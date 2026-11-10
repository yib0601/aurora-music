#!/usr/bin/env bash
# 从 SVG 源生成全平台品牌资源：桌面图标、Android 应用图标、web favicon。
#
#   bash scripts/generate-icons.sh          生成全部派生资源
#   bash scripts/generate-icons.sh --check  只校验派生资源是否与 SVG 源同代（CI / 发布前用）
#
# 派生资源各自为政过一次（车机开屏长期停在 Capacitor 模板白底图上，全靠人肉发现），
# 所以统一收口到本脚本，`--check` 就是防止下次再漏一处的闸门（CI 的 android job 会
# 跑它）。
#
# 开屏不画品牌图形，所以这里**不产出** splash_*.png；--check 反过来卡住「有人又把
# 开屏图形位图加回来」——理由见 packages/mobile/android/app/src/main/res/drawable/splash.xml。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RES="$ROOT/packages/desktop/resources"
ANDROID_RES="$ROOT/packages/mobile/android/app/src/main/res"
APP_PUBLIC="$ROOT/packages/app/public"

SVG_ROUND="$RES/icon.svg"        # 圆角版：桌面图标 / web favicon
SVG_FULL="$RES/icon-full.svg"    # 全幅版：Android 自适应图标前景

# 启动图底色。必须与下面两处同值，否则冷启动会看到「启动图 → 窗口背景 → 主界面」
# 三层色块跳变（--check 会把这三处一起卡住）：
#   packages/mobile/android/app/src/main/res/values/colors.xml  (aurora_window_bg)
#   packages/mobile/capacitor.config.ts                         (SplashScreen.backgroundColor)
SPLASH_BG='#0A0A0A'

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

  # 1) 启动画面：**开屏不画品牌图形**（刻意的决定，理由见 drawable/splash.xml）。
  #    窗口背景 splash.xml 只允许纯色 layer-list；res 下不允许再出现任何 splash 位图；
  #    两个启动主题的 windowSplashScreenAnimatedIcon 必须指向全透明的 splash_blank。
  #    这些是反向闸门：图形一旦加回来，Android 12+ 的系统启动画面会把它按「画布 ×1.5」
  #    放大再套设备图标形状遮罩（真机实拍 = 放大 2 倍、四角发尖的方块），要恢复就得连
  #    288dp 画布口径一起改，不能只塞一张 png 进来。
  splash_xml="$ANDROID_RES/drawable/splash.xml"
  if [[ ! -f "$splash_xml" ]]; then
    fail "缺少 $(rel "$splash_xml")"
  else
    xml_ok=1
    grep -q '@color/aurora_window_bg' "$splash_xml" \
      || { fail "$(rel "$splash_xml") 未引用 @color/aurora_window_bg（底色须与窗口同源）"; xml_ok=0; }
    if grep -qE '@drawable/splash_(logo|icon)|<bitmap' "$splash_xml"; then
      fail "$(rel "$splash_xml") 又引用了开屏图形（开屏不放图形，见文件内注释）"; xml_ok=0
    fi
    [[ $xml_ok -eq 1 ]] && pass "$(rel "$splash_xml") 纯色 layer-list（无图形）"
  fi

  leftover=$(find "$ANDROID_RES" -name 'splash*.png' | sort)
  if [[ -n "$leftover" ]]; then
    fail "res 下仍有开屏位图（整屏图会被按窗口尺寸拉伸，居中图形会被系统启动画面放大裁切；开屏不放图形，见 drawable/splash.xml）：$(echo "$leftover" | tr '\n' ' ')"
  fi

  #    透明占位图 + 两个启动主题的指向。缺了 splash_blank 或没指过去，系统就会去画
  #    应用图标（我们那张前景是满幅图形 → 必然被放大裁切）。
  blank="$ANDROID_RES/drawable/splash_blank.xml"
  if [[ ! -f "$blank" ]]; then
    fail "缺少 $(rel "$blank")（windowSplashScreenAnimatedIcon 要用它占位）"
  else
    grep -q '@android:color/transparent' "$blank" \
      || fail "$(rel "$blank") 不是全透明（开屏不放图形）"
  fi

  base_styles="$ANDROID_RES/values/styles.xml"
  v31="$ANDROID_RES/values-v31/styles.xml"
  grep -q 'windowSplashScreenAnimatedIcon">@drawable/splash_blank' "$base_styles" \
    || fail "$(rel "$base_styles") 里 windowSplashScreenAnimatedIcon 未指向 @drawable/splash_blank（漏了会画出应用图标并被放大裁切）"
  if [[ ! -f "$v31" ]]; then
    fail "缺少 $(rel "$v31")（API 31+ 的系统启动画面读平台属性，缺了它开屏会回落到应用图标）"
  else
    grep -q 'android:windowSplashScreenAnimatedIcon">@drawable/splash_blank' "$v31" \
      || fail "$(rel "$v31") 未把 android:windowSplashScreenAnimatedIcon 指向 @drawable/splash_blank"
    grep -q 'android:windowSplashScreenBackground">@color/aurora_window_bg' "$v31" \
      || fail "$(rel "$v31") 未把 android:windowSplashScreenBackground 指向 @color/aurora_window_bg"
    pass "$(rel "$v31") 平台启动画面属性"
  fi

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

echo "== Android 启动画面 =="
# 不产出任何 splash 位图：开屏只铺 colors.xml 的 aurora_window_bg 纯色底，图形一律不画
# （理由见 packages/mobile/android/app/src/main/res/drawable/splash.xml）。历史遗留的
# drawable-*/splash_logo.png、splash_icon.png 一并删掉，别在这里重建。
for d in "${DENSITIES[@]}"; do
  rm -f "$ANDROID_RES/drawable-$d/splash_logo.png" "$ANDROID_RES/drawable-$d/splash_icon.png"
done
echo "  无图形（纯色底），已清理历史 splash_*.png"

echo "== Web favicon =="
mkdir -p "$APP_PUBLIC"
cp "$SVG_ROUND" "$APP_PUBLIC/favicon.svg"

echo
echo "完成。校验一遍：bash scripts/generate-icons.sh --check"
