import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type AppState, type MirrorApi, type Progress } from '../shared/ipc.js';

const api: MirrorApi = {
  getState: () => ipcRenderer.invoke(IPC.getState),
  updateSettings: (patch) => ipcRenderer.invoke(IPC.updateSettings, patch),
  connect: () => ipcRenderer.invoke(IPC.connect),
  disconnect: () => ipcRenderer.invoke(IPC.disconnect),
  listRootCandidates: () => ipcRenderer.invoke(IPC.listRootCandidates),
  selectRoot: (choice) => ipcRenderer.invoke(IPC.selectRoot, choice),
  addFolders: (target) => ipcRenderer.invoke(IPC.addFolders, target),
  updateSftpSettings: (patch) => ipcRenderer.invoke(IPC.updateSftpSettings, patch),
  testSftp: () => ipcRenderer.invoke(IPC.testSftp),
  provisionSftpRoot: () => ipcRenderer.invoke(IPC.provisionSftpRoot),
  updatePair: (id, patch) => ipcRenderer.invoke(IPC.updatePair, id, patch),
  removePair: (id) => ipcRenderer.invoke(IPC.removePair, id),
  acknowledge: () => ipcRenderer.invoke(IPC.acknowledge),
  startClone: () => ipcRenderer.invoke(IPC.startClone),
  cancelClone: () => ipcRenderer.invoke(IPC.cancelClone),
  openLogFolder: () => ipcRenderer.invoke(IPC.openLogFolder),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  onStateChanged: (cb) => {
    const handler = (_e: unknown, state: AppState): void => cb(state);
    ipcRenderer.on(IPC.stateChanged, handler);
    return () => ipcRenderer.removeListener(IPC.stateChanged, handler);
  },
  onProgress: (cb) => {
    const handler = (_e: unknown, p: Progress): void => cb(p);
    ipcRenderer.on(IPC.progress, handler);
    return () => ipcRenderer.removeListener(IPC.progress, handler);
  },
};

contextBridge.exposeInMainWorld('mirror', api);
