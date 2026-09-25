# Aurora Music 样式规格（Style Sheet）

> **这份文档是什么**：**实现层规格**。它回答「有哪些类、各是什么值、怎么叠在一起、改动时必须同步什么」。
>
> 姊妹篇 [design-system.md](design-system.md) 回答的是另一半问题：「**为什么**这样设计、**什么时候**该用哪一种」。
> 两篇分工不重叠：**做决策看设计系统，查实现看本文。**
>
> **数值权威来源**：[globals.css](../packages/app/src/styles/globals.css)（1242 行，全部落地样式）、
> [ds-tokens.css](../packages/app/src/styles/ds-tokens.css)（上游设计 token）。
> 本文是它们的抽象索引——**两者冲突时以代码为准，并回来修本文**（现存代码问题见 §10）。
>
> ⚠️ **行号约定**：文中 `globals.css:NNNN` 是核对时的行号。代码仍在演进，行号会漂移——
> **类名、区块标题、符号名才是稳定锚点**，定位不到时直接 grep 它们。

---

## 1. 文件、加载顺序与分区索引

| 文件 | 角色 | 是否进生产构建 |
| --- | --- | --- |
| `packages/app/src/styles/globals.css` | 全部落地样式：变量、组件语义类、背景色场、降级规则 | ✅ |
| `packages/app/src/styles/ds-tokens.css` | `--ds-*` 设计 token（**134 条声明 / 84 个唯一名**），上游事实 | ✅（被 `@import`） |
| `packages/app/src/styles/ds-components.reference.css` | DS 原站组件类参考实现 | ❌ 有意移出 |
| `packages/app/public/ds-showcase.html` | 视觉对照页 | ❌ |

### 1.1 加载顺序有硬约束

`globals.css:23` 的 `@import './ds-tokens.css'` **必须在 `@tailwind` 指令（`globals.css:25-27`）之前**。

原因写在文件头注释（`globals.css:19-21`）：CSS 规范要求 `@import` 先于其他规则，
而本项目 **PostCSS 未装 `postcss-import`**（`postcss.config.js` 只有 `tailwindcss` + `autoprefixer`），
靠 Vite 内建 CSS 处理解析——放在 `@tailwind` 之后会被**静默丢弃**（无报错、无警告，token 全部失效）。

### 1.2 globals.css 分区索引

| 区段 | 行号 | 内容 |
| --- | --- | --- |
| 文件头注释 | 1–22 | 「`@import` 必须在最顶部」的警示 |
| `@import` + Tailwind | 23–27 | 见 §1.1 |
| 风格取向注释 | 29–52 | DS 结构 + Mineradio mint 品牌、双 token 块警告 |
| `@layer base` — 深色 `:root` | 54–261 | 项目主题变量（`--fc-*` / `--tw-*` / `--glass-*` / `--ambient-*`） |
| 浅色主题块 | 262–433 | `html:not(.dark)`（**269**）变量 + 组件级覆盖（384）+ `text-white/*` 可读性提升（419） |
| `@layer base` — 元素与排版类 | 434–474 | `html/body/#root` 默认、`.font-*`、`.text-*`（**465–472**） |
| `@layer components` — 玻璃族 | 476–556 | 五个玻璃类（483–628 内） |
| 液态玻璃说明 + `@layer components` | 557–628 | 「为什么不做几何折射」结论 + `.glass-liquid`（**595**） |
| `@layer components` — 表面与组件类 | 630–860 | 卡片、按钮、胶囊、分段、滚动条、表面 |
| Range / seek / volume | 861–982 | 滑杆三件套（`seek-bar` 897、`volume-bar` 947） |
| 大屏与黑胶 | 983–1026 | ≥1500px 控件放大、详情页旋转封面（`vinyl-disc` 1005）、`backdrop-fade-in`（1022） |
| **背景色场体系** | **1027–1168** | `.ambient-backdrop`（1032）一族与降级（§4） |
| 歌词排版与高亮 | 1171–1218 | `.lyric-line`（1194）/ `.lyric-active`（1198）/ `.lyric-active-lg`（1215） |
| **性能降级开关** | **1220–1261** | `.resizing` / `.glass-perf-lite`（§6） |

---

## 2. 变量命名空间与主题契约

### 2.1 三套命名空间（互不覆盖）

| 命名空间 | 定义位置 | 作用域 | 谁在用 |
| --- | --- | --- | --- |
| `--ds-*`（设计 token） | `ds-tokens.css:45` | `[data-ds-theme="dark\|light"]`，**刻意不用 `:root`** | 见下方「消费现状」 |
| `--fc-*` / `--tw-*`（项目主题） | `globals.css:54`（深）、`269`（浅） | `:root` 与 `html:not(.dark)` | **全站样式的主体**：颜色、表面、玻璃、色场 |
| shadcn HSL 变量 | `--border` / `--background` / `--ring`… | `:root` | shadcn 基础组件 |

**`--ds-*` 的真实消费现状**（易被误解，改动前先看）：

