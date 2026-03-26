import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // Request-response: renderer calls, main process handles
  invoke: (channel: string, data: unknown): Promise<unknown> => {
    const validChannels = [
      'status', 'log', 'full_install', 'run_step',
      'create_project', 'read_config', 'save_config',
      'delete_project', 'duplicate_project',
      'start_odoo', 'stop_odoo', 'open_vscode', 'open_explorer', 'open_browser', 'pick-folder',
      'window-minimize', 'window-maximize', 'window-close', 'window-is-maximized',
      'update-check', 'update-download', 'update-install', 'update-info',
      'app-version', 'default-paths', 'pick-icon', 'get-icon', 'reset-icon',
    ];
    if (validChannels.includes(channel)) {
      return ipcRenderer.invoke(channel, data);
    }
    return Promise.reject(new Error(`Invalid channel: ${channel}`));
  },

  // Push-based events from main process (replaces HTTP polling)
  onLogMessage: (callback: (line: string) => void): void => {
    ipcRenderer.on('log-message', (_event, line: string) => callback(line));
  },

  onTaskProgress: (callback: (task: { status: string; step: string; progress: number }) => void): void => {
    ipcRenderer.on('task-progress', (_event, task) => callback(task));
  },

  // Generic event listener (for update-status and other push events)
  onEvent: (eventName: string, callback: (...args: unknown[]) => void): void => {
    ipcRenderer.on(eventName, (_event, ...args) => callback(...args));
  },

  removeAllListeners: (channel: string): void => {
    ipcRenderer.removeAllListeners(channel);
  },
});
