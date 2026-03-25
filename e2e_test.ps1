<#
.SYNOPSIS
    E2E test: Start installer -> full install -> start Odoo -> create DB -> login.
    Run: powershell -ExecutionPolicy Bypass -File e2e_test.ps1
    Cleanup after: cleanup_test.bat
#>

$ErrorActionPreference = "Continue"

$INSTALLER_URL = "http://127.0.0.1:9017"
$ODOO_URL = "http://localhost:8069"
$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$DB_NAME = "test_odoo17"
$DB_LOGIN = "admin"
$DB_PASSWORD = "admin"
$MASTER_PASSWORD = "odoo"

$passed = 0
$failed = 0
$errors = @()

function Write-Step($step, $msg) {
    $ts = Get-Date -Format "HH:mm:ss"
    Write-Host "`n[$ts] === STEP $step === $msg" -ForegroundColor Cyan
}

function Write-Pass($msg) {
    $script:passed++
    Write-Host "  [PASS] $msg" -ForegroundColor Green
}

function Write-Fail($msg) {
    $script:failed++
    $script:errors += $msg
    Write-Host "  [FAIL] $msg" -ForegroundColor Red
}

function Wait-ForUrl($url, $timeoutSec = 300, $label = "service") {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    Write-Host "  Waiting for $label ..." -NoNewline
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
Write-Host "  ║  Odoo 17 E2E Test (Local)                    ║" -ForegroundColor Yellow
Write-Host "  ╚══════════════════════════════════════════════╝" -ForegroundColor Yellow
Write-Host "  Run cleanup_test.bat after to reset everything."
Write-Host ""

# ───────────────────────────────────────────────────────────────
# STEP 1: Find Python and start installer server
# ───────────────────────────────────────────────────────────────
Write-Step 1 "Start installer server"

# Check if server already running
$serverAlreadyRunning = $false
try {
    $r = Invoke-WebRequest -Uri $INSTALLER_URL -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
    if ($r.StatusCode -eq 200) {
        $serverAlreadyRunning = $true
        Write-Host "  Installer already running at $INSTALLER_URL" -ForegroundColor Green
    }
} catch {}

$serverProc = $null
if (-not $serverAlreadyRunning) {
    # Find Python
    $pythonExe = $null
    $pyCmd = Get-Command python -ErrorAction SilentlyContinue | Where-Object { $_.Source -notlike "*WindowsApps*" }
    if ($pyCmd) { $pythonExe = $pyCmd.Source }
    if (-not $pythonExe) {
        foreach ($ver in @("313","312","311","310","39")) {
            $p = "$env:LOCALAPPDATA\Programs\Python\Python$ver\python.exe"
            if (Test-Path $p) { $pythonExe = $p; break }
        }
    }
    if (-not $pythonExe) {
        Write-Fail "Python not found. Cannot start installer."
        Read-Host "Press Enter to exit"
        exit 1
    }
    Write-Host "  Python: $pythonExe"

    # Start setup.py
    $serverProc = Start-Process -FilePath $pythonExe -ArgumentList "$SCRIPT_DIR\setup.py" `
        -WorkingDirectory $SCRIPT_DIR -PassThru -WindowStyle Normal
    Write-Host "  Server PID: $($serverProc.Id)"
}

if (Wait-ForUrl $INSTALLER_URL 30 "installer") {
    Write-Pass "Installer server running"
} else {
    Write-Fail "Installer server did not start"
    exit 1
}

# ───────────────────────────────────────────────────────────────
# STEP 2: Check initial status
# ───────────────────────────────────────────────────────────────
Write-Step 2 "Check system status"
$status = Invoke-InstallerApi "/api/status"
if ($status) {
    Write-Host "  Python 3.11:  $($status.python311)"
    Write-Host "  PostgreSQL:   $($status.postgres)"
    Write-Host "  Odoo cloned:  $($status.odoo_cloned)"
    Write-Host "  Venv created: $($status.venv_created)"
    Write-Host "  Requirements: $($status.requirements_installed)"
    Write-Host "  Projects:     $($status.projects.Count)"
    Write-Pass "Status API works"
} else {
    Write-Fail "Status API failed"
}

# ───────────────────────────────────────────────────────────────
# STEP 3: Full Install
# ───────────────────────────────────────────────────────────────
Write-Step 3 "Full Install (this takes several minutes...)"
$kickoff = Invoke-InstallerApi "/api/full_install" @{
    project_name = "e2e_test_project"
    http_port    = "8069"
    db_user      = "odoo"
    db_password  = "odoo"
    db_port      = "5432"
    use_docker   = $false
}

if ($kickoff -and $kickoff.ok) {
    Write-Host "  Install started. Polling progress..."
    # Poll /api/log until task status is "done" or "error"
    $deadline = (Get-Date).AddSeconds(600)
    $lastStep = ""
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 5
        try {
            $logResult = Invoke-RestMethod -Uri "$INSTALLER_URL/api/log" `
                -Method POST -ContentType "application/json" -Body '{}' -TimeoutSec 10
            $task = $logResult.task
            if ($task.step -ne $lastStep) {
                Write-Host "  [$($task.progress)%] $($task.step)" -ForegroundColor DarkCyan
                $lastStep = $task.step
            }
            if ($task.status -eq "done" -or $task.status -eq "error") {
                break
            }
        } catch {}
    }
    # Check final results
    try {
        $finalLog = Invoke-RestMethod -Uri "$INSTALLER_URL/api/log" `
            -Method POST -ContentType "application/json" -Body '{}' -TimeoutSec 10
        if ($finalLog.task.status -eq "done") {
            Write-Pass "Full install completed"
        } else {
            Write-Fail "Full install status: $($finalLog.task.status) - $($finalLog.task.step)"
        }
    } catch {
        Write-Fail "Could not get final install status"
    }
} elseif ($kickoff -and $kickoff.msg -like "*already*") {
    Write-Host "  Install already in progress or completed previously"
    Write-Pass "Install already done"
} else {
    Write-Fail "Failed to start install: $($kickoff.msg)"
}

# ───────────────────────────────────────────────────────────────
# STEP 4: Verify post-install status
# ───────────────────────────────────────────────────────────────
Write-Step 4 "Verify installation"
$status2 = Invoke-InstallerApi "/api/status"
if ($status2) {
    if ($status2.python311)              { Write-Pass "Python 3.11 detected" }
    else                                 { Write-Fail "Python 3.11 not detected" }
    if ($status2.postgres)               { Write-Pass "PostgreSQL detected" }
    else                                 { Write-Fail "PostgreSQL not detected" }
    if ($status2.odoo_cloned)            { Write-Pass "Odoo source cloned" }
    else                                 { Write-Fail "Odoo source not cloned" }
    if ($status2.venv_created)           { Write-Pass "Venv created" }
    else                                 { Write-Fail "Venv not created" }
    if ($status2.requirements_installed) { Write-Pass "Requirements installed" }
    else                                 { Write-Fail "Requirements not installed" }

    $proj = $status2.projects | Where-Object { $_.name -eq "e2e_test_project" }
    if ($proj) { Write-Pass "Project 'e2e_test_project' exists" }
    else       { Write-Fail "Project 'e2e_test_project' not found" }
}

# ───────────────────────────────────────────────────────────────
# STEP 5: Test project APIs
# ───────────────────────────────────────────────────────────────
Write-Step 5 "Test project management APIs"

# Read config
$readResult = Invoke-InstallerApi "/api/read_config" @{ project_name = "e2e_test_project" }
if ($readResult -and $readResult.ok) { Write-Pass "Read config" }
else                                 { Write-Fail "Read config" }

# Save config
if ($readResult -and $readResult.content) {
    $saveResult = Invoke-InstallerApi "/api/save_config" @{
        project_name = "e2e_test_project"
        content      = $readResult.content
    }
    if ($saveResult -and $saveResult.ok) { Write-Pass "Save config" }
    else                                 { Write-Fail "Save config" }
}

# Duplicate project
$dupResult = Invoke-InstallerApi "/api/duplicate_project" @{
    project_name  = "e2e_test_project"
    new_name      = "e2e_test_copy"
    new_http_port = "8070"
}
if ($dupResult -and $dupResult.ok) { Write-Pass "Duplicate project" }
else                               { Write-Fail "Duplicate project: $($dupResult.msg)" }

# Delete the copy
$delResult = Invoke-InstallerApi "/api/delete_project" @{ project_name = "e2e_test_copy" }
if ($delResult -and $delResult.ok) { Write-Pass "Delete project copy" }
else                               { Write-Fail "Delete project copy" }

# ───────────────────────────────────────────────────────────────
# STEP 6: Start Odoo
# ───────────────────────────────────────────────────────────────
Write-Step 6 "Start Odoo server"
$startResult = Invoke-InstallerApi "/api/start_odoo" @{ project_name = "e2e_test_project" }
if ($startResult -and $startResult.ok) {
    Write-Pass "Odoo start command sent"
    Write-Host "  Command: $($startResult.command)"
} else {
    Write-Fail "Failed to start Odoo"
}

# Wait for Odoo
if (Wait-ForUrl "$ODOO_URL/web" 180 "Odoo on port 8069") {
    Write-Pass "Odoo is running"
} else {
    Write-Fail "Odoo did not start within 3 minutes"
    Write-Host "`n  === Last 20 log lines ===" -ForegroundColor Yellow
    $logResult = Invoke-InstallerApi "/api/log"
    if ($logResult -and $logResult.lines) {
        $logResult.lines | Select-Object -Last 20 | ForEach-Object { Write-Host "    $_" }
    }
}

