// ---------------------------------------------------------------------------
// Help System Data — Tour steps, Documentation, Troubleshooting
// Uses t() from i18n.js for translations with English fallback.
// ---------------------------------------------------------------------------

function _t(key, fallback) {
  if (typeof t === 'function') {
    const val = t(key);
    return val !== key ? val : fallback;
  }
  return fallback;
}

// eslint-disable-next-line no-unused-vars
function getTourSteps() {
  return [
    { selector: '[data-tour="nav"]', title: _t('td.tour.0.title', 'Navigation Bar'), text: _t('td.tour.0.text', 'Switch between Dashboard, Full Install, and Help tabs. Access Settings and check for updates here.'), position: 'bottom' },
    { selector: '[data-tour="dash-header"]', title: _t('td.tour.1.title', 'Dashboard'), text: _t('td.tour.1.text', 'Overview of all your Odoo projects. Search, filter, and create new projects from here.'), position: 'bottom', panelBefore: 'dashboard' },
    { selector: '[data-tour="kanban"]', title: _t('td.tour.2.title', 'Project Cards'), text: _t('td.tour.2.text', 'Each card shows project name, version, port, and running status. Click a card to see details.'), position: 'top', panelBefore: 'dashboard' },
    { selector: '[data-tour="card-header"]', title: _t('td.tour.2a.title', 'Card Header'), text: _t('td.tour.2a.text', 'Project name, port number (click to open in browser), and duplicate button.'), position: 'bottom', panelBefore: 'dashboard' },
    { selector: '[data-tour="card-tags"]', title: _t('td.tour.2b.title', 'Status Tags'), text: _t('td.tour.2b.text', 'Version badge (color-coded), running/stopped status, and custom modules count.'), position: 'bottom', panelBefore: 'dashboard' },
    { selector: '[data-tour="card-monitor"]', title: _t('td.tour.2c.title', 'Project Monitor'), text: _t('td.tour.2c.text', 'Open the Project Monitor window with two tabs:\n• Log — Real-time Odoo log viewer with level filtering, module upgrade, and Save & Restart.\n• Database — Create databases with Odoo schema init, restore from .zip/.dump backups, view and drop databases.'), position: 'left', panelBefore: 'dashboard' },
    { selector: '[data-tour="card-actions"]', title: _t('td.tour.2d.title', 'Action Buttons'), text: _t('td.tour.2d.text', 'Start/Stop Odoo, open in VS Code, open folder in Explorer, view project details, or delete the project.'), position: 'top', panelBefore: 'dashboard' },
    { selector: '[data-tour="new-project"]', title: _t('td.tour.3.title', 'New Project'), text: _t('td.tour.3.text', 'Create a new Odoo project. HTTP port auto-increments to avoid conflicts.'), position: 'bottom', panelBefore: 'dashboard' },
    { selector: '[data-tour="reset-templates"]', title: _t('td.tour.4.title', 'Reset All Templates'), text: _t('td.tour.4.text', 'Reset launch.json and settings.json for all projects to the latest defaults.'), position: 'bottom', panelBefore: 'dashboard' },
    { selector: '[data-tour="install-steps"]', title: _t('td.tour.5.title', 'Installation Steps'), text: _t('td.tour.5.text', '8 steps to set up everything: Nginx, Git, VS Code, Python, PostgreSQL, Odoo source, Virtual Env, and Pip.'), position: 'top', panelBefore: 'install' },
    { selector: '[data-tour="install-all"]', title: _t('td.tour.6.title', 'Install Everything'), text: _t('td.tour.6.text', 'One click to run all 8 steps automatically. Select your Odoo version first.'), position: 'top', panelBefore: 'install' },
    { selector: '[data-tour="install-version"]', title: _t('td.tour.7.title', 'Odoo Version'), text: _t('td.tour.7.text', 'Choose your Odoo version. Each version installs the correct Python and PostgreSQL.', { versions: _odooVersions ? _odooVersions.versions.map(v => v.key).join(', ') : '15, 17, 18, 19' }), position: 'bottom', panelBefore: 'install' },
    { selector: '[data-tour="settings"]', title: _t('td.tour.8.title', 'Settings'), text: _t('td.tour.8.text', 'Click to open Settings. Configure directories, database, themes, and more.'), position: 'bottom', actionBefore: 'openSettings' },
    { selector: '[data-tour="theme-presets"]', title: _t('td.tour.8a.title', 'Theme Presets'), text: _t('td.tour.8a.text', 'Choose from 4 themes: Default, Amethyst, Cyberpunk, Pink Luxury. Each with dark/light mode.'), position: 'bottom' },
    { selector: '[data-tour="settings-version"]', title: _t('td.tour.8b.title', 'Odoo Version'), text: _t('td.tour.8b.text', 'Select Odoo version. Auto-adjusts Python, PostgreSQL versions and download URLs.'), position: 'bottom' },
    { selector: '[data-tour="settings-dirs"]', title: _t('td.tour.8c.title', 'Directories'), text: _t('td.tour.8c.text', 'Base directory for Odoo source + venv. Projects directory for all your projects.'), position: 'bottom' },
    { selector: '[data-tour="settings-db"]', title: _t('td.tour.8d.title', 'Database Config'), text: _t('td.tour.8d.text', 'PostgreSQL connection: host, port, user, password. These are defaults for new projects.'), position: 'top', actionAfter: 'closeSettings' },
    { selector: '[data-tour="language"]', title: _t('td.tour.9.title', 'Language'), text: _t('td.tour.9.text', 'Switch between English, Vietnamese, and Korean.'), position: 'bottom' },
    { selector: '[data-tour="version"]', title: _t('td.tour.10.title', 'Version & Updates'), text: _t('td.tour.10.text', 'Shows current version. Click to check for updates. Auto-checks every 30 minutes.'), position: 'bottom' },
    { selector: '[data-tour="help-btn"]', title: _t('td.tour.11.title', 'Help Button'), text: _t('td.tour.11.text', 'Click anytime to restart this guided tour. Find docs and troubleshooting in Help tab.'), position: 'top' },
  ];
}

