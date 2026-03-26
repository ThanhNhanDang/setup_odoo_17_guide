#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Full E2E test script for Windows Sandbox.
    Installs Git, runs installer, full install, starts Odoo, creates DB, logs in.
#>

$ErrorActionPreference = "Continue"
$ProgressPreference = "Continue"

$INSTALLER_URL = "http://127.0.0.1:9017"
$ODOO_URL = "http://localhost:8069"
$PROJECT_DIR = "C:\test_installer"
$DB_NAME = "test_odoo17"
$DB_LOGIN = "admin"
$DB_PASSWORD = "admin"
$MASTER_PASSWORD = "odoo"

function Write-Step($step, $msg) {
    $ts = Get-Date -Format "HH:mm:ss"
    Write-Host "[$ts] STEP $step - $msg" -ForegroundColor Cyan
}

function Wait-ForUrl($url, $timeoutSec = 300, $label = "service") {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    Write-Host "  Waiting for $label at $url ..." -NoNewline
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
            if ($r.StatusCode -eq 200) {
                Write-Host " OK!" -ForegroundColor Green
                return $true
            }
        } catch {}
        Start-Sleep -Seconds 3
        Write-Host "." -NoNewline
    }
    Write-Host " TIMEOUT!" -ForegroundColor Red
    return $false
}

