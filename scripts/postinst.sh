#!/bin/sh
APP_NAME="Aurora-Music"
if [ -f "/opt/$APP_NAME/$APP_NAME" ]; then
    ln -sf "/opt/$APP_NAME/$APP_NAME" "/usr/local/bin/$APP_NAME"
    ln -sf "/opt/$APP_NAME/$APP_NAME" "/usr/local/bin/aurora-music"
    chmod +x "/opt/$APP_NAME/$APP_NAME"
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -f /usr/share/icons/hicolor 2>/dev/null || true
fi
echo "Aurora Music 安装成功！"
echo "启动命令: $APP_NAME 或 aurora-music"
