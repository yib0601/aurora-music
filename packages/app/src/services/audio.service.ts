import { Howl, Howler } from 'howler'
import type { Track } from '@/types'
import { audioEvents } from './audioEvents'
import { platform } from '@/services/platform'
import { resolveCachedAudioSrc } from './audioCache.service'
import { isRemoteAudioUrl } from '@aurora/shared'
import { shouldTreatAsNoticeClip } from '@/lib/audioGuard'
import { normalizePlaybackRate } from '@/lib/playbackRate'

let tickInterval: ReturnType<typeof setInterval> | null = null
let currentHowl: Howl | null = null
let nextHowl: Howl | null = null
let audioContext: AudioContext | null = null
let analyserNode: AnalyserNode | null = null
let currentMediaSource: MediaElementAudioSourceNode | null = null

// 播放会话号：在线曲目播放前要异步查缓存，期间用户可能已切歌，
// 回调里校验会话号，避免把旧曲目的 Howl 建出来覆盖新播放
let playSession = 0

const FADE_DURATION = 800 // ms

/**
 * 桌面端播放速率（模块级，随每个新建 Howl 重新应用）。
 *
 * 为什么存在这里而不是每次调用都从 store 取：`startHowl` 有异步分支
 * （在线曲目先查缓存再建 Howl，见 playTrack 的 session 校验），store 是
 * zustand 的全局单例、在音频服务里反向 import 会形成模块级循环依赖
 * （playerStore → audio.service 已经是单向的）。这里保留一份镜像，
 * 由 playerStore 的 setPlaybackRate / 持久化恢复两处写入。
 *
 * ⚠️ Howler 的 rate 是**每个 Howl 实例独立**的：新建 Howl 不会继承上一个
 * 实例的速率，所以 startHowl 必须每次重新应用（见下方 applyRate）。
 */
let currentRate = 1

/** 当前生效的桌面端速率（供测试与诊断读取，避免直接摸私有字段） */
export function getPlaybackRate(): number {
  return currentRate
}

/**
 * 设置桌面端播放速率：镜像到模块级，并立即应用到当前 Howl。
 *
 * 移动端不走这里——原生 MediaPlayer 桥没有变速通道（见 mediaSession.ts 的
 * setPlaybackRateAvailable），能力判据由播放器 UI 使用。
 */
export function setPlaybackRate(rate: number): void {
  currentRate = normalizePlaybackRate(rate)
  if (currentHowl) {
    applyRate(currentHowl)
  }
}

/**
 * 把速率应用到某个 Howl。
 *
 * ## 为什么不能只调一次 `howl.rate()`
 *
 * Howler 的 `rate()` 在 `_state !== 'loaded'` **或 `_playLock` 为真**时**不生效**，
 * 只是把动作推进它自己的 `_queue`（见 howler.js `rate:` 分支）。那两个条件在
 * `html5: true` 模式下恰恰是起播时的常态：`play()` 会先置 `_playLock = true`、
 * 再把 `_state` 置为 `'loading'`，直到元素 `canplay` 才释放。
 *
 * 而 `_loadQueue()` **只清掉队首那一条匹配事件的任务**，且只在
 * `if (parent._state !== 'loaded')` 那个分支里被调用一次。于是：
 *
 * - 起播瞬间写一次 → 入队 → 后续没有任何东西把它重新跑一遍；
 * - 同一个 Howl 上再写一次 → 队列里堆两条（实测 `_queue.length === 2`）→ 都不生效。
 *
 * 表现就是**变速静默失效**：`store.playbackRate` 显示 2，进度条仍按 1× 走，
 * 控制台一句话都没有。这正是本轮实测抓到的真缺陷（旧实现的两处调用都落在这个坑里）。
 *
 * ## 现在的做法
 *
 * 写入前先看 Howler 的两个闸门；关着就等它开（`loaded` + 未加锁）再写一次，
 * 不依赖 Howler 的队列时序。等待有次数上限，超时后放弃并留一条诊断日志 ——
 * 变速是附加能力，不能因为它卡住播放链路。
 */
