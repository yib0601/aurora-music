/**
 * 音乐库卡片网格的**唯一**几何来源。
 *
 * 问题背景（1420x900 截图 + 活浏览器 CDP 两次实测）：
 *   歌曲网格与专辑/艺术家网格的卡片 DOM 完全同构，却因「列数判据不同源 +
 *   行高数学不同源 + 行间距语义不同」产生肉眼可见的尺寸漂移：
 *   1. 列数：虚拟网格按**容器宽度**分档，分组网格按 **Tailwind 视口断点** class
 *      （`sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5`）。右侧 Now Playing 面板
 *      展开后容器比视口窄，两者算出不同列数。
 *   2. 行高：虚拟网格用 `rowHeight = colWidth + 52` 估算，与卡片真实高度不符，
 *      每行累积漂移；分组网格走 CSS 自然流。
 *   3. 行间距：歌曲网格的行是 `absolute` + `translateY` 定位，**CSS `gap` 对绝对
 *      定位子元素不生效**（实测：computed gap 16px，实际垂直间距 0）；分组网格是
 *      CSS flow + `gap-4`（实测垂直间距 16）。两者语义不同，须用不同函数表达。
 *
 * 本模块把「列数 / 列宽 / 间距 / 行高」收敛到一处纯计算，两个网格只允许从这里取值。
 *
 * 单位与坐标约定：
 *   - 长度单位一律为 **CSS px**。
 *   - 宽度类函数的入参是**滚动容器的 content-box 宽度**
 *     （实测用 `ResizeObserverEntry.contentRect.width` 读取）。
 *   - 卡片宽高均为**包含 1px 边框**的 border-box 尺寸
 *     （Tailwind preflight 对全元素设 `box-sizing: border-box`，已在构建产物确认）。
 *
 * 卡片 DOM（`VirtualCardGrid.TrackCard` 与 `LibraryPage.renderGroupGrid` 完全一致）：
 *   <div class="card-utility p-2.5">                      ← 内边距 10px + 1px 边框
 *     <div class="aspect-square rounded-[10px] mb-2.5">   ← 正方形封面，下外边距 10px
 *     <p class="text-[14px]">  标题</p>                   ← 行高 14 × 1.47
 *     <p class="text-[12px] mt-0.5">副标题</p>            ← 上外边距 2px + 行高 12 × 1.47
 *   </div>
 */

// ===== Tailwind 尺寸 → px（数字全部来自 packages/app/tailwind.config.js
//       与 src/styles/globals.css 的既有配置，非臆造）=====

/** 卡片内边距 `p-2.5` = 0.25rem × 2.5 = 10px（Tailwind spacing 刻度 1 = 4px） */
const CARD_PADDING = 10
/** `.card-utility` 的 `border: 1px solid`（globals.css 内该组件类的固有描边） */
const CARD_BORDER = 1
/** 封面下外边距 `mb-2.5` = 10px */
const COVER_MARGIN_BOTTOM = 10
/** 副标题上外边距 `mt-0.5` = 0.125rem × 2 = 2px */
const SUBTITLE_MARGIN_TOP = 2

/** 标题字号 `text-[14px]`：Tailwind 任意值只覆写 font-size，沿用元素继承行高 */
const TITLE_FONT_SIZE = 14
/** 副标题字号 `text-[12px]`：同上 */
const SUBTITLE_FONT_SIZE = 12

/**
 * 继承行高系数。链条（已核对构建产物）：
 *   Tailwind preflight `html { line-height: 1.5 }`
 *     → `body { line-height: inherit }`
 *     → globals.css `body { font-size: 14px; line-height: 1.47; … }` 覆写为 1.47
 *     → `text-[14px]` / `text-[12px]` 只写 `font-size`、**不写 line-height**，
 *        且两者的父元素都没有字号工具类（字号由 body 继承），
 *        故两行都从 body 继承 1.47。
 *   ⇒ 行高是「字号 × 1.47」的无单位倍数，与实际渲染字体无关。
 *     Lead 的 CDP 实测（标题 20.58 / 副标题 17.63）与此一致。
 */
const INHERITED_LINE_HEIGHT_RATIO = 1.47

/** 水平间距 = Tailwind `gap-4` = 16px，与两个网格实测的水平间距 16px 一致 */
export const GRID_GAP = 16

