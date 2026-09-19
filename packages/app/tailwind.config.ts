import type { Config } from 'tailwindcss'

const config: Config = {
  darkMode: ['class'],
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Noto Sans SC"', '"PingFang SC"', '"HarmonyOS Sans SC"', '"Inter"', '-apple-system', 'BlinkMacSystemFont', 'system-ui', 'sans-serif'],
        display: ['"Noto Sans SC"', '"PingFang SC"', '"Inter"', '-apple-system', 'BlinkMacSystemFont', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"Geist Mono"', '"SF Mono"', 'ui-monospace', 'monospace'],
        // 说明：不引入 DeepSeek Harness 原站的品牌字体（Host Grotesk / DM Sans /
        // Fragment Mono），它们均为商业授权字体，存在版权风险。设计语言中的
        // 「字体」一项本项目沿用上面的既有中文栈，不参与换肤。
      },
      colors: {
        // white 重定义为主题感知的"墨色"变量：深色主题下为白字/白底，
        // 浅色主题下翻转为深墨色（见 globals.css 的 --tw-white），
        // 从而让全站 400+ 处 text-white/* / bg-white/* / border-white/* 自动适配浅色
        white: 'rgb(var(--tw-white) / <alpha-value>)',
        // mint 同理：浅色主题下加深以保证浅底对比度（--tw-mint）
        // shadcn HSL 变量保留
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: { DEFAULT: 'var(--fc-accent)', foreground: '#030608' },
        secondary: { DEFAULT: 'hsl(var(--secondary))', foreground: 'hsl(var(--secondary-foreground))' },
        destructive: { DEFAULT: '#ff5367', foreground: '#ffffff' },
        muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
        accent: { DEFAULT: 'hsl(var(--accent))', foreground: 'hsl(var(--accent-foreground))' },
        popover: { DEFAULT: 'hsl(var(--popover))', foreground: 'hsl(var(--popover-foreground))' },
        card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
        // Mineradio 色板（fc/ink/canvas 全部走 CSS 变量，随主题翻转）
        ink: { DEFAULT: 'var(--fc-ink)', muted: 'var(--fc-muted)', deep: 'var(--fc-ink-2)' },
        canvas: { DEFAULT: 'var(--fc-bg)', paper: 'var(--fc-paper)' },
        fc: {
          bg: 'var(--fc-bg)',
          paper: 'var(--fc-paper)',
          ink: 'var(--fc-ink)',
          'ink-2': 'var(--fc-ink-2)',
          muted: 'var(--fc-muted)',
          hair: 'var(--fc-hair)',
          'hair-2': 'var(--fc-hair-2)',
          accent: 'var(--fc-accent)',
          'accent-hov': 'var(--fc-accent-hov)',
          blue: '#2442ff',
          warm: '#f8f4ee',
        },
        mint: 'rgb(var(--tw-mint) / <alpha-value>)',
        // mint 按钮/徽章上的前景色：深色主题深墨字、浅色主题白字（随 --tw-mint-fg 翻转）
        'mint-fg': 'rgb(var(--tw-mint-fg) / <alpha-value>)',
        champagne: '#f4d28a',
        coral: 'rgb(var(--tw-coral) / <alpha-value>)',
        chill: {
          cyan: '#8fe9ff',
          blue: '#73a7ff',
          mint: '#9cffdf',
        },
        // ===== DeepSeek Harness 色板（新增命名空间，不与上面任何 token 冲突）=====
        // 全部指向 --ds-color-* CSS 变量（由 src/styles/ds-tokens.css 定义 light/dark 双套值）。
        //
        // ⚠️ 嵌套结构由 Tailwind 生成 class 的规则决定，已用真实 tailwind CLI 逐项验证：
        //      ds.surface[3]     (数字嵌套) -> bg-ds-surface-3   ✅ 原站写法
        //      ds.border.default (字母嵌套) -> border-ds-border-default ✅ 原站写法
        //      ds.primary        (平铺)     -> text-ds-primary    ✅ 原站写法
        //      ds.text.primary   (字母嵌套) -> text-ds-text-primary ❌ 名字不对，故不采用
        //    Tailwind 对 colors 的「字母嵌套」会多拼一级前缀，因此 text-* / bg-page 这类
        //    目标 class 只能用平铺 key 表达；而 surface / border 的目标 class 本身就含
        //    重复词（surface、border-ds-border-*），正好用嵌套表达，两种形态并存是刻意的。
        ds: {
          brand: 'var(--ds-color-brand)',
          'brand-deep': 'var(--ds-color-brand-deep)',
          'brand-medium-reverse': 'var(--ds-color-brand-medium-reverse)',
          'brand-light-reverse': 'var(--ds-color-brand-light-reverse)',
          // ---- 文本色：平铺 key，生成 text-ds-primary / text-ds-secondary / ... ----
          primary: 'var(--ds-color-text-primary)',
          'primary-bluish': 'var(--ds-color-text-primary-bluish)',
          secondary: 'var(--ds-color-text-secondary)',
          description: 'var(--ds-color-text-description)',
          placeholder: 'var(--ds-color-text-placeholder)',
          inverse: 'var(--ds-color-text-inverse)',
          link: 'var(--ds-color-text-link-blue)',
          // ---- 页面/浮层底色：平铺 key，生成 bg-ds-page / bg-ds-overlay ----
          page: 'var(--ds-color-bg-page)',
          overlay: 'var(--ds-color-bg-overlay)',
          raised: 'var(--ds-color-bg-surface-raised)',
          hover: 'var(--ds-color-bg-hover)',
          input: 'var(--ds-color-bg-input)',
          'input-hover': 'var(--ds-color-bg-input-hover)',
          code: 'var(--ds-color-bg-code)',
          'hero-cta': 'var(--ds-color-bg-hero-cta)',
          dark: 'var(--ds-color-bg-dark)',
          // ---- 表面层级：数字嵌套，生成 bg-ds-surface-1 .. bg-ds-surface-5（原站写法）----
          // 注：一层嵌套不可省，因为目标 class 名里 "surface" 只出现一次；
          //     若平铺为 'surface-1' 会得到 bg-ds-surface-1 同样结果，此处保留嵌套更贴近语义。
          surface: {
            1: 'var(--ds-color-bg-surface-1)',
            2: 'var(--ds-color-bg-surface-2)',
            3: 'var(--ds-color-bg-surface-3)',
            4: 'var(--ds-color-bg-surface-4)',
            5: 'var(--ds-color-bg-surface-5)',
          },
          // ---- 描边色：字母嵌套，生成 border-ds-border-subtle / border-ds-border-default ... ----
          // 目标 class 里 "border" 出现两次（前缀 + 色名），故必须一层嵌套。
          border: {
            subtle: 'var(--ds-color-border-subtle)',
            default: 'var(--ds-color-border-default)',
            divider: 'var(--ds-color-border-divider)',
            hover: 'var(--ds-color-border-hover)',
            strong: 'var(--ds-color-border-strong)',
            secondary: 'var(--ds-color-border-secondary)',
            input: 'var(--ds-color-border-input)',
            'input-focus': 'var(--ds-color-border-input-focus)',
          },
          // 静态色：不随主题翻转
          white: 'var(--ds-color-static-white)',
          black: 'var(--ds-color-static-black)',
          scrollbar: 'var(--ds-color-scrollbar)',
          // ===== 按钮态（同 --ds-btn-* 变量，用于自定义/原生实现）=====
          btn: {
            'primary-bg': 'var(--ds-btn-primary-bg)',
            'primary-text': 'var(--ds-btn-primary-text)',
            'primary-hover-bg': 'var(--ds-btn-primary-hover-bg)',
            'secondary-bg': 'var(--ds-btn-secondary-bg)',
            'secondary-text': 'var(--ds-btn-secondary-text)',
            'secondary-border': 'var(--ds-btn-secondary-border)',
            'secondary-hover-bg': 'var(--ds-btn-secondary-hover-bg)',
            'secondary-hover-border': 'var(--ds-btn-secondary-hover-border)',
            'ghost-text': 'var(--ds-btn-ghost-text)',
            'ghost-hover-bg': 'var(--ds-btn-ghost-hover-bg)',
            'ghost-hover-border': 'var(--ds-btn-ghost-hover-border)',
            'liquid-bg': 'var(--ds-btn-liquid-bg)',
            'liquid-hover-bg': 'var(--ds-btn-liquid-hover-bg)',
          },
        },
      },
      borderRadius: {
        none: '0px',
        xs: '5px',
        sm: '8px',
        md: '11px',
        lg: '18px',
        xl: '22px',
        '2xl': '28px',
        '3xl': '34px',
        pill: '50px',
        full: '9999px',
        // ===== DeepSeek Harness 圆角（新增）=====
        // ⚠️ 必须用「平铺」key 而非 `ds: {...}` 嵌套对象：
        //    borderRadius / spacing 在 Tailwind 3 中是扁平静态刻度，不参与嵌套命名空间展开，
        //    写成 `ds: { pill: ... }` 不会生成任何 class（已用真实 CLI 验证）。
        //    平铺为 'ds-pill' 才能生成 rounded-ds-pill，以此类推。
        // 注意 ds-pill=100px 与上面的 pill=50px 是刻意的差异（原站胶囊为 100px），二者互不影响。
        'ds-pill': '100px',
        'ds-card': '24px',
        'ds-panel': '16px',
        'ds-media': '10px',
        'ds-input': '10px',
        'ds-sm': '8px',
      },
      spacing: {
        // Mineradio 8px 基数节奏
        xxs: '4px',
        xs: '8px',
        sm: '12px',
        md: '17px',
        lg: '24px',
        xl: '32px',
        xxl: '48px',
        section: '80px',
        // ===== DeepSeek Harness 间距刻度（新增）=====
        // 同样必须平铺：生成 gap-ds-4 / px-ds-4 / p-ds-6 / py-ds-10 / mt-ds-4 等。
        'ds-1': '4px',
        'ds-2': '8px',
        'ds-3': '12px',
        'ds-4': '16px',
        'ds-5': '24px',
        'ds-6': '32px',
        'ds-7': '40px',
        'ds-8': '56px',
        'ds-9': '80px',
        'ds-10': '120px',
        'ds-11': '160px',
        'ds-12': '200px',
        'ds-13': '240px',
      },
      // ===== DeepSeek Harness 字号阶梯（新增；本任务的空白项）=====
      // 取值逐项对齐 src/styles/ds-components.css 里的 .ds-text-* 实现（唯一权威来源），
      // 不臆造数值。用「元组」形态 [fontSize, { lineHeight, letterSpacing }] 一次性带上行高/字距。
      // ⚠️ fontSize 与 colors 一样是**支持对象/元组形态**的刻度，可以带 options；
      //    与 borderRadius / spacing 的「扁平 key」规则不同，两者都是实测过的：
      //      fontSize['ds-heading1'] -> text-ds-heading1 ✅
      //      fontSize['ds-display']   -> text-ds-display  ✅
      //    尺寸走**固定 px**（而非 clamp），与 ds-components.css 的 768px 断点保持一致：
      //    需要「小屏 28 / 大屏 36」时写 `text-ds-heading1 md:text-ds-heading1-md`。
      fontSize: {
        // 展示级 40 -> 64px
        'ds-display': ['40px', { lineHeight: '1.4', letterSpacing: '-0.02em' }],
        'ds-display-md': ['64px', { lineHeight: '1.4', letterSpacing: '-0.02em' }],
        // Hero 36 -> 46px
        'ds-hero': ['36px', { lineHeight: '1.5', letterSpacing: '-0.02em' }],
        'ds-hero-md': ['46px', { lineHeight: '1.5', letterSpacing: '-0.02em' }],
        // Heading1 28 -> 36px
        'ds-heading1': ['28px', { lineHeight: '1.5', letterSpacing: '-0.02em' }],
        'ds-heading1-md': ['36px', { lineHeight: '1.5', letterSpacing: '-0.02em' }],
        // Heading2 22 -> 28px
        'ds-heading2': ['22px', { lineHeight: '1.5', letterSpacing: '-0.02em' }],
        'ds-heading2-md': ['28px', { lineHeight: '1.5', letterSpacing: '-0.02em' }],
        // Heading3 18 -> 20px
        'ds-heading3': ['18px', { lineHeight: '1.5', letterSpacing: '-0.02em' }],
        'ds-heading3-md': ['20px', { lineHeight: '1.5', letterSpacing: '-0.02em' }],
        // 正文层级（单档，无断点）
        'ds-title': ['18px', { lineHeight: '1.5', letterSpacing: '-0.01em' }],
        'ds-subtitle': ['20px', { lineHeight: '1.5', letterSpacing: '-0.01em' }],
        'ds-body': ['16px', { lineHeight: '1.6' }],
        'ds-caption': ['14px', { lineHeight: '1.5' }],
        'ds-xs': ['13px', { lineHeight: '1.5' }],
      },
      transitionTimingFunction: {
        apple: 'cubic-bezier(0.25, 0.1, 0.25, 1)',
        'mineradio': 'cubic-bezier(0.16, 1, 0.3, 1)',
        'mineradio-soft': 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
      transitionDuration: {
        '150': '150ms',
        '200': '200ms',
        '250': '250ms',
        '300': '300ms',
        '500': '500ms',
        '1500': '1500ms',
      },
      boxShadow: {
        product: '0 5px 30px rgba(0,0,0,0.22)',
        popover: '0 4px 24px rgba(0,0,0,0.08), 0 1px 4px rgba(0,0,0,0.04)',
        glass: '0 22px 64px rgba(0,0,0,.30), 0 0 34px rgba(0,245,212,.052), inset 0 1px 0 rgba(255,255,255,.16), inset 0 -24px 58px rgba(0,0,0,.16)',
        'glass-focus': '0 24px 72px rgba(0,0,0,.34), 0 0 0 1px rgba(0,245,212,.13), 0 0 42px rgba(0,245,212,.075), inset 0 1px 0 rgba(255,255,255,.20)',
        'panel-glass': 'inset 0 0 2px 1px rgba(255,255,255,.35), inset 0 0 10px 4px rgba(255,255,255,.15), 0 4px 16px rgba(17,17,26,.05), 0 8px 24px rgba(17,17,26,.05), 0 16px 56px rgba(17,17,26,.05), inset 0 4px 16px rgba(17,17,26,.05), inset 0 8px 24px rgba(17,17,26,.05), inset 0 16px 56px rgba(17,17,26,.05)',
        'button-glass': 'inset 0 0 2px 1px rgba(255,255,255,.34), inset 0 0 10px 4px rgba(255,255,255,.13), 0 10px 30px rgba(0,0,0,.18)',
        'button-glass-hover': 'inset 0 0 2px 1px rgba(255,255,255,.42), inset 0 0 12px 5px rgba(255,255,255,.17), 0 12px 34px rgba(0,0,0,.22), 0 0 18px rgba(255,255,255,.06)',
        // ===== DeepSeek Harness 阴影（新增）=====
        // 原站 light 下卡片：1px 发丝外描边 + 两级柔和投影；dark 下退化为顶部 1px 内高光
        'ds-card': 'var(--ds-shadow-card)',
        'ds-lift': '0 24px 64px rgba(0,0,0,.4), 0 0 80px hsla(0,0%,100%,.07), 0 0 0 1px hsla(0,0%,100%,.06)',
        'ds-dropdown': '0 0 1px 0 rgba(0,0,0,.2), 0 0 4px 0 rgba(0,0,0,.02), 0 12px 32px 0 rgba(0,0,0,.08)',
        'ds-liquid': '0 2px 8px rgba(115,163,210,.1), inset 0 1px 1px hsla(0,0%,100%,.6)',
        'ds-liquid-hover': '0 4px 12px rgba(115,163,210,.2), inset 0 1px 1px hsla(0,0%,100%,.8)',
      },
      backdropBlur: {
        glass: '12px',
        'glass-lg': '34px',
        'glass-sm': '20px',
        'panel-glass': '12px',
        // ===== DeepSeek Harness 玻璃模糊（12px）=====
        // ⚠️ 必须带 12px 兜底，不能只写 var(--ds-blur-glass)：
        //    --ds-blur-glass 由 ds-tokens.css 定义在 `[data-ds-theme], .ds-scope` 下
        //    （该文件刻意不用 :root，以隔离 --ds-* 命名空间），而本应用从未挂载这两个
        //    选择器，因此裸 `var(--ds-blur-glass)` 会解析为**空值**，导致
        //    `backdrop-filter: blur()` 整条声明失效（computed 为 none）——
        //    构建不报错、class 也在产物里，但玻璃模糊静默消失。
        //    var() 的第二参数为兜底值：在 .ds-scope 内取 12px（值相同），
        //    在应用默认作用域下也取 12px，两种场景行为一致。
        ds: 'var(--ds-blur-glass, 12px)',
      },
      backgroundImage: {
        'ambient-glow':
          'radial-gradient(ellipse 60% 50% at 15% 10%, var(--ambient-from), transparent 60%), radial-gradient(ellipse 50% 40% at 85% 90%, var(--ambient-to), transparent 65%)',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
}

export default config
