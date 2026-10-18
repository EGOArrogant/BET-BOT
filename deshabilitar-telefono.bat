@echo off
rem BetBot MX - quita el acceso desde el celular (revierte habilitar-telefono.bat).
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
netsh http delete urlacl url=http://+:8787/
netsh advfirewall firewall delete rule name="BetBot MX"
echo.
echo Acceso desde el celular desactivado. Reinicia BetBot MX.
pause
