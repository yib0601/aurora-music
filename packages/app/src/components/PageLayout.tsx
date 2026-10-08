import { cn } from '@/lib/utils'
import { PageTitle } from '@/components/PageHeading'
import { useT } from '@/i18n'
import type { MessageKey } from '@aurora/shared'

interface PageLayoutProps {
  /**
   * 页头标题（**文案键**，渲染期取译文）。
   *
   * 为什么是键而不是字符串：调用方多是页面组件，字符串一旦在模块级或父组件顶部
   * 拼好，语言就被冻在那一刻；存键、在渲染期 t() 才能随语言切换刷新。
   * 页面名一律取 `nav.item.*`（见 lib/routes.ts 的 NAV_LABEL_KEYS）。
   */
  titleKey?: MessageKey
  /** 已本地化的标题字符串。仅保留给极端场景（标题来自运行时数据），新代码用 titleKey */
  title?: string
  header?: React.ReactNode
  children: React.ReactNode
  className?: string
}

/**
 * 统一页面布局组件
 * 所有页面共用，确保间距、内边距完全一致
 *
 * 用法：
 * 1. 简单标题：<PageLayout titleKey={NAV_LABEL_KEYS.library}>
 * 2. 自定义标题：<PageLayout header={<CustomHeader />}>
 *
 * 页头只放标题：全站已撤掉标题下的说明性副标题，需要解释的页面把信息交给
 * 空态或内容区首行，不在页头重复一遍。
 */
export function PageLayout({ titleKey, title, header, children, className }: PageLayoutProps) {
  const t = useT()
  return (
    // pb 需为底部悬浮播放条让位（移动端约 84px+safe-area / 桌面约 102px），
    // 否则滚动到底时内容会被播放条永久遮挡
    // 移动端收窄左右内边距、缩小大标题字号，避免小屏上内容拥挤
    // 全屏/超宽屏限宽居中：内容列拉满到 1400px+ 时表格行过宽、阅读松散，
    // max-w 让内容保持舒适行宽并与居中悬浮播放条形成一致的视觉轴
    // 间距对齐 DS 阶梯（4/8/12/16/24/32/40/56/80）
    // 页头字号/字重/字距一律取 PageTitle（PageHeading.tsx 是唯一事实源），
    // 此处不再写裸字号类——否则又会漂出与页头不一致的第二档
    <div className={cn('flex flex-col h-full px-4 pt-4 md:px-8 md:pt-8 pb-[calc(100px+env(safe-area-inset-bottom))] lg:pb-32 mx-auto w-full max-w-[1200px]', className)}>
      {header ?? ((titleKey || title) && (
        <div className="mb-6 md:mb-8">
          <PageTitle>{titleKey ? t(titleKey) : title}</PageTitle>
        </div>
      ))}
      {children}
    </div>
  )
}
