#!/usr/bin/env node
/**
 * 断言 Windows 产物（Aurora-Music.exe）的 PE 目标架构。
 *
 * 为什么需要：桌面端每个平台都出 x64 / arm64 两份，产物名由 -c.artifactName 拼出来，
 * 而真正的架构取决于 electron-builder 下载的 Electron 包与 better-sqlite3 的 rebuild
 * 目标。两者不一致时文件名照旧是 `-arm64.exe`，用户装上去却是个 x64 程序
 * （Linux 侧同样的问题由 scripts/check-linux-baseline.sh 的 EXPECTED_ARCH 拦）。
 *
 * 用法:
 *   node scripts/verify-win-arch.cjs <Aurora-Music.exe> <x64|arm64>
 *
 * 只读 PE 头，不需要 wine：
 *   - e_lfanew  在 0x3C，4 字节小端，指向 "PE\0\0"
 *   - Machine   在 e_lfanew + 4，2 字节小端（0x8664 = x64，0xAA64 = arm64）
 */
const fs = require('fs')

const MACHINE = { 0x8664: 'x64', 0xaa64: 'arm64', 0x14c: 'ia32', 0x1c4: 'armv7l' }

const [, , file, expected] = process.argv
if (!file || !expected) {
  console.error('用法: node scripts/verify-win-arch.cjs <exe> <x64|arm64>')
  process.exit(2)
}

let buf
try {
  buf = fs.readFileSync(file)
} catch (error) {
  console.error(`✗ 读不到文件：${file}（${error.message}）`)
  process.exit(2)
}

if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) {
  console.error(`✗ 不是 PE 文件（缺少 MZ 头）：${file}`)
  process.exit(2)
}

const peOffset = buf.readUInt32LE(0x3c)
if (buf.readUInt32LE(peOffset) !== 0x00004550) {
  console.error(`✗ 不是 PE 文件（缺少 PE\\0\\0 签名）：${file}`)
  process.exit(2)
}

const machine = buf.readUInt16LE(peOffset + 4)
const actual = MACHINE[machine] || `unknown(0x${machine.toString(16)})`

if (actual !== expected) {
  console.error(`✗ 架构不符：期望 ${expected}，实际 ${actual}（${file}）`)
  process.exit(1)
}

console.log(`✓ exe 架构 ${actual}（${file}）`)
