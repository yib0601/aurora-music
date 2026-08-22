import { cn } from '@/lib/utils'

interface PageLayoutProps {
  title?: string
  subtitle?: string
  header?: React.ReactNode
  children: React.ReactNode
  className?: string
}

/**
 * 统一页面布局组件
 * 所有页面共用，确保间距、内边距完全一致
 *
 * 用法：
 * 1. 简单标题：<PageLayout title="音乐库" subtitle="导入音乐...">
 * 2. 自定义标题：<PageLayout header={<CustomHeader />}>
 */
export function PageLayout({ title, subtitle, header, children, className }: PageLayoutProps) {
  return (
    // pb 需为底部悬浮播放条让位（移动端约 84px+safe-area / 桌面约 102px），
    // 否则滚动到底时内容会被播放条永久遮挡
    // 移动端收窄左右内边距、缩小大标题字号，避免小屏上内容拥挤
    // 全屏/超宽屏限宽居中：内容列拉满到 1400px+ 时表格行过宽、阅读松散，
    // max-w 让内容保持舒适行宽并与居中悬浮播放条形成一致的视觉轴
    <div className={cn('flex flex-col h-full px-4 pt-4 md:px-8 md:pt-8 pb-[calc(100px+env(safe-area-inset-bottom))] lg:pb-32 mx-auto w-full max-w-[1200px]', className)}>
      {header ?? (title && (
        <div className="mb-6 md:mb-8">
          <h1 className="font-display text-[24px] md:text-[32px] font-semibold tracking-[-0.374px] text-white/98 leading-tight">
            {title}
          </h1>
          {subtitle && (
            <p className="font-text text-[13px] text-white/50 mt-1 tracking-[-0.2px]">
              {subtitle}
            </p>
          )}
        </div>
      ))}
      {children}
    </div>
  )
}
