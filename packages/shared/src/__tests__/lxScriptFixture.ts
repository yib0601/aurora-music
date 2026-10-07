/**
 * 洛雪音源素材（第三方脚本）获取 —— 仅测试用，非实现代码
 *
 * 素材是外部仓库 pdone/lx-music-source 的脚本集合，**不入库**：体积不小、上游一直在动，
 * 而且是别人的代码。取法按「本地已有 → 浅克隆 → 放弃」三级降级：
 *   1. 本地已有克隆（默认 `/tmp/lx-music-source`，可用 `LX_SCRIPT_DIR` 覆盖）→ 直接读，离线可跑；
 *   2. 没有就浅克隆到临时目录（可用 `LX_SCRIPT_CACHE` 覆盖），CI 走这条；
 *   3. 出网受限拿不到（大陆网络无代理、CI 有 egress 限制）→ 返回 null 与原因，
 *      由调用方把相关用例显式 skip。
 *
 * 为什么必须降级而不是直接读固定路径：素材缺失原本是一条 ENOENT 硬失败
 * （CI 的 Test shared 步骤），main 上连续 5 轮全红，而红的原因是「测试机 /tmp 下没有
 * 克隆」这种环境差异，不是实现回归。外部素材不可得只能降级为显式 skip。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..')

const SOURCE_REPO = 'https://github.com/pdone/lx-music-source.git'
/** 判定「这是一份可用素材克隆」的锚点文件：取址用例依赖 huibq 脚本 */
const ANCHOR = 'huibq/latest.js'

const LOCAL_DIR = process.env.LX_SCRIPT_DIR || '/tmp/lx-music-source'
const CACHE_DIR = process.env.LX_SCRIPT_CACHE || path.join(os.tmpdir(), 'aurora-lx-scripts')

let dir: string | null | undefined
let why = ''

function usable(candidate: string): boolean {
  try {
    return fs.statSync(path.join(candidate, ANCHOR)).isFile()
  } catch {
    return false
  }
}

/** 素材目录；不可得返回 null（调用方 skip） */
export function lxScriptDir(): string | null {
  if (dir !== undefined) return dir
  if (usable(LOCAL_DIR)) {
    dir = LOCAL_DIR
    return dir
  }
  if (usable(CACHE_DIR)) {
    dir = CACHE_DIR
    return dir
  }
  try {
    // 半成品残留会让 clone 报「目标目录已存在且非空」，先清干净
    fs.rmSync(CACHE_DIR, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(CACHE_DIR), { recursive: true })
    execFileSync('git', ['clone', '--depth', '1', '--quiet', SOURCE_REPO, CACHE_DIR], {
      stdio: 'pipe',
      timeout: 120_000,
    })
  } catch (err) {
    const raw = (err as { stderr?: Buffer }).stderr?.toString() || (err as Error).message || String(err)
    const detail = raw.trim().split('\n').slice(-2).join(' / ')
    dir = null
    why = `洛雪音源素材不可得：本地无 ${LOCAL_DIR}，浅克隆 ${SOURCE_REPO} 也失败（${detail}）`
    return dir
  }
  if (!usable(CACHE_DIR)) {
    dir = null
    why = `洛雪音源素材不可得：克隆到 ${CACHE_DIR} 后仍找不到 ${ANCHOR}`
    return dir
  }
  dir = CACHE_DIR
  return dir
}

/** 素材不可得的原因（就绪时为空串），供 skip 提示 */
export function lxScriptReason(): string {
  lxScriptDir()
  return why
}

/** 读一条素材脚本；素材不可得返回 null */
export function readLxScript(rel: string): string | null {
  const base = lxScriptDir()
  if (!base) return null
  try {
    return fs.readFileSync(path.join(base, rel), 'utf8')
  } catch {
    return null
  }
}

/**
 * 打包 lxHost 用的 esbuild 可执行文件；找不到返回 null。
 * 先走 `node_modules/.bin`（pnpm 必然软链到当前版本），回落扫 `.pnpm` 下的版本目录，
 * 避免把本机 pnpm store 的绝对路径与具体版本号写死在测试里（CI 上必然对不上）。
 */
export function esbuildBin(): string | null {
  const direct = path.join(REPO_ROOT, 'node_modules', '.bin', 'esbuild')
  if (fs.existsSync(direct)) return direct
  const pnpmDir = path.join(REPO_ROOT, 'node_modules', '.pnpm')
  try {
    const versions = fs
      .readdirSync(pnpmDir)
      .filter((name) => name.startsWith('esbuild@'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    for (const name of versions.reverse()) {
      const bin = path.join(pnpmDir, name, 'node_modules', 'esbuild', 'bin', 'esbuild')
      if (fs.existsSync(bin)) return bin
    }
  } catch {
    /* 落到 null */
  }
  return null
}

/** 仓库根（报错信息用） */
export const repoRoot = REPO_ROOT