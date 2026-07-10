import * as React from 'react'
import { cn } from '@/lib/utils'

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
        className={cn('w-full', className)}
        {...props}
      />
    )
  }
)
Slider.displayName = 'Slider'

export { Slider }
