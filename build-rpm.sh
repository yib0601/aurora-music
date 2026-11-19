#!/bin/bash
set -e

VERSION=$(grep '"version"' packages/desktop/package.json | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')
APP_NAME="Aurora-Music"
OUTPUT_DIR="packages/desktop/release"

# 目标架构：x64（默认，本机）/ arm64。三个变量必须一一对应，与 build-deb.sh 同一套口径：
#   EB_ARCH   electron-builder 的架构名（--<arch> 与解包目录名）
#   UNPACKED  electron-builder 的输出目录（x64 省略后缀）
#   FPM_ARCH  rpm 架构字段（x64 → x86_64，arm64 → aarch64）
ARCH="${ARCH:-x64}"
case "$ARCH" in
  x64|x86_64|amd64)
    EB_ARCH="x64"; UNPACKED="linux-unpacked"; FPM_ARCH="x86_64" ;;
  arm64|aarch64)
    EB_ARCH="arm64"; UNPACKED="linux-arm64-unpacked"; FPM_ARCH="aarch64" ;;
  *)
    echo "错误: ARCH 只支持 x64 / arm64（收到 $ARCH）"
    exit 1
    ;;
esac

SOURCE_DIR="packages/desktop/release/$UNPACKED"

if [ ! -d "$SOURCE_DIR" ]; then
    echo "错误: 未找到构建目录 $SOURCE_DIR"
    echo "请先运行: pnpm --filter @aurora/desktop exec electron-builder --linux --$EB_ARCH --dir"
    exit 1
fi

if ! command -v fpm &> /dev/null; then
    echo "错误: 未找到 fpm 命令，请安装: sudo gem install fpm"
    exit 1
fi

echo "开始打包 RPM..."
echo "版本: $VERSION"
echo "架构: $FPM_ARCH (electron-builder: $EB_ARCH)"
echo "源目录: $SOURCE_DIR"

# 描述只给英文：fpm 的 rpm 输出没有 i18n 描述通道（--rpm-summary / --description
# 都是单值），桌面软件中心里 rpm 的本地化描述走 AppStream metainfo，不在包头上。
fpm -s dir -t rpm \
  -n "$APP_NAME" \
  -v "$VERSION" \
  --architecture "$FPM_ARCH" \
  --description "Aurora Music - Cross-platform music player" \
  --url "https://github.com/aurora-music/aurora-music" \
  --vendor "Aurora Music" \
  --maintainer "Aurora Music <aurora-music@example.com>" \
  --license "PolyForm-Noncommercial-1.0.0" \
  --category "AudioVideo" \
  --rpm-digest sha256 \
  --after-install scripts/postinst.sh \
  --after-remove scripts/postremove.sh \
  "$SOURCE_DIR/=/opt/$APP_NAME" \
  "packages/desktop/resources/$APP_NAME.desktop=/usr/share/applications/$APP_NAME.desktop" \
  "packages/desktop/resources/icon.png=/usr/share/icons/hicolor/512x512/apps/$APP_NAME.png"

RPM_FILE="$APP_NAME-$VERSION-1.$FPM_ARCH.rpm"
if [ -f "$RPM_FILE" ]; then
    mv "$RPM_FILE" "$OUTPUT_DIR/"
    echo ""
    echo "打包成功！"
    echo "RPM 包位置: $OUTPUT_DIR/$RPM_FILE"
else
    echo "错误: 未找到生成的 RPM 文件"
    exit 1
fi
