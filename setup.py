"""
Odoo 17 Development Environment Installer
Web-based setup wizard - zero external dependencies.
Run: python setup.py
Then open: http://localhost:9017
"""

import http.server
import json
import os
import subprocess
import shutil
import threading
import time
import webbrowser
import urllib.request
from pathlib import Path

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
HOST = "127.0.0.1"
PORT = 9017
SCRIPT_DIR = Path(__file__).resolve().parent
TEMPLATES_DIR = SCRIPT_DIR / "templates"

DEFAULT_BASE_DIR = r"D:\workspaces\odoo_17_base"
DEFAULT_PROJECTS_DIR = r"D:\workspaces\projects\odoo17"

PYTHON_311_URL = "https://www.python.org/ftp/python/3.11.4/python-3.11.4-amd64.exe"
POSTGRES_URL = "https://get.enterprisedb.com/postgresql/postgresql-16.6-1-windows-x64.exe"
ODOO_GIT_URL = "https://github.com/odoo/odoo.git"
ODOO_BRANCH = "17.0"

# ---------------------------------------------------------------------------
# Global state
# ---------------------------------------------------------------------------
log_lines = []
current_task = {"status": "idle", "step": "", "progress": 0}


def log(msg):
    ts = time.strftime("%H:%M:%S")
    line = "[{}] {}".format(ts, msg)
    log_lines.append(line)
    print(line)


def find_python311():
    localappdata = os.environ.get("LOCALAPPDATA", "")
    candidates = [
        os.path.join(localappdata, "Programs", "Python", "Python311", "python.exe"),
        r"C:\Python311\python.exe",
        r"C:\Program Files\Python311\python.exe",
    ]
    for p in candidates:
        if os.path.isfile(p):
            return p
    return None


def find_postgres_bin():
    for ver in ["17", "16", "15", "14"]:
        p = r"C:\Program Files\PostgreSQL\{}\bin".format(ver)
        if os.path.isfile(os.path.join(p, "psql.exe")):
            return p
    return None


def run_cmd(cmd, cwd=None):
    log("  > {}".format(cmd if isinstance(cmd, str) else " ".join(cmd)))
    try:
        result = subprocess.run(
            cmd, cwd=cwd, shell=True,
            capture_output=True, text=True, timeout=1800
        )
        output = result.stdout + result.stderr
        if output.strip():
            for line in output.strip().split("\n")[-5:]:
                log("    {}".format(line.strip()))
        return result.returncode, output
    except subprocess.TimeoutExpired:
        log("    [TIMEOUT]")
        return 1, "timeout"
    except Exception as e:
        log("    [ERROR] {}".format(e))
        return 1, str(e)


# ---------------------------------------------------------------------------
# Installation steps
# ---------------------------------------------------------------------------
def detect_status(base_dir, projects_dir):
    base = Path(base_dir)
    py311 = find_python311()
    pg_bin = find_postgres_bin()
    status = {
        "python311": py311 is not None,
        "python311_path": py311 or "",
        "postgres": pg_bin is not None,
        "postgres_path": pg_bin or "",
        "odoo_cloned": (base / "odoo" / "odoo-bin").exists(),
        "venv_created": (base / "venv" / "Scripts" / "python.exe").exists(),
        "requirements_installed": (base / "venv" / "Lib" / "site-packages" / "lxml").exists(),
        "base_dir": base_dir,
        "projects_dir": projects_dir,
        "projects": [],
    }
    proj_path = Path(projects_dir)
    if proj_path.exists():
        for d in sorted(proj_path.iterdir()):
            if d.is_dir() and (d / "odoo.conf").exists():
                status["projects"].append(d.name)
    return status


