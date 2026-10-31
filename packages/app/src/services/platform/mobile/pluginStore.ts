/**
 * 已安装插件的落盘层（移动端）。
 *
 * ## 为什么不能与桌面端共用 `pluginStore.ts`
 *
 * 桌面端用 `node:fs`（同步 API、任意路径）；移动端是 Capacitor WebView，
 * 只有 `@capacitor/filesystem`（异步 API、`Directory.Data` 这类抽象目录）。
 * 两个环境没有共同的文件原语，硬抽象出一个"两者都行"的接口只会让两边都变复杂。
 *
 * **共用的是纪律，不是代码**：
 * - 目录布局一致（`plugins/<id>/{manifest.json,install.json,script.js}`）
 * - 哈希按**原始字节**算，每次启动核对
 * - 原子写（先写 staging 目录再替换）
 * - 一个坏插件不让其余插件消失
 *
 * 这些纪律在 shared 侧的类型里已经固化（`InstalledPlugin` / `InstalledPluginScan`），
 * 所以两个平台产出的扫描结果形状一致，上层装配逻辑（`mountInstalled`）完全共用。
 *
 * ## 落盘位置
 *
 * `Directory.Data` = 应用私有目录（Android 为 `/data/data/<pkg>/files/`），
 * 卸载随应用清除，**不需要任何存储权限**。这与媒体缓存的位置选择同一个理由。
 */

import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import {
  validatePluginManifest,
  type InstalledPlugin,
  type InstalledPluginScan,
  type ManifestIssue,
  type PluginInstallRecord,
  type PluginManifest,
} from '@aurora/shared'

/** 插件根目录（相对 `Directory.Data`） */
const PLUGINS_DIR = 'plugins'

/** 清单大小上限：与桌面端同一数值（声明文件，正常只有几 KB） */
const MAX_MANIFEST_BYTES = 1024 * 1024

/** 插件 id 形状校验：id 会成为路径的一段，必须挡在拼接之前 */
function safePluginId(pluginId: unknown): string {
  if (typeof pluginId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(pluginId)) {
    throw new Error(`INVALID_PLUGIN_ID:${String(pluginId ?? '')}`)
  }
  return pluginId
}

/**
 * 计算字节的 sha256。
 *
 * 移动端 WebView 有 `crypto.subtle`，但**只在安全上下文**可用 ——
 * Capacitor 的 `https://localhost` 源算安全上下文，所以这里能直接用。
 * 不用同步实现（`crypto.subtle.digest` 是异步的），调用方一律 await。
 */
export async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** 读一个文件为文本；不存在或读不出返回 null */
async function readTextFile(path: string): Promise<string | null> {
  try {
    const result = await Filesystem.readFile({ path, directory: Directory.Data, encoding: Encoding.UTF8 })
    return typeof result.data === 'string' ? result.data : null
  } catch {
    return null
  }
}

/** 确保目录存在（Capacitor 的 mkdir 在已存在时会抛，故吞掉错误） */
async function ensureDir(path: string): Promise<void> {
  try {
    await Filesystem.mkdir({ path, directory: Directory.Data, recursive: true })
  } catch {
    // 已存在：不是错误
  }
}

/**
 * 解析清单字节：UTF-8 → JSON → schema。
 *
 * 与桌面端 `parseManifestBytes` 的三步失败分类保持一致（编码 / 语法 / 结构），
 * 因为用户的补救动作不同：换编码、改 JSON 语法、改字段。
 */
export function parseManifestText(
  text: string,
  sourceLabel: string
):
  | { ok: true; manifest: PluginManifest }
  | { ok: false; message: string; issues: ManifestIssue[] } {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (err) {
    return {
      ok: false,
      message: `AURORA_PLUGIN_BAD_JSON:${sourceLabel}:${err instanceof Error ? err.message : String(err)}`,
      issues: [],
    }
  }
  const validation = validatePluginManifest(json)
  if (!validation.ok) {
    return { ok: false, message: 'AURORA_PLUGIN_INVALID_MANIFEST', issues: validation.issues }
  }
  return { ok: true, manifest: validation.manifest }
}

