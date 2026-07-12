#!/bin/bash
set -e

# 配置变量
APP_NAME="Aurora-Music"
DESKTOP_DIR="packages/desktop"
APP_DIR="packages/app"
SOURCE_DIR="$DESKTOP_DIR/release/linux-unpacked"
OUTPUT_DIR="$DESKTOP_DIR/release"
HASH_FILE=".build-cache"

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_step() { echo -e "${BLUE}▶ $1${NC}"; }
print_ok()   { echo -e "${GREEN}✓ $1${NC}"; }
print_skip() { echo -e "${YELLOW}⊘ $1${NC}"; }

# 解析参数
SKIP_VITE=false
SKIP_TSC=false
SKIP_ELECTRON=false
SKIP_RPM=false
FORCE=false

for arg in "$@"; do
  case $arg in
    --skip-vite)     SKIP_VITE=true ;;
    --skip-tsc)      SKIP_TSC=true ;;
    --skip-electron) SKIP_ELECTRON=true ;;
    --skip-rpm)      SKIP_RPM=true ;;
    --force)         FORCE=true ;;
    --fast)
      # 快速模式：只重建前端和主进程，不重新打包 electron
      SKIP_ELECTRON=true
      SKIP_RPM=true
      ;;
    --help)
      echo "用法: bash scripts/build.sh [选项]"
      echo ""
      echo "选项:"
      echo "  --skip-vite       跳过前端构建"
      echo "  --skip-tsc        跳过 TypeScript 编译"
      echo "  --skip-electron   跳过 electron-builder 打包"
      echo "  --skip-rpm        跳过 RPM 打包"
      echo "  --fast            仅重建前端+主进程，跳过 electron-builder 和 RPM（用于快速验证代码）"
      echo "  --force           强制重建所有步骤"
      echo "  --help            显示帮助"
      exit 0
      ;;
  esac
done

cd "$(dirname "$0")/.."

# 检查文件是否变更：返回 0=未变更(可跳过)，1=已变更(需重建)
needs_rebuild() {
  local hash_key="$1"
  local hash_value="$2"
  local artifact="$3"  # 产物路径，不存在则必须重建

  if [ "$FORCE" = true ]; then
    return 1
  fi

  if [ ! -e "$artifact" ]; then
    return 1
  fi

  local old_hash=$(grep "^$hash_key=" "$HASH_FILE" 2>/dev/null | cut -d'=' -f2-)
  if [ "$old_hash" = "$hash_value" ]; then
    return 0  # 未变更
  fi
  return 1  # 已变更
}

save_hash() {
  local hash_key="$1"
  local hash_value="$2"
  if [ -f "$HASH_FILE" ]; then
    sed -i "/^$hash_key=/d" "$HASH_FILE" 2>/dev/null || true
  fi
  echo "$hash_key=$hash_value" >> "$HASH_FILE"
}

# ============ Step 1: 前端构建 (vite) ============
print_step "检查前端源码..."
FRONTEND_HASH=$(find $APP_DIR/src -type f \( -name "*.tsx" -o -name "*.ts" -o -name "*.css" -o -name "*.html" \) 2>/dev/null | sort | xargs cat 2>/dev/null | sha256sum | cut -d' ' -f1)

if [ "$SKIP_VITE" = true ]; then
  print_skip "前端构建 (手动跳过)"
elif needs_rebuild "frontend" "$FRONTEND_HASH" "$DESKTOP_DIR/app-dist/index.html"; then
  print_skip "前端构建 (无变更)"
  SKIP_VITE=true
else
  print_step "构建前端 (vite)..."
  (cd $APP_DIR && npx vite build)
  print_ok "前端构建完成"
fi
save_hash "frontend" "$FRONTEND_HASH"

# ============ Step 2: 复制前端产物到 desktop ============
if [ "$SKIP_VITE" = false ] || [ ! -d "$DESKTOP_DIR/app-dist" ]; then
  print_step "同步前端产物到 desktop/app-dist..."
  rm -rf $DESKTOP_DIR/app-dist
  cp -r $APP_DIR/dist $DESKTOP_DIR/app-dist
  print_ok "前端产物已同步"
else
  print_skip "同步前端产物 (无变更)"
fi

# ============ Step 3: TypeScript 编译 (Electron 主进程) ============
print_step "检查 Electron 主进程源码..."
ELECTRON_SRC_HASH=$(find $DESKTOP_DIR/src -type f -name "*.ts" 2>/dev/null | sort | xargs cat 2>/dev/null | sha256sum | cut -d' ' -f1)
ELECTRON_TS_HASH="${ELECTRON_SRC_HASH}_$(cat $DESKTOP_DIR/tsconfig.electron.json 2>/dev/null | sha256sum | cut -d' ' -f1)"

if [ "$SKIP_TSC" = true ]; then
  print_skip "TypeScript 编译 (手动跳过)"
elif needs_rebuild "electron_ts" "$ELECTRON_TS_HASH" "$DESKTOP_DIR/dist-electron/main.js"; then
  print_skip "TypeScript 编译 (无变更)"
else
  print_step "编译 TypeScript (Electron 主进程)..."
  (cd $DESKTOP_DIR && npx tsc -p tsconfig.electron.json)
  print_ok "TypeScript 编译完成"
fi
save_hash "electron_ts" "$ELECTRON_TS_HASH"

# 快速模式到此结束
if [ "$SKIP_ELECTRON" = true ] && [ "$SKIP_RPM" = true ]; then
  echo ""
  print_ok "快速构建完成（跳过 electron-builder 和 RPM 打包）"
  exit 0
fi

# ============ Step 4: electron-builder 打包 ============
if [ "$SKIP_ELECTRON" = true ]; then
  print_skip "electron-builder (手动跳过)"
else
  print_step "检查构建产物..."
  DIST_HASH=$(find $DESKTOP_DIR/dist-electron $DESKTOP_DIR/app-dist -type f 2>/dev/null | sort | xargs cat 2>/dev/null | sha256sum | cut -d' ' -f1)

  if needs_rebuild "electron_build" "$DIST_HASH" "$SOURCE_DIR/Aurora-Music"; then
    print_skip "electron-builder (无变更)"
  else
    print_step "运行 electron-builder..."
    # 禁用代理避免下载失败，使用本地缓存
    export ELECTRON_CACHE="${ELECTRON_CACHE:-$HOME/.cache/electron}"
    (cd $DESKTOP_DIR && unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy && npx electron-builder --dir)
    print_ok "electron-builder 打包完成"
  fi
  save_hash "electron_build" "$DIST_HASH"
fi

if [ "$SKIP_RPM" = true ]; then
  echo ""
  print_ok "构建完成（跳过 RPM 打包）"
  echo "产物目录: $SOURCE_DIR"
  exit 0
fi

# ============ Step 5: RPM 打包 ============
print_step "打包 RPM..."
bash build-rpm.sh
print_ok "RPM 打包完成"

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  构建全部完成！${NC}"
echo -e "${GREEN}========================================${NC}"
VERSION=$(grep '"version"' packages/desktop/package.json | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')
echo "RPM 包: $OUTPUT_DIR/$APP_NAME-$VERSION-1.x86_64.rpm"
echo ""
echo "安装命令: sudo rpm -Uvh --force --nodeps $OUTPUT_DIR/$APP_NAME-$VERSION-1.x86_64.rpm"
