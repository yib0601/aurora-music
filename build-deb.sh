#!/bin/bash
set -e

# 配置变量
VERSION=$(grep '"version"' packages/desktop/package.json | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')
APP_NAME="Aurora-Music"
OUTPUT_DIR="packages/desktop/release"

# 目标架构：x64（默认，本机）/ arm64。
# 三个值必须一一对应，任一错位都会产出「名字对、内容是另一架构」的包：
#   EB_ARCH   electron-builder 的架构名（决定 --<arch> 与解包目录名）
#   UNPACKED  electron-builder 的输出目录（x64 省略后缀，其余为 linux-<arch>-unpacked）
#   FPM_ARCH  Debian 架构字段 / 包名后缀（x64 → amd64，arm64 仍叫 arm64）
ARCH="${ARCH:-x64}"
case "$ARCH" in
  x64|amd64)
    EB_ARCH="x64"; UNPACKED="linux-unpacked"; FPM_ARCH="amd64" ;;
  arm64|aarch64)
    EB_ARCH="arm64"; UNPACKED="linux-arm64-unpacked"; FPM_ARCH="arm64" ;;
  *)
    echo "错误: ARCH 只支持 x64 / arm64（收到 $ARCH）"
    exit 1
    ;;
esac

SOURCE_DIR="packages/desktop/release/$UNPACKED"

# 检查源目录是否存在
if [ ! -d "$SOURCE_DIR" ]; then
    echo "错误: 未找到构建目录 $SOURCE_DIR"
    echo "请先运行: pnpm --filter @aurora/desktop exec electron-builder --linux --$EB_ARCH --dir"
    exit 1
fi

# 检查 fpm 是否可用
if ! command -v fpm &> /dev/null; then
    echo "错误: 未找到 fpm 命令"
    echo "请安装: sudo gem install fpm"
    exit 1
fi

echo "开始打包 DEB..."
echo "版本: $VERSION"
echo "架构: $FPM_ARCH (electron-builder: $EB_ARCH)"
echo "源目录: $SOURCE_DIR"
echo "输出目录: $OUTPUT_DIR"

# 使用 fpm 打包 (Ubuntu 原生 deb 格式)
# 注意：依赖项用 Ubuntu 实际包名（libxtst6/libuuid1 等带数字后缀），两个架构下同名。
# 描述字段的本地化：默认（英文）走 --description，中文走 Description-zh_CN 自定义字段。
# 实测 dpkg-deb 接受并保留该字段（`dpkg-deb -f <pkg>.deb Description-zh_CN` 可读回）；
# 但 apt / 软件中心不显示包描述的语言变体——那由仓库的 DDTP 翻译索引或 AppStream
# metainfo 提供。这里保留中文只为包内自描述完整，可读英文仍是唯一默认值。
fpm -s dir -t deb \
  -n "$APP_NAME" \
  -v "$VERSION" \
  --architecture "$FPM_ARCH" \
  --description "Aurora Music - Cross-platform music player" \
  --deb-field "Description-zh_CN: Aurora Music - 跨平台音乐播放器" \
  --url "https://github.com/aurora-music/aurora-music" \
  --vendor "Aurora Music" \
  --maintainer "Aurora Music <aurora-music@example.com>" \
  --license "PolyForm-Noncommercial-1.0.0" \
  --category "sound" \
  --depends "libxtst6" \
  --depends "libuuid1" \
  --depends "at-spi2-core" \
  --depends "libgtk-3-0" \
  --depends "libxss1" \
  --depends "libnotify4" \
  --depends "libnss3" \
  --depends "xdg-utils" \
  --after-install scripts/postinst.sh \
  --after-remove scripts/postremove.sh \
  "$SOURCE_DIR/=/opt/$APP_NAME" \
  "packages/desktop/resources/$APP_NAME.desktop=/usr/share/applications/$APP_NAME.desktop" \
  "packages/desktop/resources/icon.png=/usr/share/icons/hicolor/512x512/apps/$APP_NAME.png"

# 移动 DEB 文件到输出目录
# fpm 会自动把包名转成小写以符合 Debian 规范
DEB_FILE="aurora-music_${VERSION}_${FPM_ARCH}.deb"
if [ -f "$DEB_FILE" ]; then
    mv "$DEB_FILE" "$OUTPUT_DIR/"
    echo ""
    echo "打包成功！"
    echo "DEB 包位置: $OUTPUT_DIR/$DEB_FILE"
    echo ""
    echo "安装命令: sudo dpkg -i $OUTPUT_DIR/$DEB_FILE"
else
    echo "错误: 未找到生成的 DEB 文件"
    exit 1
fi