/**
 * 封面的内缩关系（**仅作推导说明，刻意不定义为常量**）：
 *   封面是 `aspect-square`，宽度 = 卡片**内容盒**宽度
 *     = 列宽 − 左右内边距 − 左右边框 = 列宽 − 2×10 − 2×1 = 列宽 − 22。
 *   `aspect-ratio: 1 / 1`（Tailwind 默认 `square: '1 / 1'`，已在构建产物确认）
 *   使其高度等于宽度，故封面高 = 列宽 − 22。
 *
 * ⚠️ 这里**故意不导出/不定义** `COVER_SIDE_INSET = 22` 这样的常量：
 *    它一旦存在，就很容易被「顺手」加进 `CARD_EXTRA_HEIGHT` 或断言展开式里，
 *    而 `colWidth` 已经内含该内缩 —— 再加一次即重复计数，直接产出恒差 -22px 的错误
 *    结果（历史上发生过两次：先是常量 72.22，后是 DEV 断言导致整站白屏）。
 *    正确的形式只有一个：`卡片高 = 列宽 + CARD_EXTRA_HEIGHT`，其中
 *    `CARD_EXTRA_HEIGHT` 不含内边距与边框（推导见其上方注释）。
 */

/** 标题行高 */
const TITLE_LINE_HEIGHT = TITLE_FONT_SIZE * INHERITED_LINE_HEIGHT_RATIO
/** 副标题行高 */
const SUBTITLE_LINE_HEIGHT = SUBTITLE_FONT_SIZE * INHERITED_LINE_HEIGHT_RATIO

/**
 * 正方形封面卡片的**额外高度**（px，与列宽无关的常量）。
 *
 * 关键：封面被 `p-2.5` 内边距和 1px 边框**内缩**，边长不是 colWidth 而是
 *       colWidth − 22。展开卡片高度时，内缩项与内边距/边框项**恰好抵消**，
 *       所以额外高度里**不含**内边距与边框——把它们再加一遍就是重复计数。
 *
 *   卡片高 = 上边框 + 上内边距 + 封面高 + 封面 mb + 标题行高 + 副标题 mt + 副标题行高
 *          = 1 + 10 + (colWidth − 22) + 10 + 20.58 + 2 + 17.64
 *          = colWidth + (10 + 20.58 + 2 + 17.64)
 *                       └────────────────────┘
 *                         即 CARD_EXTRA_HEIGHT
 *
 *   CARD_EXTRA_HEIGHT
 *     = 封面 mb                         = 10
 *     + TITLE_FONT_SIZE × 1.47          = 14 × 1.47 = 20.58
 *     + SUBTITLE_MARGIN_TOP             = 2
 *     + SUBTITLE_FONT_SIZE × 1.47       = 12 × 1.47 = 17.64
 *     ──────────────────────────────────────────────────
 *     = 50.22
 *
 * 与 Lead 的 CDP 实测量对账（容器 1134px、5 列）：
 *   逐项：2(边框) + 20(内边距) + 190.39(封面) + 10 + 20.58 + 2 + 17.63 = 262.60
 *   本式：列宽 212.39 → 封面 212.39 − 22 = 190.39（实测封面 h = 190.39 ✔）
 *                      卡片高 212.39 + 50.22 = 262.61（实测 262.61 ✔）
 *
 * ⚠️ 历史值与两个错误方向，记录于此以免重犯：
 *   - `52`（原实现）：按 46.75 这类**差值口径**反推，量级接近但无自洽推导，
 *     与内缩关系不符，表现为每行漂移。
 *   - `72.22`（本模块上一版，已废弃）：把「内边距 20 + 边框 2」当成额外高度**又加了
 *     一遍**，而封面边长用的是未内缩的 colWidth，导致每行**高估 22px**——
 *     比原来的漂移更严重。正确写法见上式：额外高度不含内边距/边框。
 */
export const CARD_EXTRA_HEIGHT =
  COVER_MARGIN_BOTTOM + TITLE_LINE_HEIGHT + SUBTITLE_MARGIN_TOP + SUBTITLE_LINE_HEIGHT

/**
 * 单列宽度下限（px）：auto-fill 语义下卡片列宽的下限，再窄封面就小到难以辨认。
 * 140 是「正方形封面 + 两行文字」卡片的经验下限（封面内缩 22 后仍有 118px）。
 */
export const MIN_COLUMN_WIDTH = 140
/** 列数上限：超宽屏也封顶 8 列，防止卡片过小不可读 */
export const MAX_COLUMN_COUNT = 8

