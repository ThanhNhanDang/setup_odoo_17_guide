import { BrowserWindow } from 'electron';
import { LoggerService } from './services/logger';
import { StepLockManager } from './services/step-lock';
import { IpcContext } from './ipc/context';
import { registerWindowHandlers } from './ipc/window-handlers';
import { registerSettingsHandlers } from './ipc/settings-handlers';
import { registerInstallHandlers } from './ipc/install-handlers';
import { registerProjectHandlers, registerLogoHandlers } from './ipc/project-handlers';
import { registerMonitorHandlers } from './ipc/monitor-handlers';
import { registerTelemetryHandlers } from './ipc/telemetry-handlers';

// ---------------------------------------------------------------------------
// IPC Handler Registration — Orchestrator
// Creates shared context and delegates to domain-specific handler modules.
// ---------------------------------------------------------------------------

export function registerIpcHandlers(mainWindow: BrowserWindow): void {
  const ctx: IpcContext = {
    mainWindow,
    logger: new LoggerService(mainWindow),
    stepLock: new StepLockManager(),
    logWatchers: new Map(),
    logWindows: new Map(),
    logColorIndex: 0,
    adminWindow: null,
  };

  registerWindowHandlers(ctx);
  registerSettingsHandlers(ctx);
  registerInstallHandlers(ctx);
  registerProjectHandlers(ctx);
  registerLogoHandlers(ctx);
  registerMonitorHandlers(ctx);
  registerTelemetryHandlers(ctx);
}
