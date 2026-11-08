#!/usr/bin/env bash
# 从 SVG 源生成全平台品牌资源：桌面图标、Android 应用图标与启动图、web favicon。
#
#   bash scripts/generate-icons.sh          生成全部派生资源
#   bash scripts/generate-icons.sh --check  只校验派生资源是否与 SVG 源同代（CI / 发布前用）
#
# 为什么开屏图形也归这里管：res/drawable-*/splash_logo.png 是启动画面里那块品
# 牌图形，与 mipmap、桌面图标一样都是从品牌 SVG 派生的位图。派生资源各自为政
# 过一次（车机开屏长期停在 Capacitor 模板白底图上，全靠人肉发现），所以统一收
# 口到本脚本，`--check` 就是防止下次再漏一处的闸门（CI 的 android job 会跑它）。
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

# 启动画面里的品牌图形：正方形，边长 192dp —— 与 Android 12 系统启动画面
# （windowSplashScreenAnimatedIcon 可见区 192dp）同尺寸；车机 hdpi 落在 800~1280px
# 宽的竖屏上约占 29%~22%。
#
# 只出正方形、只出这一块图形，不出口「整屏位图」：整屏 png 会被框架按窗口尺寸
# 拉伸，位图宽高比固定（10:16）而车机屏宽高比五花八门（竖屏实测 0.69），牌子就
# 被横着拉宽约 1.3 倍（2026-11 车机实拍 280x208 的图形，本该 1:1）。窗口背景改
# 由 res/drawable/splash.xml 的 layer-list 拼：纯色底 + 居中本图，layer-list 每层
# 按自己的尺寸绘制，与屏幕宽高比再无关系。
SPLASH_LOGO_DP=192
declare -A SPLASH_LOGO=( [mdpi]=192 [hdpi]=288 [xhdpi]=384 [xxhdpi]=576 [xxxhdpi]=768 )

declare -A ICON_SIZE=( [mdpi]=48 [hdpi]=72 [xhdpi]=96 [xxhdpi]=144 [xxxhdpi]=192 )
DENSITIES=(mdpi hdpi xhdpi xxhdpi xxxhdpi)

CHECK=0
[[ "${1:-}" == "--check" ]] && CHECK=1

FAILURES=0
pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
info() { printf '  %s\n' "$1"; }

rel() { printf '%s' "${1#"$ROOT"/}"; }

# ─────────────────────────── 校验模式 ───────────────────────────
if [[ $CHECK -eq 1 ]]; then
  command -v identify >/dev/null || { echo "需要 ImageMagick（identify）"; exit 1; }

  echo "== 品牌资源校验 =="

  # 1) 启动画面：窗口背景 splash.xml（layer-list）+ 各密度正方形图形 splash_logo.png。
  #    这两样是「开屏不随屏幕宽高比变形」的唯一保证：图形在 layer-list 里走
  #    <bitmap gravity="center">，按自身像素居中绘制、不参与窗口尺寸缩放；谁要是
  #    又塞回整屏 png 当窗口背景，图形立刻重新被拉伸，所以下面几条都硬卡。
  splash_xml="$ANDROID_RES/drawable/splash.xml"
  if [[ ! -f "$splash_xml" ]]; then
    fail "缺少 $(rel "$splash_xml")"
  else
    xml_ok=1
    grep -q '@color/aurora_window_bg' "$splash_xml" \
      || { fail "$(rel "$splash_xml") 未引用 @color/aurora_window_bg（底色须与窗口同源）"; xml_ok=0; }
    grep -q '@drawable/splash_logo' "$splash_xml" \
      || { fail "$(rel "$splash_xml") 未引用 @drawable/splash_logo"; xml_ok=0; }
    grep -q 'android:gravity="center"' "$splash_xml" \
      || { fail "$(rel "$splash_xml") 图形未居中（缺 android:gravity=\"center\"）"; xml_ok=0; }
    [[ $xml_ok -eq 1 ]] && pass "$(rel "$splash_xml") layer-list"
  fi

  leftover=$(find "$ANDROID_RES" -name 'splash.png' | sort)
  if [[ -n "$leftover" ]]; then
    fail "res 下仍有整屏启动图（会被按窗口尺寸拉伸，改用 drawable/splash.xml）：$(echo "$leftover" | tr '\n' ' ')"
  fi

  #    图形本身：正方形 + 尺寸对着密度档位 + 不是 Capacitor 模板白底图
  #    （白底均值≈1.0，品牌图是深底 + 亮带，均值明显更低）。
  check_splash_logo() {
    local out=$1 size=$2
    if [[ ! -f "$out" ]]; then fail "缺少 $(rel "$out")"; return; fi
    local dims
    dims=$(identify -format '%wx%h' "$out")
    if [[ "$dims" != "${size}x${size}" ]]; then
      fail "$(rel "$out") 尺寸 $dims，期望正方形 ${size}x${size}"
      return
    fi
    local mean
    mean=$(identify -format '%[fx:mean]' "$out")
    if awk -v m="$mean" 'BEGIN{exit !(m > 0.8)}'; then
      fail "$(rel "$out") 近似纯白——疑为 Capacitor 模板图形"
      return
    fi
    pass "$(rel "$out") ${size}x${size}"
  }
  for d in "${DENSITIES[@]}"; do
    check_splash_logo "$ANDROID_RES/drawable-$d/splash_logo.png" "${SPLASH_LOGO[$d]}"
  done

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

  # 3b) 渲染层不得用**根相对**路径引用 public/ 资源。
  #     生产端 Electron 是 loadFile() + file://，`/favicon.svg` 会被解析成
  #     file:///favicon.svg（文件系统根）→ 静默裂图。0.7.4 打包版侧边栏品牌图
  #     就是这么坏的，而 dev（http://localhost:5173）永远看不出来。
  #     一律走 lib/assetUrl.ts 按 vite base 拼地址。
  #     只扫 src 下的源码，不扫产物（产物里的地址已由 vite 处理成相对路径）。
  bad_abs=$(grep -rnE \
    "(src|href)=\"/[^\"]*\.(svg|png|jpe?g|webp|gif|ico)|url\(['\"]?/[^)]*\.(svg|png|jpe?g|webp|gif|ico)" \
    "$ROOT/packages/app/src" 2>/dev/null || true)
  if [[ -z "$bad_abs" ]]; then
    pass "packages/app/src 无根相对 public 资源引用（file:// 下不会裂图）"
  else
    fail "packages/app/src 存在根相对 public 资源引用（file:// 打包后必然裂图，改用 lib/assetUrl.ts）："
    printf '%s\n' "$bad_abs" | sed 's/^/        /'
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

echo "== Android 启动画面图形 =="
# 正方形、保留 alpha：圆角外露出的透明角由 drawable/splash.xml 的纯色底层补上。
for d in "${DENSITIES[@]}"; do
  size=${SPLASH_LOGO[$d]}
  mkdir -p "$ANDROID_RES/drawable-$d"
  IM -background none "$SVG_ROUND" -resize "${size}x${size}" PNG32:"$ANDROID_RES/drawable-$d/splash_logo.png"
  echo "  $d: ${size}px"
done

echo "== Web favicon =="
mkdir -p "$APP_PUBLIC"
cp "$SVG_ROUND" "$APP_PUBLIC/favicon.svg"

echo
echo "完成。校验一遍：bash scripts/generate-icons.sh --check"
