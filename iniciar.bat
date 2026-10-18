@echo off
title BetBot MX - servidor (no cierres esta ventana)
cd /d "%~dp0"
if not exist .env copy .env.example .env >nul
rem Abre el navegador 2 segundos despues, cuando el servidor ya esta listo
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:8787"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
echo.
echo El servidor se detuvo. Presiona una tecla para cerrar.
pause >nul
