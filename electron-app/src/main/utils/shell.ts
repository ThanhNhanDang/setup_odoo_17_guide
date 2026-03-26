import { exec, spawn, ChildProcess } from 'child_process';
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
 */
export function runCmdStreaming(
  cmd: string,
  logger: LoggerService,
  options?: { cwd?: string; env?: NodeJS.ProcessEnv }
): Promise<number> {
  return new Promise((resolve) => {
    const proc: ChildProcess = spawn(cmd, [], {
      cwd: options?.cwd,
      env: options?.env ?? process.env,
      shell: true,
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