| token 族 | 生产代码消费情况 |
| --- | --- |
| `--ds-blur-glass` | ✅ 经 Tailwind `backdrop-blur-ds` 间接消费（`tailwind.config.ts` 的 `backdropBlur.ds = var(--ds-blur-glass, 12px)`），用于 `MobileNowPlaying.tsx`、`UpdateBanner.tsx`、`SongDetailPage.tsx` |
| `--ds-color-*` | ✅ 经 Tailwind `ds.*` 色板消费 |
| `--ds-radius-*` | ❌ **无消费**：`rounded-ds-*` 工具类是**硬编码 px**（`tailwind.config.ts` 的 `borderRadius['ds-*']`），不读 `var(--ds-radius-*)`；源码中出现的 `--ds-radius-pill` 字样全在注释里 |
| `--ds-space-*`、`--ds-color-bg-page`、`--ds-font-*` | ❌ **生产构建零消费**（仅 `ds-components.reference.css` 引用，该文件不进构建） |

> ⚠️ 注意 `tailwind.config.ts` 的 `borderRadius` / `spacing` 是**扁平静态刻度**，必须写平铺 key
> （`'ds-pill': '100px'`）；写成 `ds: { pill: ... }` 不会生成任何 class——这是实测过的坑。

### 2.2 双 token 块同步铁律

`globals.css` 有**两个独立 token 块**，主题感知变量必须**同时改两处**，否则「一种主题正常、另一种崩掉」：

| 主题 | 选择器 | 触发方式 |
| --- | --- | --- |
| 深色（默认） | `:root`（`globals.css:54`） | `<html>` 无 `.dark` 即为深色 |
| 浅色 | `html:not(.dark)`（`globals.css:269`） | `<html class="dark">` 被移除 |

运行时切换在 `App.tsx` 完成，**双写两个钩子**（缺一会让 DS token 与项目主题脱节）：

```ts
document.documentElement.classList.toggle('dark', isDark)            // App.tsx：主题 effect
document.documentElement.setAttribute('data-ds-theme', isDark ? 'dark' : 'light')  // App.tsx：同上
```

主题来源是 `libraryStore.theme`（`'light' | 'dark' | 'system'`，默认 `'dark'`），设置入口在 `SettingsPage.tsx`。

### 2.3 运行时注入的变量（不在 CSS 里）

**`<html>` 级**（由 JS 写 inline style，无封面时 `removeProperty` 回退 CSS 默认值）：

| 变量 | 写入方 | 值 |
| --- | --- | --- |
| `--ambient-from` / `--ambient-to` / `--ambient-glow` | `useThemeColor.ts:70-76` | 封面色推导，见 §4.2 |
| `--accent-from-color` / `--accent-to-color` | `useThemeColor.ts:65-66` | 封面原色 @ `.18` / `.1`，供歌词等场景 |

**元素级**（不写 `<html>`，仅作用于单个组件）：

| 变量 | 写入方 | 用途 |
| --- | --- | --- |
| `--seek` / `--volume` | `PlayerBar.tsx`、`MobileNowPlaying.tsx` | 滑杆已播放比例的 CSS 内联值 |

⚠️ 排查「背景没变色」时先确认 `--ambient-*` 有没有被写入 `<html>`。

### 2.4 Tailwind 层的映射关系

`tailwind.config.ts` 把 CSS 变量接到工具类上，两条关键重映射：

- `white` → `rgb(var(--tw-white) / <alpha-value>)`：**深色下是白、浅色下翻转成深墨**，
  因此全站 400+ 处 `text-white/40`、`bg-white/[0.06]` 自动适配浅色，无需逐个改；
- `mint` → `rgb(var(--tw-mint) / <alpha-value>)`、`mint-fg` → `rgb(var(--tw-mint-fg) / <alpha-value>)`：
  浅色下 mint 加深为 `#009C88` 保证对比度。

其余命名空间：`fc.*`（`--fc-*`）、`ink.*`、`canvas.*`、`coral`、`ds.*`（`--ds-color-*`）。
`darkMode: ['class']`，与 §2.2 的 `.dark` 机制一致。

⚠️ **`rounded-ds-*` 与 `--ds-radius-*` 是两套值**：前者是 Tailwind 里硬编码的固定 px，
后者只是上游 token；改一处不会影响另一处（§2.1）。

---

## 3. 层级栈（stacking order）

### 3.1 层序总表

| # | 层 | 元素 / 类 | 定位手段 | 关键约束 |
| --- | --- | --- | --- | --- |
| 0 | 静态色底 | `.ambient-backdrop::before`（1038） | `z-index: -2` | **任何降级规则都不得隐藏它**，否则背景闪黑 |
| 1 | 色场色斑 | `.ambient-blob`（1055）×4 | `z-index: -1` | 必须是**独立元素**，不可合并 background（§4.3） |
| 2 | 内容 | 侧栏 / 内容列 / 右栏 | 正常流（DOM 顺序） | 侧栏在 DOM 中先于内容列（`App.tsx` 的 `AppLayout` 三个顶层子块） |
| 3 | 材质 | 同上元素自身即玻璃 | — | 玻璃不是独立图层，是**容器自身的材质** |
| 4 | 播放条 | `.glass-saved-panel`（483） | 内容列内绝对定位 | 相对**内容列**居中，避免压到右栏 |
| 5 | 浮层 | `.glass-liquid`（595） 队列 / 搜索 / 弹窗 | `absolute` / `fixed` | 队列为 `absolute right-0 bottom-full`（`QueueView.tsx`） |
| 6 | 遮罩与提示 | 抽屉 / 弹窗遮罩 / 搜索浮层 / Toast | `fixed` + `z-[60]…z-[100]` | 见下 |

**显式 z-index 的实际分布**（不止一处，改动浮层时按此对齐）：

