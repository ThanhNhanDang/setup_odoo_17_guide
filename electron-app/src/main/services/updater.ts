import { app, BrowserWindow } from 'electron';
import { autoUpdater, UpdateInfo } from 'electron-updater';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Auto-Update Service
//
// IMPORTANT: Auto-update only works when:
//   1. App is installed via NSIS installer (not portable, not dev mode)
//   2. GitHub Release has latest.yml + .exe + .blockmap
//   3. App version < release version
//
// Flow:
//   App start → checkForUpdates()
//   → 'update-available' → push to renderer (show popup)
//   → User clicks "Update" → downloadUpdate()
//   → 'update-downloaded' → quitAndInstall()
// ---------------------------------------------------------------------------

export class UpdaterService {
  private updateAvailable = false;
  private updateInfo: UpdateInfo | null = null;

  constructor(private readonly window: BrowserWindow) {
    // Don't auto-download - let user decide
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.autoRunAppAfterInstall = true;

    // Enable logging
    autoUpdater.logger = {
      info: (msg: string) => console.log('[updater]', msg),
      warn: (msg: string) => console.warn('[updater]', msg),
      error: (msg: string) => console.error('[updater]', msg),
      debug: (msg: string) => console.log('[updater:debug]', msg),
    } as any;

    // In dev mode, force check against GitHub by providing update config
    if (!app.isPackaged) {
      autoUpdater.forceDevUpdateConfig = true;
      // Point to the real app-update.yml
      const devUpdateConfig = path.join(__dirname, '..', '..', 'dev-app-update.yml');
      try {
        autoUpdater.updateConfigPath = devUpdateConfig;
      } catch {
        // ignore if file doesn't exist
      }
    }

    this.setupEvents();
  }

  private setupEvents(): void {
    autoUpdater.on('checking-for-update', () => {
      console.log('[updater] Checking for update... (current: v' + app.getVersion() + ')');
      this.sendToRenderer('update-status', { status: 'checking' });
    });

    autoUpdater.on('update-available', (info: UpdateInfo) => {
      console.log('[updater] Update available: v' + info.version);
      this.updateAvailable = true;
      this.updateInfo = info;
      this.sendToRenderer('update-status', {
        status: 'available',
        version: info.version,
        releaseDate: info.releaseDate,
        releaseNotes: typeof info.releaseNotes === 'string'
          ? info.releaseNotes
          : '',
      });
    });

    autoUpdater.on('update-not-available', (info: UpdateInfo) => {
      console.log('[updater] Up to date: v' + info.version);
      this.sendToRenderer('update-status', { status: 'up-to-date' });
    });

    autoUpdater.on('download-progress', (progress) => {
      this.sendToRenderer('update-status', {
        status: 'downloading',
        percent: Math.round(progress.percent),
        transferred: progress.transferred,
        total: progress.total,
      });
    });

    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      console.log('[updater] Downloaded: v' + info.version);
      this.sendToRenderer('update-status', {
        status: 'ready',
        version: info.version,
      });
    });

    autoUpdater.on('error', (err) => {
      console.error('[updater] Error:', err.message);
      this.sendToRenderer('update-status', {
        status: 'error',
        message: err.message,
      });
    });
  }

  private sendToRenderer(channel: string, data: unknown): void {
    if (!this.window.isDestroyed()) {
      this.window.webContents.send(channel, data);
    }
  }

  /** Check for updates */
  checkForUpdates(): void {
    console.log('[updater] Starting update check (packaged: ' + app.isPackaged + ')');
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[updater] Check failed:', err.message);
    });
  }

  /** Start downloading the update */
  downloadUpdate(): void {
    if (this.updateAvailable) {
      autoUpdater.downloadUpdate().catch((err) => {
        console.error('[updater] Download failed:', err.message);
      });
    }
  }

  /** Install update and restart app */
  installUpdate(): void {
    autoUpdater.quitAndInstall(false, true);
  }

  /** Get current update info */
  getUpdateInfo(): { available: boolean; version: string; currentVersion: string } {
    return {
      available: this.updateAvailable,
      version: this.updateInfo?.version || '',
      currentVersion: app.getVersion(),
    };
  }
}