def step_install_python(base_dir):
    if find_python311():
        log("Python 3.11 already installed.")
        return {"ok": True, "msg": "Already installed"}
    log("Downloading Python 3.11.4...")
    installer = os.path.join(base_dir, "python-3.11.4-amd64.exe")
    os.makedirs(base_dir, exist_ok=True)
    try:
        urllib.request.urlretrieve(PYTHON_311_URL, installer)
    except Exception as e:
        return {"ok": False, "msg": "Download failed: {}".format(e)}
    log("Installing Python 3.11.4 (silent)...")
    run_cmd('"{}" /quiet InstallAllUsers=0 PrependPath=0 Include_launcher=1 Include_pip=1'.format(installer))
    time.sleep(5)
    if find_python311():
        log("Python 3.11.4 installed!")
        return {"ok": True, "msg": "Installed"}
    return {"ok": False, "msg": "Install may need admin rights. Run start.bat as Administrator."}


def step_install_postgres(base_dir, pg_super_password="postgres"):
    if find_postgres_bin():
        log("PostgreSQL already installed.")
        return {"ok": True, "msg": "Already installed"}
    log("Downloading PostgreSQL 16...")
    installer = os.path.join(base_dir, "postgresql-16-installer.exe")
    os.makedirs(base_dir, exist_ok=True)
    try:
        urllib.request.urlretrieve(POSTGRES_URL, installer)
    except Exception as e:
        return {"ok": False, "msg": "Download failed: {}".format(e)}
    log("Installing PostgreSQL 16 (this takes a few minutes)...")
    run_cmd(
        '"{}" --mode unattended --superpassword "{}" '
        '--servicename postgresql-16 --servicepassword "{}" '
        '--serverport 5432 --prefix "C:\\Program Files\\PostgreSQL\\16"'.format(
            installer, pg_super_password, pg_super_password
        )
    )
    time.sleep(10)
    if find_postgres_bin():
        log("PostgreSQL installed!")
        return {"ok": True, "msg": "Installed"}
    return {"ok": False, "msg": "Install may need admin rights. Run start.bat as Administrator."}


def step_create_pg_user(db_user="odoo", db_password="odoo", db_port="5432"):
    pg_bin = find_postgres_bin()
    if not pg_bin:
        return {"ok": False, "msg": "PostgreSQL not found"}
    psql = os.path.join(pg_bin, "psql.exe")
    code, out = run_cmd(
        '"{}" -U postgres -p {} -tAc "SELECT 1 FROM pg_roles WHERE rolname=\'{}\'"'.format(
            psql, db_port, db_user
        )
    )
    if "1" in out:
        log("User '{}' already exists.".format(db_user))
        return {"ok": True, "msg": "User already exists"}
    log("Creating PostgreSQL user '{}'...".format(db_user))
    code, out = run_cmd(
        '"{}" -U postgres -p {} -c "CREATE ROLE {} WITH LOGIN PASSWORD \'{}\' CREATEDB;"'.format(
            psql, db_port, db_user, db_password
        )
    )
    if code == 0:
        log("User '{}' created.".format(db_user))
        return {"ok": True, "msg": "User created"}
    return {"ok": False, "msg": "Failed: {}".format(out)}


def step_clone_odoo(base_dir):
    base = Path(base_dir)
    base.mkdir(parents=True, exist_ok=True)
    odoo_dir = base / "odoo"
    if (odoo_dir / "odoo-bin").exists():
        log("Odoo source already cloned.")
        return {"ok": True, "msg": "Already cloned"}
    log("Cloning Odoo 17.0 (shallow clone)...")
    code, out = run_cmd(
        "git clone --branch {} --single-branch --depth 1 {}".format(ODOO_BRANCH, ODOO_GIT_URL),
        cwd=str(base)
    )
    if (odoo_dir / "odoo-bin").exists():
        log("Odoo cloned!")
        return {"ok": True, "msg": "Cloned"}
    return {"ok": False, "msg": "Clone failed"}


