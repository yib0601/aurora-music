import { useEffect, useState } from 'react'
import { Gauge, Timer } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'
import { usePlayerStore, isPlaybackRateAvailable } from '@/stores/playerStore'
import { formatRateValue, PLAYBACK_RATE_PRESETS } from '@/lib/playbackRate'
import {
  SLEEP_TIMER_PRESETS,
  formatSleepRemaining,
  sleepRemainingMs,
} from '@/lib/sleepTimer'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/**
 * 睡眠定时器倒计时的刷新间隔（毫秒）。
 *
 * 1 秒是本组件唯一的定时器，且只在**定时器运行中**才挂着（见下方 useEffect 的
 * 依赖）。刻意不复用 store 里的任何 tick：剩余量由结束时间戳推导
 * （`sleepRemainingMs`），这个 interval 只负责让**显示**追上真实时钟。
 * 后台节流会让它跑得稀，但那只会让数字少跳几格，不会影响到点判定。
 */
const SLEEP_DISPLAY_TICK_MS = 1000

/**
 * 「播放系列操作」菜单：播放速度 + 睡眠定时器。
 *
 * 两处入口共用本组件（播放条与全屏播放页），保证两边的档位集合、文案与
 * 能力判据永远一致——分开写两份是这类「小菜单」最常见的漂移来源。
 *
 * 能力判据（**不是**装饰性分支）：
 * - 播放速度：`isPlaybackRateAvailable()`。移动端音频由原生 MediaPlayer 播放，
 *   而原生桥没有变速方法，所以移动端**不渲染**这一组，而不是渲染一个点了没反应的档位。
 * - 睡眠定时器：纯 JS 定时 + `pause()`，两端都有 `pause()`，因此全端可用。
 */
export function PlaybackExtrasMenu({ align = 'end' }: { align?: 'start' | 'center' | 'end' }) {
  const t = useT()
  const playbackRate = usePlayerStore((s) => s.playbackRate)
  const sleepEndsAt = usePlayerStore((s) => s.sleepEndsAt)
  const setPlaybackRate = usePlayerStore((s) => s.setPlaybackRate)
  const setSleepTimer = usePlayerStore((s) => s.setSleepTimer)

  const rateAvailable = isPlaybackRateAvailable()

  /**
   * 剩余时间的展示值。
   *
   * 用 state 而不是渲染期直接算：渲染期读 Date.now() 会让组件在无关重渲染时
   * 得到不同结果，而 React 不会因为「时间过了」自动重渲染——倒计时会僵在原地。
   * 初值由当前时间戳推导，定时器只在运行时存在。
   */
  const [remainingMs, setRemainingMs] = useState(() =>
    sleepEndsAt === null ? 0 : sleepRemainingMs(sleepEndsAt)
  )

  useEffect(() => {
    if (sleepEndsAt === null) {
      setRemainingMs(0)
      return
    }
    // 立即对齐一次：设完定时器的那一帧就要显示正确剩余量，不能等 1 秒
    setRemainingMs(sleepRemainingMs(sleepEndsAt))
    const id = setInterval(() => {
      setRemainingMs(sleepRemainingMs(sleepEndsAt))
    }, SLEEP_DISPLAY_TICK_MS)
    return () => clearInterval(id)
  }, [sleepEndsAt])

  const sleepActive = sleepEndsAt !== null
  // 触发按钮的激活态：任一项处于非默认值就点亮，用户一眼能看出「我改过速率」/「定时器在跑」
  const anyActive = (rateAvailable && playbackRate !== 1) || sleepActive

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn('btn-icon btn-xl relative', anyActive && 'text-mint')}
          title={t('player.rate.label')}
          aria-label={t('player.rate.label')}
        >
          <Gauge className="h-[16px] w-[16px] min-[1500px]:h-[18px] min-[1500px]:w-[18px]" strokeWidth={1.5} />
          {/* 睡眠定时器在跑时的存在感标记：菜单收起后，用户仍需知道有个定时器在倒计时 */}
          {sleepActive && (
            <span
              aria-hidden
              className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-mint"
            />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-52">
        {/* ── 播放速度 ───────────────────────────────────────────
            移动端整组不渲染：原生桥没有变速通道（见 isPlaybackRateAvailable） */}
        {rateAvailable && (
          <>
            <DropdownMenuLabel>{t('player.rate.label')}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={String(playbackRate)}
              onValueChange={(value) => setPlaybackRate(Number(value))}
            >
              {PLAYBACK_RATE_PRESETS.map((rate) => (
                <DropdownMenuRadioItem key={rate} value={String(rate)}>
                  {/* 1× 用「正常速度」这个词而不是数字：字典里两个语言都提供了词形，
                      数字 1 在部分语言下会被读成序数或量词，不像一个速度 */}
                  {rate === 1
                    ? t('player.rate.normal')
                    : t('player.rate.value', { rate: formatRateValue(rate) })}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
          </>
        )}

        {/* ── 睡眠定时器 ─────────────────────────────────────────
            语义恒为「到点暂停」，不是退出应用。

            刻意**不用 RadioGroup**（速度那一组才用）：本 store 只存结束时间戳，
            不存「用户当初选了哪个档位」，而剩余时间的显示每秒都在变。
            用单选组会出现「选中项与实际剩余量对不上」的假状态——
            要么把 checked 挂在会漂移的推导值上，要么出现没有任何一项被选中的空档。
            改成动作项 + 单独的剩余时间标签：状态只有一个真值源（定时器在跑 / 在跑多久）。 */}
        <DropdownMenuLabel className="flex items-center gap-1.5">
          <Timer className="h-3.5 w-3.5" strokeWidth={1.7} />
          {t('player.sleep.label')}
        </DropdownMenuLabel>
        {sleepActive && (
          <DropdownMenuLabel className="!py-1 !text-[11px] !font-normal text-mint/90">
            {t('player.sleep.active', { time: formatSleepRemaining(remainingMs) })}
          </DropdownMenuLabel>
        )}
        <DropdownMenuItem
          // 未计时时才需要「关闭」；计时中它用于取消（同一个动作，语义自洽）
          onClick={() => setSleepTimer(null)}
          className={cn(!sleepActive && 'text-foreground/[0.55]')}
        >
          {t('player.sleep.off')}
        </DropdownMenuItem>
        {SLEEP_TIMER_PRESETS.map((minutes) => (
          <DropdownMenuItem key={minutes} onClick={() => setSleepTimer(minutes)}>
            {t('player.sleep.preset', { minutes })}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * 播放条的紧凑档用的存在感标记。
 *
 * 紧凑档（< 560px）放不下第三个入口，这里只给「定时器在跑」的标记，
 * 不做可点入口——点开全屏播放页即可操作（与音量、上一首在同一档被收起的取舍一致）。
 */
export function SleepActiveBadge() {
  const sleepEndsAt = usePlayerStore((s) => s.sleepEndsAt)
  return sleepEndsAt !== null ? (
    <span aria-hidden className="w-1.5 h-1.5 rounded-full bg-mint flex-shrink-0 mx-0.5" />
  ) : null
}
