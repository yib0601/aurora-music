/**
 * 全局搜索浮层（入口占位框 / 输入行 / 历史 / 结果行 / 底部状态行）
 *
 * 本文件由**单一 owner** 独占编辑（另一语言版本在同名 en/ 目录下，同一人一起改），
 * 以免多人同时改同一个字典文件产生写冲突。
 *
 * 编写约定：
 * - 键名用英文小驼峰，按「页面/分组/词条」三层摆放，不要拍平成一层；
 * - 复数：中文单复数同形，**只写裸键**（裸键即 other 形态）；英文侧补 `xxx_one`。
 *   中文侧若也写一份 `xxx_one`，就成了双真源，迟早与英文漂移（一致性测试会判红）；
 * - 插值用 `{name}`，且**两种语言的占位符集合必须一致**（一致性测试会判红）；
 * - 这里只放**给人看的文案**。供匹配/比较用的领域数据不得进字典：
 *   在线结果的**分组键**（源名缺失时的兜底分组）就是数据，不是文案——
 *   写成译文会让「切语言就换一组」，它在组件里是一个 ASCII 常量；
 * - 页面名（我的音乐）不在这里复制一份：字典里只写 `{library}` 占位符，
 *   取值由调用方用 `t(NAV_LABEL_KEYS.library)` 注入（见 routes.ts 的取名沿革）。
 */

const search = {
  /** 顶栏的搜索入口（伪输入框） */
  entry: {
    placeholder: '搜索歌曲、歌手、专辑',
  },
  /** 浮层本体：输入行 / 空态 / 历史 / 底部状态行 */
  overlay: {
    placeholder: '搜索歌曲、艺术家、专辑...',
    emptyTitle: '开始搜索',
    emptyDesc: '输入关键词，搜索{library}与在线音源',
    historyTitle: '历史搜索',
    historyRemove: '删除该记录',
    /** 本地命中过多时的截断提示：{count} 由组件传本地结果上限 */
    localTruncated: '本地结果较多，仅显示前 {count} 条',
    noMatch: '没有找到匹配 "{query}" 的歌曲',
    noSource: '应用不内置任何音乐源，请先在设置中配置符合协议的搜索接口',
    goSettings: '前往设置音乐源',
    searching: '正在搜索在线音乐...',
    onlineEmpty: '在线源未找到匹配结果',
  },
  /** 结果行的来源徽章 */
  badge: {
    /** 在线结果缺源名时的兜底名（来源泛称，不随页面改名而动，见 routes.ts） */
    onlineFallback: '在线音乐',
  },
  /** 结果行的操作（行内按钮 + 右键菜单） */
  row: {
    viewDetail: '查看歌曲详情',
    like: '收藏',
    unlike: '取消收藏',
    download: '下载歌曲',
    playNow: '立即播放',
    playNext: '下一首播放',
    addToQueue: '添加到队列',
    addToPlaylist: '添加到播放列表',
    noPlaylist: '暂无播放列表',
  },
}

export default search
