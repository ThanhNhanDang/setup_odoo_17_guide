# Odoo 17 Development Environment Installer

Web-based one-click installer for Odoo 17 development on Windows.

![Python](https://img.shields.io/badge/Python-3.11-blue)
![Odoo](https://img.shields.io/badge/Odoo-17.0-purple)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-blue)
![Platform](https://img.shields.io/badge/Platform-Windows-lightgrey)

## Quick Start

```cmd
git clone https://github.com/ThanhNhanDang/setup_odoo_17_guide.git
cd setup_odoo_17_guide
start.bat
```

Browser opens at `http://localhost:9017` - click **Install Everything** and done.

> **Note:** Run `start.bat` as **Administrator** for PostgreSQL install and symlinks.

## What it installs

| Component | Description |
|-----------|-------------|
| Python 3.11.4 | Required runtime for Odoo 17 |
| PostgreSQL 16 | Database server + creates `odoo` user |
| Odoo 17.0 | Source code (shallow clone from GitHub) |
| Virtual Environment | Isolated Python packages |
| pip requirements | All Odoo dependencies |
| Project folder | Config + VS Code debug + symlink |

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
1. Open installer (`start.bat`)
2. Go to **New Project**
3. Enter name + port
4. Click **Create Project**

### Run Odoo
1. Open project folder in VS Code
2. Press **F5**
3. Open `http://localhost:<port>`

## Features

- Zero external dependencies (Python stdlib only)
- SoundCloud-inspired dark UI
- Real-time installation log
- Individual step buttons for partial installs
- Auto-detects already installed components
- Multiple projects with different ports

## Requirements

- Windows 10/11
- Git
- Internet connection
- Administrator rights (for PostgreSQL + symlinks)
