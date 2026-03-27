// ---------------------------------------------------------------------------
// Help System Data — Tour steps, Documentation, Troubleshooting
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-unused-vars
const TOUR_STEPS = [
  {
    selector: '.topnav',
    title: 'Navigation Bar',
    text: 'Switch between Dashboard, Full Install, and Help tabs. Access Settings and check for updates here.',
    position: 'bottom',
  },
  {
    selector: '#panel-dashboard .dash-header',
    title: 'Dashboard',
    text: 'Overview of all your Odoo projects. Search, filter, and create new projects from here.',
    position: 'bottom',
    panelBefore: 'dashboard',
  },
  {
    selector: '#dashKanban',
    title: 'Project Cards',
    text: 'Each card shows project name, version, port, and running status. Click a card to see details. Use Start/Stop buttons to control Odoo.',
    position: 'top',
    panelBefore: 'dashboard',
  },
  {
    selector: '[onclick*="showModal(\'modalNewProject\')"]',
    title: 'New Project',
    text: 'Create a new Odoo project. HTTP port auto-increments to avoid conflicts. Each project gets its own odoo.conf, addons folder, and domain.',
    position: 'bottom',
    panelBefore: 'dashboard',
  },
  {
    selector: '[onclick*="resetAllTemplates"]',
    title: 'Reset All Templates',
    text: 'Reset launch.json and settings.json for all projects to the latest defaults. Useful after app updates.',
    position: 'bottom',
    panelBefore: 'dashboard',
  },
  {
    selector: '#panel-install .install-steps',
    title: 'Installation Steps',
    text: '8 steps to set up everything: Nginx, Git, VS Code, Python, PostgreSQL, Odoo source, Virtual Env, and Pip. Click any card to run that step individually.',
    position: 'top',
    panelBefore: 'install',
  },
  {
    selector: '#btnFullInstall',
    title: 'Install Everything',
    text: 'One click to run all 8 steps automatically. Select your Odoo version (15/17/19) first.',
    position: 'top',
    panelBefore: 'install',
  },
  {
    selector: '#installVersion',
    title: 'Odoo Version',
    text: 'Choose Odoo 15 (Python 3.10), 17 (Python 3.11), or 19 (Python 3.12). Each version installs the correct Python and PostgreSQL.',
    position: 'bottom',
    panelBefore: 'install',
  },
  {
    selector: '.theme-toggle[onclick*="openSettingsModal"]',
    title: 'Settings',
    text: 'Configure directories, database, default project settings, appearance themes, and check for updates.',
    position: 'bottom',
  },
  {
    selector: '.theme-toggle[onclick*="toggleMode"]',
    title: 'Dark / Light Mode',
    text: 'Toggle between dark and light themes. You can also choose preset themes (Amethyst, Cyberpunk, Pink Luxury) in Settings.',
    position: 'bottom',
  },
  {
    selector: '#navVersion',
    title: 'Version & Updates',
    text: 'Shows current app version. Click to check for updates. The app checks automatically every 30 minutes while running in the system tray.',
    position: 'bottom',
  },
  {
    selector: '.tour-fab',
    title: 'Help Button',
    text: 'Click this button anytime to restart this guided tour. You can also find documentation and troubleshooting in the Help tab.',
    position: 'top',
  },
];

