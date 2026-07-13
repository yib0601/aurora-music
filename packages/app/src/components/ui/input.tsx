import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * Apple search-input 风格
 * - pill 圆角
 * - 1px hairline 边框
 * - 44px 高度
 */
export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          'flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 font-text text-[14px] tracking-[-0.224px] text-foreground transition-[border-color,box-shadow] duration-200 ease-apple placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:border-action-blue focus-visible:ring-2 focus-visible:ring-action-blue/20 disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = 'Input'

export { Input }