| z-index | 用途 | 位置 |
| --- | --- | --- |
| `z-[60]` | 弹窗遮罩 | `App.tsx`（弹窗渲染处） |
| `z-[70]` | 移动端抽屉、重复歌曲提示 | `MobileNav.tsx`、`components/common/DuplicateInfo.tsx` |
| `z-[80]` | 搜索浮层 | `SearchOverlay.tsx` |
| `z-[90]` | 浮层内的右键菜单（4 处） | `SearchOverlay.tsx` 等 |
| `z-[100]` | Toast | `components/common/Toast.tsx` |

### 3.2 根容器与隔离

```tsx
// App.tsx 的 AppLayout() 根容器 —— 所有色场的宿主
<div className="h-screen w-screen flex flex-col overflow-hidden relative bg-background text-foreground ambient-backdrop">
```

`.ambient-backdrop`（`globals.css:1032`）= `position: relative` + **`isolation: isolate`**。
`isolation` 是必需的：它建立新的堆叠上下文，使 `z-index: -2/-1` 的色场**沉在所有内容之下，
但不会掉到窗口背景之外**（否则会被 Electron 窗口底色盖住或产生穿帮）。

详情页沉浸背景（`App.tsx` 的 `backdropReady` 分支）在同一根容器内、`absolute inset-0`，位于色场之上、内容之下。

### 3.3 响应式与端差异

| 维度 | 规则 | 位置 |
| --- | --- | --- |
| **端判定** | `isMobile()`：先排除 `window.electronAPI`，再看 Capacitor 平台；纯浏览器（`vite preview`）走桌面布局 | `lib/utils.ts` |
| **断点** | Tailwind 默认（`md` 768 / `lg` 1024 / `xl` 1280），**未自定义 `screens`** | `tailwind.config.ts` |
| **大屏档** | `min-[1500px]:` 任意变体（对应 1080p@125% 全屏），播放控件整体放大一档 | `globals.css:986`、`PlayerBar.tsx` |
| **桌面布局** | 左栏 `w-56` + 内容列 + 右栏 `w-72`（`hidden lg:block`） | `App.tsx` 的两处 `<aside>` |
| **移动布局** | 顶部汉堡 + 左侧抽屉（`fixed`，`z-[70]`）+ 全屏 Now Playing | `MobileNav.tsx` |
| **详情页折叠** | 侧栏/右栏以 300ms `ease-apple` 折叠为 `w-0`（**不卸载**，避免内容列宽度突变导致悬浮播放条横移跳动），折叠期间挂 `.glass-perf-lite` 关模糊 | `App.tsx` 的两处 `<aside>` 折叠块 + `glass-perf-lite` effect |

⚠️ **端判定的坑**：桌面端 bundle 会经 platform/mobile 链**静态引入 `@capacitor/core`**，其 IIFE 会把 `window.Capacitor`
注入到桌面端——因此必须先排除 `electronAPI`，否则**桌面端会被误判为移动端、左侧导航栏被隐藏**（注释保留在 `lib/utils.ts`）。

---

## 4. 背景体系

背景由**三个独立机制**叠加而成，分别负责「底色」「氛围」「沉浸」，玻璃只是它们的折射面。

### 4.1 三个机制一览

| 机制 | 实现 | 生效范围 | 代价 |
| --- | --- | --- | --- |
| **色场**（4 层色斑） | `radial-gradient` + 极慢 transform 漂移 | 全部页面，常驻 | 近似零（静态图 + 合成层位移） |
| **沉浸背景** | 封面原图 `object-cover` + 渐变遮罩 + mint 径向提亮 | 仅歌曲详情页 | 一次性光栅化，逐帧仅合成 |
| **玻璃材质** | `backdrop-filter` | 侧栏 / 顶栏 / 右栏 / 播放条 / 浮层 | 逐帧重采样（最贵，见 §9） |

### 4.2 色场变量契约

色场由 5 个变量驱动，**深浅两套值必须同时维护**：

| 变量 | 深色（`globals.css:249-256`） | 浅色（`globals.css:376-380`） | 语义 |
| --- | --- | --- | --- |
| `--ambient-from` | `rgba(0, 214, 186, .34)` | `rgba(0, 176, 152, .22)` | 主色斑（跟随封面主色） |
| `--ambient-to` | `rgba(20, 92, 158, .50)` | `rgba(77, 159, 216, .26)` | 次色斑（跟随封面次色） |
| `--ambient-glow` | `rgba(74, 140, 200, .38)` | `rgba(56, 170, 235, .18)` | 高光斑（主副混色） |
| `--ambient-base` | `#0a1524` | `#eef3fa` | 静态色底，**不能是纯黑/纯白** |
| `--ambient-strength` | `1` | `1` | 色场总强度旋钮（`calc()` 乘进各层 opacity） |

**为什么浅色 alpha 明显更低**：浅色是「越加越亮」，alpha 过高会把底色冲到 L≈0.88，
白玻璃叠在近白场上等于消失。深色则是越加越「有色」。

**为什么底色不能纯黑**：纯黑底会把半透明色斑的饱和度吃掉大半——这正是「色场几乎看不见」的根因。

### 4.3 四层色斑规格

DOM 顺序与 `App.tsx` 中 `AppLayout()` 的四层色斑一致，从下到上：

