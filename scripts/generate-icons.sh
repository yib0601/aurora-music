#!/usr/bin/env bash
# 从 SVG 源生成全平台品牌资源：桌面图标、Android 应用图标与启动图、web favicon。
#
#   bash scripts/generate-icons.sh          生成全部派生资源
#   bash scripts/generate-icons.sh --check  只校验派生资源是否与 SVG 源同代（CI / 发布前用）
#
# 为什么启动图也归这里管：res/drawable*/splash.png 曾是 Capacitor 模板自带的白底
# 占位图，2026-09 那次「替换全平台图标」只覆盖了 mipmap 与桌面图标，车机开屏
# 因此长期停在旧图上且没有任何提示。凡是「从品牌 SVG 派生的位图」都收口到本
# 脚本，`--check` 就是防止下次再漏一处的闸门（CI 的 android job 会跑它）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RES="$ROOT/packages/desktop/resources"
ANDROID_RES="$ROOT/packages/mobile/android/app/src/main/res"
APP_PUBLIC="$ROOT/packages/app/public"

SVG_ROUND="$RES/icon.svg"        # 圆角版：桌面 / web / 启动图居中图形
SVG_FULL="$RES/icon-full.svg"    # 全幅版：Android 自适应图标前景

# 启动图底色。必须与下面两处同值，否则冷启动会看到「启动图 → 窗口背景 → 主界面」
# 三层色块跳变（--check 会把这三处一起卡住）：
#   packages/mobile/android/app/src/main/res/values/colors.xml  (aurora_window_bg)
#   packages/mobile/capacitor.config.ts                         (SplashScreen.backgroundColor)
SPLASH_BG='#0A0A0A'

# Capacitor 模板约定的 11 张启动图规格：横竖各 5 档密度 + 无方向限定的兜底张。
# 车机是横屏大屏，实际命中的是 land-* 与 drawable/ 兜底那两张。
declare -A SPLASH_PORT=( [mdpi]='320x480' [hdpi]='480x800' [xhdpi]='720x1280' [xxhdpi]='960x1600' [xxxhdpi]='1280x1920' )
declare -A SPLASH_LAND=( [mdpi]='480x320' [hdpi]='800x480' [xhdpi]='1280x720' [xxhdpi]='1600x960' [xxxhdpi]='1920x1280' )
SPLASH_FALLBACK='480x320'

declare -A ICON_SIZE=( [mdpi]=48 [hdpi]=72 [xhdpi]=96 [xxhdpi]=144 [xxxhdpi]=192 )
DENSITIES=(mdpi hdpi xhdpi xxhdpi xxxhdpi)

# 启动图里品牌图形占屏幕短边的比例：过大像壁纸、过小显空。30% 与 Android 12
# 系统启动画面（288dp 图标 / 短边约 720dp）的观感一致。
SPLASH_ICON_PCT=30

CHECK=0
[[ "${1:-}" == "--check" ]] && CHECK=1

FAILURES=0
pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
info() { printf '  %s\n' "$1"; }

rel() { printf '%s' "${1#"$ROOT"/}"; }

