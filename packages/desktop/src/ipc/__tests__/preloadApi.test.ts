/**
 * preload 暴露面与渲染层调用面的**一致性门禁**。
 *
 * 为什么必须有这条测试：渲染层是从 `(window as any).electronAPI` 取的类型 `any`
 * （见 `packages/app/src/services/platform/index.ts` 的 createElectronPlatform），
 * preload 里少一个方法，编译器不会说话、运行期也不报错 —— 渲染层那句
 * `if (!api?.xxx) return` 就地静默降级。真实后果分两种，都很隐蔽：
 *   1. 订阅类缺失（`onEncryptedFile`）：主进程照推 `scan:encrypted`，渲染层永远收
 *      不到，UI 提示与弹窗永不出现，功能等于不存在；
 *   2. 调用类缺失（`importAudioFile`）：恒返回 null，于是每次下载都误报
 *      「已下载，但没进曲库」。
 * 两者都不进日志、不进错误上报，只能靠这条门禁拦住。
 *
 * 写法参照 `src/audioFocus/__tests__/preloadChannels.test.ts`：沙箱 preload 不能
 * require 相对路径模块，通道名只能在 preload.ts 里写死字面量，所以这里读源码做比对。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/** preload.ts（本文件位于 src/ipc/__tests__/） */
const PRELOAD_PATH = path.resolve(__dirname, '../../preload.ts')
/** 渲染层桌面端平台实现：唯一通过 window.electronAPI 调用 preload 的地方 */
const APP_PLATFORM_PATH = path.resolve(__dirname, '../../../../app/src/services/platform/index.ts')
/** 主进程 IPC 注册处 */
const HANDLERS_PATH = path.resolve(__dirname, '../handlers.ts')

const read = (file: string) => fs.readFileSync(file, 'utf8')

/**
 * 渲染层实际调用的 preload 方法名。
 *
 * 两种写法都收：可选链 `api?.foo`（能力探测，缺失即降级）与直接调用 `api.foo`。
 * 只匹配 `api` 这个标识符本身，`electronAPI` 之类不会误入（后面紧跟的不是 `.`）。
 */
function usedApiNames(source: string): string[] {
  const names = new Set<string>()
  for (const match of source.matchAll(/\bapi(\?)?\.([A-Za-z_$][\w$]*)/g)) names.add(match[2])
  return [...names].sort()
}

/**
 * preload 里 electronAPI 对象的**顶层**方法名。
 *
 * 按缩进取：对象成员是两空格缩进，嵌套对象（如 logging）的内层是四空格，
 * 因此「恰好两空格的键」就是暴露面。`electronAPI` 之外的顶层 const 不匹配
 * （它们不在两空格缩进内）。
 */
function exposedApiNames(source: string): string[] {
  const names = new Set<string>()
  for (const match of source.matchAll(/\n {2}([A-Za-z_$][\w$]*)\s*:/g)) names.add(match[1])
  return [...names].sort()
}

describe('preload 暴露面', () => {
  it('渲染层调用的每个 electronAPI 方法，preload 都必须提供', () => {
    const used = usedApiNames(read(APP_PLATFORM_PATH))
    const exposed = new Set(exposedApiNames(read(PRELOAD_PATH)))
    // 先自检解析本身没瞎：渲染层确实调了一批方法，不是空集
    expect(used.length).toBeGreaterThan(20)
    expect(used.filter((name) => !exposed.has(name))).toEqual([])
  })

  it('加密音频上报走 on，方向是主进程 → 渲染层', () => {
    const source = read(PRELOAD_PATH)
    expect(source).toContain("ipcRenderer.on('scan:encrypted'")
    expect(source).toContain('onEncryptedFile')
  })

  it('入库走 invoke（要回执），且主进程确实注册了同名通道', () => {
    const preload = read(PRELOAD_PATH)
    const handlers = read(HANDLERS_PATH)
    expect(preload).toContain("ipcRenderer.invoke('library:importFile'")
    expect(handlers).toContain("ipcMain.handle('library:importFile'")
    // 上报端：主进程推的通道名必须与 preload 监听的一致
    expect(handlers).toContain("sendToRenderer('scan:encrypted'")
  })
})