# ───────────────────────────────────────────────────────────────
# STEP 7: Create Database
# ───────────────────────────────────────────────────────────────
Write-Step 7 "Create database '$DB_NAME'"

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

Write-Host "  Creating database (1-3 min for demo data)..."
$dbCreated = $false
try {
    $dbResult = Invoke-RestMethod -Uri "$ODOO_URL/web/database/create" `
        -Method POST -ContentType "application/json" -Body $createDbBody -TimeoutSec 300
    if ($dbResult.error) {
        Write-Fail "DB create: $($dbResult.error.message)"
    } else {
        Write-Pass "Database '$DB_NAME' created"
        $dbCreated = $true
    }
} catch {
    # Odoo redirects on success (302) -> PowerShell may throw
    if ($_.Exception.Response.StatusCode -eq 303 -or
        $_.Exception.Response.StatusCode -eq 302 -or
        $_.Exception.Message -like "*302*" -or
        $_.Exception.Message -like "*303*") {
        Write-Pass "Database '$DB_NAME' created (redirect = success)"
        $dbCreated = $true
    } else {
        Write-Fail "DB create error: $_"
    }
}

Start-Sleep -Seconds 3

# ───────────────────────────────────────────────────────────────
# STEP 8: Login
# ───────────────────────────────────────────────────────────────
Write-Step 8 "Login as $DB_LOGIN/$DB_PASSWORD"

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
    $loginResp = Invoke-RestMethod -Uri "$ODOO_URL/web/session/authenticate" `
        -Method POST -ContentType "application/json" -Body $loginBody -TimeoutSec 30
    if ($loginResp.result -and $loginResp.result.uid) {
        Write-Pass "Login OK! uid=$($loginResp.result.uid) user=$($loginResp.result.username)"
    } elseif ($loginResp.result -and $loginResp.result.uid -eq $false) {
        Write-Fail "Login: invalid credentials"
    } else {
        Write-Fail "Login: unexpected response"
    }
} catch {
    Write-Fail "Login error: $_"
}

