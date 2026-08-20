import { contextBridge, ipcRenderer } from 'electron'

const electronAPI = {
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFolder'),
  readDir: (dirPath: string) => ipcRenderer.invoke('fs:readDir', dirPath),
  readFile: (filePath: string): Promise<ArrayBuffer> => ipcRenderer.invoke('fs:readFile', filePath),
  scanFolder: (folderPath: string): Promise<any[]> => ipcRenderer.invoke('scan:start', folderPath),
  getUserDataPath: (): Promise<string> => ipcRenderer.invoke('app:getUserDataPath'),
  getAllTracks: (): Promise<any[]> => ipcRenderer.invoke('db:getAllTracks'),
  getTrack: (id: string): Promise<any | null> => ipcRenderer.invoke('tracks:get', id),
  // 按需补齐封面（扫描时为提速跳过了嵌入图片，UI 需要时单独提取）
  ensureCover: (id: string): Promise<string | null> => ipcRenderer.invoke('covers:ensure', id),
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
    query: string,
    options?: { customSources?: Array<{ id: string; name: string; apiUrl: string; enabled: boolean }>; useNetease?: boolean; useQQ?: boolean }
  ): Promise<
    Array<{
      id: string
      title: string
      artist: string
      album: string
      duration: number
      coverUrl?: string
      audioUrl: string
      source: 'netease' | 'qq' | 'kugou' | 'custom'
      sourceName?: string
    }>
  > => {
    return ipcRenderer.invoke('tracks:searchOnline', query, options)
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
    const handler = (_event: unknown, tracks: any[]) => callback(tracks)
    ipcRenderer.on('scan:complete', handler)
    return () => ipcRenderer.removeListener('scan:complete', handler)
  },
  onTrackScanned: (callback: (track: any) => void) => {
    const handler = (_event: unknown, track: any) => callback(track)
    ipcRenderer.on('track:scanned', handler)
    return () => ipcRenderer.removeListener('track:scanned', handler)
  },
  onScanError: (callback: (error: { folder: string; message: string }) => void) => {
    const handler = (_event: unknown, error: { folder: string; message: string }) => callback(error)
    ipcRenderer.on('scan:error', handler)
    return () => ipcRenderer.removeListener('scan:error', handler)
  },
  onMediaControl: (callback: (action: string) => void) => {
    const handler = (_event: unknown, action: string) => callback(action)
    ipcRenderer.on('media-control', handler)
    return () => ipcRenderer.removeListener('media-control', handler)
  },
  updateMprisMetadata: (track: any, isPlaying: boolean) => {
    ipcRenderer.send('mpris:updateMetadata', track, isPlaying)
  },
  isMaximized: false,
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

export type ElectronAPI = typeof electronAPI
