import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { usePlayerStore } from '@/stores/playerStore'
import { formatTime } from '@/lib/utils'

/**
 * 播放进度插值 + 命令式渲染：把 2Hz 的轮询进度补成逐帧进度。
 *
 * 为什么要它：
 *   移动端 position 由 playerStore 每 500ms 轮询原生快照写回（见 nativeTicker），
 *   进度条直接绑 store 值会一格一格跳；而且每次跳都会重渲染整棵播放页（含歌词）。
 *   原做法用 CSS transition 追帧掩盖台阶，代价是「永远慢半拍」且重渲染照旧。
 *
 * 做法（与 NeriPlayer 的 WaveProgressPredictor 同构）：
 *   以最新快照为锚点，播放中按帧外推；所有写入走命令式 DOM（input.value /
 *   --seek / textContent），因此 progress 变化不再触发 React 渲染 —— 只在
 *   切歌、暂停/播放这类低频字段变化时才重渲染。
 *
 * seek 锁定：
 *   seekTo 会乐观写目标位置，但紧随其后的轮询可能仍读到原生旧位置，
 *   把进度条拉回去。这里在提交后短暂锁定显示位置，等原生真实位置追平
 *   才恢复跟随。锁定窗口内的时间文本与滑块都停在目标点上。
 */

/** seek 后原生位置追到这个容差内即认为已对齐（秒） */
const SEEK_SETTLE_TOLERANCE_SEC = 0.28
/** 提交后先锁定这么久，避开 seekTo 的乐观写与第一次迟到的轮询（毫秒） */
const SEEK_LOCK_MIN_MS = 400
/** 原生迟迟不追平（引擎卡住）时放弃锁定，避免进度条永久停在目标点（毫秒） */
const SEEK_LOCK_TIMEOUT_MS = 2_500
/** 帧间隔超过这个值即认定页面被挂起过（后台标签 / WebView 被系统冻结，毫秒） */
const FRAME_GAP_RESYNC_MS = 800

export interface PlaybackProgressController {
  /** 进度滑块（非受控：值由这里的 rAF 写，拖动交给浏览器自身处理） */
  sliderRef: RefObject<HTMLInputElement>
  /** 左侧当前时间文本节点 */
  timeRef: RefObject<HTMLSpanElement>
  /** 拖动开始：让位给浏览器滑块，暂停外推 */
  onSeekStart: () => void
  /** 拖动结束（pointerup / pointercancel）：提交 seek 并进入锁定窗口 */
  onSeekCommit: () => void
}

interface Options {
  /** 总时长（秒），0 表示未知 */
  duration: number
  /** 是否接管进度渲染（无曲目 / 浮层关闭时应传 false） */
  active: boolean
}

