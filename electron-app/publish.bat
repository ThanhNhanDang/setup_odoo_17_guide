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

REM Get current LOCAL version
for /f %%v in ('node -p "require('./package.json').version"') do set LOCAL_VER=%%v
echo   Local version:   %LOCAL_VER%

REM Get latest PUBLISHED version from GitHub (exclude drafts and pre-releases)
for /f %%v in ('gh release list --exclude-drafts --exclude-pre-releases --limit 1 --json tagName --jq ".[0].tagName" 2^>nul') do set GH_TAG=%%v
if "%GH_TAG%"=="" (
    echo   GitHub version:  [none found]
    set GH_VER=0.0.0
) else (
    REM Strip leading 'v' from tag (v1.4.1 -> 1.4.1)
    set GH_VER=%GH_TAG:~1%
    echo   GitHub version:  %GH_VER%
)

REM Compare: if local < GitHub, sync local to GitHub version first
for /f %%r in ('node -e "const [a,b]=['%LOCAL_VER%','%GH_VER%'].map(v=>v.split('.').map(Number));const c=a[0]-b[0]||a[1]-b[1]||a[2]-b[2];console.log(c<0?'behind':c>0?'ahead':'same')"') do set CMP=%%r

if "%CMP%"=="behind" (
    echo.
    echo   [WARNING] Local v%LOCAL_VER% is behind GitHub v%GH_VER%
    echo   Syncing local version to v%GH_VER% before bumping...
    call npm version %GH_VER% --no-git-tag-version --allow-same-version >nul 2>&1
)

REM Bump version
call npm version %TYPE% --no-git-tag-version >nul 2>&1

REM Get new version
for /f %%v in ('node -p "require('./package.json').version"') do set NEW_VER=%%v
echo   New version:     %NEW_VER%

REM Final safety check: new version must be > GitHub version
for /f %%r in ('node -e "const [a,b]=['%NEW_VER%','%GH_VER%'].map(v=>v.split('.').map(Number));console.log((a[0]-b[0]||a[1]-b[1]||a[2]-b[2])>0?'ok':'fail')"') do set FINAL_CMP=%%r
if "%FINAL_CMP%"=="fail" (
    echo.
    echo   [ERROR] New version v%NEW_VER% is not greater than GitHub v%GH_VER%!
    echo   Aborting publish.
    pause
    exit /b 1
)
echo.

echo   Cleaning old builds...
if exist release rmdir /s /q release

echo   Building TypeScript...
call npx tsc
if errorlevel 1 (
    echo [ERROR] TypeScript build failed!
    pause
    exit /b 1
)

echo   Packaging and uploading to GitHub...
echo.
call npx electron-builder --publish always
if errorlevel 1 (
    echo [ERROR] Publish failed!
    pause
    exit /b 1
)

REM Publish draft release (electron-builder creates drafts by default)
echo.
echo   Publishing draft release v%NEW_VER% on GitHub...
call gh release edit v%NEW_VER% --draft=false 2>nul

echo.
echo ============================================================
echo   Published v%NEW_VER% successfully!
echo   https://github.com/ThanhNhanDang/setup_odoo_17_guide/releases
echo ============================================================
echo.

REM Git commit + tag + push
cd ..
git add electron-app/package.json electron-app/package-lock.json
git commit -m "release: v%NEW_VER%"
git tag -f v%NEW_VER%
git push origin main
git push origin v%NEW_VER% --force

echo.
echo   Git tagged v%NEW_VER% and pushed!
pause