/**
 * 把一份插件写到磁盘（原子替换）。
 *
 * `staging` 目录看似多余（Capacitor 没有 rename），但它解决一个真实问题：
 * 写 manifest 成功、写 install.json 失败会留下一个"清单在但记录不在"的目录，
 * 下次扫描判成 broken，用户看到的是一个莫名其妙的坏插件。
 * 先全部写进 staging，全部成功后才挪到正式目录 —— 中途失败只需删 staging。
 */
export async function writeInstalledPlugin(
  manifest: PluginManifest,
  manifestText: string,
  record: PluginInstallRecord,
  scriptBody?: string | null
): Promise<void> {
  const id = safePluginId(manifest.id)
  const staging = `${PLUGINS_DIR}/${id}.tmp-${Date.now()}`
  const target = `${PLUGINS_DIR}/${id}`

  await ensureDir(staging)
  try {
    await Filesystem.writeFile({
      path: `${staging}/manifest.json`,
      data: manifestText,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
    })
    await Filesystem.writeFile({
      path: `${staging}/install.json`,
      data: JSON.stringify(record, null, 2),
      directory: Directory.Data,
      encoding: Encoding.UTF8,
    })
    if (typeof scriptBody === 'string' && scriptBody.trim()) {
      // B 档脚本正文：运行期只读本地副本，绝不回源
      await Filesystem.writeFile({
        path: `${staging}/script.js`,
        data: scriptBody,
        directory: Directory.Data,
        encoding: Encoding.UTF8,
      })
    }
    // 替换正式目录：先删旧的（不存在时 rmdir 会抛，吞掉）
    try {
      await Filesystem.rmdir({ path: target, directory: Directory.Data, recursive: true })
    } catch {
      // 不存在：正常
    }
    // Capacitor 没有 rename：逐个文件搬过去（只有两个小文件 + 可选脚本）
    await ensureDir(target)
    for (const name of ['manifest.json', 'install.json', 'script.js']) {
      const content = await readTextFile(`${staging}/${name}`)
      if (content === null) continue
      await Filesystem.writeFile({
        path: `${target}/${name}`,
        data: content,
        directory: Directory.Data,
        encoding: Encoding.UTF8,
      })
    }
  } finally {
    try {
      await Filesystem.rmdir({ path: staging, directory: Directory.Data, recursive: true })
    } catch {
      // staging 清理失败不影响结果（扫描时会跳过 `.tmp-` 目录）
    }
  }
}

/** 读安装记录；不存在或结构不对返回 null */
export async function readInstallRecord(pluginId: string): Promise<PluginInstallRecord | null> {
  const text = await readTextFile(`${PLUGINS_DIR}/${safePluginId(pluginId)}/install.json`)
  if (text === null) return null
  try {
    const json = JSON.parse(text) as Partial<PluginInstallRecord>
    if (
      typeof json?.id !== 'string' ||
      typeof json.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(json.sha256)
    ) {
      return null
    }
    return {
      id: json.id,
      version: typeof json.version === 'string' ? json.version : '',
      sha256: json.sha256,
      installedAt: typeof json.installedAt === 'number' ? json.installedAt : 0,
      origin: typeof json.origin === 'string' ? json.origin : '',
    }
  } catch {
    return null
  }
}

/**
 * 扫描插件目录。
 *
 * 与桌面端同一容错原则：**一个坏目录不能让整次扫描失败**。
 * 否则用户会遇到最不可解释的现象 —— "我装了三个插件，重启后全没���"，
 * 而真实原因只是其中一个文件写坏了。
 */
