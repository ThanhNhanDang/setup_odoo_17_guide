# Electron Migration Plan

## Muc tieu

Chuyen doi ung dung web Python (`setup.py`) sang Electron desktop app de:
- Khong phu thuoc Python 3.11.4 duoc cai san tren may
- Dong goi thanh file `.exe` installer duy nhat
- Giu nguyen giao dien web (SoundCloud-inspired dark UI)
- Cai dat cac goi can thiet (Python, PostgreSQL, Odoo) voi giao dien theo doi tien trinh

---

## 1. Kien truc hien tai vs Electron

### Hien tai (Python)
```
start.bat → Tim/Tai Python → Tao .venv → Chay setup.py → HTTP Server :9017 → Browser
```
- setup.py: 1293 dong, monolith
- Zero dependencies (chi stdlib)
- Can Python de chay installer

### Electron (moi)
```
OdooInstaller.exe → Electron Main Process → BrowserWindow (UI)
                       ↕ IPC
                   Node.js Services (detection, install, project mgmt)
```
- Node.js runtime dong goi san
- Khong can Python, khong can browser
- File .exe installer duy nhat

---

## 2. Cau truc du an Electron

```
electron-odoo-installer/
├── package.json
├── electron-builder.yml           # NSIS packaging config
├── tsconfig.json
├── src/
│   ├── main/                      # Main process (Node.js backend)
│   │   ├── index.ts               # App entry, BrowserWindow, IPC setup
│   │   ├── ipc-handlers.ts        # IPC channel registration (thay HTTP API)
│   │   ├── services/
│   │   │   ├── config.ts          # Constants, PROJECT_DEFAULTS
│   │   │   ├── logger.ts          # Log management + IPC push events
│   │   │   ├── shell.ts           # run_cmd() wrapper (child_process)
│   │   │   ├── detection.ts       # find_python311, find_postgres, find_docker
│   │   │   ├── status.ts          # detect_status aggregation
│   │   │   ├── installer.ts       # step_install_python/postgres/clone/venv/pip
│   │   │   ├── projects.ts        # create/delete/duplicate/parse_config
│   │   │   ├── launcher.ts        # start_odoo, open_vscode, open_explorer
│   │   │   └── ini-parser.ts      # odoo.conf read/write (thay configparser)
│   │   └── utils/
│   │       └── elevation.ts       # UAC admin elevation
│   ├── preload/
│   │   └── index.ts               # contextBridge (secure IPC bridge)
│   └── renderer/                  # Frontend (tach tu HTML_PAGE)
│       ├── index.html             # HTML structure
│       ├── styles.css             # CSS (~90 dong)
│       └── app.js                 # JS logic (~230 dong), fetch → IPC
├── templates/
│   ├── odoo.conf                  # Giu nguyen
│   └── launch.json                # Giu nguyen
├── resources/
│   └── icon.ico                   # App icon
└── tests/
    ├── detection.test.ts
    ├── projects.test.ts
    ├── installer.test.ts
    ├── status.test.ts
    └── ini-parser.test.ts
```

---

## 3. Mapping Python → Node.js chi tiet

### 3.1 Config Constants (`services/config.ts`)

```typescript
// Python
DEFAULT_BASE_DIR = r"D:\workspaces\odoo_17_base"
PROJECT_DEFAULTS = {"addons_path": "./addons,./odoo/addons", ...}

// Node.js
export const DEFAULT_BASE_DIR = 'D:\\workspaces\\odoo_17_base';
export const PROJECT_DEFAULTS: Record<string, string> = {
  addons_path: './addons,./odoo/addons',
  // ...
};
```

### 3.2 Shell Helper (`services/shell.ts`)

```typescript
// Python: run_cmd(cmd, cwd=None) → (returncode, output)
// Node.js:
import { exec } from 'child_process';

export function runCmd(cmd: string, cwd?: string): Promise<{code: number, output: string}> {
  return new Promise((resolve) => {
    exec(cmd, { cwd, shell: 'cmd.exe', timeout: 1_800_000, encoding: 'utf8' },
      (error, stdout, stderr) => {
        resolve({
          code: error ? error.code ?? 1 : 0,
          output: stdout + stderr
        });
      });
  });
}
```

