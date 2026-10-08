/**
 * 渲染层运行时文案（services / stores / hooks / lib）。
 *
 * 这一层没有页面归属：扫描器、下载器、缓存、播放解析、更新检查的提示与错误
 * 会被多个页面复用。放这里而不是塞进各页面命名空间，是为了让页面域与
 * 运行时域的所有权保持单一（同一张字典文件只有一个 owner）。
 *
 * 涉及跨进程的错误请改走 AuroraError（shared/i18n/errors.ts），
 * 码写在本命名空间的 error 分组下即可，不要在抛出点拼中文。
 *
 * 编写约定：
 * - 键名用英文小驼峰，按「分组/词条」两层摆放；
 * - 插值用 `{name}`，且**两种语言的占位符集合必须一致**（一致性测试会判红）；
 * - 这里只放**给人看的文案**。供匹配/比较用的领域数据（如 coverMatch 的
 *   繁简映射表、`未知艺术家` 这类参与匹配的落库占位值）不得进字典：
 *   scanner / database 落库的占位值参与封面匹配，属于数据而非界面文案；
 * - 本层没有渲染周期，取值一律走 `appTranslate()`（每次调用时取），
 *   不要在模块级把译文缓存成常量。
 */
const runtime = {
  /** 媒体缓存容量档位 */
  cache: {
    /** 0 档：不限制容量（不驱逐、照常缓存），设置页与档位胶囊共用 */
    unlimited: '不限制',
  },
  /** 曲库扫描的提示与失败结论（移动端 / Web 端以回调替代 IPC 事件） */
  scan: {
    folderUnreadable: '扫描失败：文件夹「{folder}」不存在或无法读取（可能未授予存储权限）',
    folderUnspecified: '扫描失败：未指定文件夹',
    permissionMissing: '目录访问权限未持有',
    permissionDenied: '未获得目录读取权限',
  },
  /** 在线下载落盘：文件名兜底与后续提示 */
  download: {
    unknownArtist: '未知艺术家',
    unknownTitle: '未知歌曲',
  },
  /** 平台能力差异提示（源探测结论，非抛错） */
  platform: {
    scriptUnsupportedDesktop: '当前版本不支持脚本音源（请更新桌面端）',
    scriptUnsupportedBrowser: '浏览器环境不支持脚本音源（请使用桌面端或手机端）',
    scriptUnsupportedEnv: '当前环境不支持脚本音源',
  },
  /** 移动端存储权限引导（原生 alert 与降级输入提示） */
  permission: {
    mediaDenied: '未授予存储权限，无法浏览本地文件夹。\n请授予「音乐和音频」权限后重试；若系统不再弹出授权窗口，可在 系统设置 → 应用 → Aurora Music → 权限 中手动开启。',
    folderUnreachable: '无法访问目录「{path}」\n请检查路径是否正确，或确认已授予存储权限。',
    allFilesRequired: '下载歌曲到手机存储需要「所有文件访问」权限。\n请在系统设置中授予该权限后重试。',
    dirPathHint: '请输入音乐目录的相对路径（相对于 storage/emulated/0）。\n常见目录：\n  Music\n  Download/Music\n  Documents/Music\n  DCIM/Music',
  },
  /** 播放器运行时提示 */
  player: {
    resolveFailed: '无法播放该在线歌曲：未配置音源或搜索无结果',
  },
  /**
   * 结构化错误的码（AuroraError）：值就是显示端要出的人话。
   * 抛出点只给码 + 参数，文案由渲染层的 translateError 按当前语言渲染。
   */
  error: {
    scanFolderMissing: '文件夹不存在或不可访问',
    fileReadFailed: '读取文件失败：HTTP {status}',
    downloadFileReadFailed: '读取下载文件失败：HTTP {status}',
    downloadUrlInvalid: '下载地址无效',
    downloadUnsupported: '当前版本不支持下载',
    storageUnsupported: '当前平台不支持网络存储',
    storagePermissionMissing: '缺少存储权限',
    downloadDirCreateFailed: '无法创建下载目录（存储不可用或缺少权限），请检查存储权限后重试',
    downloadFailed: '下载失败，请检查网络连接或稍后重试',
    databaseNotInited: '数据库未初始化',
    scriptSourceUrlMissing: '音源未填写脚本地址',
  },
}

export default runtime
