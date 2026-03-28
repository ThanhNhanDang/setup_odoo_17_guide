import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // Request-response: renderer calls, main process handles
  invoke: (channel: string, data: unknown): Promise<unknown> => {
    const validChannels = [
      'status', 'log', 'full_install', 'run_step',
      'create_project', 'read_config', 'save_config',
      'delete_project', 'duplicate_project', 'reset_templates',
      'start_odoo', 'stop_odoo', 'open_vscode', 'open_explorer', 'open_browser', 'pick-folder',
      'window-minimize', 'window-maximize', 'window-close', 'window-is-maximized',
      'update-check', 'update-download', 'update-install', 'update-info', 'update-reset-interval',
      'app-version', 'default-paths', 'odoo-versions', 'pick-icon', 'get-icon', 'reset-icon',
      'watch-log', 'unwatch-log', 'load-settings', 'save-settings',
      'open-log-window', 'log-window-pin', 'log-viewer-info', 'log-viewer-restart',
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

  onDownloadProgress: (callback: (data: { step: string; percent: number; downloadedMB: string; totalMB: string }) => void): void => {
    ipcRenderer.on('download-progress', (_event, data) => callback(data));
  },

  // Generic event listener (for push events from main process)
  onEvent: (eventName: string, callback: (...args: unknown[]) => void): void => {
    const validPushChannels = [
      'log-message', 'task-progress', 'download-progress',
      'update-status', 'project-log', 'duplicate-progress',
      'create-progress', 'delete-progress',
    ];
    if (validPushChannels.includes(eventName)) {
      ipcRenderer.on(eventName, (_event, ...args) => callback(...args));
    }
  },

  removeAllListeners: (channel: string): void => {
    ipcRenderer.removeAllListeners(channel);
  },
});