// Keep backward compat — TOUR_STEPS as getter
Object.defineProperty(window, 'TOUR_STEPS', { get: getTourSteps });

function _getDocsEntries() { return [
  {
    id: 'first-install', category: _t('td.cat.start', 'Getting Started'),
    title: _t('td.doc.firstInstall.title', 'First-Time Setup'), icon: 'rocket',
    description: _t('td.doc.firstInstall.desc', 'Install everything from scratch — Python, PostgreSQL, Odoo source, and create your first project.'),
    body: _t('td.doc.firstInstall.body', '<ol><li>Open the app and go to <strong>Full Install</strong> tab</li><li>Select your Odoo version (15, 17, or 19)</li><li>Click <strong>"Install Everything"</strong></li><li>Wait for all 8 steps to complete</li><li>Go to <strong>Dashboard</strong> — your first project is ready!</li><li>Click <strong>Start</strong> to launch Odoo</li></ol><p><strong>Tip:</strong> The app needs Administrator rights to install PostgreSQL and create symlinks.</p>'),
    tourRange: [9, 11],
  },
  {
    id: 'create-project', category: _t('td.cat.start', 'Getting Started'),
    title: _t('td.doc.createProject.title', 'Create a New Project'), icon: 'plus',
    description: _t('td.doc.createProject.desc', 'Add a new Odoo project with its own config, port, and database.'),
    body: _t('td.doc.createProject.body', '<ol><li>On Dashboard, click <strong>"New Project"</strong></li><li>Enter a project name</li><li>HTTP Port is auto-assigned</li><li>Click <strong>"Create Project"</strong></li></ol><p>Each project gets: <code>addons/</code>, <code>data/</code>, <code>odoo.conf</code>, and <code>.vscode/launch.json</code>.</p>'),
    tourRange: [7, 7],
  },
  {
    id: 'start-stop', category: _t('td.cat.project', 'Project Management'),
    title: _t('td.doc.startStop.title', 'Start & Stop Odoo'), icon: 'play',
    description: _t('td.doc.startStop.desc', 'Launch Odoo server and manage running instances.'),
    body: _t('td.doc.startStop.body', '<ul><li><strong>Start:</strong> Click the green Start button. PostgreSQL auto-starts if needed.</li><li><strong>Stop:</strong> Click the red Stop button.</li><li>Status syncs every 10 seconds.</li><li><strong>VS Code:</strong> Press <kbd>F5</kbd> to debug with logs in terminal.</li></ul>'),
    tourRange: [6, 6],
  },
  {
    id: 'duplicate-delete', category: _t('td.cat.project', 'Project Management'),
    title: _t('td.doc.dupDelete.title', 'Duplicate & Delete Projects'), icon: 'copy',
    description: _t('td.doc.dupDelete.desc', 'Clone an existing project or remove one permanently.'),
    body: _t('td.doc.dupDelete.body', '<p><strong>Duplicate:</strong> Creates a copy with new name and port.</p><p><strong>Delete:</strong> Type project name to confirm. Optionally drop databases.</p><p><strong>Warning:</strong> Delete is permanent!</p>'),
  },
  {
    id: 'custom-modules', category: _t('td.cat.project', 'Project Management'),
    title: _t('td.doc.customModules.title', 'Adding Custom Modules'), icon: 'folder',
    description: _t('td.doc.customModules.desc', 'Add your own Odoo modules to a project.'),
    body: _t('td.doc.customModules.body', '<ol><li>Place module folder inside <code>addons/</code></li><li>Or use <strong>Add Folder</strong> in project detail</li><li>Click <strong>"Save & Restart"</strong></li><li>In Odoo: Apps → Update App List → Install</li></ol>'),
  },
  {
    id: 'edit-config', category: _t('td.cat.config', 'Configuration'),
    title: _t('td.doc.editConfig.title', 'Editing odoo.conf'), icon: 'settings',
    description: _t('td.doc.editConfig.desc', 'Modify Odoo configuration — ports, database, logging.'),
    body: _t('td.doc.editConfig.body', '<p>Common settings: <code>http_port</code>, <code>db_port</code>, <code>log_level</code>, <code>addons_path</code>, <code>admin_passwd</code>, <code>dbfilter</code>.</p>'),
    tourRange: [12, 16],
  },
  {
    id: 'debug-vscode', category: _t('td.cat.config', 'Configuration'),
    title: _t('td.doc.debugVscode.title', 'Debug with VS Code'), icon: 'code',
    description: _t('td.doc.debugVscode.desc', 'Use VS Code F5 to run Odoo with breakpoints and live logs.'),
    body: _t('td.doc.debugVscode.body', '<ol><li>Click <strong>"VS Code"</strong> on project card</li><li>Press <kbd>F5</kbd></li><li>Logs appear in terminal</li><li>Set breakpoints in Python files</li></ol><p><strong>No logs?</strong> Click "Reset Templates" in project detail.</p>'),
  },
  {
    id: 'multiple-pg', category: _t('td.cat.config', 'Configuration'),
    title: _t('td.doc.multiplePg.title', 'Multiple PostgreSQL Versions'), icon: 'database',
    description: _t('td.doc.multiplePg.desc', 'Running PG 14, 16, and Docker PG side by side.'),
    body: _t('td.doc.multiplePg.body', '<ul><li>Each Odoo version installs its recommended PG version</li><li>PG 14 port 5432, PG 16 port 5434, etc.</li><li>Docker PostgreSQL containers also detected</li><li>App reads <code>db_port</code> from odoo.conf and starts the correct PG</li></ul>'),
  },
  {
    id: 'video-overview', category: _t('td.cat.video', 'Video Tutorials'),
    title: _t('td.doc.video.title', 'App Overview (Video)'), icon: 'video',
    description: _t('td.doc.video.desc', 'Quick video walkthrough of the Odoo Installer app.'),
    videoUrl: null,
    body: _t('td.doc.video.body', '<p>Video coming soon!</p>'),
  },
  {
    id: 'create-restore-db', category: _t('td.cat.project', 'Project Management'),
    title: _t('td.doc.createDb.title', 'Create & Restore Database'), icon: 'database',
    description: _t('td.doc.createDb.desc', 'Create a new database or restore from a backup — using Project Monitor or Odoo web.'),
    tourRange: [5, 5],
    body: _t('td.doc.createDb.body', '<h4>Method 1: Project Monitor (Recommended)</h4><p>Click the <strong>Monitor</strong> button on a project card, then switch to the <strong>Database</strong> tab.</p><h4>Create Database</h4><ol><li>Click <strong>"Create Database"</strong></li><li>Master Password is shown automatically (from odoo.conf)</li><li>Enter: Database Name, Email, Password</li><li>Choose Language and Country</li><li>Check "Demo Data" if you want sample data</li><li>Click <strong>"Create"</strong> — wait 2-5 minutes for schema initialization</li><li>Progress is shown in real-time. You can close and reopen the window without losing progress.</li></ol><h4>Restore Database</h4><ol><li>Click <strong>"Restore Database"</strong></li><li>Enter a name for the restored database</li><li>Click <strong>"Browse"</strong> and select your backup file (<code>.zip</code>, <code>.dump</code>, or <code>.sql</code>)</li><li>Click <strong>"Restore"</strong></li><li>For <code>.zip</code> files: the app auto-extracts the dump and copies the filestore</li></ol><h4>Method 2: Odoo Web Manager</h4><ol><li>Start Odoo and open <code>/web/database/manager</code> in the browser</li><li>Use the web interface to create or restore databases</li></ol><p><strong>Tips:</strong></p><ul><li>Project Monitor works <strong>without Odoo running</strong> — it uses PostgreSQL directly</li><li>Database name should match the project\'s dbfilter pattern</li><li>Default Master Password is <code>odoo</code> (configurable in Settings)</li><li>System databases (postgres, template0, template1) are protected from deletion</li></ul>'),
  },
  {
    id: 'vscode-dev', category: _t('td.cat.config', 'Configuration'),
    title: _t('td.doc.vscodeDev.title', 'Developing with VS Code'), icon: 'code',
    description: _t('td.doc.vscodeDev.desc', 'VS Code setup for Odoo development — extensions, shortcuts, and workflow.'),
    body: _t('td.doc.vscodeDev.body', '<h4>Opening a Project</h4><ol><li>Click <strong>"VS Code"</strong> on any project card</li><li>VS Code opens with the project folder as workspace</li><li>Python interpreter is auto-configured to the venv</li></ol><h4>Recommended Extensions</h4><ul><li><strong>Python</strong> (Microsoft) — IntelliSense, debugging</li><li><strong>Odoo</strong> (Odoo S.A.) — Odoo-specific snippets</li><li><strong>XML Tools</strong> — for Odoo XML views</li></ul><h4>Debugging (F5)</h4><ul><li>Press <kbd>F5</kbd> to start Odoo in debug mode</li><li>Set breakpoints by clicking left of line numbers</li><li>Logs appear in the integrated terminal</li><li>Use <kbd>F10</kbd> (step over), <kbd>F11</kbd> (step into), <kbd>Shift+F5</kbd> (stop)</li></ul><h4>Hot Reload</h4><p>With <code>--dev xml</code> (already in launch.json), Odoo auto-reloads XML changes. For Python changes, restart with <kbd>Shift+F5</kbd> then <kbd>F5</kbd>.</p>'),
  },
  {
    id: 'claude-code', category: _t('td.cat.config', 'Configuration'),
    title: _t('td.doc.claudeCode.title', 'Using Claude Code for Odoo'), icon: 'code',
    description: _t('td.doc.claudeCode.desc', 'AI-powered coding assistant for Odoo module development.'),
    body: _t('td.doc.claudeCode.body', '<h4>What is Claude Code?</h4><p>Claude Code is an AI coding assistant that runs in your terminal. It can read your Odoo project files, generate modules, fix bugs, and explain code.</p><h4>Setup</h4><ol><li>Install: <code>npm install -g @anthropic-ai/claude-code</code></li><li>Open terminal in your project folder</li><li>Run: <code>claude</code></li></ol><h4>Common Tasks</h4><ul><li><strong>"Create a new Odoo module called inventory_report"</strong> — generates __manifest__.py, models, views, security</li><li><strong>"Fix this error: [paste error]"</strong> — analyzes and fixes bugs</li><li><strong>"Add a computed field total_price to sale.order.line"</strong> — modifies existing models</li><li><strong>"Write unit tests for my custom module"</strong> — generates test files</li><li><strong>"Explain what this XML view does"</strong> — explains Odoo views</li></ul><h4>Tips</h4><ul><li>Add a <code>CLAUDE.md</code> file in your project with Odoo conventions</li><li>Use <code>/commit</code> to auto-commit changes</li><li>Claude reads <code>odoo.conf</code> to understand your setup</li></ul>'),
  },
]; }
Object.defineProperty(window, 'DOCS_ENTRIES', { get: _getDocsEntries });

