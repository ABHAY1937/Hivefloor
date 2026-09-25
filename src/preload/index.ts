import { contextBridge, ipcRenderer } from 'electron';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (payload: any) => void;

contextBridge.exposeInMainWorld('hf', {
  call: (method: string, ...args: unknown[]) => ipcRenderer.invoke('hf:call', method, args),
  on: (channel: 'hf:events' | 'hf:pty' | 'hf:exit', fn: Handler) => {
    const listener = (_: Electron.IpcRendererEvent, payload: unknown) => fn(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  platform: process.platform
});
