/**
 * 歌单同步（插件域 `sync`）
 *
 * 本文件由**单一 owner** 独占编辑（另一语言版本在同名 en/ 目录下，同一人一起改），
 * 以免多人同时改同一个字典文件产生写冲突。
 *
 * 编写约定（与 `sources.ts` 同）：
 * - 键名用英文小驼峰，按「插件名 / 字段 / 面板 / 状态 / 错误」分组；
 * - 插值用 `{name}`，且**两种语言的占位符集合必须一致**（一致性测试会判红）；
 * - `error.*` 是**结构化错误的显示端文案**：插件抛出点只给键路径
 *   （如 `sync.error.webdavAuth`），由 `translateError(err, t)` 在渲染期按语言取值；
 * - 平台自报的原文（HTTP 状态、异常类名）作为 `{status}` / `{reason}` 透出，不进字典。
 */
const sync = {
  /** 插件管理页的能力徽章（一个插件就一件本事） */
  capability: '歌单与收藏同步',

  /** 内置同步插件的展示名与说明 */
  plugin: {
    webdav: {
      name: 'WebDAV 同步',
      description: '用自己的网络存储同步歌单：坚果云、Nextcloud、Alist、群晖等任意 WebDAV',
    },
    lan: {
      name: '局域网同步',
      description: '在同一网段的设备之间直连同步，不需要任何服务器',
    },
  },

  /** WebDAV 链路的字段文案 */
  webdav: {
    baseUrlLabel: '服务地址',
    baseUrlPlaceholder: 'https://dav.example.com/dav',
    baseUrlHint: '填 WebDAV 的根地址（不含具体目录）。坚果云为 https://dav.jianguoyun.com/dav',
    rootLabel: '目录',
    rootPlaceholder: '/aurora-music',
    rootHint: '快照写在其中的 aurora-sync 子目录，目录不存在会自动创建',
    usernameLabel: '账号',
    passwordLabel: '应用密码',
    passwordHint: '口令由主进程 safeStorage 加密保存，不会写进配置文件',
  },

  /** 局域网链路的字段文案 */
  lan: {
    hostLabel: '对端地址',
    hostPlaceholder: '192.168.1.20',
    portLabel: '端口',
    portHint: '填对端「局域网同步」面板里显示的监听端口',
    codeLabel: '配对码',
    codePlaceholder: '对端的 10 位配对码',
    codeHint: '配对码要在对端设备上查看后手动填入；它不会随广播传播',
  },

  /** 同步面板（设置 → 插件 → 齿轮） */
  panel: {
    title: '歌单与收藏同步',
    description:
      '把歌单（名称、顺序与曲目）与收藏同步到其它设备。曲目按本机曲库重新匹配，找不到的会在歌单里以占位显示。',
    unsupported: '歌单与收藏同步需要桌面端或手机端应用。',
    privacyNote: '同步文件包含歌单名、曲目信息、收藏时间与本机文件路径；局域网传输是明文的，只建议在可信网络里使用。',
    conflictNote: '同一个歌单在两端都被修改时，以较新的那次改动为准；收藏按每首歌较晚的那次收藏/取消为准。',
    emptyTitle: '还没有同步目标',
    emptyDesc: '添加一个网络存储，或添加同一局域网里的另一台设备。',
    add: '添加同步目标',
    addTitle: '添加同步目标',
    editTitle: '编辑同步目标',
  },

  /** 配置表单 */
  config: {
    nameLabel: '名称',
    namePlaceholder: '例如：坚果云 / 书房台式机',
    directionLabel: '方向',
    directionBidirectional: '双向',
    directionBidirectionalHint: '两边的改动互相同步',
    directionPullOnly: '仅拉取',
    directionPullOnlyHint: '只把对端的歌单拿过来，不改动对端',
    directionPushOnly: '仅推送',
    directionPushOnlyHint: '只把自己的歌单推过去（适合备份机）',
    autoSync: '自动同步',
    autoSyncHint: '启动后、歌单变更后与每 5 分钟自动同步一次',
    save: '保存',
    cancel: '取消',
    delete: '删除',
    deleteTitle: '删除这个同步目标？',
    deleteDesc: '只删本机的配置与口令，对端已有的歌单不会被删除。',
    deleted: '已删除同步目标',
  },

  /** 卡片上的动作与状态 */
  card: {
    syncNow: '立即同步',
    test: '测试连接',
    testing: '连接中…',
    testOk: '连接正常',
    lastSyncNever: '尚未同步',
    lastSyncAt: '上次同步：{time}',
    lastError: '上次失败：{reason}',
    direction: '方向：{direction}',
    autoSyncOn: '自动同步已开',
    autoSyncOff: '自动同步已关',
  },

  /** 同步过程中的状态词（卡片角标） */
  state: {
    idle: '空闲',
    running: '同步中',
    ok: '已完成',
    failed: '失败',
  },

  /** 同步结果提示 */
  toast: {
    applied: '{count} 个歌单已更新',
    upToDate: '歌单已是最新',
    failed: '同步失败：{reason}',
  },

  /** 局域网面板：本机服务 + 发现 */
  server: {
    title: '本机服务',
    enable: '开启局域网同步',
    enableHint: '开启后本机会监听一个端口并广播自己的存在，供同一网段的设备发现',
    running: '正在监听端口 {port}',
    stopped: '未开启',
    codeLabel: '本机配对码',
    codeHidden: '点击显示',
    codeHint: '把这段配对码抄到对端设备上，对端才能写入你的歌单',
    copy: '复制',
    copied: '已复制配对码',
    rotate: '换一个配对码',
    rotated: '配对码已更新，旧码立即失效',
    rotateWarn: '换码后，已配对的设备需要重新填写新码。',
    plaintextNote: '局域网快照是明文传输：配对码只用来确认「谁有权写你的歌单」，不做加密。',
  },

  /** 局域网面板：发现附近设备 */
  discover: {
    scan: '扫描附近设备',
    scanning: '扫描中…',
    title: '发现的设备',
    empty: '没有发现设备。确认对方已开启局域网同步、在同一网段，且防火墙放行 UDP 45872。',
    online: '在线',
    offline: '离线',
    add: '添加为同步目标',
    added: '已添加设备 {name}',
    pair: '配对',
    pairing: '等待对端确认…',
    pairHint: '点「配对」后在对端屏幕上点一次「允许」即可，不需要抄配对码',
    manualAdd: '手动填码',
  },

  /** 一键配对（docs/playlist-sync.md §16）：两端各点一次，配对码不再手抄 */
  pair: {
    title: '配对请求',
    requestDesc: '「{name}」请求与这台设备同步歌单。允许后两边的歌单会互相同步。',
    allow: '允许',
    deny: '拒绝',
    waiting: '已向「{name}」发出配对请求，请在对端设备上点「允许」',
    paired: '已与「{name}」配对，双向同步已开启',
    denied: '对端拒绝了配对请求',
    timeout: '等待对端确认超时，请重试',
    unreachable: '连不上 {host}:{port}：确认对端已开启局域网同步，且在同一网段',
    unsupported: '对端版本不支持一键配对，请升级对端；也可改用「手动填码」',
    auth: '对端未能接收配对凭据，请重试；反复失败可改用「手动填码」',
    self: '不能与本机配对',
    busy: '对端正在处理另一个配对请求，稍后再试',
    invalid: '对端返回的数据无法识别，请把两端都升级到最新版本',
    expired: '配对请求已过期',
    cancelled: '已取消配对',
  },

  /** 结构化错误（插件抛出 → `translateError` 渲染） */
  error: {
    webdavAuth: '网络存储「{name}」认证失败：检查账号与应用密码',
    webdavStatus: '网络存储「{name}」返回 HTTP {status}',
    webdavConnect: '无法连接到网络存储「{name}」：{reason}',
    webdavPath: '网络存储「{name}」的目录不存在，且无法创建',
    snapshotInvalid: '同步文件格式不正确（{file}），已跳过',
    snapshotVersion: '同步文件版本不受支持（{format}），可能来自更新版本的应用',
    lanDisabled: '本机局域网同步服务未开启',
    lanUnreachable: '无法连接到设备 {host}:{port}',
    lanAuth: '对端拒绝了访问：配对码不正确，或对端已轮换配对码',
    lanProtocol: '对端协议版本不兼容（{protocol}），请把两台设备都升级到最新版本',
    missingSecret: '缺少口令：这台设备无法安全保存口令，请在桌面端配置',
    unknown: '同步失败：{reason}',
  },
}

export default sync
