#!/bin/sh
set -e

# 不注入任何沙箱 / GPU 开关，保持 Chromium 默认（沙箱全开 + 硬件加速）。
# ⚠️ 不要加 --no-sandbox：实测会关闭渲染进程与 GPU 进程沙箱，且可能诱发
#   `GPU process launch failed: error_code=1002` → `FATAL: GPU process isn't usable` 直接退出。
# ⚠️ 不要加 --disable-gpu：实测会把渲染退化为软件路径（首屏 658ms vs 215ms，
#   重度模糊压测慢 3.55 倍）。详见 main.ts 顶部注释。
DESKTOP_FILE=/usr/share/applications/Aurora-Music.desktop

if [ -f "$DESKTOP_FILE" ]; then
  sed -i 's|^Exec=.*%U|Exec=/opt/Aurora-Music/Aurora-Music %U|' "$DESKTOP_FILE"
fi
