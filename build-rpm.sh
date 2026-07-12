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
    echo "请先运行: cd packages/desktop && pnpm run build:dir"
    exit 1
fi

# 检查 fpm 是否可用
if ! command -v fpm &> /dev/null; then
    echo "错误: 未找到 fpm 命令"
    echo "请安装: sudo gem install fpm"
    exit 1
fi

echo "开始打包 RPM..."
echo "版本: $VERSION"
echo "源目录: $SOURCE_DIR"
echo "输出目录: $OUTPUT_DIR"

# 使用 fpm 打包
fpm -s dir -t rpm \
  -n "$APP_NAME" \
  -v "$VERSION" \
  --architecture x86_64 \
  --description "Aurora Music - 跨平台优雅音乐播放器" \
  --url "https://github.com/aurora-music/aurora-music" \
  --vendor "Aurora Music" \
  --maintainer "Aurora Music <aurora-music@example.com>" \
  --license "MIT" \
  --category "AudioVideo" \
  --depends "libXtst" \
  --depends "libXtst6" \
  --depends "libuuid" \
  --depends "libuuid1" \
  --depends "at-spi2-core" \
  --depends "gtk3" \
  --depends "libXScrnSaver" \
  --depends "libnotify" \
  --depends "nss" \
  --depends "xdg-utils" \
  --rpm-digest sha256 \
  --after-install scripts/postinst.sh \
  --after-remove scripts/postremove.sh \
  "$SOURCE_DIR/=/opt/$APP_NAME" \
  "packages/desktop/resources/$APP_NAME.desktop=/usr/share/applications/$APP_NAME.desktop" \
  "packages/desktop/resources/icon.png=/usr/share/icons/hicolor/512x512/apps/$APP_NAME.png"

# 移动 RPM 文件到输出目录
if [ -f "$APP_NAME-$VERSION-1.x86_64.rpm" ]; then
    mv "$APP_NAME-$VERSION-1.x86_64.rpm" "$OUTPUT_DIR/"
    echo ""
    echo "打包成功！"
    echo "RPM 包位置: $OUTPUT_DIR/$APP_NAME-$VERSION-1.x86_64.rpm"
    echo ""
    echo "安装命令: sudo rpm -Uvh --nodeps $OUTPUT_DIR/$APP_NAME-$VERSION-1.x86_64.rpm"
else
    echo "错误: 未找到生成的 RPM 文件"
    exit 1
fi