def step_create_venv(base_dir):
    base = Path(base_dir)
    venv_dir = base / "venv"
    python_path = find_python311()
    if not python_path:
        return {"ok": False, "msg": "Python 3.11 not found. Install it first."}
    if (venv_dir / "Scripts" / "python.exe").exists():
        code, out = run_cmd('"{}" --version'.format(venv_dir / "Scripts" / "python.exe"))
        if "3.11" in out:
            log("Venv already exists with Python 3.11.")
            return {"ok": True, "msg": "Already exists"}
        log("Wrong Python version in venv. Recreating...")
        shutil.rmtree(str(venv_dir), ignore_errors=True)
    log("Creating virtual environment...")
    run_cmd('"{}" -m venv "{}"'.format(python_path, venv_dir))
    if (venv_dir / "Scripts" / "python.exe").exists():
        log("Venv created!")
        return {"ok": True, "msg": "Created"}
    return {"ok": False, "msg": "Failed to create venv"}


def step_install_requirements(base_dir):
    base = Path(base_dir)
    pip_exe = base / "venv" / "Scripts" / "pip.exe"
    req_file = base / "odoo" / "requirements.txt"
    if not pip_exe.exists():
        return {"ok": False, "msg": "Venv not found. Create it first."}
    if not req_file.exists():
        return {"ok": False, "msg": "requirements.txt not found. Clone Odoo first."}
    log("Installing dependencies (this takes a few minutes)...")
    code, out = run_cmd('"{}" install -r "{}"'.format(pip_exe, req_file))
    if code == 0 or "Successfully installed" in out:
        log("Requirements installed!")
        return {"ok": True, "msg": "Installed"}
    return {"ok": False, "msg": "Failed. Check logs."}


def step_create_project(base_dir, projects_dir, project_name,
                        http_port="8069", db_port="5432",
                        db_user="odoo", db_password="odoo"):
    base = Path(base_dir)
    proj = Path(projects_dir) / project_name
    if not project_name.strip():
        return {"ok": False, "msg": "Project name is required"}
    if (proj / "odoo.conf").exists():
        return {"ok": False, "msg": "Project '{}' already exists".format(project_name)}
    log("Creating project '{}'...".format(project_name))
    proj.mkdir(parents=True, exist_ok=True)
    (proj / "addons").mkdir(exist_ok=True)
    (proj / ".vscode").mkdir(exist_ok=True)

    # Junction link
    odoo_link = proj / "odoo"
    odoo_source = base / "odoo"
    if not odoo_link.exists():
        run_cmd('cmd /c mklink /J "{}" "{}"'.format(odoo_link, odoo_source))
        if not odoo_link.exists():
            return {"ok": False, "msg": "Failed to create symlink. Run as Administrator."}

    # odoo.conf
    conf_template = (TEMPLATES_DIR / "odoo.conf").read_text(encoding="utf-8")
    (proj / "odoo.conf").write_text(
        conf_template.format(
            http_port=http_port, db_port=db_port,
            db_user=db_user, db_password=db_password,
        ),
        encoding="utf-8",
    )

    # launch.json
    venv_python = str(base / "venv" / "Scripts" / "python.exe").replace("\\", "\\\\")
    odoo_bin = str(base / "odoo" / "odoo-bin").replace("\\", "\\\\")
    launch_template = (TEMPLATES_DIR / "launch.json").read_text(encoding="utf-8")
    (proj / ".vscode" / "launch.json").write_text(
        launch_template.format(python_path=venv_python, odoo_bin_path=odoo_bin),
        encoding="utf-8",
    )

    log("Project '{}' ready at {}".format(project_name, proj))
    return {"ok": True, "msg": str(proj)}


