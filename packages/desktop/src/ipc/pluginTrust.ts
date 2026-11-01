/**
 * 签名信任表的落盘（主进程）。
 *
 * 存储位置：`<userData>/aurora-music/plugin-trust.json`
 *
 * 为什么与插件目录**分开**：信任表描述的是"我信任谁的签名"，而插件目录是
 * "我装了哪些插件"。放在一起会让"删掉某个插件"误伤信任根（用户删一个插件，
 * 结果发现他装的其他同作者插件全变成"签名者未知"）。
 *
 * ## 数据保护
 *
 * 信任表不是秘密（公钥本来就是公开的），所以**不加密**：
 * - 加密会让"备份/迁移信任表"变得困难（用户想把自己的信任根带到另一台机器）
 * - 它也不含口令或 token，泄密的后果是"别人知道你在信任谁"，不构成攻击面
 *
 * 但它**是安全关键**：写入必须原子（临时文件 + rename），
 * 且读取时逐条容错（坏条目跳过，不让一条坏数据让整张表失效）。
 */

import { app, ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import {
  mergeTrustedKeys,
  parseTrustedKeys,
  removeTrustedKey,
  serializeTrustedKeys,
  validateTrustedKey,
  type TrustedKey,
} from '@aurora/shared'

/** 信任表文件（惰性解析：app 未 ready 时不能取 userData） */
function trustFilePath(): string {
  return path.join(app.getPath('userData'), 'aurora-music', 'plugin-trust.json')
}

/**
 * 读用户表。
 *
 * 文件不存在 = 用户没导入过任何 key（正常情况，返回空数组）。
 * 文件损坏 = 返回空数组并记日志：**不能让损坏的信任表阻止插件功能**，
 * 否则用户会看到"所有插件都加载失败"而不知道是信任表文件坏了。
 */
export function readUserTrustedKeys(): TrustedKey[] {
  try {
    const text = fs.readFileSync(trustFilePath(), 'utf8')
    return parseTrustedKeys(JSON.parse(text))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code !== 'ENOENT') {
      console.warn('[plugin-trust] 读取信任表失败，按空表处理:', err)
    }
    return []
  }
}

/**
 * 写用户表（原子）。
 *
 * 先写 `.tmp` 再 rename：进程中途崩掉不会留下半截 JSON。
 * 半截 JSON 的后果是下次读取失败 → 信任表变空 → 所有已验签插件都变"签名者未知"
 * （用户会以为自己导入的 key 丢了）。
 */
export function writeUserTrustedKeys(keys: readonly TrustedKey[]): void {
  const file = trustFilePath()
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, serializeTrustedKeys(keys), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/**
 * 取**生效的**信任表（内置 ∪ 用户）。
 *
 * 这是安装时验签应当用的那一份：`mergeTrustedKeys` 保证内置条目不会被用户表挤掉，
 * 同 keyId 时以用户表为准（用户显式导入的意图更强）。
 */
export function effectiveTrustedKeys(): TrustedKey[] {
  return mergeTrustedKeys(undefined, readUserTrustedKeys())
}

/** 信任表快照（供 UI 展示：分了「内置 / 我导入的」两类，用户才知道哪些能删） */
export interface TrustTableSnapshot {
  builtin: TrustedKey[]
  user: TrustedKey[]
  /** 生效表条数（内置 ∪ 用户） */
  effective: number
}

export function trustTableSnapshot(): TrustTableSnapshot {
  const user = readUserTrustedKeys()
  const effective = mergeTrustedKeys(undefined, user)
  return {
    // 内置表当前为空（见 shared 的 TRUSTED_PLUGIN_KEYS 注释）；
    // 保留这个分类是为了将来真的内置官方公钥时 UI 不用改
    builtin: effective.filter((key) => !user.some((item) => item.keyId === key.keyId)),
    user,
    effective: effective.length,
  }
}

// ─── IPC ──────────────────────────────────────────────────────

/**
 * 注册信任表通道。
 *
 * 与安装通道分开注册：信任表的读写**不依赖**插件是否已装，
 * 且它本身就是"安装前先配置信任根"的场景（用户可以先导入公钥再装插件）。
 */
export function registerPluginTrustIpc(): void {
  /** 列出信任表（内置 / 我导入的 分两类，用户才知道哪些能删） */
  ipcMain.handle('plugin:trust:list', () => trustTableSnapshot())

  /**
   * 导入一条公钥。
   *
   * 入参来自渲染层，按不可信处理：keyId 与公钥都在 `validateTrustedKey` 里校验，
   * 形状不对时返回可归因的码而不是抛错（UI 要能把"公钥格式不对"说清楚）。
   */
  ipcMain.handle(
    'plugin:trust:add',
    (_event, input: { keyId?: unknown; publicKey?: unknown; note?: unknown }) => {
      const user = readUserTrustedKeys()
      const validation = validateTrustedKey(input || {}, user)
      if (!validation.ok) return { ok: false, code: validation.code }
      const next = [...user, validation.key]
      writeUserTrustedKeys(next)
      return { ok: true, key: validation.key, keys: next }
    }
  )

  /** 删除一条**用户导入的**公钥（内置的不可删，见 removeTrustedKey 注释） */
  ipcMain.handle('plugin:trust:remove', (_event, keyId: unknown) => {
    const user = readUserTrustedKeys()
    const result = removeTrustedKey(user, String(keyId ?? ''))
    if (!result.removed) return { ok: false, code: 'not-found-or-builtin' }
    writeUserTrustedKeys(result.keys)
    return { ok: true, keys: result.keys }
  })
}
