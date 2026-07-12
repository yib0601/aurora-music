#!/bin/sh
# 安装后脚本 - 使用 sh 而非 bash 以兼容 RPM

APP_NAME="Aurora-Music"

# 创建符号链接
if [ -f "/opt/$APP_NAME/$APP_NAME" ]; then
    ln -sf "/opt/$APP_NAME/$APP_NAME" "/usr/local/bin/$APP_NAME"
    ln -sf "/opt/$APP_NAME/$APP_NAME" "/usr/local/bin/aurora-music"
    chmod +x "/opt/$APP_NAME/$APP_NAME"
fi

# 更新图标缓存
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -f /usr/share/icons/hicolor 2>/dev/null || true
fi

echo "Aurora Music 安装成功！"
echo "启动命令: $APP_NAME 或 aurora-music"