| 层 | 类（行号） | 渐变 | 锚点 | 自身 opacity | 漂移周期 |
| --- | --- | --- | --- | --- | --- |
| 纵深 | `.ambient-blob--depth`（1146） | `linear-gradient(180deg, transparent → to@22% → glow@30%)` | 全屏 `inset: 0`，`border-radius: 0` | `--ambient-strength` | **无动画**（静态层） |
| 主色 | `.ambient-blob--primary`（1094） | `radial-gradient(circle at 18% 45%)`，色标 0/30%/54%/76% | `inset: -20%` | `× 0.95` | `ambient-drift-a` **34s** |
| 次色 | `.ambient-blob--secondary`（1107） | `radial-gradient(ellipse 46% 62% at 78% 62%)` | `inset: -20%` | `× 1` | `ambient-drift-b` **46s** |
| 高光 | `.ambient-blob--glow`（1121） | `radial-gradient(ellipse 58% 40% at 50% 72%)` | `inset: -20%` | `× 0.85` | `ambient-drift-c` **40s** |

三个设计要点（改动前必读，`.ambient-blob` 定义处有完整长注释）：

1. **多色标（0/30/54/76%）替代 `filter: blur()`** 做柔边。`transparent 76%` 这类收尾已足够柔和，
   肉眼与 `blur(90px)` 几乎无差，但它是**静态背景图**——移动时只发生合成层位移，不触发滤镜运算。
2. **动画挂在空的子层 `.ambient-blob__drift`（1138）上**，不是外层色斑。
   外层挂着 `color-mix` 推导的自定义属性与 0.9s 过渡，动画会让它每帧重新光栅化（实测 38.7 FPS）；
   挪到只做 transform 的子层后满帧。
3. **周期刻意互质且方向不同**（34/46/40s，位移幅度 2%~2.5% + `scale 1.01~1.1`），
   避免整块同步移动的「贴纸感」。

> 全族**不使用滤镜**。仅 `.ambient-blob--depth` 有一条显式 `filter: none`（`globals.css:1153`），
> 语义等价于无滤镜，属防御性声明。

### 4.4 取色链路（封面色 → 色场）

```
当前曲目 coverPath / coverUrl
   └─ App.tsx  AppLayout() 里的 useThemeColor(currentTrack?.coverPath || currentTrack?.coverUrl)
        └─ useThemeColor.ts:39  缓存去重（同一路径不重复提取）、无封面时 removeProperty 回退默认
             └─ colorExtractor.ts:132  extractColorsFromUrl(url)
                  │  远端 https 直连；本地路径走 platform.getCoverSrc()（useThemeColor.ts:57）
                  └─ colorExtractor.ts:56  extractColorsFromImage(imageData)
                       画到 100×100 canvas → 逐像素 HSL 分桶
                       过滤：alpha<128、亮度 <10 或 >90、饱和 <15
                       产出 primary / secondary / vibrant / muted / darkVibrant / lightMuted
             └─ useThemeColor.ts:20  toFieldColor()  ← 关键修色步骤
             └─ useThemeColor.ts:70-76  setProperty('--ambient-*')
```

`toFieldColor(r, g, b, alpha, { satBoost, minLum })` 做两件事（`useThemeColor.ts:20-37`）：

| 处理 | 公式 | 默认参数 | 为什么必需 |
| --- | --- | --- | --- |
| **提饱和** | `new = lum + (c - lum) × satBoost`，`lum` 用 Rec.709 权重 | `satBoost: 1.35` | 灰封面（人像、黑白专辑）不提饱和，背景仍是灰的，玻璃折射一片死灰 |
| **抬亮度下限** | `newLum < minLum` 时整体乘 `k = minLum / newLum` | `minLum: 46` | 深棕、墨绿封面会把背景基调压死 |

三色斑的写入参数：

| 变量 | 来源 | alpha | 参数 |
| --- | --- | --- | --- |
| `--ambient-from` | primary | `0.50` | 默认 |
| `--ambient-to` | secondary | `0.62` | 默认 |
| `--ambient-glow` | primary 与 secondary 的**算术平均** | `0.48` | `satBoost: 1.2, minLum: 44` |

> **第三色为什么取混色**：直接复用主色或次色会在两者色相冲突时出现脏色；取平均值可保证它落在两者之间。

> **alpha 不是随手填的**：它按参考站色场亮度 L≈0.05~0.069 标定过。
> `.50/.62/.48` 是回调后的值——更早的取值实测 L≈0.07~0.11，过亮 1.6×。

### 4.5 色场过渡与降级

| 机制 | 实现 | 位置 |
| --- | --- | --- |
| 切歌平滑过渡 | `@property --ambient-* { syntax: '<color>' }`（**1161-1163**）注册为可插值类型 + `.ambient-blob`（1055）上 `transition: --ambient-* 0.9s` | `globals.css` |
| 减少动效 | `@media (prefers-reduced-motion: reduce)` → `.ambient-blob__drift { animation: none }`（**1184**） | `globals.css` |

⚠️ 未注册 `@property` 时自定义属性是**离散**的，改值会「啪」地跳变——这是切歌时背景硬切的唯一原因。
不支持 `@property` 的旧内核会忽略该块，退化为瞬时切换，不影响可用性。

### 4.6 详情页沉浸背景

`App.tsx` 的 `isSongDetail && currentTrack && backdropReady` 分支，仅歌曲详情页挂载：

