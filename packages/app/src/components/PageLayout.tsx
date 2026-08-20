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
    <div className={cn('flex flex-col h-full px-8 pt-8 pb-[calc(100px+env(safe-area-inset-bottom))] lg:pb-32', className)}>
      {header ?? (title && (
        <div className="mb-8">
          <h1 className="font-display text-[32px] font-semibold tracking-[-0.374px] text-white/98 leading-tight">
            {title}
          </h1>
          {subtitle && (
            <p className="font-text text-[13px] text-white/40 mt-1 tracking-[-0.2px]">
              {subtitle}
            </p>
          )}
        </div>
      ))}
      {children}
    </div>
  )
}