def step_full_install(base_dir, projects_dir, project_name,
                      http_port, db_port, db_user, db_password, pg_super_password):
    steps = [
        ("Installing Python 3.11...", lambda: step_install_python(base_dir)),
        ("Installing PostgreSQL...", lambda: step_install_postgres(base_dir, pg_super_password)),
        ("Creating DB user...", lambda: step_create_pg_user(db_user, db_password, db_port)),
        ("Cloning Odoo 17...", lambda: step_clone_odoo(base_dir)),
        ("Creating virtual environment...", lambda: step_create_venv(base_dir)),
        ("Installing requirements...", lambda: step_install_requirements(base_dir)),
        ("Creating project...", lambda: step_create_project(
            base_dir, projects_dir, project_name,
            http_port, db_port, db_user, db_password
        )),
    ]
    results = []
    for i, (label, fn) in enumerate(steps):
        current_task["step"] = label
        current_task["progress"] = int((i / len(steps)) * 100)
        current_task["status"] = "running"
        log("")
        log("=" * 50)
        log("Step {}/{}: {}".format(i + 1, len(steps), label))
        log("=" * 50)
        result = fn()
        results.append({"step": label, "ok": result["ok"], "msg": result["msg"]})
        if not result["ok"]:
            log("[WARN] {} - continuing...".format(result["msg"]))
    current_task["status"] = "done"
    current_task["progress"] = 100
    current_task["step"] = "Complete!"
    return results


