# BetBot MX - servidor local (solo PowerShell, sin instalar nada)
# - Sirve la app web y guarda la banca ficticia en data\state.json (con control de versiones entre dispositivos).
# - Guarda tus claves en .env y las usa SOLO aqui: el navegador (PC o celular) nunca las recibe.
#   Las llamadas a Claude y a The Odds API pasan por este servidor, que agrega la clave.
# - Acceso desde el celular en tu WiFi con un codigo secreto (QR). Requiere ejecutar una vez habilitar-telefono.bat.
# - Actualizaciones: descarga la version publicada (UPDATE_MANIFEST_URL en .env) y conserva tus datos.

param([int]$Port = 8787)

# Versión del servidor: la app la compara con la de la página para avisar si hace falta reiniciarlo.
$SERVER_VERSION = '1.9.1'

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$webDir = Join-Path $root 'web'
$dataDir = Join-Path $root 'data'
$statePath = Join-Path $dataDir 'state.json'
$revPath = Join-Path $dataDir 'state.rev'
$tokenPath = Join-Path $dataDir 'token.txt'
$envPath = Join-Path $root '.env'
if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir | Out-Null }
$utf8 = New-Object Text.UTF8Encoding($false)

# Codigo secreto para entrar desde otros dispositivos (se crea una sola vez).
if (-not (Test-Path $tokenPath)) {
  $chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'.ToCharArray()
  $rng = New-Object Security.Cryptography.RNGCryptoServiceProvider
  $buf = New-Object byte[] 24; $rng.GetBytes($buf)
  [IO.File]::WriteAllText($tokenPath, (-join ($buf | ForEach-Object { $chars[$_ % $chars.Length] })), $utf8)
}
$token = ([IO.File]::ReadAllText($tokenPath)).Trim()

$proxyHosts = @('news.google.com', 'liquipedia.net', 'api.elections.kalshi.com', 'data-api.polymarket.com', 'api.bo3.gg')
# Liquipedia pide: gzip, User-Agent identificable y maximo 1 consulta "parse" cada 30 s.
$proxyCache = @{}
$imgCache = @{}
$script:lastLiquipedia = [DateTime]::MinValue
$mime = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json; charset=utf-8'
  '.svg' = 'image/svg+xml'; '.png' = 'image/png'; '.ico' = 'image/x-icon'; '.webmanifest' = 'application/manifest+json'
}

$defaultManifest = 'https://raw.githubusercontent.com/EGOArrogant/BET-BOT/main/web/version.json'

function Read-EnvFile {
  $cfg = @{}
  if (Test-Path $envPath) {
    foreach ($line in [IO.File]::ReadAllLines($envPath)) {
      if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$') { $cfg[$Matches[1]] = $Matches[2].Trim('"', "'", ' ') }
    }
  }
  # Por defecto, las actualizaciones vienen del repositorio oficial del bot en GitHub.
  if (-not $cfg['UPDATE_MANIFEST_URL']) { $cfg['UPDATE_MANIFEST_URL'] = $defaultManifest }
  $cfg
}

function Set-EnvValues([hashtable]$vals) {
  $lines = if (Test-Path $envPath) { [IO.File]::ReadAllLines($envPath) } else { @() }
  $out = New-Object System.Collections.Generic.List[string]
  $done = @{}
  foreach ($l in $lines) {
    if ($l -match '^\s*([A-Z0-9_]+)\s*=' -and $vals.ContainsKey($Matches[1])) { $k = $Matches[1]; $out.Add("$k=$($vals[$k])"); $done[$k] = 1; continue }
    $out.Add($l)
  }
  foreach ($k in $vals.Keys) { if (-not $done[$k]) { $out.Add("$k=$($vals[$k])") } }
  [IO.File]::WriteAllLines($envPath, $out, $utf8)
}

function Send-Bytes($ctx, [byte[]]$bytes, [string]$type, [int]$status = 200, [string]$cacheControl = 'no-store') {
  $res = $ctx.Response
  $res.StatusCode = $status
  $res.ContentType = $type
  $res.Headers['Cache-Control'] = $cacheControl
  $res.ContentLength64 = $bytes.Length
  # Las peticiones HEAD (revisiones de "esta vivo?") no llevan cuerpo.
  if ($ctx.Request.HttpMethod -ne 'HEAD') { $res.OutputStream.Write($bytes, 0, $bytes.Length) }
  $res.OutputStream.Close()
}
function Send-Text($ctx, [string]$text, [string]$type = 'application/json; charset=utf-8', [int]$status = 200) {
  Send-Bytes $ctx ($utf8.GetBytes($text)) $type $status
}
function Read-Body($req) {
  $ms = New-Object IO.MemoryStream
  $req.InputStream.CopyTo($ms)
  $ms.ToArray()
}

# ---------- Conexiones por Tailscale ----------
# "tailscale serve" entrega las visitas del iPhone desde 127.0.0.1, pero NO son la PC:
# se reconocen por sus encabezados y se tratan como otro dispositivo (piden el codigo de acceso).
function Test-Local($req) {
  if (-not $req.IsLocal) { return $false }
  if ($req.Headers['Tailscale-User-Login'] -or $req.Headers['X-Forwarded-For'] -or ([string]$req.Headers['Host']) -like '*.ts.net*') { return $false }
  return $true
}

