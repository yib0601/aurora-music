#!/usr/bin/env node
/**
 * i18n 门禁：扫描源码里**还没走字典**的中文界面文案。
 *
 * 判据（为什么是这几条）：
 *   1. 注释里的中文一律不算 —— 项目注释密度很高，把注释算进来会让报告
 *      立刻失去可读性，而且注释本来就该用中文写；
 *   2. 日志（console.*）不算 —— 日志面向开发者，不进界面；
 *   3. 字符串字面量与 JSX 文本节点里的中文**算** —— 这正是会被渲染上屏的东西，
 *      包括抛错的 message（错误文案已改走 AuroraError 的结构化键）；
 *   4. 领域数据（歌名繁简映射、平台标签等）按文件级白名单放行，白名单必须
 *      写明理由，且白名单文件里的界面文案仍需单独处理。
 *
 * 用法：
 *   node scripts/check-i18n.mjs            # 报告模式：列出未国际化的文件与条目
 *   node scripts/check-i18n.mjs --strict   # 门禁模式：有任何一条即退出码 1
 *   node scripts/check-i18n.mjs --json     # 机读输出（供 verifier 统计）
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const SCAN_ROOTS = [
  'packages/app/src',
  'packages/desktop/src',
  'packages/shared/src',
  'packages/mobile/android/app/src/main/java',
  'packages/mobile/android/app/src/main/res/values',
]

const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.kt', '.java', '.xml', '.html'])

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'dist-electron',
  'app-dist',
  'release',
  'build',
  '.git',
  '__tests__',
  'assets',
  'screenshots',
])

/**
 * 文件级白名单：允许保留中文字面量的「非界面」文件。
 * 每一条都必须写清理由，否则下一个人不敢动、也不会动。
 */
const FILE_ALLOWLIST = [
  {
    file: 'packages/shared/src/coverMatch.ts',
    reason: '华语歌名匹配用的繁简映射表与版本标记词表，是参与比较的数据而非界面文案',
  },
  {
    file: 'packages/shared/src/i18n/messages/zh-CN',
    reason: '中文字典本身（中文是源语言）',
  },
  {
    file: 'packages/shared/src/i18n/messages/en',
    reason: '英文字典（注释用中文书写）',
  },
  {
    file: 'packages/mobile/android/app/src/main/java/com/aurora/music/MainActivity.java',
    reason: 'Capacitor 桥接层，中文仅出现在注释里',
  },
]

/** 行级豁免：显式标记的行不参与判红（用于确有必要的例外，如品牌名） */
const LINE_EXEMPTION = /i18n-exempt/

/**
 * 领域占位值：这些中文字面量是**匹配数据**，不是界面文案。
 *
 * 它们由 `packages/shared/src/coverMatch.ts` 的 `PLACEHOLDER_ARTISTS` 定义
 * （用于判定「歌手未知」，从而决定封面候选是否要过歌手门禁），并被
 * `musicSource` / `lxHost` / `musicHall` / `downloadUtils` 用作兜底值，
 * desktop 侧 `ipc/scanner.ts` 的 `META_PLACEHOLDERS` 认得同一批串。
 *
 * 翻译它们 = 改匹配规则：英文界面下 `hasKnownArtist()` 会对 'Unknown artist'
 * 返回 true，封面匹配行为随语言漂移。所以这些**只允许原样保留**，
 * 且下面的自检会保证它与 coverMatch 的同源关系不被改坏。
 */
const DOMAIN_PLACEHOLDERS = new Set(['未知艺术家', '未知专辑', '未知歌曲', '合辑', '群星'])

/**
 * 自检：脚本里的占位值必须与 coverMatch.ts 的定义逐字一致。
 * 门禁脚本自身也会漂移（改了 coverMatch 忘了改这里，就会出现「越白名单」的
 * 静默放行），所以把同源关系变成启动时的硬校验。
 */
