#!/usr/bin/env node
/**
 * Capacitor 6.x 的 AGP 9.x 兼容补丁（幂等）。
 *
 * AGP 9.x 起 getDefaultProguardFile('proguard-android.txt') 被移除（该文件带
 * -dontoptimize，会阻止 R8 优化），而 Capacitor 6.x 各包的 build.gradle 仍在引用它，
 * 于是「CI 能构建、本地一构建就挂」；更麻烦的是每次 pnpm install 都会把 node_modules
 * 里的手工改动抹掉，靠记忆去 sed 必然复发。
 *
 * 所以补丁收口在这里：本地由 `pnpm build:android`（经 sync:android）自动调用，
 * CI 调同一个脚本 —— 两边一份实现，不再各自维护一条 find | sed。
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '../../..')
const PNPM_DIR = join(ROOT, 'node_modules/.pnpm')
const FROM = 'proguard-android.txt'
const TO = 'proguard-android-optimize.txt'

function* walkBuildGradle(dir, depth = 0) {
  if (depth > 6) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'build' || entry.name === 'node_modules') continue
      yield* walkBuildGradle(path, depth + 1)
    } else if (entry.name === 'build.gradle') {
      yield path
    }
  }
}

/** 只扫 Capacitor 家族的包目录，避免误伤其他依赖 */
function* capacitorBuildGradleFiles() {
  let entries
  try {
    entries = readdirSync(PNPM_DIR, { withFileTypes: true })
  } catch {
    console.error(`找不到 ${PNPM_DIR} —— 请先在仓库根执行 pnpm install`)
    process.exit(1)
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('@capacitor')) continue
    yield* walkBuildGradle(join(PNPM_DIR, entry.name, 'node_modules'))
  }
}

let scanned = 0
let patched = 0
for (const file of capacitorBuildGradleFiles()) {
  scanned++
  const source = readFileSync(file, 'utf8')
  if (!source.includes(FROM)) continue
  // 不带引号替换，与 CI 原先的 sed 语义一致（引号类型无关）；
  // `proguard-android.txt` 不是 `proguard-android-optimize.txt` 的子串，重复执行安全
  writeFileSync(file, source.replaceAll(FROM, TO))
  patched++
  console.log(`  修正 ${file.slice(ROOT.length + 1)}`)
}

console.log(`Capacitor AGP 兼容补丁：扫描 ${scanned} 个 build.gradle，修正 ${patched} 个`)