function Get-TailscaleExe {
  foreach ($p in @((Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'), (Join-Path ${env:ProgramFiles(x86)} 'Tailscale\tailscale.exe'))) { if ($p -and (Test-Path $p)) { return $p } }
  $c = Get-Command tailscale.exe -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  return $null
}
function Invoke-Tailscale([string[]]$argv, [int]$timeoutMs = 8000) {
  $exe = Get-TailscaleExe
  if (-not $exe) { return $null }
  $psi = New-Object Diagnostics.ProcessStartInfo($exe, ($argv -join ' '))
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $p = [Diagnostics.Process]::Start($psi)
  $o = $p.StandardOutput.ReadToEndAsync(); $e = $p.StandardError.ReadToEndAsync()
  $done = $p.WaitForExit($timeoutMs)
  # "tailscale serve" se queda esperando si falta activar HTTPS en tu cuenta: se corta y se devuelve el enlace.
  if (-not $done) { try { $p.Kill() } catch {} ; $null = $p.WaitForExit(2000) }
  return @{ done = $done; code = $(if ($done) { $p.ExitCode } else { -1 }); out = [string]$o.Result; err = [string]$e.Result }
}

# ---------- Notificaciones push (Web Push + VAPID) ----------
# Llegan a la pantalla de bloqueo del iPhone aunque la app este cerrada (requiere la direccion HTTPS de Tailscale).
# El servidor revisa la bitacora del bot cada vez que se guarda la banca y envia lo nuevo: oportunidades de oro,
# apuestas nuevas, ganadas/perdidas y entradas de los top apostadores. Nada sale de tu PC salvo el aviso cifrado.
$pushPath = Join-Path $dataDir 'push.json'
$pushSubject = 'https://github.com/EGOArrogant/BET-BOT'
$pushCs = @'
using System;
using System.IO;
using System.Net;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;

// Web Push (RFC 8291 aes128gcm + VAPID RFC 8292) sin dependencias: P-256, ECDSA, HKDF y AES-GCM
// implementados aqui porque .NET Framework 4.x (PowerShell 5.1) no trae ECDH "crudo" ni AES-GCM.
public static class BetBotPush
{
    static readonly BigInteger P = H("ffffffff00000001000000000000000000000000ffffffffffffffffffffffff");
    static readonly BigInteger N = H("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
    static readonly BigInteger B = H("5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b");
    static readonly BigInteger GX = H("6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296");
    static readonly BigInteger GY = H("4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5");
    static readonly RandomNumberGenerator Rng = RandomNumberGenerator.Create();

    static BigInteger H(string hex) { return BigInteger.Parse("0" + hex, System.Globalization.NumberStyles.HexNumber); }
    static BigInteger Mod(BigInteger a, BigInteger m) { BigInteger r = a % m; return r.Sign < 0 ? r + m : r; }
    static BigInteger Inv(BigInteger a, BigInteger m) { return BigInteger.ModPow(Mod(a, m), m - 2, m); }

    // ---------- Curva P-256 (coordenadas jacobianas: una sola inversion por multiplicacion) ----------
    struct J { public BigInteger X, Y, Z; public bool Inf; }

    static J Dbl(J p)
    {
        if (p.Inf || p.Y.IsZero) return new J { Inf = true };
        BigInteger ysq = Mod(p.Y * p.Y, P);
        BigInteger s = Mod(4 * p.X * ysq, P);
        BigInteger z2 = Mod(p.Z * p.Z, P);
        BigInteger m = Mod(3 * (p.X - z2) * (p.X + z2), P); // a = -3
        BigInteger x3 = Mod(m * m - 2 * s, P);
        BigInteger y3 = Mod(m * (s - x3) - 8 * ysq * ysq, P);
        BigInteger z3 = Mod(2 * p.Y * p.Z, P);
        return new J { X = x3, Y = y3, Z = z3 };
    }

    static J AddJ(J p, J q)
    {
        if (p.Inf) return q;
        if (q.Inf) return p;
        BigInteger z1s = Mod(p.Z * p.Z, P), z2s = Mod(q.Z * q.Z, P);
        BigInteger u1 = Mod(p.X * z2s, P), u2 = Mod(q.X * z1s, P);
        BigInteger s1 = Mod(p.Y * z2s * q.Z, P), s2 = Mod(q.Y * z1s * p.Z, P);
        if (u1 == u2) return s1 == s2 ? Dbl(p) : new J { Inf = true };
        BigInteger h = Mod(u2 - u1, P), r = Mod(s2 - s1, P);
        BigInteger h2 = Mod(h * h, P), h3 = Mod(h2 * h, P);
        BigInteger x3 = Mod(r * r - h3 - 2 * u1 * h2, P);
        BigInteger y3 = Mod(r * (u1 * h2 - x3) - s1 * h3, P);
        BigInteger z3 = Mod(h * p.Z * q.Z, P);
        return new J { X = x3, Y = y3, Z = z3 };
    }

    static void Mul(BigInteger k, BigInteger x, BigInteger y, out BigInteger rx, out BigInteger ry)
    {
        J acc = new J { Inf = true };
        J pt = new J { X = x, Y = y, Z = 1 };
        byte[] kb = ToBytes(k, 32);
        for (int i = 0; i < 32; i++)
            for (int b = 7; b >= 0; b--)
            {
                acc = Dbl(acc);
                if (((kb[i] >> b) & 1) == 1) acc = AddJ(acc, pt);
            }
        if (acc.Inf) throw new CryptographicException("punto en el infinito");
        BigInteger zi = Inv(acc.Z, P), zi2 = Mod(zi * zi, P);
        rx = Mod(acc.X * zi2, P);
        ry = Mod(acc.Y * zi2 * zi, P);
    }

    static bool OnCurve(BigInteger x, BigInteger y)
    {
        return x < P && y < P && Mod(y * y - (x * x * x - 3 * x + B), P).IsZero;
    }

    // ---------- Conversion de bytes ----------
    static BigInteger FromBytes(byte[] be, int off, int len)
    {
        byte[] le = new byte[len + 1];
        for (int i = 0; i < len; i++) le[i] = be[off + len - 1 - i];
        return new BigInteger(le);
    }
    static byte[] ToBytes(BigInteger v, int len)
    {
        byte[] le = v.ToByteArray();
        byte[] be = new byte[len];
        for (int i = 0; i < len && i < le.Length; i++) be[len - 1 - i] = le[i];
        return be;
    }
    static byte[] Concat(params byte[][] parts)
    {
        MemoryStream ms = new MemoryStream();
        foreach (byte[] p in parts) ms.Write(p, 0, p.Length);
        return ms.ToArray();
    }
    public static string B64U(byte[] b) { return Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_'); }
    public static byte[] FromB64U(string s)
    {
        s = s.Replace('-', '+').Replace('_', '/');
        while (s.Length % 4 != 0) s += "=";
        return Convert.FromBase64String(s);
    }
    static BigInteger RandomScalar()
    {
        byte[] b = new byte[32];
        while (true)
        {
            Rng.GetBytes(b);
            BigInteger k = FromBytes(b, 0, 32);
            if (k > 0 && k < N) return k;
        }
    }
    static byte[] PublicFromPrivate(BigInteger d)
    {
        BigInteger x, y; Mul(d, GX, GY, out x, out y);
        return Concat(new byte[] { 4 }, ToBytes(x, 32), ToBytes(y, 32));
    }

    // ---------- Claves VAPID ----------
    // Devuelve [privada (32 bytes, base64url), publica sin comprimir (65 bytes, base64url)].
    public static string[] NewKeys()
    {
        BigInteger d = RandomScalar();
        return new string[] { B64U(ToBytes(d, 32)), B64U(PublicFromPrivate(d)) };
    }
    public static string PublicKeyOf(string privB64u) { return B64U(PublicFromPrivate(FromBytes(FromB64U(privB64u), 0, 32))); }

    // ECDSA P-256 / SHA-256, firma r||s (formato JWS ES256).
    public static byte[] Sign(byte[] data, string privB64u)
    {
        BigInteger d = FromBytes(FromB64U(privB64u), 0, 32);
        byte[] hash; using (SHA256 sha = SHA256.Create()) hash = sha.ComputeHash(data);
        BigInteger z = FromBytes(hash, 0, 32);
        while (true)
        {
            BigInteger k = RandomScalar(), kx, ky;
            Mul(k, GX, GY, out kx, out ky);
            BigInteger r = Mod(kx, N);
            if (r.IsZero) continue;
            BigInteger s = Mod(Inv(k, N) * (z + r * d), N);
            if (s.IsZero) continue;
            return Concat(ToBytes(r, 32), ToBytes(s, 32));
        }
    }

    public static string VapidJwt(string audience, string subject, string privB64u)
    {
        long exp = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalSeconds + 12 * 3600;
        string head = B64U(Encoding.UTF8.GetBytes("{\"typ\":\"JWT\",\"alg\":\"ES256\"}"));
        string claims = B64U(Encoding.UTF8.GetBytes("{\"aud\":\"" + audience + "\",\"exp\":" + exp + ",\"sub\":\"" + subject + "\"}"));
        string input = head + "." + claims;
        return input + "." + B64U(Sign(Encoding.ASCII.GetBytes(input), privB64u));
    }

    // ---------- HKDF y AES-128-GCM ----------
    static byte[] Hmac(byte[] key, byte[] data) { using (HMACSHA256 h = new HMACSHA256(key)) return h.ComputeHash(data); }
    static byte[] Expand(byte[] prk, byte[] info, int len)
    {
        byte[] t = Hmac(prk, Concat(info, new byte[] { 1 }));
        byte[] o = new byte[len]; Array.Copy(t, o, len); return o;
    }

    static void GfMul(ref ulong xh, ref ulong xl, ulong yh, ulong yl)
    {
        ulong zh = 0, zl = 0, vh = yh, vl = yl;
        for (int i = 0; i < 128; i++)
        {
            ulong bit = i < 64 ? (xh >> (63 - i)) & 1UL : (xl >> (127 - i)) & 1UL;
            if (bit == 1UL) { zh ^= vh; zl ^= vl; }
            bool lsb = (vl & 1UL) == 1UL;
            vl = (vl >> 1) | (vh << 63);
            vh >>= 1;
            if (lsb) vh ^= 0xE100000000000000UL;
        }
        xh = zh; xl = zl;
    }
    static ulong U64(byte[] b, int o) { ulong v = 0; for (int i = 0; i < 8; i++) v = (v << 8) | b[o + i]; return v; }
    static void PutU64(byte[] b, int o, ulong v) { for (int i = 7; i >= 0; i--) { b[o + i] = (byte)v; v >>= 8; } }

    static byte[] AesGcmEncrypt(byte[] key, byte[] nonce, byte[] plain)
    {
        using (Aes aes = Aes.Create())
        {
            aes.Mode = CipherMode.ECB; aes.Padding = PaddingMode.None; aes.Key = key;
            ICryptoTransform enc = aes.CreateEncryptor();
            byte[] hBlock = new byte[16]; enc.TransformBlock(new byte[16], 0, 16, hBlock, 0);
            ulong hh = U64(hBlock, 0), hl = U64(hBlock, 8);
            byte[] j0 = new byte[16]; Array.Copy(nonce, j0, 12); j0[15] = 1;
            byte[] cipher = new byte[plain.Length];
            byte[] ctr = (byte[])j0.Clone(), ks = new byte[16];
            for (int off = 0; off < plain.Length; off += 16)
            {
                for (int i = 15; i >= 12; i--) { if (++ctr[i] != 0) break; }
                enc.TransformBlock(ctr, 0, 16, ks, 0);
                for (int i = 0; i < 16 && off + i < plain.Length; i++) cipher[off + i] = (byte)(plain[off + i] ^ ks[i]);
            }
            // GHASH (sin datos adicionales)
            ulong gh = 0, gl = 0;
            for (int off = 0; off < cipher.Length; off += 16)
            {
                byte[] blk = new byte[16];
                Array.Copy(cipher, off, blk, 0, Math.Min(16, cipher.Length - off));
                gh ^= U64(blk, 0); gl ^= U64(blk, 8);
                GfMul(ref gh, ref gl, hh, hl);
            }
            gl ^= (ulong)cipher.Length * 8UL;
            GfMul(ref gh, ref gl, hh, hl);
            byte[] tagMask = new byte[16]; enc.TransformBlock(j0, 0, 16, tagMask, 0);
            byte[] tag = new byte[16]; PutU64(tag, 0, gh); PutU64(tag, 8, gl);
            for (int i = 0; i < 16; i++) tag[i] ^= tagMask[i];
            return Concat(cipher, tag);
        }
    }

    // ---------- Cifrado del mensaje (RFC 8291) ----------
    // asPriv y salt opcionales (null = aleatorios); se pueden fijar solo para probar con el ejemplo del RFC.
    public static byte[] Encrypt(byte[] plaintext, string uaPublicB64u, string authB64u, string asPrivB64u, string saltB64u)
    {
        byte[] uaPub = FromB64U(uaPublicB64u), auth = FromB64U(authB64u);
        if (uaPub.Length != 65 || uaPub[0] != 4) throw new ArgumentException("clave p256dh invalida");
        BigInteger ux = FromBytes(uaPub, 1, 32), uy = FromBytes(uaPub, 33, 32);
        if (!OnCurve(ux, uy)) throw new ArgumentException("clave p256dh fuera de la curva");
        BigInteger asD = string.IsNullOrEmpty(asPrivB64u) ? RandomScalar() : FromBytes(FromB64U(asPrivB64u), 0, 32);
        byte[] asPub = PublicFromPrivate(asD);
        BigInteger sx, sy; Mul(asD, ux, uy, out sx, out sy);
        byte[] ecdh = ToBytes(sx, 32);
        byte[] salt = new byte[16];
        if (string.IsNullOrEmpty(saltB64u)) Rng.GetBytes(salt); else salt = FromB64U(saltB64u);

        byte[] keyInfo = Concat(Encoding.ASCII.GetBytes("WebPush: info"), new byte[] { 0 }, uaPub, asPub);
        byte[] ikm = Expand(Hmac(auth, ecdh), keyInfo, 32);
        byte[] prk = Hmac(salt, ikm);
        byte[] cek = Expand(prk, Concat(Encoding.ASCII.GetBytes("Content-Encoding: aes128gcm"), new byte[] { 0 }), 16);
        byte[] nonce = Expand(prk, Concat(Encoding.ASCII.GetBytes("Content-Encoding: nonce"), new byte[] { 0 }), 12);
        byte[] ct = AesGcmEncrypt(cek, nonce, Concat(plaintext, new byte[] { 2 }));
        byte[] header = Concat(salt, new byte[] { 0, 0, 16, 0 }, new byte[] { 65 }, asPub);
        return Concat(header, ct);
    }

    // ---------- Envio ----------
    // Devuelve el codigo HTTP del servicio de notificaciones (201 = enviado; 404/410 = la suscripcion ya no existe).
    public static int Send(string endpoint, string p256dh, string auth, string payloadJson, string vapidPriv, string vapidPub, string subject, int ttl, string urgency)
    {
        byte[] body = Encrypt(Encoding.UTF8.GetBytes(payloadJson), p256dh, auth, null, null);
        Uri u = new Uri(endpoint);
        string aud = u.Scheme + "://" + u.Host + (u.IsDefaultPort ? "" : ":" + u.Port);
        HttpWebRequest req = (HttpWebRequest)WebRequest.Create(endpoint);
        req.Method = "POST";
        req.Timeout = 15000;
        req.ContentType = "application/octet-stream";
        req.Headers["Content-Encoding"] = "aes128gcm";
        req.Headers["TTL"] = ttl.ToString();
        req.Headers["Urgency"] = urgency;
        req.Headers["Authorization"] = "vapid t=" + VapidJwt(aud, subject, vapidPriv) + ", k=" + vapidPub;
        req.ContentLength = body.Length;
        using (Stream s = req.GetRequestStream()) s.Write(body, 0, body.Length);
        try
        {
            using (HttpWebResponse res = (HttpWebResponse)req.GetResponse()) return (int)res.StatusCode;
        }
        catch (WebException e)
        {
            HttpWebResponse r = e.Response as HttpWebResponse;
            if (r != null) { int c = (int)r.StatusCode; r.Close(); return c; }
            throw;
        }
    }
}
'@
if (-not ('BetBotPush' -as [type])) { Add-Type -TypeDefinition $pushCs -ReferencedAssemblies System.Numerics, System.Core }

function New-PushPrefs($src) {
  $d = @{ gold = $true; bets = $true; newbets = $true; smart = $true }
  if ($src) { foreach ($k in @($d.Keys)) { $v = $src.$k; if ($v -ne $null) { $d[$k] = [bool]$v } } }
  return $d
}
function Load-Push {
  $p = @{ priv = $null; pub = $null; lastT = 0; subs = New-Object Collections.ArrayList }
  if (Test-Path $pushPath) {
    try {
      $j = [IO.File]::ReadAllText($pushPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
      $p.priv = [string]$j.priv; $p.pub = [string]$j.pub; $p.lastT = [double]$j.lastT
      foreach ($s in @($j.subs)) {
        if ($s -and $s.endpoint) { [void]$p.subs.Add(@{ endpoint = [string]$s.endpoint; p256dh = [string]$s.p256dh; auth = [string]$s.auth; device = [string]$s.device; added = [double]$s.added; prefs = (New-PushPrefs $s.prefs) }) }
      }
    } catch { Write-Host "push.json danado, se crea de nuevo: $($_.Exception.Message)" }
  }
  if (-not $p.priv) { $k = [BetBotPush]::NewKeys(); $p.priv = $k[0]; $p.pub = $k[1] }
  return $p
}
function Save-Push { [IO.File]::WriteAllText($pushPath, ($script:push | ConvertTo-Json -Depth 6), $utf8) }
$script:push = Load-Push
Save-Push

function Find-PushSub([string]$endpoint) { foreach ($s in $script:push.subs) { if ($s.endpoint -eq $endpoint) { return $s } }; return $null }

function Send-Push($sub, $payload) {
  try {
    $json = $payload | ConvertTo-Json -Compress -Depth 4
    $code = [BetBotPush]::Send($sub.endpoint, $sub.p256dh, $sub.auth, $json, $script:push.priv, $script:push.pub, $pushSubject, 86400, 'high')
  } catch { Write-Host "Aviso push no enviado: $($_.Exception.Message)"; return 0 }
  # 404/410: el iPhone borro la app o quito el permiso; se olvida esa suscripcion.
  if ($code -eq 404 -or $code -eq 410) { $script:push.subs.Remove($sub); Save-Push }
  return $code
}

# Categoria de cada mensaje de la bitacora (lo demas no genera aviso).
function Get-PushCategory($entry) {
  switch ([string]$entry.kind) {
    'gold' { return 'gold' }
    'won' { return 'bets' }
    'lost' { return 'bets' }
    'void' { return 'bets' }
    'bet' { return 'newbets' }
    'ai' { if (([string]$entry.msg).StartsWith([char]::ConvertFromUtf32(0x1F40B))) { return 'smart' } }
  }
  return $null
}

function Push-FromState($stateObj) {
  $entries = @($stateObj.log | Where-Object { $_ -and $_.t })
  if (-not $entries.Count) { return }
  $maxT = ($entries | Measure-Object -Property t -Maximum).Maximum
  $first = -not $script:push.lastT
  $since = [double]$script:push.lastT
  if ([double]$maxT -le $since) { return }   # nada nuevo en la bitacora
  $script:push.lastT = [Math]::Max($since, [double]$maxT)
  Save-Push
  # La primera vez solo se marca hasta donde va la bitacora (no se envia el historial completo).
  if ($first -or -not $script:push.subs.Count) { return }
  $now = ([DateTimeOffset]::UtcNow).ToUnixTimeMilliseconds()
  $fresh = @($entries | Where-Object { [double]$_.t -gt $since -and $now - [double]$_.t -lt 15 * 60 * 1000 } | Sort-Object { [double]$_.t })
  foreach ($sub in @($script:push.subs)) {
    $mine = @($fresh | Where-Object { $c = Get-PushCategory $_; $c -and $sub.prefs[$c] })
    $sent = 0
    foreach ($e in $mine) {
      if ($sent -ge 4) { break }
      $null = Send-Push $sub @{ kind = [string]$e.kind; cat = (Get-PushCategory $e); msg = [string]$e.msg; t = $e.t }
      $sent++
    }
    if ($mine.Count -gt 4) { $null = Send-Push $sub @{ kind = 'more'; cat = 'more'; msg = ''; count = ($mine.Count - 4); t = $now } }
  }
}

# Peticion HTTP saliente con control total (devuelve tambien el cuerpo de los errores).
function Invoke-Forward([string]$method, [string]$url, [hashtable]$headers, [byte[]]$body, [int]$timeoutSec = 60) {
  $wr = [System.Net.HttpWebRequest]::Create($url)
  $wr.Method = $method
  $wr.Timeout = $timeoutSec * 1000
  $wr.ReadWriteTimeout = $timeoutSec * 1000
  $wr.AutomaticDecompression = [System.Net.DecompressionMethods]::GZip -bor [System.Net.DecompressionMethods]::Deflate
  $wr.UserAgent = 'BetBotMX/1.1 (app personal de analisis)'
  foreach ($k in $headers.Keys) {
    if ($k -eq 'Content-Type') { $wr.ContentType = $headers[$k] }
    elseif ($k -eq 'User-Agent') { $wr.UserAgent = $headers[$k] }
    elseif ($k -eq 'Accept') { $wr.Accept = $headers[$k] }
    else { $wr.Headers[$k] = $headers[$k] }
  }
  if ($body -and $body.Length) {
    $wr.ContentLength = $body.Length
    $s = $wr.GetRequestStream(); $s.Write($body, 0, $body.Length); $s.Close()
  }
  try { $resp = $wr.GetResponse() }
  catch [System.Net.WebException] { $resp = $_.Exception.Response; if (-not $resp) { throw } }
  $ms = New-Object IO.MemoryStream
  $resp.GetResponseStream().CopyTo($ms)
  $out = @{ status = [int]$resp.StatusCode; type = [string]$resp.ContentType; bytes = $ms.ToArray(); headers = $resp.Headers }
  $resp.Close()
  $out
}

$deniedHtml = @'
<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BetBot MX</title><body style="font-family:-apple-system,system-ui,sans-serif;background:#0b0b10;color:#f5f5f7;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:24px">
<div><div style="font-size:54px">&#128274;</div><h1 style="margin:8px 0">BetBot MX</h1>
<p style="color:#aaa;max-width:340px">Para entrar desde este dispositivo, escanea el c&oacute;digo QR que aparece en la app de tu computadora (M&aacute;s &rarr; Celular).</p></div></body></html>
'@

# Devuelve $true si puede pasar; si no, ya respondio (redirige o niega).
function Test-Auth($ctx) {
  $req = $ctx.Request
  if (Test-Local $req) { return $true }
  # Icono, pantalla de inicio y manifiesto de la app del iPhone: iOS los pide sin la sesion.
  if ($req.Url.AbsolutePath -like '/icons/*' -or $req.Url.AbsolutePath -in @('/manifest.webmanifest', '/sw.js', '/offline.html')) { return $true }
  $c = $req.Cookies['bb_t']
  if ($c -and $c.Value -eq $token) { return $true }
  if ($req.Headers['X-BetBot-Token'] -eq $token) { return $true }
  if ($req.QueryString['t'] -eq $token) {
    $ctx.Response.AppendHeader('Set-Cookie', "bb_t=$token; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax")
    $ctx.Response.Redirect('/')
    $ctx.Response.Close()
    return $false
  }
  Send-Text $ctx $deniedHtml 'text/html; charset=utf-8' 401
  return $false
}

function Get-Rev { if (Test-Path $revPath) { [int]([IO.File]::ReadAllText($revPath).Trim()) } else { 0 } }

function Get-LanIps {
  @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.AddressState -eq 'Preferred' } |
    Sort-Object { if ($_.InterfaceAlias -match 'Wi-?Fi|WLAN|Ethernet') { 0 } else { 1 } } |
    ForEach-Object { $_.IPAddress })
}

function Get-LocalVersion {
  $vf = Join-Path $webDir 'version.json'
  if (Test-Path $vf) { [IO.File]::ReadAllText($vf, [Text.Encoding]::UTF8) } else { '{"version":"0.0.0"}' }
}

# ---------- arranque: intenta abrir para la red local; si no hay permiso, solo esta PC ----------
$script:lanEnabled = $false
$script:rebind = $false
$script:restart = $false
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://+:$Port/")
try { $listener.Start(); $script:lanEnabled = $true }
catch {
  $listener = New-Object System.Net.HttpListener
  $listener.Prefixes.Add("http://localhost:$Port/")
  try { $listener.Start() }
  catch {
    Write-Host "No se pudo abrir el puerto $Port. Probablemente BetBot MX ya esta abierto en otra ventana." -ForegroundColor Yellow
    Write-Host "Entra a http://localhost:$Port o cierra la otra ventana y vuelve a intentar."
    exit 1
  }
}
Write-Host "BetBot MX corriendo en http://localhost:$Port  (cierra esta ventana para detenerlo)" -ForegroundColor Green
if ($script:lanEnabled) { Write-Host "Acceso desde el celular: ACTIVO (escanea el QR en Mas -> Celular)" -ForegroundColor Cyan }
else { Write-Host "Acceso desde el celular: desactivado (ejecuta habilitar-telefono.bat una vez)" -ForegroundColor DarkGray }

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $path = $req.Url.AbsolutePath
    try {
      if (-not (Test-Auth $ctx)) { continue }
      $cfg = Read-EnvFile

      if ($path -eq '/api/config') {
        $out = @{
          hasAnthropic = [bool]$cfg['ANTHROPIC_API_KEY']
          hasOdds      = [bool]$cfg['ODDS_API_KEY']
          aiModel      = $(if ($cfg['AI_MODEL']) { $cfg['AI_MODEL'] } else { 'claude-opus-5-5' })
          hasUpdates   = [bool]$cfg['UPDATE_MANIFEST_URL']
          local        = (Test-Local $req)
          lan          = $script:lanEnabled
          serverVersion = $SERVER_VERSION
        }
        Send-Text $ctx ($out | ConvertTo-Json -Compress)
      }
      elseif ($path -eq '/api/state' -and $req.HttpMethod -eq 'GET') {
        $ctx.Response.Headers['X-Rev'] = [string](Get-Rev)
        if (Test-Path $statePath) { Send-Text $ctx ([IO.File]::ReadAllText($statePath, [Text.Encoding]::UTF8)) } else { Send-Text $ctx 'null' }
      }
      elseif ($path -eq '/api/state' -and $req.HttpMethod -eq 'PUT') {
        $body = $utf8.GetString((Read-Body $req))
        $stateObj = $body | ConvertFrom-Json   # valida que sea JSON antes de guardar
        $rev = Get-Rev
        $base = $req.Headers['X-Base-Rev']
        if ($base -ne $null -and [int]$base -ne $rev) {
          # Otro dispositivo guardo antes: se devuelve la version actual para que el cliente se sincronice.
          $ctx.Response.Headers['X-Rev'] = [string]$rev
          Send-Text $ctx ([IO.File]::ReadAllText($statePath, [Text.Encoding]::UTF8)) 'application/json; charset=utf-8' 409
          continue
        }
        [IO.File]::WriteAllText("$statePath.tmp", $body, $utf8)
        Move-Item -Force "$statePath.tmp" $statePath
        $rev++
        [IO.File]::WriteAllText($revPath, [string]$rev, $utf8)
        Send-Text $ctx ('{"ok":true,"rev":' + $rev + '}')
        # Avisos push de lo nuevo en la bitacora (despues de responder, para no hacer esperar a la app).
        try { Push-FromState $stateObj } catch { Write-Host "Avisos push: $($_.Exception.Message)" }
      }
      elseif ($path.StartsWith('/api/anthropic/')) {
        # Proxy a la API de Claude: la clave se agrega aqui y nunca sale de tu PC.
        if (-not $cfg['ANTHROPIC_API_KEY']) { Send-Text $ctx '{"type":"error","error":{"type":"authentication_error","message":"Falta ANTHROPIC_API_KEY. Agregala en Mas -> Ajustes."}}' 'application/json' 401; continue }
        $target = 'https://api.anthropic.com' + $path.Substring('/api/anthropic'.Length) + $req.Url.Query
        $h = @{ 'x-api-key' = $cfg['ANTHROPIC_API_KEY']; 'Content-Type' = 'application/json'; 'Accept' = 'application/json' }
        $h['anthropic-version'] = $(if ($req.Headers['anthropic-version']) { $req.Headers['anthropic-version'] } else { '2023-06-01' })
        if ($req.Headers['anthropic-beta']) { $h['anthropic-beta'] = $req.Headers['anthropic-beta'] }
        $r = Invoke-Forward $req.HttpMethod $target $h (Read-Body $req) 600
        Send-Bytes $ctx $r.bytes $(if ($r.type) { $r.type } else { 'application/json' }) $r.status
      }
      elseif ($path -eq '/api/odds') {
        # Proxy a The Odds API (la clave se agrega aqui).
        if (-not $cfg['ODDS_API_KEY']) { Send-Text $ctx '{"error":"Falta ODDS_API_KEY"}' 'application/json' 401; continue }
        $p = [string]$req.QueryString['p']
        if (-not $p.StartsWith('sports/')) { Send-Text $ctx '{"error":"ruta no permitida"}' 'application/json' 400; continue }
        $sep = if ($p.Contains('?')) { '&' } else { '?' }
        $r = Invoke-Forward 'GET' ("https://api.the-odds-api.com/v4/$p$sep" + 'apiKey=' + $cfg['ODDS_API_KEY']) @{} $null 30
        $rem = $r.headers['x-requests-remaining']
        if ($rem) { $ctx.Response.Headers['X-Requests-Remaining'] = $rem }
        Send-Bytes $ctx $r.bytes 'application/json; charset=utf-8' $r.status
      }
      elseif ($path -eq '/api/img') {
        # Logos de equipos de Liquipedia (no permiten cargarlos directo desde otra página): se piden aquí y se guardan en memoria.
        $target = [Uri]$req.QueryString['u']
        if ($target.Host -ne 'liquipedia.net' -or -not $target.AbsolutePath.StartsWith('/commons/images/')) { Send-Text $ctx '{"error":"imagen no permitida"}' 'application/json' 403; continue }
        $key = $target.AbsoluteUri
        $hit = $imgCache[$key]
        if (-not $hit) {
          $r = Invoke-Forward 'GET' $key @{ 'Accept' = 'image/*' } $null 20
          if ($r.status -ne 200) { Send-Text $ctx '' 'text/plain' $r.status; continue }
          $hit = @{ bytes = $r.bytes; type = $r.type }
          if ($imgCache.Count -gt 500) { $imgCache.Clear() }
          $imgCache[$key] = $hit
        }
        Send-Bytes $ctx $hit.bytes $hit.type 200 'public, max-age=86400'
      }
      elseif ($path -eq '/api/proxy') {
        $target = [Uri]$req.QueryString['url']
        if ($proxyHosts -notcontains $target.Host) { Send-Text $ctx '{"error":"host no permitido"}' 'application/json' 403; continue }
        $key = $target.AbsoluteUri
        $isLp = $target.Host -eq 'liquipedia.net'
        # Tiempo real: marcadores de eSports (bo3.gg) 4 s, precios de Kalshi 8 s; Liquipedia y lo demas, 60 s / 30 s.
        $ttl = if ($isLp) { 60 } elseif ($target.Host -eq 'api.bo3.gg') { 4 } elseif ($target.Host -eq 'api.elections.kalshi.com') { 8 } else { 30 }
        $hit = $proxyCache[$key]
        if ($hit -and ((Get-Date) - $hit.t).TotalSeconds -lt $ttl) { Send-Text $ctx $hit.v 'text/plain; charset=utf-8'; continue }
        if ($isLp) {
          $wait = 30 - ((Get-Date) - $script:lastLiquipedia).TotalSeconds
          if ($wait -gt 0) {
            # No se bloquea el servidor: se devuelve lo guardado o se pide reintentar.
            if ($hit) { Send-Text $ctx $hit.v 'text/plain; charset=utf-8'; continue }
            $ctx.Response.Headers['Retry-After'] = [string][Math]::Ceiling($wait)
            Send-Text $ctx '{"error":"limite de Liquipedia, reintenta"}' 'application/json' 429; continue
          }
          $script:lastLiquipedia = Get-Date
          $r = Invoke-Forward 'GET' $target.AbsoluteUri @{ 'Accept-Encoding' = 'gzip' } $null 30
        } else {
          $r = Invoke-Forward 'GET' $target.AbsoluteUri @{ 'User-Agent' = 'Mozilla/5.0 (compatible; BetBotMX/1.3)'; 'Accept' = 'application/json, text/xml, */*' } $null 20
        }
        $text = $utf8.GetString($r.bytes)
        if ($r.status -eq 200) { $proxyCache[$key] = @{ t = Get-Date; v = $text } }
        Send-Text $ctx $text 'text/plain; charset=utf-8' $r.status
      }
      # ---------- notificaciones push (cualquier dispositivo con acceso) ----------
      elseif ($path -eq '/api/push/key') {
        Send-Text $ctx (@{ publicKey = $script:push.pub; subscribers = $script:push.subs.Count } | ConvertTo-Json -Compress)
      }
      elseif ($path -eq '/api/push/subscribe' -and $req.HttpMethod -eq 'POST') {
        $b = $utf8.GetString((Read-Body $req)) | ConvertFrom-Json
        $s = $b.subscription
        if (-not $s -or -not $s.endpoint -or -not $s.keys.p256dh -or -not $s.keys.auth) { Send-Text $ctx '{"error":"suscripcion incompleta"}' 'application/json' 400; continue }
        if (-not ([string]$s.endpoint).StartsWith('https://')) { Send-Text $ctx '{"error":"endpoint invalido"}' 'application/json' 400; continue }
        $old = Find-PushSub ([string]$s.endpoint)
        if ($old) { $script:push.subs.Remove($old) }
        $prefsSrc = $(if ($b.prefs) { $b.prefs } elseif ($old) { [pscustomobject]$old.prefs } else { $null })
        [void]$script:push.subs.Add(@{ endpoint = [string]$s.endpoint; p256dh = [string]$s.keys.p256dh; auth = [string]$s.keys.auth; device = [string]$b.device; added = ([DateTimeOffset]::UtcNow).ToUnixTimeMilliseconds(); prefs = (New-PushPrefs $prefsSrc) })
        Save-Push
        Send-Text $ctx (@{ ok = $true; subscribers = $script:push.subs.Count } | ConvertTo-Json -Compress)
      }
      elseif ($path -eq '/api/push/unsubscribe' -and $req.HttpMethod -eq 'POST') {
        $b = $utf8.GetString((Read-Body $req)) | ConvertFrom-Json
        $old = Find-PushSub ([string]$b.endpoint)
        if ($old) { $script:push.subs.Remove($old); Save-Push }
        Send-Text $ctx '{"ok":true}'
      }
      elseif ($path -eq '/api/push/status' -and $req.HttpMethod -eq 'POST') {
        $b = $utf8.GetString((Read-Body $req)) | ConvertFrom-Json
        $s = Find-PushSub ([string]$b.endpoint)
        Send-Text $ctx (@{ subscribed = [bool]$s; prefs = $(if ($s) { $s.prefs } else { New-PushPrefs $null }); subscribers = $script:push.subs.Count } | ConvertTo-Json -Compress)
      }
      elseif ($path -eq '/api/push/prefs' -and $req.HttpMethod -eq 'POST') {
        $b = $utf8.GetString((Read-Body $req)) | ConvertFrom-Json
        $s = Find-PushSub ([string]$b.endpoint)
        if (-not $s) { Send-Text $ctx '{"error":"este dispositivo no tiene avisos activos"}' 'application/json' 404; continue }
        $s.prefs = New-PushPrefs $b.prefs
        Save-Push
        Send-Text $ctx (@{ ok = $true; prefs = $s.prefs } | ConvertTo-Json -Compress)
      }
      elseif ($path -eq '/api/push/test' -and $req.HttpMethod -eq 'POST') {
        $b = $utf8.GetString((Read-Body $req)) | ConvertFrom-Json
        $targets = $(if ($b.endpoint) { @(Find-PushSub ([string]$b.endpoint)) | Where-Object { $_ } } else { @($script:push.subs) })
        if (-not @($targets).Count) { Send-Text $ctx '{"error":"no hay dispositivos con avisos activos"}' 'application/json' 404; continue }
        $codes = @(foreach ($s in @($targets)) { Send-Push $s @{ kind = 'test'; cat = 'test'; msg = ''; t = ([DateTimeOffset]::UtcNow).ToUnixTimeMilliseconds() } })
        $ok = @($codes | Where-Object { $_ -ge 200 -and $_ -lt 300 }).Count
        Send-Text $ctx (@{ ok = ($ok -gt 0); sent = $ok; codes = $codes } | ConvertTo-Json -Compress)
      }
      # ---------- Tailscale: acceso seguro (HTTPS) desde el iPhone, en casa o con datos moviles ----------
      elseif ($path -eq '/api/tailscale') {
        if (-not (Test-Local $req)) { Send-Text $ctx '{"error":"solo desde la PC"}' 'application/json' 403; continue }
        if (-not (Get-TailscaleExe)) { Send-Text $ctx (@{ installed = $false; lan = $script:lanEnabled; port = $Port } | ConvertTo-Json -Compress); continue }
        $st = Invoke-Tailscale @('status', '--json')
        $j = $null; try { $j = $st.out | ConvertFrom-Json } catch {}
        $dns = $(if ($j -and $j.Self) { ([string]$j.Self.DNSName).TrimEnd('.') } else { '' })
        $sv = Invoke-Tailscale @('serve', 'status', '--json')
        $serving = [bool]($sv -and $sv.out -match "(127\.0\.0\.1|localhost):$Port")
        $out = @{ installed = $true; state = $(if ($j) { [string]$j.BackendState } else { '' }); dns = $dns; https = [bool]($j -and @($j.CertDomains | Where-Object { $_ }).Count)
                  serving = $serving; lan = $script:lanEnabled; port = $Port; token = $token; url = $(if ($dns) { "https://$dns" } else { '' }) }
        Send-Text $ctx ($out | ConvertTo-Json -Compress)
      }
      elseif ($path -eq '/api/tailscale/serve' -and $req.HttpMethod -eq 'POST') {
        if (-not (Test-Local $req)) { Send-Text $ctx '{"error":"solo desde la PC"}' 'application/json' 403; continue }
        $r = Invoke-Tailscale @('serve', '--bg', [string]$Port) 15000
        if (-not $r) { Send-Text $ctx '{"error":"Tailscale no esta instalado"}' 'application/json' 400; continue }
        $all = $r.out + "`n" + $r.err
        $link = [regex]::Match($all, 'https://login\.tailscale\.com/\S+').Value
        if ($link) { Send-Text $ctx (@{ ok = $false; enableUrl = $link; output = $all.Trim() } | ConvertTo-Json -Compress); continue }
        Send-Text $ctx (@{ ok = ($r.done -and $r.code -eq 0); output = $all.Trim() } | ConvertTo-Json -Compress)
      }
      elseif ($path -eq '/api/tailscale/reset' -and $req.HttpMethod -eq 'POST') {
        if (-not (Test-Local $req)) { Send-Text $ctx '{"error":"solo desde la PC"}' 'application/json' 403; continue }
        $r = Invoke-Tailscale @('serve', 'reset')
        Send-Text $ctx (@{ ok = [bool]($r -and $r.code -eq 0) } | ConvertTo-Json -Compress)
      }
      # ---------- solo desde esta PC ----------
      elseif ($path -eq '/api/network') {
        if (-not (Test-Local $req)) { Send-Text $ctx '{"error":"solo desde la PC"}' 'application/json' 403; continue }
        # Tipo de red de Windows: si es "Public", el firewall bloquea al celular (la regla del bot es solo para redes privadas).
        $profiles = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | ForEach-Object { @{ name = [string]$_.InterfaceAlias; network = [string]$_.Name; category = [string]$_.NetworkCategory } })
        $out = @{ lan = $script:lanEnabled; ips = @(Get-LanIps); port = $Port; token = $token; profiles = $profiles }
        Send-Text $ctx ($out | ConvertTo-Json -Compress)
      }
      elseif ($path -eq '/api/phone/enable' -and $req.HttpMethod -eq 'POST') {
        # Ejecuta habilitar-telefono.bat como administrador: Windows muestra su aviso (UAC) y TU decides si lo aceptas.
        if (-not (Test-Local $req)) { Send-Text $ctx '{"error":"solo desde la PC"}' 'application/json' 403; continue }
        if ($script:lanEnabled) { Send-Text $ctx '{"ok":true,"lan":true}'; continue }
        $bat = Join-Path $root 'habilitar-telefono.bat'
        try { Start-Process -FilePath $bat -ArgumentList 'auto' -Verb RunAs -Wait -WindowStyle Hidden }
        catch { Send-Text $ctx '{"error":"Se cancelo el permiso de administrador. Vuelve a intentarlo y presiona Si en el aviso de Windows."}' 'application/json' 400; continue }
        Send-Text $ctx '{"ok":true,"rebinding":true}'
        $script:rebind = $true
      }
      elseif ($path -eq '/api/keys' -and $req.HttpMethod -eq 'POST') {
        if (-not (Test-Local $req)) { Send-Text $ctx '{"error":"Las claves solo se pueden cambiar desde la PC"}' 'application/json' 403; continue }
        $b = $utf8.GetString((Read-Body $req)) | ConvertFrom-Json
        $vals = @{}
        if ($b.anthropicKey -ne $null) {
          $k = ([string]$b.anthropicKey).Trim()
          if ($k -and $k -notmatch '^sk-ant-[A-Za-z0-9_\-]{20,}$') { Send-Text $ctx '{"error":"La clave de Anthropic debe empezar con sk-ant-"}' 'application/json' 400; continue }
          $vals['ANTHROPIC_API_KEY'] = $k
        }
        if ($b.oddsApiKey -ne $null) {
          $k = ([string]$b.oddsApiKey).Trim()
          if ($k -and $k -notmatch '^[A-Za-z0-9]{16,64}$') { Send-Text $ctx '{"error":"Clave de The Odds API no valida"}' 'application/json' 400; continue }
          $vals['ODDS_API_KEY'] = $k
        }
        if ($b.updateUrl -ne $null) {
          $u = ([string]$b.updateUrl).Trim()
          if ($u -and $u -notmatch '^https://[^\s]+$') { Send-Text $ctx '{"error":"La URL de actualizaciones debe empezar con https://"}' 'application/json' 400; continue }
          $vals['UPDATE_MANIFEST_URL'] = $u
        }
        Set-EnvValues $vals
        # Prueba la clave de Anthropic contra la API (lista de modelos).
        $test = $null
        if ($vals['ANTHROPIC_API_KEY']) {
          $r = Invoke-Forward 'GET' 'https://api.anthropic.com/v1/models?limit=1' @{ 'x-api-key' = $vals['ANTHROPIC_API_KEY']; 'anthropic-version' = '2023-06-01' } $null 20
          $test = ($r.status -eq 200)
        }
        Send-Text $ctx (@{ ok = $true; anthropicValid = $test } | ConvertTo-Json -Compress)
      }
      elseif ($path -eq '/api/update/check') {
        if (-not (Test-Local $req)) { Send-Text $ctx '{"error":"solo desde la PC"}' 'application/json' 403; continue }
        $local = Get-LocalVersion
        if (-not $cfg['UPDATE_MANIFEST_URL']) { Send-Text $ctx ('{"configured":false,"local":' + $local + '}'); continue }
        $r = Invoke-Forward 'GET' $cfg['UPDATE_MANIFEST_URL'] @{} $null 20
        if ($r.status -ne 200) { Send-Text $ctx ('{"configured":true,"error":"No se pudo leer la version publicada (HTTP ' + $r.status + ')","local":' + $local + '}'); continue }
        Send-Text $ctx ('{"configured":true,"local":' + $local + ',"remote":' + $utf8.GetString($r.bytes) + '}')
      }
      elseif ($path -eq '/api/update/apply' -and $req.HttpMethod -eq 'POST') {
        if (-not (Test-Local $req)) { Send-Text $ctx '{"error":"solo desde la PC"}' 'application/json' 403; continue }
        $m = Invoke-Forward 'GET' $cfg['UPDATE_MANIFEST_URL'] @{} $null 20
        $manifest = $utf8.GetString($m.bytes) | ConvertFrom-Json
        if (-not $manifest.zip -or $manifest.zip -notmatch '^https://') { throw 'El manifiesto no trae una URL zip valida' }
        $z = Invoke-Forward 'GET' $manifest.zip @{} $null 180
        if ($z.status -ne 200) { throw "No se pudo descargar la actualizacion (HTTP $($z.status))" }
        $zipPath = Join-Path $dataDir 'update.zip'
        $tmp = Join-Path $dataDir 'update_tmp'
        [IO.File]::WriteAllBytes($zipPath, $z.bytes)
        if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
        Expand-Archive -Path $zipPath -DestinationPath $tmp -Force
        $idx = Get-ChildItem $tmp -Recurse -Filter 'index.html' | Where-Object { $_.Directory.Name -eq 'web' } | Select-Object -First 1
        if (-not $idx) { throw 'El paquete no contiene la carpeta web' }
        $src = $idx.Directory.Parent.FullName
        # Respaldo de la version actual (tus datos y .env no se tocan).
        $bk = Join-Path $dataDir ('respaldo-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
        New-Item -ItemType Directory -Path $bk | Out-Null
        Copy-Item $webDir -Destination $bk -Recurse
        $oldServer = [IO.File]::ReadAllText((Join-Path $root 'server.ps1'))
        foreach ($f in 'server.ps1', 'iniciar.bat', 'habilitar-telefono.bat', 'LEEME.md', '.env.example') {
          if (Test-Path (Join-Path $root $f)) { Copy-Item (Join-Path $root $f) $bk }
        }
        Remove-Item -Recurse -Force $webDir
        Copy-Item (Join-Path $src 'web') -Destination $root -Recurse
        foreach ($f in 'server.ps1', 'iniciar.bat', 'habilitar-telefono.bat', 'LEEME.md', '.env.example') {
          if (Test-Path (Join-Path $src $f)) { Copy-Item (Join-Path $src $f) $root -Force }
        }
        # Se compara sin fines de línea (CRLF/LF) para no pedir reinicio si solo cambió el formato.
        $serverChanged = (([IO.File]::ReadAllText((Join-Path $root 'server.ps1')) -replace "`r", '') -ne ($oldServer -replace "`r", ''))
        Remove-Item -Recurse -Force $tmp; Remove-Item -Force $zipPath
        Send-Text $ctx (@{ ok = $true; version = [string]$manifest.version; serverChanged = $serverChanged; restarting = $serverChanged } | ConvertTo-Json -Compress)
        # Si cambió el servidor, se reinicia solo para usar el código nuevo (antes había que cerrar y abrir iniciar.bat).
        if ($serverChanged) { $script:restart = $true }
      }
      elseif ($path -eq '/api/restart' -and $req.HttpMethod -eq 'POST') {
        if (-not (Test-Local $req)) { Send-Text $ctx '{"error":"solo desde la PC"}' 'application/json' 403; continue }
        Send-Text $ctx '{"ok":true,"restarting":true}'
        $script:restart = $true
      }
      elseif ($path -eq '/manifest.webmanifest') {
        # App instalada en el iPhone: si quien la instala ya tiene acceso, el inicio lleva su codigo
        # (la app de la pantalla de inicio no comparte la sesion de Safari y si no, pediria el QR otra vez).
        $ck = $req.Cookies['bb_t']
        $authed = $ck -and $ck.Value -eq $token
        $m = [ordered]@{
          id = '/'; name = 'BetBot MX'; short_name = 'BetBot'; description = 'Analisis de apuestas deportivas con IA (banca ficticia)'
          start_url = $(if ($authed) { "/?t=$token&app=1" } else { '/?app=1' }); scope = '/'
          display = 'standalone'; orientation = 'portrait'; background_color = '#0b0b10'; theme_color = '#0b0b10'; lang = 'es-MX'
          icons = @(
            @{ src = '/icons/icon-180.png'; sizes = '180x180'; type = 'image/png' },
            @{ src = '/icons/icon-192.png'; sizes = '192x192'; type = 'image/png' },
            @{ src = '/icons/icon-512.png'; sizes = '512x512'; type = 'image/png' },
            @{ src = '/icons/icon-maskable-512.png'; sizes = '512x512'; type = 'image/png'; purpose = 'maskable' })
        }
        $ctx.Response.Headers['Cache-Control'] = 'no-store'
        Send-Text $ctx ($m | ConvertTo-Json -Depth 4 -Compress) 'application/manifest+json'
      }
      elseif ($path -eq '/api/apptoken') {
        # Solo para quien ya tiene acceso: permite que "Agregar a pantalla de inicio" guarde el enlace con su codigo.
        Send-Text $ctx (@{ token = $(if (Test-Local $req) { '' } else { $token }) } | ConvertTo-Json -Compress)
      }
      else {
        $rel = if ($path -eq '/') { 'index.html' } else { $path.TrimStart('/') -replace '/', '\' }
        $file = [IO.Path]::GetFullPath((Join-Path $webDir $rel))
        if (-not $file.StartsWith($webDir) -or -not (Test-Path $file -PathType Leaf)) { Send-Text $ctx 'No encontrado' 'text/plain' 404; continue }
        $ext = [IO.Path]::GetExtension($file).ToLower()
        $type = if ($mime[$ext]) { $mime[$ext] } else { 'application/octet-stream' }
        Send-Bytes $ctx ([IO.File]::ReadAllBytes($file)) $type
      }
    }
    catch {
      $ex = $_.Exception; while ($ex.InnerException) { $ex = $ex.InnerException }
      # El navegador o el iPhone dejo de esperar la respuesta (recargo, cambio de seccion, se bloqueo la pantalla,
      # cambio de red o se cancelo la consulta): no es un error del bot, se descarta en silencio.
      $gone = ($ex -is [System.Net.HttpListenerException] -and @(64, 995, 1229, 1236) -contains $ex.ErrorCode) -or ($ex -is [System.IO.IOException]) -or ($ex -is [System.ObjectDisposedException])
      if ($gone) { try { $ctx.Response.Abort() } catch {} }
      else {
        Write-Host "Error en $path : $($_.Exception.Message)"
        try { Send-Text $ctx (@{ error = $_.Exception.Message } | ConvertTo-Json -Compress) 'application/json' 500 } catch {}
      }
    }
    # Reinicio: abre un servidor nuevo (con el código actualizado) en su propia ventana y cierra este.
    if ($script:restart) {
      Write-Host "Reiniciando BetBot MX con la version nueva..." -ForegroundColor Cyan
      $serverFile = Join-Path $root 'server.ps1'
      Start-Process -FilePath 'powershell.exe' -WorkingDirectory $root -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', "Start-Sleep -Seconds 2; & '$serverFile' -Port $Port")
      $listener.Stop(); $listener.Close()
      exit 0
    }
    # Tras activar el celular, el servidor se vuelve a abrir para la red local sin tener que reiniciarlo.
    if ($script:rebind) {
      $script:rebind = $false
      $listener.Stop(); $listener.Close()
      $listener = New-Object System.Net.HttpListener
      $listener.Prefixes.Add("http://+:$Port/")
      try { $listener.Start(); $script:lanEnabled = $true; Write-Host "Acceso desde el celular: ACTIVO" -ForegroundColor Cyan }
      catch {
        $listener = New-Object System.Net.HttpListener
        $listener.Prefixes.Add("http://localhost:$Port/")
        $listener.Start()
        Write-Host "No se pudo abrir para la red local; sigue solo en esta PC." -ForegroundColor Yellow
      }
    }
  }
}
finally { $listener.Stop() }