# 启动图几何：短边（无论横竖）的 30%，取偶数边长，避免奇偶缩放产生半像素模糊。
splash_geom() { # $1 = WxH → 打印 "W H ICON"
  local wh=$1 w=${1%x*} h=${1#*x}
  local short=$(( w < h ? w : h ))
  echo "$w $h $(( short * SPLASH_ICON_PCT / 100 / 2 * 2 ))"
}

# ─────────────────────────── 校验模式 ───────────────────────────
if [[ $CHECK -eq 1 ]]; then
  command -v identify >/dev/null || { echo "需要 ImageMagick（identify）"; exit 1; }

  echo "== 品牌资源校验 =="

  # 1) 启动图：尺寸 + 底色。旧模板图是白底（均值≈1.0），新图是 #0A0A0A 深底
  #    （均值≈0.05），用均值判据即可在不做像素格式解析的前提下把旧图挡在门外。
  check_splash() {
    local out=$1 wh=$2
    local -a geom
    read -r -a geom <<<"$(splash_geom "$wh")"
    local w=${geom[0]} h=${geom[1]}
    if [[ ! -f "$out" ]]; then fail "缺少 $(rel "$out")"; return; fi
    local dims mean
    dims=$(identify -format '%wx%h' "$out")
    if [[ "$dims" != "$wh" ]]; then
      fail "$(rel "$out") 尺寸 $dims，期望 $wh"
      return
    fi
    mean=$(identify -format '%[fx:mean]' "$out")
    if ! awk -v m="$mean" 'BEGIN{exit !(m < 0.35)}'; then
      fail "$(rel "$out") 底色偏亮（均值 $mean）——疑似仍是 Capacitor 模板白底旧图"
      return
    fi
    pass "$(rel "$out") ${w}x${h}"
  }

  for d in "${DENSITIES[@]}"; do
    check_splash "$ANDROID_RES/drawable-port-$d/splash.png" "${SPLASH_PORT[$d]}"
  done
  for d in "${DENSITIES[@]}"; do
    check_splash "$ANDROID_RES/drawable-land-$d/splash.png" "${SPLASH_LAND[$d]}"
  done
  check_splash "$ANDROID_RES/drawable/splash.png" "$SPLASH_FALLBACK"

  # 2) Android 自适应图标：尺寸 + 非白底（模板默认图标是白底绿机器人）
  check_mipmap() {
    local out=$1 size=$2
    if [[ ! -f "$out" ]]; then fail "缺少 $(rel "$out")"; return; fi
    local dims
    dims=$(identify -format '%wx%h' "$out")
    if [[ "$dims" != "${size}x${size}" ]]; then
      fail "$(rel "$out") 尺寸 $dims，期望 ${size}x${size}"
      return
    fi
    local mean
    mean=$(identify -format '%[fx:mean]' "$out")
    if awk -v m="$mean" 'BEGIN{exit !(m > 0.9)}'; then
      fail "$(rel "$out") 近似纯白背景——疑为模板默认图标"
      return
    fi
    pass "$(rel "$out") ${size}px"
  }
  for d in "${DENSITIES[@]}"; do
    check_mipmap "$ANDROID_RES/mipmap-$d/ic_launcher.png" "${ICON_SIZE[$d]}"
    check_mipmap "$ANDROID_RES/mipmap-$d/ic_launcher_foreground.png" "$(( ${ICON_SIZE[$d]} * 225 / 100 ))"
  done

  # 3) 桌面图标与 web favicon
  for f in icon.png icon.ico icon-mac.png; do
    [[ -f "$RES/$f" ]] && pass "packages/desktop/resources/$f" || fail "缺少 packages/desktop/resources/$f"
  done
  if cmp -s "$SVG_ROUND" "$APP_PUBLIC/favicon.svg"; then
    pass "packages/app/public/favicon.svg 与 icon.svg 一致"
  else
    fail "packages/app/public/favicon.svg 与 icon.svg 不一致（重新生成即可）"
  fi

  # 4) 启动链路三处底色同值：不同色就是肉眼可见的跳变
  win_bg=$(sed -n 's/.*<color name="aurora_window_bg">\(#[0-9A-Fa-f]\{6\}\)<.*/\1/p' "$ANDROID_RES/values/colors.xml")
  # 锚定 SplashScreen 块：capacitor.config.ts 里 StatusBar 也有一个 backgroundColor
  cap_bg=$(awk '/SplashScreen: *\{/{f=1} f && /backgroundColor:/{print; exit}' "$ROOT/packages/mobile/capacitor.config.ts" |
    sed -n "s/.*'\([^']*\)'.*/\1/p")
  want=$(printf '%s' "$SPLASH_BG" | tr 'a-f' 'A-F')
  for pair in "colors.xml aurora_window_bg:$win_bg" "capacitor.config.ts SplashScreen.backgroundColor:$cap_bg"; do
    name=${pair%%:*}; got=$(printf '%s' "${pair#*:}" | tr 'a-f' 'A-F')
    if [[ "$got" == "$want" ]]; then pass "$name = $want"; else fail "$name = ${got:-未找到}，期望 $want"; fi
  done

  echo
  if (( FAILURES > 0 )); then
    echo "品牌资源校验未通过：$FAILURES 项。跑 bash scripts/generate-icons.sh 重新生成。"
    exit 1
  fi
  echo "品牌资源校验通过。"
  exit 0
fi

# ─────────────────────────── 生成模式 ───────────────────────────
if command -v magick >/dev/null 2>&1; then
  IM() { magick "$@"; }
elif command -v convert >/dev/null 2>&1; then
  IM() { convert "$@"; }
else
  echo "需要 ImageMagick（magick 或 convert）"; exit 1
fi
[[ -f "$SVG_ROUND" && -f "$SVG_FULL" ]] || { echo "缺少 SVG 源：$SVG_ROUND / $SVG_FULL"; exit 1; }

echo "== 桌面版 =="
IM -background none "$SVG_ROUND" -resize 512x512 "$RES/icon.png"
IM -background none "$SVG_ROUND" \
  \( -clone 0 -resize 16x16 \) \
  \( -clone 0 -resize 24x24 \) \
  \( -clone 0 -resize 32x32 \) \
  \( -clone 0 -resize 48x48 \) \
  \( -clone 0 -resize 64x64 \) \
  \( -clone 0 -resize 128x128 \) \
  \( -clone 0 -resize 256x256 \) \
  -delete 0 "$RES/icon.ico"
# macOS 源图：electron-builder 用 icon-tool 转 icns，要求 1024x1024 且必须 8-bit
# （icon.png 是 16-bit，转 icns 会被拒），故单独出一份
IM -background none "$SVG_ROUND" -resize 1024x1024 -depth 8 PNG32:"$RES/icon-mac.png"

echo "== Android mipmap =="
for d in "${DENSITIES[@]}"; do
  size=${ICON_SIZE[$d]}
  fg=$(( size * 225 / 100 ))   # foreground = launcher * 2.25 (108dp/48dp)
  dir="$ANDROID_RES/mipmap-$d"
  IM -background none "$SVG_FULL" -resize "${size}x${size}" "$dir/ic_launcher.png"
  IM -background none "$SVG_FULL" -resize "${size}x${size}" "$dir/ic_launcher_round.png"
  IM -background none "$SVG_FULL" -resize "${fg}x${fg}" "$dir/ic_launcher_foreground.png"
  echo "  $d: ${size}px / foreground ${fg}px"
done
# adaptive icon 背景色 = 夜空底色
sed -i 's|#FFFFFF|#0A1128|' "$ANDROID_RES/values/ic_launcher_background.xml"

echo "== Android 启动图 =="
gen_splash() { # $1 = 目标文件, $2 = WxH
  local out=$1 wh=$2
  local -a geom
  read -r -a geom <<<"$(splash_geom "$wh")"
  local w=${geom[0]} h=${geom[1]} icon=${geom[2]}
  # 底色铺满 + 品牌图形居中：与窗口背景同色，冷启动到首帧之间看不到色块跳变。
  # PNG24（无 alpha）体积更小，启动时解码更快。
  IM -background "$SPLASH_BG" "$SVG_ROUND" \
    -resize "${icon}x${icon}" -gravity center -extent "${w}x${h}" PNG24:"$out"
}
for d in "${DENSITIES[@]}"; do
  gen_splash "$ANDROID_RES/drawable-port-$d/splash.png" "${SPLASH_PORT[$d]}"
  gen_splash "$ANDROID_RES/drawable-land-$d/splash.png" "${SPLASH_LAND[$d]}"
  echo "  $d: port ${SPLASH_PORT[$d]} / land ${SPLASH_LAND[$d]}"
done
gen_splash "$ANDROID_RES/drawable/splash.png" "$SPLASH_FALLBACK"

echo "== Web favicon =="
mkdir -p "$APP_PUBLIC"
cp "$SVG_ROUND" "$APP_PUBLIC/favicon.svg"

echo
echo "完成。校验一遍：bash scripts/generate-icons.sh --check"
