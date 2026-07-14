#!/bin/bash
set -e

VERSION="0.1.2"
APP_NAME="Aurora-Music"
SOURCE_DIR="packages/desktop/release/linux-unpacked"
OUTPUT_DIR="packages/desktop/release"

if [ ! -d "$SOURCE_DIR" ]; then
    echo "错误: 未找到构建目录 $SOURCE_DIR"
    echo "请先运行: cd packages/desktop && pnpm run build:dir"
    exit 1
fi

if ! command -v fpm &> /dev/null; then
    echo "错误: 未找到 fpm 命令，请安装: sudo gem install fpm"
    exit 1
fi

echo "开始打包 RPM..."
echo "版本: $VERSION"
echo "源目录: $SOURCE_DIR"

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
  --rpm-digest sha256 \
  --after-install scripts/postinst.sh \
  --after-remove scripts/postremove.sh \
  "$SOURCE_DIR/=/opt/$APP_NAME" \
  "packages/desktop/resources/$APP_NAME.desktop=/usr/share/applications/$APP_NAME.desktop" \
  "packages/desktop/resources/icon.png=/usr/share/icons/hicolor/512x512/apps/$APP_NAME.png"

if [ -f "$APP_NAME-$VERSION-1.x86_64.rpm" ]; then
    mv "$APP_NAME-$VERSION-1.x86_64.rpm" "$OUTPUT_DIR/"
    echo ""
    echo "打包成功！"
    echo "RPM 包位置: $OUTPUT_DIR/$APP_NAME-$VERSION-1.x86_64.rpm"
else
    echo "错误: 未找到生成的 RPM 文件"
    exit 1
fi
