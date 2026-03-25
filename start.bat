@echo off
setlocal EnableDelayedExpansion
title Odoo 17 Setup Installer
echo ============================================
echo   Odoo 17 Development Environment Installer
echo ============================================
echo.

:: -----------------------------------------------------------
:: Step 1: Find any Python installation
:: -----------------------------------------------------------
set "PYTHON_EXE="

:: Check common install locations first (avoid Microsoft Store alias)
for %%V in (311 312 313 310 39) do (
    if exist "%LOCALAPPDATA%\Programs\Python\Python%%V\python.exe" (
        set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python%%V\python.exe"
        goto :found_python
    )
)
for %%V in (311 312 313 310 39) do (
    if exist "C:\Python%%V\python.exe" (
        set "PYTHON_EXE=C:\Python%%V\python.exe"
        goto :found_python
    )
)
for %%V in (311 312 313 310 39) do (
    if exist "C:\Program Files\Python%%V\python.exe" (
        set "PYTHON_EXE=C:\Program Files\Python%%V\python.exe"
        goto :found_python
    )
)

:: Last resort: try py launcher
py --version >nul 2>&1
if %errorlevel% equ 0 (
    set "PYTHON_EXE=py"
    goto :found_python
)

echo [ERROR] Python not found!
echo.
echo Please install Python from:
echo   https://www.python.org/downloads/
echo.
echo Make sure to check "Add Python to PATH" during installation.
pause
goto :eof

:found_python
echo [OK] Found Python: !PYTHON_EXE!
"!PYTHON_EXE!" --version
echo.

:: -----------------------------------------------------------
:: Step 2: Create installer venv (if not exists)
:: -----------------------------------------------------------
set "VENV_DIR=%~dp0.venv"
set "VENV_PYTHON=%VENV_DIR%\Scripts\python.exe"

if not exist "%VENV_PYTHON%" (
    echo [SETUP] Creating installer virtual environment...
    "!PYTHON_EXE!" -m venv "%VENV_DIR%"
    if not exist "%VENV_PYTHON%" (
        echo [ERROR] Failed to create virtual environment.
        echo Running directly with system Python instead...
        "!PYTHON_EXE!" "%~dp0setup.py" %*
        pause
        goto :eof
    )
    echo [OK] Virtual environment created.
    echo.
)

:: -----------------------------------------------------------
:: Step 3: Install dependencies into venv (if needed)
:: -----------------------------------------------------------
:: setup.py uses only stdlib, but we ensure pip is up to date
:: and pre-install any future dependencies here
"%VENV_PYTHON%" -c "import http.server" >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Python installation is incomplete.
    pause
    goto :eof
)

:: -----------------------------------------------------------
:: Step 4: Run the installer
:: -----------------------------------------------------------
echo [START] Launching installer web UI...
echo.
"%VENV_PYTHON%" "%~dp0setup.py" %*

pause