function applyRate(howl: Howl, attempt = 0): void {
  const h = howl as unknown as {
    _state?: string
    _playLock?: boolean
    rate: (r: number) => unknown
  }

  // Howler 此刻接不了速率：等一个可写的时机再写（`once('load')` 之外还要避开
  // `_playLock` —— 实测 `load` 事件发出时 `_playLock` 仍可能为真）。
  //
  // 判定写成「**明确处于加载中**」而不是「不等于 loaded」：内部字段缺失
  // （`_state === undefined`，例如较新的 Howler 改了私有字段名、或单测里的替身）
  // 时应当**照常写入**。反过来写会把一处内部实现细节变成硬依赖：字段一改名，
  // 变速就会静默失效，而它本该只是"这一帧不确定，先试一次"。
  const loading = h._state === 'loading' || h._state === 'unloaded'
  if (loading || h._playLock) {
    if (attempt >= RATE_APPLY_MAX_ATTEMPTS) {
      // 放弃但不影响播放：这条日志是给"用户报变速无效"时定位用的唯一线索
      console.warn('[播放] 速率未能应用（Howler 长时间不可写）:', {
        rate: currentRate,
        state: h._state,
        playLock: h._playLock,
      })
      return
    }
    rateApplyTimers.set(howl, setTimeout(() => {
      rateApplyTimers.delete(howl)
      applyRate(howl, attempt + 1)
    }, RATE_APPLY_RETRY_MS))
    return
  }

  try {
    // ⚠️ 每次都用**当前**的 `currentRate`，不接受调用点传进来的快照值。
    //
    // 快照会造成一个只在时序里才出现的缺陷：用户连点两档（1× → 2× → 0.5×）时，
    // 前一次的重试还挂在同一个 Howl 上，等它到点执行就会把中间那个 2× 写回去 ——
    // 用户看到的是「最后一次选择没生效，停在倒数第二次」。实测已复现。
    // 读全局值让所有在途重试自然收敛到"最后一次用户意图"，也省掉一次参数传递。
    h.rate(currentRate)
  } catch (err) {
    // 越界速率在部分内核上会让 HTMLMediaElement.playbackRate 抛
    // InvalidStateError。变速是附加能力，不能因此中断播放
    console.warn('[播放] 设置播放速率失败:', currentRate, err)
  }
}

/**
 * 待写入速率的 Howl → 定时器。
 *
 * 为什么按 Howl 记而不是一个全局定时器：切歌时旧 Howl 会被 unload，
 * 它还挂着的重试必须能被取消（见 `stopPlayback` / `startHowl` 的清理），
 * 否则旧实例的重试会在新实例上跑一遍，把速率写成上一个用户设定值。
 */
const rateApplyTimers = new WeakMap<Howl, ReturnType<typeof setTimeout>>()

/** 重试间隔：Howler 的 `_playLock` 在 canplay 后释放，实测量级是几十毫秒 */
const RATE_APPLY_RETRY_MS = 40
/** 重试上限：40ms × 50 ≈ 2s，足够覆盖慢速网络下的首次 canplay；再久就没有意义了 */
const RATE_APPLY_MAX_ATTEMPTS = 50

/** 取消某个 Howl 上尚未执行的重试（切歌 / 停止时调用） */
function cancelRateApply(howl: Howl | null): void {
  if (!howl) return
  const timer = rateApplyTimers.get(howl)
  if (timer !== undefined) {
    clearTimeout(timer)
    rateApplyTimers.delete(howl)
  }
}

function getPlatformSrc(path: string): string {
  // 已带协议的地址（在线歌源直链 https://、远端媒体库代理 aurora-remote://）直接返回；
  // 其余（本机绝对路径、web 平台的 web:<key>/<rel> 前缀）委托 platform 层转换协议
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    return path
  }
  // 委托 platform 层处理协议转换（桌面端 cover-local://，移动端 Capacitor.convertFileSrc）
  return platform.getAudioSrc(path)
}