export async function scanInstalledPlugins(): Promise<InstalledPluginScan> {
  const plugins: InstalledPlugin[] = []
  const broken: InstalledPluginScan['broken'] = []

  let entries: string[] = []
  try {
    const result = await Filesystem.readdir({ path: PLUGINS_DIR, directory: Directory.Data })
    entries = result.files.map((file) => file.name)
  } catch {
    // 目录不存在 = 一个插件都没装（首次启动的正常情况）
    return { plugins, broken }
  }

  for (const name of entries) {
    // 原子写的临时目录不是插件
    if (name.includes('.tmp-')) continue

    const record = await readInstallRecord(name)
    if (!record) {
      broken.push({ path: `${PLUGINS_DIR}/${name}/install.json`, issues: [], message: 'AURORA_PLUGIN_RECORD_INVALID' })
      continue
    }

    const manifestText = await readTextFile(`${PLUGINS_DIR}/${name}/manifest.json`)
    if (manifestText === null) {
      broken.push({ path: `${PLUGINS_DIR}/${name}/manifest.json`, issues: [], message: 'AURORA_PLUGIN_MANIFEST_MISSING' })
      continue
    }
    if (manifestText.length > MAX_MANIFEST_BYTES) {
      broken.push({ path: `${PLUGINS_DIR}/${name}/manifest.json`, issues: [], message: 'AURORA_PLUGIN_MANIFEST_TOO_LARGE' })
      continue
    }

    // 哈希锁定：内容被改过就拒绝加载（与桌面端同一条纪律）
    const actual = await sha256OfBytes(new TextEncoder().encode(manifestText))
    if (actual !== record.sha256) {
      broken.push({
        path: `${PLUGINS_DIR}/${name}/manifest.json`,
        issues: [],
        message: `AURORA_PLUGIN_HASH_MISMATCH:{expected:${record.sha256},actual:${actual}}`,
      })
      continue
    }

    const parsed = parseManifestText(manifestText, `${PLUGINS_DIR}/${name}/manifest.json`)
    if (!parsed.ok) {
      broken.push({
        path: `${PLUGINS_DIR}/${name}/manifest.json`,
        issues: parsed.issues,
        message: parsed.message,
      })
      continue
    }

    // 目录名与清单 id 必须一致（id 是注册键与卸载目标，不能靠猜）
    if (parsed.manifest.id !== name) {
      broken.push({
        path: `${PLUGINS_DIR}/${name}`,
        issues: [],
        message: `AURORA_PLUGIN_DIR_MISMATCH:{dir:${name},id:${parsed.manifest.id}}`,
      })
      continue
    }

    // B 档脚本正文
    let scriptBody: string | null = null
    if (parsed.manifest.script) {
      scriptBody = await readTextFile(`${PLUGINS_DIR}/${name}/script.js`)
      // 清单声明了脚本哈希 → 校验落盘脚本（与桌面端同一条纪律）
      const expected = parsed.manifest.script.sha256
      if (scriptBody !== null && expected) {
        const scriptHash = await sha256OfBytes(new TextEncoder().encode(scriptBody))
        if (scriptHash !== expected.toLowerCase()) {
          broken.push({
            path: `${PLUGINS_DIR}/${name}/script.js`,
            issues: [],
            message: `AURORA_PLUGIN_SCRIPT_HASH_MISMATCH:{expected:${expected.toLowerCase()},actual:${scriptHash}}`,
          })
          continue
        }
      }
    }

    plugins.push({
      manifest: parsed.manifest,
      record,
      path: `${PLUGINS_DIR}/${name}/manifest.json`,
      ...(scriptBody === null ? {} : { scriptBody }),
    })
  }

  return { plugins, broken }
}

/** 卸载：删掉整个插件目录（幂等） */
export async function removeInstalledPlugin(pluginId: string): Promise<void> {
  const id = safePluginId(pluginId)
  try {
    await Filesystem.rmdir({ path: `${PLUGINS_DIR}/${id}`, directory: Directory.Data, recursive: true })
  } catch {
    // 不存在：卸载是幂等的
  }
}

/** 某插件是否在磁盘上有目录（诊断用） */
export async function hasInstalledDir(pluginId: string): Promise<boolean> {
  try {
    await Filesystem.stat({ path: `${PLUGINS_DIR}/${safePluginId(pluginId)}`, directory: Directory.Data })
    return true
  } catch {
    return false
  }
}
