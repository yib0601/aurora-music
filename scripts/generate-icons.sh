#!/usr/bin/env bash
# 从 SVG 源文件生成全平台图标（桌面 png/ico、Android mipmap、web favicon）
# 用法: bash scripts/generate-icons.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RES="$ROOT/packages/desktop/resources"
ANDROID_RES="$ROOT/packages/mobile/android/app/src/main/res"
APP_PUBLIC="$ROOT/packages/app/public"

SVG_ROUND="$RES/icon.svg"        # 圆角版（桌面/web）
SVG_FULL="$RES/icon-full.svg"    # 全幅版（Android）

command -v magick >/dev/null || { echo "需要 ImageMagick (magick)"; exit 1; }

echo "== 桌面版 =="
magick -background none "$SVG_ROUND" -resize 512x512 "$RES/icon.png"
magick -background none "$SVG_ROUND" \
  \( -clone 0 -resize 16x16 \) \
  \( -clone 0 -resize 24x24 \) \
  \( -clone 0 -resize 32x32 \) \
  \( -clone 0 -resize 48x48 \) \
  \( -clone 0 -resize 64x64 \) \
  \( -clone 0 -resize 128x128 \) \
  \( -clone 0 -resize 256x256 \) \
  -delete 0 "$RES/icon.ico"

echo "== Android mipmap =="
declare -A DENSITIES=( [mdpi]=48 [hdpi]=72 [xhdpi]=96 [xxhdpi]=144 [xxxhdpi]=192 )
for d in mdpi hdpi xhdpi xxhdpi xxxhdpi; do
  size=${DENSITIES[$d]}
  fg=$(( size * 225 / 100 ))   # foreground = launcher * 2.25 (108dp/48dp)
  dir="$ANDROID_RES/mipmap-$d"
  magick -background none "$SVG_FULL" -resize "${size}x${size}" "$dir/ic_launcher.png"
  magick -background none "$SVG_FULL" -resize "${size}x${size}" "$dir/ic_launcher_round.png"
  magick -background none "$SVG_FULL" -resize "${fg}x${fg}" "$dir/ic_launcher_foreground.png"
  echo "  $d: ${size}px / foreground ${fg}px"
done
# adaptive icon 背景色 = 夜空底色
sed -i 's|#FFFFFF|#0A1128|' "$ANDROID_RES/values/ic_launcher_background.xml"

echo "== Web favicon =="
mkdir -p "$APP_PUBLIC"
cp "$SVG_ROUND" "$APP_PUBLIC/favicon.svg"

echo "完成。"