| 元素 | 值 |
| --- | --- |
| 容器 | `absolute inset-0 overflow-hidden pointer-events-none animate-[backdrop-fade-in_.45s_ease]`（`backdrop-fade-in` 在 `globals.css:1022`） |
| 封面层 | 封面原图 `object-cover`，`opacity-55`，**不加 CSS blur、不 scale 放大** |
| 遮罩层 | `bg-gradient-to-b from-background/75 via-background/50 to-background/95` |
| 提亮层 | `radial-gradient(ellipse 60% 45% at 28% 18%, rgba(var(--fc-accent-rgb),.10), transparent 65%)` |

两条历史教训（注释保留在 `App.tsx` 的沉浸背景块）：

1. **旧方案的全屏 `blur-[64px]` 是卡顿源**：滤镜每帧全屏重算。无滤镜的静态图层只一次性光栅化缓存，
   逐帧仅合成，**成本低于玻璃 `backdrop-filter`**。
2. **延迟 320ms 挂载**：等侧栏/瓷砖折叠动画结束再渲染，否则动画期间每帧重算模糊，展开过程严重掉帧。
   详情页内切歌时 `backdropReady` 已为 `true`，背景立即随新封面更新。

---

## 5. 玻璃材质族

### 5.1 五个玻璃类

| 类 | `backdrop-filter` | 背景变量（深色） | 边框 | 厚度层 | 用途 |
| --- | --- | --- | --- | --- | --- |
| `.glass-regular`（541） | `blur(24px) saturate(1.5) brightness(1.05)` | `--glass-regular-bg` | — | `::before`（547） | **常驻面板主材质**：侧栏、右栏 |
| `.glass-liquid`（595） | `blur(24px) saturate(1.6) brightness(1.08)` | `--glass-liquid-bg` | `--glass-liquid-border` | `::before`（610） | **浮层首选**：下拉、右键菜单、弹窗、搜索、播放队列 |
| `.glass-floating`（517） | `blur(24px) saturate(1.5) brightness(1.06)` | `--glass-floating-bg` | `--glass-floating-border` | — | 小面积信息层：Toast、重复歌曲提示 |
| `.glass-saved-panel`（483） | `var(--saved-panel-glass-filter)` = `blur(24px) saturate(1.6) brightness(1.05)` | `rgba(255,255,255,.05)` | `border: 0` | 在自身 `--saved-panel-glass-shadow` 里 | **播放条**（类内圆角 `100px`，实际被使用处覆盖，见下注） |
| `.glass-saved-button`（498） | `var(--saved-button-glass-filter)` = `blur(20px) saturate(1.5) brightness(1.05)` | `rgba(255,255,255,.05)` | `border: 0` | 在阴影变量里 | 播放控件按钮 |

深色下材质变量集中在玻璃族变量区；浅色覆盖在 `globals.css` 的 `html:not(.dark)` 块内同名变量处。

> **材质档位已收敛为五个**。历史上有 9 个：`glass-strong` / `glass-subtle` / `glass-popover` /
> `glass-search-box` 四个类**生产代码零引用**（搜索浮层与弹层早已统一走 `.glass-liquid`），
> 已连同它们独有的 CSS 变量、SVG 滤镜定义一并删除。需要更强/更弱的常驻面板时，
> 按 `.glass-regular` 的规格复制一档并**同步 §6.3 的降级清单**。

> ⚠️ **材质类不决定圆角，使用处才决定**。`@layer components` 里的声明会被使用处的 Tailwind 工具类覆盖
> （`utilities` 层优先级更高），且多数材质类**根本没有 `border-radius` 声明**。
> 例：`.glass-saved-panel` 类内写的是 `--saved-panel-glass-radius: 100px`，但播放条实际用
> `rounded-[24px]`（桌面）与 `rounded-[16px]`（移动端迷你条）；浮层则统一用 `rounded-ds-panel`。
> **查「某个元素到底多大圆角」必须看使用处，不能只看材质类。**

### 5.2 厚度层实现约定（硬约束）

`.glass-regular` / `.glass-liquid` 的「厚度」**必须用 `::before` 画，不能写进 `box-shadow`**：

```css
.glass-regular::before {          /* globals.css:547 */
  content: ''; position: absolute; inset: 0;
  border-radius: inherit; pointer-events: none;
  box-shadow: var(--glass-liquid-edge);
}
```

原因（`.glass-regular` 定义处的长注释）：侧栏/标题栏的 class 带 Tailwind 的 **`shadow-none`**
（它们紧贴窗口边缘，外投影会被裁掉显脏），而 `shadow-none` 会把 `box-shadow` **整个覆盖掉**——
实测侧栏的 `box-shadow` 被静默清零成三个透明占位值，于是「所有面板统一厚度」的约定在**最重要的侧栏上失效**。
伪元素画法与该属性完全解耦。

厚度构成（`--glass-liquid-edge`）：

```
inset 0  1px   0   0    rgba(255,255,255,.34)   ← 顶部：1px 零模糊（掠射反射是锐的）
inset 0 -1.5px 1px -1px rgba(255,255,255,.18)   ← 底部：偏移 + 1px 模糊（折返光是柔的）
```

**「上锐下柔」的不对称是「有厚度的材料」与「一条描边」的分界**，也是全项目玻璃材质统一的锚点。

### 5.3 SVG 位移滤镜分支

`GlassSvgFilter`（`components/common/GlassSvgFilter.tsx`）挂载时检测支持性，
给 `<html>` 加 `control-glass-svg-ok`，CSS 据此切换分支：