### 3.3 Detection Functions (`services/detection.ts`)

| Python | Node.js |
|---|---|
| `os.path.isfile(p)` | `fs.existsSync(p)` |
| `os.environ.get("LOCALAPPDATA")` | `process.env.LOCALAPPDATA` |
| `subprocess.run("docker --version")` | `execSync("docker --version")` |
| `subprocess.run('docker ps --format ...')` | `execSync('docker ps --format ...')` |
| `open(conf_file, "r").read()` | `fs.readFileSync(conf_file, 'utf8')` |

### 3.4 Installation Steps (`services/installer.ts`)

| Python | Node.js |
|---|---|
| `urllib.request.urlretrieve(url, path)` | `https.get()` + `fs.createWriteStream()` (co progress!) |
| `run_cmd('installer.exe /quiet ...')` | `runCmd('installer.exe /quiet ...')` |
| `run_cmd('git clone ...')` | `spawn('git', ['clone', ...])` (stream output) |
| `shutil.rmtree(path)` | `fs.rmSync(path, {recursive: true})` |
| `os.makedirs(path, exist_ok=True)` | `fs.mkdirSync(path, {recursive: true})` |
| `shutil.copytree(s, d)` | `fs.cpSync(s, d, {recursive: true})` |
| `run_cmd('cmd /c mklink /J ...')` | `runCmd('cmd /c mklink /J ...')` |

### 3.5 INI Parser (`services/ini-parser.ts`)

```typescript
// Dung package 'ini' (2KB, 3.5M downloads/week)
import ini from 'ini';

// Python: configparser.RawConfigParser().read(file)
const config = ini.parse(fs.readFileSync(file, 'utf8'));

// Python: cp.get("options", "http_port")
const port = config.options?.http_port;

// Python: cp.set("options", "http_port", "8069")
config.options.http_port = '8069';
fs.writeFileSync(file, ini.stringify(config));
```

### 3.6 IPC thay the HTTP API

```
HTTP Polling (cu):   JS → fetch('/api/log') moi 1s → Python HTTP Server → response
IPC Push (moi):      Main Process → webContents.send('log-update', data) → Renderer
```

| HTTP Endpoint | IPC Channel | Ghi chu |
|---|---|---|
| `POST /api/status` | `ipcMain.handle('status')` | |
| `POST /api/full_install` | `ipcMain.handle('full-install')` | Chay background, push progress |
| `POST /api/run_step` | `ipcMain.handle('run-step')` | |
| `POST /api/create_project` | `ipcMain.handle('create-project')` | |
| `POST /api/read_config` | `ipcMain.handle('read-config')` | |
| `POST /api/save_config` | `ipcMain.handle('save-config')` | |
| `POST /api/delete_project` | `ipcMain.handle('delete-project')` | |
| `POST /api/duplicate_project` | `ipcMain.handle('duplicate-project')` | |
| `POST /api/start_odoo` | `ipcMain.handle('start-odoo')` | spawn detached |
| `POST /api/open_vscode` | `ipcMain.handle('open-vscode')` | `shell.openExternal()` |
| `POST /api/open_explorer` | `ipcMain.handle('open-explorer')` | `shell.showItemInFolder()` |
| `POST /api/log` (polling) | `ipcMain.on('log-update')` (push) | Real-time! |

### 3.7 Frontend Changes (`renderer/app.js`)

```javascript
// Cu (HTTP):
async function api(endpoint, data={}) {
  const res = await fetch('/api/' + endpoint, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(data)
  });
  return res.json();
}

// Moi (IPC):
async function api(channel, data={}) {
  return window.electronAPI.invoke(channel, data);
}

// Cu: Log polling
setInterval(async () => {
  const res = await api('log');
  updateLog(res.lines);
}, 1000);

// Moi: Log push events
window.electronAPI.onLogUpdate((data) => {
  updateLog(data.lines);
});
```

### 3.8 Preload Bridge (`preload/index.ts`)

```typescript
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  invoke: (channel: string, data: any) => ipcRenderer.invoke(channel, data),
  onLogUpdate: (cb: Function) => ipcRenderer.on('log-update', (_, data) => cb(data)),
  onProgress: (cb: Function) => ipcRenderer.on('progress', (_, data) => cb(data)),
});
```

