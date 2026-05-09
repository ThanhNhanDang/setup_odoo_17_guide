import { exec, spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import { LoggerService } from '../services/logger';

/**
 * Create a directory if it does not exist. Safe for drive roots on Windows:
 * `fs.mkdirSync('E:\\', { recursive: true })` throws EPERM even though the
 * root already exists, so we skip when the path is already a directory.
 */
export function ensureDir(dir: string): void {
  if (fs.existsSync(dir)) {
    try {
      if (fs.statSync(dir).isDirectory()) return;
    } catch { /* fall through to mkdir */ }
  }
  fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Shell utilities - replaces Python run_cmd()
// ---------------------------------------------------------------------------

export interface CmdResult {
  readonly code: number;
  readonly output: string;
}

/**
 * Run a shell command and return the result.
 * Uses cmd.exe shell (equivalent to Python's shell=True).
 *
 * IMPORTANT: Uses exec() with shell:true, NOT execFile().
 * execFile('cmd.exe', ['/c', cmd]) breaks when cmd contains
 * quoted paths like "C:\path\python.exe" because cmd.exe /c
 * has special quoting rules that mangle the quotes.
 */
export function runCmd(cmd: string, cwd?: string, env?: NodeJS.ProcessEnv): Promise<CmdResult> {
  return new Promise((resolve) => {
    exec(cmd, {
      cwd,
      env: env ?? process.env,
      shell: 'cmd.exe',
      timeout: 1_800_000, // 30 minutes
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const output = (stdout || '') + (stderr || '');
      resolve({
        code: error ? 1 : 0,
        output,
      });
    });
  });
}

/**
 * Run a command with real-time output streaming to the logger.
 * Used for long-running operations (git clone, pip install).
 *
 * @param onData optional callback for each output line, used to parse progress
 */
export function runCmdStreaming(
  cmd: string,
  logger: LoggerService,
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    onData?: (line: string) => void;
  }
): Promise<number> {
  return new Promise((resolve) => {
    const proc: ChildProcess = spawn(cmd, [], {
      cwd: options?.cwd,
      env: options?.env ?? process.env,
      shell: true,
      windowsHide: true,
    });

    const handleData = (data: Buffer) => {
      // Split on \n and \r for git progress which uses \r
      const lines = data.toString().split(/[\r\n]+/).filter(Boolean);
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          logger.log(`    ${trimmed}`);
          options?.onData?.(trimmed);
        }
      }
    };

    proc.stdout?.on('data', handleData);
    proc.stderr?.on('data', handleData);

    proc.on('error', (err) => {
      logger.log(`    [ERROR] ${err.message}`);
      resolve(1);
    });

    proc.on('close', (code) => {
      resolve(code ?? 1);
    });
  });
}
