/**
 * 应用外壳（App 根组件、侧栏、移动端导航、标题栏、页头、Toast）。
 *
 * 命名轴：**不归属于任何业务页面**的框架性文案。
 * 页面自己的标题与空态属于各自页面域（library / hall / player…）；
 * 版本更新链路（横幅 / 下载对话框 / 检查与安装包）在 update 命名空间。
 *
 * 归位判据（避免与 common / nav 重复）：
 * - 纯动作词（取消 / 创建 / 重命名 / 删除）取 `common.action.*`；
 * - 页面名（我的音乐 / 音乐库 / 设置 / 播放列表 / 收藏 / 最近添加）取 `nav.item.*`；
 * - 品牌名与副标题取 `nav.brand.*`；
 * - 只有「外壳结构自己产生的句子」才落在这里（如导航 aria 标签、歌单导入提示词）。
 */
const shell = {
  /** 侧栏 / 抽屉的品牌区（nav.brand 是产品级品牌名，两个入口共用） */
  brand: {
    /** 标题栏与抽屉顶端的完整品牌名 */
    full: 'Aurora Music',
  },
  nav: {
    /** 移动端顶栏（常规流那一行）的 aria 标签 */
    topBar: '顶部导航',
    openMenu: '打开菜单',
    closeMenu: '关闭菜单',
  },
  playlist: {
    /** 歌单导入入口：下拉菜单项与抽屉按钮共用 */
    importLink: '导入歌单',
    importLinkText: '导入歌单（链接/文本）',
    importFile: '导入 M3U 文件',
    create: '新建播放列表',
    /** 「新建播放列表」对话框的提交按钮（common.action 里只有「添加」，语义偏轻） */
    submit: '创建',
    namePlaceholder: '播放列表名称',
    empty: '点击 + 创建你的第一个播放列表',
    /** M3U 里解析不出任何路径 */
    importNoPath: '文件中没有找到有效的音乐路径',
    /** 路径解析出来了，但在本地曲库里一首都没匹配上（{library} 传页面名） */
    importNoMatch: '没有匹配到{library}中的歌曲，请先扫描包含这些歌曲的目录',
    /** 导入成功后新建的歌单默认名 */
    importedName: '导入的播放列表',
    imported: '已导入 {count} 首歌曲',
    imported_one: '已导入 {count} 首歌曲',
  },
  /** 没有页面归属的外壳元素（标题栏、右侧播放瓷砖） */
  chrome: {
    minimize: '最小化',
    maximize: '最大化',
    restore: '还原',
    closeToTray: '关闭（最小化到托盘）',
    songDetail: '查看歌曲详情',
    nowPlayingEmpty: '未在播放',
    nowPlayingHint: '选择一首歌曲开始',
  },
  /**
   * 移动端存储权限引导（App 根组件渲染的全局浮层，不属于任何页面）。
   * 放在 shell 而不是 mobile 域：本弹层由 App.tsx 直接渲染，触发条件是启动扫描，
   * 与「原生桥能力」无关；mobile 域留给权限/文件夹选择/系统栏的**桥接层**文案。
   */
  permission: {
    title: '需要存储权限',
    description:
      '未授予存储权限时无法读取本地音乐，因此扫描结果为空。请授予「音乐和音频」权限；若系统不再弹出授权窗口，可在设置中开启「所有文件访问」。授权后返回应用会自动开始扫描。',
    grant: '授予权限',
    later: '稍后再说',
  },
  /** 移动端系统返回键的二次确认（toast，非渲染期取译文） */
  back: {
    pressAgainToExit: '再按一次返回键退出',
  },
}

export default shell
