@echo off
setlocal
title Cleanup Test Environment
chcp 65001 >nul 2>&1

echo.
echo   ╔══════════════════════════════════════════╗
echo   ║   CLEANUP - Remove all installed items    ║
echo   ╚══════════════════════════════════════════╝
echo.
echo   This will DELETE:
echo     - D:\workspaces\odoo_17_base  (Odoo source + venv)
echo     - D:\workspaces\projects\odoo17  (all projects)
echo     - Docker container: odoo-postgres-*
echo.

set /p CONFIRM="   Are you sure? (y/N): "
if /i not "%CONFIRM%"=="y" (
    echo   Cancelled.
    pause
    goto :eof
)

echo.
echo   [1/4] Removing odoo_17_base...
if exist "D:\workspaces\odoo_17_base" (
    rmdir /s /q "D:\workspaces\odoo_17_base"
    echo         Done.
) else (
    echo         Not found, skipping.
)

echo   [2/4] Removing projects...
if exist "D:\workspaces\projects\odoo17" (
    rmdir /s /q "D:\workspaces\projects\odoo17"
    echo         Done.
) else (
    echo         Not found, skipping.
)

echo   [3/4] Stopping Docker PostgreSQL containers...
for /f "tokens=*" %%c in ('docker ps -a --filter "name=odoo-postgres" --format "{{.Names}}" 2^>nul') do (
    echo         Removing container: %%c
    docker rm -f %%c >nul 2>&1
)
echo         Done.

echo   [4/4] Removing installer venv...
if exist "%~dp0.venv" (
    rmdir /s /q "%~dp0.venv"
    echo         Done.
) else (
    echo         Not found, skipping.
)

echo.
echo   ══════════════════════════════════════════
echo   Cleanup complete! Run start.bat to test again.
echo   ══════════════════════════════════════════
echo.
pause