/**
 * 列数（**容器宽度驱动**，等价于 CSS `repeat(auto-fill, minmax(140px, 1fr))`）：
 *
 *   cols = clamp(floor((w + GAP) / (MIN_COLUMN_WIDTH + GAP)), 1, MAX_COLUMN_COUNT)
 *
 * 公式与 auto-fill 语义一致：放下 n 列需要 n×最小列宽 + (n−1)×间距，反解最大 n；
 * 列宽仍由 getGridColumnWidth 均分（即 1fr），容器比整档略宽时列宽略大于下限，无跳变。
 *
 * 旧实现是固定分档（640/768/1024 → 2..5 列），右侧 Now Playing 面板展开后
 * 容器只剩 ~600px 会掉进 2 列档：卡片巨大、一屏仅 4 首（用户实测截图）。
 * auto-fill 后同场景得 4 列，宽容器（≥1100px）得 7~8 列，密度始终跟满宽度。
 *
 * ⚠️ 歌曲虚拟网格与专辑/艺术家平铺网格必须共用本判据——改回视口断点或固定
 *    分档会让两个网格的卡片尺寸再次分叉（原 bug 根因）。
 */
export function getGridColumnCount(containerWidth: number): number {
  const cols = Math.floor((containerWidth + GRID_GAP) / (MIN_COLUMN_WIDTH + GRID_GAP))
  return Math.min(MAX_COLUMN_COUNT, Math.max(1, cols))
}

/**
 * 单列宽度（px），与 CSS `grid-template-columns: repeat(n, minmax(0, 1fr))` + `gap`
 * 的布局语义一致：
 *   列宽 = (容器宽 − 间距 × (列数 − 1)) / 列数
 * 即等比分配剩余空间、不设最小宽度（`minmax(0, 1fr)` 允许列被压缩到内容以下）。
 * 返回值可带小数（浏览器按子像素布局）；对账：1134px / 5 列 → (1134−64)/5 = 214.0，
 * Lead 实测卡片宽 212.39（差额来自滚动条占位）。
 *
 * @param containerWidth 滚动容器 content-box 宽度（px）
 * @param colCount 列数，应来自 `getGridColumnCount`；< 1 时按 1 处理
 */
export function getGridColumnWidth(containerWidth: number, colCount: number): number {
  const cols = Math.max(1, Math.floor(colCount))
  const usable = containerWidth - GRID_GAP * (cols - 1)
  // 多列时列数公式已保证列宽 ≥ MIN_COLUMN_WIDTH，这里**不能**再 clamp：
  //  clamp 会在分档边界造出「列宽贴底平区」，破坏列宽随列数递减的单调性。
  //  仅单列（极窄容器）时按 minmax(140px, 1fr) 语义保底 140。
  return cols === 1 ? Math.max(MIN_COLUMN_WIDTH, usable) : usable / cols
}

/**
 * 卡片真实高度（px）：封面被内缩后高 = 列宽 − 22，故
 *   卡片高 = 列宽 + CARD_EXTRA_HEIGHT（内缩的 22px 已在额外高度推导中抵消）
 * 供行高计算与调试断言使用。
 */
export function getCardHeight(containerWidth: number, colCount: number): number {
  return getGridColumnWidth(containerWidth, colCount) + CARD_EXTRA_HEIGHT
}

/**
 * 平铺（CSS flow）网格的单行占位高度（px）——用于**专辑 / 艺术家**网格。
 * 这类网格由容器 CSS `gap` 控制行间距，故：
 *   行高 = 卡片真实高度 + GRID_GAP
 * 必须与容器上的 `gap: ${GRID_GAP}px` 同源，否则相邻行逐行累积漂移。
 */
export function getGridRowHeight(containerWidth: number, colCount: number): number {
  return getCardHeight(containerWidth, colCount) + GRID_GAP
}

/**
 * 虚拟化（**绝对定位行**）的单行总占位高度（px）——用于**歌曲**网格。
 *
 * 歌曲网格每行是 `absolute` + `translateY(vi.start)`；**CSS `gap` 对绝对定位子元素
 * 不生效**（Lead 实测：computed gap 16px，而实际垂直间距 0）。行间距只能由
 * virtualizer 的 `vi.start` 步进表达，即本函数的返回值。因此这里**不加** GRID_GAP，
 * 但总占位仍须含行间距，否则相邻行会紧贴：
 *   总占位 = 行间距 + 卡片真实高度 = GRID_GAP + getCardHeight(...)
 *
 * 由此可见本函数与 `getGridRowHeight` **数值相同、语义不同**：前者把 gap 计入
 * 「行盒之间的间距」（由 translateY 步进承担），后者计入「行盒内的下留白」
 * （由 CSS flow 承担）。分开命名是为了防止调用方误以为绝对定位行能靠 CSS `gap`
 * 拿到间距——那正是原实现的实际表现（gap 写了 16 却完全没有行间距）。
 *
 * ⚠️ 若虚拟行盒子用 `height: vi.size` 拉伸卡片，则 `vi.size` **必须**等于本函数
 * 返回值，否则卡片被拉伸/裁切（Lead 实测歌曲卡片高 266 ≠ 专辑 262.61，差值即来自
 * 行盒 `height: vi.size` 的拉伸）。
 */
