import { cn } from '@/lib/utils'

/** Aurora 品牌标识：与应用图标共用同一视觉资产，不再使用通用音符代替。 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span className={cn('brand-mark', className)}>
      <img src="/favicon.svg" alt="" draggable={false} />
    </span>
  )
}
