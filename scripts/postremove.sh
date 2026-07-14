#!/bin/sh
APP_NAME="Aurora-Music"
rm -f "/usr/local/bin/$APP_NAME"
rm -f "/usr/local/bin/aurora-music"
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -f /usr/share/icons/hicolor 2>/dev/null || true
fi
