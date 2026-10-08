/**
 * 设置页（外观 / 曲库 / 存储 / 关于）
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
 * 归属判据：本文件是**设置页自身**的文案（分区名、行标签与说明、档位胶囊、
 * 确认框与区块标题）。含「音源」「歌单」「WebDAV」这类领域名词的表单文案留在
 * `sources` 命名空间；分区名里的「我的音乐」复用 `nav.item.library`，
 * 不在这里另开一份（双真源会让两处改名后不一致）。
 */
const settings = {
  page: {
    title: '设置',
  },
  /** 分区导航 = 内容列的分区标题，同一份键渲染两处 */
  nav: {
    general: '通用',
    storage: '下载与缓存',
    sources: '在线源',
    about: '关于',
  },
  general: {
    theme: {
      label: '主题',
      dark: '深色',
      light: '浅色',
      system: '跟随系统',
    },
    /**
     * 语言项只放标题：三个选项的名必须用**该语言自身**书写（简体中文 / English），
     * 由 shared 的 LOCALE_LABELS / SYSTEM_LANGUAGE_LABELS 提供——用户看不懂当前
     * 界面语言时，母语名是唯一能自救的线索，翻译它等于把线索抹掉。
     */
    language: {
      label: '语言',
    },
    outputDevice: {
      label: '输出设备',
      empty: '未检测到可用设备',
      system: '系统默认',
    },
  },
  library: {
    scanDirs: {
      label: '扫描目录',
      hint: '应用自动扫描这些目录里的音乐文件',
      empty: '尚未添加目录',
      removeTitle: '移除目录（同时从{library}移除该目录下的歌曲）',
      removeConfirm: '移除扫描目录「{folder}」？',
      removeConfirmWithCount:
        '移除扫描目录「{folder}」？\n该目录下的 {count} 首歌曲会同时从{library}中移除（磁盘文件不会被删除）。',
      pickFailed: '扫描目录「{folder}」失败，请检查目录是否存在且可访问',
    },
    storage: {
      label: '网络存储',
      hint: 'NAS / WebDAV 上的音乐会被扫描入库并长期保留',
      empty: '尚未添加，支持群晖 / 威联通 / Nextcloud 等标准 WebDAV',
    },
  },
  storage: {
    downloadQuality: {
      label: '下载音质',
      standard: '标准 128k',
      high: '高品质 320k',
      lossless: '无损 FLAC',
    },
    downloadDir: {
      label: '下载目录',
      desktopHint: '设置后不再弹保存对话框',
      mobileHint: '设置后直接存入该目录',
      clear: '清除',
      change: '更换',
      desktopUnset: '未设置（每次下载都会询问保存位置）',
      mobilePath: '手机存储/{path}',
      mobileUnset: '未设置（默认存入 手机存储/{path}）',
      pickerTitle: '选择下载目录',
      pickerDescription: '在线歌曲将直接保存到该目录，不再存入默认的 {path}',
    },
    cache: {
      label: '缓存上限',
      hintUnlimited: '不限制容量，只受磁盘剩余空间约束 · 当前占用 {used}',
      hintLimited: '超出上限时按最久未使用自动清理 · 默认 {default} · 当前占用 {used}',
      unlimited: '不限制',
      gb: '{value} GB',
      custom: '自定义 {value}',
      defaultPill: '默认 {value}',
      customPlaceholder: '自定义 GB',
      unit: 'GB',
      clearTitle: '清空全部缓存',
      clearConfirm: '清空全部缓存？',
      cleared: '缓存已清空',
      invalid: '需填 {min} – {max} GB',
    },
  },
  about: {
    version: '版本',
    repo: '项目仓库',
    repoTitle: '查看源码与开源许可（禁止商业用途）',
    checkUpdate: '检查更新',
    checking: '检查中…',
    newVersion: '发现新版本',
    downloading: '正在下载安装包，可关闭此窗口继续后台下载',
    ready: '安装包已就绪，点击右侧继续安装',
    assetHint: '将下载对应系统的安装包（{label}）',
    downloadHint: '点击下载对应平台的安装包',
    continueInstall: '继续安装',
    downloadingButton: '下载中…',
    downloadUpdate: '下载更新',
    latest: '当前已是最新版本',
    checkFailed: '检查失败：{reason}',
    checkFailedFallback: '检查失败，请确认网络后重试',
  },
}

export default settings