---

## 4. Admin Elevation (UAC)

### Option A - Elevate toan bo app (khuyen nghi cho v1)

```yaml
# electron-builder.yml
win:
  requestedExecutionLevel: requireAdministrator
```

- Don gian, giong hanh vi hien tai (start.bat elevate len Admin)
- User thay UAC prompt 1 lan khi mo app

### Option B - Elevate theo yeu cau (tuong lai)

```typescript
import sudoPrompt from 'sudo-prompt';
const options = { name: 'Odoo 17 Installer' };
sudoPrompt.exec('cmd /c mklink /J "..." "..."', options, (error, stdout) => { ... });
```

- Chi elevate khi can (mklink, install PostgreSQL)
- Bao mat tot hon nhung phuc tap hon

---

## 5. Build & Packaging

### Tech Stack

| Component | Choice | Ly do |
|---|---|---|
| Framework | Electron 33+ | Stable, mature |
| Language | TypeScript | Type safety |
| Bundler | electron-forge | Official Electron tooling |
| Packager | electron-builder | NSIS installer cho Windows |
| INI parser | `ini` package | Thay configparser (2KB) |
| Testing | Vitest | Fast, TypeScript native |
| UI | Vanilla JS | Giu nguyen, khong can React/Vue |

### electron-builder.yml

```yaml
appId: com.odoo17.installer
productName: "Odoo 17 Installer"
win:
  target: nsis
  icon: resources/icon.ico
  requestedExecutionLevel: requireAdministrator
nsis:
  oneClick: true
  perMachine: false
directories:
  output: dist
extraResources:
  - from: templates
    to: templates
asar: true
```

### Output
- File: `Odoo 17 Installer Setup.exe` (~80-100MB)
- Bao gom: Chromium + Node.js runtime + app code
- Khong can Python, khong can Node.js cai san

---

## 6. Phases trien khai

### Phase 1: Scaffold & UI Extraction (1-2 ngay)
- [ ] Init Electron project voi TypeScript (electron-forge)
- [ ] Tach HTML_PAGE (dong 630-1147) ra `index.html` + `styles.css` + `app.js`
- [ ] Setup BrowserWindow hien thi UI
- [ ] Verify: UI render dung trong Electron window

### Phase 2: Core Services (2-3 ngay)
- [ ] Port `config.ts` (constants, defaults)
- [ ] Port `logger.ts` (log management + IPC push)
- [ ] Port `shell.ts` (run_cmd wrapper)
- [ ] Port `detection.ts` (find_python, find_postgres, find_docker, detect_status)
- [ ] Port `ini-parser.ts` (configparser replacement)
- [ ] Setup IPC handlers + preload bridge
- [ ] Unit tests cho tat ca services
- [ ] Verify: `status` IPC channel hoat dong

### Phase 3: Installation Steps (3-4 ngay)
- [ ] Port `installer.ts` (tat ca step_* functions)
- [ ] Download voi progress bar (https stream)
- [ ] Port `projects.ts` (create/delete/duplicate/parse_config)
- [ ] Log streaming qua IPC events (thay polling)
- [ ] Full install orchestrator voi progress updates
- [ ] Unit tests voi mocked child_process
- [ ] Verify: Full install workflow end-to-end

### Phase 4: Launcher & Polish (1-2 ngay)
- [ ] Port `launcher.ts` (start_odoo, open_vscode, open_explorer)
- [ ] Admin elevation (UAC manifest)
- [ ] Error handling + edge cases
- [ ] App lifecycle (single instance, graceful shutdown)
- [ ] Verify: Tat ca features hoat dong

### Phase 5: Packaging & Distribution (1-2 ngay)
- [ ] Config electron-builder (NSIS installer)
- [ ] App icon + branding
- [ ] Test tren Windows 10 sach (khong co Python/Node)
- [ ] Test full workflow: install Python → PostgreSQL → Odoo → create project
- [ ] Verify: .exe chay tren may sach

