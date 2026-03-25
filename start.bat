@echo off
setlocal EnableDelayedExpansion
title Odoo 17 Setup Installer
chcp 65001 >nul 2>&1

:: -----------------------------------------------------------
:: Auto-elevate to Administrator (needed for symlinks + PG)
:: -----------------------------------------------------------
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo   Requesting Administrator privileges...
    powershell -Command "Start-Process cmd -ArgumentList '/c cd /d \"%~dp0\" && \"%~f0\"' -Verb RunAs"
    exit /b
)
cd /d "%~dp0"

echo.
echo   ╔══════════════════════════════════════════╗
echo   ║   Odoo 17 Development Environment Setup  ║
echo   ╚══════════════════════════════════════════╝
echo.

:: -----------------------------------------------------------
:: Step 1: Find Python
:: -----------------------------------------------------------
set "PYTHON_EXE="

:: Check environment PATH (but skip Microsoft Store alias)
for /f "tokens=*" %%i in ('where python 2^>nul') do (
    echo %%i | findstr /i "WindowsApps" >nul
    if errorlevel 1 (
        set "PYTHON_EXE=%%i"
        goto :check_python
    )
)

:: Scan common install locations
for %%V in (313 312 311 310 39) do (
    if exist "%LOCALAPPDATA%\Programs\Python\Python%%V\python.exe" (
        set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python%%V\python.exe"
        goto :check_python
    )
)
for %%V in (313 312 311 310 39) do (
    if exist "C:\Python%%V\python.exe" (
        set "PYTHON_EXE=C:\Python%%V\python.exe"
        goto :check_python
    )
)
for %%V in (313 312 311 310 39) do (
    if exist "C:\Program Files\Python%%V\python.exe" (
        set "PYTHON_EXE=C:\Program Files\Python%%V\python.exe"
        goto :check_python
    )
)

:: Not found -> auto download
goto :no_python

:check_python
for /f "tokens=*" %%v in ('"!PYTHON_EXE!" --version 2^>^&1') do set "PY_VER=%%v"
echo   [OK] Found: !PY_VER!
echo        Path : !PYTHON_EXE!
echo.
goto :run_installer

:: -----------------------------------------------------------
:: Step 2: Python not found -> download and install
:: -----------------------------------------------------------
:no_python
echo   [!!] Python not found on this system.
echo.
echo   Downloading Python 3.11.4 automatically...
echo.

set "PY_INSTALLER=%~dp0python-3.11.4-amd64.exe"

:: Download using PowerShell (always available on Win 10+)
powershell -NoProfile -Command ^
    "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; " ^
    "$ProgressPreference = 'Continue'; " ^
    "Write-Host '   Downloading from python.org...'; " ^
    "Invoke-WebRequest -Uri 'https://www.python.org/ftp/python/3.11.4/python-3.11.4-amd64.exe' -OutFile '%PY_INSTALLER%'; " ^
    "if (Test-Path '%PY_INSTALLER%') { Write-Host '   [OK] Download complete.' } else { Write-Host '   [ERROR] Download failed.' }"

if not exist "%PY_INSTALLER%" (
    echo.
    echo   [ERROR] Failed to download Python.
    echo   Please download manually from: https://www.python.org/downloads/
    pause
    goto :eof
)

echo.
echo   Installing Python 3.11.4...
echo   (This may request Administrator permission)
echo.

:: Install silently with pip, for current user
"%PY_INSTALLER%" /passive InstallAllUsers=0 PrependPath=1 Include_pip=1 Include_launcher=1

:: Wait for install to finish
timeout /t 5 /nobreak >nul

:: Re-scan for Python
for %%V in (311 313 312 310 39) do (
    if exist "%LOCALAPPDATA%\Programs\Python\Python%%V\python.exe" (
        set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python%%V\python.exe"
        goto :after_install
    )
)

echo.
echo   [ERROR] Python installation may have failed.
echo   Please install Python manually from: https://www.python.org/downloads/
pause
goto :eof

:after_install
for /f "tokens=*" %%v in ('"!PYTHON_EXE!" --version 2^>^&1') do set "PY_VER=%%v"
echo   [OK] Installed: !PY_VER!
echo.

:: Clean up installer
del "%PY_INSTALLER%" >nul 2>&1

:: -----------------------------------------------------------
:: Step 3: Create venv and run web UI
:: -----------------------------------------------------------
:run_installer
set "VENV_DIR=%~dp0.venv"
set "VENV_PYTHON=%VENV_DIR%\Scripts\python.exe"

if not exist "%VENV_PYTHON%" (
    echo   [SETUP] Creating virtual environment for installer...
    "!PYTHON_EXE!" -m venv "%VENV_DIR%"
    if not exist "%VENV_PYTHON%" (
        echo   [WARN] Venv failed, using system Python...
        set "VENV_PYTHON=!PYTHON_EXE!"
    ) else (
        echo   [OK] Virtual environment ready.
    )
    echo.
)

echo   [START] Opening installer at http://127.0.0.1:9017
echo   Press Ctrl+C to stop.
echo.
echo   ──────────────────────────────────────────
echo.

"%VENV_PYTHON%" "%~dp0setup.py"

pause
