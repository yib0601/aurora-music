/**
 * 存储协议依赖注入（SFTP / SMB）。
 *
 * ## 为什么单独一个文件、且在启动时注入
 *
 * SFTP 与 SMB 的协议实现住在 `@aurora/shared`（存储插件契约是双端共用的），
 * 但它们的**依赖只有桌面端装**：两个协议都需要原始 TCP，而渲染层是
 * `nodeIntegration: false`，只有主进程能用 `node:net`。
 *
 * 所以 shared 侧把它们写成**注入式**（`setSsh2Module` / `setSmb2Module`），
 * 由这里在启动时把真实模块传进去。好处：
 * - `shared` 的 `dependencies` 保持干净（现在只有 lz-string），
 *   打包时不会把 ssh2 / smb2 拖进渲染层
 * - 移动端不注入，SFTP/SMB 插件仍出现在列表里但 `probe` 返回「本机不支持」
 *   —— 这比"插件凭空消失"更可解释
 *
 * ## 为什么懒加载（require 而不是 import）
 *
 * 两个包都是**可选能力**：绝大多数用户不用（NAS 多数支持 WebDAV）。
 * 用 `require` 把它们挡在模块求值路径之外：只有执行到这里才加载。
 * 若某个包装坏了（原生模块编译失败、平台不支持），也只影响对应协议，
 * 不会把整个应用在启动时打挂 —— 与 `storage/index.ts` 的 `isolatePluginStep`
 * 是同一个思路。
 *
 * ## 一处必须如实记录的代价
 *
 * `ssh2` 的**原生 crypto 绑定**是可选的：编译失败时会回退到纯 JS 实现。
 * 两种实现功能等价，纯 JS 版略慢（握手慢几十毫秒）。这在 NAS 场景可忽略，
 * 但如果用户在日志里看到 "Failed to build optional crypto binding"，
 * 那是**预期内的降级**，不是故障。
 */

import { setSmb2Module, setSsh2Module } from '@aurora/shared'

/** 注入结果（供诊断：哪个协议没能加载） */
export interface StorageProtocolStatus {
  sftp: boolean
  smb: boolean
  /** 加载失败的原因（协议名 → 原因），成功的不出现 */
  errors: Record<string, string>
}

/**
 * 注入两个协议的依赖。
 *
 * 每个协议独立 try/catch：一个装不上不该影响另一个（SFTP 与 SMB 是完全独立的路径）。
 */
export function installStorageProtocolDeps(): StorageProtocolStatus {
  const status: StorageProtocolStatus = { sftp: false, smb: false, errors: {} }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ssh2 = require('ssh2') as { Client: unknown }
    if (typeof ssh2?.Client === 'function') {
      setSsh2Module(ssh2 as never)
      status.sftp = true
    } else {
      status.errors.sftp = 'ssh2 has no Client export'
    }
  } catch (err) {
    status.errors.sftp = err instanceof Error ? err.message : String(err)
  }

  try {
    // `@marsaud/smb2` 是 CommonJS 默认导出（构造函数）
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const smb2 = require('@marsaud/smb2') as unknown
    const ctor = typeof smb2 === 'function' ? smb2 : (smb2 as { default?: unknown })?.default
    if (typeof ctor === 'function') {
      setSmb2Module(ctor as never)
      status.smb = true
    } else {
      status.errors.smb = 'smb2 module did not export a constructor'
    }
  } catch (err) {
    status.errors.smb = err instanceof Error ? err.message : String(err)
  }

  // 只记一行：这两个协议是可选能力，用户不需要在正常日志里看到它们
  if (status.sftp || status.smb) {
    const loaded = [status.sftp ? 'sftp' : null, status.smb ? 'smb' : null].filter(Boolean)
    console.log(`[storage] 协议依赖已就绪: ${loaded.join(', ')}`)
  }
  for (const [protocol, reason] of Object.entries(status.errors)) {
    console.warn(`[storage] ${protocol} 依赖不可用（该协议在设置页会显示为不支持）:`, reason)
  }

  return status
}