function Invoke-InstallerApi($endpoint, $body = @{}) {
    $json = $body | ConvertTo-Json -Depth 5
    try {
        $r = Invoke-RestMethod -Uri "$INSTALLER_URL$endpoint" `
            -Method POST -ContentType "application/json" -Body $json -TimeoutSec 600
        return $r
    } catch {
        Write-Host "  API Error ($endpoint): $_" -ForegroundColor Red
        return $null
    }
}

# ═══════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "  ╔══════════════════════════════════════════════╗" -ForegroundColor Yellow
Write-Host "  ║  Odoo 17 Sandbox E2E Test                    ║" -ForegroundColor Yellow
Write-Host "  ╚══════════════════════════════════════════════╝" -ForegroundColor Yellow
Write-Host ""

# ───────────────────────────────────────────────────────────────
# STEP 1: Copy project files
# ───────────────────────────────────────────────────────────────
Write-Step 1 "Copying project files..."
$source = "C:\setup_odoo_17_guide"
if (-not (Test-Path $source)) {
    Write-Host "  ERROR: Mapped folder $source not found!" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}
New-Item -ItemType Directory -Path $PROJECT_DIR -Force | Out-Null
Copy-Item "$source\setup.py" "$PROJECT_DIR\" -Force
Copy-Item "$source\start.bat" "$PROJECT_DIR\" -Force
New-Item -ItemType Directory -Path "$PROJECT_DIR\templates" -Force | Out-Null
Copy-Item "$source\templates\*" "$PROJECT_DIR\templates\" -Force
Write-Host "  Files copied to $PROJECT_DIR" -ForegroundColor Green

# ───────────────────────────────────────────────────────────────
# STEP 2: Install Git
# ───────────────────────────────────────────────────────────────
Write-Step 2 "Installing Git..."
$gitExe = Get-Command git -ErrorAction SilentlyContinue
if ($gitExe) {
    Write-Host "  Git already installed: $($gitExe.Source)" -ForegroundColor Green
} else {
    $gitInstaller = "$env:TEMP\git-installer.exe"
    $gitUrl = "https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.2/Git-2.47.1.2-64-bit.exe"
    Write-Host "  Downloading Git..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $gitUrl -OutFile $gitInstaller -UseBasicParsing
    Write-Host "  Installing Git silently..."
    Start-Process -FilePath $gitInstaller -ArgumentList "/VERYSILENT /NORESTART /NOCANCEL /SP- /CLOSEAPPLICATIONS /RESTARTAPPLICATIONS /COMPONENTS=`"icons,ext\reg\shellhere,assoc,assoc_sh`"" -Wait
    # Add to PATH for this session
    $env:Path = "$env:ProgramFiles\Git\cmd;$env:Path"
    Remove-Item $gitInstaller -ErrorAction SilentlyContinue
    $gitCheck = Get-Command git -ErrorAction SilentlyContinue
    if ($gitCheck) {
        Write-Host "  Git installed: $($gitCheck.Source)" -ForegroundColor Green
    } else {
        Write-Host "  WARNING: Git install may have failed" -ForegroundColor Yellow
    }
}

# ───────────────────────────────────────────────────────────────
# STEP 3: Find/Download Python & Start installer server
# ───────────────────────────────────────────────────────────────
Write-Step 3 "Starting installer server..."

# Find Python (same logic as start.bat)
$pythonExe = $null
$candidates = @(
    (Get-Command python -ErrorAction SilentlyContinue | Where-Object { $_.Source -notlike "*WindowsApps*" })
)
if ($candidates -and $candidates[0]) {
    $pythonExe = $candidates[0].Source
}
if (-not $pythonExe) {
    foreach ($ver in @("313","312","311","310","39")) {
        $p = "$env:LOCALAPPDATA\Programs\Python\Python$ver\python.exe"
        if (Test-Path $p) { $pythonExe = $p; break }
        $p = "C:\Python$ver\python.exe"
        if (Test-Path $p) { $pythonExe = $p; break }
    }
}

# If no Python, the installer API will download it - we need at least one Python to run setup.py
if (-not $pythonExe) {
    Write-Host "  No Python found. Downloading Python 3.11.4..."
    $pyInstaller = "$env:TEMP\python-3.11.4-amd64.exe"
    Invoke-WebRequest -Uri "https://www.python.org/ftp/python/3.11.4/python-3.11.4-amd64.exe" `
        -OutFile $pyInstaller -UseBasicParsing
    Write-Host "  Installing Python 3.11.4..."
    Start-Process -FilePath $pyInstaller `
        -ArgumentList "/quiet InstallAllUsers=0 PrependPath=1 Include_pip=1 Include_launcher=1" -Wait
    Start-Sleep -Seconds 5
    Remove-Item $pyInstaller -ErrorAction SilentlyContinue
    # Re-scan
    foreach ($ver in @("311","313","312","310")) {
        $p = "$env:LOCALAPPDATA\Programs\Python\Python$ver\python.exe"
        if (Test-Path $p) { $pythonExe = $p; break }
    }
    if (-not $pythonExe) {
        Write-Host "  ERROR: Python install failed!" -ForegroundColor Red
        Read-Host "Press Enter to exit"
        exit 1
    }
}
Write-Host "  Using Python: $pythonExe" -ForegroundColor Green

# Start setup.py in background
$serverJob = Start-Process -FilePath $pythonExe -ArgumentList "$PROJECT_DIR\setup.py" `
    -WorkingDirectory $PROJECT_DIR -PassThru -WindowStyle Normal
Write-Host "  Server PID: $($serverJob.Id)"

# Wait for server
$ready = Wait-ForUrl $INSTALLER_URL 60 "installer"
if (-not $ready) {
    Write-Host "  ERROR: Installer server did not start!" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

# ───────────────────────────────────────────────────────────────
# STEP 4: Check status
# ───────────────────────────────────────────────────────────────
Write-Step 4 "Checking system status..."
$status = Invoke-InstallerApi "/api/status"
if ($status) {
    Write-Host "  Python 3.11: $($status.python311)"
    Write-Host "  PostgreSQL:  $($status.postgres)"
    Write-Host "  Odoo cloned: $($status.odoo_cloned)"
    Write-Host "  Venv:        $($status.venv_created)"
    Write-Host "  Projects:    $($status.projects.Count)"
}

# ───────────────────────────────────────────────────────────────
# STEP 5: Full Install
# ───────────────────────────────────────────────────────────────
Write-Step 5 "Running FULL INSTALL (this takes several minutes)..."
$installResult = Invoke-InstallerApi "/api/full_install" @{
    project_name = "sandbox_test"
    http_port    = "8069"
    db_user      = "odoo"
    db_password  = "odoo"
    db_port      = "5432"
    use_docker   = $false
}

if ($installResult -and $installResult.results) {
    Write-Host ""
    Write-Host "  Install Results:" -ForegroundColor Yellow
    foreach ($r in $installResult.results) {
        $icon = if ($r.ok) { "[OK]" } else { "[FAIL]" }
        $color = if ($r.ok) { "Green" } else { "Red" }
        Write-Host "    $icon $($r.step) - $($r.msg)" -ForegroundColor $color
    }
    Write-Host ""
}

# ───────────────────────────────────────────────────────────────
# STEP 6: Verify installation
# ───────────────────────────────────────────────────────────────
Write-Step 6 "Verifying installation..."
$status2 = Invoke-InstallerApi "/api/status"
if ($status2) {
    $allGood = $status2.python311 -and $status2.postgres -and
               $status2.odoo_cloned -and $status2.venv_created
    if ($allGood) {
        Write-Host "  All components installed!" -ForegroundColor Green
    } else {
        Write-Host "  WARNING: Some components missing" -ForegroundColor Yellow
        Write-Host "  Python: $($status2.python311) | PG: $($status2.postgres) | Odoo: $($status2.odoo_cloned) | Venv: $($status2.venv_created)"
    }

    if ($status2.projects.Count -gt 0) {
        Write-Host "  Projects: $($status2.projects | ForEach-Object { $_.name })" -ForegroundColor Green
    }
}

# ───────────────────────────────────────────────────────────────
# STEP 7: Start Odoo
# ───────────────────────────────────────────────────────────────
Write-Step 7 "Starting Odoo server..."
$startResult = Invoke-InstallerApi "/api/start_odoo" @{
    project_name = "sandbox_test"
}
if ($startResult -and $startResult.ok) {
    Write-Host "  Odoo starting... command: $($startResult.command)" -ForegroundColor Green
} else {
    Write-Host "  Failed to start Odoo. Trying manual start..." -ForegroundColor Yellow
    $venvPy = "D:\workspaces\odoo_17_base\venv\Scripts\python.exe"
    $odooBin = "D:\workspaces\odoo_17_base\odoo\odoo-bin"
    $odooConf = "D:\workspaces\projects\odoo17\sandbox_test\odoo.conf"
    Start-Process -FilePath $venvPy -ArgumentList "$odooBin -c $odooConf" -WindowStyle Normal
}

# Wait for Odoo to be ready
$odooReady = Wait-ForUrl "$ODOO_URL/web" 180 "Odoo"
if (-not $odooReady) {
    Write-Host ""
    Write-Host "  Odoo did not start. Check the Odoo console window for errors." -ForegroundColor Red
    Write-Host "  Opening installer log..." -ForegroundColor Yellow
    $logResult = Invoke-InstallerApi "/api/log"
    if ($logResult -and $logResult.lines) {
        $logResult.lines | Select-Object -Last 20 | ForEach-Object { Write-Host "    $_" }
    }
    Read-Host "Press Enter to exit"
    exit 1
}

# ───────────────────────────────────────────────────────────────
# STEP 8: Create Database via Odoo JSON-RPC
# ───────────────────────────────────────────────────────────────
Write-Step 8 "Creating database '$DB_NAME'..."

# Use Odoo's /web/database/create endpoint
$createDbBody = @{
    jsonrpc = "2.0"
    id      = 1
    method  = "call"
    params  = @{
        master_pwd   = $MASTER_PASSWORD
        name         = $DB_NAME
        login        = $DB_LOGIN
        password     = $DB_PASSWORD
        lang         = "en_US"
        country_code = "vn"
        phone        = ""
    }
} | ConvertTo-Json -Depth 5

Write-Host "  Creating database (this takes 1-3 minutes for demo data)..."
try {
    $dbResult = Invoke-RestMethod -Uri "$ODOO_URL/web/database/create" `
        -Method POST -ContentType "application/json" -Body $createDbBody -TimeoutSec 300
    if ($dbResult.error) {
        Write-Host "  DB creation error: $($dbResult.error.message)" -ForegroundColor Red
    } else {
        Write-Host "  Database '$DB_NAME' created!" -ForegroundColor Green
    }
} catch {
    # Odoo may redirect on success (302) which Invoke-RestMethod treats as error
    Write-Host "  Database creation request sent (may have redirected on success)" -ForegroundColor Yellow
}