function assertPlaceholdersInSync() {
  const coverMatchPath = path.join(root, 'packages/shared/src/coverMatch.ts')
  if (!fs.existsSync(coverMatchPath)) return
  const source = fs.readFileSync(coverMatchPath, 'utf8')
  const match = /PLACEHOLDER_ARTISTS\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(source)
  if (!match) return
  const declared = [...match[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2])
  const mismatch = declared.some((value) => !DOMAIN_PLACEHOLDERS.has(value))
  if (mismatch || declared.length !== DOMAIN_PLACEHOLDERS.size) {
    console.error('check-i18n 自身失步：DOMAIN_PLACEHOLDERS 与 coverMatch.PLACEHOLDER_ARTISTS 不一致')
    console.error(`  coverMatch: ${declared.join(' / ')}`)
    console.error(`  check-i18n: ${[...DOMAIN_PLACEHOLDERS].join(' / ')}`)
    process.exit(2)
  }
}

assertPlaceholdersInSync()

const CHINESE = /[\u4e00-\u9fff]/

function walk(dir, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(path.join(dir, entry.name), out)
    } else if (EXTENSIONS.has(path.extname(entry.name))) {
      out.push(path.join(dir, entry.name))
    }
  }
  return out
}

function isAllowlisted(relPath) {
  return FILE_ALLOWLIST.some((entry) => relPath === entry.file || relPath.startsWith(`${entry.file}/`))
}

/**
 * 剥离注释，保留字符串字面量。
 * 逐字符扫描（而不是正则）：JS 里 `//` 会出现在 URL 字符串里，`/*` 会出现在
 * 正则里，正则替换会把字符串内容误删，导致漏报。
 */
function stripComments(source) {
  let out = ''
  let state = 'code'
  let quote = ''
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i]
    const d = source[i + 1]
    if (state === 'code') {
      if (c === '/' && d === '/') {
        state = 'line'
        i += 1
        continue
      }
      if (c === '/' && d === '*') {
        state = 'block'
        i += 1
        continue
      }
      if (c === '"' || c === "'" || c === '`') {
        state = 'str'
        quote = c
        out += c
        continue
      }
      out += c
      continue
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'code'
        out += c
      }
      continue
    }
    if (state === 'block') {
      if (c === '*' && d === '/') {
        state = 'code'
        i += 1
        continue
      }
      if (c === '\n') out += c
      continue
    }
    // state === 'str'
    if (c === '\\') {
      out += c + (d ?? '')
      i += 1
      continue
    }
    out += c
    if (c === quote) state = 'code'
  }
  return out
}

/** 中文注释行（Kotlin / XML 用各自语法）：行级剥离，报告里不当作违规 */
function isCommentOnlyLine(line) {
  const trimmed = line.trim()
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('<!--') ||
    trimmed.startsWith('*/')
  )
}

/**
 * 日志行：面向开发者，不进界面。
 * 除了 Web 侧的 console.*，也要认 Android 原生的 Log.x( / Timber / printStackTrace：
 * 之前只认 console.*，Kotlin 里的中文日志行被逐条误报，只能靠行尾 i18n-exempt 压下去。
 */
