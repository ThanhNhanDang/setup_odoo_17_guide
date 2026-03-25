@echo off
title Odoo 17 Setup Installer
echo ============================================
echo   Odoo 17 Development Environment Installer
echo ============================================
echo.
echo Starting installer...
echo.

:: Try Python from PATH first, then common locations
where python >nul 2>&1
if %errorlevel% equ 0 (
    python "%~dp0setup.py" %*
    goto :end
)

if exist "C:\Users\%USERNAME%\AppData\Local\Programs\Python\Python311\python.exe" (
    "C:\Users\%USERNAME%\AppData\Local\Programs\Python\Python311\python.exe" "%~dp0setup.py" %*
    goto :end
)

if exist "C:\Users\%USERNAME%\AppData\Local\Programs\Python\Python313\python.exe" (
    "C:\Users\%USERNAME%\AppData\Local\Programs\Python\Python313\python.exe" "%~dp0setup.py" %*
    goto :end
)

if exist "C:\Python311\python.exe" (
    "C:\Python311\python.exe" "%~dp0setup.py" %*
    goto :end
)

echo [ERROR] Python not found!
echo Please install Python from https://www.python.org/downloads/
echo.
pause
goto :end

:end
pause