// eslint-disable-next-line no-unused-vars
const DOCS_ENTRIES = [
  // --- Getting Started ---
  {
    id: 'first-install',
    category: 'Getting Started',
    title: 'First-Time Setup',
    icon: 'rocket',
    description: 'Install everything from scratch — Python, PostgreSQL, Odoo source, and create your first project.',
    body: `
      <ol>
        <li>Open the app and go to <strong>Full Install</strong> tab</li>
        <li>Select your Odoo version (15, 17, or 19)</li>
        <li>Click <strong>"Install Everything"</strong></li>
        <li>Wait for all 8 steps to complete (green checkmarks)</li>
        <li>Go to <strong>Dashboard</strong> — your first project is ready!</li>
        <li>Click <strong>Start</strong> to launch Odoo</li>
      </ol>
      <p><strong>Tip:</strong> The app needs Administrator rights to install PostgreSQL and create symlinks.</p>
    `,
  },
  {
    id: 'create-project',
    category: 'Getting Started',
    title: 'Create a New Project',
    icon: 'plus',
    description: 'Add a new Odoo project with its own config, port, and database.',
    body: `
      <ol>
        <li>On Dashboard, click <strong>"New Project"</strong></li>
        <li>Enter a project name (e.g., <code>ecommerce</code>)</li>
        <li>HTTP Port is auto-assigned (no conflicts)</li>
        <li>Domain is auto-generated (e.g., <code>ecommerce.odoo.local</code>)</li>
        <li>Click <strong>"Create Project"</strong></li>
      </ol>
      <p>Each project gets: <code>addons/</code>, <code>data/</code>, <code>odoo.conf</code>, <code>.vscode/launch.json</code>, and a junction link to shared Odoo source.</p>
    `,
  },
  // --- Project Management ---
  {
    id: 'start-stop',
    category: 'Project Management',
    title: 'Start & Stop Odoo',
    icon: 'play',
    description: 'Launch Odoo server and manage running instances.',
    body: `
      <ul>
        <li><strong>Start:</strong> Click the green Start button. PostgreSQL auto-starts if needed. Browser opens automatically.</li>
        <li><strong>Stop:</strong> Click the red Stop button. The process is killed on the project's port.</li>
        <li>Status syncs every 10 seconds — even if you stop Odoo from terminal.</li>
        <li><strong>Start from VS Code:</strong> Open project in VS Code, press <kbd>F5</kbd> to debug with logs in terminal.</li>
      </ul>
    `,
  },
  {
    id: 'duplicate-delete',
    category: 'Project Management',
    title: 'Duplicate & Delete Projects',
    icon: 'copy',
    description: 'Clone an existing project or remove one permanently.',
    body: `
      <p><strong>Duplicate:</strong> Creates a copy with new name and port. All config and addons are copied.</p>
      <p><strong>Delete:</strong> Type the project name to confirm. Optionally check "Also drop databases" to clean up PostgreSQL.</p>
      <p><strong>Warning:</strong> Delete is permanent and cannot be undone!</p>
    `,
  },
  {
    id: 'custom-modules',
    category: 'Project Management',
    title: 'Adding Custom Modules',
    icon: 'folder',
    description: 'Add your own Odoo modules to a project.',
    body: `
      <ol>
        <li>Place your module folder inside the project's <code>addons/</code> directory</li>
        <li>Or use <strong>Add Folder</strong> in project detail to add an external addons path</li>
        <li>Click <strong>"Save & Restart"</strong> to apply</li>
        <li>In Odoo, go to Apps → Update App List → Install your module</li>
      </ol>
      <p><strong>Tip:</strong> Each module needs a <code>__manifest__.py</code> file to be detected.</p>
    `,
  },
  // --- Configuration ---
  {
    id: 'edit-config',
    category: 'Configuration',
    title: 'Editing odoo.conf',
    icon: 'settings',
    description: 'Modify Odoo configuration — ports, database, logging, and more.',
    body: `
      <p>From project detail, you can edit individual fields or click <strong>"Edit Config"</strong> to edit the raw config file.</p>
      <p>Common settings:</p>
      <ul>
        <li><code>http_port</code> — HTTP port (auto-assigned, avoid conflicts)</li>
        <li><code>db_port</code> — PostgreSQL port</li>
        <li><code>log_level</code> — error, warn, info, debug</li>
        <li><code>addons_path</code> — comma-separated paths to addon directories</li>
        <li><code>admin_passwd</code> — master password for database management</li>
        <li><code>dbfilter</code> — regex to filter visible databases</li>
      </ul>
    `,
  },
  {
    id: 'debug-vscode',
    category: 'Configuration',
    title: 'Debug with VS Code',
    icon: 'code',
    description: 'Use VS Code F5 to run Odoo with breakpoints and live logs.',
    body: `
      <ol>
        <li>Click <strong>"VS Code"</strong> on any project card</li>
        <li>Press <kbd>F5</kbd> to start debugging</li>
        <li>Logs appear in the integrated terminal (not in file)</li>
        <li>Set breakpoints in Python files — debugger stops there</li>
      </ol>
      <p><strong>No logs?</strong> Click "Reset Templates" in project detail to update launch.json.</p>
    `,
  },
  {
    id: 'multiple-pg',
    category: 'Configuration',
    title: 'Multiple PostgreSQL Versions',
    icon: 'database',
    description: 'Running PG 14, 16, and Docker PG side by side.',
    body: `
      <p>The installer supports multiple PostgreSQL versions on different ports:</p>
      <ul>
        <li>Each Odoo version installs its recommended PG version on the configured port</li>
        <li>PG 14 on port 5432, PG 16 on port 5434, etc.</li>
        <li>Docker PostgreSQL containers are also detected and usable</li>
        <li>When starting Odoo, the app reads <code>db_port</code> from odoo.conf and starts the correct PG instance</li>
      </ul>
    `,
  },
  // --- Video Tutorials ---
  {
    id: 'video-overview',
    category: 'Video Tutorials',
    title: 'App Overview (Video)',
    icon: 'video',
    description: 'Quick video walkthrough of the Odoo Installer app.',
    videoUrl: null, // TODO: Add YouTube URL when video is recorded
    body: '<p>Video coming soon! Record and upload your walkthrough, then update this entry.</p>',
  },
];

