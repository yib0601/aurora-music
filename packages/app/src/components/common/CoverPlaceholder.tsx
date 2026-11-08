import { useId } from 'react'
import { cn } from '@/lib/utils'

/**
 * 无封面时的「签名式」占位图：歌名首字 + 由歌名/歌手稳定派生的渐变底。
 *
 * 为什么不画音符图标：歌源里确实有一批条目**上游就没有专辑**（无专辑的翻唱/搬运上传，
 * 例如「网络歌手」的《七月七爱恋》），它们的 `coverUrl` 是空串，列表与队列里会成片出现
 * 同一个音符图标，整屏看起来像加载失败。用首字 + 稳定配色后，每首歌占位图互不重复，
 * 一眼能认出是哪首，也不再像错误态。
 *
 * 纯展示组件：不吃网络、不看 store、不参与任何取图或匹配链路；颜色只由文本派生，
 * 同一首歌在任何页面/任何次启动都得到同一张图（FNV-1a，避免 Math.random 的闪烁）。
 */

/** FNV-1a 32 位：把「歌名|歌手」稳定映射到 0..2^32-1 */
function hashOf(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    // h *= 16777619，用移位避免大数溢出丢精度
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h
}

/** 取首个可见字符作为字形；拉丁字母转大写，空标题回音符 */
function initialOf(title?: string): string {
  const chars = Array.from((title || '').trim())
  const first = chars.find((c) => c.trim())
  if (!first) return '♪'
  return /[a-z]/.test(first) ? first.toUpperCase() : first
}

/**
 * 底色色相只在这 8 档里取（青绿 → 蓝 → 紫 → 玫红），不经全色环随机。
 * 全色环会抽出橄榄/土黄这类脏色，和 DS 皮肤的薄荷渐变放在一起像另一套设计。
 * 档位够多，同名不同歌手的占位仍能区分开。
 */
const PLACEHOLDER_HUES = [168, 190, 210, 232, 258, 286, 316, 342]

export interface CoverPlaceholderProps {
  /** 歌名（决定字形与配色；空则回退音符） */
  title?: string
  /** 歌手（参与配色派生，让同名的不同录音也能区分） */
  artist?: string
  className?: string
}

export function CoverPlaceholder({ title, artist, className }: CoverPlaceholderProps) {
  // 同页可能同时渲染几十个占位图，渐变的 id 必须唯一，否则后挂载的会覆盖前者
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const hue = PLACEHOLDER_HUES[hashOf(`${title || ''}|${artist || ''}`) % PLACEHOLDER_HUES.length]
  const hueDeep = (hue + 16) % 360

  return (
    <svg
      aria-hidden
      className={cn('w-full h-full', className)}
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid slice"
    >
      <defs>
        <linearGradient id={`cp-${uid}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={`hsl(${hue}, 34%, 27%)`} />
          <stop offset="55%" stopColor={`hsl(${hueDeep}, 40%, 19%)`} />
          <stop offset="100%" stopColor={`hsl(${hueDeep}, 44%, 13%)`} />
        </linearGradient>
        <radialGradient id={`cp-hl-${uid}`} cx="0.28" cy="0.2" r="0.75">
          <stop offset="0%" stopColor="rgba(255,255,255,0.16)" />
          <stop offset="100%" stopColor="rgba(255,255,255,0)" />
        </radialGradient>
      </defs>
      <rect width="100" height="100" fill={`url(#cp-${uid})`} />
      <rect width="100" height="100" fill={`url(#cp-hl-${uid})`} />
      <text
        x="50"
        y="50"
        textAnchor="middle"
        dominantBaseline="central"
        className="font-display"
        fontSize="44"
        fontWeight="600"
        fill="rgba(255,255,255,0.72)"
      >
        {initialOf(title)}
      </text>
    </svg>
  )
}
