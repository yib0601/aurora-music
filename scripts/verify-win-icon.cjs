#!/usr/bin/env node
/**
 * 校验 Windows 构建产物是否真的嵌入了 Aurora 图标与版本信息。
 *
 * 背景：build.win.signAndEditExecutable: false 会整体跳过 exe 资源编辑，
 * 导致桌面快捷方式（NSIS 取 exe 第 0 号图标）显示 Electron 默认图标。
 * 详见 docs/desktop-packaging.md。
 *
 * 用法：
 *   node scripts/verify-win-icon.cjs packages/desktop/release/win-unpacked/Aurora-Music.exe
 *   # 带参照 ico 时额外比对图标尺寸集合：
 *   node scripts/verify-win-icon.cjs <exe> packages/desktop/resources/icon.ico
 *
 * 期望结果：
 *   图标组 7 个尺寸 16/24/32/48/64/128/256，且与 resources/icon.ico 一致；
 *   版本信息 ProductName=Aurora-Music、CompanyName=Aurora Music。
 *   若只有 4 个尺寸（16/32/48/256）且 ProductName=Electron，说明配置被改坏了。
 */
const fs = require('fs')
const path = require('path')
const { createRequire } = require('module')

const ROOT = path.join(__dirname, '..')
const DESKTOP = path.join(ROOT, 'packages', 'desktop')

// resedit 是 electron-builder（app-builder-lib）的依赖，不在项目直接依赖里，
// 因此按「直接解析 → 沿 electron-builder 依赖树解析 → pnpm 虚拟 store 兜底」依次尝试。
function loadResedit() {
  const attempts = [
    () => require('resedit'),
    () => {
      const eb = require.resolve('electron-builder', { paths: [DESKTOP, ROOT] })
      const abl = createRequire(eb).resolve('app-builder-lib')
      return createRequire(abl)('resedit')
    },
    () => {
      const pnpmDir = path.join(ROOT, 'node_modules', '.pnpm')
      const dir = fs.readdirSync(pnpmDir).find((d) => d.startsWith('resedit@'))
      if (!dir) throw new Error('pnpm store 中未找到 resedit')
      return require(path.join(pnpmDir, dir, 'node_modules', 'resedit'))
    },
  ]
  const errors = []
  for (const attempt of attempts) {
    try {
      return attempt()
    } catch (err) {
      errors.push(err.message)
    }
  }
  throw new Error(`未能加载 resedit（请确认已 pnpm install）:\n  ${errors.join('\n  ')}`)
}

const { NtExecutable, NtExecutableResource, Resource, Data } = loadResedit()

function inspectExe(exePath) {
  const buf = fs.readFileSync(exePath)
  if (buf[0] !== 0x4d || buf[1] !== 0x5a) throw new Error(`不是 PE 文件: ${exePath}`)

  const exe = NtExecutable.from(buf, { ignoreCert: true })
  const res = NtExecutableResource.from(exe)

  const icons = []
  for (const g of Resource.IconGroupEntry.fromEntries(res.entries)) {
    for (const i of g.icons) {
      icons.push({ w: i.width || 256, h: i.height || 256, bpp: i.bitCount })
    }
  }

  let version = null
  const viList = Resource.VersionInfo.fromEntries(res.entries)
  if (viList.length > 0) {
    const langs = viList[0].getAllLanguagesForStringValues()
    if (langs.length > 0) version = viList[0].getStringValues(langs[0])
  }

  return { icons, version }
}

function readIco(icoPath) {
  const iconFile = Data.IconFile.from(fs.readFileSync(icoPath))
  return iconFile.icons.map((i) => `${i.width || 256}x${i.height || 256}`).sort()
}

function main() {
  const exePath = process.argv[2]
  if (!exePath) {
    console.error('用法: node scripts/verify-win-icon.cjs <exe> [参照 icon.ico]')
    process.exit(2)
  }

  const { icons, version } = inspectExe(exePath)
  const dims = icons.map((i) => `${i.w}x${i.h}`).sort()

  console.log(`exe: ${exePath}`)
  console.log(`图标组尺寸(${dims.length}): ${dims.join(', ')}`)
  console.log('版本信息:', JSON.stringify(version, null, 2))

  const failures = []

  const EXPECTED = ['128x128', '16x16', '24x24', '256x256', '32x32', '48x48', '64x64']
  if (JSON.stringify(dims) !== JSON.stringify(EXPECTED)) {
    failures.push(`图标尺寸集合应为 ${EXPECTED.join(', ')}，实际 ${dims.join(', ')}`)
  }

  if (!version || version.ProductName !== 'Aurora-Music') {
    failures.push(`版本信息 ProductName 应为 Aurora-Music，实际 ${version && version.ProductName}`)
  }

  const icoPath = process.argv[3]
  if (icoPath) {
    const ref = readIco(icoPath)
    if (JSON.stringify(ref) !== JSON.stringify(dims)) {
      failures.push(`与 ${icoPath} 尺寸不一致：参照 [${ref.join(', ')}]`)
    } else {
      console.log(`与参照 ico 尺寸一致 ✅ (${path.basename(icoPath)})`)
    }
  }

  if (failures.length > 0) {
    console.error('\n❌ 校验失败：')
    for (const f of failures) console.error(`  - ${f}`)
    console.error('  请检查 build.win.signExecutable / signAndEditExecutable（见 docs/desktop-packaging.md）')
    process.exit(1)
  }
  console.log('\n✅ exe 已嵌入 Aurora 图标与版本信息')
}

main()
