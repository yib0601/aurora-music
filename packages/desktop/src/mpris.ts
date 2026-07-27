import { BrowserWindow } from 'electron'
import path from 'path'

let mprisPlayer: any = null
let mainWindow: BrowserWindow | null = null

export function initMpris(win: BrowserWindow) {
  mainWindow = win

  // 仅在 Linux 上启用 MPRIS
  if (process.platform !== 'linux') {
    console.log('[MPRIS] Not on Linux, skipping MPRIS initialization')
    return
  }

  try {
    const Player = require('mpris-service')
    
    mprisPlayer = Player({
      name: 'aurora-music',
      identity: 'Aurora Music',
      supportedInterfaces: ['player'],
    })

    console.log('[MPRIS] MPRIS service initialized successfully')

    // 设置初始状态
    mprisPlayer.playbackStatus = 'Stopped'
    mprisPlayer.canPlay = false
    mprisPlayer.canPause = false
    mprisPlayer.canGoNext = false
    mprisPlayer.canGoPrevious = false
    mprisPlayer.canSeek = false

    // 监听媒体键事件
    mprisPlayer.on('play', () => {
      console.log('[MPRIS] Play button pressed')
      mainWindow?.webContents.send('media-control', 'toggle-play')
    })

    mprisPlayer.on('pause', () => {
      console.log('[MPRIS] Pause button pressed')
      mainWindow?.webContents.send('media-control', 'toggle-play')
    })

    mprisPlayer.on('playpause', () => {
      console.log('[MPRIS] Play/Pause button pressed')
      mainWindow?.webContents.send('media-control', 'toggle-play')
    })

    mprisPlayer.on('next', () => {
      console.log('[MPRIS] Next button pressed')
      mainWindow?.webContents.send('media-control', 'next')
    })

    mprisPlayer.on('previous', () => {
      console.log('[MPRIS] Previous button pressed')
      mainWindow?.webContents.send('media-control', 'previous')
    })

    mprisPlayer.on('stop', () => {
      console.log('[MPRIS] Stop button pressed')
      mainWindow?.webContents.send('media-control', 'stop')
    })

    mprisPlayer.on('seek', (offset: number) => {
      console.log('[MPRIS] Seek:', offset)
      mainWindow?.webContents.send('media-seek', offset)
    })

    mprisPlayer.on('quit', () => {
      console.log('[MPRIS] Quit requested')
      mainWindow?.close()
    })

  } catch (error) {
    console.error('[MPRIS] Failed to initialize MPRIS service:', error)
  }
}

export function updateMprisMetadata(track: any, isPlaying: boolean) {
  if (!mprisPlayer) return

  try {
    mprisPlayer.playbackStatus = isPlaying ? 'Playing' : 'Paused'
    mprisPlayer.canPlay = true
    mprisPlayer.canPause = true
    mprisPlayer.canGoNext = true
    mprisPlayer.canGoPrevious = true
    mprisPlayer.canSeek = true

    if (track) {
      mprisPlayer.metadata = {
        'mpris:trackid': mprisPlayer.objectPath('track/' + track.id),
        'mpris:length': (track.duration || 0) * 1000000, // 微秒
        'xesam:title': track.title || 'Unknown',
        'xesam:artist': track.artist ? [track.artist] : ['Unknown'],
        'xesam:album': track.album || 'Unknown',
      }

      // 如果有封面,添加封面
      if (track.coverPath) {
        mprisPlayer.metadata['mpris:artUrl'] = `file://${track.coverPath}`
      }
    } else {
      mprisPlayer.metadata = {}
    }
  } catch (error) {
    console.error('[MPRIS] Failed to update metadata:', error)
  }
}

export function cleanupMpris() {
  if (mprisPlayer) {
    try {
      mprisPlayer.playbackStatus = 'Stopped'
      mprisPlayer = null
    } catch (error) {
      console.error('[MPRIS] Failed to cleanup:', error)
    }
  }
}
