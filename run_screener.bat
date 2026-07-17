@echo off
REM ═══ Crypto Value Screener — corrida manual ═══
REM Genera app\data.js y crypto_screen.json con datos frescos.
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
"C:\Users\Fausto Manjarrez\AppData\Local\Python\bin\python.exe" fetch_crypto.py
if errorlevel 1 (
  echo.
  echo *** El screener termino con errores. Revisa el mensaje de arriba. ***
) else (
  echo.
  echo Listo. Puedes importar crypto_screen.json en la app con el boton Importar.
)
pause
