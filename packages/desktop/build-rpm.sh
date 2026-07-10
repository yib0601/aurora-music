#!/bin/bash
set -e

PKG_NAME="aurora-music"
VERSION="0.1.0"
RELEASE="1"
SRC_DIR="/home/yibin/code/Music/packages/desktop/release/linux-unpacked"
ICON_SRC="/home/yibin/code/Music/packages/desktop/resources/icon.png"
WORKDIR=$(mktemp -d /tmp/rpm-build-XXXXXX)
TOPDIR="$WORKDIR/topdir"
mkdir -p "$TOPDIR"/{BUILD,RPMS,SOURCES,SPECS,SRPMS}

# 准备源 tarball（放到 SOURCES）
SOURCE_STAGE="$WORKDIR/stage"
mkdir -p "$SOURCE_STAGE/app"
cp -a "$SRC_DIR/." "$SOURCE_STAGE/app/"
cp "$ICON_SRC" "$SOURCE_STAGE/icon.png"
cat > "$SOURCE_STAGE/aurora-music.desktop" <<EOF
[Desktop Entry]
Name=Aurora Music
Comment=An elegant cross-platform music player
Exec=/usr/bin/aurora-music %U
Icon=aurora-music
Terminal=false
Type=Application
Categories=AudioVideo;Audio;
EOF

tar czf "$TOPDIR/SOURCES/app.tar.gz" -C "$SOURCE_STAGE" .

# 写 spec
cat > "$TOPDIR/SPECS/$PKG_NAME.spec" <<EOF
Name:           $PKG_NAME
Version:        $VERSION
Release:        $RELEASE%{?dist}
Summary:        Aurora Music - cross-platform elegant music player
License:        MIT
URL:            https://github.com/aurora-music/aurora-music
Vendor:         Aurora Music <aurora-music@example.com>
Packager:       Aurora Music <aurora-music@example.com>
Source0:        app.tar.gz
AutoReqProv:    no
%define debug_package %{nil}
Requires:       gtk3
Requires:       libnotify
Requires:       nss
Requires:       libXScrnSaver
Requires:       libXtst
Requires:       xdg-utils
Requires:       at-spi2-core

%description
Aurora Music - cross-platform elegant music player

%prep
%setup -q -c

%build

%install
mkdir -p "%{buildroot}/opt/Aurora Music"
cp -a app/. "%{buildroot}/opt/Aurora Music/"
mkdir -p "%{buildroot}/usr/bin"
ln -sf "/opt/Aurora Music/@auroradesktop" "%{buildroot}/usr/bin/aurora-music"
mkdir -p "%{buildroot}/usr/share/applications"
install -m 644 aurora-music.desktop "%{buildroot}/usr/share/applications/aurora-music.desktop"
mkdir -p "%{buildroot}/usr/share/icons/hicolor/512x512/apps"
install -m 644 icon.png "%{buildroot}/usr/share/icons/hicolor/512x512/apps/aurora-music.png"

%files
%defattr(-,root,root,-)
"/opt/Aurora Music"
/usr/bin/aurora-music
/usr/share/applications/aurora-music.desktop
/usr/share/icons/hicolor/512x512/apps/aurora-music.png
EOF

echo "=== spec 文件内容 ==="
cat "$TOPDIR/SPECS/$PKG_NAME.spec"
echo "====================="

# 构建
rpmbuild -bb \
  --define "_topdir $TOPDIR" \
  --define "_tmppath /tmp" \
  "$TOPDIR/SPECS/$PKG_NAME.spec" 2>&1

# 找到生成的 rpm 并复制到 release 目录
RPM_FILE=$(find "$TOPDIR/RPMS" -name "*.rpm" | head -1)
if [ -z "$RPM_FILE" ]; then
  echo "ERROR: 没找到生成的 rpm"
  exit 1
fi
OUTPUT="/home/yibin/code/Music/packages/desktop/release/Aurora-Music-${VERSION}-${RELEASE}.x86_64.rpm"
cp "$RPM_FILE" "$OUTPUT"
echo "✓ RPM 已生成: $OUTPUT"
ls -la "$OUTPUT"

# 清理
rm -rf "$WORKDIR"
