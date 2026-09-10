#!/usr/bin/env bash
#
# 校验 APK 是否由固定发布密钥签名。
#
# 背景：APK 的签名密钥一旦变化，已安装用户无法覆盖升级（Android 报「签名不一致」），
# 只能卸载重装。历史上该问题复发过多次，且都是「静默发生」——CI 照常成功、
# Release 照常发布，直到用户安装时才暴露。本脚本把这件事变成构建期硬失败。
#
# 三重校验（任意一项不符即退出码 1）：
#   1. 仓库内 keystore 的证书指纹 == 写死的期望值（防止 keystore 被重新生成）
#   2. APK 的签名证书指纹 == 写死的期望值（防止构建时被换成别的密钥签名）
#   3. 二者互相一致
#
# 用法：scripts/verify-apk-signature.sh <apk 路径>
set -euo pipefail

# 发布密钥证书指纹（SHA-256），对应 packages/mobile/android/app/aurora-music.keystore
# 变更此常量等同于承认「所有已安装用户都必须卸载重装」，务必谨慎。
EXPECTED_SHA256="eb4e48a95587ed954789b81b20fc23689cc702e602ebac08050d308eabdb435b"

KEYSTORE_REL="packages/mobile/android/app/aurora-music.keystore"
KEYSTORE_PASS="aurora-music-signing"
KEYSTORE_ALIAS="aurora"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEYSTORE="$REPO_ROOT/$KEYSTORE_REL"

die() { echo "::error::$*" >&2; echo "❌ $*" >&2; exit 1; }

APK="${1:-}"
[ -n "$APK" ] || die "用法：$0 <apk 路径>"
[ -f "$APK" ] || die "APK 不存在：$APK"
[ -f "$KEYSTORE" ] || die "签名密钥不存在：$KEYSTORE（请从 git 恢复，切勿重新生成）"

# 归一化指纹：去冒号、转小写，便于比较
normalize() { tr -d ':' | tr 'A-Z' 'a-z'; }

# --- 定位 apksigner（PATH 里没有就从 Android SDK build-tools 找）---
APKSIGNER="$(command -v apksigner || true)"
if [ -z "$APKSIGNER" ]; then
  SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
  if [ -n "$SDK" ] && [ -d "$SDK/build-tools" ]; then
    APKSIGNER="$(ls -1 "$SDK"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -1 || true)"
  fi
fi
[ -n "$APKSIGNER" ] && [ -x "$APKSIGNER" ] || die "找不到 apksigner，请设置 ANDROID_HOME 或安装 Android build-tools"
echo "apksigner : $APKSIGNER"

# --- 1. keystore 证书指纹 ---
# LC_ALL=C 保证 keytool 输出英文标签（SHA256:），与下面的 grep 匹配
KEYSTORE_SHA256="$(LC_ALL=C keytool -list -v \
    -keystore "$KEYSTORE" \
    -storepass "$KEYSTORE_PASS" \
    -alias "$KEYSTORE_ALIAS" 2>/dev/null \
  | grep 'SHA256:' | head -1 | awk '{print $2}' | normalize)"

[ -n "$KEYSTORE_SHA256" ] || die "无法从 $KEYSTORE_REL 读取证书指纹（密码/别名是否被改动？）"

# --- 2. APK 签名证书指纹 ---
APK_SHA256="$("$APKSIGNER" verify --print-certs "$APK" 2>/dev/null \
  | grep 'certificate SHA-256 digest' | head -1 | awk '{print $NF}' | normalize)"

[ -n "$APK_SHA256" ] || die "无法读取 APK 签名证书：$APK"
APK_SIGNERS="$("$APKSIGNER" verify --print-certs "$APK" 2>/dev/null \
  | grep -c 'certificate SHA-256 digest' || true)"
[ "$APK_SIGNERS" = "1" ] || die "APK 签名者数量异常（期望 1，实际 $APK_SIGNERS）"

echo "期望指纹  : $EXPECTED_SHA256"
echo "keystore  : $KEYSTORE_SHA256"
echo "APK       : $APK_SHA256"

# --- 3. 比对 ---
if [ "$KEYSTORE_SHA256" != "$EXPECTED_SHA256" ]; then
  die "发布密钥已被更换！$KEYSTORE_REL 的证书指纹与固定值不符。\
已安装用户将无法覆盖升级。请从 git 恢复原始 keystore，不要用新密钥发版。"
fi

if [ "$APK_SHA256" != "$EXPECTED_SHA256" ]; then
  die "APK 未使用固定发布密钥签名！$(basename "$APK") 的签名与固定值不符，\
发布后用户会看到「签名不一致」而无法覆盖安装。请检查 build.gradle 的 signingConfigs 是否被改动。"
fi

echo "✅ 签名校验通过：APK 由固定发布密钥签名，可安全覆盖升级"
