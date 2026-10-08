/**
 * 版本更新（检查 / 下载 / 安装 / 更新提示）
 *
 * 本文件由**单一 owner** 独占编辑（另一语言版本在同名 en/ 目录下，同一人一起改），
 * 以免多人同时改同一个字典文件产生写冲突。
 *
 * 编写约定：
 * - 键名用英文小驼峰，按「页面/分组/词条」三层摆放，不要拍平成一层；
 * - 复数用键后缀：`xxx_one` / `xxx_other`（两种语言都要写，中文两份值相同）；
 * - 插值用 `{name}`，且**两种语言的占位符集合必须一致**（一致性测试会判红）；
 * - 这里只放**给人看的文案**。供匹配/比较用的领域数据（如封面繁简映射表、
 *   "未知艺术家" 这类参与匹配的占位值）不得进字典；
 * - 不要在这里写「{count} 首歌」以外的拼接式句子：需要拼接的用整句 + 占位符。
 *
 * 本域的两类键，用途不同、都不可省：
 * - `update.asset.*` / `update.hint.*` / `update.error.*` / `update.label.*` 是**键**
 *   （由 update-source / update-asset / updateDownloadStore 返回或抛出，
 *   渲染期再用 t() 取值）。service 层不许拼句子，否则会把语言冻在解析那一刻；
 * - 其余是**句子**，渲染期直接 t()。
 * 英文里的 `Aurora Music`、`dmg`、`v{version}` 是产品名与格式名，不翻译。
 */
const update = {
  /** 更新横幅（窄档整行 / 宽档顶栏胶囊） */
  banner: {
    /** 紧凑形态：版本号独占一行 */
    newVersionCompact: '新版本',
    /** 整行形态：版本号与当前版本并排 */
    newVersionFull: '发现新版本',
    /** 整行形态里跟在版本号后的「，当前 v{version}」半句 */
    currentVersion: '，当前 v{version}',
    /** 应用内下载可用时，下载按钮的 tooltip */
    inAppHint: '应用内下载，完成后可直接安装',
    download: '下载更新',
    /** 回退到浏览器打开下载页后，按钮变成的完成态（胶囊形态） */
    opened: '已打开',
    /** 同上，整行形态 */
    openedDownload: '已打开下载',
    close: '关闭更新提示',
  },
  /** 下载 / 安装对话框 */
  dialog: {
    title: '软件更新',
    downloading: '正在下载安装包…',
    /** 下载路径说明：安装包落在系统下载目录 */
    savedToDownloads: '保存至系统「下载」目录',
    /** 线路速度明显偏低时的解释（不是错误） */
    slowLine:
      '当前速度偏低。应用跟随系统代理下载，若本机代理未开启或未设为系统代理，会自动回退直连，速度会明显下降。',
    background: '后台下载',
    close: '关闭',
    retry: '重试',
    done: '下载完成',
    reveal: '打开文件夹',
    /** 移动端安装按钮：调起系统安装界面 */
    installMobile: '去安装',
    /** 桌面端安装按钮 */
    installDesktop: '现在安装',
    later: '稍后',
    /** 移动端未授予「安装未知应用」时的提示 */
    needInstallPermission: '请先允许本应用安装未知应用，授权后回来再次点击「去安装」',
  },
  /** 各安装包类型的「现在安装」说明（键，由 update-asset 的 assetInstallHintKey 返回） */
  hint: {
    exe: '启动安装器后将退出当前应用，按向导完成安装',
    appimage: '启动新版本后将退出当前应用，直接运行新文件即完成更新',
    deb: '将打开系统终端执行 sudo 安装命令，输入密码确认即可',
    rpm: '将打开系统终端执行 sudo 安装命令，输入密码确认即可',
    dmg: '将挂载 dmg 安装包，把 Aurora Music 拖入「应用程序」覆盖旧版本即完成更新',
    apk: '将调起系统安装界面，按提示确认安装；若提示未授权，请先允许本应用「安装未知应用」',
  },
  /** 安装包类型展示名（键，由 update-asset 的 ASSET_LABEL_KEYS 返回） */
  asset: {
    apk: 'APK',
    exe: 'EXE 安装包',
    appimage: 'AppImage 便携版',
    deb: 'DEB 包',
    rpm: 'RPM 包',
    dmg: 'DMG 安装包',
  },
  /** 双击/点击安装后的结果提示（toast） */
  toast: {
    terminal: '已在终端打开安装命令，请按提示输入密码',
    mounted: '已挂载 dmg，把 Aurora Music 拖入「应用程序」覆盖旧版本即完成更新',
  },
  /** 覆盖安装命令行提示（系统包管理器安装时才给，{command} 是命令行原文） */
  installHint: {
    rpm: '下载后用 {command} 覆盖安装',
    deb: '下载后用 {command} 覆盖安装',
  },
  /** 结构化错误码：service / store 抛出，渲染层用 translateError(err, t) 显示 */
  error: {
    /** 下载失败（含主进程事件通道传回的失败） */
    downloadFailed: '下载失败，请稍后重试',
    /** 当前运行形态（Web / 未注册原生插件）不支持应用内更新 */
    notSupported: '当前版本不支持应用内更新',
    /** 同上，移动端安装那一侧 */
    installNotSupported: '当前版本不支持应用内安装',
    /** 安装器启动失败（异常原因未识别时的兜底句） */
    installFailed: '启动安装失败',
    /** 客户端离线：检查更新的候选地址为空 */
    offline: '网络不可用',
    /** 用户主动取消（离开页面/关闭对话框） */
    canceled: '已取消',
  },
}

export default update