| 类 | 默认 | `html.control-glass-svg-ok` 下 |
| --- | --- | --- |
| `.glass-saved-button`（506） | `blur(20px) saturate(1.5) brightness(1.05)` | `var(--saved-button-glass-svg-filter)` |
| `.glass-saved-panel`（492） | 纯透明 blur | **不变**——刻意不启用 SVG 滤镜，避免背后文字翻转扭曲 |

滤镜当前只有**一组**：`mineradio-control-glass-filter`（`lib/glassFilter.ts`）。
搜索框 / 搜索药丸两组滤镜已随零引用类删除（§5.1）。

⚠️ 正因为存在 `html.control-glass-svg-ok .glass-saved-panel`（特异性 0,2,1），
降级规则**必须带 `!important`** 才能压过它（§6.3）。

---

## 6. 降级开关

### 6.1 两个开关

| 开关 | 触发源 | 场景 | 代码位置 |
| --- | --- | --- | --- |
| `.resizing` | 窗口拖拽缩放开始 | 期间模糊区域尺寸每帧变化 | `components/layout/ResizeHandle.tsx` |
| `.glass-perf-lite` | 进出详情页的侧栏/瓷砖折叠动画（动画 300ms）、移动端抽屉开合 | 过渡期间临时关模糊（降级窗口 400ms，含 100ms 余量） | `App.tsx` 的 `glass-perf-lite` effect、`MobileNav.tsx` |

> 历史上有第三个开关 `.glass-flat`（扁平模式）：它**只有 `remove` 没有 `add`**，运行时永不生效。
> 已连同 `glassMode` 状态、`GlassMode` 类型与整套 CSS 规则一并删除（§11）。

### 6.2 行为差异（两者并不同）

| | `.resizing` | `.glass-perf-lite` |
| --- | --- | --- |
| `backdrop-filter` | `none !important` | `none !important` |
| 背景 / `box-shadow` / 厚度层 `::before` | 全部保留 | 全部保留 |
| 色斑 | `.ambient-blob { opacity: 0; animation: none }`（1240），保 `.ambient-blob--depth`（1241） | **不改动色斑**（无对应规则） |

两条设计依据：

- **保留厚度层**：厚度是廉价的 `box-shadow`，关掉没有性能收益，保留能让动画期间视觉不突变
  （`design-system.md` §2.6）。
- **隐藏色斑时必须保底 `.ambient-blob--depth`**：它是纯 `linear-gradient`、无动画，代价近似为零；
  连它一起藏掉，降级态背景会退回一块死黑。`.ambient-backdrop::before`（静态色底）同理**不可隐藏**。

### 6.3 覆盖类清单：5 个（同一处列表）

```
glass-regular  glass-floating  glass-liquid  glass-saved-panel  glass-saved-button
```

全部写在**同一处**选择器列表（`globals.css:1222-1232`，`.resizing` 与 `.glass-perf-lite` 共用），
**新增或改名玻璃类后必须更新它**，否则会出现「降级开关没关掉这块玻璃」的性能隐患。

**`!important` 是必需的，不是偷懒**（`globals.css:1217-1220`）：`html.control-glass-svg-ok .glass-saved-panel`
特异性高于 `.resizing .glass-saved-panel`，不加 `!important` 总开关会**静默失效**——
恰好在「性能降级」模式下保留最贵的 `blur(24px)`。此坑已实际发生过一次。

---

## 7. 组件语义类索引

**大部分**定义在 `globals.css` 的 `@layer components` 内；`.row-hover` / `.apple-press` / `.vinyl-disc`（1005）/
`.lyric-line`（1194）/ `.lyric-active`（1198）等则在 layer 之外。**新增界面优先复用，不要新造并行词汇**（如 `.ds-btn-*`）。

| 族 | 类（行号） | 关键规格 |
| --- | --- | --- |
| **按钮** | `.btn-primary`（681） | mint 填充 + 深墨前景 `#030608` + `--r-pill` + 13px/700 + `padding: 8px 18px` |
| | `.btn-secondary`（698） | mint 描边 `rgba(0,245,212,.34)` + 透明底 |
| | `.btn-pearl`（711） | 玻璃材质（复用 `--saved-button-glass-*`） |
| | `.btn-icon`（730）/ `.is-on`（747）/ `.btn-xl` | 图标按钮；`.is-on` 为激活态；`btn-xl` 在 ≥1500px 放大 |
| **卡片** | `.card-utility`（637） | 玻璃 `blur(12px)` + hover 上浮 `-2px`（**不得用于长列表**） |
| | `.card-solid`（655） | **无 blur**，长列表卡片（背景已近不透明，省下逐帧重采样） |
| | `.card-list`（664） | 同材质但 **hover 不上浮**，包裹多行列表 |
| **表面** | `.surface-canvas/paper/card/tile-1/tile-2`（631–635） | 平铺叠色，无浮起关系 |
| **胶囊** | `.pill`（815）+ `.pill-sm/md/lg`（826–828） | `9999px` 全圆角；高度 28 / 36 / 44px |
| | `.pill-mint`（829）/ `.pill-soft`（836） | mint 实心 + 上浮；浅灰描边款 |
| **分段控件** | `.segmented`（786）/ `.segmented-item`（798）/ `.is-on`（812） | 28px 高，`--r-ds-input` 外圆角 + `--r-ds-sm` 内圆角；选中项 mint 填充 |
| **滑杆** | `.seek-bar`（897）/ `.volume-bar`（947）/ `.seek-lg` / `.volume-xl` | mint 渐变填充 + 发光滑块 |
| **行交互** | `.row-hover` | 只改背景（`rgba(0,245,212,.075)`），**不做位移**——避免鼠标扫过时整列表跳动 |
| | `.apple-press` | 只做 `:active` 的 `scale(.96)` 按压反馈，**不碰背景与描边** |
| **分隔与滚动** | `.hairline`（847）/ `.scrollbar-thin`（854）/ `.scrollbar-hide`（852） | 发丝边走 `--surface-card-border`；细滚动条 3px |
| **歌词** | `.lyric-line`（1194）/ `.lyric-active`（1198）/ `.lyric-active-lg`（1215） | `.lyric-line` 给出 `text-wrap: balance` 均衡折行断点；高亮为渐变文字 + **`drop-shadow` 双层发光**（不可改回 `text-shadow`，会从透明笔画内部透出来把字糊掉）；浅色主题整体翻转为深墨→青 |
| **黑胶** | `.vinyl-disc`（1005） | 详情页旋转封面 |
| **窗口** | `.titlebar-drag` / `.titlebar-no-drag` | Electron 拖拽区控制 |

