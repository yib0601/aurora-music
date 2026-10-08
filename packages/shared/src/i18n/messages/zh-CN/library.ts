/**
 * 本地曲库（扫描 / 导入 / 歌曲表 / 歌单 / 空态）
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
 * 归属判据：**页面/组件名 + 名词**（播放列表、文件夹选择器、重复曲目）放本命名空间；
 * 纯动作词（确定/取消/重试/播放/下一首）优先用 common.action.*，
 * 纯字段名（标题/艺术家/专辑/时长/本地/在线）优先用 common.label.*，
 * 纯计数单位（首歌/项/个文件）优先用 common.unit.*——不要在这里重复造。
 */
const library = {
  /** 曲目/歌单的通用动作（菜单项、页头按钮） */
  action: {
    importMusic: '导入音乐',
    goToLibrary: '去{label}',
    backToLibrary: '返回{label}',
    playAll: '播放全部',
    viewDetails: '查看歌曲详情',
    playNext: '下一首播放',
    addToQueue: '添加到队列',
    addToPlaylist: '添加到播放列表',
    like: '收藏',
    unlike: '取消收藏',
    sortBy: '排序方式',
    moreActions: '更多操作',
  },
  /** 曲库浏览标签：歌曲 / 专辑 / 艺术家（后两个复用 common.label.*） */
  tab: {
    songs: '歌曲',
  },
  /** 排序项（标题/艺术家/专辑/时长复用 common.label.*） */
  sort: {
    default: '默认排序',
    addedAt: '添加时间',
    asc: '升序',
    desc: '降序',
  },
  /** 重新扫描入口（扫描中的状态文案复用 common.state.scanning） */
  rescan: {
    tooltip: '重新扫描，同步已删除的歌曲',
  },
  /** 曲目来源的展示名（网络存储复用 nav.source.webdav） */
  source: {
    localFile: '本机文件',
    quoted: '「{name}」',
    fromNetworkStorage: '来自网络存储「{name}」',
  },
  empty: {
    title: '还没有音乐',
    hint: '导入你的音乐文件夹，开始构建你的专属曲库',
  },
  /** 专辑/艺术家分组卡片的副标题：`歌手 · N 首歌` */
  group: {
    albumSubtitle: '{subtitle} · {count} 首歌',
  },
  recent: {
    title: '最近播放',
    empty: {
      title: '还没有播放记录',
      hint: '导入音乐后，你播放的歌曲会出现在这里',
    },
  },
  liked: {
    title: '我喜欢的音乐',
    empty: {
      title: '还没有收藏的歌曲',
      hint: '在歌曲上点击爱心，它们会出现在这里',
    },
  },
  playlist: {
    title: '播放列表',
    new: '新建播放列表',
    /** 菜单项：省略号表示「会打开对话框」 */
    newMenu: '新建播放列表…',
    namePlaceholder: '播放列表名称',
    createAndAdd: '创建并添加',
    /** 导入歌单时的默认名（同时用于输入框占位与创建时的兜底名） */
    defaultImportName: '导入的播放列表',
    notFound: '播放列表不存在',
    empty: '暂无播放列表',
    exportM3u: '导出为 M3U',
    importM3u: '导入 M3U 文件',
    importLink: '导入歌单（链接/文本）',
    delete: '删除播放列表',
    removeTrack: '从播放列表移除',
    importInvalidFile: '文件中没有找到有效的音乐路径',
    importNoMatch: '没有匹配到{label}中的歌曲，请先扫描包含这些歌曲的目录',
    emptyTitle: '播放列表为空',
    emptyHint: '从{label}中添加歌曲',
  },
  /** 歌单导入对话框（链接/纯文本 → 本地匹配 → 在线补齐） */
  import: {
    title: '导入歌单',
    description:
      '粘贴歌单分享链接或纯文本（每行一首：歌名 - 歌手）。应用不内置任何平台的抓取器：链接解析由你配置的音源提供（设置里填好音源的服务地址与密钥即可），纯文本导入无需任何配置。',
    textPlaceholder: '粘贴歌单分享链接，或按行粘贴歌曲列表：\n七里香 - 周杰伦\n晴天 - 周杰伦',
    namePlaceholder: '歌单名称（可选，默认「{name}」）',
    notice: '仅导入歌名/歌手等元数据；在线歌曲只展示与在线播放，不会下载',
    parsing: '解析中…',
    parse: '解析并预览',
    summary: '共 {total} 首 · 本地 {local} 首',
    summaryPending: '共 {total} 首 · 本地 {local} 首 · 待在线匹配 {pending} 首',
    matching: '匹配中',
    progress: '在线匹配中 {done}/{total}…',
    repaste: '重新粘贴',
    create: '创建歌单',
    emptyResult: '没有解析出任何歌曲，请检查粘贴内容（每行一首：歌名 - 歌手）',
    nothingMatched: '没有可导入的歌曲：本地曲库未匹配，在线匹配也无结果',
    /** 导入结果提示：有无在线曲目 × 有无未找到曲目，四种组合各一条整句 */
    toast: {
      resultLocal: '成功导入 {count} 首（本地 {local} 首）',
      resultMixed: '成功导入 {count} 首（本地 {local} 首，在线 {online} 首）',
      resultLocalSkipped: '成功导入 {count} 首（本地 {local} 首）\n{skipped} 首未找到，已跳过',
      resultMixedSkipped: '成功导入 {count} 首（本地 {local} 首，在线 {online} 首）\n{skipped} 首未找到，已跳过',
    },
  },
  /** 移动端文件夹选择器 */
  folderPicker: {
    title: '选择扫描目录',
    description: '浏览并选择包含音乐文件的文件夹',
    confirm: '选择此目录',
    storage: '存储',
    noSubfolders: '此目录下没有子文件夹',
    emptyHint: '可点击下方「{label}」直接使用当前位置',
    up: '返回上级',
    current: '当前：{path}',
  },
  /** 重复曲目明示（去重只影响展示，明细必须可查） */
  duplicate: {
    badge: '重复',
    summary: '· 已隐藏 {count} 首重复曲目',
    keptHidden: '保留 {kept} · 隐藏 {hidden}',
    introSummary:
      '以下歌曲在多个来源中存在副本，列表只展示一份（本机文件优先）。记录没有删除，歌单/收藏引用仍有效：',
    introBadge: '这首歌曲存在多个副本，列表只展示一份。记录没有删除：',
  },
  /** 域内错误兜底文案：抛出侧给键、显示侧按当前语言渲染 */
  error: {
    /** `{reason}` 是音源侧的原始原因（未配置接口/超时/HTTP 状态），原样透出不吞信息 */
    parseFailed: '歌单解析失败：{reason}',
    readDirFailed: '无法读取该目录，请检查存储权限',
    scanPartialFailed: '部分目录扫描失败，请检查目录是否存在且可访问',
    scanUnsupported: '当前浏览器不支持访问本地文件，请使用 Chrome/Edge 或桌面版、安卓版',
  },
}

export default library
