@echo off
rem Tower Trainer — double-click to start the server and open the trainer in your browser.
rem Needs Python 3 (https://www.python.org/downloads/ — tick "Add python.exe to PATH").
setlocal
cd /d "%~dp0"
set PY=
where python >nul 2>nul && set PY=python
if "%PY%"=="" where py >nul 2>nul && set PY=py -3
if "%PY%"=="" (
  echo Python 3 was not found. Install it from https://www.python.org/downloads/ and tick "Add python.exe to PATH".
  pause
  exit /b 1
)
%PY% -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" || (echo Python 3.9 or newer is needed. & pause & exit /b 1)
echo Tower Trainer: http://localhost:8780   (close this window to stop)
start "" "http://localhost:8780/"
%PY% server.py %*
if errorlevel 1 pause
