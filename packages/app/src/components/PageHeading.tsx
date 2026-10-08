import React from 'react'
import { cn } from '@/lib/utils'

/**
 * 页头标题字号的**唯一事实源**。
 *
 * 背景：此前 9 处页头各自抄了一份类名字面量，同一视觉角色漂出
 * 22 / 24 / 26 / 28 / 32 / 34 / 36 / 40 八种字号。最刺眼的是**一级页头之间**：
 * 「音乐库 / 收藏 / 最近播放」32px，「我的音乐」36px，「设置」24px 且**没有 md 断点**
 * （桌面端也停在手机档），于是同一条导航上切换页面，同一位置的标题忽大忽小。
 * 二级页头（带返回入口的详情页）则散在 22 / 28 / 34 / 36 四种值上。
 *
 * 收敛为**两档**，字号/字重/字距/行高/颜色五件套整体绑定：
 * - 一级页头（侧栏可直接到达的页面）：24px（移动）→ 32px（md+）
 * - 二级页头（带返回入口的详情页）：22px（移动）→ 28px（md+）
 *
 * 数值依据：
 * - 字重 600 而非 700：中文笔画密度远高于拉丁字母，同一字重在中文下更粗更糊，
 *   深色底上尤甚（`design-system.md` §8.3）。全站页头统一 600，不再混用 500/700。
 * - 字距 -0.374px：与全站其余大标题同值。此前「设置」用 -0.02em、「歌名」用 -0.5px、
 *   其余用 -0.374px，三种写法在同一屏相邻时肉眼可辨。
 * - `text-white/98`（而非 `text-white`）：白色的 98% 是画面里柔和的一档，
 *   页头与正文同用纯白会让层级塌掉。
 *
 * 新页面一律用 `PageTitle` / `SubPageTitle`，不要再写裸的字号类名。
 */
export const PAGE_TITLE_CLASS =
  'font-display text-[24px] md:text-[32px] font-semibold tracking-[-0.374px] text-white/98 leading-tight'

/** 二级页头（详情页 / 播放列表等带返回入口的页面）字号档 */
export const SUB_PAGE_TITLE_CLASS =
  'font-display text-[22px] md:text-[28px] font-semibold tracking-[-0.374px] text-white/98 leading-tight'

/**
 * 页头副标题档。颜色固定 `text-white/65`。
 *
 * `/65` 不是随手取的：色场提亮后低 alpha 次要文字实测跌破 WCAG AA 4.5:1，
 * 历史提交把当时两个页面的副标题提到 /65（暗色 5.11、浅色 5.23，实测达标），
 * 但后来新增/拆分的页面又各自写回 /50 —— 对比度回归就这样漏了进来。
 * 现在收口到本常量，新页面不要再写裸色值。
 */
export const PAGE_SUBTITLE_CLASS = 'font-text text-[13px] text-white/65 tracking-[-0.2px]'

/**
 * 空态标题档。全站空态（无曲目 / 无收藏 / 无播放记录 / 无音源 / 无搜索结果）
 * 此前抄了 6 份**逐字相同**的类名，含 `text-white/90` + `tracking-[-0.3px]`
 * 这两处别处都不用的写法；收口后新空态直接用它。
 * 字号 22px 与二级页头同档：空态标题是「页面级提示」，不该比页头更抢眼。
 */
export const EMPTY_TITLE_CLASS = 'font-display text-[22px] font-semibold text-white/90 mb-2 tracking-[-0.3px]'

interface TitleProps {
  children: React.ReactNode
  /** 追加的布局类（如 `truncate` / `mb-3`）；字号档本身不可覆写 */
  className?: string
}

/** 一级页面标题 */
export function PageTitle({ children, className }: TitleProps) {
  return <h1 className={cn(PAGE_TITLE_CLASS, className)}>{children}</h1>
}

/** 二级页面标题 */
export function SubPageTitle({ children, className }: TitleProps) {
  return <h1 className={cn(SUB_PAGE_TITLE_CLASS, className)}>{children}</h1>
}

/** 页头副标题（标题下那一行说明/计数） */
export function PageSubtitle({ children, className }: TitleProps) {
  return <p className={cn(PAGE_SUBTITLE_CLASS, 'mt-1', className)}>{children}</p>
}

/** 空态标题（图标 + 一句主文案 + 一句说明 + 动作按钮的空态块） */
export function EmptyTitle({ children, className }: TitleProps) {
  return <h2 className={cn(EMPTY_TITLE_CLASS, className)}>{children}</h2>
}

/** 空态说明文字（与空态标题成对出现） */
export function EmptyText({ children, className }: TitleProps) {
  return <p className={cn('font-text text-[14px] text-white/50 mb-6 tracking-[-0.15px]', className)}>{children}</p>
}
