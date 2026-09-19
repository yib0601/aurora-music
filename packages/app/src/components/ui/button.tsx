import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

/**
 * Mineradio × DeepSeek Harness 按钮系统
 *
 * 材质/排版取 DS 语言（见 docs/design-system.md §3.1）：
 * - 统一 pill 圆角（DS `--ds-radius-pill` = 100px，等价 rounded-ds-pill）
 * - 发丝描边只用 1px + 低透明，靠提高不透明度表达"更重"，不靠加粗
 * - 表面用半透明白叠加（bg-white/[0.06] 这类天生适配任意底色的值）
 * - 暗色下"阴影"优先用内高光（inset 0 1px 0）而非黑色投影
 * - 尺寸档对齐 DS：m=36px / s=28px；文字 14px、字重 500、字距收紧
 *
 * 品牌色不变：主交互色仍是薄荷青 mint #00F5D4（保留项目品牌识别），
 * DS 提供的是结构、材质与排版语言，不是换色。
 *
 * 变体（8）与尺寸（5）名称一字未改，仅调整 class 字符串，全站引用不受影响。
 * 共用 active 状态: scale(0.95)
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap font-text transition-[transform,background,box-shadow,border-color] duration-200 ease-mineradio focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint/30 focus-visible:ring-offset-0 disabled:pointer-events-none disabled:opacity-50 active:scale-95 select-none',
  {
    variants: {
      variant: {
        // primary: mint 实心 pill（DS 的实心主按钮材质，配色仍走品牌 mint）
        // - DS 规范：字重 500、圆角 pill、hover 位移 -1px
        // - 阴影收敛为「内高光 + 单层柔和投影」，去掉多层 glow
        primary:
          'bg-mint text-mint-fg rounded-ds-pill text-[14px] font-medium tracking-[-0.224px] hover:bg-[var(--fc-accent-hov)] hover:-translate-y-px shadow-[inset_0_1px_0_rgba(255,255,255,.20),0_2px_8px_rgb(var(--tw-mint)/.16)]',
        // secondary: 玻璃底 + 1px 发丝描边（DS 的次级按钮形态）
        // ⚠️ 两个坑叠加，必须同时规避：
        //   1) 此处写字面量 12px 而非 backdrop-blur-ds：数值等价于 DS 的
        //      --ds-blur-glass，且不依赖 [data-ds-theme] 的挂载时序（首屏脚本
        //      执行前也正确）。注意 --ds-* 只定义在该作用域下，裸用会解析为空值。
        //   2) 本项目 Tailwind 的 backdrop-blur-* 只写 --tw-backdrop-blur 变量，不含
        //      backdrop-filter 声明，必须额外挂 .backdrop-filter 才会真正落地。
        secondary:
          'bg-mint/[0.06] text-mint border border-mint/30 rounded-ds-pill text-[14px] font-medium tracking-[-0.224px] backdrop-filter backdrop-blur-[12px] hover:bg-mint/[0.10] hover:border-mint/45',
        // utility: DS 的次级玻璃胶囊，圆角对齐 panel(16px) -> media(10px) 档
        utility:
          'bg-white/[0.06] text-white/[0.86] border border-white/10 rounded-ds-media text-[14px] font-medium tracking-[-0.224px] hover:bg-white/[0.10] hover:border-white/[0.16] hover:-translate-y-px',
        // pearl: 对应 DS `.ds-btn-liquid` —— 液体玻璃（DS 量级 blur 10px + 内高光 + 轻投影）
        // 原变体只写 backdrop-blur-[12px] 而本项目 Tailwind 未给该键附带 backdrop-filter，
        // 故补 .backdrop-filter 让模糊真正生效（实测原写法 computed = none）；10px 对齐 DS .ds-btn-liquid
        pearl:
          'bg-[rgba(0,0,0,.10)] backdrop-filter backdrop-blur-[10px] saturate-[1.8] text-white/[0.86] border-0 rounded-ds-input text-[13px] font-medium tracking-[-0.12px] shadow-[inset_0_1px_1px_rgba(255,255,255,.34),0_2px_8px_rgba(0,0,0,.18)] hover:bg-[rgba(255,255,255,.055)] hover:shadow-[inset_0_1px_1px_rgba(255,255,255,.42),0_4px_12px_rgba(0,0,0,.22)] hover:-translate-y-px',
        // ghost: 全透明弱行动，仅 hover 显形（对应 DS `.ds-btn-ghost`，字重 400）
        ghost: 'bg-transparent text-white/70 font-normal hover:bg-white/[0.06] hover:text-white rounded-ds-sm',
        // destructive: 珊瑚红实心 pill（沿用既有语义色，材质对齐 DS 实心按钮）
        destructive:
          'bg-coral text-white rounded-ds-pill text-[14px] font-medium tracking-[-0.224px] hover:bg-coral/90 hover:-translate-y-px',
        // link: 纯文字按钮，品牌色（对应 DS `.ds-btn-text`）
        link: 'bg-transparent text-mint font-normal underline-offset-4 hover:underline rounded-none',
        // outline: 对应 DS 的 1px 发丝描边次级按钮（不填充，仅描边）
        outline:
          'bg-transparent border border-white/10 text-white/80 rounded-ds-sm text-[14px] font-normal hover:bg-white/[0.05] hover:border-white/[0.18]',
      },
      size: {
        // 统一三档高度：xs 28 / md 36 / lg 44（与 globals.css 的 .pill-* 一致）
        // 对齐 DS 尺寸档：-m(36) / -s(28) / -xs(28)，仅改圆角与内距表达
        default: 'h-9 px-4 rounded-ds-pill',
        sm: 'h-7 px-3 text-[12px] rounded-ds-pill',
        lg: 'h-11 px-6 text-[14px] rounded-ds-pill',
        icon: 'h-9 w-9 rounded-ds-pill p-0',
        'icon-sm': 'h-7 w-7 rounded-ds-pill p-0',
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
