#!/bin/bash
set -e

# 配置变量
VERSION=$(grep '"version"' packages/desktop/package.json | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')
APP_NAME="Aurora-Music"
SOURCE_DIR="packages/desktop/release/linux-unpacked"
OUTPUT_DIR="packages/desktop/release"

# 检查源目录是否存在
if [ ! -d "$SOURCE_DIR" ]; then
    echo "错误: 未找到构建目录 $SOURCE_DIR"
    echo "请先运行: pnpm build:desktop (electron-builder 会构建 linux-unpacked)"
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
echo "源目录: $SOURCE_DIR"
echo "输出目录: $OUTPUT_DIR"

# 使用 fpm 打包 (Ubuntu 原生 deb 格式)
# 注意：依赖项用 Ubuntu 实际包名（libxtst6/libuuid1 等带数字后缀）
fpm -s dir -t deb \
  -n "$APP_NAME" \
  -v "$VERSION" \
  --architecture amd64 \
  --description "Aurora Music - 跨平台优雅音乐播放器" \
  --url "https://github.com/aurora-music/aurora-music" \
  --vendor "Aurora Music" \
  --maintainer "Aurora Music <aurora-music@example.com>" \
  --license "MIT" \
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
DEB_FILE="aurora-music_${VERSION}_amd64.deb"
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
