@echo off
setlocal
cd /d "%~dp0df_local_asr"
if not exist "df_local_asr.exe" (
    echo Companion files are missing. Re-extract the complete release ZIP.
    pause
    exit /b 1
)
df_local_asr.exe
endlocal