/**
 * 是否是需要走"流式"路径的地址（在线歌源直链 / 远端媒体库代理）。
 *
 * 判据不只看 http(s)：aurora-remote:// 是指向 WebDAV 的自定义协议，播放器拿到
 * 的是跨源资源，Web Audio 的 MediaElementSource 在没有可靠 CORS 保证时会让
 * 元素输出被浏览器静音（与在线流同一个坑），因此可视化必须一并降级跳过。
 */
function isStreamingSrc(src: string): boolean {
  return /^https?:\/\//i.test(src) || isRemoteAudioUrl(src)
}

function startTick(howl: Howl) {
  if (tickInterval) clearInterval(tickInterval)
  // ⚠️ 性能：500ms 足够进度条显示，过高频率会触发 LyricsView/PlayerBar 频繁更新
  tickInterval = setInterval(() => {
    const progress = howl.seek() as number
    if (typeof progress === 'number' && !isNaN(progress)) {
      audioEvents.emit('progress', { currentTime: progress })
    }
  }, 500)
}

function stopTick() {
  if (tickInterval) {
    clearInterval(tickInterval)
    tickInterval = null
  }
}

export function initAudioAnalyser(): AnalyserNode | null {
  try {
    const AC = window.AudioContext || (window as any).webkitAudioContext
    if (!AC) return null

    if (!audioContext) {
      audioContext = new AC()
      analyserNode = audioContext.createAnalyser()
      analyserNode.fftSize = 2048
      analyserNode.smoothingTimeConstant = 0.8
      analyserNode.connect(audioContext.destination)
    }
    return analyserNode
  } catch {
    return null
  }
}

export function getAnalyser(): AnalyserNode | null {
  return analyserNode
}

export function playTrack(track: Track, volume: number = 0.7, muted: boolean = false, autoplay: boolean = true): void {
  const targetVolume = muted ? 0 : volume

  // 处理旧 howl：立即停止播放并清理,避免新旧 Howl 同时播放导致重叠声音
  // 注:为保持切换流畅,不使用异步 fade out——旧 Howl 立即 unload,新 Howl fade in
  if (currentHowl) {
    const oldHowl = currentHowl
    // 立即停止输出(即使 unload 之前的 fade 也已无效)
    oldHowl.volume(0)
    // 取消旧实例上挂着的速率重试：不清会在新曲目上跑一遍，把速率写成旧值
    cancelRateApply(oldHowl)
    oldHowl.unload()
    currentHowl = null
  }
  // 清理旧 MediaElementSource 节点
  if (currentMediaSource) {
    try { currentMediaSource.disconnect() } catch {}
    currentMediaSource = null
  }
  stopTick()

  // 在线歌源直链优先（易失，取到就用）；其次是远端媒体库代理地址（长期有效）；
  // 最后才是本机路径
  const rawPath = track.onlineUrl || track.remoteUrl || track.path
  const src = getPlatformSrc(rawPath)
  const isOnline = isStreamingSrc(rawPath)
  const session = ++playSession

  // 在线曲目先查本地播放缓存：命中则播放地址换成 aurora-cache:// 本地文件
  // （直链过期也能播）；未命中时主进程已在后台拉流写缓存，本次仍走源直链。
  // 非在线曲目与平台不支持缓存时同步直建，不引入额外延迟
  if (track.onlineUrl && track.onlineSource) {
    resolveCachedAudioSrc(track)
      .then((cached) => {
        if (session !== playSession) return
        startHowl(track, cached || src, isOnline, targetVolume, autoplay)
      })
      .catch(() => {
        if (session !== playSession) return
        startHowl(track, src, isOnline, targetVolume, autoplay)
      })
    return
  }
  startHowl(track, src, isOnline, targetVolume, autoplay)
}

