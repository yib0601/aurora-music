import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * 滑块：本体样式（原逻辑保持原样，trackClass/thumbClass 仍作为透传 props 保留）。
 * 视觉由 globals.css 的 [type=range] 规则承担，此处的 DS 化仅体现在
 * 圆角/尺寸沿用 DS 阶梯（不改变任何 props 签名与 DOM 结构）。
 */
export interface SliderProps extends React.InputHTMLAttributes<HTMLInputElement> {
  trackClass?: string
  thumbClass?: string
}

const Slider = React.forwardRef<HTMLInputElement, SliderProps>(
  ({ className, trackClass, thumbClass, ...props }, ref) => {
    return (
      <input
        type="range"
        ref={ref}
        className={cn(
          // rounded-ds-pill：轨道在暗/浅主题下都保持 DS 的胶囊语汇
          'w-full rounded-ds-pill',
          className
        )}
        {...props}
      />
    )
  }
)
Slider.displayName = 'Slider'

export { Slider }
