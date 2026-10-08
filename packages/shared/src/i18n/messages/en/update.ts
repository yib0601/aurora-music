import type update from '../zh-CN/update'
import type { LocalizedOf } from '../schema'

/**
 * English messages. 类型标注刻意写成 `typeof` 中文侧的形状：
 * 少键 / 多键 / 拼错键都会在 tsc 阶段直接报错，语言覆盖度由编译器守门。
 *
 * 两处刻意的选词（对齐 nav.ts 的命名轴，勿直译）：
 * - 音乐库 → Discover，因此歌单导入提示里的页面名走 `{library}` 占位符，
 *   由调用方传 `nav.item.library` 的当前语言值，不在本文件重复写页面名；
 * - 品牌名与格式名（Aurora Music / dmg / APK / dmg / AppImage）保持原文。
 */
const en: LocalizedOf<typeof update> = {
  banner: {
    newVersionCompact: 'New version',
    newVersionFull: 'New version available',
    currentVersion: ', currently v{version}',
    inAppHint: 'Downloads in-app and installs right away',
    download: 'Download update',
    opened: 'Opened',
    openedDownload: 'Download page opened',
    close: 'Dismiss update notice',
  },
  dialog: {
    title: 'Software update',
    downloading: 'Downloading installer…',
    savedToDownloads: 'Saved to your system Downloads folder',
    slowLine:
      'The download is slow. The app follows your system proxy; if no proxy is enabled or set as the system proxy, it falls back to a direct connection and the speed drops sharply.',
    background: 'Download in background',
    close: 'Close',
    retry: 'Retry',
    done: 'Download complete',
    reveal: 'Open folder',
    installMobile: 'Install',
    installDesktop: 'Install now',
    later: 'Later',
    needInstallPermission:
      'Allow this app to install unknown apps first, then come back and tap "Install" again',
  },
  hint: {
    exe: 'The installer starts and this app quits; finish the wizard to complete the update',
    appimage: 'The new version starts and this app quits; just run the new file to complete the update',
    deb: 'A terminal opens to run the sudo install command; confirm with your password',
    rpm: 'A terminal opens to run the sudo install command; confirm with your password',
    dmg: 'The dmg opens; drag Aurora Music into Applications to overwrite the old version and finish the update',
    apk: 'The system installer opens; confirm the prompts. If it reports no permission, allow this app to install unknown apps first',
  },
  asset: {
    apk: 'APK',
    exe: 'EXE installer',
    appimage: 'AppImage portable',
    deb: 'DEB package',
    rpm: 'RPM package',
    dmg: 'DMG installer',
  },
  toast: {
    terminal: 'Install command opened in the terminal; enter your password when prompted',
    mounted: 'dmg mounted; drag Aurora Music into Applications to overwrite the old version',
  },
  installHint: {
    rpm: 'After downloading, run {command} to overwrite the installation',
    deb: 'After downloading, run {command} to overwrite the installation',
  },
  error: {
    downloadFailed: 'Download failed, please try again later',
    notSupported: 'This build does not support in-app updates',
    installNotSupported: 'This build does not support in-app installation',
    installFailed: 'Could not start the installer',
    offline: 'Network unavailable',
    canceled: 'Canceled',
  },
}

export default en
