"""Notificaciones push (Web Push + VAPID) para la app del iPhone.

Llegan a la pantalla de bloqueo aunque la app esté cerrada (requiere la dirección HTTPS de Tailscale).
Cada vez que se guarda la banca, se revisa la bitácora del bot y se envía lo nuevo: oportunidades de oro,
apuestas nuevas, ganadas/perdidas y entradas de los top apostadores. Nada sale de tu PC salvo el aviso cifrado.
Usa las mismas llaves VAPID que el servidor de PowerShell, así los iPhones ya suscritos siguen recibiendo avisos.
"""

from __future__ import annotations

import base64
import json
import time

from cryptography.hazmat.primitives.asymmetric import ec
from py_vapid import Vapid02
from pywebpush import WebPushException, webpush

PREF_KEYS = ("gold", "bets", "newbets", "smart")
WHALE = "\U0001F40B"


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def b64u_dec(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def new_keys() -> tuple[str, str]:
    """Llave privada (32 bytes) y pública sin comprimir (65 bytes), en base64url, igual que el servidor anterior."""
    k = ec.generate_private_key(ec.SECP256R1())
    priv = k.private_numbers().private_value.to_bytes(32, "big")
    pub = k.public_key().public_numbers()
    return b64u(priv), b64u(b"\x04" + pub.x.to_bytes(32, "big") + pub.y.to_bytes(32, "big"))


def vapid(priv_b64: str) -> Vapid02:
    d = int.from_bytes(b64u_dec(priv_b64), "big")
    # "no-strict": el remitente es la dirección del proyecto (https://...), como en el servidor anterior; Apple lo acepta.
    return Vapid02(private_key=ec.derive_private_key(d, ec.SECP256R1()), conf={"no-strict": True})


def prefs(src) -> dict:
    d = {k: True for k in PREF_KEYS}
    if isinstance(src, dict):
        for k in PREF_KEYS:
            if src.get(k) is not None:
                d[k] = bool(src[k])
    return d


def send(store, sub: dict, payload: dict, subject: str) -> int:
    """Devuelve el código HTTP del servicio de notificaciones (201 = enviado; 404/410 = la suscripción ya no existe)."""
    keys = store.push_keys()
    try:
        r = webpush(
            subscription_info={"endpoint": sub["endpoint"], "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]}},
            data=json.dumps(payload, ensure_ascii=False),
            vapid_private_key=vapid(keys[0]),
            vapid_claims={"sub": subject},
            ttl=86400,
            headers={"Urgency": "high"},
            content_encoding="aes128gcm",
            timeout=15,
        )
        code = r.status_code
    except WebPushException as e:
        code = e.response.status_code if e.response is not None else 0
        if not code:
            print(f"Aviso push no enviado: {e}")
    except Exception as e:  # red caída, endpoint inválido, etc.
        print(f"Aviso push no enviado: {e}")
        return 0
    # 404/410: el iPhone borró la app o quitó el permiso; se olvida esa suscripción.
    if code in (404, 410):
        store.delete_push_sub(sub["endpoint"])
    return code


def category(entry: dict) -> str | None:
    kind = str(entry.get("kind") or "")
    if kind == "gold":
        return "gold"
    if kind in ("won", "lost", "void"):
        return "bets"
    if kind == "bet":
        return "newbets"
    if kind == "ai" and str(entry.get("msg") or "").startswith(WHALE):
        return "smart"
    return None


def push_from_state(store, state: dict, subject: str) -> None:
    try:
        entries = [e for e in (state.get("log") or []) if isinstance(e, dict) and e.get("t")]
        if not entries:
            return
        keys = store.push_keys()
        since = float(keys[2] or 0)
        max_t = max(float(e["t"]) for e in entries)
        first = not since
        if max_t <= since:
            return  # nada nuevo en la bitácora
        store.set_push_last(max(since, max_t))
        subs = store.push_subs()
        # La primera vez solo se marca hasta dónde va la bitácora (no se envía el historial completo).
        if first or not subs:
            return
        now = time.time() * 1000
        fresh = sorted((e for e in entries if float(e["t"]) > since and now - float(e["t"]) < 15 * 60 * 1000), key=lambda e: float(e["t"]))
        for sub in subs:
            mine = [e for e in fresh if (c := category(e)) and sub["prefs"].get(c, True)]
            for e in mine[:4]:
                send(store, sub, {"kind": str(e.get("kind")), "cat": category(e), "msg": str(e.get("msg") or ""), "t": e["t"]}, subject)
            if len(mine) > 4:
                send(store, sub, {"kind": "more", "cat": "more", "msg": "", "count": len(mine) - 4, "t": int(now)}, subject)
    except Exception as e:
        print(f"Avisos push: {e}")
