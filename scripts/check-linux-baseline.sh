#!/usr/bin/env bash
# 校验 Linux 产物引用的 glibc / libstdc++ 符号不超过基线。
#
# 背景：AppImage 目录（appimage.github.io）在 ubuntu-22.04（glibc 2.35、
# libstdc++ 6.0.30）上逐个测试上传的包，Debian 12 用户是 glibc 2.36。原生模块
# 只要是在更新的系统上编译的，产物就会带上那台机器的符号：better-sqlite3 在
# Ubuntu 24.04 上编译后需要 GLIBC_2.38 与 GLIBCXX_3.4.31，在老系统上 dlopen
# 直接失败——
#   Error: /lib/x86_64-linux-gnu/libm.so.6: version `GLIBC_2.38' not found
# 主进程随即异常，界面起不来。本脚本在打包后把关，把这类问题挡在发布之前。
#
# 用法:
#   bash scripts/check-linux-baseline.sh <包文件...>
#   包可以是 .AppImage / .deb / .rpm，也可以是已解包的目录（如 linux-unpacked）
#
# 环境变量:
#   GLIBC_BASELINE    默认 2.35   （Ubuntu 22.04，AppImage 目录的测试机）
#   GLIBCXX_BASELINE  默认 3.4.30 （同上，libstdc++ 6.0.30）
#   EXPECTED_ARCH     可选：x64 / arm64（也接受 amd64 / x86_64 / aarch64）。
#                     设定后额外断言包内主程序与 better-sqlite3 原生模块的 ELF
#                     e_machine 与之一致。交叉打包时真的会产出「文件名写 arm64、
#                     内容却是 x86-64」的包（electron-builder 的 target.arch 与
#                     命令行 --arm64 打架时），发出去用户拿到的是装不上的包，
#                     所以发布前必须在同一道闸门里卡住。
#
# 退出码: 0 = 全部达标；1 = 存在超基线符号、架构不符或解包失败
set -euo pipefail

GLIBC_BASELINE="${GLIBC_BASELINE:-2.35}"
GLIBCXX_BASELINE="${GLIBCXX_BASELINE:-3.4.30}"

# 期望架构归一化成 electron-builder 的命名（x64 / arm64）
EXPECTED_ARCH="${EXPECTED_ARCH:-}"
case "$EXPECTED_ARCH" in
  x64|amd64|x86_64) EXPECTED_ARCH="x64" ;;
  arm64|aarch64)    EXPECTED_ARCH="arm64" ;;
  '') ;;
  *)
    echo "错误: EXPECTED_ARCH 只支持 x64 / arm64（收到 $EXPECTED_ARCH）" >&2
    exit 2
    ;;
esac

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

if [ $# -lt 1 ]; then
  echo "用法: bash scripts/check-linux-baseline.sh <包文件或已解包目录...>" >&2
  echo "      GLIBC_BASELINE=2.35 GLIBCXX_BASELINE=3.4.30 可覆盖基线" >&2
  echo "      EXPECTED_ARCH=x64|arm64 额外断言产物架构（发布前必填）" >&2
  exit 2
fi

command -v objdump >/dev/null || { echo "缺少 objdump（binutils），请先安装" >&2; exit 2; }

# 统一转成绝对路径：解包函数内部会 cd 进临时目录，相对路径在那之后就失效了
abs_args=()
for arg in "$@"; do
  if abs="$(realpath "$arg" 2>/dev/null)"; then abs_args+=("$abs"); else abs_args+=("$arg"); fi
done
set -- "${abs_args[@]}"

# $1 > $2 ？按版本序比较
ver_gt() {
  [ -n "$1" ] && [ "$1" != "$2" ] &&
    [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | tail -n 1)" = "$1" ]
}

is_elf() {
  [ "$(od -An -N4 -tx1 "$1" 2>/dev/null | tr -d ' \n')" = "7f454c46" ]
}

# ELF e_machine（偏移 18，2 字节，大小端与本机一致：x86-64 / aarch64 都是小端）
elf_arch() { # $1=文件 → x64 / arm64 / ia32 / unknown(...)
  local m
  m="$(od -An -j18 -N2 -tu2 "$1" 2>/dev/null | tr -d ' \n')"
  case "$m" in
    62)  echo "x64" ;;
    183) echo "arm64" ;;
    3)   echo "ia32" ;;
    *)   echo "unknown(${m:-?})" ;;
  esac
}