---

## 8. 排版落地值

**实际生效的是 `globals.css:465-472` 的 `.text-*` 类**，不是 `design-system.md` §8.1 的字号表
（那是对照上游的层级描述，两处口径不同，见 §10 第 2 条）。

| 类 | font-size | weight | line-height | letter-spacing |
| --- | --- | --- | --- | --- |
| `.text-hero` | `clamp(34px, 4.6vw, 58px)` | 760 | 0.98 | 0 |
| `.text-display` | 28px | 700 | 1.1 | -0.374px |
| `.text-tagline` | 21px | 600 | 1.19 | +0.231px |
| `.text-body-strong` | 17px | 600 | 1.24 | -0.374px |
| `.text-body` | 14px | 400 | 1.47 | -0.224px |
| `.text-caption` | 12px | 400 | 1.43 | -0.12px（色 `--fc-muted`） |
| `.text-caption-strong` | 12px | 600 | 1.29 | -0.12px |
| `.text-micro` | 10.5px | 650 | — | +0.7px + `uppercase` |

`body` 默认：`14px / 1.47 / -0.1px`，`-webkit-font-smoothing: antialiased`，`user-select: none`。

字体栈：`"Noto Sans SC","PingFang SC","HarmonyOS Sans SC","Alibaba PuHuiTi","Inter",…`。
**不引入风格来源站的品牌字体**（商业授权风险，且不含中文字形），原因见 `design-system.md` §11.1。

---

## 9. 性能红线（样式层）

| 红线 | 依据 | 位置 |
| --- | --- | --- |
| **色斑上不得出现 `filter`，只要它同时在动** | 实测：`blur(80~110px)` + 无限动画 = **4 FPS**；同视觉改纯 `radial-gradient` = **60 FPS**。分层、`will-change`、放慢动画、只改 opacity 均**救不回来** | `.ambient-blob` 定义处的长注释 |
| **动画不得与 `color-mix` 推导的变量同元素** | 直接放外层色斑 → 38.7 FPS；挪到只做 transform 的空子层（1138）→ 满帧 | 同上 |
| **大面积滚动区域禁用 `backdrop-filter`** | 逐帧重采样是详情页滚动卡顿主因；故有 `.card-solid` 这个无 blur 变体 | `globals.css:655` |
| **禁止嵌套多层 `backdrop-filter`** | 代价叠加且视觉发灰 | `design-system.md` §3.5 |
| **全屏背景禁用 `blur()`** | 旧沉浸背景用 `blur-[64px]` 每帧全屏重算；改用无滤镜静态图层 | `App.tsx` 详情页沉浸背景（`backdropReady` 分支） |
| **折叠/缩放动画期间关模糊** | 模糊区域尺寸每帧变化，软件渲染下严重掉帧 | `.resizing` / `.glass-perf-lite` |
| **`@import` 必须在 `@tailwind` 之前** | 否则被静默丢弃，token 全失效 | §1.1 |

**判断口径**：`filter` 与 `backdrop-filter` 代价差一个量级——**背景氛围不用滤镜，玻璃用 `backdrop-filter`**，不要互串。

---

## 10. 代码层待办与已知缺陷

> 本轮清理已修复：`.glass-flat` 死开关、`prefers-reduced-motion` 选择器错、`.resizing` 过时注释、
> `.glass-perf-lite` 时长口径不一、四个零引用玻璃类及其 SVG 滤镜链（明细见 §11）。
> 下面只剩仍然存在的事项。

| # | 问题 | 事实与证据 | 建议 |
| --- | --- | --- | --- |
| 1 | `design-system.md` §8.1 与本文 §8 口径不同 | `ds-tokens.css` **不存在** `--ds-font-size-*`；§8.1 表只列上游 px 层级，实际生效的是 `.text-*` | 已在两文档分别标注口径，**无需改代码** |
| 2 | `App.tsx` 行号易漂移 | 该文件正被「标题栏浮层化」改造（`hasDesktopTitleBar` / `pt-11`），本文对它的引用一律用**符号引用**、不写行号 | 改 `App.tsx` 时以符号名为准 |

---

## 11. 文档同步记录

