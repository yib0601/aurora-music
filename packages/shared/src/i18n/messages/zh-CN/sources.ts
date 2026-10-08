/**
 * 音源与媒体库来源配置（洛雪脚本源 / Aurora 服务 / WebDAV）
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
 * `error.*` 是**结构化错误的显示端文案**：抛出点只给键路径（如
 * `sources.error.scriptUrlScheme`），由 `translateError(err, t)` 在渲染期按语言取值——
 * 错误信息不再在产生地烧死中文。平台自报的中文（脚本错误原文、服务端 message）
 * 属于领域数据，作为 `{reason}` 参数透出，不进字典。
 */
const sources = {
  /** 能力标签：一条源能做什么，卡片上一眼可见 */
  capability: {
    search: '搜索',
    lyrics: '歌词',
    playlist: '歌单',
    lxScript: '洛雪脚本',
  },
  /** 探测（「测试」/「测试连接」按钮与结论） */
  probe: {
    test: '测试',
    testing: '测试中…',
    testConnection: '测试连接',
    scriptOk: '脚本可用',
    scriptFailed: '脚本加载失败：{reason}',
    noPlatform: '脚本未声明任何可用平台',
    unnamedScript: '未命名脚本',
    scriptName: '{name}',
    scriptNameWithVersion: '{name} · v{version}',
    packed: '脚本经 liscript 包装，已自动解包',
    qualityCount: '音质 {count} 档',
    searchAndResolve: '搜索+取址',
    resolveOnly: '取址',
  },
  /** 音源表单：字段标签、就地提示、形态选择 */
  form: {
    title: '添加音源',
    titleLx: '添加洛雪音源',
    desc: '服务地址自动生成接口，接口模板原样使用',
    descLx: '粘贴脚本链接，脚本提供取址能力',
    kindLabel: '音源形态',
    kindAurora: 'Aurora 协议源',
    kindAuroraHint: '服务地址 / 接口模板',
    kindLx: '洛雪音源脚本',
    kindLxHint: '脚本链接（取址）',
    kindLxHintUnsupported: '仅桌面端 / 手机端支持',
    kindLxDisabledTitle: '浏览器环境不支持洛雪音源脚本，请使用桌面端或手机端',
    nameLabel: '名称（可选）',
    namePlaceholder: '如：我的音源',
    namePlaceholderLx: '如：我的洛雪源',
    nameDraftPlaceholder: '源名称',
    unnamed: '未命名源',
    defaultName: '新音源',
    defaultNameLx: '新洛雪源',
    scriptLabel: '脚本链接',
    scriptHint: '脚本提供取址能力；没有搜索接口的脚本，需要另配一条 Aurora 音源用于搜索',
    sourceLabel: '音源地址',
    apiLabel: '接口地址',
    sourceDetectedWithKey: '已识别为服务地址，密钥已提取；搜索与歌单接口自动生成',
    sourceDetected: '已识别为服务地址；搜索与歌单接口自动生成，密钥可写在链接里',
    templateDetected: '按接口模板使用，占位符由软件替换',
    sourceHint: '服务地址或完整接口地址都行；密钥写在链接里即可，如 https://host?key=xxx',
    playlistLabel: '歌单解析接口（可选）',
    playlistLabelRequired: '歌单解析接口（可选，需含 {placeholder}）',
    playlistHint: '留空表示该音源不参与歌单导入',
    playlistHintDialog: '填入后，导入歌单时可直接解析 QQ / 网易云等平台的歌单分享链接',
    headersLabel: '请求头（可选，JSON 对象）',
    /** 设置页「在线源」分区的行标签与空态（表单之外的入口文案） */
    sourceRowLabel: '音源',
    sourceRowHint: '在线搜索与歌单导入共用这一条源',
    sourceRowEmpty: '尚未配置，在线搜索与歌单导入暂不可用',
    previewService: '服务 {url}',
    previewSearch: '搜索 {url}',
    previewPlaylist: '歌单 {url}',
    savedDisabled: '脚本未测试通过，已保存为停用；测试通过后可在列表中启用',
  },
  /** 网络存储（WebDAV）来源：会入库的持久曲库来源，与在线音源不是一层 */
  webdav: {
    title: '添加网络存储',
    desc: '支持标准 WebDAV：群晖 / 威联通 / Nextcloud / rclone serve webdav 等。添加后可先「测试连接」，再扫描入库。',
    nameLabel: '名称（可选）',
    namePlaceholder: '如：家里的群晖',
    nameDraftPlaceholder: '名称',
    defaultName: '网络存储',
    baseUrlLabel: '服务地址',
    baseUrlPlaceholder: '如：https://nas.example.com:5006/dav',
    baseUrlPlaceholderDraft: '服务地址，如 https://nas.example.com:5006/dav',
    baseUrlHint: '群晖为 http(s)://主机:5006/共享文件夹名；Nextcloud 为 https://主机/remote.php/dav/files/用户名',
    rootLabel: '音乐库根目录（可选）',
    rootPlaceholder: '如：Music，留空表示服务地址本身',
    rootPlaceholderDraft: '音乐库根目录（可选），如 Music',
    usernameLabel: '用户名（可选）',
    passwordLabel: '口令（可选）',
    passwordHint: '口令仅保存在本机配置中，不会写入曲库、也不会出现在播放地址里（远端请求由主进程代理）。',
    enabledTitle: '已启用（启动时自动扫描该来源）',
    disabledTitle: '已停用（启动时不再自动扫描，可手动扫描）',
    removeTitle: '移除来源（同时从{library}移除该来源的歌曲）',
    removeConfirm: '移除网络存储「{name}」？',
    removeConfirmWithCount:
      '移除网络存储「{name}」？\n该来源下的 {count} 首歌曲会同时从{library}中移除（远端文件不会被删除）。',
    testConnection: '测试连接',
    scan: '扫描入库',
    scanComplete: '扫描完成，曲库共 {count} 首',
    scanIncomplete: '扫描完成，但有 {count} 个目录无法访问，已保留原记录',
  },
  /**
   * 结构化错误的显示端文案（键路径即错误码）。
   * 只放**本域自有**的错误：音源链接与歌单解析接口的校验错误由
   * shared 的 `checkSourceForm` 直接产出（键在 `core.error.formLinkInvalid` /
   * `core.error.formLinkPlaceholder`），这里不再复写一份，避免双真源。
   */
  error: {
    scriptUrlRequired: '请填写脚本链接',
    scriptUrlScheme: '脚本链接需以 http:// 或 https:// 开头',
    headersJson: 'JSON 格式无效：需为对象，如 {example}',
  },
}

export default sources
