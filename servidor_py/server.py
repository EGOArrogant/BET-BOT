"""BetBot MX - servidor local en Python (FastAPI + uvicorn).

Reemplaza a server.ps1 con los mismos endpoints: la app web (carpeta web/) funciona igual en la PC y en el celular.
- Sirve la app y guarda la banca en SQLite (data/betbot.db), con copia en los archivos de siempre.
- Tus claves viven solo en .env: las llamadas a Claude y a The Odds API pasan por aquí, que agrega la clave.
- Acceso desde el celular con el código secreto (QR) y por Tailscale (HTTPS).
- Atiende muchas consultas a la vez (el de PowerShell atendía una por una).
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import base64
import datetime as dt
import ipaddress
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import time
import zipfile
from pathlib import Path
from urllib.parse import urlsplit

import httpx
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse, RedirectResponse, Response, StreamingResponse

sys.path.insert(0, str(Path(__file__).parent))
from db import Store  # noqa: E402
import push as pushmod  # noqa: E402
import bot as botmod  # noqa: E402

SERVER_VERSION = "3.1.0"
ENGINE = "python"

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
DATA = ROOT / "data"
ENV_PATH = ROOT / ".env"
TOKEN_PATH = DATA / "token.txt"
DEFAULT_MANIFEST = "https://raw.githubusercontent.com/EGOArrogant/BET-BOT/main/web/version.json"
PUSH_SUBJECT = "https://github.com/EGOArrogant/BET-BOT"

PROXY_HOSTS = {
    "news.google.com", "liquipedia.net", "api.elections.kalshi.com", "data-api.polymarket.com",
    "api.bo3.gg", "www.vlr.gg", "www.transfermarkt.es", "webws.365scores.com",
}
# Segundos que se reutiliza una respuesta por sitio (tiempo real donde importa; Liquipedia exige calma).
PROXY_TTL = {
    "liquipedia.net": 60, "www.transfermarkt.es": 86400, "www.vlr.gg": 5, "webws.365scores.com": 10,
    "api.bo3.gg": 4, "api.elections.kalshi.com": 8,
}
# Ritmo por sitio: (consultas a la vez, segundos mínimos entre consultas). Este servidor atiende todo en paralelo
# y algunos sitios rechazan ráfagas (Kalshi responde 429), así que se les pregunta con calma.
HOST_PACE = {"api.elections.kalshi.com": (2, 0.25), "webws.365scores.com": (4, 0.05), "www.transfermarkt.es": (1, 1.0), "www.vlr.gg": (2, 0.2)}
MIME = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
    ".webmanifest": "application/manifest+json", ".jpg": "image/jpeg", ".webp": "image/webp", ".txt": "text/plain; charset=utf-8",
}
# Archivos del programa que copia una actualización (tus datos y .env nunca se tocan).
UPDATE_FILES = ["server.ps1", "iniciar.bat", "iniciar-python.bat", "habilitar-telefono.bat", "deshabilitar-telefono.bat", "LEEME.md", ".env.example"]
UPDATE_DIRS = ["web", "servidor_py"]

DENIED_HTML = """<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BetBot MX</title><body style="font-family:-apple-system,system-ui,sans-serif;background:#0b0b10;color:#f5f5f7;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:24px">
<div><div style="font-size:54px">&#128274;</div><h1 style="margin:8px 0">BetBot MX</h1>
<p style="color:#aaa;max-width:340px">Para entrar desde este dispositivo, escanea el c&oacute;digo QR que aparece en la app de tu computadora (M&aacute;s &rarr; Celular).</p></div></body></html>"""

ARGS = argparse.Namespace(port=8787, wait=0.0)
store: Store
TOKEN = ""
http: httpx.AsyncClient
proxy_cache: dict[str, tuple[float, str]] = {}
img_cache: dict[str, tuple[bytes, str]] = {}
inflight: dict[str, asyncio.Future] = {}
last_liquipedia = 0.0
lp_lock = asyncio.Lock()
LOCAL_IPS: set[str] = {"127.0.0.1", "::1"}
runner: botmod.BotRunner | None = None


# ---------- utilidades ----------
def read_env() -> dict[str, str]:
    cfg: dict[str, str] = {}
    if ENV_PATH.exists():
        for line in ENV_PATH.read_text(encoding="utf-8-sig").splitlines():
            m = re.match(r"^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$", line)
            if m:
                cfg[m.group(1)] = m.group(2).strip().strip("\"' ")
    cfg.setdefault("UPDATE_MANIFEST_URL", DEFAULT_MANIFEST)
    if not cfg["UPDATE_MANIFEST_URL"]:
        cfg["UPDATE_MANIFEST_URL"] = DEFAULT_MANIFEST
    return cfg


def set_env_values(vals: dict[str, str]) -> None:
    lines = ENV_PATH.read_text(encoding="utf-8-sig").splitlines() if ENV_PATH.exists() else []
    out, done = [], set()
    for l in lines:
        m = re.match(r"^\s*([A-Z0-9_]+)\s*=", l)
        if m and m.group(1) in vals:
            out.append(f"{m.group(1)}={vals[m.group(1)]}")
            done.add(m.group(1))
        else:
            out.append(l)
    out += [f"{k}={v}" for k, v in vals.items() if k not in done]
    ENV_PATH.write_text("\r\n".join(out) + "\r\n", encoding="utf-8")


def j(obj, status: int = 200, headers: dict | None = None) -> Response:
    return Response(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), status_code=status,
                    media_type="application/json; charset=utf-8", headers={"Cache-Control": "no-store", **(headers or {})})


def text(body: str, status: int = 200, media: str = "text/plain; charset=utf-8", headers: dict | None = None) -> Response:
    return Response(body, status_code=status, media_type=media, headers={"Cache-Control": "no-store", **(headers or {})})


def run_ps(cmd: str, timeout: int = 15) -> str:
    """Ejecuta un comando de PowerShell (información de red de Windows) y devuelve su salida."""
    try:
        r = subprocess.run(["powershell", "-NoProfile", "-Command", cmd], capture_output=True, text=True, timeout=timeout,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return r.stdout
    except (OSError, subprocess.TimeoutExpired):
        return ""


def lan_ips() -> list[str]:
    out = run_ps("Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and "
                 "$_.IPAddress -notlike '169.254.*' -and $_.AddressState -eq 'Preferred' } | Sort-Object { if ($_.InterfaceAlias -match "
                 "'Wi-?Fi|WLAN|Ethernet') { 0 } else { 1 } } | ForEach-Object { $_.IPAddress }")
    ips = [l.strip() for l in out.splitlines() if l.strip()]
    if not ips:
        try:
            ips = [ip for ip in socket.gethostbyname_ex(socket.gethostname())[2] if not ip.startswith(("127.", "169.254."))]
        except OSError:
            ips = []
    return ips


def lan_enabled() -> bool:
    """El celular puede entrar si existe la regla del firewall que crea habilitar-telefono.bat."""
    try:
        r = subprocess.run(["netsh", "advfirewall", "firewall", "show", "rule", 'name=BetBot MX'], capture_output=True, text=True,
                           timeout=10, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return r.returncode == 0 and "BetBot MX" in r.stdout
    except (OSError, subprocess.TimeoutExpired):
        return False


def is_local(req: Request) -> bool:
    """Solo la PC. Las visitas por Tailscale llegan desde 127.0.0.1 pero se reconocen por sus encabezados."""
    host = req.client.host if req.client else ""
    if host not in LOCAL_IPS:
        return False
    h = req.headers
    if h.get("tailscale-user-login") or h.get("x-forwarded-for") or ".ts.net" in (h.get("host") or ""):
        return False
    return True


def tailscale_exe() -> str | None:
    for base in (os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)")):
        if base:
            p = Path(base) / "Tailscale" / "tailscale.exe"
            if p.exists():
                return str(p)
    return shutil.which("tailscale.exe") or shutil.which("tailscale")


async def run_tailscale(argv: list[str], timeout: float = 8) -> dict | None:
    exe = tailscale_exe()
    if not exe:
        return None
    p = await asyncio.create_subprocess_exec(exe, *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    try:
        out, err = await asyncio.wait_for(p.communicate(), timeout)
        return {"done": True, "code": p.returncode, "out": out.decode("utf-8", "replace"), "err": err.decode("utf-8", "replace")}
    except asyncio.TimeoutError:
        # "tailscale serve" se queda esperando si falta activar HTTPS en tu cuenta: se corta y se devuelve el enlace.
        p.kill()
        out = await p.stdout.read() if p.stdout else b""
        err = await p.stderr.read() if p.stderr else b""
        return {"done": False, "code": -1, "out": out.decode("utf-8", "replace"), "err": err.decode("utf-8", "replace")}


def local_version() -> str:
    vf = WEB / "version.json"
    return vf.read_text(encoding="utf-8-sig") if vf.exists() else '{"version":"0.0.0"}'


class Pace:
    """Limita cuántas consultas van a la vez a un sitio y deja un espacio mínimo entre ellas."""

    def __init__(self, concurrent: int, gap: float):
        self.sem, self.gap, self.lock, self.last = asyncio.Semaphore(concurrent), gap, asyncio.Lock(), 0.0

    async def __aenter__(self):
        await self.sem.acquire()
        async with self.lock:
            wait = self.last + self.gap - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
            self.last = time.monotonic()

    async def __aexit__(self, *exc):
        self.sem.release()


paces: dict[str, Pace] = {}


async def fetch_paced(host: str, url: str, **kw) -> httpx.Response:
    pace = paces.get(host)
    if pace is None and host in HOST_PACE:
        pace = paces[host] = Pace(*HOST_PACE[host])
    for attempt in range(2):
        if pace:
            async with pace:
                r = await http.get(url, **kw)
        else:
            r = await http.get(url, **kw)
        if r.status_code != 429 or attempt:
            return r
        # El sitio pidió calma: se espera lo que indique (máx. 3 s) y se reintenta una vez.
        try:
            delay = min(3.0, float(r.headers.get("retry-after", 1)))
        except ValueError:
            delay = 1.0
        await asyncio.sleep(delay)
    return r


# ---------- app ----------
@contextlib.asynccontextmanager
async def lifespan(_app):
    global http
    http = httpx.AsyncClient(follow_redirects=True, headers={"User-Agent": "BetBotMX/1.1 (app personal de analisis)"},
                             limits=httpx.Limits(max_connections=50, max_keepalive_connections=20))
    _app.state.lan = await asyncio.to_thread(lan_enabled)
    for ip in await asyncio.to_thread(lan_ips):
        LOCAL_IPS.add(ip)
    print(f"BetBot MX (Python) corriendo en http://localhost:{ARGS.port}  (cierra esta ventana para detenerlo)")
    print("Acceso desde el celular: " + ("ACTIVO (escanea el QR en Más → Celular)" if _app.state.lan else "desactivado (ejecuta habilitar-telefono.bat una vez)"))
    watchdog = asyncio.create_task(bot_watchdog())
    yield
    watchdog.cancel()
    if runner:
        await asyncio.to_thread(runner.stop)
        runner.set_awake(False)
    await http.aclose()


async def bot_watchdog():
    """Bot 24/7: abre el motor y lo vigila cada 20 s (lo reinicia si se cae o deja de responder)."""
    global runner
    cfg = read_env()
    runner = botmod.BotRunner(DATA, ARGS.port)
    runner.enabled = cfg.get("BOT_24_7", "1") != "0"
    runner.keep_awake = cfg.get("BOT_NO_DORMIR", "1") != "0"
    killed = await asyncio.to_thread(botmod.kill_orphans, runner.profile)
    if killed:
        runner.note(f"Se cerraron {killed} procesos de un motor anterior")
    if not runner.browser:
        print("Bot 24/7: no se encontró Microsoft Edge ni Google Chrome; el bot solo opera con la app abierta.")
    elif runner.enabled:
        print("Bot 24/7: ACTIVO (opera aunque no tengas la app abierta)")
    await asyncio.sleep(2)  # que el servidor ya esté escuchando antes de abrir el motor
    while True:
        try:
            runner.set_awake(runner.enabled and runner.keep_awake and bool(runner.browser))
            await asyncio.to_thread(runner.tick)
        except Exception as e:  # nunca debe tumbar al servidor
            print(f"Bot 24/7: {e}")
        await asyncio.sleep(20)


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)


@app.middleware("http")
async def auth(req: Request, call_next):
    path = req.url.path
    if is_local(req) or path.startswith("/icons/") or path in ("/manifest.webmanifest", "/sw.js", "/offline.html"):
        return await call_next(req)
    if req.cookies.get("bb_t") == TOKEN or req.headers.get("x-betbot-token") == TOKEN:
        return await call_next(req)
    if req.query_params.get("t") == TOKEN:
        r = RedirectResponse("/", status_code=302)
        r.set_cookie("bb_t", TOKEN, max_age=31536000, httponly=True, samesite="lax", path="/")
        return r
    return HTMLResponse(DENIED_HTML, status_code=401, headers={"Cache-Control": "no-store"})


@app.exception_handler(Exception)
async def on_error(req: Request, exc: Exception):
    print(f"Error en {req.url.path} : {exc}")
    return j({"error": str(exc)}, 500)


@app.get("/api/config")
async def config(req: Request):
    cfg = read_env()
    return j({
        "hasAnthropic": bool(cfg.get("ANTHROPIC_API_KEY")), "hasOdds": bool(cfg.get("ODDS_API_KEY")),
        "aiModel": cfg.get("AI_MODEL") or "claude-opus-5-5", "hasUpdates": bool(cfg.get("UPDATE_MANIFEST_URL")),
        "local": is_local(req), "lan": app.state.lan, "serverVersion": SERVER_VERSION, "engine": ENGINE,
    })


# ---------- estado (banca) con control de revisiones entre dispositivos ----------
@app.get("/api/state")
async def get_state():
    st, rev = store.get_state()
    return text(st or "null", media="application/json; charset=utf-8", headers={"X-Rev": str(rev)})


@app.put("/api/state")
async def put_state(req: Request):
    body = (await req.body()).decode("utf-8")
    state_obj = json.loads(body)  # valida que sea JSON antes de guardar
    base = req.headers.get("x-base-rev")
    ok, rev, current = store.save_state(body, int(base) if base not in (None, "") else None)
    if not ok:
        # Otro dispositivo guardó antes: se devuelve la versión actual para que el cliente se sincronice.
        return text(current or "null", 409, "application/json; charset=utf-8", {"X-Rev": str(rev)})
    # Avisos push de lo nuevo en la bitácora, después de responder (para no hacer esperar a la app).
    asyncio.create_task(asyncio.to_thread(pushmod.push_from_state, store, state_obj, PUSH_SUBJECT))
    return j({"ok": True, "rev": rev})


# ---------- Claude y The Odds API (la clave se agrega aquí y nunca sale de tu PC) ----------
@app.api_route("/api/anthropic/{rest:path}", methods=["GET", "POST"])
async def anthropic(rest: str, req: Request):
    cfg = read_env()
    if not cfg.get("ANTHROPIC_API_KEY"):
        return j({"type": "error", "error": {"type": "authentication_error", "message": "Falta ANTHROPIC_API_KEY. Agrégala en Más → Ajustes."}}, 401)
    target = "https://api.anthropic.com/" + rest + (("?" + req.url.query) if req.url.query else "")
    h = {"x-api-key": cfg["ANTHROPIC_API_KEY"], "content-type": "application/json", "accept": req.headers.get("accept", "application/json"),
         "anthropic-version": req.headers.get("anthropic-version", "2023-06-01"), "accept-encoding": "identity"}
    if req.headers.get("anthropic-beta"):
        h["anthropic-beta"] = req.headers["anthropic-beta"]
    upstream = await http.send(http.build_request(req.method, target, headers=h, content=await req.body(), timeout=httpx.Timeout(600, connect=20)), stream=True)

    # Se transmite tal cual llega (también respuestas en streaming), sin esperar a que termine.
    async def body():
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        finally:
            await upstream.aclose()

    return StreamingResponse(body(), status_code=upstream.status_code, media_type=upstream.headers.get("content-type", "application/json"),
                             headers={"Cache-Control": "no-store"})


@app.get("/api/odds")
async def odds(p: str = ""):
    cfg = read_env()
    if not cfg.get("ODDS_API_KEY"):
        return j({"error": "Falta ODDS_API_KEY"}, 401)
    if not p.startswith("sports/"):
        return j({"error": "ruta no permitida"}, 400)
    sep = "&" if "?" in p else "?"
    r = await http.get(f"https://api.the-odds-api.com/v4/{p}{sep}apiKey={cfg['ODDS_API_KEY']}", timeout=30)
    extra = {"X-Requests-Remaining": r.headers["x-requests-remaining"]} if r.headers.get("x-requests-remaining") else {}
    return Response(r.content, status_code=r.status_code, media_type="application/json; charset=utf-8", headers={"Cache-Control": "no-store", **extra})


# ---------- logos de Liquipedia y proxy de fuentes públicas ----------
@app.get("/api/img")
async def img(u: str = ""):
    t = urlsplit(u)
    if t.hostname != "liquipedia.net" or not t.path.startswith("/commons/images/"):
        return j({"error": "imagen no permitida"}, 403)
    hit = img_cache.get(u)
    if not hit:
        r = await http.get(u, headers={"Accept": "image/*"}, timeout=20)
        if r.status_code != 200:
            return text("", r.status_code)
        if len(img_cache) > 500:
            img_cache.clear()
        hit = img_cache[u] = (r.content, r.headers.get("content-type", "image/png"))
    return Response(hit[0], media_type=hit[1], headers={"Cache-Control": "public, max-age=86400"})


@app.get("/api/proxy")
async def proxy(url: str = ""):
    global last_liquipedia
    t = urlsplit(url)
    if t.scheme not in ("http", "https") or t.hostname not in PROXY_HOSTS:
        return j({"error": "host no permitido"}, 403)
    ttl = PROXY_TTL.get(t.hostname, 30)
    hit = proxy_cache.get(url)
    if hit and time.time() - hit[0] < ttl:
        return text(hit[1])
    if t.hostname != "liquipedia.net":
        # Si otra consulta idéntica ya va en camino, se espera su respuesta en lugar de repetirla.
        pending = inflight.get(url)
        if pending:
            status, body = await asyncio.shield(pending)
            return text(body, status)
        fut = inflight[url] = asyncio.get_running_loop().create_future()
        try:
            r = await fetch_paced(t.hostname, url, headers={"User-Agent": "Mozilla/5.0 (compatible; BetBotMX/1.3)", "Accept": "application/json, text/xml, */*"}, timeout=20)
            body = r.content.decode("utf-8", "replace")
            if r.status_code == 200:
                if len(proxy_cache) > 2000:
                    proxy_cache.clear()
                proxy_cache[url] = (time.time(), body)
            fut.set_result((r.status_code, body))
            return text(body, r.status_code)
        except Exception as e:
            fut.set_exception(e)
            fut.exception()  # evita el aviso de "excepción no leída" si nadie más esperaba
            raise
        finally:
            inflight.pop(url, None)
    # Liquipedia pide: gzip, User-Agent identificable y máximo 1 consulta "parse" cada 30 s.
    async with lp_lock:
        wait = 30 - (time.time() - last_liquipedia)
        if wait > 0:
            if hit:
                return text(hit[1])
            return j({"error": "limite de Liquipedia, reintenta"}, 429, {"Retry-After": str(int(wait) + 1)})
        last_liquipedia = time.time()
    r = await http.get(url, headers={"Accept-Encoding": "gzip", "User-Agent": "BetBotMX/1.1 (app personal de analisis)"}, timeout=30)
    body = r.content.decode("utf-8", "replace")
    if r.status_code == 200:
        if len(proxy_cache) > 2000:
            proxy_cache.clear()
        proxy_cache[url] = (time.time(), body)
    return text(body, r.status_code)


# ---------- notificaciones push ----------
async def body_json(req: Request) -> dict:
    try:
        return json.loads((await req.body()).decode("utf-8") or "{}")
    except ValueError:
        return {}


@app.get("/api/push/key")
async def push_key():
    return j({"publicKey": store.push_keys()[1], "subscribers": len(store.push_subs())})


@app.post("/api/push/subscribe")
async def push_subscribe(req: Request):
    b = await body_json(req)
    s = b.get("subscription") or {}
    keys = s.get("keys") or {}
    if not s.get("endpoint") or not keys.get("p256dh") or not keys.get("auth"):
        return j({"error": "suscripcion incompleta"}, 400)
    if not str(s["endpoint"]).startswith("https://"):
        return j({"error": "endpoint invalido"}, 400)
    old = store.push_sub(s["endpoint"])
    prefs = pushmod.prefs(b.get("prefs") if b.get("prefs") else (old or {}).get("prefs"))
    store.upsert_push_sub({"endpoint": s["endpoint"], "p256dh": keys["p256dh"], "auth": keys["auth"], "device": b.get("device") or "",
                           "added": int(time.time() * 1000), "prefs": prefs})
    return j({"ok": True, "subscribers": len(store.push_subs())})


@app.post("/api/push/unsubscribe")
async def push_unsubscribe(req: Request):
    b = await body_json(req)
    if b.get("endpoint"):
        store.delete_push_sub(b["endpoint"])
    return j({"ok": True})


@app.post("/api/push/status")
async def push_status(req: Request):
    s = store.push_sub((await body_json(req)).get("endpoint") or "")
    return j({"subscribed": bool(s), "prefs": s["prefs"] if s else pushmod.prefs(None), "subscribers": len(store.push_subs())})


@app.post("/api/push/prefs")
async def push_prefs(req: Request):
    b = await body_json(req)
    s = store.push_sub(b.get("endpoint") or "")
    if not s:
        return j({"error": "este dispositivo no tiene avisos activos"}, 404)
    s["prefs"] = pushmod.prefs(b.get("prefs"))
    store.upsert_push_sub(s)
    return j({"ok": True, "prefs": s["prefs"]})


@app.post("/api/push/test")
async def push_test(req: Request):
    b = await body_json(req)
    targets = [s for s in ([store.push_sub(b["endpoint"])] if b.get("endpoint") else store.push_subs()) if s]
    if not targets:
        return j({"error": "no hay dispositivos con avisos activos"}, 404)
    payload = {"kind": "test", "cat": "test", "msg": "", "t": int(time.time() * 1000)}
    codes = [await asyncio.to_thread(pushmod.send, store, s, payload, PUSH_SUBJECT) for s in targets]
    ok = sum(1 for c in codes if 200 <= c < 300)
    return j({"ok": ok > 0, "sent": ok, "codes": codes})


# ---------- Tailscale: acceso seguro (HTTPS) desde el iPhone, en casa o con datos móviles ----------
def pc_only(req: Request):
    return None if is_local(req) else j({"error": "solo desde la PC"}, 403)


@app.get("/api/tailscale")
async def tailscale(req: Request):
    if (deny := pc_only(req)):
        return deny
    port = ARGS.port
    if not tailscale_exe():
        return j({"installed": False, "lan": app.state.lan, "port": port})
    st = await run_tailscale(["status", "--json"])
    try:
        js = json.loads(st["out"]) if st else None
    except ValueError:
        js = None
    dns = (js.get("Self") or {}).get("DNSName", "").rstrip(".") if js else ""
    sv = await run_tailscale(["serve", "status", "--json"])
    serving = bool(sv and re.search(rf"(127\.0\.0\.1|localhost):{port}", sv["out"]))
    return j({"installed": True, "state": (js or {}).get("BackendState", ""), "dns": dns, "https": bool(js and any((js.get("CertDomains") or []))),
              "serving": serving, "lan": app.state.lan, "port": port, "token": TOKEN, "url": f"https://{dns}" if dns else ""})


@app.post("/api/tailscale/serve")
async def tailscale_serve(req: Request):
    if (deny := pc_only(req)):
        return deny
    r = await run_tailscale(["serve", "--bg", str(ARGS.port)], 15)
    if not r:
        return j({"error": "Tailscale no esta instalado"}, 400)
    allout = (r["out"] + "\n" + r["err"]).strip()
    m = re.search(r"https://login\.tailscale\.com/\S+", allout)
    if m:
        return j({"ok": False, "enableUrl": m.group(0), "output": allout})
    return j({"ok": r["done"] and r["code"] == 0, "output": allout})


@app.post("/api/tailscale/reset")
async def tailscale_reset(req: Request):
    if (deny := pc_only(req)):
        return deny
    r = await run_tailscale(["serve", "reset"])
    return j({"ok": bool(r and r["code"] == 0)})


# ---------- solo desde esta PC ----------
@app.get("/api/network")
async def network(req: Request):
    if (deny := pc_only(req)):
        return deny
    # Tipo de red de Windows: si es "Public", el firewall bloquea al celular (la regla del bot es solo para redes privadas).
    raw = await asyncio.to_thread(run_ps, "Get-NetConnectionProfile -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ "
                                  "name = [string]$_.InterfaceAlias; network = [string]$_.Name; category = [string]$_.NetworkCategory } } | ConvertTo-Json -Compress")
    try:
        profiles = json.loads(raw) if raw.strip() else []
        profiles = profiles if isinstance(profiles, list) else [profiles]
    except ValueError:
        profiles = []
    app.state.lan = await asyncio.to_thread(lan_enabled)
    return j({"lan": app.state.lan, "ips": await asyncio.to_thread(lan_ips), "port": ARGS.port, "token": TOKEN, "profiles": profiles})


@app.post("/api/phone/enable")
async def phone_enable(req: Request):
    # Ejecuta habilitar-telefono.bat como administrador: Windows muestra su aviso (UAC) y TÚ decides si lo aceptas.
    if (deny := pc_only(req)):
        return deny
    if app.state.lan:
        return j({"ok": True, "lan": True})
    bat = str(ROOT / "habilitar-telefono.bat")
    cmd = f"try {{ Start-Process -FilePath '{bat}' -ArgumentList 'auto' -Verb RunAs -Wait -WindowStyle Hidden; exit 0 }} catch {{ exit 1 }}"
    r = await asyncio.to_thread(subprocess.run, ["powershell", "-NoProfile", "-Command", cmd], capture_output=True, timeout=300,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if r.returncode != 0:
        return j({"error": "Se canceló el permiso de administrador. Vuelve a intentarlo y presiona Sí en el aviso de Windows."}, 400)
    # Este servidor ya escucha en toda la red: con la regla del firewall basta, no hace falta reiniciar.
    app.state.lan = await asyncio.to_thread(lan_enabled)
    return j({"ok": True, "lan": app.state.lan})


@app.post("/api/keys")
async def keys(req: Request):
    if not is_local(req):
        return j({"error": "Las claves solo se pueden cambiar desde la PC"}, 403)
    b = await body_json(req)
    vals: dict[str, str] = {}
    if b.get("anthropicKey") is not None:
        k = str(b["anthropicKey"]).strip()
        if k and not re.match(r"^sk-ant-[A-Za-z0-9_\-]{20,}$", k):
            return j({"error": "La clave de Anthropic debe empezar con sk-ant-"}, 400)
        vals["ANTHROPIC_API_KEY"] = k
    if b.get("oddsApiKey") is not None:
        k = str(b["oddsApiKey"]).strip()
        if k and not re.match(r"^[A-Za-z0-9]{16,64}$", k):
            return j({"error": "Clave de The Odds API no valida"}, 400)
        vals["ODDS_API_KEY"] = k
    if b.get("updateUrl") is not None:
        u = str(b["updateUrl"]).strip()
        if u and not re.match(r"^https://\S+$", u):
            return j({"error": "La URL de actualizaciones debe empezar con https://"}, 400)
        vals["UPDATE_MANIFEST_URL"] = u
    set_env_values(vals)
    test = None
    if vals.get("ANTHROPIC_API_KEY"):
        r = await http.get("https://api.anthropic.com/v1/models?limit=1", headers={"x-api-key": vals["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01"}, timeout=20)
        test = r.status_code == 200
    return j({"ok": True, "anthropicValid": test})


# ---------- actualizaciones ----------
@app.get("/api/update/check")
async def update_check(req: Request):
    if (deny := pc_only(req)):
        return deny
    cfg, local = read_env(), local_version()
    r = await http.get(cfg["UPDATE_MANIFEST_URL"], timeout=20)
    if r.status_code != 200:
        return text('{"configured":true,"error":"No se pudo leer la version publicada (HTTP ' + str(r.status_code) + ')","local":' + local + "}",
                    media="application/json; charset=utf-8")
    return text('{"configured":true,"local":' + local + ',"remote":' + r.text + "}", media="application/json; charset=utf-8")


def server_fingerprint() -> str:
    """Contenido del código del servidor (sin fines de línea) para saber si una actualización lo cambió."""
    parts = []
    for p in sorted((ROOT / "servidor_py").glob("*.py")) + [ROOT / "servidor_py" / "requirements.txt"]:
        if p.exists():
            parts.append(p.name + ":" + p.read_text(encoding="utf-8", errors="replace").replace("\r", ""))
    return "\n".join(parts)


def apply_update(zip_bytes: bytes) -> bool:
    tmp = DATA / "update_tmp"
    if tmp.exists():
        shutil.rmtree(tmp)
    with zipfile.ZipFile(__import__("io").BytesIO(zip_bytes)) as z:
        z.extractall(tmp)
    idx = next((p for p in tmp.rglob("index.html") if p.parent.name == "web"), None)
    if not idx:
        raise RuntimeError("El paquete no contiene la carpeta web")
    src = idx.parent.parent
    # Respaldo de la versión actual (tus datos y .env no se tocan).
    bk = DATA / ("respaldo-" + dt.datetime.now().strftime("%Y%m%d-%H%M%S"))
    bk.mkdir(parents=True)
    for d in UPDATE_DIRS:
        if (ROOT / d).exists():
            shutil.copytree(ROOT / d, bk / d, ignore=shutil.ignore_patterns("__pycache__"))
    for f in UPDATE_FILES:
        if (ROOT / f).exists():
            shutil.copy2(ROOT / f, bk / f)
    before = server_fingerprint()
    for d in UPDATE_DIRS:
        if (src / d).exists():
            if (ROOT / d).exists():
                shutil.rmtree(ROOT / d)
            shutil.copytree(src / d, ROOT / d)
    for f in UPDATE_FILES:
        if (src / f).exists():
            shutil.copy2(src / f, ROOT / f)
    shutil.rmtree(tmp, ignore_errors=True)
    return server_fingerprint() != before


@app.post("/api/update/apply")
async def update_apply(req: Request):
    if (deny := pc_only(req)):
        return deny
    cfg = read_env()
    manifest = (await http.get(cfg["UPDATE_MANIFEST_URL"], timeout=20)).json()
    if not str(manifest.get("zip", "")).startswith("https://"):
        raise RuntimeError("El manifiesto no trae una URL zip valida")
    z = await http.get(manifest["zip"], timeout=180, follow_redirects=True)
    if z.status_code != 200:
        raise RuntimeError(f"No se pudo descargar la actualizacion (HTTP {z.status_code})")
    changed = await asyncio.to_thread(apply_update, z.content)
    # Si cambió el servidor, se instalan las librerías nuevas que pida y se reinicia solo para usar el código nuevo.
    if changed:
        req_file = ROOT / "servidor_py" / "requirements.txt"
        if req_file.exists():
            r = await asyncio.to_thread(subprocess.run, [sys.executable, "-m", "pip", "install", "-q", "--disable-pip-version-check", "-r", str(req_file)],
                                        capture_output=True, text=True, timeout=600, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            if r.returncode != 0:
                # Sin las librerías el servidor nuevo no arrancaría: se queda el actual y se avisa.
                return j({"ok": False, "error": "No se pudieron instalar las librerías nuevas de Python. Revisa tu internet y vuelve a intentar.",
                          "detail": (r.stderr or r.stdout)[-500:]}, 500)
        schedule_restart()
    return j({"ok": True, "version": str(manifest.get("version", "")), "serverChanged": changed, "restarting": changed})


@app.post("/api/restart")
async def restart(req: Request):
    if (deny := pc_only(req)):
        return deny
    schedule_restart()
    return j({"ok": True, "restarting": True})


def schedule_restart() -> None:
    def go():
        print("Reiniciando BetBot MX con la versión nueva...")
        if runner:
            runner.stop()
        flags = getattr(subprocess, "CREATE_NEW_CONSOLE", 0)
        subprocess.Popen([sys.executable, str(ROOT / "servidor_py" / "server.py"), "--port", str(ARGS.port), "--wait", "2"], cwd=str(ROOT), creationflags=flags)
        os._exit(0)
    asyncio.get_running_loop().call_later(0.8, go)


# ---------- bot 24/7 ----------
@app.get("/api/bot/status")
async def bot_status():
    if not runner:
        return j({"enabled": False, "running": False, "healthy": False, "browser": False})
    return j(runner.status())


@app.post("/api/bot/heartbeat")
async def bot_heartbeat(req: Request):
    if (deny := pc_only(req)):
        return deny
    if not runner:
        return j({"stop": True})
    # Si responde "stop", esa pestaña no es la autorizada (o el bot 24/7 está pausado) y se apaga sola.
    return j(runner.heartbeat(await body_json(req)))


@app.post("/api/bot/config")
async def bot_config(req: Request):
    if (deny := pc_only(req)):
        return deny
    b = await body_json(req)
    vals = {}
    if b.get("enabled") is not None:
        runner.enabled = bool(b["enabled"])
        vals["BOT_24_7"] = "1" if runner.enabled else "0"
    if b.get("keepAwake") is not None:
        runner.keep_awake = bool(b["keepAwake"])
        vals["BOT_NO_DORMIR"] = "1" if runner.keep_awake else "0"
    if vals:
        set_env_values(vals)
    runner.set_awake(runner.enabled and runner.keep_awake and bool(runner.browser))
    await asyncio.to_thread(runner.tick)
    return j(runner.status())


@app.post("/api/bot/restart")
async def bot_restart(req: Request):
    if (deny := pc_only(req)):
        return deny
    await asyncio.to_thread(runner.start, "reinicio pedido desde la app")
    return j(runner.status())


# ---------- base de datos de apuestas liquidadas ----------
@app.post("/api/ledger")
async def ledger_post(req: Request):
    items = json.loads((await req.body()).decode("utf-8") or "[]")
    added, total = store.ledger_add(items if isinstance(items, list) else [items])
    return j({"ok": True, "added": added, "total": total})


@app.get("/api/ledger")
async def ledger_get():
    return text(store.ledger_all(), media="application/json; charset=utf-8")


# ---------- app del iPhone ----------
@app.get("/manifest.webmanifest")
async def manifest(req: Request):
    # Si quien instala ya tiene acceso, el inicio lleva su código (la app de inicio no comparte la sesión de Safari).
    authed = req.cookies.get("bb_t") == TOKEN
    m = {
        "id": "/", "name": "BetBot MX", "short_name": "BetBot", "description": "Analisis de apuestas deportivas con IA (banca ficticia)",
        "start_url": f"/?t={TOKEN}&app=1" if authed else "/?app=1", "scope": "/", "display": "standalone", "orientation": "portrait",
        "background_color": "#0b0b10", "theme_color": "#0b0b10", "lang": "es-MX",
        "icons": [
            {"src": "/icons/icon-180.png", "sizes": "180x180", "type": "image/png"},
            {"src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png"},
            {"src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png"},
            {"src": "/icons/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
        ],
    }
    return text(json.dumps(m, separators=(",", ":")), media="application/manifest+json")


@app.get("/api/apptoken")
async def apptoken(req: Request):
    return j({"token": "" if is_local(req) else TOKEN})


# ---------- archivos de la app ----------
@app.api_route("/{path:path}", methods=["GET", "HEAD"])
async def static(path: str):
    rel = "index.html" if path in ("", "/") else path
    f = (WEB / rel).resolve()
    if not str(f).startswith(str(WEB.resolve())) or not f.is_file():
        return text("No encontrado", 404)
    return Response(f.read_bytes(), media_type=MIME.get(f.suffix.lower(), "application/octet-stream"), headers={"Cache-Control": "no-store"})


# ---------- arranque ----------
def init() -> None:
    global store, TOKEN
    DATA.mkdir(parents=True, exist_ok=True)
    if not TOKEN_PATH.exists():
        alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        TOKEN_PATH.write_text("".join(secrets.choice(alphabet) for _ in range(24)), encoding="utf-8")
    TOKEN = TOKEN_PATH.read_text(encoding="utf-8-sig").strip()
    store = Store(DATA)
    rep = store.sync_from_files()
    if rep["estado"] or rep["apuestas"] or rep["push"]:
        print(f"Datos importados de los archivos: estado={'sí' if rep['estado'] else 'sin cambios'}, apuestas nuevas={rep['apuestas']}, avisos={'sí' if rep['push'] else 'sin cambios'}")
    if not store.push_keys():
        priv, pub = pushmod.new_keys()
        store.set_push_keys(priv, pub, 0)


def main() -> None:
    global ARGS
    ap = argparse.ArgumentParser(description="BetBot MX - servidor local")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--wait", type=float, default=0, help="segundos de espera antes de abrir el puerto (reinicios)")
    ap.add_argument("--host", default="0.0.0.0")
    ARGS = ap.parse_args()
    # Mensajes con acentos y flechas aunque la ventana o el archivo de registro no usen UTF-8.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    if ARGS.wait:
        time.sleep(ARGS.wait)
    init()
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("0.0.0.0", ARGS.port))
    except OSError:
        print(f"No se pudo abrir el puerto {ARGS.port}. Probablemente BetBot MX ya está abierto en otra ventana.")
        print(f"Entra a http://localhost:{ARGS.port} o cierra la otra ventana y vuelve a intentar.")
        sys.exit(1)
    uvicorn.run(app, host=ARGS.host, port=ARGS.port, log_level="warning", access_log=False)


if __name__ == "__main__":
    main()