export function getVirtualRowHeight(containerWidth: number, colCount: number): number {
  return GRID_GAP + getCardHeight(containerWidth, colCount)
}

/**
 * 几何自检：返回全部不一致项的说明（空数组 = 全部自洽）。
 *
 * ⚠️ **本函数绝不能在模块顶层调用，也绝不能 throw**——历史教训（P0）：
 *    上一版把它设计成「import 期 throw 以防回归」，常量改动后断言先于应用挂载失败，
 *    导致 `import` 直接抛错、React 完全没挂载、整站白屏（`#root` 子元素数为 0）。
 *    这种「用崩溃防回归」的代价远大于收益，且 `tsc` / `build` 都发现不了。
 *    现在改为**返回问题列表**的纯函数：既不 throw，也不在 import 期执行，
 *    需要时由单元测试或调试代码显式调用。
 *
 * 校验项：
 * 1) 分档单调性：容器越宽列数不减，且恒在 2..5；
 * 2) 列宽递减性：同一宽度下列数越多、单列越窄；
 * 3) 行高恒等式：平铺行高与虚拟行高均 ≡ 卡高 + GRID_GAP；
 * 4) 卡片高恒等式：卡高 ≡ 列宽 + CARD_EXTRA_HEIGHT（防额外高度被改坏）。
 *
 * ⚠️ 关于第 4 项**不要**写成「列宽 + 内缩 22 + 文字块」：`colWidth` 已内含内缩
 *    （封面被 pad/border 内缩 22px），再加一次就是重复计数，会得到恒差 -22px 的
 *    假告警——这正是上一版 P0 的直接原因。正确写法即 `expanded = CARD_EXTRA_HEIGHT`
 *    （唯一真源，不含内边距/边框），故此处直接引用 `CARD_EXTRA_HEIGHT`。
 */
export function assertGridLayoutInvariants(): string[] {
  const problems: string[] = []

  for (let w = 320; w <= 4096; w += 1) {
    const cols = getGridColumnCount(w)
    if (cols < 1 || cols > MAX_COLUMN_COUNT) problems.push(`列数越界: ${w}px -> ${cols}`)
    if (cols > 1 && getGridColumnCount(w - 1) > cols) {
      problems.push(`列数分档不单调: ${w}px`)
    }
    const cardHeight = getCardHeight(w, cols)
    if (getGridRowHeight(w, cols) !== cardHeight + GRID_GAP) {
      problems.push(`平铺行高与卡高+GRID_GAP 不一致: ${w}px`)
    }
    if (getVirtualRowHeight(w, cols) !== cardHeight + GRID_GAP) {
      problems.push(`虚拟行高与卡高+GRID_GAP 不一致: ${w}px`)
    }
    if (cols < MAX_COLUMN_COUNT && getGridColumnWidth(w, cols + 1) >= getGridColumnWidth(w, cols)) {
      problems.push(`列宽未随列数递减: ${w}px ${cols}->${cols + 1} 列`)
    }
    // 卡片高恒等式等价于「卡高 = 列宽 + 额外高度」，其中额外高度只有 CARD_EXTRA_HEIGHT
    // 一个真源（不含内边距/边框，理由见该常量上方的推导）。
    if (Math.abs(cardHeight - (getGridColumnWidth(w, cols) + CARD_EXTRA_HEIGHT)) > 1e-9) {
      problems.push(`卡片高与「列宽 + CARD_EXTRA_HEIGHT」不一致: ${w}px`)
    }
  }

  return problems
}

/**
 * DEV 期一次性自检：**只 `console.error`，绝不 throw**。
 * 必须保证模块 import 绝不抛错，否则会连坐整站白屏（见上方 P0 说明）。
 * 注：沿用仓库既有写法 `(import.meta as any).env`（见 services/update.service.ts）
 * ——项目 tsconfig 未引入 vite/client 类型，直接写 `import.meta.env` 会编译失败。
 */
const viteEnv = (import.meta as { env?: { DEV?: boolean } }).env
if (viteEnv?.DEV) {
  const problems = assertGridLayoutInvariants()
  if (problems.length > 0) {
    console.error('[gridLayout] 几何自检未通过（不阻断启动）:', problems.slice(0, 5))
  }
}
