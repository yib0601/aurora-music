/**
 * 在线发现（推荐歌单 / 排行榜 / 在线歌曲详情 / 下载）
 *
 * 本文件由**单一 owner** 独占编辑（另一语言版本在同名 en/ 目录下，同一人一起改），
 * 以免多人同时改同一个字典文件产生写冲突。
 *
 * 编写约定：
 * - 键名用英文小驼峰，按「页面/分组/词条」三层摆放，不要拍平成一层；
 * - 复数：中文单复数同形，**只写裸键**（裸键即 other 形态）；英文侧补 `xxx_one`。
 *   中文侧若也写一份 `xxx_one`，就成了双真源，迟早与英文漂移（一致性测试会判红）；
 * - 插值用 `{name}`，且**两种语言的占位符集合必须一致**（一致性测试会判红）；
 * - 这里只放**给人看的文案**。供匹配/比较用的领域数据（如 coverMatch 的
 *   繁简映射表、"未知艺术家" 这类参与匹配的占位值）不得进字典；
 * - 页面名（音乐库 / 我的音乐）不在这里复制一份：字典里只写 `{hall}` / `{library}`
 *   占位符，取值由调用方用 `t(NAV_LABEL_KEYS.hall|library)` 注入，
 *   否则改名要改两处，且两处必然先漂移一次（routes.ts 里写了取名沿革）；
 * - 复数形态靠 `count` 参数选；`{plays}` 这类**已格式化的显示值**另起占位符名，
 *   与 `count` 并存：`count` 只负责选形态，`plays` 负责上屏（万/K 的压缩跟语言走）。
 */

const hall = {
  /** 整页不可用（环境不支持 / 未配音源 / 源被停用）的原因说明：首屏空态与列表错误态共用 */
  unavailable: {
    unsupportedEnv: '当前环境不支持{hall}（浏览器版无在线能力），可先到「{library}」听本地曲库',
    noSource: '{hall}的推荐与榜单由音源服务提供，尚未配置音源；本地曲库不受影响',
    allDisabled: '音源已全部停用，请在设置页启用音乐源',
    sourceUnsupported: '当前音源不支持{hall}（需填写服务地址形态的音源）',
  },
  /** 首屏空态：标题与两条出路（本页是应用首屏，空态必须给出「不配也能用」的出路） */
  empty: {
    title: '{hall}暂不可用',
    configureSource: '去配置音源',
    goLibrary: '去{library}',
  },
  recommend: {
    /** 栏目名；歌单条目缺创建者信息时也用它兜底 */
    title: '推荐歌单',
    /** 栏目副标题的数量（{count} 个） */
    count: '{count} 个',
    empty: '暂无推荐歌单',
    /** 播放量：{plays} 是已按语言压缩的显示值，count 只用于选复数形态 */
    plays: '{plays} 次播放',
  },
  toplist: {
    title: '排行榜',
    count: '{count} 个榜单',
    empty: '暂无榜单',
    viewFull: '点击查看完整榜单',
    /** 详情页标题的兜底名（上游没给榜单名时用）；与栏目名「排行榜」不是一句，故分列 */
    fallbackName: '榜单',
  },
  detail: {
    reload: '重新加载',
    playAll: '播放全部',
    shuffle: '随机播放',
    empty: {
      playlist: '这个歌单里没有曲目',
      toplist: '这个榜单里没有曲目',
    },
    column: {
      song: '歌曲',
    },
    /** Hero 副标题的各片段（用「 · 」连接的是同级元信息，不是句子拼接） */
    meta: {
      songs: '{count} 首',
      songsOfTotal: '{shown} / {total} 首',
      hoursMinutes: '{hours} 小时 {minutes} 分',
      updated: '更新 {time}',
    },
  },
  download: {
    starting: '正在下载「{title}」…',
    noSource: '无法下载：未配置可用音源，或未搜索到该歌曲',
    saved: '下载完成\n已保存到：{path}',
    /** 实际取到的地址来自另一个音源时：单独一整句，不做「主句 + 备注」的拼接 */
    savedWithSource: '下载完成\n已保存到：{path}\n音源：{name}',
    setDefaultDir: '设为默认下载目录',
    defaultDirSaved: '后续下载将直接保存到「{dir}」，可在「设置 → 下载」中修改',
  },
}

export default hall
