/**
 * 播放器（播放条 / 队列 / 正在播放 / 歌词 / 音频设备 / 可视化）
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
 * 复用优先：动作词（播放/暂停/上一首/下一首/返回/取消）、通用状态（加载中）、
 * 通用字段名（时长）一律用 common.*；来源类型标签（本地/网络存储）与导航侧的
 * nav.source.* 同义，也直接复用，避免同一个词在两处漂移。
 * 播放器特有的词（队列/播放模式/歌词空态/属性字段名）才落在这里。
 *
 * 平台展示名（网易云 / QQ 音乐 / 酷狗）属于界面文案，可以进字典；
 * 平台**标识串**（`onlineSource === 'qq'` 这类判断值）是领域数据，留在源码里。
 */
const player = {
  bar: {
    /** 播放条紧凑档整条的可点区域（只有 aria-label） */
    expand: '展开播放器',
  },
  queue: {
    title: '播放队列',
    /** 播放条上的队列开关：图标按钮，只有 aria-label / title */
    toggle: '队列',
    empty: '队列为空',
  },
  nowPlaying: {
    /** 全屏播放页顶栏的收起按钮 */
    collapse: '收起播放页',
    progress: '播放进度',
  },
  state: {
    notPlaying: '未在播放',
    idle: '选择一首歌曲',
    idleHint: '选择一首歌曲开始',
  },
  mode: {
    label: '播放模式',
    /** 播放模式按钮的三种提示：当前处于哪种模式就显示哪种 */
    shuffle: '随机播放',
    repeatOne: '单曲循环',
    repeatAll: '列表循环',
  },
  volume: {
    mute: '静音',
    unmute: '取消静音',
  },
  like: {
    add: '收藏',
    remove: '取消收藏',
  },
  track: {
    viewDetail: '查看歌曲详情',
  },
  lyrics: {
    searching: '正在搜索歌词…',
    empty: '暂无歌词',
  },
  source: {
    /** 在线平台的展示名（标识串 'netease' / 'qq' / 'kugou' 不进字典） */
    onlineMusic: '在线音乐',
    netease: '网易云',
    qqMusic: 'QQ 音乐',
    kugou: '酷狗',
  },
  detail: {
    /** 歌曲详情页的眉标：整句交给这里，避免在 JSX 里拼「来源 · 歌曲详情」 */
    tagline: '{source} · 歌曲详情',
    loading: '正在加载歌曲…',
    notFound: '未找到这首歌曲',
    loadingHint: '请稍候，{library}正在加载',
    removed: '歌曲可能已被移除',
    goBack: '返回上一页',
    moreActions: '更多操作',
    playNext: '下一首播放',
    addToQueue: '添加到队列',
    download: '下载歌曲',
    newPlaylist: '新建播放列表',
    newPlaylistAndAdd: '新建播放列表并添加',
    newPlaylistPlaceholder: '播放列表名称',
    createAndAdd: '创建并添加',
    moreInfo: '更多信息',
    fromAlbum: '来自专辑「{album}」',
  },
  facts: {
    year: '年份',
    genre: '流派',
    trackNumber: '音轨',
    /** 播放次数值：英文按 {count} 选单复数，中文单形态 */
    playCount: '{count} 次',
    fileSize: '文件大小',
    addedAt: '添加时间',
    lastPlayed: '最后播放',
    neverPlayed: '从未播放',
  },
  device: {
    /** 音频输出设备没有系统标签时的兜底名（label 由系统给出，不进字典） */
    fallbackLabel: '输出设备 {index}',
  },
}

export default player