function startHowl(track: Track, src: string, isOnline: boolean, targetVolume: number, autoplay: boolean): void {
  if (isOnline) {
    // howler 会复用 html5 Audio 元素池：曾被 createMediaElementSource 绑定的元素
    // 输出永久走 AudioContext，在线流跨域时会被浏览器静音。播放在线流前把已包装的
    // 元素从池中剔除，确保 howler 分配全新 Audio（可视化对在线流已降级跳过）
    const pool = (Howler as any)?._html5AudioPool
    if (Array.isArray(pool)) {
      ;(Howler as any)._html5AudioPool = pool.filter((el: any) => !el?.__auroraSource)
    }
  }

  const howl = new Howl({
    src: [src],
    html5: true,
    format: isOnline ? undefined : detectFormat(track.path),
    volume: 0, // 初始为 0，播放后 fade in
    onplay: () => {
      audioEvents.emit('play', { track })
      // 触发播放统计事件，libraryStore 独立订阅更新曲库数据
      audioEvents.emit('playStatsUpdate', {
        trackId: track.id,
        lastPlayedAt: Date.now(),
        playCount: (track.playCount || 0) + 1,
        track,
      })
      if (audioContext && audioContext.state === 'suspended') {
        audioContext.resume()
      }
      startTick(howl)
    },
    onpause: () => {
      audioEvents.emit('pause', {})
      stopTick()
    },
    onstop: () => {
      audioEvents.emit('stop', {})
      stopTick()
    },
    onend: () => {
      stopTick()
      audioEvents.emit('end', {})
    },
    onload: () => {
      const dur = howl.duration()
      // 新 Howl 的 rate 不会继承上一个实例（Howler 的速率是按 Howl 存的），
      // 这里同步再落一次，保证「切歌后速率回到用户设定」而不是悄悄变回 1×
      applyRate(howl)
      // 上源提示音 / 试听片段闸门：实际时长远短于**元数据时长**时，这个地址指向的是
      // 版权提示音或试听片段，不是本曲音频。判据是比例（见 lib/audioGuard），
      // 不是「小于 10 秒」——实测片段是 48~221 秒，绝对阈值会整批漏过。
      // 旧行为会照播半分钟再自动跳下一首，用户只看到进度条闪一下、歌没了，
      // 还以为「这首歌不能放」。这里当场停住并如实说明原因。
      // 元数据缺失（源把 duration 写成 0）时退化为「实际很短即异常」的兜底：
      // 见 audioGuard 的说明。
      // 不走「加载失败」分支：网络来源曲目本就该留在队列里（见 audioEvents.error 注释）。
      if (shouldTreatAsNoticeClip(track, dur, isOnline)) {
        stopTick()
        try {
          howl.unload()
        } catch {
          /* 已卸载/未完成装载时 unload 抛错无害 */
        }
        currentHowl = null
        audioEvents.emit('error', {
          error: { code: 'shortStream', actual: dur, expected: track.duration || 0 },
          trackId: track.id,
        })
        return
      }
      audioEvents.emit('duration', { duration: dur })
    },
    onloaderror: (_id, error) => {
      console.error('Audio load error:', error)
      // 带上出错的曲目：切歌后旧 Howl 的失败回调可能晚到，
      // 订阅方据此判断该不该动当前曲目（见 audioEvents 的 error 注释）
      audioEvents.emit('error', { error, trackId: track.id })
    },
    onplayerror: (_id, error) => {
      console.error('Audio play error:', error)
      howl.once('unlock', () => howl.play())
    },
  })

  currentHowl = howl
  audioEvents.emit('trackChange', { track })

  if (autoplay) {
    howl.play()
    // 淡入到目标音量
    howl.fade(0, targetVolume, FADE_DURATION)
  } else {
    // 不自动播放（断点续播场景），直接设置目标音量
    howl.volume(targetVolume)
  }

  connectAnalyser(howl, isOnline)
}

/**
 * 预加载下一首曲目（gapless 播放预留接口）
 * TODO: 实现真正的无缝播放需要 playerStore 提供 getNextTrack() 方法
 */
export function preloadNextTrack(_track: Track, _volume: number, _muted: boolean): void {
  // 预留接口，暂不实现
}