| 项目 | 状态 |
| --- | --- |
| 建立本文（实现层规格） | ✅ |
| `design-system.md` §2.5「色场实现方式」 | ✅ 已同步：旧文写 `filter: blur(80~110px)`，实际已是纯 `radial-gradient` + 禁止 `filter` |
| `design-system.md` §3.5 玻璃类计数 | ✅ 已同步：`8/8` → `9/9` → **`5/5`**（两轮清理后收敛为 5 类） |
| `design-system.md` §3.5 色斑降级理由 | ✅ 已同步：不再声称「只藏带 `filter` 的色斑」 |
| `design-system.md` §2.4 `--ds-blur-glass` 表述 | ✅ 已同步：改为「上游基准值，实际三档」 |
| `design-system.md` §8.1 排版表口径 | ✅ 已同步：加注「实际生效值见本文 §8」 |
| **代码修复**：删除 `.glass-flat` 死开关 | ✅ 删除 CSS 规则块、`libraryStore` 的 `glassMode` 字段/setter/持久化项、`GlassMode` 类型、`App.tsx` 兼容 effect；持久化 `version 6 → 7` 并清理旧值 |
| **代码修复**：`prefers-reduced-motion` | ✅ 选择器改为 `.ambient-blob__drift`，降级真正生效 |
| **代码修复**：`.resizing` 过时注释 | ✅ 改写为「隐藏 + 停动画」，不再声称是关掉昂贵的滤镜 |
| **代码修复**：`.glass-perf-lite` 时长口径 | ✅ 统一为「动画 300ms、降级窗口 400ms」 |
| **代码清理**：四个零引用玻璃类 | ✅ 删除 `glass-strong` / `glass-subtle` / `glass-popover` / `glass-search-box` 及其独有变量（`--glass-strong-*`、`--glass-subtle-*`、`--glass-popover-*`、`--glass-bg*`、`--glass-border*`、`--glass-shadow*`、`--glass-edge-highlight*`、`--saved-panel-glass-svg-filter`） |
| **代码清理**：SVG 滤镜链 | ✅ `glassFilter.ts` 与 `GlassSvgFilter.tsx` 收敛为单组 control 滤镜：删除 SEARCH/PILL 常量与配置、`applyGlassMap`、`updateGlassMap`、无消费者的 re-export |
| **歌词排版重做** | ✅ 新增 `.lyric-line`（`text-wrap: balance` 均衡折行断点）；行距 `1.6 → 1.5`、段间距窄栏 `20 → 28px` / 宽栏 `28 → 36px`（段间距必须大于行内行距，否则折行后语义分组消失）；非当前行改三级透明度 `/70 /50 /35`；窄栏字号 `14 → 13px`；`.lyric-active` `17px/scale(1.05)/36px 光晕 → 16px/scale(1.02)/28px`；渐隐带由 `12%/88%` 百分比改为按行高固定像素（窄栏 40 / 宽栏 52）；`App.tsx` 右栏去掉与 `LyricsView` 重复的 `px-4`（净宽 224 → 256px） |
| **歌词高亮去糊** | ✅ `.lyric-active` 的 `text-shadow` → `filter: drop-shadow`（`-webkit-text-fill-color:transparent` 之后 `text-shadow` 会从透明笔画内部透出，实测放大后笔画边缘全糊）；去掉 `transform: scale()`（非整数缩放重新采样字形，同样发虚）；行过渡由 `transition-all duration-500` 改为 `transition-[color,filter] duration-300`——`all` 会把 `font-size` 纳入过渡，切行时字号在 13 ↔ 16px 之间插值数百毫秒，全程非整数 px 渲染（实测 14.5px 字形边缘发毛）且逐帧重排；浅色覆盖同步改 `drop-shadow`；新增 `.resizing` / `.glass-perf-lite` 下的 `filter: none` 降级 |
| **验证** | ✅ `pnpm --filter @aurora/app build`（`tsc` + `vite build`）通过，exit 0；全仓 grep 无残留引用 |

---

## 12. 新增样式落点检查清单

写样式前逐条过：

- [ ] **改颜色/玻璃/色场变量时**，`:root`（`globals.css:54`）与 `html:not(.dark)`（`globals.css:269`）**两处都改了吗**（§2.2）？
- [ ] **新增玻璃类**，加进 §6.3 的**降级清单**了吗（当前 5 个，只有一处列表）？降级规则带 `!important` 了吗？
- [ ] **新加的材质带 `backdrop-filter` 吗**？它在小面积、不随滚动移动的元素上吗（§9）？
- [ ] **动效挂在哪个元素上**？有没有和 `filter` / `color-mix` 同元素（§9）？
- [ ] **写了 `prefers-reduced-motion` 降级吗**？规则是否命中了**真正承载动画的那个元素**（色场动画挂在 `.ambient-blob__drift` 上，见 §4.5）？
- [ ] **色场相关改动**：是否保持了「无 `filter`」「分层独立成元素」「`::before` 静态底不可隐藏」三条（§4.5、§6.2）？
- [ ] **是否硬编码了色值/圆角**？应走 `--fc-*` / `--ds-*` token 与 `rounded-ds-*` 工具类（注意 §2.4：工具类是固定 px，不读 `--ds-radius-*`）。
- [ ] **用了哪套类名**？项目词汇是 `.btn-*` / `.card-*` / `.glass-*` / `.surface-*`，**不要新造 `.ds-btn-*`**。
- [ ] **改了本文涉及的数值**？回来同步本文与 `design-system.md` 对应处（§11）。