# ---------------------------------------------------------------------------
# HTML UI (SoundCloud-inspired dark theme)
# ---------------------------------------------------------------------------
HTML_PAGE = r"""<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Odoo 17 Installer</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',system-ui,-apple-system,sans-serif;background:#111;color:#ccc;min-height:100vh}

/* SoundCloud-style top bar */
.topbar{background:#333;height:46px;display:flex;align-items:center;padding:0 24px;position:sticky;top:0;z-index:100;border-bottom:1px solid #444}
.topbar .brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:1rem;color:#f50}
.topbar .brand svg{width:28px;height:28px}
.topbar .nav{display:flex;gap:4px;margin-left:32px}
.topbar .nav button{background:none;border:none;color:#999;padding:8px 14px;font-size:0.85rem;cursor:pointer;border-radius:4px;transition:all 0.15s}
.topbar .nav button:hover,.topbar .nav button.active{color:#fff;background:#444}

.main{display:flex;max-width:1100px;margin:0 auto;min-height:calc(100vh - 46px)}
.sidebar{width:240px;background:#1a1a1a;border-right:1px solid #282828;padding:20px 0;flex-shrink:0}
.sidebar .menu-item{display:flex;align-items:center;gap:10px;padding:10px 20px;color:#999;font-size:0.9rem;cursor:pointer;transition:all 0.15s;border-left:3px solid transparent}
.sidebar .menu-item:hover{color:#fff;background:#222}
.sidebar .menu-item.active{color:#f50;border-left-color:#f50;background:#1f1a17}
.sidebar .menu-item svg{width:18px;height:18px;flex-shrink:0}
.sidebar .menu-label{padding:20px 20px 8px;font-size:0.7rem;text-transform:uppercase;letter-spacing:1px;color:#666}

.content{flex:1;padding:28px 32px;overflow-y:auto}
.content h2{font-size:1.3rem;color:#fff;margin-bottom:4px}
.content .desc{color:#888;font-size:0.85rem;margin-bottom:24px}

/* Panels */
.panel{display:none}
.panel.active{display:block}

/* Status cards */
.status-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-bottom:24px}
.status-card{background:#1a1a1a;border:1px solid #282828;border-radius:6px;padding:16px;display:flex;align-items:center;gap:12px;transition:border 0.2s}
.status-card:hover{border-color:#444}
.status-icon{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:1.1rem;flex-shrink:0}
.status-icon.ok{background:#1a3a1a;color:#22c55e}
.status-icon.missing{background:#3a1a1a;color:#ef4444}
.status-info .label{font-size:0.85rem;color:#fff;font-weight:600}
.status-info .detail{font-size:0.7rem;color:#666;margin-top:2px;word-break:break-all}

/* Forms */
.form-section{background:#1a1a1a;border:1px solid #282828;border-radius:6px;padding:20px;margin-bottom:16px}
.form-section h3{font-size:0.95rem;color:#fff;margin-bottom:14px;display:flex;align-items:center;gap:8px}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.form-group{display:flex;flex-direction:column;gap:4px}
.form-group.full{grid-column:1/-1}
.form-group label{font-size:0.75rem;color:#888;text-transform:uppercase;letter-spacing:0.5px}
.form-group input{padding:9px 12px;border-radius:4px;border:1px solid #333;background:#222;color:#eee;font-size:0.9rem;outline:none;transition:border 0.2s}
.form-group input:focus{border-color:#f50}

/* Buttons */
.btn{padding:10px 20px;border-radius:4px;border:none;font-size:0.9rem;font-weight:600;cursor:pointer;transition:all 0.15s;display:inline-flex;align-items:center;gap:6px}
.btn-primary{background:#f50;color:#fff}
.btn-primary:hover{background:#e04500}
.btn-primary:disabled{opacity:0.4;cursor:not-allowed}
.btn-outline{background:transparent;border:1px solid #444;color:#999}
.btn-outline:hover{border-color:#f50;color:#fff}
.btn-sm{padding:6px 12px;font-size:0.8rem}
.btn-block{width:100%;justify-content:center;margin-top:8px}
.btn-row{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}

/* Progress */
.progress-wrap{margin-top:16px;display:none}
.progress-wrap.visible{display:block}
.progress-bar{height:4px;background:#282828;border-radius:2px;overflow:hidden}
.progress-fill{height:100%;background:linear-gradient(90deg,#f50,#ff8c00);transition:width 0.5s;width:0%}
.progress-info{display:flex;justify-content:space-between;margin-top:6px;font-size:0.75rem;color:#666}

/* Log */
.log-box{background:#0a0a0a;border:1px solid #1e1e1e;border-radius:4px;padding:10px;max-height:280px;overflow-y:auto;font-family:'Cascadia Code',Consolas,monospace;font-size:0.78rem;line-height:1.7;color:#555;margin-top:12px}
.log-box .line:last-child{color:#ccc}

/* Projects list */
.project-card{background:#1a1a1a;border:1px solid #282828;border-radius:6px;padding:14px 18px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;transition:border 0.2s}
.project-card:hover{border-color:#f50}
.project-card .name{font-weight:600;color:#fff;font-size:0.95rem}
.project-card .path{font-size:0.75rem;color:#666;margin-top:2px}
.tag{display:inline-block;padding:3px 10px;border-radius:3px;font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:0.5px}
.tag-ready{background:#1a3a1a;color:#22c55e}

/* Results */
.result-item{display:flex;align-items:center;gap:8px;padding:8px 0;font-size:0.9rem;border-bottom:1px solid #1e1e1e}
.result-item:last-child{border:none}

/* Empty state */
.empty{text-align:center;padding:40px 20px;color:#555}
.empty svg{width:48px;height:48px;margin-bottom:12px;opacity:0.3}

/* Responsive */
@media(max-width:768px){
  .sidebar{display:none}
  .form-grid{grid-template-columns:1fr}
  .status-grid{grid-template-columns:1fr}
}
</style>
</head>
<body>

<!-- Top Bar -->
<div class="topbar">
  <div class="brand">
    <svg viewBox="0 0 24 24" fill="none" stroke="#f50" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
    Odoo 17 Installer
  </div>
</div>

<div class="main">
  <!-- Sidebar -->
  <div class="sidebar">
    <div class="menu-label">Setup</div>
    <div class="menu-item active" onclick="showPanel('status',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
      Status
    </div>
    <div class="menu-item" onclick="showPanel('install',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7,10 12,15 17,10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      Full Install
    </div>
    <div class="menu-label">Projects</div>
    <div class="menu-item" onclick="showPanel('newproject',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
      New Project
    </div>
    <div class="menu-item" onclick="showPanel('projects',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
      My Projects
    </div>
    <div class="menu-label">Advanced</div>
    <div class="menu-item" onclick="showPanel('log',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4,17 10,11 4,5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
      Log
    </div>
  </div>

  <!-- Content -->
  <div class="content">

    <!-- STATUS PANEL -->
    <div class="panel active" id="panel-status">
      <h2>System Status</h2>
      <p class="desc">Current state of your development environment</p>
      <div class="status-grid" id="statusGrid"></div>
      <button class="btn btn-outline btn-sm" onclick="refreshStatus()">Refresh</button>
    </div>

    <!-- INSTALL PANEL -->
    <div class="panel" id="panel-install">
      <h2>Full Install</h2>
      <p class="desc">Install everything in one click - Python, PostgreSQL, Odoo, and your first project</p>

      <div class="form-section">
        <h3>Directories</h3>
        <div class="form-grid">
          <div class="form-group"><label>Base Directory</label><input id="baseDir" value="D:\workspaces\odoo_17_base"></div>
          <div class="form-group"><label>Projects Directory</label><input id="projectsDir" value="D:\workspaces\projects\odoo17"></div>
        </div>
      </div>

      <div class="form-section">
        <h3>Project</h3>
        <div class="form-grid">
          <div class="form-group"><label>Project Name</label><input id="projectName" value="my_project"></div>
          <div class="form-group"><label>HTTP Port</label><input id="httpPort" value="8069" type="number"></div>
        </div>
      </div>

      <div class="form-section">
        <h3>Database</h3>
        <div class="form-grid">
          <div class="form-group"><label>DB User</label><input id="dbUser" value="odoo"></div>
          <div class="form-group"><label>DB Password</label><input id="dbPassword" value="odoo"></div>
          <div class="form-group"><label>DB Port</label><input id="dbPort" value="5432" type="number"></div>
          <div class="form-group"><label>PG Super Password</label><input id="pgSuperPassword" value="postgres"></div>
        </div>
      </div>

      <button class="btn btn-primary btn-block" id="btnFullInstall" onclick="fullInstall()">Install Everything</button>

      <div class="btn-row">
        <button class="btn btn-outline btn-sm" onclick="runStep('install_python')">Python</button>
        <button class="btn btn-outline btn-sm" onclick="runStep('install_postgres')">PostgreSQL</button>
        <button class="btn btn-outline btn-sm" onclick="runStep('clone_odoo')">Clone Odoo</button>
        <button class="btn btn-outline btn-sm" onclick="runStep('create_venv')">Venv</button>
        <button class="btn btn-outline btn-sm" onclick="runStep('install_requirements')">Pip Install</button>
      </div>

      <div class="progress-wrap" id="progressWrap">
        <div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div>
        <div class="progress-info"><span id="progressStep">Preparing...</span><span id="progressPct">0%</span></div>
      </div>
      <div id="results"></div>
    </div>

    <!-- NEW PROJECT PANEL -->
    <div class="panel" id="panel-newproject">
      <h2>Create New Project</h2>
      <p class="desc">Add a new Odoo project with its own config and port</p>
      <div class="form-section">
        <div class="form-grid">
          <div class="form-group"><label>Project Name</label><input id="newProjName" placeholder="e.g. ecommerce, hr, crm"></div>
          <div class="form-group"><label>HTTP Port</label><input id="newProjPort" value="8070" type="number"></div>
          <div class="form-group"><label>DB Port</label><input id="newProjDbPort" value="5432" type="number"></div>
          <div class="form-group"><label>DB Password</label><input id="newProjDbPass" value="odoo"></div>
        </div>
        <button class="btn btn-primary btn-block" onclick="createProject()">Create Project</button>
      </div>
    </div>

    <!-- PROJECTS PANEL -->
    <div class="panel" id="panel-projects">
      <h2>My Projects</h2>
      <p class="desc">Existing Odoo projects</p>
      <div id="projectsList"></div>
    </div>

    <!-- LOG PANEL -->
    <div class="panel" id="panel-log">
      <h2>Installation Log</h2>
      <p class="desc">Real-time output from installation commands</p>
      <div class="log-box" id="log" style="max-height:500px"></div>
    </div>

  </div>
</div>

<script>
const $=id=>document.getElementById(id);

function showPanel(name,el){
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.menu-item').forEach(m=>m.classList.remove('active'));
  $('panel-'+name).classList.add('active');
  if(el)el.classList.add('active');
  if(name==='status'||name==='projects')refreshStatus();
  if(name==='log')pollLog();
}

function escHtml(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}

async function api(endpoint,data={}){
  const res=await fetch('/api/'+endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  return res.json();
}

function getFormData(){
  return {
    base_dir:$('baseDir').value, projects_dir:$('projectsDir').value,
    project_name:$('projectName').value, http_port:$('httpPort').value,
    db_port:$('dbPort').value, db_user:$('dbUser').value,
    db_password:$('dbPassword').value, pg_super_password:$('pgSuperPassword').value,
  };
}

async function refreshStatus(){
  const data=getFormData();
  const s=await api('status',data);
  const items=[
    ['Python 3.11',s.python311,s.python311_path,'P'],
    ['PostgreSQL',s.postgres,s.postgres_path,'DB'],
    ['Odoo Source',s.odoo_cloned,'','O'],
    ['Virtual Env',s.venv_created,'','V'],
    ['Requirements',s.requirements_installed,'','R'],
  ];
  $('statusGrid').innerHTML=items.map(([label,ok,detail,letter])=>`
    <div class="status-card">
      <div class="status-icon ${ok?'ok':'missing'}">${ok?'\u2713':'\u2717'}</div>
      <div class="status-info">
        <div class="label">${label}</div>
        ${detail?`<div class="detail">${escHtml(detail)}</div>`:''}
      </div>
    </div>`).join('');
  const list=$('projectsList');
  if(s.projects&&s.projects.length>0){
    list.innerHTML=s.projects.map(name=>`
      <div class="project-card">
        <div><div class="name">${escHtml(name)}</div><div class="path">${escHtml(data.projects_dir)}\\${escHtml(name)}</div></div>
        <span class="tag tag-ready">ready</span>
      </div>`).join('');
  }else{
    list.innerHTML='<div class="empty"><p>No projects yet. Create one to get started.</p></div>';
  }
}

let logPoll=null;
async function pollLog(){
  const res=await api('log');
  const el=$('log');
  el.innerHTML=res.lines.map(l=>`<div class="line">${escHtml(l)}</div>`).join('');
  el.scrollTop=el.scrollHeight;
  if(res.task.status==='running'){
    $('progressFill').style.width=res.task.progress+'%';
    $('progressStep').textContent=res.task.step;
    $('progressPct').textContent=res.task.progress+'%';
  }
}
function startLogPoll(){
  $('progressWrap').classList.add('visible');
  if(!logPoll)logPoll=setInterval(pollLog,1000);
}
function stopLogPoll(){if(logPoll){clearInterval(logPoll);logPoll=null}pollLog()}

async function fullInstall(){
  const btn=$('btnFullInstall');
  btn.disabled=true;btn.textContent='Installing...';
  $('results').innerHTML='';
  startLogPoll();
  const res=await api('full_install',getFormData());
  btn.disabled=false;btn.textContent='Install Everything';
  stopLogPoll();
  $('progressFill').style.width='100%';
  $('progressStep').textContent='Done!';
  $('progressPct').textContent='100%';
  if(res.results){
    $('results').innerHTML=res.results.map(r=>`
      <div class="result-item">
        <span style="font-size:1.1rem">${r.ok?'\u2705':'\u274C'}</span>
        <span>${escHtml(r.step)}</span>
        <span style="color:#666;font-size:0.8rem;margin-left:auto">${escHtml(r.msg)}</span>
      </div>`).join('');
  }
  refreshStatus();
}

async function runStep(step){
  startLogPoll();
  const res=await api('run_step',{...getFormData(),step});
  stopLogPoll();refreshStatus();
  alert(res.ok?'\u2705 '+res.msg:'\u274C '+res.msg);
}

async function createProject(){
  const name=$('newProjName').value.trim();
  if(!name){alert('Enter a project name');return}
  startLogPoll();
  const data=getFormData();
  data.project_name=name;
  data.http_port=$('newProjPort').value;
  data.db_port=$('newProjDbPort').value;
  data.db_password=$('newProjDbPass').value;
  const res=await api('create_project',data);
  stopLogPoll();refreshStatus();
  alert(res.ok?'\u2705 Project created!\n'+res.msg:'\u274C '+res.msg);
}

refreshStatus();
</script>
</body>
</html>
"""


