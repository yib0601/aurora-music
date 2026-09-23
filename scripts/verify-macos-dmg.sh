#!/usr/bin/env bash
# macOS 产物校验：主程序架构 / better-sqlite3 原生模块架构 / ad-hoc 签名 / 版本号
# 仅在 macOS 上运行（依赖 hdiutil、lipo、codesign、PlistBuddy）。
# 用法: EXPECTED_ARCH=arm64 bash scripts/verify-macos-dmg.sh <dmg 路径>
#
# 两条硬约束（都在 CI 上真实踩过，改动本文件时勿破坏）：
# 1. 变量后紧跟中文标点必须写成 ${VAR}。macOS 自带 bash 3.2 解析 `$VAR（` 时会把全角
#    字符的字节并进变量名，报 "unbound variable" 并中止脚本；Linux 的 bash 5 不会，
#    所以在本地跑得好好的脚本到了 mac runner 上会挂。
# 2. EXIT trap 里最后一条命令的退出码会覆盖脚本退出码。不显式 exit "${code}" 的话，
#    任何校验失败都会被 cleanup 的成功退出码洗成 0，CI 上表现为「校验步骤全绿」。
set -euo pipefail

DMG="${1:-}"
EXPECTED_ARCH="${EXPECTED_ARCH:-}"

if [ -z "${DMG}" ] || [ ! -f "${DMG}" ]; then
  echo "::error::未找到 dmg 产物：${DMG:-<空>}"
  exit 1
fi
if [ -z "${EXPECTED_ARCH}" ]; then
  echo "::error::未设置 EXPECTED_ARCH（arm64 或 x86_64）"
  exit 1
fi

MOUNT="$(mktemp -d)"

cleanup() {
  local code=$?
  hdiutil detach "${MOUNT}" -quiet 2>/dev/null || true
  rmdir "${MOUNT}" 2>/dev/null || true
  exit "${code}"
}
trap cleanup EXIT

fail() {
  echo "::error::$1"
  exit 1
}

echo "== 挂载 ${DMG} =="
hdiutil attach "${DMG}" -nobrowse -readonly -quiet -mountpoint "${MOUNT}"

APP="$(find "${MOUNT}" -maxdepth 1 -name '*.app' | head -1)"
if [ -z "${APP}" ]; then
  echo "::error::dmg 内没有 .app"
  ls -la "${MOUNT}"
  exit 1
fi
echo "APP: ${APP}"

# 1. 主可执行文件架构：架构错了在目标机器上表现为「双击无反应」
MAIN="${APP}/Contents/MacOS/Aurora-Music"
[ -f "${MAIN}" ] || fail "主可执行文件缺失：${MAIN}"
MAIN_ARCH="$(lipo -archs "${MAIN}" | tr -d ' ')"
echo "主程序架构: ${MAIN_ARCH}"
[ "${MAIN_ARCH}" = "${EXPECTED_ARCH}" ] || fail "主程序架构不符：期望 ${EXPECTED_ARCH}，实际 ${MAIN_ARCH}"

# 2. better-sqlite3 原生模块架构：electron-builder 的 npmRebuild 必须针对目标架构重建，
#    否则渲染层一进库就抛 ABI 不匹配
NATIVE="${APP}/Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
[ -f "${NATIVE}" ] || fail "better-sqlite3 原生模块缺失：${NATIVE}"
NATIVE_ARCH="$(lipo -archs "${NATIVE}" | tr -d ' ')"
echo "better-sqlite3 架构: ${NATIVE_ARCH}"
[ "${NATIVE_ARCH}" = "${EXPECTED_ARCH}" ] || fail "better-sqlite3 架构不符：期望 ${EXPECTED_ARCH}，实际 ${NATIVE_ARCH}"

# 3. ad-hoc 签名：无 Apple 开发者证书时，未签名的 arm64 产物会被内核拒绝执行。
#    mac.identity 一旦被改回 null / 移除，这里必须让发布失败而不是静默出坏包。
SIGN_INFO="$(codesign -dv --verbose=2 "${APP}" 2>&1 || true)"
echo "${SIGN_INFO}" | grep -E '^(Identifier|Signature|TeamIdentifier)=' || true
echo "${SIGN_INFO}" | grep -q 'Signature=adhoc' || fail "未检测到 ad-hoc 签名（packages/desktop/package.json 的 mac.identity 配置失效？）"

# 4. 版本号：dmg 内 Info.plist 必须与根 package.json 一致
EXPECTED_VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json | head -1)"
ACTUAL_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "${APP}/Contents/Info.plist")"
echo "版本: ${ACTUAL_VERSION}（期望 ${EXPECTED_VERSION}）"
[ "${ACTUAL_VERSION}" = "${EXPECTED_VERSION}" ] || fail "版本号不符：期望 ${EXPECTED_VERSION}，实际 ${ACTUAL_VERSION}"

echo "✅ macOS 产物校验通过：${EXPECTED_ARCH} / ad-hoc 签名 / v${ACTUAL_VERSION}"
