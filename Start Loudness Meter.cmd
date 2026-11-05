@echo off
rem Serves the meter on http://localhost:8080 with a visible console window.
rem Close this window to stop. Prefer the desktop shortcut unless you want the log.
cd /d "%~dp0"

set "PY=python"
where py >nul 2>nul && set "PY=py -3"

start "" http://localhost:8080/LoudnessMeter.html
%PY% -m http.server 8080 --bind 127.0.0.1