function _getTroubleshootEntries() { return [
  { id: 'port-in-use', title: _t('td.ts.port.title', 'Port already in use'), tags: ['port', 'address', 'bind', '8069'], symptom: _t('td.ts.port.symptom', 'Error: "Address already in use" or Odoo won\'t start.'), cause: _t('td.ts.port.cause', 'Another Odoo instance or service is using the same HTTP port.'), solution: _t('td.ts.port.solution', 'Change the HTTP port in project detail, or stop the other process.') },
  { id: 'pg-connection-refused', title: _t('td.ts.pgConn.title', 'PostgreSQL connection refused'), tags: ['postgres', 'connection', 'refused', '5432'], symptom: _t('td.ts.pgConn.symptom', 'Odoo fails to start with "connection refused" to PostgreSQL.'), cause: _t('td.ts.pgConn.cause', 'PostgreSQL service is not running, or running on a different port.'), solution: _t('td.ts.pgConn.solution', 'The app auto-starts PostgreSQL. Check db_port in odoo.conf matches the PostgreSQL port.') },
  { id: 'python-not-found', title: _t('td.ts.python.title', 'Python not found after install'), tags: ['python', 'not found', 'install'], symptom: _t('td.ts.python.symptom', 'Python step fails or shows "Install may need admin rights".'), cause: _t('td.ts.python.cause', 'Python installer needs Administrator privileges.'), solution: _t('td.ts.python.solution', 'Run the app as Administrator.') },
  { id: 'pip-install-fail', title: _t('td.ts.pip.title', 'Pip requirements installation fails'), tags: ['pip', 'requirements', 'error'], symptom: _t('td.ts.pip.symptom', '"Pip Requirements" fails with compilation errors.'), cause: _t('td.ts.pip.cause', 'Some packages need C++ build tools.'), solution: _t('td.ts.pip.solution', 'Install "Visual Studio Build Tools" with C++ workload.') },
  { id: 'symlink-fail', title: _t('td.ts.symlink.title', 'Failed to create symlink'), tags: ['symlink', 'junction', 'administrator'], symptom: _t('td.ts.symlink.symptom', 'Project creation fails with "Failed to create symlink".'), cause: _t('td.ts.symlink.cause', 'Junction links require Administrator privileges.'), solution: _t('td.ts.symlink.solution', 'Right-click the app → Run as Administrator.') },
  { id: 'openssl-error', title: _t('td.ts.openssl.title', 'pyOpenSSL / cryptography error'), tags: ['openssl', 'cryptography', 'X509'], symptom: _t('td.ts.openssl.symptom', 'Odoo crashes with "X509_V_FLAG_NOTIFY_POLICY" error.'), cause: _t('td.ts.openssl.cause', 'Version mismatch between pyOpenSSL and cryptography.'), solution: _t('td.ts.openssl.solution', 'Run: pip install --upgrade cryptography pyOpenSSL') },
  { id: 'no-log-vscode', title: _t('td.ts.noLog.title', 'No logs in VS Code terminal'), tags: ['log', 'vscode', 'F5', 'empty'], symptom: _t('td.ts.noLog.symptom', 'VS Code F5 starts Odoo but terminal is empty.'), cause: _t('td.ts.noLog.cause', 'odoo.conf logfile redirects output to file.'), solution: _t('td.ts.noLog.solution', 'Click "Reset Templates" in project detail to update launch.json.') },
  { id: 'db-not-visible', title: _t('td.ts.dbFilter.title', 'Database not visible in Odoo'), tags: ['database', 'dbfilter', 'hidden'], symptom: _t('td.ts.dbFilter.symptom', 'Database doesn\'t show in Odoo selector.'), cause: _t('td.ts.dbFilter.cause', 'dbfilter only shows databases matching project name.'), solution: _t('td.ts.dbFilter.solution', 'Name DB starting with project name, or set dbfilter to .* to show all.') },
  { id: 'git-clone-timeout', title: _t('td.ts.gitClone.title', 'Git clone Odoo times out'), tags: ['git', 'clone', 'timeout'], symptom: _t('td.ts.gitClone.symptom', 'Clone step takes very long or fails.'), cause: _t('td.ts.gitClone.cause', 'Odoo repo is ~2GB. Slow internet or firewall.'), solution: _t('td.ts.gitClone.solution', 'Check internet connection. Installer uses --depth 1 for minimal download.') },
  { id: 'venv-wrong-python', title: _t('td.ts.venv.title', 'Virtual environment wrong Python'), tags: ['venv', 'python', 'version'], symptom: _t('td.ts.venv.symptom', 'Import errors after switching Odoo version.'), cause: _t('td.ts.venv.cause', 'Venv was created with wrong Python version.'), solution: _t('td.ts.venv.solution', 'Delete venv folder, then run "Virtual Env" step again.') },
  { id: 'odoo-wont-start', title: _t('td.ts.wontStart.title', 'Odoo starts but not responding'), tags: ['start', 'not responding', 'timeout'], symptom: _t('td.ts.wontStart.symptom', 'Browser keeps loading after clicking Start.'), cause: _t('td.ts.wontStart.cause', 'First start initializes database (1-5 minutes).'), solution: _t('td.ts.wontStart.solution', 'Wait 1-5 minutes for first start. Check Installation Log for errors.') },
  { id: 'addons-path-backslash', title: _t('td.ts.addonsPath.title', 'Addons path not saved correctly'), tags: ['addons', 'path', 'backslash'], symptom: _t('td.ts.addonsPath.symptom', 'Odoo can\'t find addons after Add Folder.'), cause: _t('td.ts.addonsPath.cause', 'Windows backslashes vs odoo.conf forward slashes.'), solution: _t('td.ts.addonsPath.solution', 'App auto-converts \\ to /. Edit manually if needed.') },
  { id: 'slow-download', title: _t('td.ts.slowDl.title', 'Download is very slow or stuck'), tags: ['download', 'slow', 'stuck'], symptom: _t('td.ts.slowDl.symptom', 'Download takes very long or fails.'), cause: _t('td.ts.slowDl.cause', 'Slow internet, VPN, or firewall blocking.'), solution: _t('td.ts.slowDl.solution', 'Disconnect VPN. Check firewall. Download installer manually from python.org or postgresql.org.') },
  { id: 'version-incompatible', title: _t('td.ts.compat.title', 'Odoo version not working on this PC'), tags: ['version', 'incompatible', 'Windows'], symptom: _t('td.ts.compat.symptom', 'Odoo crashes or installer fails.'), cause: _t('td.ts.compat.cause', 'Python 3.12 needs Windows 10+. Missing DLLs.'), solution: _t('td.ts.compat.solution', 'Update Windows. Try older Odoo version. Install Visual C++ Redistributable.') },
  { id: 'antivirus-block', title: _t('td.ts.antivirus.title', 'Antivirus blocks installation'), tags: ['antivirus', 'defender', 'quarantine'], symptom: _t('td.ts.antivirus.symptom', 'Installer exe gets quarantined or steps fail silently.'), cause: _t('td.ts.antivirus.cause', 'Windows Defender flags downloaded executables.'), solution: _t('td.ts.antivirus.solution', 'Temporarily disable real-time protection during installation.') },
  { id: 'disk-space', title: _t('td.ts.disk.title', 'Not enough disk space'), tags: ['disk', 'space', 'full'], symptom: _t('td.ts.disk.symptom', 'Installation fails partway or Odoo crashes.'), cause: _t('td.ts.disk.cause', 'Full install needs ~5GB.'), solution: _t('td.ts.disk.solution', 'Free disk space. Change Base Directory to a drive with more space.') },
  { id: 'multiple-pg-conflict', title: _t('td.ts.pgConflict.title', 'Multiple PostgreSQL versions conflict'), tags: ['postgres', 'multiple', 'conflict'], symptom: _t('td.ts.pgConflict.symptom', 'Wrong PostgreSQL version used or DB creation fails.'), cause: _t('td.ts.pgConflict.cause', 'Multiple PG versions on different ports.'), solution: _t('td.ts.pgConflict.solution', 'Check db_port in odoo.conf matches the correct PG version.') },
  { id: 'first-start-slow', title: _t('td.ts.firstStart.title', 'First Odoo start takes very long'), tags: ['first', 'start', 'slow'], symptom: _t('td.ts.firstStart.symptom', 'First start loads for 1-5 minutes.'), cause: _t('td.ts.firstStart.cause', 'Odoo initializes database schema on first start.'), solution: _t('td.ts.firstStart.solution', 'Wait 1-5 minutes. Subsequent starts are faster (~10-30s).') },
]; }
Object.defineProperty(window, 'TROUBLESHOOT_ENTRIES', { get: _getTroubleshootEntries });