function isLogLine(line) {
  return (
    /\bconsole\.(log|info|warn|error|debug)\s*\(/.test(line) ||
    /\bLog\.[vdiew]\s*\(/.test(line) ||
    /\bTimber\.[vdiew]\s*\(/.test(line) ||
    /\bprintStackTrace\s*\(/.test(line)
  )
}

function extractItems(line) {
  const items = []
  // JSX 文本节点：>{...}<
  for (const match of line.matchAll(/>([^<>{}]*[\u4e00-\u9fff][^<>{}]*)</g)) {
    items.push(match[1].trim())
  }
  // 字符串字面量
  for (const match of line.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*?)\1/g)) {
    if (CHINESE.test(match[2])) items.push(match[2])
  }
  // Kotlin/Java 字符串："..."
  if (line.includes('"')) {
    for (const match of line.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)) {
      if (CHINESE.test(match[1])) items.push(match[1])
    }
  }
  return [...new Set(items)]
}

const findings = []
for (const scanRoot of SCAN_ROOTS) {
  const absolute = path.join(root, scanRoot)
  if (!fs.existsSync(absolute)) continue
  for (const file of walk(absolute)) {
    const relPath = path.relative(root, file).split(path.sep).join('/')
    if (isAllowlisted(relPath)) continue
    const source = fs.readFileSync(file, 'utf8')
    const rawLines = source.split('\n')
    const stripped = stripComments(source)
    const lines = stripped.split('\n')
    lines.forEach((line, index) => {
      if (!CHINESE.test(line)) return
      if (isCommentOnlyLine(line) || isLogLine(line)) return
      // 行级豁免按**原始行**判定：注释在上一行已被剥掉，若拿剥离后的文本判，
      // `// i18n-exempt` 这种标记永远匹配不到（这条 bug 曾经真实存在过）。
      if (LINE_EXEMPTION.test(rawLines[index] ?? '')) return
      const items = extractItems(line).filter((item) => !DOMAIN_PLACEHOLDERS.has(item))
      if (items.length === 0) return
      findings.push({ file: relPath, line: index + 1, items })
    })
  }
}

const byFile = new Map()
for (const finding of findings) {
  const entry = byFile.get(finding.file) ?? { count: 0, samples: [] }
  entry.count += finding.items.length
  if (entry.samples.length < 3) entry.samples.push(`L${finding.line} ${finding.items[0]}`)
  byFile.set(finding.file, entry)
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ total: findings.reduce((sum, f) => sum + f.items.length, 0), files: Object.fromEntries(byFile), findings }, null, 2))
} else {
  const total = findings.reduce((sum, f) => sum + f.items.length, 0)
  console.log(`未国际化中文文案：${total} 条，涉及 ${byFile.size} 个文件`)
  console.log('')
  const sorted = [...byFile.entries()].sort((a, b) => b[1].count - a[1].count)
  for (const [file, entry] of sorted) {
    console.log(`${String(entry.count).padStart(4)}  ${file}`)
    for (const sample of entry.samples) console.log(`      · ${sample}`)
  }
  console.log('')
  console.log('白名单（理由见脚本 FILE_ALLOWLIST）：')
  for (const entry of FILE_ALLOWLIST) console.log(`  - ${entry.file}：${entry.reason}`)
}

/**
 * 英文字典的残留检查：英文文案里不许出现中日韩字符。
 *
 * 为什么这条比「英文键覆盖齐全」更值得单独判：键覆盖由 tsc 保证（少键编译就炸），
 * 但**值**可以是任何字符串——复制中文条目当占位、或者写了个半成品，
 * 编译器一句话都不会说。这条检查跑的是**构建产物**（dist），
 * 也就是运行时真正会加载的那份数据。
 *
 * 例外：值里合法的 CJK 只可能来自「中文是数据的一部分」的场景，
 * 这里显式列白名单键，其余一律判红。
 */
const EN_CJK_ALLOWLIST = new Set()

function checkEnglishDictionary() {
  const distPath = path.join(root, 'packages/shared/dist/index.js')
  if (!fs.existsSync(distPath)) {
    console.error('check-i18n：未找到 packages/shared/dist/index.js，先跑 `pnpm --filter @aurora/shared build`')
    process.exit(2)
  }
  const require = createRequire(import.meta.url)
  const sharedDist = require(distPath)
  const enTree = sharedDist.en
  if (!enTree) {
    console.error('check-i18n：构建产物里没有 en 字典（shared 是否已导出 i18n？）')
    process.exit(2)
  }
  const offenders = []
  const walk = (node, prefix) => {
    for (const [key, value] of Object.entries(node)) {
      const keyPath = prefix ? `${prefix}.${key}` : key
      if (typeof value === 'string') {
        if (CHINESE.test(value) && !EN_CJK_ALLOWLIST.has(keyPath)) {
          offenders.push(`${keyPath} = ${value}`)
        }
      } else if (value && typeof value === 'object') {
        walk(value, keyPath)
      }
    }
  }
  walk(enTree, '')
  if (offenders.length > 0) {
    console.error('')
    console.error(`英文字典里有 ${offenders.length} 条文案仍含中文：`)
    for (const line of offenders.slice(0, 20)) console.error(`  · ${line}`)
    if (offenders.length > 20) console.error(`  …另有 ${offenders.length - 20} 条`)
    process.exit(1)
  }
  console.log('英文字典残留检查：通过（en 全部条目无中文）')
}

if (!process.argv.includes('--json') && !process.argv.includes('--no-dict')) {
  checkEnglishDictionary()
}

if (process.argv.includes('--strict') && findings.length > 0) {
  console.error('')
  console.error(`i18n 门禁未通过：仍有 ${findings.length} 行界面中文未走字典`)
  process.exit(1)
}