### Phase 6: Bonus (optional)
- [ ] Auto-updater (electron-updater)
- [ ] Code signing certificate
- [ ] Tray icon
- [ ] Adapt e2e_test.ps1 cho Electron version

**Tong thoi gian uoc tinh: 8-13 ngay**

---

## 7. Nhung gi giu nguyen vs viet lai

### Giu nguyen (copy truc tiep)
- `templates/odoo.conf` - Khong thay doi
- `templates/launch.json` - Khong thay doi
- HTML structure (tach tu HTML_PAGE)
- CSS styles (tach tu HTML_PAGE)
- Phan lon JS logic (chi thay `fetch` → IPC)

### Viet lai (1:1 logic tuong duong)
- Detection functions (subprocess → child_process)
- Installation steps (subprocess + file ops)
- Project CRUD (file system ops)
- Config parsing (configparser → ini package)
- Logging + run_cmd helper
- Download files (urlretrieve → https stream)

### Code moi (khong co trong Python)
- Electron main process (BrowserWindow, app lifecycle)
- IPC handler registration
- Preload script (contextBridge)
- electron-builder config
- Download progress tracking
- Push-based log updates

### Loai bo hoan toan
- `start.bat` - Khong can (Electron tu chay)
- Python HTTP server - Thay bang IPC
- Python venv cua installer - Thay bang Node.js runtime
- `webbrowser.open()` - Electron tu mo window

---

## 8. Rui ro & Giai phap

| Rui ro | Muc | Giai phap |
|---|---|---|
| App size lon (~80-100MB do Chromium) | Low | Chap nhan - user cai 1 lan |
| Admin elevation UX | Medium | NSIS manifest + test UAC settings |
| INI parsing khac configparser | Medium | Test ky voi odoo.conf thuc te |
| Encoding issues (UTF-8, paths) | Medium | Set `encoding: 'utf8'` tren moi exec call |
| Silent installer treo | Medium | Timeout 30 phut + kill mechanism |
| Template files trong asar | Medium | Dung `extraResources` (ngoai asar) |
| Antivirus false positive | Medium | Code signing certificate |
| child_process behavior khac | Low | Node child_process tuong duong subprocess |

---

## 9. Dependencies (toi thieu)

### Production
```json
{
  "ini": "^4.1.0"
}
```

### Development
```json
{
  "electron": "^33.0.0",
  "electron-builder": "^25.0.0",
  "typescript": "^5.5.0",
  "vitest": "^2.0.0"
}
```

Tong cong chi 2 production dependencies. Phan con lai la Electron runtime + dev tools.

---

## 10. Security (cai thien lon so voi Python version)

### Hien tai (Python) - van de
```python
# shell=True + string format → COMMAND INJECTION risk
run_cmd('docker exec {} psql -U postgres -c "CREATE ROLE {}"'.format(name, user))
```

### Electron (moi) - an toan hon
```typescript
// execFile voi argument arrays → KHONG shell injection
await runCmd('docker', ['exec', name, 'psql', '-U', 'postgres', '-c', `CREATE ROLE ${user} ...`]);
```

### BrowserWindow config
```typescript
const mainWindow = new BrowserWindow({
  webPreferences: {
    contextIsolation: true,      // BAT BUOC: tach renderer khoi Node
    nodeIntegration: false,      // BAT BUOC: khong require() trong renderer
    sandbox: true,               // Lop bao ve them
    preload: path.join(__dirname, 'preload.js'),
  },
});
```

### IPC Input Validation
- Validate project name: `/^[a-zA-Z0-9_-]+$/`
- Validate paths: kiem tra path traversal (../ attacks)
- Khong expose `ipcRenderer.send` truc tiep, chi expose named functions qua contextBridge
- CSP header: `default-src 'self'`

### Streaming output cho long-running commands
```typescript
// git clone, pip install → stream stdout line-by-line qua IPC
const proc = spawn('git', ['clone', '--depth', '1', url], { cwd });
proc.stdout.on('data', (data) => {
  data.toString().split('\n').filter(Boolean).forEach((line) => {
    logger.log(`  ${line.trim()}`);  // Push real-time to renderer
  });
});
```
UX tot hon: user thay toan bo output real-time thay vi chi 5 dong cuoi.
