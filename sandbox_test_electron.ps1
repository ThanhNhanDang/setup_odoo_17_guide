# ============================================================
# Sandbox Test - Odoo 17 Installer (Electron App)
# Tests the portable exe in a clean Windows environment
# The app handles ALL installations (Git, Python, PG, etc.)
# ============================================================

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Odoo 17 Installer - Sandbox Test" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# Copy portable exe to desktop
$source = "C:\setup_odoo_17_guide\electron-app\release"
$desktop = [Environment]::GetFolderPath("Desktop")

if (Test-Path "$source\Odoo17Installer.exe") {
    Write-Host "[1] Copying portable exe to Desktop..." -ForegroundColor Yellow
    Copy-Item "$source\Odoo17Installer.exe" "$desktop\Odoo17Installer.exe"
    Write-Host "    OK: $desktop\Odoo17Installer.exe" -ForegroundColor Green
} elseif (Test-Path "$source\win-unpacked\Odoo 17 Installer.exe") {
    Write-Host "[1] Copying unpacked app to Desktop..." -ForegroundColor Yellow
    Copy-Item -Recurse "$source\win-unpacked" "$desktop\Odoo17Installer"
    Write-Host "    OK: $desktop\Odoo17Installer\" -ForegroundColor Green
} else {
    Write-Host "[1] ERROR: No build found in release folder!" -ForegroundColor Red
    Write-Host "    Build first: npm run dist" -ForegroundColor Red
    pause
    exit 1
}

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Ready! Double-click Odoo17Installer.exe" -ForegroundColor Cyan
Write-Host "  on the Desktop to test." -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Clean Windows - no Git, no Python, no PG, no Node." -ForegroundColor Gray
Write-Host "The app will install everything automatically." -ForegroundColor Gray
Write-Host ""
pause
