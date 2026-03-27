"""
Odoo 17 Development Environment Installer
Web-based setup wizard - zero external dependencies.
Run: python setup.py
Then open: http://localhost:9017
"""

import configparser
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

PROJECT_DEFAULTS = {
    "addons_path": "./addons,./odoo/addons",
    "admin_passwd": "odoo",
    "http_port": "8069",
    "longpolling_port": "",
    "db_host": "localhost",
    "db_port": "5432",
    "db_user": "odoo",
    "db_password": "odoo",
    "log_level": "error",
    "workers": "0",
    "limit_memory_hard": "10737418240",
    "limit_memory_soft": "10737418240",
    "list_db": "True",
    "dbfilter": "",
    "proxy_mode": "True",
    "server_wide_modules": "base,web",
    "data_dir": "",
}

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
# Detection functions
# ---------------------------------------------------------------------------
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


def find_docker():
    try:
        result = subprocess.run(
            "docker --version", shell=True,
            capture_output=True, text=True, timeout=5
        )
        return result.returncode == 0
    except Exception:
        return False


def find_docker_postgres():
    try:
        result = subprocess.run(
            'docker ps --format "{{.Names}}\\t{{.Image}}\\t{{.Ports}}\\t{{.Status}}"',
            shell=True, capture_output=True, text=True, timeout=10
        )
        containers = []
        if result.returncode == 0 and result.stdout.strip():
            for line in result.stdout.strip().split("\n"):
                parts = line.split("\t")
                if len(parts) >= 3 and "postgres" in parts[1].lower():
                    port = ""
                    for mapping in parts[2].split(","):
                        mapping = mapping.strip()
                        if "->5432" in mapping and ":" in mapping:
                            port = mapping.split(":")[1].split("->")[0]
                            break
                    containers.append({
                        "name": parts[0],
                        "image": parts[1],
                        "port": port,
                        "status": parts[3] if len(parts) > 3 else "",
                    })
        return containers
    except Exception:
        return []


def detect_native_postgres_details():
    pg_bin = find_postgres_bin()
    if not pg_bin:
        return None
    result = {"data_dir": "", "port": "", "is_ready": False, "databases": [], "bin_path": pg_bin}
    # Find data dir and port
    for ver in ["17", "16", "15", "14"]:
        data_dir = r"C:\Program Files\PostgreSQL\{}\data".format(ver)
        if os.path.isdir(data_dir):
            result["data_dir"] = data_dir
            # Parse port from postgresql.conf
            conf_file = os.path.join(data_dir, "postgresql.conf")
            if os.path.isfile(conf_file):
                try:
                    with open(conf_file, "r", encoding="utf-8", errors="ignore") as f:
                        for line in f:
                            line = line.strip()
                            if line.startswith("port") and "=" in line:
                                result["port"] = line.split("=")[1].strip().split("#")[0].strip()
                                break
                except Exception:
                    pass
            break
    # Check pg_isready
    port = result["port"] or "5432"
    pg_isready = os.path.join(pg_bin, "pg_isready.exe")
    if os.path.isfile(pg_isready):
        try:
            r = subprocess.run(
                '"{}" -p {}'.format(pg_isready, port),
                shell=True, capture_output=True, text=True, timeout=5
            )
            result["is_ready"] = r.returncode == 0
        except Exception:
            pass
    # List databases
    psql = os.path.join(pg_bin, "psql.exe")
    if result["is_ready"]:
        try:
            env = os.environ.copy()
            env["PGPASSWORD"] = "postgres"
            r = subprocess.run(
                '"{}" -U postgres -p {} --no-password -tAc "SELECT datname FROM pg_database WHERE datistemplate=false"'.format(
                    psql, port),
                shell=True, capture_output=True, text=True, timeout=10, env=env
            )
            if r.returncode == 0:
                result["databases"] = [db.strip() for db in r.stdout.strip().split("\n") if db.strip()]
        except Exception:
            pass
    return result


def parse_project_config(project_path, base_dir=DEFAULT_BASE_DIR):
    """Parse a project's odoo.conf and return rich detail dict."""
    conf_file = os.path.join(str(project_path), "odoo.conf")
    info = {
        "name": os.path.basename(str(project_path)),
        "path": str(project_path),
        "http_port": "", "longpolling_port": "", "db_port": "", "db_host": "",
        "db_user": "", "addons_path": "", "data_dir": "", "admin_passwd": "",
        "log_level": "", "workers": "", "list_db": "", "dbfilter": "",
        "proxy_mode": "", "server_wide_modules": "",
        "custom_modules": 0, "addon_dirs": [],
        "start_command": "",
    }
    if not os.path.isfile(conf_file):
        return info
    try:
        cp = configparser.RawConfigParser()
        cp.read(conf_file, encoding="utf-8")
        section = "options"
        if not cp.has_section(section):
            return info
        get = lambda k, d="": cp.get(section, k) if cp.has_option(section, k) else d
        info["http_port"] = get("http_port")
        info["longpolling_port"] = get("longpolling_port", get("gevent_port"))
        info["db_port"] = get("db_port")
        info["db_host"] = get("db_host", "localhost")
        info["db_user"] = get("db_user")
        info["addons_path"] = get("addons_path")
        info["data_dir"] = get("data_dir")
        info["admin_passwd"] = get("admin_passwd")
        info["log_level"] = get("log_level")
        info["workers"] = get("workers")
        info["list_db"] = get("list_db")
        info["dbfilter"] = get("dbfilter")
        info["proxy_mode"] = get("proxy_mode")
        info["server_wide_modules"] = get("server_wide_modules")
    except Exception:
        pass
    # Count custom modules
    total_custom = 0
    addon_dirs = []
    if info["addons_path"]:
        for p in info["addons_path"].split(","):
            p = p.strip()
            # Resolve relative paths
            abs_p = p
            if not os.path.isabs(p):
                abs_p = os.path.join(str(project_path), p)
            is_base = "odoo/addons" in p.replace("\\", "/")
            count = 0
            if os.path.isdir(abs_p) and not is_base:
                try:
                    for entry in os.listdir(abs_p):
                        manifest = os.path.join(abs_p, entry, "__manifest__.py")
                        if os.path.isfile(manifest):
                            count += 1
                except Exception:
                    pass
            addon_dirs.append({"path": p, "count": count, "is_base": is_base})
            if not is_base:
                total_custom += count
    info["custom_modules"] = total_custom
    info["addon_dirs"] = addon_dirs
    # Build start command
    venv_py = os.path.join(base_dir, "venv", "Scripts", "python.exe")
    odoo_bin = os.path.join(base_dir, "odoo", "odoo-bin")
    info["start_command"] = '"{}" "{}" -c "{}"'.format(venv_py, odoo_bin, conf_file)
    return info


