import { registerLogHandlers } from './log-handlers';
import { registerDbHandlers } from './db-handlers';
import { IpcContext } from './context';

export function registerMonitorHandlers(ctx: IpcContext): void {
  registerLogHandlers(ctx);
  registerDbHandlers(ctx);
}
