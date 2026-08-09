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
    return ipcRenderer.invoke('lyrics:save', lyrics, trackId)
  },
  readLyrics: async (trackId: string): Promise<string | null> => {
    return ipcRenderer.invoke('lyrics:read', trackId)
  },
  searchLyrics: async (
    query: string,
    artist?: string,
    album?: string,
    duration?: number
  ): Promise<{ lrc: string | null; name: string; artist: string } | null> => {
    return ipcRenderer.invoke('lyrics:search', query, artist, album, duration)
  },
  searchOnlineTracks: async (
    query: string
  ): Promise<
    Array<{
      id: string
      title: string
      artist: string
      album: string
      duration: number
      coverUrl?: string
      audioUrl: string
      source: 'netease' | 'qq' | 'kugou'
    }>
  > => {
    return ipcRenderer.invoke('tracks:searchOnline', query)
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
  getBounds: (): Promise<{ x: number; y: number; width: number; height: number } | null> =>
    ipcRenderer.invoke('window:getBounds'),
  setBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke('window:setBounds', bounds),
  onTracksScanned: (callback: (tracks: any[]) => void) => {
    ipcRenderer.on('scan:complete', (_event, tracks) => callback(tracks))
  },
  onScanProgress: (callback: (progress: { current: number; total: number; file: string }) => void) => {
    ipcRenderer.on('scan:progress', (_event, progress) => callback(progress))
  },
  onMediaControl: (callback: (action: string) => void) => {
    ipcRenderer.on('media-control', (_event, action) => callback(action))
  },
  updateMprisMetadata: (track: any, isPlaying: boolean) => {
    ipcRenderer.send('mpris:updateMetadata', track, isPlaying)
  },
  isMaximized: false,
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

export type ElectronAPI = typeof electronAPI
