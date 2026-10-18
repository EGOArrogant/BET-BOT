# BetBot MX - servidor local (solo PowerShell, sin instalar nada)
# - Sirve la app web y guarda la banca ficticia en data\state.json (con control de versiones entre dispositivos).
# - Guarda tus claves en .env y las usa SOLO aqui: el navegador (PC o celular) nunca las recibe.
#   Las llamadas a Claude y a The Odds API pasan por este servidor, que agrega la clave.
# - Acceso desde el celular en tu WiFi con un codigo secreto (QR). Requiere ejecutar una vez habilitar-telefono.bat.
# - Actualizaciones: descarga la version publicada (UPDATE_MANIFEST_URL en .env) y conserva tus datos.

param([int]$Port = 8787)

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

$proxyHosts = @('news.google.com', 'liquipedia.net')
# Liquipedia pide: gzip, User-Agent identificable y maximo 1 consulta "parse" cada 30 s.
$proxyCache = @{}
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

function Send-Bytes($ctx, [byte[]]$bytes, [string]$type, [int]$status = 200) {
  $res = $ctx.Response
  $res.StatusCode = $status
  $res.ContentType = $type
  $res.Headers['Cache-Control'] = 'no-store'
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
  if ($req.IsLocal) { return $true }
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
          local        = $req.IsLocal
          lan          = $script:lanEnabled
        }
        Send-Text $ctx ($out | ConvertTo-Json -Compress)
      }
      elseif ($path -eq '/api/state' -and $req.HttpMethod -eq 'GET') {
        $ctx.Response.Headers['X-Rev'] = [string](Get-Rev)
        if (Test-Path $statePath) { Send-Text $ctx ([IO.File]::ReadAllText($statePath, [Text.Encoding]::UTF8)) } else { Send-Text $ctx 'null' }
      }
      elseif ($path -eq '/api/state' -and $req.HttpMethod -eq 'PUT') {
        $body = $utf8.GetString((Read-Body $req))
        $null = $body | ConvertFrom-Json   # valida que sea JSON antes de guardar
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
      elseif ($path -eq '/api/proxy') {
        $target = [Uri]$req.QueryString['url']
        if ($proxyHosts -notcontains $target.Host) { Send-Text $ctx '{"error":"host no permitido"}' 'application/json' 403; continue }
        $key = $target.AbsoluteUri
        $isLp = $target.Host -eq 'liquipedia.net'
        $ttl = if ($isLp) { 300 } else { 120 }
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
          $r = Invoke-Forward 'GET' $target.AbsoluteUri @{} $null 20
        }
        $text = $utf8.GetString($r.bytes)
        if ($r.status -eq 200) { $proxyCache[$key] = @{ t = Get-Date; v = $text } }
        Send-Text $ctx $text 'text/plain; charset=utf-8' $r.status
      }
      # ---------- solo desde esta PC ----------
      elseif ($path -eq '/api/network') {
        if (-not $req.IsLocal) { Send-Text $ctx '{"error":"solo desde la PC"}' 'application/json' 403; continue }
        $out = @{ lan = $script:lanEnabled; ips = @(Get-LanIps); port = $Port; token = $token }
        Send-Text $ctx ($out | ConvertTo-Json -Compress)
      }
      elseif ($path -eq '/api/keys' -and $req.HttpMethod -eq 'POST') {
        if (-not $req.IsLocal) { Send-Text $ctx '{"error":"Las claves solo se pueden cambiar desde la PC"}' 'application/json' 403; continue }
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
        if (-not $req.IsLocal) { Send-Text $ctx '{"error":"solo desde la PC"}' 'application/json' 403; continue }
        $local = Get-LocalVersion
        if (-not $cfg['UPDATE_MANIFEST_URL']) { Send-Text $ctx ('{"configured":false,"local":' + $local + '}'); continue }
        $r = Invoke-Forward 'GET' $cfg['UPDATE_MANIFEST_URL'] @{} $null 20
        if ($r.status -ne 200) { Send-Text $ctx ('{"configured":true,"error":"No se pudo leer la version publicada (HTTP ' + $r.status + ')","local":' + $local + '}'); continue }
        Send-Text $ctx ('{"configured":true,"local":' + $local + ',"remote":' + $utf8.GetString($r.bytes) + '}')
      }
      elseif ($path -eq '/api/update/apply' -and $req.HttpMethod -eq 'POST') {
        if (-not $req.IsLocal) { Send-Text $ctx '{"error":"solo desde la PC"}' 'application/json' 403; continue }
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
        $serverChanged = ([IO.File]::ReadAllText((Join-Path $root 'server.ps1')) -ne $oldServer)
        Remove-Item -Recurse -Force $tmp; Remove-Item -Force $zipPath
        Send-Text $ctx (@{ ok = $true; version = [string]$manifest.version; serverChanged = $serverChanged } | ConvertTo-Json -Compress)
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
      Write-Host "Error en $path : $($_.Exception.Message)"
      try { Send-Text $ctx (@{ error = $_.Exception.Message } | ConvertTo-Json -Compress) 'application/json' 500 } catch {}
    }
  }
}
finally { $listener.Stop() }
