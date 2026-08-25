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
      },
      backdropBlur: {
        glass: '12px',
        'glass-lg': '34px',
        'glass-sm': '20px',
        'panel-glass': '12px',
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
