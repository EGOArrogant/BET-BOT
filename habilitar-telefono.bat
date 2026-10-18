@echo off
rem BetBot MX - permite abrir el bot desde tu celular en la MISMA red WiFi.
rem Hace dos cambios en Windows (requiere administrador, una sola vez):
rem   1) Reserva la direccion http://+:8787/ para que el servidor escuche en la red local.
rem   2) Abre el puerto 8787 en el firewall SOLO para redes privadas (tu casa), no en redes publicas.
rem Para deshacerlo, ejecuta: deshabilitar-telefono.bat

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Se necesitan permisos de administrador. Windows te pedira confirmar...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo.
echo [1/2] Reservando direccion para la red local...
netsh http delete urlacl url=http://+:8787/ >nul 2>&1
netsh http add urlacl url=http://+:8787/ sddl=D:(A;;GX;;;WD)

echo [2/2] Abriendo el puerto 8787 en el firewall (solo redes privadas)...
netsh advfirewall firewall delete rule name="BetBot MX" >nul 2>&1
netsh advfirewall firewall add rule name="BetBot MX" dir=in action=allow protocol=TCP localport=8787 profile=private

echo.
echo Listo. Ahora:
echo   1. Cierra la ventana negra de BetBot MX si esta abierta.
echo   2. Abre de nuevo iniciar.bat.
echo   3. En la app ve a Mas ^> Celular y escanea el codigo QR con tu telefono.
echo.
echo Importante: tu red WiFi debe estar marcada como "Privada" en Windows
echo (Configuracion ^> Red e Internet ^> Wi-Fi ^> tu red ^> Tipo de perfil: Privada).
echo.
pause