export function usePlaybackProgress({ duration, active }: Options): PlaybackProgressController {
  const sliderRef = useRef<HTMLInputElement>(null)
  const timeRef = useRef<HTMLSpanElement>(null)

  /** 外推锚点：最近一次快照位置 + 采样时刻 */
  const anchorRef = useRef({ position: 0, at: 0 })
  /** 当前显示位置（拖动中即浏览器滑块值） */
  const displayRef = useRef(0)
  /** seek 锁定：非空时显示位置冻结在目标点 */
  const pendingSeekRef = useRef<{ position: number; at: number } | null>(null)
  const seekingRef = useRef(false)
  const playingRef = useRef(false)
  const wasPlayingRef = useRef(false)
  const durationRef = useRef(duration)
  const activeRef = useRef(active)
  const lastTimeTextRef = useRef('')

  durationRef.current = duration
  activeRef.current = active

  // 快照 → 锚点。手动订阅而不是 usePlayerStore(selector)：progress 每 500ms
  // 变一次，走 React 会连带歌词一起重渲染，这里只需要更新 ref。
  useEffect(() => {
    const resync = (position: number) => {
      anchorRef.current = { position, at: performance.now() }
      displayRef.current = position
    }
    const initial = usePlayerStore.getState()
    playingRef.current = initial.isPlaying
    resync(initial.progress)

    return usePlayerStore.subscribe((state, prev) => {
      playingRef.current = state.isPlaying

      // 切歌：清掉锁定与拖动态，直接跟随新曲目的位置（0 或持久化进度）
      if (state.currentTrack?.id !== prev.currentTrack?.id) {
        pendingSeekRef.current = null
        seekingRef.current = false
        resync(state.progress)
        return
      }

      if (state.progress === prev.progress) return

      const pending = pendingSeekRef.current
      if (pending) {
        const lockedFor = performance.now() - pending.at
        const settled =
          lockedFor >= SEEK_LOCK_MIN_MS &&
          Math.abs(state.progress - pending.position) <= SEEK_SETTLE_TOLERANCE_SEC
        if (!settled && lockedFor < SEEK_LOCK_TIMEOUT_MS) return
        pendingSeekRef.current = null
      }

      // 拖动期间不允许轮询值回写锚点，否则滑块会被拽走
      if (seekingRef.current) return
      resync(state.progress)
    })
  }, [])

  useEffect(() => {
    const writeFrame = (position: number, dur: number, seeking: boolean) => {
      const slider = sliderRef.current
      if (slider) {
        if (!seeking) {
          // 保留两位小数：够精细，又不至于每帧写一个超长字符串
          const next = String(Number(position.toFixed(2)))
          if (slider.value !== next) slider.value = next
        }
        slider.style.setProperty('--seek', `${dur > 0 ? (position / dur) * 100 : 0}%`)
      }
      const timeEl = timeRef.current
      if (timeEl) {
        const text = formatTime(position)
        if (text !== lastTimeTextRef.current) {
          lastTimeTextRef.current = text
          timeEl.textContent = text
        }
      }
    }

    // 不接管时把进度归零并停掉循环（浮层关闭 / 无曲目：不得残留上次会话的进度）
    if (!active) {
      displayRef.current = 0
      pendingSeekRef.current = null
      seekingRef.current = false
      writeFrame(0, durationRef.current, false)
      return
    }

    let raf = 0
    let lastFrameAt = performance.now()
    const frame = () => {
      raf = requestAnimationFrame(frame)

      const now = performance.now()
      // 帧间出现大空档 = 页面被挂起过（切到后台、WebView 被系统冻结）。
      // 这段时长不属于播放进度，必须先锚回挂起前的位置，否则回前台时
      // 进度条会瞬间冲出很远；真实位置由随后的轮询快照校准
      if (now - lastFrameAt > FRAME_GAP_RESYNC_MS) {
        anchorRef.current = { position: displayRef.current, at: now }
      }
      lastFrameAt = now

      const playing = playingRef.current
      // 播放态切换：以当前显示位置重设锚点，否则暂停时长会被算进外推
      if (playing !== wasPlayingRef.current) {
        wasPlayingRef.current = playing
        anchorRef.current = { position: displayRef.current, at: now }
      }

      const dur = durationRef.current
      const seeking = seekingRef.current
      // 锁定超时必须在帧循环里兜底：解除条件挂在 store 更新上时，遇到引擎无响应
      // （或浏览器里没有原生引擎）就永远等不到那次更新，进度条会冻结在目标点
      const pending = pendingSeekRef.current
      if (pending && now - pending.at > SEEK_LOCK_TIMEOUT_MS) {
        pendingSeekRef.current = null
      }
      const locked = pendingSeekRef.current
      let position: number

      if (seeking) {
        position = Number(sliderRef.current?.value ?? 0) || 0
      } else if (locked) {
        // 锁定窗口：停在目标点等原生追平，避免被迟到的那次轮询拉回去
        position = locked.position
      } else {
        const anchor = anchorRef.current
        position = anchor.position + (playing ? (now - anchor.at) / 1000 : 0)
      }

      if (dur > 0) position = Math.min(position, dur)
      if (!(position >= 0)) position = 0

      displayRef.current = position
      writeFrame(position, dur, seeking)
    }

    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [active])

  const onSeekStart = useCallback(() => {
    seekingRef.current = true
    pendingSeekRef.current = null
  }, [])

  const onSeekCommit = useCallback(() => {
    const slider = sliderRef.current
    if (!slider) return
    const target = Number(slider.value) || 0
    seekingRef.current = false
    displayRef.current = target
    anchorRef.current = { position: target, at: performance.now() }
    pendingSeekRef.current = { position: target, at: performance.now() }
    usePlayerStore.getState().seekTo(target)
  }, [])

  return { sliderRef, timeRef, onSeekStart, onSeekCommit }
}
