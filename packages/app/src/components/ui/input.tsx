import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * Mineradio 暗色玻璃输入框风格
 * - 半透明暗色底
 * - 1px 白色/10 hairline 边框
 * - focus 时薄荷青微光边框
 */
export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          'flex h-9 w-full rounded-md border border-white/10 bg-white/[0.04] px-3 py-1 font-text text-[14px] tracking-[-0.224px] text-white/92 transition-[border-color,box-shadow,background] duration-200 ease-mineradio placeholder:text-white/30 focus-visible:outline-none focus-visible:border-mint/40 focus-visible:ring-2 focus-visible:ring-mint/15 focus-visible:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50',
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
