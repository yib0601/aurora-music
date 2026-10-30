/**
 * 日志导出包的排版。
 *
 * 交付形态是**一个纯文本文件**（不是 zip）：用户要能直接拖进聊天窗口或邮件正文，
 * 不用先装解压工具；开发者拿到后 `less` 就能读，也不依赖任何导入工具。
 *
 * 因此导出流程是「读全部日志文件 → 拼成一个带环境头的文本」，
 * 环境头是排障的一半：同一个 bug 在不同版本/发行版/后端上表现完全不同，
 * 少了这几行就得来回追问，一轮对话的成本远高于把它写进文件。
 *
 * **排版层一律用英文**：这份文件的读者是开发者（也就是维护本仓库的人），
 * 而界面文案必须走 i18n 字典（门禁 check-i18n 会把中文字面量判红）。
 * 日志正文本身是中文，那是 `console.warn('…')` 的既有输出，不受此约束。
 */

import { formatTimestamp } from './format'

/** 导出包里的环境信息（各端自己收集，这里只负责排版） */
export interface LogEnvironment {
  /** 应用版本，如 0.7.3 */
  appVersion: string
  /** 进程/平台：main / renderer / mobile */
  origin: string
  /** 运行平台：linux / win32 / darwin / android */
  platform: string
  arch?: string
  /** Electron / Chromium / Android 等运行时版本 */
  runtime?: string
  /** 包形态或安装形态（AppImage / deb / rpm / 系统包 / 便携） */
  installKind?: string
  /** 发行版名（仅 Linux） */
  distro?: string
  /** 用户界面语言 */
  locale?: string
  /** 用户数据目录（脱敏后），便于判断是否是目录权限/路径问题 */
  userDataPath?: string
  /** 导出时刻（epoch），由调用方给出，排版层不做时间取数 */
  exportedAt: number
  /** 本次导出的日志覆盖范围描述，如「5 个文件，共 1.2 MB」 */
  coverage?: string
}

/** 一份待打包的日志文件 */
export interface LogFilePart {
  /** 文件名（含滚动序号后缀），导出后作为分段标题 */
  name: string
  /** 修改时间（epoch）；缺失时排到最前，避免因 0 被误排到最后 */
  mtime?: number
  content: string
}

/** 分隔线：人工阅读时分段清晰，且不会与日志正文形态混淆 */
const SEPARATOR = '='.repeat(78)

/** 环境头排版：`键: 值` 对齐，空值写成 `-` 而不是省略（省略会被误读为「没采到」） */
export function formatEnvironment(env: LogEnvironment): string {
  const rows: Array<[string, string | undefined]> = [
    ['App version', env.appVersion],
    ['Origin', env.origin],
    ['Platform', env.platform],
    ['Arch', env.arch],
    ['Runtime', env.runtime],
    ['Install kind', env.installKind],
    ['Distro', env.distro],
    ['Locale', env.locale],
    ['User data', env.userDataPath],
    ['Exported at', formatTimestamp(env.exportedAt)],
    ['Coverage', env.coverage],
  ]
  const width = Math.max(...rows.map(([key]) => key.length))
  const lines = rows.map(([key, value]) => `${key.padEnd(width)} : ${value && value.trim() ? value : '-'}`)
  return [
    SEPARATOR,
    'Aurora Music diagnostic logs',
    SEPARATOR,
    ...lines,
    '',
    'NOTE: secrets (passwords / API keys / cookies / auth headers) are redacted as ***.',
    'Please still skim this file before sending it anywhere.',
    SEPARATOR,
    '',
  ].join('\n')
}

/**
 * 拼装导出包。
 *
 * 文件顺序按 mtime 升序（旧 → 新）：排障时读者关心「最后发生了什么」，
 * 新记录在文件尾部，顺序与时间一致才不需要来回翻。
 * 内容结尾统一补一个空行，避免下一段的标题被上一条日志的半行挤在一起。
 */
export function buildLogBundle(env: LogEnvironment, files: LogFilePart[]): string {
  const ordered = [...files].sort((a, b) => (a.mtime ?? 0) - (b.mtime ?? 0))
  const chunkCount = ordered.length

  const parts: string[] = [formatEnvironment({ ...env, coverage: env.coverage ?? `${chunkCount} file(s)` })]

  ordered.forEach((file, index) => {
    // 旧 → 新；给读者标注「第几个，越靠后越新」
    const position = `${index + 1}/${chunkCount}`
    const mtime = file.mtime ? ` · mtime ${formatTimestamp(file.mtime)}` : ''
    parts.push(`${SEPARATOR}\n── ${file.name} (${position}${mtime})\n${SEPARATOR}`)
    const content = file.content ?? ''
    parts.push(content.endsWith('\n') || content === '' ? content : `${content}\n`)
  })

  if (ordered.length === 0) {
    parts.push('(no log files: the logging system may not have produced output yet, or logs were cleared)\n')
  }

  return parts.join('\n')
}

/** 导出文件名：带时间戳且不含冒号（Windows 文件名不允许），便于用户多个文件并存 */
export function logBundleFileName(appVersion: string, exportedAt: number): string {
  const date = new Date(exportedAt)
  const stamp = Number.isNaN(date.getTime())
    ? 'unknown'
    : [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0'),
      ].join('') +
      '-' +
      [
        String(date.getHours()).padStart(2, '0'),
        String(date.getMinutes()).padStart(2, '0'),
        String(date.getSeconds()).padStart(2, '0'),
      ].join('')
  return `Aurora-Music-logs-v${appVersion}-${stamp}.txt`
}
