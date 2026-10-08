/**
 * 移动端播放界面验收台（仅 dev 使用，不参与打包）
 *
 * 桌面浏览器里以手机视口渲染真实移动端组件，便于在没有真机时调排版：
 *   /mobile-lab.html?ui=mobile&scene=np        全屏播放详情页（有曲目、播放中）
 *   /mobile-lab.html?ui=mobile&scene=np-paused 全屏播放详情页（暂停）
 *   /mobile-lab.html?ui=mobile&scene=np-empty  全屏播放详情页（无曲目空态）
 *   /mobile-lab.html?ui=mobile&scene=np&lyrics=none  全屏播放详情页（有曲目、无歌词）
 *   /mobile-lab.html?ui=mobile&scene=bar       底部迷你播放条（有曲目）
 *   /mobile-lab.html?ui=mobile&scene=bar-empty 底部迷你播放条（无曲目）
 *   &theme=light 切浅色主题；&t=125 指定播放秒数；&cover=none 走无封面占位
 *
 * 只注入 playerStore / libraryStore 与歌词读取，组件本身零改动。
 */
import React from 'react'
import ReactDOM from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { translateDefault } from '@aurora/shared'
import './styles/globals.css'
import { PlayerBar } from '@/components/player/PlayerBar'
import { MobileNowPlaying } from '@/components/player/MobileNowPlaying'
import { usePlayerStore } from '@/stores/playerStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { platform } from '@/services/platform'
import type { Track } from '@/types'

const qs = new URLSearchParams(location.search)
const scene = qs.get('scene') ?? 'np'
const withCover = qs.get('cover') !== 'none'
const isPaused = scene.endsWith('paused')
const isEmpty = scene.endsWith('empty')
const progressSec = Number(qs.get('t') ?? '125')

if (qs.get('theme') === 'light') {
  document.documentElement.classList.remove('dark')
}

// 临时验收封面（public/ 下，构建产物里仅占 1.4KB）
const LAB_COVER_PATH = '/lab-cover.svg'

const LRC = `[00:00.00]作词：李焯雄  作曲：周传雄
[00:12.40]终于明白你已变成回忆
[00:16.80]没有言语能够说明当别人问起
[00:24.20]谱了一段旋律没有句点
[00:28.60]也无法再继续
[00:36.10]像埋伏在街头的某种气息
[00:40.50]无意间经过把往日笑与泪勾起
[00:48.00]忽然心痛的无法再压抑
[00:52.40]原来从未忘记
[00:58.20]Melody 脑海中的旋律转个不停
[01:05.60]爱过你 有太多话忘了要告诉你
[01:13.00]Melody 无数动人音符在我生命
[01:20.40]爱过你 失去你我才知道要珍惜
[01:30.00]
[01:38.80]终于落下休止符的那首歌
[01:43.20]我听着每一个音符流过的回忆
[01:50.60]为什么在那么多年以后
[01:55.00]还不能说再见
[02:02.40]Melody 脑海中的旋律如此熟悉
[02:09.80]爱过你 在我心里只能轻轻叹息
[02:17.20]Melody 无数动人音符在我生命
[02:24.60]爱过你 失去你我才知道要珍惜
[02:34.00]Melody oh Melody 我永远不能忘记
[02:38.40]你是多么的美丽 让这音乐一直不停响起
[02:45.80]Melody oh Melody 我舍不得去忘记
[02:50.20]我们快乐的过去 请别让我从这梦境清醒
[02:57.60]Melody 脑海中的旋律如此熟悉
[03:05.00]爱着你 求你听我唱完这一段旋律
[03:12.40]请不要离去
[03:20.00]Melody 你是在我脑海不停的旋律
[03:27.40]爱过你 我的心里只能无言叹息
[03:34.80]Melody 无数动人音符在生命里
[03:42.20]爱过你 失去后我才知道要珍惜你
`

// 歌词读取改为返回内置 lrc（移动端真实路径是读本地缓存 → 在线搜索，浏览器里两者都拿不到）
// &lyrics=none 模拟「这首歌没有歌词」，用于验收全屏页的空态版式
;(platform as unknown as { readLyrics: () => Promise<string | null> }).readLyrics = async () =>
  qs.get('lyrics') === 'none' ? null : LRC

