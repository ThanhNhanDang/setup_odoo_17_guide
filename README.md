# Odoo 17 Development Environment Installer

One-click installer for Odoo 17 development on Windows. Available as **Electron desktop app** (recommended) or Python web UI.

![Python](https://img.shields.io/badge/Python-3.11-blue)
![Odoo](https://img.shields.io/badge/Odoo-17.0-purple)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-blue)
![Electron](https://img.shields.io/badge/Electron-33-47848F)
![Platform](https://img.shields.io/badge/Platform-Windows-lightgrey)

## Quick Start

### Option 1: Desktop App (recommended)

Download **Odoo17Installer.exe** from [Releases](https://github.com/ThanhNhanDang/setup_odoo_17_guide/releases/latest) and run it. No Python or Node.js required.

### Option 2: Python Web UI

```cmd
git clone https://github.com/ThanhNhanDang/setup_odoo_17_guide.git
cd setup_odoo_17_guide
start.bat
```

Browser opens at `http://localhost:9017` - click **Install Everything** and done.

> **Note:** Run as **Administrator** for PostgreSQL install and junction symlinks.

## What it installs

| Component | Description |
|-----------|-------------|
| Python 3.11.4 | Required runtime for Odoo 17 |
| PostgreSQL 16 | Database server + creates `odoo` user |
| Odoo 17.0 | Source code (shallow clone from GitHub) |
| Virtual Environment | Isolated Python packages |
| pip requirements | All Odoo dependencies |
| Project folder | Config + VS Code debug + symlink |

## Features

- **Dashboard** with kanban project cards, search & filter
- **Auto-update** - notifies when new version is available
- **Docker PostgreSQL** support (auto-detect or create containers)
- Real-time installation log with progress tracking
- Multiple projects with independent ports and configs
- Start Odoo, open VS Code, open Explorer from the app
- Edit `odoo.conf` directly, duplicate/delete projects
- Frameless dark UI (GitHub Dark theme)

## Project Structure

```
D:\workspaces\
├── odoo_17_base\              # Shared (install once)
│   ├── odoo\                  # Odoo 17 source
│   └── venv\                  # Python 3.11 venv
│
└── projects\odoo17\
    ├── project_a\             # Each project is independent
    │   ├── odoo -> junction   # Link to odoo_17_base\odoo
    │   ├── addons\            # Your custom modules
    │   ├── odoo.conf          # Project config (unique port)
    │   └── .vscode\
    │       └── launch.json    # F5 to debug
    └── project_b\
        └── ...
```

## How to use

### Add a new project
1. Open the app
2. Go to **New Project** tab
3. Enter name + port
4. Click **Create Project**

### Run Odoo
- Click **Start** on any project card in the Dashboard, or
- Open project folder in VS Code and press **F5**
- Open `http://localhost:<port>`

## Electron App Development

```cmd
cd electron-app

# Development (with DevTools)
npm run dev

# Build portable exe
npm run pack

# Build NSIS installer + publish to GitHub Releases
set GH_TOKEN=your_github_token
publish.bat patch    # 1.0.0 -> 1.0.1
publish.bat minor    # 1.0.0 -> 1.1.0
publish.bat major    # 1.0.0 -> 2.0.0
```

### Architecture

```
electron-app/
├── src/main/            # Node.js backend (IPC handlers, services)
│   ├── services/        # detection, installer, projects, logger, updater
│   └── utils/           # shell, download
├── src/preload/         # Secure IPC bridge (contextBridge)
└── src/renderer/        # Frontend (HTML, CSS, vanilla JS)
```

See [SKILL_ELECTRON_APP.md](SKILL_ELECTRON_APP.md) for the full Electron development guide.

## Requirements

- Windows 10/11
- Git
- Internet connection
- Administrator rights (for PostgreSQL + junction symlinks)
