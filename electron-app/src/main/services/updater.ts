import { BrowserWindow } from 'electron';
import { autoUpdater, UpdateInfo } from 'electron-updater';

// ---------------------------------------------------------------------------
// Auto-Update Service
// Uses electron-updater to check for updates from GitHub Releases
// or a generic update server.
//
// Flow:
//   App start → checkForUpdates()
//   → 'update-available' event → push to renderer (show popup)
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

    // Suppress default error dialog
    autoUpdater.autoRunAppAfterInstall = true;

    this.setupEvents();
  }

  private setupEvents(): void {
    autoUpdater.on('checking-for-update', () => {
      this.sendToRenderer('update-status', { status: 'checking' });
    });

    autoUpdater.on('update-available', (info: UpdateInfo) => {
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

    autoUpdater.on('update-not-available', () => {
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
      this.sendToRenderer('update-status', {
        status: 'ready',
        version: info.version,
      });
    });

    autoUpdater.on('error', (err) => {
      console.error('Update error:', err.message);
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

  /** Check for updates (call on app start) */
  checkForUpdates(): void {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('Check update failed:', err.message);
    });
  }

  /** Start downloading the update */
  downloadUpdate(): void {
    if (this.updateAvailable) {
      autoUpdater.downloadUpdate().catch((err) => {
        console.error('Download update failed:', err.message);
      });
    }
  }

  /** Install update and restart app */
  installUpdate(): void {
    autoUpdater.quitAndInstall(false, true);
  }

  /** Get current update info */
  getUpdateInfo(): { available: boolean; version: string } {
    return {
      available: this.updateAvailable,
      version: this.updateInfo?.version || '',
    };
  }
}
