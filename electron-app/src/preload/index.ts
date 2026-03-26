import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // Request-response: renderer calls, main process handles
  invoke: (channel: string, data: unknown): Promise<unknown> => {
    const validChannels = [
      'status', 'log', 'full_install', 'run_step',
      'create_project', 'read_config', 'save_config',
      'delete_project', 'duplicate_project',
      'start_odoo', 'open_vscode', 'open_explorer',
      'window-minimize', 'window-maximize', 'window-close', 'window-is-maximized',
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

  removeAllListeners: (channel: string): void => {
    ipcRenderer.removeAllListeners(channel);
  },
});