# 架构断言的目标文件：主程序 + better-sqlite3 原生模块。
# 只查这两个而不是「包里所有 ELF」—— 后者会被 Electron 自带的辅助二进制、
# 第三方 .node 等无关文件误伤（它们本来就不该出现在本项目的包里）。
arch_targets() { # $1=解包根目录
  find "$1" -type f \( -name 'Aurora-Music' -o -name 'better_sqlite3.node' \) -print0 2>/dev/null
}

extract_pkg() { # $1=包文件 $2=目标目录
  local pkg="$1" dest="$2" tmp data
  case "$pkg" in
    *.AppImage|*.appimage)
      tmp="$(mktemp -d)"
      cp "$pkg" "$tmp/pkg.AppImage"
      chmod +x "$tmp/pkg.AppImage"
      # --appimage-extract 用内置运行时解压，不需要 FUSE
      ( cd "$dest" && "$tmp/pkg.AppImage" --appimage-extract >/dev/null 2>&1 ) || true
      rm -rf "$tmp"
      if [ -d "$dest/squashfs-root" ]; then
        shopt -s dotglob
        mv "$dest/squashfs-root"/* "$dest"/ 2>/dev/null || true
        shopt -u dotglob
        rmdir "$dest/squashfs-root" 2>/dev/null || true
      fi
      [ -x "$dest/AppRun" ] || [ -d "$dest/resources" ] || return 1
      ;;
    *.deb)
      ( cd "$dest" && ar x "$pkg" ) >/dev/null 2>&1 || return 1
      data=""
      for data in "$dest"/data.tar.*; do [ -e "$data" ] && break; done
      [ -e "$data" ] || return 1
      tar -xf "$data" -C "$dest" || return 1
      ;;
    *.rpm)
      command -v rpm2cpio >/dev/null || { echo "缺少 rpm2cpio，无法检查 rpm" >&2; return 1; }
      ( cd "$dest" && rpm2cpio "$pkg" | cpio -idmu --quiet ) || return 1
      ;;
    *)
      mkdir -p "$dest/x"
      cp "$pkg" "$dest/x/" 2>/dev/null || return 1
      ;;
  esac
  return 0
}

# 输出 "相对路径 版本" 行：只统计未定义符号，即运行时真正从系统要的版本
scan_dir() { # $1=解包根目录
  local root="$1" f
  while IFS= read -r -d '' f; do
    is_elf "$f" || continue
    objdump -T "$f" 2>/dev/null | grep '\*UND\*' \
      | grep -oE '(GLIBCXX|GLIBC)_[0-9]+(\.[0-9]+)+' \
      | sed "s|^|${f#"$root"/} |"
  done < <(find "$root" -type f -size +1k -print0 2>/dev/null)
}

max_ver() { # $1=rows $2=GLIBC|GLIBCXX
  printf '%s\n' "$1" | awk -v p="$2" '$2 ~ "^" p "_" { print $2 }' \
    | sed "s/^${2}_//" | sort -uV | tail -n 1
}

bad_rows() { # $1=rows $2=GLIBC|GLIBCXX $3=基线  → "路径 版本"
  local rows="$1" prefix="$2" base="$3" v bad="" b
  while IFS= read -r v; do
    [ -n "$v" ] || continue
    ver_gt "$v" "$base" && bad="$bad $v"
  done < <(printf '%s\n' "$rows" | awk -v p="$prefix" '$2 ~ "^" p "_" { print $2 }' | sed "s/^${prefix}_//" | sort -uV)
  [ -n "$bad" ] || return 0
  while read -r p v; do
    for b in $bad; do
      [ "$v" = "${prefix}_$b" ] && echo "$p $b" && break
    done
  done <<< "$rows"
}

check_one() { # $1=包路径或目录
  local pkg="$1" dest="" rows="" rc=0 bad_glibc="" bad_glibcxx="" g="" gx="" p v
  local arch_report="" arch_bad=0 f got

  if [ -d "$pkg" ]; then
    dest="$pkg"
  else
    dest="$(mktemp -d)"
    if ! extract_pkg "$pkg" "$dest"; then
      echo -e "${RED}✗ 无法解包：$pkg${NC}" >&2
      rm -rf "$dest"
      return 1
    fi
  fi

  if [ -n "$EXPECTED_ARCH" ]; then
    while IFS= read -r -d '' f; do
      got="$(elf_arch "$f")"
      arch_report="$arch_report $(basename "$f")=$got"
      if [ "$got" != "$EXPECTED_ARCH" ]; then
        echo -e "${RED}✗ 架构不符（期望 $EXPECTED_ARCH，实际 $got）：${f#"$dest"/}${NC}" >&2
        arch_bad=1
      fi
    done < <(arch_targets "$dest")
    if [ -z "$arch_report" ]; then
      echo -e "${RED}✗ 包内找不到可断言的 ELF（Aurora-Music / better_sqlite3.node）：$pkg${NC}" >&2
      arch_bad=1
    fi
    [ $arch_bad -eq 0 ] || rc=1
  fi

  rows="$(scan_dir "$dest" | sort -u || true)"
  g="$(max_ver "$rows" GLIBC)"
  gx="$(max_ver "$rows" GLIBCXX)"
  bad_glibc="$(bad_rows "$rows" GLIBC "$GLIBC_BASELINE")"
  bad_glibcxx="$(bad_rows "$rows" GLIBCXX "$GLIBCXX_BASELINE")"

  echo -e "${BLUE}== $(basename "$pkg") ==${NC}"
  if [ -n "$EXPECTED_ARCH" ]; then
    if [ $arch_bad -eq 0 ]; then
      echo -e "   架构：${GREEN}✓${NC} 全部为 $EXPECTED_ARCH（$arch_report ）"
    else
      echo -e "   架构：${RED}✗${NC} 期望 $EXPECTED_ARCH（$arch_report ）"
    fi
  fi
  echo "   最高需求：GLIBC ${g:-无}（基线 $GLIBC_BASELINE） / GLIBCXX ${gx:-无}（基线 $GLIBCXX_BASELINE）"

  if [ -z "$rows" ]; then
    # 常见于「在 x64 机器上检查 arm64 包」：本机 objdump 没有该架构后端，
    # 读不出符号表，此时静默判通过等于放过一条没被验证的产物。
    echo -e "   ${YELLOW}⚠ 未读到任何 GLIBC/GLIBCXX 符号：本机 objdump 可能不支持该 ELF 架构。"
    echo -e "   符号基线未经验证，请在该架构的机器/容器（release.yml 的对应 job）上复查。${NC}"
  fi

  if [ -n "$bad_glibc" ] || [ -n "$bad_glibcxx" ]; then
    rc=1
    while read -r p v; do
      [ -n "$p" ] && echo -e "   ${RED}✗ GLIBC_$v 超出基线：$p${NC}"
    done <<< "$bad_glibc"
    while read -r p v; do
      [ -n "$p" ] && echo -e "   ${RED}✗ GLIBCXX_$v 超出基线：$p${NC}"
    done <<< "$bad_glibcxx"
    echo -e "   ${YELLOW}原生模块必须在基线系统里编译（见 .github/workflows/release.yml 的"
    echo -e "   build-linux-x64 容器 / build-linux-arm64 runner），或在更老的系统上构建后重新打包。${NC}"
  else
    echo -e "   ${GREEN}✓ 全部落在基线内${NC}"
  fi

  if [ -n "$dest" ] && [ ! -d "$pkg" ]; then
    rm -rf "$dest"
  fi
  return $rc
}

rc=0
for pkg in "$@"; do
  check_one "$pkg" || rc=1
  echo
done

if [ $rc -eq 0 ]; then
  echo -e "${GREEN}基线检查通过：这些包可在 Ubuntu 22.04 / Debian 12 及以上运行${NC}"
else
  echo -e "${RED}基线检查失败：上面列出的文件会让老系统（含 AppImage 目录测试机）加载失败${NC}"
fi
exit $rc
