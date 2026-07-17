#!/bin/sh
set -e

DESKTOP_FILE=/usr/share/applications/Aurora-Music.desktop

if [ -f "$DESKTOP_FILE" ]; then
  sed -i 's|Exec=/opt/Aurora-Music/Aurora-Music %U|Exec=/opt/Aurora-Music/Aurora-Music --no-sandbox --ozone-platform=x11 --disable-gpu %U|' "$DESKTOP_FILE"
fi
