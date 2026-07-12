#!/bin/sh
# 卸载后脚本 - 使用 sh 而非 bash 以兼容 RPM

APP_NAME="Aurora-Music"

# 删除符号链接
rm -f "/usr/local/bin/$APP_NAME"
rm -f "/usr/local/bin/aurora-music"

# 更新图标缓存
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -f /usr/share/icons/hicolor 2>/dev/null || true
fi