const track: Track = {
  id: 'lab-track-1',
  path: '/music/Melody.flac',
  title: 'Melody',
  // 假数据：歌手与专辑都不进字典（它们是内容，不是界面文案），
  // 用通用「未知」词条占位，避免验收台里留下未国际化的中文字面量。
  // 本文件是 dev 专用单页入口（无 I18nProvider），取译文用 translateDefault。
  artist: translateDefault('common.label.unknownArtist'),
  album: translateDefault('common.label.unknownAlbum'),
  duration: 275,
  addedAt: Date.now(),
  playCount: 12,
  liked: false,
  coverPath: withCover ? LAB_COVER_PATH : undefined,
}

// 模拟 App 根 useThemeColor 的产物（真实运行时由封面提取色写入 documentElement）：
// 覆盖全屏播放页的氛围底色，取封面紫→粉→橙的色场
const root = document.documentElement
root.style.setProperty('--ambient-from', 'rgba(150, 92, 208, 0.50)')
root.style.setProperty('--ambient-to', 'rgba(206, 84, 132, 0.60)')
root.style.setProperty('--ambient-glow', 'rgba(255, 168, 118, 0.42)')

usePlayerStore.setState({
  currentTrack: isEmpty ? null : track,
  isPlaying: !isEmpty && !isPaused,
  progress: isEmpty ? 0 : progressSec,
  duration: isEmpty ? 0 : track.duration,
  volume: 0.7,
  muted: false,
  queue: isEmpty ? [] : [track],
  currentIndex: isEmpty ? -1 : 0,
})
useLibraryStore.setState({ likedTracks: new Set<string>() })

// 模拟播放中的进度推进：真实场景里 progress 持续变化会驱动歌词滚动定位。
// 这里跨行推一次（StrictMode 会双调用挂载期 effect，首挂载那一次滚动会被第二次
// 挂载打断，只有后续推进能反映真机上的定位结果）
if (!isEmpty) {
  setTimeout(() => usePlayerStore.setState({ progress: progressSec + 9 }), 900)
}

const noop = () => {}

function BarScene() {
  return (
    <div className="min-h-screen ambient-backdrop bg-background text-foreground">
      {/* 背景假内容：让播放条的玻璃材质有东西可折射 */}
      <div className="px-4 pt-[calc(env(safe-area-inset-top)+56px)] pb-40 space-y-3">
        <div className="h-7 w-32 rounded-md bg-white/[0.06]" />
        {Array.from({ length: 9 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-[10px] bg-white/[0.05]" />
            <div className="flex-1 space-y-2">
              <div className="h-3 rounded bg-white/[0.07]" style={{ width: `${52 + (i % 4) * 11}%` }} />
              <div className="h-2.5 w-20 rounded bg-white/[0.04]" />
            </div>
          </div>
        ))}
      </div>
      <div className="fixed left-1/2 -translate-x-1/2 bottom-[calc(10px+env(safe-area-inset-bottom))] w-[calc(100%-32px)] z-30">
        <PlayerBar
          currentTrack={isEmpty ? null : track}
          volume={0.7}
          muted={false}
          repeatMode="off"
          shuffleMode="on"
          onTogglePlay={noop}
          onNext={noop}
          onPrevious={noop}
          onSeek={noop}
          onVolumeChange={noop}
          onToggleMute={noop}
          onCyclePlayMode={noop}
          onOpenNowPlaying={noop}
        />
      </div>
    </div>
  )
}

function Lab() {
  if (scene.startsWith('bar'))
    return (
      // PlayerBar 内部用 useOpenSongDetail（react-router），lab 里补最小 Router 上下文
      <MemoryRouter>
        <BarScene />
      </MemoryRouter>
    )
  return (
    <div className="h-screen ambient-backdrop bg-background">
      <MobileNowPlaying open onClose={noop} />
    </div>
  )
}

console.log('[lab] module loaded', { scene, isEmpty, withCover })

try {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <Lab />
    </React.StrictMode>
  )
  console.log('[lab] render scheduled')
} catch (err) {
  console.error('[lab] render failed', err)
  document.body.setAttribute('data-lab-error', String(err))
}
