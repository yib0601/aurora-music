import { contextBridge, ipcRenderer } from 'electron'

const electronAPI = {
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFolder'),
  readDir: (dirPath: string) => ipcRenderer.invoke('fs:readDir', dirPath),
  readFile: (filePath: string): Promise<ArrayBuffer> => ipcRenderer.invoke('fs:readFile', filePath),
  scanFolder: (folderPath: string): Promise<any[]> => ipcRenderer.invoke('scan:start', folderPath),
  getUserDataPath: (): Promise<string> => ipcRenderer.invoke('app:getUserDataPath'),
  getAllTracks: (): Promise<any[]> => ipcRenderer.invoke('db:getAllTracks'),
  saveCover: async (coverData: ArrayBuffer, trackId: string): Promise<string> => {
    return ''
  },
  saveLyrics: async (lyrics: string, trackId: string): Promise<string> => {
    return ''
  },
  readLyrics: async (trackId: string): Promise<string | null> => {
    return null
  },
  getMetadata: async (filePath: string) => {
    return ipcRenderer.invoke('fs:readFile', filePath)
  },
  windowControls: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:isMaximized'),
  },
  onTracksScanned: (callback: (tracks: any[]) => void) => {
    ipcRenderer.on('scan:complete', (_event, tracks) => callback(tracks))
  },
  onScanProgress: (callback: (progress: { current: number; total: number; file: string }) => void) => {
    ipcRenderer.on('scan:progress', (_event, progress) => callback(progress))
  },
  isMaximized: false,
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

export type ElectronAPI = typeof electronAPI
