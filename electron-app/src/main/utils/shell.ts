import { execFile, spawn, ChildProcess } from 'child_process';
import { LoggerService } from '../services/logger';

// ---------------------------------------------------------------------------
// Shell utilities - replaces Python run_cmd()
// ---------------------------------------------------------------------------

export interface CmdResult {
  readonly code: number;
  readonly output: string;
}

/**
 * Run a shell command and return the result.
 * Uses cmd.exe as shell on Windows (equivalent to Python's shell=True).
 */
export function runCmd(cmd: string, cwd?: string, env?: NodeJS.ProcessEnv): Promise<CmdResult> {
  return new Promise((resolve) => {
    execFile('cmd.exe', ['/c', cmd], {
      cwd,
      env: env ?? process.env,
      timeout: 1_800_000, // 30 minutes
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const output = (stdout || '') + (stderr || '');
      resolve({
        code: error ? (error as NodeJS.ErrnoException).code ? 1 : (error.killed ? 1 : 1) : 0,
        output,
      });
    });
  });
}

/**
 * Run a command with real-time output streaming to the logger.
 * Used for long-running operations (git clone, pip install).
 */
export function runCmdStreaming(
  cmd: string,
  logger: LoggerService,
  options?: { cwd?: string; env?: NodeJS.ProcessEnv }
): Promise<number> {
  return new Promise((resolve) => {
    const proc: ChildProcess = spawn('cmd.exe', ['/c', cmd], {
      cwd: options?.cwd,
      env: options?.env ?? process.env,
      windowsHide: true,
    });

    proc.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        logger.log(`    ${line.trim()}`);
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        logger.log(`    ${line.trim()}`);
      }
    });

    proc.on('error', (err) => {
      logger.log(`    [ERROR] ${err.message}`);
      resolve(1);
    });

    proc.on('close', (code) => {
      resolve(code ?? 1);
    });
  });
}
