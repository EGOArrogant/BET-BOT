@echo off
title BetBot MX (Python) - servidor (no cierres esta ventana)
cd /d "%~dp0"
if not exist .env copy .env.example .env >nul

rem Primera vez: crea un entorno de Python solo para el bot (carpeta .venv) e instala lo necesario.
if not exist ".venv\Scripts\python.exe" (
  echo Preparando Python para BetBot MX ^(solo la primera vez, tarda un minuto^)...
  py -3 -m venv .venv
  if errorlevel 1 (
    echo.
    echo No se encontro Python. Instalalo con:  winget install -e --id Python.Python.3.12 --scope user
    echo y vuelve a abrir este archivo.
    pause
    exit /b 1
  )
)
rem Revisa que esten las librerias (si ya estan, termina en segundos).
".venv\Scripts\python.exe" -m pip install -q --disable-pip-version-check -r servidor_py\requirements.txt
if errorlevel 1 (
  echo.
  echo No se pudieron instalar las librerias de Python. Revisa tu conexion a internet y vuelve a intentar.
  pause
  exit /b 1
)

rem Abre el navegador 3 segundos despues, cuando el servidor ya esta listo
start "" cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:8787"
".venv\Scripts\python.exe" servidor_py\server.py --port 8787
echo.
echo El servidor se detuvo. Presiona una tecla para cerrar.
pause >nul
