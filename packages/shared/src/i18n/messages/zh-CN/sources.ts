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
    playlist: '歌单',
    lxScript: '洛雪脚本',
    // 插件能力的通用徽章（插件自己声明 capabilities，这里只给展示名）
    pluginProbe: '可测试',
    pluginSearch: '搜索',
    pluginResolve: '取址',
    pluginUserPlaylists: '我的歌单',
    pluginPlaylistTracks: '歌单曲目',
    pluginAuth: '登录',
  },
  /** 插件登录面板 */
  auth: {
    unsupportedEnv: '当前环境不支持插件（请使用桌面端或手机端）',
    emptyInput: '请先粘贴凭证',
    saved: '已保存，登录成功',
    loggedOut: '已退出登录',
    failed: '操作失败',
    notLoggedIn: '未登录',
    expired: '登录已失效，请重新登录',
    loggedIn: '已登录',
    loggedInAs: '已登录：{name}',
    inputLabel: '凭证',
    inputHint: '从官方客户端复制 Cookie 或凭证值粘贴到这里',
    submit: '保存登录',
    logout: '退出登录',
    refresh: '刷新状态',
    noPlugins: '没有需要登录的插件',
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
    /*
       这几个 `kind*` 键**不是**「形态选择器」的残留，而是插件自己的展示名与说明：
       `auroraPlugin` / `lxPlugin` / `qishuiPlugin` 的 `displayNameKey` / `descriptionKey`
       指向它们（插件契约要求文案键，不在实现里烧中文）。

       下线的是同一批里的另一组：`kindLabel`（选择器标题）、`kindLxHintUnsupported`、
       `kind*DisabledTitle`、`kindDisabledByUser`。那个选择器随「配置按插件归属」
       一起消失之后，「这个端支不支持」改由插件设置入口的**可见性**表达；
       「是不是被停用」由目录条目上的开关表达，都不再需要一句事后解释。
    */
    kindAuroraHint: '服务地址 / 接口模板',
    kindLx: '洛雪音源脚本',
    kindLxHint: '脚本链接（取址）',
    defaultNameQishui: '我的汽水歌单',
    namePlaceholderQishui: '如：我的汽水歌单',
    playlistUrlLabel: '歌单链接或 ID',
    playlistUrlPlaceholder: 'https://music.douyin.com/qishui/share/playlist?playlist_id=…',
    playlistUrlHint: '粘贴汽水歌单的分享链接或歌单 ID 即可导入；不需要登录',
    kindQishuiHint: '歌单链接（免登录）；登录后可拉取我的歌单',
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
    sourceDetectedWithKey: '已识别为服务地址，密钥已提取；搜索与歌单接口自动生成',
    sourceDetected: '已识别为服务地址；搜索与歌单接口自动生成，密钥可写在链接里',
    templateDetected: '按接口模板使用，占位符由软件替换',
    sourceHint: '服务地址或完整接口地址都行；密钥写在链接里即可，如 https://host?key=xxx',
    playlistLabel: '歌单解析接口（可选）',
    playlistLabelRequired: '歌单解析接口（可选，需含 {placeholder}）',
    playlistHint: '留空表示该音源不参与歌单导入',
    playlistHintDialog: '填入后，导入歌单时可直接解析 QQ / 网易云等平台的歌单分享链接',
    headersLabel: '请求头（可选，JSON 对象）',
    previewService: '服务 {url}',
    previewSearch: '搜索 {url}',
    previewPlaylist: '歌单 {url}',
    savedDisabled: '脚本未测试通过，已保存为停用；测试通过后可在列表中启用',
  },
  /** 网络存储（WebDAV）来源：会入库的持久曲库来源，与在线音源不是一层 */
  webdav: {
    title: '添加网络存储',
    /**
     * 弹窗通用说明：**不提具体协议**。曲库来源已插件化，WebDAV 只是当前唯一的内置协议；
     * 协议特有的地址格式说明归各字段自己的 hint（如 baseUrlHint），不写在这一层。
     */
    desc: '添加网络存储后可先「测试连接」，再扫描入库。',
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
    /**
     * 声明式表单的通用文案（字段标签/占位/说明由插件的 `fields` 声明提供，
     * 这里只放「表单骨架」自己的字，协议特有的说明一律归各字段的 hint）。
     */
    /** 口令状态的三种形态：已保存 / 未保存 / 本机无法加密保存 */
    credentialSaved: '口令已安全保存',
    credentialMissing: '未保存口令',
    credentialUnavailable: '本机无法安全保存口令，每次启动都需要重新输入',
    credentialHint: '口令经系统密钥加密后保存在本机，不会写入配置文件，也不会出现在播放地址里',
    clearCredential: '清除口令',
    /** 必填字段缺失时的提交校验提示 */
    fieldRequired: '{field}不能为空',
  },
  /**
   * SFTP（SSH 文件传输）。
   *
   * 与 WebDAV 同一套声明式字段机制：设置页据 `fields` 通用渲染表单，这里只给文案。
   * 认证两条路（口令 / 私钥）都要有明确说明 —— 用户最容易卡在"到底该填哪个"。
   */
  sftp: {
    title: 'SFTP',
    desc: '通过 SSH 访问 NAS 或服务器上的音乐目录',
    hostLabel: '主机',
    hostPlaceholder: '如：nas.example.com 或 192.168.1.10',
    portLabel: '端口（默认 22）',
    portPlaceholder: '22',
    usernameLabel: '用户名',
    passwordLabel: '口令',
    passwordHint: '口令经系统密钥加密后保存在本机，不会写入配置文件',
    privateKeyLabel: '私钥（可选）',
    privateKeyHint: '粘贴 OpenSSH 私钥全文（以 -----BEGIN 开头）。填了私钥就无需口令',
    rootLabel: '音乐库根目录（可选）',
    rootPlaceholder: '如：/volume1/music 或 music，留空表示登录目录',
  },
  /**
   * SMB / CIFS（Windows 共享）。
   */
  smb: {
    title: 'SMB',
    desc: '访问 Windows 共享或 NAS 的 SMB 共享目录',
    hostLabel: '主机',
    hostPlaceholder: '如：nas.example.com 或 192.168.1.10',
    portLabel: '端口（默认 445）',
    portPlaceholder: '445',
    shareLabel: '共享名',
    sharePlaceholder: '如：music',
    shareHint: '共享名是路径的第一段，不是完整路径（如 //nas/music 里的 music）',
    domainLabel: '域（可选）',
    domainPlaceholder: '如：WORKGROUP',
    usernameLabel: '用户名',
    passwordLabel: '口令',
    passwordHint: '口令经系统密钥加密后保存在本机，不会写入配置文件',
    rootLabel: '共享内子目录（可选）',
    rootPlaceholder: '如：Music，留空表示共享根目录',
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
  /**
   * 插件管理（安装 / 卸载 / 目录）。
   *
   * 命名轴是**安装来源**而不是技术形态：用户看到的是「我从网上装了一个」「我选了个文件」，
   * 而不是「这是声明式清单」——后者是实现的说法，不是用户的说法。
   * 权限与主机必须逐条展示（见 docs/plugins.md「权限：插件申请什么，就要让用户看见什么」）。
   */
  plugins: {
    title: '插件',
    desc: '插件为播放器补充能力（音源、歌词）。内置插件随应用发布，也可以从网址或本地文件安装第三方插件',
    pickTitle: '选择插件清单',
    allFiles: '所有文件',
    /** 列表 */
    installed: '已安装',
    builtin: '内置',
    listEmpty: '还没有安装任何第三方插件',
    listBroken: '有 {count} 个插件文件读取失败',
    brokenHint: '这些文件不符合插件清单格式，或内容与被安装时不一致（可能被修改过）',
    removeBroken: '删除该文件',
    openDir: '打开插件目录',
    /**
     * 启动时的插件异常提示。
     *
     * 措辞的关键是**先说"不影响使用"**：用户看到"插件出错"第一反应是"我是不是得修"，
     * 而这件事的正确答案是"不用，其他功能照常"。第二句才说他能做什么。
     */
    startupWarning: '{count} 个插件没能正常加载，它们的音源暂不可用。软件其余功能不受影响',
    startupWarningAction: '查看',
    startupFailedList: '启动时未能加载',
    startupFailedHint: '这些插件在加载阶段出错，因此没有出现在上面的列表里。可以重新安装或删除它们所在目录',
    /** 安装 */
    install: '安装插件',
    installFromUrl: '从网址安装',
    installFromFile: '从本地文件安装',
    urlLabel: '插件清单地址',
    urlPlaceholder: 'https://example.com/aurora-plugin.json',
    installHint: '清单是一份 JSON 描述文件，安装时不会执行任何代码',
    installing: '正在安装…',
    installingWait: '上一个安装还没结束，请稍候',
    installedOk: '已安装「{name}」',
    installFailed: '安装失败：{reason}',
    /** 权限确认（安装前逐条列出） */
    permissionTitle: '该插件申请的权限',
    permissionNetwork: '访问这些域名：{hosts}',
    permissionCredential: '保存登录凭证（加密存放在本机）',
    /** B 档：会运行第三方代码 —— 措辞必须与 A 档的「只发 HTTP 请求」明显不同 */
    permissionScript: '在本机沙箱内运行插件作者提供的脚本代码（可发网络请求，读不到你的文件）',
    permissionNone: '不需要额外权限',
    /** 安装前尚未取到清单时的域名占位（列不出就是列不出，不假装列出） */
    pendingHosts: '（安装后会在此显示具体域名）',
    /** 卸载 */
    uninstall: '卸载',
    uninstallConfirmTitle: '卸载插件「{name}」？',
    uninstallConfirmBody: '卸载后，使用该插件的音源会立即失效。已保存的登录凭证同时被删除。',
    uninstalledOk: '已卸载「{name}」',
    uninstallFailed: '卸载失败：{reason}',
    /** 能力徽章（与 capability.* 分开：这里是插件管理页的短标签） */
    capability: {
      search: '搜索',
      resolveTrack: '取址',
      playlistParse: '歌单',
      lyrics: '歌词',
      storage: '存储',
      script: '脚本源',
      recommendPlaylists: '推荐',
      toplists: '榜单',
      none: '无',
    },
    /**
     * 插件启停。
     *
     * 措辞要把它与「卸载」区分开，否则用户会以为关掉等于删了：
     * 停用**不动磁盘**，插件仍在列表里，凭证与音源配置都保留，只是不再参与执行。
     *
     * 另一点必须说清：停用的是**这一个插件**（它的全部音源），不是某一条音源配置。
     * 用户想只关掉某一条源时该去改那条源的开关，这两层不能混。
     */
    enableTitle: '已启用，点击停用',
    disableTitle: '已停用，点击启用',
    /**
     * 停用态说明。
     *
     * 不能只写"已停用"：用户真正要知道的是"停用之后会发生什么" ——
     * 哪些东西不再工作、有没有被删掉。所以这句把两个后果都写出来。
     */
    disabledHint: '已停用：它的音源与存储暂时不参与工作。配置和登录凭证都还在，随时可以重新启用',
    enableFailed: '操作失败：{reason}',
    toggleUnsupported: '当前环境不支持管理插件启停（请使用桌面端）',
    /** 校验问题（清单结构不对时逐条展示，path 指到具体字段） */
    issue: {
      title: '清单内容有问题',
      field: '字段：{path}',
      notObject: '清单必须是一个 JSON 对象',
      missing: '缺少必填项',
      invalidFormat: '不是本应用支持的插件格式',
      invalidId: '插件标识格式不对（小写字母开头，只能用字母、数字、点、下划线、短横）',
      invalidVersion: '版本号格式不对（如 1.0.0）',
      invalidType: '字段类型不对',
      invalidUrl: '地址无效（需以 http:// 或 https:// 开头）',
      empty: '不能为空',
      wildcardHost: '域名不能使用通配符，必须写具体域名',
      unsupportedPermission: '本应用不支持该权限',
      unsupportedDomain: '本应用不支持该能力类型',
      noCapability: '至少要声明一种能力（音源或歌词）',
      duplicate: '重复或冲突',
    },
    /** 安装失败的结构化原因（键路径即错误码） */
    error: {
      busy: '正在安装上一个插件，请稍候再试',
      builtinId: '「{id}」是内置插件，不能用同名清单覆盖',
      duplicateId: '已经安装过同标识的插件：{id}（请先卸载）',
      hashMismatch: '插件内容与预期不一致，已拒绝安装',
      notInstalled: '该插件不在已安装列表里',
      notUtf8: '文件不是 UTF-8 编码的文本',
      badJson: '文件不是合法的 JSON：{reason}',
      pathOutsideRoot: '只能删除插件目录内的文件',
      scriptHashMismatch: '脚本内容与插件声明的不一致，已拒绝安装',
      scriptFetchFailed: '下载插件脚本失败：{reason}',
    },
  },
  /**
   * 插件设置面板（「设置 → 插件」里每个插件自己的配置入口）。
   *
   * 配置全部按插件归属搬进来之后，面板本身就是「这个插件的全部设置」，
   * 所以这里按**面板骨架**分组（音源 / 存储 / 登录，各自的空态与计数），
   * 而不是按表单字段：字段名由插件自己的声明式 `fields` 提供，
   * 骨架上的字才是各插件共用、放这里才不会每加一个插件就复写一遍的部分。
   *
   * 三个分区的 hint 各写一句「配置完能干什么」，因为用户在这一层才第一次
   * 同时看到它们 —— 只说「音源」「存储」而不说用途，等于让用户自己猜。
   */
  config: {
    open: '配置',
    title: '「{name}」的设置',
    desc: '这个插件的全部配置都在这里，改完立即生效',
    sectionSources: '音源',
    sectionSourcesHint: '这些音源负责在线搜索与歌单导入',
    sectionStorage: '网络存储',
    sectionStorageHint: '配好后可测试连接并扫描入库',
    sectionAuth: '登录',
    sectionAuthHint: '登录后可用该插件的账号能力',
    sourceEmpty: '还没有音源',
    storageEmpty: '还没有网络存储',
    noConfig: '这个插件没有可配置项',
    countSources: '{count} 条音源',
    countStorage: '{count} 条存储',
  },
}

export default sources
