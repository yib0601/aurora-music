import { memo, useState, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Copy } from 'lucide-react'
import type { DuplicateGroup } from '@aurora/shared'
import { useLibraryStore } from '@/stores/libraryStore'
import type { Track } from '@/types'

/**
 * 重复曲目明示组件。
 *
 * 去重只影响展示、不删记录，但「藏了哪首」必须可查：
 * - DuplicateSummaryHover：音乐库头部「已隐藏 N 首重复曲目」提示，
 *   悬停浮层逐组列出重复名单（留了哪份、藏了哪份）；
 * - DuplicateBadge：列表/网格中胜出副本行上的小徽标，悬停看该首的副本明细。
 *
 * 浮层用 portal 挂到 body（fixed 定位）：歌曲表在虚拟化滚动容器里，
 * 行内绝对定位的浮层会被容器 overflow 裁掉，fixed 则不受任何祖先裁剪。
 * 浮层纯展示（pointer-events-none），鼠标移开锚点即消失，无需维护悬停续命逻辑。
 */

/** 副本来源展示名：本机文件 / 「来源名」 */
function useSourceLabel() {
  const librarySources = useLibraryStore((s) => s.librarySources)
  return (t: Track) =>
    t.sourceId
      ? `「${librarySources.find((s) => s.id === t.sourceId)?.name || '网络存储'}」`
      : '本机文件'
}

/** 悬停锚点：记录锚点 rect 供浮层定位，移开即清空 */
function useHoverRect() {
  const [rect, setRect] = useState<DOMRect | null>(null)
  return {
    rect,
    onEnter: (e: MouseEvent<HTMLElement>) => setRect(e.currentTarget.getBoundingClientRect()),
    onLeave: () => setRect(null),
  }
}

const PANEL_WIDTH = 300

/** fixed 浮层：默认在锚点下方，贴近视口底部时翻到上方；水平方向收进视口 */
function PortalPanel({ rect, children }: { rect: DOMRect; children: ReactNode }) {
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - PANEL_WIDTH - 8))
  const flip = rect.bottom + 280 > window.innerHeight && rect.top > 300
  return createPortal(
    <div
      className="fixed z-[70] pointer-events-none animate-in fade-in-0"
      style={{
        width: PANEL_WIDTH,
        left,
        ...(flip
          ? { bottom: window.innerHeight - rect.top + 6 }
          : { top: rect.bottom + 6 }),
      }}
    >
      {children}
    </div>,
    document.body,
  )
}

/** 重复组明细面板：逐组展示歌名/歌手 + 保留与隐藏的副本来源 */
export function DuplicateDetails({ groups, intro }: {
  groups: DuplicateGroup<Track>[]
  intro?: string
}) {
  const sourceLabel = useSourceLabel()
  return (
    <div className="glass-floating rounded-[10px] p-3">
      {intro && (
        <p className="font-text text-[12px] text-white/55 mb-2 leading-relaxed">{intro}</p>
      )}
      <ul className="space-y-2 max-h-72 overflow-y-auto scrollbar-thin">
        {groups.map((g) => (
          <li key={g.kept.id} className="min-w-0">
            <p className="font-text text-[13px] font-semibold text-white/90 truncate tracking-[-0.2px]">
              {g.kept.title}
              <span className="font-normal text-white/65"> · {g.kept.artist}</span>
            </p>
            <p className="font-text text-[11px] text-white/65 mt-0.5 truncate">
              保留 {sourceLabel(g.kept)} · 隐藏 {g.hiddenCopies.map((c) => sourceLabel(c)).join('、')}
            </p>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** 头部「已隐藏 N 首重复曲目」提示：悬停浮层列出全部重复名单 */
export function DuplicateSummaryHover({ hidden, groups }: {
  hidden: number
  groups: DuplicateGroup<Track>[]
}) {
  const { rect, onEnter, onLeave } = useHoverRect()
  return (
    <span
      className="ml-2 text-white/35 cursor-help underline decoration-dotted decoration-white/20 underline-offset-4"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      · 已隐藏 {hidden} 首重复曲目
      {rect && (
        <PortalPanel rect={rect}>
          <DuplicateDetails
            groups={groups}
            intro="以下歌曲在多个来源中存在副本，列表只展示一份（本机文件优先）。记录没有删除，歌单/收藏引用仍有效："
          />
        </PortalPanel>
      )}
    </span>
  )
}

/** 行内「重复」徽标：标记该展示副本另有被隐藏的副本，悬停看明细 */
export const DuplicateBadge = memo(function DuplicateBadge({
  group,
}: {
  group: DuplicateGroup<Track>
}) {
  const { rect, onEnter, onLeave } = useHoverRect()
  return (
    <span
      // 徽标只读：点击/双击不触发行的播放与详情跳转
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      className="flex-shrink-0 inline-flex items-center gap-1 rounded-full bg-white/[0.06] border border-white/[0.12] px-1.5 py-[1px] font-text text-[10px] text-white/55 cursor-help"
    >
      <Copy className="h-2.5 w-2.5" strokeWidth={1.8} />
      重复
      {rect && (
        <PortalPanel rect={rect}>
          <DuplicateDetails
            groups={[group]}
            intro="这首歌曲存在多个副本，列表只展示一份。记录没有删除："
          />
        </PortalPanel>
      )}
    </span>
  )
})
