/**
 * 主进程日志的环境信息采集。
 *
 * 单独成文件而不是塞进 ipc/logging.ts：环境信息既给「导出包的环境头」用，
 * 也给「启动时那一条 session start」用，两个消费点共享同一份采集逻辑，
 * 避免导出包里写的版本号和启动日志里写的对不上（那会让排障结论直接跑偏）。
 *
 * 依赖 Electron 运行时（app.getVersion / app.getPath），所以不进 shared ——
 * 渲染进程与移动端各自采集，只把排版放在 shared。
 */

import { app } from 'electron'
import type { LogEnvironment } from '@aurora/shared'
import { detectSystemInfo } from '../ipc/system'
import { getMainLocale } from '../i18n'

/**
 * 运行时版本串。
 *
 * 三个版本号一次给全：Electron 与 Chromium 决定「是不是浏览器层的 bug」，
 * Node 版本决定「原生模块与 fs 行为」，只写其中一个往往还得再问一轮。
 */
export function runtimeVersions(): string {
  const { electron, chrome, node } = process.versions
  return `Electron ${electron ?? '-'} / Chromium ${chrome ?? '-'} / Node ${node ?? '-'}`
}

/**
 * 采集导出包/启动日志需要的环境信息。
 *
 * `exportedAt` 由调用方传入而不是在函数里取 Date.now()：导出包里的「导出时间」
 * 必须与文件名里的时间戳、以及包内其它时间字段保持同一时刻，
 * 各自取一次时间会在跨秒时出现「文件名 02:15:00、正文 02:15:01」的错位。
 */
export function collectMainEnvironment(exportedAt: number): LogEnvironment {
  // detectSystemInfo 内部缓存并且会打一条 System 日志：首次采集顺带把发行版/安装形态写进日志，
  // 之后的调用是纯缓存读取，不会重复刷屏
  const info = detectSystemInfo()
  let userDataPath: string | undefined
  try {
    userDataPath = app.getPath('userData')
  } catch {
    // ready 之前或路径不可读：环境头里留 '-' 即可，不影响导出
    userDataPath = undefined
  }
  return {
    appVersion: app.getVersion(),
    origin: 'main',
    platform: process.platform,
    arch: process.arch,
    runtime: runtimeVersions(),
    installKind: info.installKind,
    // 发行版只对 Linux 有意义；其它平台留空由排版层写成 '-'，避免出现 "Distro: win32" 这种误导
    distro: info.distroName ?? undefined,
    // 语言取主进程当前状态（渲染层同步过来后就是权威值），而不是再探一次系统语言：
    // 用户手动选了英文、界面是英文，日志里写 zh-CN 会让人误判
    locale: getMainLocale(),
    userDataPath,
    exportedAt,
  }
}