function connectAnalyser(howl: Howl, isOnline = false) {
  // 在线流不接入 Web Audio：跨域音源无 CORS 头，createMediaElementSource 后
  // 元素输出会被浏览器强制静音（进度正常走但没有声音），可视化对在线流降级跳过
  if (isOnline) return
  if (!analyserNode) {
    initAudioAnalyser()
  }
  if (!analyserNode || !audioContext) return

  try {
    // ⚠️ howler 私有 API：防御性访问，内部结构变化时静默降级（无可视化但正常出声）
    const audioEl = (howl as any)?._sounds?.[0]?._node
    if (audioEl && audioEl instanceof HTMLMediaElement) {
      // 同一个 audioEl 只能创建一次 MediaElementSource,否则抛 InvalidStateError
      // 用属性标记缓存,避免重复创建;但 howler 会复用 html5 Audio 元素,
      // 切歌时命中缓存也需强制重连 analyser,否则 AudioContext 挂起导致不播放、进度卡 00:00
      let source = (audioEl as any).__auroraSource
      if (!source) {
        source = audioContext.createMediaElementSource(audioEl)
        ;(audioEl as any).__auroraSource = source
      }
      try { source.disconnect() } catch {}
      source.connect(analyserNode)
      currentMediaSource = source
    } else {
      console.warn('Analyser: 无法获取 audio 元素，跳过可视化连接')
    }
  } catch (e) {
    console.warn('Analyser connection failed:', e)
  }
}

export function pausePlayback(): void {
  if (currentHowl && currentHowl.playing()) {
    currentHowl.pause()
  }
}

export function resumePlayback(): void {
  if (currentHowl) {
    currentHowl.play()
  }
}

/** 当前是否持有 Howl 实例（用于判断 togglePlay 是否需要重建播放器） */
export function hasCurrentHowl(): boolean {
  return currentHowl !== null
}

export function seekTo(seconds: number): void {
  if (currentHowl) {
    currentHowl.seek(seconds)
    audioEvents.emit('progress', { currentTime: seconds })
  }
}

export function setVolume(volume: number): void {
  if (currentHowl) {
    currentHowl.volume(volume)
  }
}

export function setMuted(muted: boolean, volume: number = 0.7): void {
  if (currentHowl) {
    currentHowl.volume(muted ? 0 : volume)
  }
}

export function togglePlayPause(isPlaying: boolean): void {
  if (isPlaying) {
    pausePlayback()
  } else {
    resumePlayback()
  }
}

export function stopPlayback(): void {
  if (currentHowl) {
    cancelRateApply(currentHowl)
    currentHowl.stop()
    currentHowl.unload()
    currentHowl = null
  }
  if (nextHowl) {
    nextHowl.unload()
    nextHowl = null
  }
  if (currentMediaSource) {
    try { currentMediaSource.disconnect() } catch {}
    currentMediaSource = null
  }
  stopTick()
}

function detectFormat(path: string): string | undefined {
  const ext = path.split('.').pop()?.toLowerCase()
  if (!ext) return undefined
  const map: Record<string, string> = {
    mp3: 'mp3',
    flac: 'flac',
    m4a: 'mp4',
    aac: 'aac',
    ogg: 'ogg',
    wav: 'wav',
    wma: 'wma',
  }
  return map[ext]
}

export function cleanupAudio(): void {
  stopPlayback()
  if (audioContext) {
    audioContext.close()
    audioContext = null
    analyserNode = null
  }
}

/**
 * 为当前 Howl 注册一次性的 load 回调,用于断点续播场景下精确 seek
 * 如果 Howl 已加载则立即调用 callback
 */
export function onCurrentTrackLoad(callback: () => void): void {
  if (!currentHowl) return
  const dur = currentHowl.duration()
  // Howl duration() 在未加载时返回 0
  if (dur && isFinite(dur) && dur > 0) {
    callback()
  } else {
    currentHowl.once('load', callback)
  }
}

export function setOutputDevice(deviceId: string): void {
  if (!currentHowl) return
  const audioEl = (currentHowl as any)._sounds?.[0]?._node
  if (audioEl && typeof (audioEl as any).setSinkId === 'function') {
    (audioEl as any).setSinkId(deviceId).catch((e: any) => {
      console.warn('Failed to set audio output device:', e)
    })
  }
}
