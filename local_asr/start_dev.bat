@echo off
setlocal
cd /d "%~dp0"

if not exist "config.json" (
    copy "config.example.json" "config.json" >nul
    echo Created local_asr\config.json from the example.
)

if not exist ".venv\Scripts\python.exe" (
    echo Create the environment and install dependencies first:
    echo   py -3.12 -m venv .venv
    echo   .venv\Scripts\python -m pip install -r requirements.txt
    pause
    exit /b 1
)

".venv\Scripts\python.exe" run.py
endlocal
