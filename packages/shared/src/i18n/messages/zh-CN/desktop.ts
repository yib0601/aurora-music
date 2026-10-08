/**
 * Electron 主进程（托盘 / 菜单 / 原生对话框 / 通知 / IPC 错误）
 *
 * 本文件由**单一 owner** 独占编辑（另一语言版本在同名 en/ 目录下，同一人一起改），
 * 以免多人同时改同一个字典文件产生写冲突。
 *
 * 编写约定：
 * - 键名用英文小驼峰，按「页面/分组/词条」三层摆放，不要拍平成一层；
 * - 复数用键后缀：`xxx_one` / `xxx_other`（两种语言都要写，中文两份值相同）；
 * - 插值用 `{name}`，且**两种语言的占位符集合必须一致**（一致性测试会判红）；
 * - 这里只放**给人看的文案**。供匹配/比较用的领域数据（如 coverMatch 的
 *   繁简映射表、"未知艺术家" 这类参与匹配的占位值）不得进字典；
 * - 不要在这里写「{count} 首歌」以外的拼接式句子：需要拼接的用整句 + 占位符。
 *
 * 分组语义：
 * - `tray`    托盘提示与右键菜单。菜单模板**必须在函数内构造**：模块级求值会把
 *             语言冻结在加载那一刻，切语言后托盘菜单不会变。
 * - `dialog`  原生对话框（showOpenDialog / showSaveDialog）的标题。
 *             这些对话框的按钮由系统提供并随系统语言变化，标题由我们负责。
 * - `updater` 更新下载的线路说明，经 updater:route 事件**直接上屏**（渲染层只做透传），
 *             所以取值时必须已经渲染成当前语言的成品句。
 * - `error`  主进程抛出的结构化错误。`AuroraError` 的 code 就是这里的完整键路径，
 *             文案不在抛出点拼，由显示端 translateError 按语言渲染。
 *             域内错误按域分组（scan / download / source / lx / updater），
 *             跨域通用错误放 common。
 */
const desktop = {
  tray: {
    /**
     * 产品名：品牌名不翻译，两种语言同值。
     * `{brand}` 由调用方从 `nav.brand.name` 取，保证托盘与界面品牌区是同一条来源。
     */
    appName: '{brand} Music',
    show: '显示主窗口',
    quit: '退出 {appName}',
  },
  dialog: {
    /** 选择扫描目录（dialog:openFolder） */
    pickMusicFolder: '选择音乐文件夹',
    /** 下载在线歌曲时选择保存位置（tracks:download，未配置默认下载目录） */
    saveSong: '保存歌曲',
  },
  updater: {
    /** 下载线路说明：走系统代理时把代理地址一并告诉用户 */
    routeProxy: '系统代理 {proxy}',
    /** 没有可用的系统代理：Chromium 直连上游 */
    routeDirect: '直连（未走系统代理）',
  },
  error: {
    /** 跨域通用：入参无效、依赖未就绪 */
    common: {
      windowUnavailable: '窗口不可用',
      databaseUnavailable: '数据库尚未初始化',
      trackIdInvalid: '曲目 ID 无效',
      urlInvalid: '下载地址无效',
    },
    /** 曲库扫描（本地目录 / 媒体库来源） */
    scan: {
      noFolder: '扫描失败：未指定文件夹',
      noSource: '扫描失败：未指定媒体库来源',
      folderUnavailable: '文件夹不存在或不可访问',
      folderUnreadable: '扫描失败：文件夹「{folder}」不存在或无法读取',
    },
    /** 在线歌曲下载（tracks:download） */
    download: {
      dirInvalid: '默认下载目录无效，请在设置中重新选择',
      dirUnusable: '默认下载目录不可用（无法创建或没有写入权限），请在设置中重新选择',
      dirNotWritable: '默认下载目录不可写，请在设置中重新选择',
      canceled: '已取消保存',
      networkFailed: '下载失败，请检查网络连接或稍后重试',
      httpStatus: '下载失败：服务器返回 HTTP {status}',
      writeFailed: '下载失败，写入文件时出错',
    },
    /** 媒体库来源（WebDAV 等）与远端封面 */
    source: {
      invalid: '来源无效',
      notFound: '来源配置不存在',
      unknown: '未知的媒体库来源：{id}',
      kindUnsupported: '暂不支持的媒体库来源类型：{kind}',
      remoteReadFailed: '读取远端文件失败：HTTP {status}',
      coverHttpStatus: '封面下载失败：HTTP {status}',
      coverInvalid: '封面下载失败：内容不是有效图片',
    },
    /** 洛雪（LX）脚本音源宿主 */
    lx: {
      scriptUrlMissing: '音源未填写脚本地址',
      scriptUrlInvalid: '脚本地址无效',
      sourceInvalid: '音源配置无效',
      refMissing: '曲目缺少洛雪定位信息',
      notScriptSource: '音源「{name}」不是洛雪脚本源',
      sourceDisabled: '洛雪音源「{name}」已停用',
      binaryUnsupported: '不支持的二进制入参',
      requestTimeout: '请求超时（{ms}ms）',
      requestFailed: '网络请求失败',
      /** 取址两路走：每路的失败原因各留一条，最后合并成 resolveFailed */
      directAttempt: '原样取址：{reason}',
      mappedAttempt: '映射取址：{reason}',
      resolveFailed: '取址失败：{reasons}',
    },
    /** 内置更新（下载 / 校验 / 安装） */
    updater: {
      kindInvalid: '安装包类型无效',
      busy: '已有更新下载在进行中',
      canceled: '已取消下载',
      installerMissing: '安装包文件不存在',
      httpStatus: '服务器返回 HTTP {status}',
      integrityUnknown: '无法确认安装包完整性（服务端未提供长度，也不清楚官方包体大小）',
      incomplete: '安装包不完整（已下载 {received} / 应为 {expected} 字节）',
      diskWriteFailed: '写入磁盘失败',
      stalled: '连接长时间无数据',
      rangeUnknown: '响应无法确认数据起点',
      digestMismatch: '安装包校验失败（内容与官方摘要不一致）',
      interrupted: '下载中断',
      downloadFailed: '下载失败：{detail}',
      downloadFailedGeneric: '下载失败，请稍后重试',
      launchFailed: '启动新版本失败：{detail}',
      terminalFailed: '无法打开终端，请手动执行：{command}',
      openFailed: '打开安装包失败：{detail}',
    },
  },
}

export default desktop