// eslint-disable-next-line no-unused-vars
const TROUBLESHOOT_ENTRIES = [
  {
    id: 'port-in-use',
    title: 'Port already in use',
    tags: ['port', 'address', 'bind', '8069', 'EADDRINUSE'],
    symptom: 'Error: "Address already in use" or Odoo won\'t start.',
    cause: 'Another Odoo instance or service is using the same HTTP port.',
    solution: 'Change the HTTP port in project detail, or stop the other process. Ports auto-increment when creating new projects.',
  },
  {
    id: 'pg-connection-refused',
    title: 'PostgreSQL connection refused',
    tags: ['postgres', 'connection', 'refused', '5432', '5434', 'psql'],
    symptom: 'Odoo fails to start with "connection refused" to PostgreSQL.',
    cause: 'PostgreSQL service is not running, or running on a different port than configured in odoo.conf.',
    solution: 'The app auto-starts PostgreSQL when you click Start. If it fails, check that db_port in odoo.conf matches the PostgreSQL port. Open Services (services.msc) to verify the PostgreSQL service status.',
  },
  {
    id: 'python-not-found',
    title: 'Python not found after install',
    tags: ['python', 'not found', 'install', 'admin'],
    symptom: 'Python installation step fails or shows "Install may need admin rights".',
    cause: 'Python installer needs Administrator privileges. Or Python was installed to a non-standard path.',
    solution: 'Run the app as Administrator. The installer now tries system-wide install first, then per-user, then checks the Windows py launcher.',
  },
  {
    id: 'pip-install-fail',
    title: 'Pip requirements installation fails',
    tags: ['pip', 'requirements', 'install', 'error', 'build'],
    symptom: 'Step "Pip Requirements" fails with compilation errors.',
    cause: 'Some Python packages need C++ build tools (e.g., lxml, greenlet).',
    solution: 'Install "Visual Studio Build Tools" with C++ workload. Or try running the step again — sometimes it\'s a network timeout.',
  },
  {
    id: 'symlink-fail',
    title: 'Failed to create symlink',
    tags: ['symlink', 'junction', 'mklink', 'administrator', 'permission'],
    symptom: 'Project creation fails with "Failed to create symlink".',
    cause: 'Creating junction links on Windows requires Administrator privileges.',
    solution: 'Right-click the app → Run as Administrator. The app should auto-elevate, but some systems block this.',
  },
  {
    id: 'openssl-error',
    title: 'pyOpenSSL / cryptography error',
    tags: ['openssl', 'cryptography', 'X509', 'NOTIFY_POLICY', 'AttributeError'],
    symptom: 'Odoo crashes with "X509_V_FLAG_NOTIFY_POLICY" AttributeError.',
    cause: 'Version mismatch between pyOpenSSL and cryptography packages.',
    solution: 'Run in your project\'s venv: <code>pip install --upgrade cryptography pyOpenSSL</code>',
  },
  {
    id: 'no-log-vscode',
    title: 'No logs in VS Code terminal',
    tags: ['log', 'vscode', 'terminal', 'F5', 'debug', 'empty'],
    symptom: 'VS Code F5 starts Odoo but terminal shows no output.',
    cause: 'odoo.conf has logfile set, which redirects all output to a file instead of stdout.',
    solution: 'Click "Reset Templates" in project detail. This updates launch.json with --logfile "" to force output to terminal.',
  },
  {
    id: 'db-not-visible',
    title: 'Database not visible in Odoo',
    tags: ['database', 'dbfilter', 'not visible', 'missing', 'hidden'],
    symptom: 'Created a database but it doesn\'t show up in Odoo database selector.',
    cause: 'The dbfilter in odoo.conf only shows databases matching the project name pattern.',
    solution: 'Name your database starting with the project name (e.g., project "shop" → database "shop_main"). Or edit dbfilter in odoo.conf to <code>.*</code> to show all databases.',
  },
  {
    id: 'git-clone-timeout',
    title: 'Git clone Odoo times out',
    tags: ['git', 'clone', 'timeout', 'slow', 'network'],
    symptom: 'Clone Odoo step takes very long or fails with timeout.',
    cause: 'Odoo repository is large (~2GB). Slow internet or firewall blocking GitHub.',
    solution: 'The installer uses --depth 1 (shallow clone) to minimize download. Check your internet connection. Try again — git resumes partial downloads.',
  },
  {
    id: 'venv-wrong-python',
    title: 'Virtual environment uses wrong Python version',
    tags: ['venv', 'python', 'version', 'mismatch', '3.10', '3.11', '3.12'],
    symptom: 'Odoo fails with import errors after switching Odoo version.',
    cause: 'The venv was created with a different Python version than required.',
    solution: 'Delete the venv folder in the base directory, then run the "Virtual Env" step again with the correct Odoo version selected.',
  },
  {
    id: 'odoo-wont-start',
    title: 'Odoo process starts but not responding',
    tags: ['start', 'not responding', 'timeout', 'loading'],
    symptom: 'Click Start, process launches but browser shows "connection refused" or keeps loading.',
    cause: 'Odoo is still initializing (first start creates database schema). Or a module has an error.',
    solution: 'Wait 15-30 seconds for first start. Check the Installation Log for error details. Try with log_level = debug in odoo.conf for more info.',
  },
  {
    id: 'addons-path-backslash',
    title: 'Addons path not saved correctly',
    tags: ['addons', 'path', 'backslash', 'save', 'config'],
    symptom: 'Added a folder via "Add Folder" but Odoo can\'t find the addons.',
    cause: 'Windows paths use backslashes (\\) but odoo.conf needs forward slashes (/).',
    solution: 'The app now auto-converts \\ to / when saving. If you see backslashes in odoo.conf, edit them manually to forward slashes.',
  },
];
