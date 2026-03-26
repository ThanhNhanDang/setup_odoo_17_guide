@echo off
REM ============================================================
REM  Odoo 17 Installer - Publish New Version
REM  Usage: publish.bat [patch|minor|major]
REM
REM  patch: 1.0.0 -> 1.0.1 (bug fixes)
REM  minor: 1.0.0 -> 1.1.0 (new features)
REM  major: 1.0.0 -> 2.0.0 (breaking changes)
REM
REM  Requires: GH_TOKEN environment variable
REM ============================================================

if "%GH_TOKEN%"=="" (
    echo [ERROR] GH_TOKEN not set!
    echo.
    echo   1. Go to: https://github.com/settings/tokens
    echo   2. Create token with 'repo' scope
    echo   3. Run: set GH_TOKEN=your_token_here
    echo   4. Then run this script again
    echo.
    pause
    exit /b 1
)

set TYPE=%1
if "%TYPE%"=="" set TYPE=patch

echo.
echo ============================================================
echo   Publishing %TYPE% release...
echo ============================================================
echo.

REM Show current version
for /f "tokens=2 delims=:, " %%a in ('findstr "version" package.json') do (
    echo   Current version: %%~a
    goto :bump
)
:bump

REM Bump version
call npm version %TYPE% --no-git-tag-version
echo.

REM Show new version
for /f "tokens=2 delims=:, " %%a in ('findstr "version" package.json') do (
    echo   New version: %%~a
    goto :build
)
:build

echo.
echo   Building and publishing...
echo.

call tsc
if errorlevel 1 (
    echo [ERROR] TypeScript build failed!
    pause
    exit /b 1
)

call npx electron-builder --publish always
if errorlevel 1 (
    echo [ERROR] Publish failed!
    pause
    exit /b 1
)

echo.
echo ============================================================
echo   Published successfully!
echo   Check: https://github.com/ThanhNhanDang/setup_odoo_17_guide/releases
echo ============================================================
echo.

REM Git commit the version bump
cd ..
git add electron-app/package.json electron-app/package-lock.json
for /f "tokens=2 delims=:, " %%a in ('findstr "version" electron-app\package.json') do (
    git commit -m "release: v%%~a"
    git tag v%%~a
    git push origin main --tags
)

echo   Git tagged and pushed!
pause
