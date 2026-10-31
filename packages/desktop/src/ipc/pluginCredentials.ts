/**
 * 插件凭证的安全存储（主进程）。
 *
 * 为什么必须有这一层：插件的登录凭证（如汽水的 `sessionid`）等价于账号口令。
 * 渲染层的持久化走 zustand persist → localStorage，是**明文**文件；而现有 WebDAV 口令
 * 正是这么存的（`shared/src/webdav.ts` 自述「后续应迁移到主进程 safeStorage」）。
 * 插件化不复制这个缺陷：凭证只在主进程经 `safeStorage` 加密后落盘，
 * 渲染层只拿到「是否已登录」这类不含秘密的状态。
 *
 * 三条边界：
 * 1. **凭证不出主进程**：读接口只回 `AuthState`（是否登录、账号展示名），不回 token 原文。
 * 2. **落盘是密文**：`safeStorage.encryptString` 产出的二进制直接写文件；
 *    系统不支持加密时（少数无 keyring 的 Linux 桌面）明确降级并在状态里标出来，
 *    而不是静默写明文。
 * 3. **文件权限 0600**：即便加密不可用，也不给同机其它用户可读的机会。
 *
 * 存储布局：`<userData>/aurora-music/plugin-credentials/<pluginId>.bin`
 * 每个插件一个文件——卸载插件 = 删文件，不会牵连其它插件。
 */

import { app, safeStorage } from 'electron'
import fs from 'fs'
import path from 'path'
import { auroraError } from '@aurora/shared'

/** 凭证文件所在目录（惰性解析：主进程早期 app 尚未 ready 时不能取 userData） */
function credentialsDir(): string {
  return path.join(app.getPath('userData'), 'aurora-music', 'plugin-credentials')
}

/** 插件 id 作文件名，必须先校验：id 来自渲染层，按不可信处理 */
function safeFileName(pluginId: string): string {
  if (typeof pluginId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(pluginId)) {
    throw auroraError('desktop.error.plugin.invalidId', { id: String(pluginId ?? '') })
  }
  return `${pluginId}.bin`
}

function credentialPath(pluginId: string): string {
  return path.join(credentialsDir(), safeFileName(pluginId))
}

/** 系统是否具备加密能力（无 keyring 的 Linux 会返回 false） */
export function isCredentialEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/**
 * 写入凭证。
 *
 * @param pluginId 插件 id（决定落盘文件名）
 * @param payload  插件自定义的凭证载荷（如 `{ sessionid: '...' }`）。只要求可 JSON 序列化。
 *
 * 加密不可用时**拒绝写入**而不是写明文：用户宁可重新登录一次，
 * 也不该在不知情的情况下把账号凭证以明文留在磁盘上。
 */
export function savePluginCredential(pluginId: string, payload: unknown): void {
  if (payload == null || typeof payload !== 'object') {
    throw auroraError('desktop.error.plugin.credentialInvalid')
  }
  if (!isCredentialEncryptionAvailable()) {
    throw auroraError('desktop.error.plugin.encryptionUnavailable')
  }

  const dir = credentialsDir()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })

  const json = JSON.stringify(payload)
  const cipher = safeStorage.encryptString(json)
  const target = credentialPath(pluginId)

  // 先写临时文件再 rename：避免进程在写一半时崩掉留下半截密文，
  // 下次读取解密失败会让用户以为是「凭证损坏」而不是「上次没写完」
  const tmp = `${target}.tmp`
  fs.writeFileSync(tmp, cipher, { mode: 0o600 })
  fs.renameSync(tmp, target)

  try {
    fs.chmodSync(target, 0o600)
  } catch {
    // 某些文件系统（FAT / 部分网络盘）不支持 chmod；加密本身仍在，不因此失败
  }
}

/**
 * 读取凭证原文（**仅供主进程内部**使用，绝不经 IPC 回渲染层）。
 * 文件不存在返回 null（表示该插件未登录，是正常状态而非错误）；
 * 文件存在但解密失败返回 null 并清掉坏文件——否则每次启动都会重复失败。
 */
export function readPluginCredential(pluginId: string): Record<string, unknown> | null {
  const target = credentialPath(pluginId)
  let cipher: Buffer
  try {
    cipher = fs.readFileSync(target)
  } catch {
    return null
  }

  let json: string
  try {
    json = safeStorage.decryptString(cipher)
  } catch {
    // 系统密钥变了（换机器 / 重装系统 / keyring 被重置）时必然走到这里：
    // 这不是 bug，坏的密文留着没有任何用处，删掉让用户重新登录
    try {
      fs.unlinkSync(target)
    } catch {
      /* 删不掉也不影响下次读：仍会走这条分支 */
    }
    return null
  }

  try {
    const parsed = JSON.parse(json)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    try {
      fs.unlinkSync(target)
    } catch {
      /* 同上 */
    }
    return null
  }
}

/** 是否已保存凭证（只看文件在不在，不解密——状态查询在 UI 高频路径上） */
export function hasPluginCredential(pluginId: string): boolean {
  try {
    return fs.existsSync(credentialPath(pluginId))
  } catch {
    return false
  }
}

/** 清除凭证（退出登录 / 卸载插件）。文件本就不存在时视作成功。 */
export function clearPluginCredential(pluginId: string): void {
  try {
    fs.unlinkSync(credentialPath(pluginId))
  } catch {
    // ENOENT 是预期路径；其它错误（权限）也不该让「退出登录」卡住，
    // 上层拿到的是「下次仍显示已登录」，用户可再点一次
  }
}