# ───────────────────────────────────────────────────────────────
# STEP 9: Open browser
# ───────────────────────────────────────────────────────────────
Write-Step 9 "Open browser"
Start-Process "$ODOO_URL/web/login?db=$DB_NAME"
Write-Pass "Browser opened"

# ═══════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "  ══════════════════════════════════════════════" -ForegroundColor Yellow
Write-Host "  E2E TEST SUMMARY" -ForegroundColor Yellow
Write-Host "  ══════════════════════════════════════════════" -ForegroundColor Yellow
Write-Host "  Passed: $passed" -ForegroundColor Green
if ($failed -gt 0) {
    Write-Host "  Failed: $failed" -ForegroundColor Red
    Write-Host ""
    Write-Host "  Failures:" -ForegroundColor Red
    foreach ($e in $errors) {
        Write-Host "    - $e" -ForegroundColor Red
    }
} else {
    Write-Host "  Failed: 0" -ForegroundColor Green
}
Write-Host ""
Write-Host "  Odoo:     $ODOO_URL"
Write-Host "  Database: $DB_NAME"
Write-Host "  Login:    $DB_LOGIN / $DB_PASSWORD"
Write-Host ""
Write-Host "  Run cleanup_test.bat to reset everything."
Write-Host ""
Read-Host "Press Enter to exit"

# Stop installer server if we started it
if ($serverProc -and -not $serverProc.HasExited) {
    Write-Host "  Stopping installer server..."
    Stop-Process -Id $serverProc.Id -Force -ErrorAction SilentlyContinue
}