# ---------------------------------------------------------------------------
# Status detection
# ---------------------------------------------------------------------------
def detect_status(base_dir, projects_dir):
    base = Path(base_dir)
    py311 = find_python311()
    pg_bin = find_postgres_bin()
    docker_available = find_docker()
    docker_pg = find_docker_postgres() if docker_available else []
    native_pg = detect_native_postgres_details()
    pg_ok = pg_bin is not None or len(docker_pg) > 0

    if docker_pg:
        pg_detail = "Docker: " + ", ".join(
            "{}({} port:{})".format(c["name"], c["image"], c["port"]) for c in docker_pg
        )
    elif pg_bin:
        pg_detail = pg_bin
    else:
        pg_detail = ""

    status = {
        "python311": py311 is not None,
        "python311_path": py311 or "",
        "postgres": pg_ok,
        "postgres_path": pg_detail,
        "postgres_local": pg_bin is not None,
        "docker": docker_available,
        "docker_postgres": docker_pg,
        "native_postgres": native_pg,
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
                status["projects"].append(parse_project_config(d, base_dir))
    return status


# ---------------------------------------------------------------------------
# Installation steps
# ---------------------------------------------------------------------------
def step_install_python(base_dir):
    if find_python311():
        log("Python 3.11 already installed.")
        return {"ok": True, "msg": "Already installed"}
    log("Downloading Python 3.11.4...")
    os.makedirs(base_dir, exist_ok=True)
    installer = os.path.join(base_dir, "python-3.11.4-amd64.exe")
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


def step_install_postgres(base_dir, pg_super_password="postgres",
                          db_port="5432", db_user="odoo", db_password="odoo",
                          use_docker=True, container_name=""):
    if find_postgres_bin():
        log("PostgreSQL already installed locally.")
        return {"ok": True, "msg": "Already installed (local)"}
    docker_pg = find_docker_postgres()
    if docker_pg:
        log("PostgreSQL running in Docker: {}".format(", ".join(c["name"] for c in docker_pg)))
        return {"ok": True, "msg": "Already running (Docker)"}
    if use_docker and find_docker():
        cname = container_name or "odoo-postgres-{}".format(db_port)
        log("Creating PostgreSQL container '{}'...".format(cname))
        code, out = run_cmd(
            'docker run -d --name {} -e POSTGRES_USER={} -e POSTGRES_PASSWORD={} '
            '-e POSTGRES_DB=postgres -p {}:5432 --restart unless-stopped postgres:16'.format(
                cname, db_user, db_password, db_port))
        if code == 0:
            log("Docker container '{}' started on port {}!".format(cname, db_port))
            return {"ok": True, "msg": "Docker container '{}' on port {}".format(cname, db_port)}
    log("Downloading PostgreSQL 16...")
    os.makedirs(base_dir, exist_ok=True)
    installer = os.path.join(base_dir, "postgresql-16-installer.exe")
    try:
        urllib.request.urlretrieve(POSTGRES_URL, installer)
    except Exception as e:
        return {"ok": False, "msg": "Download failed: {}".format(e)}
    log("Installing PostgreSQL 16...")
    run_cmd('"{}" --mode unattended --superpassword "{}" --servicename postgresql-16 '
            '--servicepassword "{}" --serverport {} --prefix "C:\\Program Files\\PostgreSQL\\16"'.format(
                installer, pg_super_password, pg_super_password, db_port))
    time.sleep(10)
    if find_postgres_bin():
        return {"ok": True, "msg": "Installed (native)"}
    return {"ok": False, "msg": "Install failed. Run as Administrator or install Docker."}


def step_create_pg_user(db_user="odoo", db_password="odoo", db_port="5432",
                        pg_super_password="postgres"):
    docker_pg = find_docker_postgres()
    for c in docker_pg:
        if c["port"] == str(db_port):
            code, out = run_cmd(
                'docker exec {} psql -U postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname=\'{}\'"'.format(
                    c["name"], db_user))
            if "1" in out:
                return {"ok": True, "msg": "User exists (Docker: {})".format(c["name"])}
            code, out = run_cmd(
                'docker exec {} psql -U postgres -c "CREATE ROLE {} WITH LOGIN PASSWORD \'{}\' CREATEDB;"'.format(
                    c["name"], db_user, db_password))
            if code == 0:
                return {"ok": True, "msg": "User created (Docker: {})".format(c["name"])}
            return {"ok": False, "msg": "Failed: {}".format(out)}
    pg_bin = find_postgres_bin()
    if not pg_bin:
        return {"ok": False, "msg": "PostgreSQL not found"}
    psql = os.path.join(pg_bin, "psql.exe")
    env = os.environ.copy()
    env["PGPASSWORD"] = pg_super_password
    log("  > Checking if user '{}' exists...".format(db_user))
    try:
        result = subprocess.run(
            '"{}" -U postgres -p {} -tAc "SELECT 1 FROM pg_roles WHERE rolname=\'{}\'"'.format(
                psql, db_port, db_user),
            shell=True, capture_output=True, text=True, timeout=30, env=env)
        if "1" in result.stdout:
            return {"ok": True, "msg": "User already exists"}
    except Exception as e:
        log("    [ERROR] {}".format(e))
    log("  > Creating user '{}'...".format(db_user))
    try:
        result = subprocess.run(
            '"{}" -U postgres -p {} -c "CREATE ROLE {} WITH LOGIN PASSWORD \'{}\' CREATEDB;"'.format(
                psql, db_port, db_user, db_password),
            shell=True, capture_output=True, text=True, timeout=30, env=env)
        if result.returncode == 0:
            return {"ok": True, "msg": "User created"}
        return {"ok": False, "msg": "Failed: {}".format(result.stderr)}
    except Exception as e:
        return {"ok": False, "msg": "Failed: {}".format(e)}


def step_clone_odoo(base_dir):
    base = Path(base_dir)
    base.mkdir(parents=True, exist_ok=True)
    odoo_dir = base / "odoo"
    if (odoo_dir / "odoo-bin").exists():
        log("Odoo source already cloned.")
        return {"ok": True, "msg": "Already cloned"}
    log("Cloning Odoo 17.0 (shallow clone)...")
    code, out = run_cmd("git clone --branch {} --single-branch --depth 1 {}".format(
        ODOO_BRANCH, ODOO_GIT_URL), cwd=str(base))
    if (odoo_dir / "odoo-bin").exists():
        return {"ok": True, "msg": "Cloned"}
    return {"ok": False, "msg": "Clone failed"}


def step_create_venv(base_dir):
    base = Path(base_dir)
    venv_dir = base / "venv"
    python_path = find_python311()
    if not python_path:
        return {"ok": False, "msg": "Python 3.11 not found."}
    if (venv_dir / "Scripts" / "python.exe").exists():
        code, out = run_cmd('"{}" --version'.format(venv_dir / "Scripts" / "python.exe"))
        if "3.11" in out:
            return {"ok": True, "msg": "Already exists"}
        shutil.rmtree(str(venv_dir), ignore_errors=True)
    log("Creating virtual environment...")
    run_cmd('"{}" -m venv "{}"'.format(python_path, venv_dir))
    if (venv_dir / "Scripts" / "python.exe").exists():
        return {"ok": True, "msg": "Created"}
    return {"ok": False, "msg": "Failed to create venv"}


def step_install_requirements(base_dir):
    base = Path(base_dir)
    pip_exe = base / "venv" / "Scripts" / "pip.exe"
    req_file = base / "odoo" / "requirements.txt"
    if not pip_exe.exists():
        return {"ok": False, "msg": "Venv not found."}
    if not req_file.exists():
        return {"ok": False, "msg": "requirements.txt not found."}
    log("Installing dependencies...")
    code, out = run_cmd('"{}" install -r "{}"'.format(pip_exe, req_file))
    if code == 0 or "Successfully installed" in out:
        return {"ok": True, "msg": "Installed"}
    return {"ok": False, "msg": "Failed. Check logs."}


def step_create_project(base_dir, projects_dir, project_name, **kwargs):
    base = Path(base_dir)
    os.makedirs(projects_dir, exist_ok=True)
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
    # Build config values with defaults
    cfg = dict(PROJECT_DEFAULTS)
    cfg.update({k: v for k, v in kwargs.items() if v})
    # Keep relative addons_path (resolved by cwd when running Odoo)
    if not cfg["longpolling_port"]:
        try:
            cfg["longpolling_port"] = str(int(cfg["http_port"]) + 3)
        except ValueError:
            cfg["longpolling_port"] = "8072"
    # odoo.conf
    conf_template = (TEMPLATES_DIR / "odoo.conf").read_text(encoding="utf-8")
    (proj / "odoo.conf").write_text(conf_template.format(**cfg), encoding="utf-8")
    # launch.json
    venv_python = str(base / "venv" / "Scripts" / "python.exe").replace("\\", "\\\\")
    odoo_bin = str(base / "odoo" / "odoo-bin").replace("\\", "\\\\")
    launch_content = (TEMPLATES_DIR / "launch.json").read_text(encoding="utf-8")
    launch_content = launch_content.replace("{python_path}", venv_python)
    launch_content = launch_content.replace("{odoo_bin_path}", odoo_bin)
    (proj / ".vscode" / "launch.json").write_text(launch_content, encoding="utf-8")
    log("Project '{}' ready at {}".format(project_name, proj))
    return {"ok": True, "msg": str(proj)}


def step_full_install(base_dir, projects_dir, project_name, **kwargs):
    os.makedirs(base_dir, exist_ok=True)
    os.makedirs(projects_dir, exist_ok=True)
    db_port = kwargs.get("db_port", "5432")
    db_user = kwargs.get("db_user", "odoo")
    db_password = kwargs.get("db_password", "odoo")
    pg_super_password = kwargs.get("pg_super_password", "postgres")
    steps = [
        ("Installing Python 3.11...", lambda: step_install_python(base_dir)),
        ("Installing PostgreSQL...", lambda: step_install_postgres(
            base_dir, pg_super_password, db_port, db_user, db_password)),
        ("Creating DB user...", lambda: step_create_pg_user(db_user, db_password, db_port, pg_super_password)),
        ("Cloning Odoo 17...", lambda: step_clone_odoo(base_dir)),
        ("Creating virtual environment...", lambda: step_create_venv(base_dir)),
        ("Installing requirements...", lambda: step_install_requirements(base_dir)),
        ("Creating project...", lambda: step_create_project(
            base_dir, projects_dir, project_name, **kwargs)),
    ]
    results = []
    for i, (label, fn) in enumerate(steps):
        current_task["step"] = label
        current_task["progress"] = int((i / len(steps)) * 100)
        current_task["status"] = "running"
        log("\n" + "=" * 50)
        log("Step {}/{}: {}".format(i + 1, len(steps), label))
        result = fn()
        results.append({"step": label, "ok": result["ok"], "msg": result["msg"]})
        if not result["ok"]:
            log("[WARN] {} - continuing...".format(result["msg"]))
    current_task["status"] = "done"
    current_task["progress"] = 100
    current_task["step"] = "Complete!"
    return results


# ---------------------------------------------------------------------------
# Project management
# ---------------------------------------------------------------------------
def read_project_config(projects_dir, project_name):
    conf = os.path.join(projects_dir, project_name, "odoo.conf")
    if not os.path.isfile(conf):
        return {"ok": False, "msg": "Config not found"}
    return {"ok": True, "content": open(conf, "r", encoding="utf-8").read()}


def save_project_config(projects_dir, project_name, content):
    conf = os.path.join(projects_dir, project_name, "odoo.conf")
    if not os.path.isfile(conf):
        return {"ok": False, "msg": "Config not found"}
    try:
        cp = configparser.RawConfigParser()
        cp.read_string(content)
    except Exception as e:
        return {"ok": False, "msg": "Invalid config: {}".format(e)}
    with open(conf, "w", encoding="utf-8") as f:
        f.write(content)
    return {"ok": True, "msg": "Saved"}


def delete_project(projects_dir, project_name):
    proj = os.path.join(projects_dir, project_name)
    if not os.path.isdir(proj) or not os.path.isfile(os.path.join(proj, "odoo.conf")):
        return {"ok": False, "msg": "Project not found"}
    try:
        shutil.rmtree(proj)
        return {"ok": True, "msg": "Deleted"}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


def duplicate_project(base_dir, projects_dir, project_name, new_name, new_http_port):
    src = os.path.join(projects_dir, project_name)
    dst = os.path.join(projects_dir, new_name)
    if not os.path.isdir(src):
        return {"ok": False, "msg": "Source project not found"}
    if os.path.exists(dst):
        return {"ok": False, "msg": "Project '{}' already exists".format(new_name)}
    try:
        # Copy all files except the junction
        os.makedirs(dst, exist_ok=True)
        for item in os.listdir(src):
            s = os.path.join(src, item)
            d = os.path.join(dst, item)
            if item == "odoo" and os.path.isdir(s):
                # Recreate junction
                run_cmd('cmd /c mklink /J "{}" "{}"'.format(d, os.path.join(base_dir, "odoo")))
            elif os.path.isdir(s):
                shutil.copytree(s, d)
            else:
                shutil.copy2(s, d)
        # Update ports in config
        conf = os.path.join(dst, "odoo.conf")
        if os.path.isfile(conf):
            content = open(conf, "r", encoding="utf-8").read()
            cp = configparser.RawConfigParser()
            cp.read_string(content)
            if cp.has_section("options"):
                old_port = cp.get("options", "http_port") if cp.has_option("options", "http_port") else ""
                cp.set("options", "http_port", str(new_http_port))
                try:
                    new_lp = str(int(new_http_port) + 3)
                    cp.set("options", "longpolling_port", new_lp)
                except ValueError:
                    pass
            with open(conf, "w", encoding="utf-8") as f:
                cp.write(f)
        return {"ok": True, "msg": str(dst)}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


# ---------------------------------------------------------------------------
# HTML UI
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
.topbar{background:#333;height:46px;display:flex;align-items:center;padding:0 24px;position:sticky;top:0;z-index:100;border-bottom:1px solid #444}
.topbar .brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:1rem;color:#f50}
.topbar .brand svg{width:28px;height:28px}
.main{display:flex;max-width:1600px;margin:0 auto;min-height:calc(100vh - 46px)}
.sidebar{width:220px;background:#1a1a1a;border-right:1px solid #282828;padding:20px 0;flex-shrink:0}
.sidebar .menu-item{display:flex;align-items:center;gap:10px;padding:10px 20px;color:#999;font-size:0.9rem;cursor:pointer;transition:all 0.15s;border-left:3px solid transparent}
.sidebar .menu-item:hover{color:#fff;background:#222}
.sidebar .menu-item.active{color:#f50;border-left-color:#f50;background:#1f1a17}
.sidebar .menu-item svg{width:18px;height:18px;flex-shrink:0}
.sidebar .menu-label{padding:20px 20px 8px;font-size:0.7rem;text-transform:uppercase;letter-spacing:1px;color:#666}
.content{flex:1;padding:28px 32px;overflow-y:auto}
.content h2{font-size:1.3rem;color:#fff;margin-bottom:4px}
.content .desc{color:#888;font-size:0.85rem;margin-bottom:24px}
.panel{display:none}.panel.active{display:block}
.status-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-bottom:24px}
.status-card{background:#1a1a1a;border:1px solid #282828;border-radius:6px;padding:16px;display:flex;align-items:center;gap:12px;transition:border 0.2s}
.status-card:hover{border-color:#444}
.status-icon{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:1.1rem;flex-shrink:0}
.status-icon.ok{background:#1a3a1a;color:#22c55e}
.status-icon.missing{background:#3a1a1a;color:#ef4444}
.status-info .label{font-size:0.85rem;color:#fff;font-weight:600}
.status-info .detail{font-size:0.7rem;color:#666;margin-top:2px;word-break:break-all}
.form-section{background:#1a1a1a;border:1px solid #282828;border-radius:6px;padding:20px;margin-bottom:16px}
.form-section h3{font-size:0.95rem;color:#fff;margin-bottom:14px;cursor:pointer;display:flex;align-items:center;gap:8px}
.form-section h3 .arrow{transition:transform 0.2s;font-size:0.7rem}
.form-section h3 .arrow.open{transform:rotate(90deg)}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.form-grid-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
.form-group{display:flex;flex-direction:column;gap:4px}
.form-group.full{grid-column:1/-1}
.form-group label{font-size:0.75rem;color:#888;text-transform:uppercase;letter-spacing:0.5px}
.form-group input,.form-group select{padding:9px 12px;border-radius:4px;border:1px solid #333;background:#222;color:#eee;font-size:0.9rem;outline:none;transition:border 0.2s}
.form-group input:focus,.form-group select:focus{border-color:#f50}
.btn{padding:10px 20px;border-radius:4px;border:none;font-size:0.9rem;font-weight:600;cursor:pointer;transition:all 0.15s;display:inline-flex;align-items:center;gap:6px}
.btn-primary{background:#f50;color:#fff}.btn-primary:hover{background:#e04500}.btn-primary:disabled{opacity:0.4;cursor:not-allowed}
.btn-outline{background:transparent;border:1px solid #444;color:#999}.btn-outline:hover{border-color:#f50;color:#fff}
.btn-success{background:#22c55e;color:#fff}.btn-success:hover{background:#16a34a}
.btn-danger{background:#ef4444;color:#fff}.btn-danger:hover{background:#dc2626}
.btn-sm{padding:6px 12px;font-size:0.8rem}
.btn-xs{padding:4px 8px;font-size:0.75rem}
.btn-block{width:100%;justify-content:center;margin-top:8px}
.btn-row{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
.progress-wrap{margin-top:16px;display:none}.progress-wrap.visible{display:block}
.progress-bar{height:4px;background:#282828;border-radius:2px;overflow:hidden}
.progress-fill{height:100%;background:linear-gradient(90deg,#f50,#ff8c00);transition:width 0.5s;width:0%}
.progress-info{display:flex;justify-content:space-between;margin-top:6px;font-size:0.75rem;color:#666}
.log-box{background:#0a0a0a;border:1px solid #1e1e1e;border-radius:4px;padding:10px;max-height:280px;overflow-y:auto;font-family:'Cascadia Code',Consolas,monospace;font-size:0.78rem;line-height:1.7;color:#555;margin-top:12px}
.log-box .line:last-child{color:#ccc}
/* Project cards */
.project-card{background:#1a1a1a;border:1px solid #282828;border-radius:6px;padding:18px;margin-bottom:12px;transition:border 0.2s}
.project-card:hover{border-color:#f50}
.project-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.project-header .name{font-weight:700;color:#fff;font-size:1.05rem}
.project-detail-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px;margin-bottom:12px}
.detail-item{padding:8px 10px;background:#0f0f0f;border-radius:4px}
.detail-label{font-size:0.7rem;color:#666;text-transform:uppercase;letter-spacing:0.5px}
.detail-value{font-size:0.85rem;color:#eee;margin-top:2px;font-family:'Cascadia Code',Consolas,monospace}
.project-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;padding-top:10px;border-top:1px solid #282828}
.cmd-box{background:#0a0a0a;border:1px solid #1e1e1e;border-radius:4px;padding:8px 12px;font-family:'Cascadia Code',Consolas,monospace;font-size:0.78rem;color:#888;margin-top:8px;cursor:pointer;display:flex;justify-content:space-between;align-items:center}
.cmd-box:hover{color:#ccc;border-color:#444}
.cmd-box .copy-hint{font-size:0.65rem;color:#555}
.tag{display:inline-block;padding:3px 10px;border-radius:3px;font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:0.5px}
.tag-ready{background:#1a3a1a;color:#22c55e}
.tag-port{background:#1a2a3a;color:#60a5fa;margin-left:6px}
/* Modal */
.modal-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:200;display:none;align-items:center;justify-content:center}
.modal-overlay.visible{display:flex}
.modal{background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:24px;width:90%;max-width:700px;max-height:80vh;overflow-y:auto}
.modal h3{color:#fff;margin-bottom:16px;font-size:1.1rem}
.modal textarea{width:100%;min-height:400px;background:#0a0a0a;border:1px solid #282828;border-radius:4px;padding:12px;font-family:'Cascadia Code',Consolas,monospace;font-size:0.82rem;color:#ccc;resize:vertical;outline:none}
.modal textarea:focus{border-color:#f50}
.modal .btn-row{justify-content:flex-end}
.modal input{padding:9px 12px;border-radius:4px;border:1px solid #333;background:#222;color:#eee;font-size:0.9rem;outline:none;width:100%;margin-bottom:8px}
.empty{text-align:center;padding:40px 20px;color:#555}
/* Native PG */
.pg-detail{background:#1a1a1a;border:1px solid #282828;border-radius:6px;padding:16px;margin-bottom:16px}
.pg-detail h4{color:#fff;font-size:0.9rem;margin-bottom:10px}
.pg-databases{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.pg-databases .db-tag{background:#1a2a3a;color:#60a5fa;padding:3px 8px;border-radius:3px;font-size:0.75rem}
.collapsible{display:none}.collapsible.show{display:block}
@media(max-width:768px){.sidebar{display:none}.form-grid,.form-grid-3{grid-template-columns:1fr}.status-grid{grid-template-columns:1fr}.project-detail-grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="topbar">
  <div class="brand">
    <svg viewBox="0 0 24 24" fill="none" stroke="#f50" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
    Odoo 17 Installer
  </div>
</div>
<div class="main">
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
  <div class="content">

    <!-- STATUS -->
    <div class="panel active" id="panel-status">
      <h2>System Status</h2>
      <p class="desc">Current state of your development environment</p>
      <div class="status-grid" id="statusGrid"></div>
      <div id="nativePgDetail"></div>
      <button class="btn btn-outline btn-sm" onclick="refreshStatus()">Refresh</button>
    </div>

    <!-- INSTALL -->
    <div class="panel" id="panel-install">
      <h2>Full Install</h2>
      <p class="desc">Install everything in one click</p>
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
          <div class="form-group"><label>DB Host</label><input id="dbHost" value="localhost"></div>
          <div class="form-group"><label>DB Port</label><input id="dbPort" value="5432" type="number"></div>
          <div class="form-group"><label>DB User</label><input id="dbUser" value="odoo"></div>
          <div class="form-group"><label>DB Password</label><input id="dbPassword" value="odoo"></div>
          <div class="form-group"><label>PG Super Password</label><input id="pgSuperPassword" value="postgres"></div>
        </div>
      </div>
      <div class="form-section">
        <h3 onclick="toggleAdvanced('advInstall')"><span class="arrow" id="arrowAdvInstall">&#9654;</span> Advanced Odoo Config</h3>
        <div class="collapsible" id="advInstall">
          <div class="form-grid">
            <div class="form-group full"><label>Addons Path</label><input id="addonsPath" value="./addons,./odoo/addons"></div>
            <div class="form-group"><label>Admin Password</label><input id="adminPasswd" value="odoo"></div>
            <div class="form-group"><label>Longpolling Port</label><input id="longpollingPort" placeholder="auto = http_port + 3"></div>
            <div class="form-group"><label>Log Level</label><select id="logLevel"><option value="error" selected>error</option><option value="warn">warn</option><option value="info">info</option><option value="debug">debug</option></select></div>
            <div class="form-group"><label>Workers</label><input id="workers" value="0" type="number"></div>
            <div class="form-group"><label>List DB</label><select id="listDb"><option value="True" selected>True</option><option value="False">False</option></select></div>
            <div class="form-group"><label>DB Filter</label><input id="dbfilter" placeholder="e.g. ^mydb.*$"></div>
            <div class="form-group"><label>Proxy Mode</label><select id="proxyMode"><option value="True" selected>True</option><option value="False">False</option></select></div>
            <div class="form-group full"><label>Server Wide Modules</label><input id="serverWideModules" value="base,web"></div>
            <div class="form-group full"><label>Data Dir (filestore)</label><input id="dataDir" placeholder="Leave empty for Odoo default"></div>
            <div class="form-group"><label>Memory Hard Limit</label><input id="memHard" value="10737418240"></div>
            <div class="form-group"><label>Memory Soft Limit</label><input id="memSoft" value="10737418240"></div>
          </div>
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

    <!-- NEW PROJECT -->
    <div class="panel" id="panel-newproject">
      <h2>Create New Project</h2>
      <p class="desc">Add a new Odoo project with its own config and port</p>
      <div class="form-section">
        <div class="form-grid">
          <div class="form-group"><label>Project Name</label><input id="newProjName" placeholder="e.g. ecommerce"></div>
          <div class="form-group"><label>HTTP Port</label><input id="newProjPort" value="8070" type="number"></div>
          <div class="form-group"><label>DB Host</label><input id="newProjDbHost" value="localhost"></div>
          <div class="form-group"><label>DB Port</label><input id="newProjDbPort" value="5432" type="number"></div>
          <div class="form-group"><label>DB User</label><input id="newProjDbUser" value="odoo"></div>
          <div class="form-group"><label>DB Password</label><input id="newProjDbPass" value="odoo"></div>
        </div>
        <h3 onclick="toggleAdvanced('advNew')" style="margin-top:14px"><span class="arrow" id="arrowAdvNew">&#9654;</span> Advanced Config</h3>
        <div class="collapsible" id="advNew">
          <div class="form-grid" style="margin-top:10px">
            <div class="form-group"><label>Log Level</label><select id="newLogLevel"><option value="error" selected>error</option><option value="warn">warn</option><option value="info">info</option><option value="debug">debug</option></select></div>
            <div class="form-group"><label>Workers</label><input id="newWorkers" value="0" type="number"></div>
            <div class="form-group"><label>DB Filter</label><input id="newDbfilter" placeholder="e.g. ^mydb.*$"></div>
            <div class="form-group"><label>Proxy Mode</label><select id="newProxyMode"><option value="True" selected>True</option><option value="False">False</option></select></div>
          </div>
        </div>
        <button class="btn btn-primary btn-block" onclick="createProject()">Create Project</button>
      </div>
    </div>

    <!-- PROJECTS -->
    <div class="panel" id="panel-projects">
      <h2>My Projects</h2>
      <p class="desc">Manage your Odoo development projects</p>
      <div id="projectsList"></div>
    </div>

    <!-- LOG -->
    <div class="panel" id="panel-log">
      <h2>Installation Log</h2>
      <p class="desc">Real-time output from installation commands</p>
      <div class="log-box" id="log" style="max-height:500px"></div>
    </div>

  </div>
</div>

<!-- Modals -->
<div class="modal-overlay" id="modalConfig">
  <div class="modal">
    <h3>Edit odoo.conf - <span id="modalConfigName"></span></h3>
    <textarea id="modalConfigContent"></textarea>
    <div class="btn-row">
      <button class="btn btn-outline btn-sm" onclick="hideModal('modalConfig')">Cancel</button>
      <button class="btn btn-primary btn-sm" onclick="saveConfig()">Save</button>
    </div>
  </div>
</div>
<div class="modal-overlay" id="modalDelete">
  <div class="modal">
    <h3>Delete Project</h3>
    <p style="color:#ef4444;margin-bottom:12px">This will permanently delete the project folder.</p>
    <p style="margin-bottom:8px">Type <strong id="deleteTargetName" style="color:#fff"></strong> to confirm:</p>
    <input id="deleteConfirmInput" placeholder="Type project name">
    <div class="btn-row">
      <button class="btn btn-outline btn-sm" onclick="hideModal('modalDelete')">Cancel</button>
      <button class="btn btn-danger btn-sm" onclick="confirmDelete()">Delete</button>
    </div>
  </div>
</div>
<div class="modal-overlay" id="modalDuplicate">
  <div class="modal">
    <h3>Duplicate Project - <span id="dupSourceName"></span></h3>
    <div class="form-grid" style="margin-bottom:12px">
      <div class="form-group"><label>New Project Name</label><input id="dupNewName" placeholder="e.g. my_project_copy"></div>
      <div class="form-group"><label>New HTTP Port</label><input id="dupNewPort" value="8071" type="number"></div>
    </div>
    <div class="btn-row">
      <button class="btn btn-outline btn-sm" onclick="hideModal('modalDuplicate')">Cancel</button>
      <button class="btn btn-primary btn-sm" onclick="confirmDuplicate()">Duplicate</button>
    </div>
  </div>
</div>

<script>
const $=id=>document.getElementById(id);
let _status=null;

function showPanel(name,el){
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.menu-item').forEach(m=>m.classList.remove('active'));
  $('panel-'+name).classList.add('active');
  if(el)el.classList.add('active');
  if(name==='status'||name==='projects')refreshStatus();
  if(name==='log')pollLog();
}
function escHtml(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function toggleAdvanced(id){
  const el=$(id);el.classList.toggle('show');
  const arrow=$('arrow'+id.charAt(0).toUpperCase()+id.slice(1));
  if(arrow)arrow.classList.toggle('open');
}
function showModal(id){$(id).classList.add('visible')}
function hideModal(id){$(id).classList.remove('visible')}

async function api(endpoint,data={}){
  const res=await fetch('/api/'+endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  return res.json();
}

function getFormData(){
  return {
    base_dir:$('baseDir').value, projects_dir:$('projectsDir').value,
    project_name:$('projectName').value, http_port:$('httpPort').value,
    db_host:$('dbHost').value, db_port:$('dbPort').value,
    db_user:$('dbUser').value, db_password:$('dbPassword').value,
    pg_super_password:$('pgSuperPassword').value,
    addons_path:$('addonsPath').value, admin_passwd:$('adminPasswd').value,
    longpolling_port:$('longpollingPort').value, log_level:$('logLevel').value,
    workers:$('workers').value, list_db:$('listDb').value,
    dbfilter:$('dbfilter').value, proxy_mode:$('proxyMode').value,
    server_wide_modules:$('serverWideModules').value,
    data_dir:$('dataDir').value,
    limit_memory_hard:$('memHard').value, limit_memory_soft:$('memSoft').value,
  };
}

async function refreshStatus(){
  const data=getFormData();
  const s=await api('status',data);
  _status=s;
  // Status grid
  const items=[
    ['Python 3.11',s.python311,s.python311_path],
    ['PostgreSQL',s.postgres,s.postgres_path],
    ['Docker',s.docker,s.docker?'Available':'Not found'],
    ['Odoo Source',s.odoo_cloned,''],
    ['Virtual Env',s.venv_created,''],
    ['Requirements',s.requirements_installed,''],
  ];
  $('statusGrid').innerHTML=items.map(([label,ok,detail])=>`
    <div class="status-card">
      <div class="status-icon ${ok?'ok':'missing'}">${ok?'\u2713':'\u2717'}</div>
      <div class="status-info"><div class="label">${label}</div>
      ${detail?`<div class="detail">${escHtml(detail)}</div>`:''}</div>
    </div>`).join('');
  if(s.docker_postgres&&s.docker_postgres.length>0){
    $('statusGrid').innerHTML+=s.docker_postgres.map(c=>`
      <div class="status-card" style="border-color:#1a3a1a">
        <div class="status-icon ok">PG</div>
        <div class="status-info"><div class="label">${escHtml(c.name)}</div>
        <div class="detail">${escHtml(c.image)} | port:${escHtml(c.port)} | ${escHtml(c.status)}</div></div>
      </div>`).join('');
  }
  // Native PG detail
  const np=s.native_postgres;
  if(np){
    $('nativePgDetail').innerHTML=`<div class="pg-detail">
      <h4>Native PostgreSQL</h4>
      <div class="project-detail-grid">
        <div class="detail-item"><div class="detail-label">Status</div><div class="detail-value">${np.is_ready?'<span style="color:#22c55e">Running</span>':'<span style="color:#ef4444">Stopped</span>'}</div></div>
        <div class="detail-item"><div class="detail-label">Port</div><div class="detail-value">${escHtml(np.port||'N/A')}</div></div>
        <div class="detail-item"><div class="detail-label">Data Dir</div><div class="detail-value">${escHtml(np.data_dir||'N/A')}</div></div>
        <div class="detail-item"><div class="detail-label">Bin Path</div><div class="detail-value">${escHtml(np.bin_path||'N/A')}</div></div>
      </div>
      ${np.databases&&np.databases.length?`<div><span class="detail-label">Databases:</span><div class="pg-databases">${np.databases.map(d=>`<span class="db-tag">${escHtml(d)}</span>`).join('')}</div></div>`:''}
    </div>`;
  } else {
    $('nativePgDetail').innerHTML='';
  }
  // Projects list
  renderProjects(s);
  // Auto-update port fields for new project
  const nextPort=getNextAvailablePort();
  if($('newProjPort'))$('newProjPort').value=nextPort;
}

function renderProjects(s){
  const list=$('projectsList');
  if(!s.projects||s.projects.length===0){
    list.innerHTML='<div class="empty"><p>No projects yet. Create one to get started.</p></div>';
    return;
  }
  list.innerHTML=s.projects.map(p=>{
    const details=[
      ['HTTP Port',p.http_port],['Longpolling',p.longpolling_port],['DB',`${p.db_host||'localhost'}:${p.db_port}`],
      ['DB User',p.db_user],['Workers',p.workers],['Log Level',p.log_level],
      ['Custom Modules',p.custom_modules],['List DB',p.list_db],
    ].filter(([,v])=>v!==''&&v!==undefined&&v!==null);
    return `<div class="project-card">
      <div class="project-header">
        <div><span class="name">${escHtml(p.name)}</span>
          <span class="tag tag-port">:${escHtml(p.http_port)}</span>
          <span class="tag tag-ready">ready</span></div>
        <div style="font-size:0.75rem;color:#666">${escHtml(p.path)}</div>
      </div>
      <div class="project-detail-grid">
        ${details.map(([l,v])=>`<div class="detail-item"><div class="detail-label">${l}</div><div class="detail-value">${escHtml(v)}</div></div>`).join('')}
        ${p.addon_dirs&&p.addon_dirs.length?p.addon_dirs.map(a=>`<div class="detail-item"><div class="detail-label">${a.is_base?'Base Addons':'Custom Addons'}</div><div class="detail-value">${escHtml(a.path)} (${a.count} modules)</div></div>`).join(''):''}
        ${p.data_dir?`<div class="detail-item"><div class="detail-label">Data Dir</div><div class="detail-value">${escHtml(p.data_dir)}</div></div>`:''}
      </div>
      <div class="cmd-box" onclick="copyCmd(this)" title="Click to copy">
        <span>${escHtml(p.start_command)}</span>
        <span class="copy-hint">click to copy</span>
      </div>
      <div class="project-actions">
        <button class="btn btn-success btn-xs" onclick="startOdoo('${escHtml(p.name)}')">Start Odoo</button>
        <button class="btn btn-outline btn-xs" onclick="openVSCode('${escHtml(p.path)}')">VS Code</button>
        <button class="btn btn-outline btn-xs" onclick="openExplorer('${escHtml(p.path)}')">Explorer</button>
        <button class="btn btn-outline btn-xs" onclick="editConfig('${escHtml(p.name)}')">Edit Config</button>
        <button class="btn btn-outline btn-xs" onclick="duplicateProject('${escHtml(p.name)}','${escHtml(p.http_port)}')">Duplicate</button>
        <button class="btn btn-danger btn-xs" onclick="deleteProject('${escHtml(p.name)}')">Delete</button>
      </div>
    </div>`;
  }).join('');
}

function getNextAvailablePort(){
  if(!_status||!_status.projects||_status.projects.length===0) return 8069;
  const usedSet=new Set();
  _status.projects.forEach(p=>{
    const hp=parseInt(p.http_port)||0;
    const lp=parseInt(p.longpolling_port)||0;
    if(hp>0) usedSet.add(hp);
    if(lp>0) usedSet.add(lp);
  });
  if(usedSet.size===0) return 8069;
  let port=Math.min(...usedSet);
  while(usedSet.has(port)||usedSet.has(port+3)){port++}
  return port;
}

function copyCmd(el){
  const text=el.querySelector('span').textContent;
  navigator.clipboard.writeText(text).then(()=>{
    const hint=el.querySelector('.copy-hint');
    hint.textContent='copied!';setTimeout(()=>hint.textContent='click to copy',1500);
  });
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
function startLogPoll(){$('progressWrap').classList.add('visible');if(!logPoll)logPoll=setInterval(pollLog,1000)}
function stopLogPoll(){if(logPoll){clearInterval(logPoll);logPoll=null}pollLog()}

async function fullInstall(){
  const btn=$('btnFullInstall');btn.disabled=true;btn.textContent='Installing...';
  $('results').innerHTML='';startLogPoll();
  const res=await api('full_install',getFormData());
  btn.disabled=false;btn.textContent='Install Everything';stopLogPoll();
  $('progressFill').style.width='100%';$('progressStep').textContent='Done!';$('progressPct').textContent='100%';
  if(res.results){$('results').innerHTML=res.results.map(r=>`
    <div class="result-item" style="display:flex;align-items:center;gap:8px;padding:8px 0;font-size:0.9rem;border-bottom:1px solid #1e1e1e">
      <span style="font-size:1.1rem">${r.ok?'\u2705':'\u274C'}</span><span>${escHtml(r.step)}</span>
      <span style="color:#666;font-size:0.8rem;margin-left:auto">${escHtml(r.msg)}</span>
    </div>`).join('')}
  refreshStatus();
}

async function runStep(step){startLogPoll();const res=await api('run_step',{...getFormData(),step});stopLogPoll();refreshStatus();alert(res.ok?'\u2705 '+res.msg:'\u274C '+res.msg)}

async function createProject(){
  const name=$('newProjName').value.trim();if(!name){alert('Enter a project name');return}
  startLogPoll();
  const data=getFormData();
  data.project_name=name;data.http_port=$('newProjPort').value;
  data.db_host=$('newProjDbHost').value;data.db_port=$('newProjDbPort').value;
  data.db_user=$('newProjDbUser').value;data.db_password=$('newProjDbPass').value;
  data.log_level=$('newLogLevel').value;data.workers=$('newWorkers').value;
  data.dbfilter=$('newDbfilter').value;data.proxy_mode=$('newProxyMode').value;
  const res=await api('create_project',data);stopLogPoll();refreshStatus();
  alert(res.ok?'\u2705 Project created!\n'+res.msg:'\u274C '+res.msg);
}

// Project actions
async function startOdoo(name){
  const data=getFormData();data.project_name=name;
  const res=await api('start_odoo',data);
  if(res.ok)alert('\u2705 Odoo started!\nCommand: '+res.command);
  else alert('\u274C '+res.msg);
}
async function openVSCode(path){await api('open_vscode',{path})}
async function openExplorer(path){await api('open_explorer',{path})}

let _editingProject='';
async function editConfig(name){
  _editingProject=name;
  const data=getFormData();
  const res=await api('read_config',{projects_dir:data.projects_dir,project_name:name});
  if(!res.ok){alert('\u274C '+res.msg);return}
  $('modalConfigName').textContent=name;
  $('modalConfigContent').value=res.content;
  showModal('modalConfig');
}
async function saveConfig(){
  const data=getFormData();
  const res=await api('save_config',{projects_dir:data.projects_dir,project_name:_editingProject,content:$('modalConfigContent').value});
  hideModal('modalConfig');refreshStatus();
  alert(res.ok?'\u2705 Saved!':'\u274C '+res.msg);
}

let _deletingProject='';
function deleteProject(name){_deletingProject=name;$('deleteTargetName').textContent=name;$('deleteConfirmInput').value='';showModal('modalDelete')}
async function confirmDelete(){
  if($('deleteConfirmInput').value!==_deletingProject){alert('Name does not match!');return}
  const data=getFormData();
  const res=await api('delete_project',{projects_dir:data.projects_dir,project_name:_deletingProject});
  hideModal('modalDelete');refreshStatus();
  alert(res.ok?'\u2705 Deleted!':'\u274C '+res.msg);
}

let _dupSource='';
function duplicateProject(name,port){
  _dupSource=name;$('dupSourceName').textContent=name;
  $('dupNewName').value=name+'_copy';$('dupNewPort').value=getNextAvailablePort();
  showModal('modalDuplicate');
}
async function confirmDuplicate(){
  const data=getFormData();
  const res=await api('duplicate_project',{
    base_dir:data.base_dir,projects_dir:data.projects_dir,
    project_name:_dupSource,new_name:$('dupNewName').value,new_http_port:$('dupNewPort').value
  });
  hideModal('modalDuplicate');refreshStatus();
  alert(res.ok?'\u2705 Duplicated!\n'+res.msg:'\u274C '+res.msg);
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
        bd = body.get("base_dir", DEFAULT_BASE_DIR)
        pd = body.get("projects_dir", DEFAULT_PROJECTS_DIR)

        if path == "/api/status":
            self._json(detect_status(bd, pd))

        elif path == "/api/log":
            self._json({"lines": log_lines[-200:], "task": current_task})

        elif path == "/api/full_install":
            if current_task["status"] == "running":
                self._json({"ok": False, "msg": "Install already in progress"})
                return
            install_opts = {k: v for k, v in body.items()
                           if k not in ("base_dir", "projects_dir", "project_name")}
            project_name = body.get("project_name", "my_project")

            def _run_install():
                try:
                    results = step_full_install(bd, pd, project_name, **install_opts)
                    current_task["results"] = results
                except Exception as e:
                    current_task["status"] = "error"
                    current_task["step"] = str(e)
                    log("[ERROR] Full install failed: {}".format(e))

            threading.Thread(target=_run_install, daemon=True).start()
            self._json({"ok": True, "msg": "Install started in background. Poll /api/log for progress."})

        elif path == "/api/run_step":
            step = body.get("step", "")
            fns = {
                "install_python": lambda: step_install_python(bd),
                "install_postgres": lambda: step_install_postgres(
                    bd, body.get("pg_super_password", "postgres"),
                    body.get("db_port", "5432"), body.get("db_user", "odoo"),
                    body.get("db_password", "odoo")),
                "clone_odoo": lambda: step_clone_odoo(bd),
                "create_venv": lambda: step_create_venv(bd),
                "install_requirements": lambda: step_install_requirements(bd),
            }
            fn = fns.get(step)
            self._json(fn() if fn else {"ok": False, "msg": "Unknown step"})

        elif path == "/api/create_project":
            project_opts = {k: v for k, v in body.items()
                           if k not in ("base_dir", "projects_dir", "project_name")}
            self._json(step_create_project(bd, pd, body.get("project_name", ""), **project_opts))

        elif path == "/api/read_config":
            self._json(read_project_config(pd, body.get("project_name", "")))

        elif path == "/api/save_config":
            self._json(save_project_config(pd, body.get("project_name", ""), body.get("content", "")))

        elif path == "/api/delete_project":
            self._json(delete_project(pd, body.get("project_name", "")))

        elif path == "/api/duplicate_project":
            self._json(duplicate_project(
                bd, pd, body.get("project_name", ""),
                body.get("new_name", ""), body.get("new_http_port", "8070")))

        elif path == "/api/open_vscode":
            try:
                subprocess.Popen(["code", body.get("path", "")], shell=True)
                self._json({"ok": True})
            except Exception as e:
                self._json({"ok": False, "msg": str(e)})

        elif path == "/api/open_explorer":
            try:
                subprocess.Popen(["explorer", body.get("path", "")], shell=True)
                self._json({"ok": True})
            except Exception as e:
                self._json({"ok": False, "msg": str(e)})

        elif path == "/api/start_odoo":
            pname = body.get("project_name", "")
            proj_path = os.path.join(pd, pname)
            conf = os.path.join(proj_path, "odoo.conf")
            venv_py = os.path.join(bd, "venv", "Scripts", "python.exe")
            odoo_bin = os.path.join(bd, "odoo", "odoo-bin")
            cmd = '"{}" "{}" -c "{}"'.format(venv_py, odoo_bin, conf)
            try:
                subprocess.Popen(cmd, shell=True, cwd=proj_path,
                                 creationflags=subprocess.CREATE_NEW_CONSOLE)
                self._json({"ok": True, "command": cmd})
            except Exception as e:
                self._json({"ok": False, "msg": str(e)})

        else:
            self._json({"error": "Not found"}, 404)


def main():
    class ThreadedServer(http.server.ThreadingHTTPServer):
        daemon_threads = True
    server = ThreadedServer((HOST, PORT), InstallerHandler)
    url = "http://{}:{}".format(HOST, PORT)
    print("\n" + "=" * 50)
    print("  Odoo 17 Installer: {}".format(url))
    print("  Press Ctrl+C to stop")
    print("=" * 50 + "\n")
    threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        server.shutdown()


if __name__ == "__main__":
    main()
