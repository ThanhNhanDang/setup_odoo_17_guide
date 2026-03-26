import { BrowserWindow } from 'electron';

// ---------------------------------------------------------------------------
// Logger Service - replaces Python global log_lines + current_task
// ---------------------------------------------------------------------------

export interface TaskProgress {
  readonly status: 'idle' | 'running' | 'done' | 'error';
  readonly step: string;
  readonly progress: number;
  readonly results?: ReadonlyArray<{ step: string; ok: boolean; msg: string }>;
}

export class LoggerService {
  private readonly lines: string[] = [];
  private task: TaskProgress = { status: 'idle', step: '', progress: 0 };

  constructor(private readonly window: BrowserWindow) {}

  log(msg: string): void {
    const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
    const line = `[${ts}] ${msg}`;
    this.lines.push(line);
    console.log(line);
    // Push to renderer immediately
    if (!this.window.isDestroyed()) {
      this.window.webContents.send('log-message', line);
    }
  }

  updateTask(update: Partial<TaskProgress>): void {
    this.task = { ...this.task, ...update };
    if (!this.window.isDestroyed()) {
      this.window.webContents.send('task-progress', this.task);
    }
  }

  getLines(count: number = 200): readonly string[] {
    return this.lines.slice(-count);
  }

  getTask(): Readonly<TaskProgress> {
    return this.task;
  }

  resetTask(): void {
    this.task = { status: 'idle', step: '', progress: 0 };
  }
}
