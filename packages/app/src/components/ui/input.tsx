import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * 输入框：DS 材质（见 docs/design-system.md §3）
 * - 圆角走 DS input 档（--ds-radius-input = 10px）
 * - 1px 发丝边框（DS 的 border-subtle/default 量级），不靠加粗表达层级
 * - 表面用半透明白叠加 bg-white/[0.04]，适配任意底色
 * - focus 态：品牌 mint 描边 + 极轻 ring，保留既有可访问性反馈
 */
export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          'flex h-9 w-full rounded-ds-input border border-white/10 bg-white/[0.04] px-3 py-1 font-text text-[14px] tracking-[-0.224px] text-white/[0.92] transition-[border-color,box-shadow,background] duration-200 ease-mineradio placeholder:text-white/30 focus-visible:outline-none focus-visible:border-mint/40 focus-visible:ring-2 focus-visible:ring-mint/15 focus-visible:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50',
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