# ---------------------------------------------------------------------------
# HTTP Server
# ---------------------------------------------------------------------------
class InstallerHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _respond(self, code, content, ctype="text/html"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(content.encode("utf-8"))

    def _json(self, data, code=200):
        self._respond(code, json.dumps(data, ensure_ascii=False), "application/json")

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length)) if length else {}

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            self._respond(200, HTML_PAGE)
        else:
            self._respond(404, "Not Found")

    def do_POST(self):
        body = self._read_body()
        path = self.path

        if path == "/api/status":
            self._json(detect_status(
                body.get("base_dir", DEFAULT_BASE_DIR),
                body.get("projects_dir", DEFAULT_PROJECTS_DIR),
            ))

        elif path == "/api/log":
            self._json({"lines": log_lines[-200:], "task": current_task})

        elif path == "/api/full_install":
            results = step_full_install(
                base_dir=body.get("base_dir", DEFAULT_BASE_DIR),
                projects_dir=body.get("projects_dir", DEFAULT_PROJECTS_DIR),
                project_name=body.get("project_name", "my_project"),
                http_port=body.get("http_port", "8069"),
                db_port=body.get("db_port", "5432"),
                db_user=body.get("db_user", "odoo"),
                db_password=body.get("db_password", "odoo"),
                pg_super_password=body.get("pg_super_password", "postgres"),
            )
            self._json({"ok": True, "results": results})

        elif path == "/api/run_step":
            step = body.get("step", "")
            bd = body.get("base_dir", DEFAULT_BASE_DIR)
            fns = {
                "install_python": lambda: step_install_python(bd),
                "install_postgres": lambda: step_install_postgres(bd, body.get("pg_super_password", "postgres")),
                "clone_odoo": lambda: step_clone_odoo(bd),
                "create_venv": lambda: step_create_venv(bd),
                "install_requirements": lambda: step_install_requirements(bd),
            }
            fn = fns.get(step)
            self._json(fn() if fn else {"ok": False, "msg": "Unknown step"})

        elif path == "/api/create_project":
            self._json(step_create_project(
                base_dir=body.get("base_dir", DEFAULT_BASE_DIR),
                projects_dir=body.get("projects_dir", DEFAULT_PROJECTS_DIR),
                project_name=body.get("project_name", ""),
                http_port=body.get("http_port", "8069"),
                db_port=body.get("db_port", "5432"),
                db_user=body.get("db_user", "odoo"),
                db_password=body.get("db_password", "odoo"),
            ))

        else:
            self._json({"error": "Not found"}, 404)


def main():
    server = http.server.HTTPServer((HOST, PORT), InstallerHandler)
    url = "http://{}:{}".format(HOST, PORT)
    print("")
    print("=" * 50)
    print("  Odoo 17 Installer: {}".format(url))
    print("  Press Ctrl+C to stop")
    print("=" * 50)
    print("")
    threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        server.shutdown()


if __name__ == "__main__":
    main()
