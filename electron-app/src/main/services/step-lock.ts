// ---------------------------------------------------------------------------
// Step Lock Manager - prevents concurrent execution of the same install step
// ---------------------------------------------------------------------------

export interface StepResult {
  readonly ok: boolean;
  readonly msg: string;
}

interface LockEntry {
  readonly holder: string;
  readonly promise: Promise<StepResult>;
}

export class StepLockManager {
  private readonly locks = new Map<string, LockEntry>();

  /** Try to acquire lock. Returns false if already locked. */
  acquire(stepId: string, holder: string, promise: Promise<StepResult>): boolean {
    if (this.locks.has(stepId)) return false;
    this.locks.set(stepId, { holder, promise });
    return true;
  }

  /** Release lock for a step. */
  release(stepId: string): void {
    this.locks.delete(stepId);
  }

  /** Check if step is currently locked. */
  isLocked(stepId: string): boolean {
    return this.locks.has(stepId);
  }

  /** Get the holder of the lock (e.g. 'run_step' or 'full_install'). */
  getHolder(stepId: string): string | null {
    return this.locks.get(stepId)?.holder ?? null;
  }

  /** Get the running promise to await its result. Returns null if not locked. */
  getResult(stepId: string): Promise<StepResult> | null {
    return this.locks.get(stepId)?.promise ?? null;
  }
}
