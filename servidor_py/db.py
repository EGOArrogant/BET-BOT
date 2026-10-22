"""Base de datos de BetBot MX (SQLite).

Guarda el estado de la app (banca, apuestas, aprendizaje), la base de datos de apuestas liquidadas
y las suscripciones de notificaciones push.

Compatibilidad: además de SQLite se siguen escribiendo los archivos de siempre (data/state.json,
data/state.rev, data/apuestas.jsonl y data/push.json). Así puedes volver al servidor de PowerShell
en cualquier momento sin perder nada, y si el de PowerShell guardó algo después, al arrancar este
servidor se importa lo más reciente.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from pathlib import Path


class Store:
    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        data_dir.mkdir(parents=True, exist_ok=True)
        self.state_path = data_dir / "state.json"
        self.rev_path = data_dir / "state.rev"
        self.ledger_path = data_dir / "apuestas.jsonl"
        self.push_path = data_dir / "push.json"
        self.db_path = data_dir / "betbot.db"
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.db_path, check_same_thread=False, isolation_level=None)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS estado (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL, rev INTEGER NOT NULL, t REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS apuestas (id TEXT PRIMARY KEY, t REAL, json TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS push_llaves (id INTEGER PRIMARY KEY CHECK (id = 1), priv TEXT NOT NULL, pub TEXT NOT NULL, last_t REAL NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, device TEXT, added REAL, prefs TEXT);
            CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
            """
        )
        self.sync_from_files()

    # ---------- importación desde los archivos (primera vez o si el servidor de PowerShell guardó después) ----------
    def _meta(self, k: str, v: str | None = None) -> str | None:
        if v is None:
            row = self.db.execute("SELECT v FROM meta WHERE k = ?", (k,)).fetchone()
            return row[0] if row else None
        self.db.execute("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", (k, v))
        return v

    @staticmethod
    def _atomic_write(path: Path, text: str) -> None:
        # Se escribe en un temporal, se fuerza a disco y se reemplaza de golpe: si la PC se apaga o el
        # servidor se cierra a la mitad, queda el archivo anterior completo y no uno vacío o con ceros.
        tmp = path.with_name(path.name + ".tmp")
        with open(tmp, "w", encoding="utf-8", newline="") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)

    def _read_rev(self) -> int | None:
        """Revisión de data/state.rev; None si el archivo está dañado (p. ej. lleno de ceros tras un apagón)."""
        if not self.rev_path.exists():
            return None  # se borró: se toma la revisión de la base de datos (o 0 si es la primera vez)
        try:
            raw = self.rev_path.read_bytes().strip()
        except OSError:
            return None
        if not raw:
            return 0
        return int(raw) if raw.isdigit() else None  # ceros de un apagón o basura = dañado

    def sync_from_files(self) -> dict:
        report = {"estado": False, "apuestas": 0, "push": False}
        with self.lock:
            # Estado: manda el que tenga la revisión más nueva.
            file_rev = self._read_rev()
            row = self.db.execute("SELECT rev FROM estado WHERE id = 1").fetchone()
            if file_rev is None:
                # Archivo de revisión dañado: la base de datos (SQLite, a prueba de apagones) es la referencia.
                if self.rev_path.exists() or row is not None:
                    print("data/state.rev faltaba o estaba dañado: se usa la revisión guardada en la base de datos y se repara.")
                if row is not None:
                    self._atomic_write(self.rev_path, str(row[0]))
                    file_rev = row[0]
                else:
                    file_rev = 0
            if self.state_path.exists():
                try:
                    text = self.state_path.read_text(encoding="utf-8-sig")
                    json.loads(text)  # valida
                    valid = True
                except (ValueError, OSError) as e:
                    valid = False
                    # state.json dañado: si la base de datos tiene el estado, se reconstruye el archivo desde ahí.
                    print(f"data/state.json no se pudo leer ({e}); se conserva el estado de la base de datos.")
                    if row is not None:
                        cur_text = self.db.execute("SELECT json FROM estado WHERE id = 1").fetchone()[0]
                        self._atomic_write(self.state_path, cur_text)
                        self._atomic_write(self.rev_path, str(row[0]))
                if valid and (row is None or file_rev != row[0]):
                    self.db.execute("INSERT OR REPLACE INTO estado (id, json, rev, t) VALUES (1, ?, ?, ?)", (text, file_rev, time.time()))
                    self._atomic_write(self.rev_path, str(file_rev))
                    report["estado"] = True
            # Apuestas liquidadas: se agregan las que falten (sin duplicados).
            if self.ledger_path.exists():
                cur = self.db.execute("SELECT COUNT(*) FROM apuestas").fetchone()[0]
                for line in self.ledger_path.read_text(encoding="utf-8-sig").splitlines():
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        it = json.loads(line)
                    except ValueError:
                        continue
                    if isinstance(it, dict) and it.get("id"):
                        self.db.execute("INSERT OR IGNORE INTO apuestas (id, t, json) VALUES (?, ?, ?)", (str(it["id"]), it.get("t"), line))
                report["apuestas"] = self.db.execute("SELECT COUNT(*) FROM apuestas").fetchone()[0] - cur
            # Notificaciones: llaves VAPID y suscripciones (si push.json es más nuevo que lo importado).
            if self.push_path.exists():
                mtime = str(self.push_path.stat().st_mtime)
                if self._meta("push_mtime") != mtime:
                    try:
                        j = json.loads(self.push_path.read_text(encoding="utf-8-sig"))
                        if j.get("priv") and j.get("pub"):
                            self.db.execute(
                                "INSERT OR REPLACE INTO push_llaves (id, priv, pub, last_t) VALUES (1, ?, ?, ?)",
                                (j["priv"], j["pub"], float(j.get("lastT") or 0)),
                            )
                        self.db.execute("DELETE FROM push_subs")
                        subs = j.get("subs") or []
                        if isinstance(subs, dict):
                            subs = [subs]
                        for s in subs:
                            if s and s.get("endpoint"):
                                self.db.execute(
                                    "INSERT OR REPLACE INTO push_subs (endpoint, p256dh, auth, device, added, prefs) VALUES (?, ?, ?, ?, ?, ?)",
                                    (s["endpoint"], s.get("p256dh", ""), s.get("auth", ""), s.get("device", ""), s.get("added"), json.dumps(s.get("prefs") or {})),
                                )
                        self._meta("push_mtime", mtime)
                        report["push"] = True
                    except (ValueError, OSError) as e:
                        print(f"push.json no se pudo importar: {e}")
        return report

    # ---------- estado ----------
    def get_state(self) -> tuple[str | None, int]:
        row = self.db.execute("SELECT json, rev FROM estado WHERE id = 1").fetchone()
        return (row[0], row[1]) if row else (None, 0)

    def save_state(self, text: str, base_rev: int | None) -> tuple[bool, int, str | None]:
        """Guarda si la revisión base coincide. Devuelve (ok, rev, estado_actual_si_hubo_conflicto)."""
        with self.lock:
            cur, rev = self.get_state()
            if base_rev is not None and base_rev != rev:
                return False, rev, cur
            rev += 1
            self.db.execute("INSERT OR REPLACE INTO estado (id, json, rev, t) VALUES (1, ?, ?, ?)", (text, rev, time.time()))
            # Copia en los archivos de siempre (compatibilidad con el servidor de PowerShell).
            self._atomic_write(self.state_path, text)
            self._atomic_write(self.rev_path, str(rev))
            return True, rev, None

    # ---------- base de datos de apuestas ----------
    def ledger_add(self, items: list) -> tuple[int, int]:
        added = 0
        with self.lock:
            for it in items:
                if not isinstance(it, dict) or not it.get("id"):
                    continue
                line = json.dumps(it, ensure_ascii=False, separators=(",", ":"))
                cur = self.db.execute("INSERT OR IGNORE INTO apuestas (id, t, json) VALUES (?, ?, ?)", (str(it["id"]), it.get("t"), line))
                if cur.rowcount:
                    added += 1
                    with self.ledger_path.open("a", encoding="utf-8") as f:
                        f.write(line + "\n")
            total = self.db.execute("SELECT COUNT(*) FROM apuestas").fetchone()[0]
        return added, total

    def ledger_all(self) -> str:
        rows = self.db.execute("SELECT json FROM apuestas ORDER BY rowid").fetchall()
        return "[" + ",".join(r[0] for r in rows) + "]"

    # ---------- notificaciones push ----------
    def push_keys(self) -> tuple[str, str, float] | None:
        row = self.db.execute("SELECT priv, pub, last_t FROM push_llaves WHERE id = 1").fetchone()
        return (row[0], row[1], row[2]) if row else None

    def set_push_keys(self, priv: str, pub: str, last_t: float = 0) -> None:
        self.db.execute("INSERT OR REPLACE INTO push_llaves (id, priv, pub, last_t) VALUES (1, ?, ?, ?)", (priv, pub, last_t))
        self._write_push_file()

    def set_push_last(self, last_t: float) -> None:
        self.db.execute("UPDATE push_llaves SET last_t = ? WHERE id = 1", (last_t,))
        self._write_push_file()

    def push_subs(self) -> list[dict]:
        rows = self.db.execute("SELECT endpoint, p256dh, auth, device, added, prefs FROM push_subs").fetchall()
        return [
            {"endpoint": r[0], "p256dh": r[1], "auth": r[2], "device": r[3], "added": r[4], "prefs": json.loads(r[5] or "{}")}
            for r in rows
        ]

    def push_sub(self, endpoint: str) -> dict | None:
        return next((s for s in self.push_subs() if s["endpoint"] == endpoint), None)

    def upsert_push_sub(self, sub: dict) -> None:
        self.db.execute(
            "INSERT OR REPLACE INTO push_subs (endpoint, p256dh, auth, device, added, prefs) VALUES (?, ?, ?, ?, ?, ?)",
            (sub["endpoint"], sub["p256dh"], sub["auth"], sub.get("device", ""), sub.get("added"), json.dumps(sub.get("prefs") or {})),
        )
        self._write_push_file()

    def delete_push_sub(self, endpoint: str) -> None:
        self.db.execute("DELETE FROM push_subs WHERE endpoint = ?", (endpoint,))
        self._write_push_file()

    def _write_push_file(self) -> None:
        k = self.push_keys()
        if not k:
            return
        doc = {"priv": k[0], "pub": k[1], "lastT": k[2], "subs": self.push_subs()}
        self._atomic_write(self.push_path, json.dumps(doc, ensure_ascii=False, indent=2))
        self._meta("push_mtime", str(self.push_path.stat().st_mtime))
