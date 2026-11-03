import type { AudioFocusProvider } from '../types'
import { createLinuxProvider } from './linux'
import { createWin32Provider } from './win32'
import { createDarwinProvider } from './darwin'

/**
 * 平台选择器：把「当前这台机器有没有可用的抢占通道」收敛到一个地方。
 *
 * 上层（service.ts）只认 `AudioFocusProvider`，因此这里的关键约束是：
 * 1. **构造 provider 绝对不能有副作用**。service.ts 在 `initAudioFocus()` 里就 new 出 provider，
 *    而那时用户可能根本没打开开关；如果构造即连 D-Bus / 起 PowerShell，
 *    等于给一个没开的功能白付常驻成本（Windows 上是一条常驻 powershell.exe）。所以
 *    真正的连接/子进程一律推迟到第一次 `list()`。
 * 2. **选不出来时返回 `none`，而不是抛错或返回 null**：service 用
 *    `provider.kind !== 'none'` 判断能力（见 service.ts 的 `supported`），
 *    返回 null 会让主进程在启动时就炸，返回一个「什么都不做」的实现才是可验收的降级。
 */

/** 没有平台通道时的 kind；service 依赖这个字面量判断「此端只能隐藏开关」 */
export const NO_PROVIDER_KIND = 'none'

/**
 * 空 provider：功能不可用时的占位实现。
 *
 * 刻意做成严格符合契约（list 返回空数组、pause/play/dispose 静默成功），
 * 这样 service 的轮询与归还逻辑不用为「不支持」写分支——不支持时每一拍都得到
 * 「外面没人出声」的结论，不会误判成抢占或让位。
 */
function createNoopProvider(): AudioFocusProvider {
  return {
    kind: NO_PROVIDER_KIND,
    // 取一个偏大的值：轮询是空转，间隔大一点少唤醒主进程（service 会夹到 >=300ms）
    pollingIntervalMs: 5000,
    async list() {
      return []
    },
    async pause() {
      /* 无通道可控制，静默成功（契约要求不得抛错） */
    },
    async play() {
      /* 同上 */
    },
    async dispose() {
      /* 无资源可释放；幂等 */
    },
  }
}

/**
 * 按平台构造 provider（导出给单测用：不必真的改 `process.platform` 就能覆盖全部分支）。
 *
 * 注意这里只判断 `process.platform`，不探测「pwsh 是否安装」「MPRIS 是否可用」——
 * 那些属于 provider 自己的降级逻辑（list 返回空），放到这里会让「支持与否」变成
 * 一个启动瞬间的快照，之后装了播放器也永远不生效。
 */
export function createProviderForPlatform(platform: NodeJS.Platform): AudioFocusProvider {
  switch (platform) {
    case 'linux':
      return createLinuxProvider()
    case 'win32':
      return createWin32Provider()
    case 'darwin':
      return createDarwinProvider()
    default:
      // freebsd / openbsd / sunos / aix / android …：没有实现，隐藏开关
      return createNoopProvider()
  }
}

/** 当前进程所在平台的 provider（service.ts 的唯一入口） */
export function createAudioFocusProvider(): AudioFocusProvider {
  return createProviderForPlatform(process.platform)
}
