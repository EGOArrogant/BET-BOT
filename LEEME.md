# BetBot MX — Guía de instalación (v1.1)

Bot de análisis de apuestas deportivas con banca ficticia de $2,000 MXN.
Funciona en Windows 10/11 sin instalar nada: usa PowerShell, que ya viene en Windows.

## 1. Descomprimir

1. Descarga `BetBotMX.zip`.
2. Clic derecho → **Extraer todo…** y elige una carpeta fija, por ejemplo `Documentos\BetBotMX`.
   No lo ejecutes desde dentro del .zip.

```
BetBotMX\
  iniciar.bat               ← doble clic para abrir el bot
  habilitar-telefono.bat    ← (una vez) permite abrirlo desde tu celular
  deshabilitar-telefono.bat ← quita el acceso desde el celular
  server.ps1                ← servidor local
  web\                      ← la app
```

## 2. Abrir el bot

1. Doble clic en **`iniciar.bat`**.
2. Si Windows muestra "Windows protegió su PC": **Más información → Ejecutar de todas formas**.
3. Se abre una ventana negra (el servidor) y el navegador en `http://localhost:8787`.
4. **No cierres la ventana negra** mientras uses el bot.

## 3. Agregar tu clave de Anthropic (activa la IA)

1. Entra a https://console.anthropic.com y crea tu cuenta.
2. En **Billing**, agrega saldo (por ejemplo $5 USD). Cada análisis cuesta centavos de dólar.
3. En **API Keys**, presiona **Create Key** y copia la clave (empieza con `sk-ant-`).
4. En BetBot MX, desde la PC: **Más → Ajustes → Claves**, pégala y presiona **Guardar**.
   La app la verifica con Anthropic y te dice si quedó bien.

La clave se guarda solo en el archivo `.env` de tu PC. El navegador y el celular nunca la reciben.
Opcional: en la misma sección puedes agregar una clave gratis de https://the-odds-api.com para ver Pinnacle y 40+ casas.

## 4. Usarlo desde tu celular

1. Cierra la ventana negra de BetBot MX.
2. Doble clic en **`habilitar-telefono.bat`** y acepta el aviso de administrador. Solo se hace una vez.
   Esto permite que el bot se abra en tu red WiFi de casa y abre el puerto 8787 solo para redes privadas.
3. Abre otra vez `iniciar.bat`.
4. En la PC ve a **Más → Celular** y escanea el código QR con la cámara del celular, que debe estar en la misma red WiFi.
5. En el celular: Compartir → **Agregar a pantalla de inicio** para tenerlo como app.

- El QR contiene tu código de acceso: no lo compartas.
- El celular y la PC comparten la misma banca y el mismo boleto.
- La PC debe estar encendida con `iniciar.bat` abierto.
- **Fuera de casa:** instala Tailscale (gratis) en la PC y en el celular con la misma cuenta, y usa la IP de Tailscale de tu PC en lugar de la del QR.
- Tu red WiFi debe estar como **Privada** en Windows: Configuración → Red e Internet → Wi-Fi → tu red.

## 5. Apostar

1. Toca cualquier momio en Fútbol, Deportes o eSports y se agrega a tu **boleto** (sección **Apostar**).
2. En el boleto escribe el momio que ves en cada casa, o presiona **🔎 Buscar momios en internet** para que la IA lo busque.
3. El bot te dice **en qué casa apostar**, cuánto y si hay valor. Presiona **Registrar apuesta**.
4. Si decides apostar de verdad, colócala en esa casa y presiona **Ya la coloqué** en "Por colocar en tu casa".

Configura tus casas en **Más → Mis casas**. Las internacionales (sin permiso SEGOB) están en un grupo aparte porque ahí no tienes protección legal.

## 6. Actualizaciones

En **Más → Ajustes → Actualizaciones**, presiona **Buscar actualización**.
Cuando Claude publique una nueva versión, te dará la dirección de actualizaciones para pegarla ahí una sola vez.
Después, cada actualización se instala con un clic, conserva tus apuestas y claves, y respalda la versión anterior en `data\`.

## 7. Servidor en Python (en prueba, opcional)

Hay una versión nueva del servidor escrita en Python (carpeta `servidor_py`). Hace lo mismo que `server.ps1`, pero atiende muchas consultas a la vez y guarda tus datos en una base de datos (`data/betbot.db`). Además sigue escribiendo `state.json` y `apuestas.jsonl`, así puedes volver a PowerShell cuando quieras sin perder nada.

1. Instala Python 3.12 o más nuevo (una sola vez):  `winget install -e --id Python.Python.3.12 --scope user`
2. Cierra la ventana negra de BetBot MX.
3. Abre **`iniciar-python.bat`**. La primera vez prepara Python (tarda un minuto).
4. Para volver al servidor de siempre: cierra esa ventana y abre `iniciar.bat`.

**Bot 24/7:** con el servidor de Python, el bot (escaneo, liquidación, práctica y piloto automático) sigue operando aunque cierres la app: el servidor lo corre en una ventana invisible de Edge y lo reinicia si falla. Se activa o pausa en Inicio → Piloto automático → "Bot 24/7 en tu PC". La PC debe estar encendida con la ventana negra abierta.

## Problemas comunes

| Problema | Solución |
|---|---|
| La ventana negra se cierra sola | Clic derecho en `server.ps1` → **Propiedades** → **Desbloquear** → Aceptar. Repite con los `.bat`. |
| "No se pudo abrir el puerto" | Ya hay un BetBot abierto. Cierra la otra ventana negra o entra a `http://localhost:8787`. |
| El celular no abre el QR | Revisa que esté en la misma WiFi, que ejecutaste `habilitar-telefono.bat` y que la red esté como Privada. |
| eSports tardan en aparecer | Liquipedia permite 1 consulta cada 30 s; espera unos segundos. |

## Importante

- Es una herramienta de **análisis y práctica con dinero ficticio**. El bot no apuesta dinero real: tú decides y colocas cada apuesta.
- Antes de pensar en dinero real, junta al menos 300 a 500 apuestas simuladas con ROI y CLV positivos.
- Juego responsable: si deja de ser divertido, para. Línea de la Vida: 800 911 2000.
