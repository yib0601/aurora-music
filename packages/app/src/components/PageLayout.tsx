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
    <div className={cn('flex flex-col h-full px-8 pt-8 pb-4', className)}>
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
