import { BrowserWindow } from 'electron';
import { spawn } from 'child_process';
import { LoggerService } from '../services/logger';
import { StepLockManager } from '../services/step-lock';

export type LogWatcherEntry = {
  tailProc: ReturnType<typeof spawn> | null;
  pollTimer: ReturnType<typeof setInterval> | null;
  lastSize: number;
  subscribers: Set<BrowserWindow>;
};

export interface IpcContext {
  mainWindow: BrowserWindow;
  logger: LoggerService;
  stepLock: StepLockManager;
  logWatchers: Map<string, LogWatcherEntry>;
  logWindows: Map<string, BrowserWindow>;
  logColorIndex: number;
}