Start-Sleep -Seconds 5

# ───────────────────────────────────────────────────────────────
# STEP 9: Login test
# ───────────────────────────────────────────────────────────────
Write-Step 9 "Testing login..."
$loginBody = @{
    jsonrpc = "2.0"
    id      = 2
    method  = "call"
    params  = @{
        db       = $DB_NAME
        login    = $DB_LOGIN
        password = $DB_PASSWORD
    }
} | ConvertTo-Json -Depth 5

try {
    $session = Invoke-WebRequest -Uri "$ODOO_URL/web/session/authenticate" `
        -Method POST -ContentType "application/json" -Body $loginBody `
        -UseBasicParsing -TimeoutSec 30 -SessionVariable odooSession
    $loginResult = $session.Content | ConvertFrom-Json
    if ($loginResult.result -and $loginResult.result.uid) {
        Write-Host "  Login SUCCESS! uid=$($loginResult.result.uid), user=$($loginResult.result.username)" -ForegroundColor Green
    } else {
        Write-Host "  Login failed: $($loginResult | ConvertTo-Json -Depth 3)" -ForegroundColor Red
    }
} catch {
    Write-Host "  Login error: $_" -ForegroundColor Red
}

# ───────────────────────────────────────────────────────────────
# STEP 10: Open browser
# ───────────────────────────────────────────────────────────────
Write-Step 10 "Opening browser..."
Start-Process "$ODOO_URL/web/login?db=$DB_NAME"

# ═══════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "  ══════════════════════════════════════════════" -ForegroundColor Green
Write-Host "  E2E TEST COMPLETE!" -ForegroundColor Green
Write-Host "  Odoo:     $ODOO_URL" -ForegroundColor Green
Write-Host "  Database: $DB_NAME" -ForegroundColor Green
Write-Host "  Login:    $DB_LOGIN / $DB_PASSWORD" -ForegroundColor Green
Write-Host "  ══════════════════════════════════════════════" -ForegroundColor Green
Write-Host ""
Write-Host "  Close this sandbox window to destroy everything and start fresh."
Write-Host ""
Read-Host "Press Enter to exit"
