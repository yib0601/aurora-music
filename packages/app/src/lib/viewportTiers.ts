/**
 * 视口「空间档位」的**唯一事实源**（维度：可用高度 / 宽高比）。
 *
 * 背景（多比例实测，见 .tmp-aspect 的 9 档视口截图矩阵）：
 *   项目此前的适配判据**全是宽度维度**（Tailwind 的 sm/md/lg/xl/2xl、容器查询、
 *   useContainerWidth），对「屏幕比例」这一维度只有一个宽高双判据（lib/shellMode
 *   的宽 ≥1024 或宽高都 ≥520），且仅用于外壳结构分档。结果是同一份宽档 UI 落在
 *   矮屏上被纵向压爆：
 *     - 详情页 1280×600：唱片区 `lg:w-[320px]` + `lg:flex-col` 照样生效，Hero 高度
 *       超出视口，标题与操作按钮被底部播放条永久遮挡（实测截图）；
 *     - 手机横屏 915×412：完整档播放条高约 130px 占掉 31% 屏高，内容区只剩一条；
 *     - 桌面 1280×600 与车机 1280×720：宽档尺寸、宽档内边距一分不减。
 *
 * 为什么判据用**媒体查询（视口）而不是容器实测**：
 *   外壳是 `h-screen overflow-hidden` 的固定布局（App.tsx 根容器），可用高度恒等于
 *   视口高度减去外壳自带的固定带（--titleband-h）；高度这一维度上「容器 = 视口」，
 *   与宽度维度不同（宽度被侧栏 / 右侧瓷砖 / max-w 三重约束，必须实测，见
 *   useContainerWidth 的注释）。所以这里用视口媒体查询是恰当且无闪烁的。
 *
 * 档位取值依据（两个阈值都必须能整除真实设备，不许拍脑袋）：
 *   - 矮档 780：宽档详情页的刚性高度 ≈ 唱片 320（`lg:w-[320px]`）+ 标题块 ~120
 *     + 上下内边距 96 + 浮层带 68 ≈ 604；再让歌词区至少留 ~176 可见，合计 780。
 *     1280×800（Electron 默认窗口）高于它 → 宽档尺寸原样保留，默认窗口观感不变；
 *     1280×720（车机 720p）、1280×600（窗口最小高度）、915×412（手机横屏）落入档内。
 *   - 极矮档 560：手机横屏的短边实测区间 360–448，加安全区后仍 < 560；
 *     桌面窗口最小高度 600 高于它 → 桌面最小窗口只降密度，不降控件档位。
 *   - 超宽档 2/1：21:9(2.37)、32:9(3.56) 命中；16:9(1.78)、16:10(1.6)、3:2 不命中。
 *     用途只有一个——把内容列上限按比例放宽，收掉两侧的空旷留白。
 *
 * tailwind.config.ts 的 `short` / `squat` / `ultrawide` 三个 screen 直接 import 本文件的
 * 数值生成，避免出现「改了常量、class 没跟着变」的静默漂移。同名查询串另供
 * useViewportMatch 在 JS 侧使用（如播放条按视口高切紧凑档）。
 */

/** 矮档上限（px）：可用高度低于此值时，宽档尺寸一律收敛一档 */
export const SHORT_VIEWPORT_MAX_HEIGHT = 780

/** 极矮档上限（px）：手机横屏 / 车机窄高窗口，纵向空间按「省着用」处理 */
export const SQUAT_VIEWPORT_MAX_HEIGHT = 560

/** 超宽档宽高比下限（媒体查询比值写法）：≥ 此比例视为超宽屏 */
export const ULTRAWIDE_MIN_RATIO = '2/1'

/** 矮档查询串（Tailwind `short:` 的同源判据） */
export const SHORT_VIEWPORT_QUERY = `(max-height: ${SHORT_VIEWPORT_MAX_HEIGHT}px)`

/** 极矮档查询串（Tailwind `squat:` 的同源判据） */
export const SQUAT_VIEWPORT_QUERY = `(max-height: ${SQUAT_VIEWPORT_MAX_HEIGHT}px)`

/** 超宽档查询串（Tailwind `ultrawide:` 的同源判据） */
export const ULTRAWIDE_VIEWPORT_QUERY = `(min-aspect-ratio: ${ULTRAWIDE_MIN_RATIO})`

/**
 * 纯函数判据：与上面三条查询串逐字对应，供单测与需要在 JS 里算档位的场景使用
 * （媒体查询本身不便于单测，边界一律在这里锁死）。
 */
export function isShortViewport(width: number, height: number): boolean {
  return height < SHORT_VIEWPORT_MAX_HEIGHT
}

export function isSquatViewport(width: number, height: number): boolean {
  return height < SQUAT_VIEWPORT_MAX_HEIGHT
}

export function isUltrawideViewport(width: number, height: number): boolean {
  if (height <= 0) return false
  return width / height >= 2
}
