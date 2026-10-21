"""Bot 24/7: el servidor corre el motor del bot sin necesitar ninguna pestaña abierta.

El motor (escaneo, modelos, valor, piloto automático, modo práctica y liquidación) es el mismo de la app web.
En lugar de duplicarlo en Python, el servidor lo abre en una ventana invisible de Microsoft Edge (o Chrome)
que él mismo controla:
- la abre al arrancar y la cierra al salir;
- la página le manda un latido cada 30 s; si se cae o deja de latir, la reinicia sola;
- la renueva cada 6 h para que no acumule memoria;
- mientras está activo, pide a Windows que no se duerma (si lo permites en Ajustes).
"""

from __future__ import annotations

import ctypes
import os
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path

import psutil

NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
HEARTBEAT_TIMEOUT = 4 * 60      # sin latido en 4 min → se reinicia
STARTUP_GRACE = 3 * 60          # tiempo para el primer latido después de abrir
RENEW_EVERY = 6 * 3600          # se renueva cada 6 h
ES_CONTINUOUS, ES_SYSTEM_REQUIRED = 0x80000000, 0x00000001


# ---------- el motor se cierra junto con el servidor (Job Object de Windows) ----------
class _JobLimits(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64), ("LimitFlags", ctypes.c_uint32),
        ("MinimumWorkingSetSize", ctypes.c_size_t), ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", ctypes.c_uint32),
        ("Affinity", ctypes.c_size_t), ("PriorityClass", ctypes.c_uint32), ("SchedulingClass", ctypes.c_uint32),
    ]


class _IoCounters(ctypes.Structure):
    _fields_ = [(n, ctypes.c_uint64) for n in ("ReadOps", "WriteOps", "OtherOps", "ReadBytes", "WriteBytes", "OtherBytes")]


