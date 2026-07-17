import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

/**
 * Mineradio 暗色玻璃风格按钮系统
 * - primary: 薄荷青（mint）实心 pill，深色文字
 * - secondary: 透明 + 薄荷青边框 pill
 * - pearl: 玻璃珍珠按钮（Saved Button 质感）
 * - ghost: 透明 hover，暗色底微光
 * - destructive: 珊瑚红 pill
 * - outline: 暗色玻璃边框
 * - link: 薄荷青文字链接
 *
 * 共用 active 状态: scale(0.96)
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap font-text transition-[transform,background,box-shadow,border-color] duration-200 ease-mineradio focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint/30 focus-visible:ring-offset-0 disabled:pointer-events-none disabled:opacity-50 active:scale-95 select-none',
  {
    variants: {
      variant: {
        // Mineradio primary: mint 实心 pill
        primary:
          'bg-mint text-[#030608] rounded-pill text-[14px] font-semibold tracking-[-0.224px] hover:bg-[#00E0BE] hover:-translate-y-px shadow-[0_10px_30px_rgba(0,245,212,.18),inset_0_1px_0_rgba(255,255,255,.20)]',
        // Mineradio secondary: 透明 + mint 边框 pill
        secondary:
          'bg-transparent text-mint border border-mint/34 rounded-pill text-[14px] font-semibold tracking-[-0.224px] hover:bg-mint/[0.08] hover:border-mint/50',
        // Mineradio utility: 暗色玻璃胶囊
        utility:
          'bg-white/[0.06] text-white/86 border border-white/10 rounded-md text-[14px] font-medium tracking-[-0.224px] hover:bg-white/[0.10] hover:border-white/16 hover:-translate-y-px',
        // Mineradio pearl: 玻璃珍珠按钮（Saved Button 质感）
        pearl:
          'bg-[rgba(0,0,0,.10)] backdrop-blur-[12px] saturate-[1.8] text-white/86 border-0 rounded-[13px] text-[13px] font-semibold tracking-[-0.12px] shadow-[inset_0_0_2px_1px_rgba(255,255,255,.34),inset_0_0_10px_4px_rgba(255,255,255,.13),0_10px_30px_rgba(0,0,0,.18)] hover:bg-[rgba(255,255,255,.055)] hover:shadow-[inset_0_0_2px_1px_rgba(255,255,255,.42),inset_0_0_12px_5px_rgba(255,255,255,.17),0_12px_34px_rgba(0,0,0,.22),0_0_18px_rgba(255,255,255,.06)] hover:-translate-y-px',
        // ghost: 透明 hover
        ghost: 'bg-transparent text-white/70 hover:bg-white/[0.06] hover:text-white rounded-sm',
        // destructive: 珊瑚红 pill
        destructive:
          'bg-coral text-white rounded-pill text-[14px] font-semibold tracking-[-0.224px] hover:bg-coral/90 hover:-translate-y-px',
        // link
        link: 'bg-transparent text-mint underline-offset-4 hover:underline rounded-none',
        // outline: 暗色玻璃边框
        outline:
          'bg-transparent border border-white/10 text-white/80 rounded-sm text-[14px] hover:bg-white/[0.05] hover:border-white/18',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 px-3 text-[13px]',
        lg: 'h-11 px-6 text-[15px]',
        icon: 'h-9 w-9 rounded-full p-0',
        'icon-sm': 'h-7 w-7 rounded-full p-0',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'default',
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = 'Button'

export { Button, buttonVariants }
