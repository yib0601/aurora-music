import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

/**
 * Apple 风格按钮系统
 * - primary: Action Blue + pill 圆角
 * - secondary: 透明 + 蓝边 + pill
 * - utility: ink 矩形 + sm 圆角
 * - pearl: 珍珠按钮 + md 圆角
 * - ghost: 透明 hover
 * - destructive: 红色 pill（用于删除确认）
 *
 * 共用 active 状态: scale(0.95)
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap font-text transition-[transform,background,filter] duration-200 ease-apple focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action-blue-focus focus-visible:ring-offset-0 disabled:pointer-events-none disabled:opacity-50 active:scale-95 select-none',
  {
    variants: {
      variant: {
        // Apple button-primary: Action Blue + pill
        primary:
          'bg-action-blue text-white rounded-pill text-[14px] font-normal tracking-[-0.224px] hover:bg-action-blue-focus',
        // Apple button-secondary-pill: 透明 + 蓝边
        secondary:
          'bg-transparent text-action-blue border border-action-blue rounded-pill text-[14px] font-normal tracking-[-0.224px] hover:bg-action-blue/[0.06]',
        // Apple button-dark-utility: ink + sm 圆角
        utility:
          'bg-foreground text-background rounded-sm text-[14px] font-normal tracking-[-0.224px] hover:opacity-90',
        // Apple button-pearl-capsule: 珍珠 + md 圆角
        pearl:
          'bg-[#fafafc] text-ink-muted80 border border-[#f0f0f0] rounded-md text-[14px] font-normal tracking-[-0.224px] hover:bg-white',
        // ghost: 透明 hover
        ghost: 'bg-transparent text-foreground/70 hover:bg-foreground/[0.06] hover:text-foreground rounded-sm',
        // destructive: 红色 pill（删除等危险操作）
        destructive:
          'bg-destructive text-destructive-foreground rounded-pill text-[14px] font-normal tracking-[-0.224px] hover:bg-destructive/90',
        // link
        link: 'bg-transparent text-action-blue underline-offset-4 hover:underline rounded-none',
        // outline: 保留 shadcn 兼容
        outline:
          'bg-transparent border border-border text-foreground rounded-sm text-[14px] hover:bg-foreground/[0.04]',
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