class _JobExtLimits(ctypes.Structure):
    _fields_ = [
        ("Basic", _JobLimits), ("Io", _IoCounters), ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


_job = None


def _kill_with_server(pid: int) -> None:
    """Si el servidor se cierra de golpe (por ejemplo con la X de la ventana), Windows cierra también el motor."""
    global _job
    if sys.platform != "win32":
        return
    try:
        k32 = ctypes.windll.kernel32
        k32.CreateJobObjectW.restype = ctypes.c_void_p
        k32.OpenProcess.restype = ctypes.c_void_p
        if _job is None:
            job = k32.CreateJobObjectW(None, None)
            info = _JobExtLimits()
            info.Basic.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            k32.SetInformationJobObject(ctypes.c_void_p(job), 9, ctypes.byref(info), ctypes.sizeof(info))
            _job = job
        h = k32.OpenProcess(0x1F0FFF, False, pid)
        if h:
            k32.AssignProcessToJobObject(ctypes.c_void_p(_job), ctypes.c_void_p(h))
            k32.CloseHandle(ctypes.c_void_p(h))
    except (AttributeError, OSError):
        pass


def engine_procs(profile: Path) -> list[psutil.Process]:
    """Procesos del motor: Edge/Chrome que usan la carpeta de perfil del bot (nunca toca tu navegador normal)."""
    key = str(profile).lower()
    out = []
    for p in psutil.process_iter(["name", "cmdline"]):
        try:
            if (p.info["name"] or "").lower() in ("msedge.exe", "chrome.exe") and key in " ".join(p.info["cmdline"] or []).lower():
                out.append(p)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    return out


def kill_orphans(profile: Path) -> int:
    """Cierra todos los procesos del motor (de esta ejecución o de una anterior)."""
    procs = engine_procs(profile)
    for p in procs:
        try:
            p.kill()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    psutil.wait_procs(procs, timeout=10)
    return len(procs)


def find_browser() -> str | None:
    cands = []
    for base in (os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles"), os.environ.get("LOCALAPPDATA")):
        if base:
            cands += [Path(base) / "Microsoft" / "Edge" / "Application" / "msedge.exe", Path(base) / "Google" / "Chrome" / "Application" / "chrome.exe"]
    for c in cands:
        if c.exists():
            return str(c)
    return shutil.which("msedge") or shutil.which("chrome")


class BotRunner:
    def __init__(self, data_dir: Path, port: int):
        self.profile = data_dir / "navegador-bot"
        self.port = port
        self.proc: subprocess.Popen | None = None
        self.started = 0.0
        self.restarts = 0
        self.last_reason = ""
        self.beat: dict = {}
        self.beat_t = 0.0
        self.enabled = True
        self.keep_awake = True
        self.awake_on = False
        self.browser = find_browser()
        self.log: list[dict] = []
        self.page_id: str | None = None
        self.duplicates = 0

    # ---------- registro ----------
    def note(self, msg: str) -> None:
        print(f"[bot 24/7] {msg}")
        self.log.insert(0, {"t": time.time() * 1000, "msg": msg})
        del self.log[30:]

    # ---------- proceso del navegador ----------
    def running(self) -> bool:
        return bool(engine_procs(self.profile))

    def start(self, reason: str = "") -> None:
        if not self.browser:
            self.last_reason = "No se encontró Microsoft Edge ni Google Chrome en esta PC."
            return
        self.stop()
        self.profile.mkdir(parents=True, exist_ok=True)
        args = [
            self.browser, "--headless=new", f"--user-data-dir={self.profile}", "--disable-gpu", "--no-first-run",
            "--no-default-browser-check", "--disable-extensions", "--mute-audio", "--disable-sync",
            "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
            "--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling",
            f"http://localhost:{self.port}/?bot=servidor",
        ]
        self.proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=NO_WINDOW)
        _kill_with_server(self.proc.pid)
        self.started = time.time()
        self.beat_t = 0.0
        self.page_id = None  # la primera pestaña del motor que lata queda como la única autorizada
        if reason:
            self.restarts += 1
            self.last_reason = reason
            self.note(f"Reiniciado: {reason}")
        else:
            self.note("Motor del bot iniciado (ventana invisible de " + ("Edge" if "msedge" in self.browser.lower() else "Chrome") + ")")

    def stop(self) -> None:
        kill_orphans(self.profile)
        self.proc = None

    # ---------- latido de la página ----------
    def heartbeat(self, data: dict) -> dict:
        """Solo UNA pestaña del motor puede operar: si apareciera otra (por ejemplo, Edge reabrió la página),
        se le pide apagarse para que nunca haya apuestas duplicadas."""
        pid = str(data.get("page") or "")
        if not self.enabled:
            return {"stop": True}
        if self.page_id is None:
            self.page_id = pid
        if pid != self.page_id:
            self.duplicates += 1
            return {"stop": True}
        self.beat = data
        self.beat_t = time.time()
        return {"ok": True}

    # ---------- vigilancia (cada 20 s) ----------
    def tick(self) -> None:
        if not self.enabled:
            if self.running():
                self.stop()
                self.note("Bot 24/7 desactivado")
            return
        now = time.time()
        if not self.running():
            self.start("el motor se había cerrado" if self.started else "")
        elif self.beat_t == 0 and now - self.started > STARTUP_GRACE:
            self.start("no respondió al arrancar")
        elif self.beat_t and now - self.beat_t > HEARTBEAT_TIMEOUT:
            self.start("dejó de responder")
        elif now - self.started > RENEW_EVERY and not (self.beat or {}).get("scanning"):
            self.start("renovación programada (cada 6 h)")

    # ---------- que Windows no se duerma mientras el bot opera ----------
    def set_awake(self, on: bool) -> None:
        if on == self.awake_on or sys.platform != "win32":
            return
        try:
            ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS | (ES_SYSTEM_REQUIRED if on else 0))
            self.awake_on = on
        except (AttributeError, OSError):
            pass

    def status(self) -> dict:
        now = time.time()
        return {
            "enabled": self.enabled, "keepAwake": self.keep_awake, "browser": bool(self.browser), "running": self.running(),
            "healthy": self.running() and bool(self.beat_t) and now - self.beat_t < 90,
            "uptime": int(now - self.started) if self.running() else 0, "lastBeat": int(self.beat_t * 1000) if self.beat_t else None,
            "restarts": self.restarts, "lastReason": self.last_reason, "duplicatesStopped": self.duplicates, "beat": self.beat, "log": self.log[:10],
        }
