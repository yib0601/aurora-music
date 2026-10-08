/**
 * shared 底层文案（音源协议执行器、媒体库、WebDAV、歌单解析、封面嵌入等）。
 *
 * 这是「从底层支持多语言」的那一层：执行器抛出的错误若在这里就烧成中文字面量，
 * 渲染层拿到时已经无从翻译。因此本域的铁律是——
 *   **文案只以字典键 + 参数的形式离开这一层**（AuroraError('core.error.xxx', params)）。
 *
 * 三种形态的取值口径（对应本域的三种「对外文本」）：
 *   1. 抛出的错误、探测/迁移返回的**结论与原因**文本 → 走 errors.ts 的结构化信封
 *      （`auroraError(code, params).message`），显示端 `translateError(err, t)` 渲染；
 *      带参数与不带参数一视同仁，显示端因此只有一条规则。
 *   2. **展示名**（平台名、能力行）→ 直接给文案键，显示端在渲染期 `t(key)` 取值。
 *   3. 纯数据（源名、文件名）→ 走 `translateDefault`（源语言）取值，因为它们是**落盘数据**，
 *      不该随界面语言漂移（见 sourceName 分组）。
 *
 * 例外：供匹配/比较用的领域数据（平台标识、繁简映射、版本标记词、未知艺术家这类
 * 占位值）不是文案，不得进字典，也不得被翻译，否则匹配逻辑会随语言漂移。
 */
const core = {
  /** 平台展示名（协议标识 → 界面文案）；标识串本身见 LX_KNOWN_PLATFORMS，不翻译 */
  platform: {
    kw: '酷我',
    kg: '酷狗',
    tx: 'QQ',
    wy: '网易',
    mg: '咪咕',
    git: 'Git',
    local: '本地',
  },

  /** 服务源端点 → 能力行的展示名（脚本源的平台名见 platform 分组） */
  probe: {
    endpoint: {
      search: '在线搜索',
      playlist: '歌单解析',
      recommend: '推荐歌单',
      toplists: '榜单列表',
      toplist: '榜单详情',
    },
    /** 脚本源探测成功 */
    lxOk: '脚本可用',
    /** 服务源探测结论（密钥校验结果见 serviceKeyRejected 错误码） */
    serviceKeyOk: '连接正常，密钥有效',
    serviceKeyUnverified: '服务在线，但未能校验密钥（/health 不可达）',
    serviceOnline: '服务在线（未填密钥）',
    serviceOnlineNoSelfDescription: '服务在线，但未读到端点自描述，将按默认 /aurora 路径组装',
    /** 网络存储探测结论：带计数，走结构化信封送出 */
    webdavOk: '连接成功：根目录下 {dirs} 个子目录、{files} 个文件',
    webdavOkWithAudio: '连接成功：根目录下 {dirs} 个子目录、{files} 个文件，其中 {audio} 个音频',
  },

  /**
   * 迁移时写进用户配置的默认源名。
   *
   * 它们是**持久化数据**（用户可改），不是界面文案，所以一律按源语言取值
   * （`translateDefault`）：同一份配置在切换界面语言后不该改名，否则同一张音源卡片
   * 会在中英界面下显示成两个名字，收藏/引用它的地方也会各说各话。
   */
  sourceName: {
    default: '音源',
    lx: '洛雪音源',
    playlist: '歌单解析源',
  },

  /**
   * 本域错误码。
   *
   * 命名：`core.error.<域><用途>`，域与模块一一对应（lx / source / lyrics / hall /
   * webdav / playlist / form / service）。文案里给的是**原因**，不重复「失败」二字之前
   * 已经在报错语境里的状态词；命令式提示（请检查…）只留在确有必要的地方。
   */
  error: {
    // ── 洛雪脚本宿主（lxHost / lxResolver） ──────────────────────────
    lxHostNotReady: '洛雪音源宿主未初始化（缺少 lx.request 实现）',
    lxCallTimeout: '脚本「{source}」处理 {action} 超时（{ms}ms）',
    lxNoRequestHandler: '脚本未注册 request 事件',
    lxNotInited: '脚本未完成初始化（未收到 inited）',
    lxNoPlatforms: '脚本未声明任何可用平台',
    lxScriptEmpty: '脚本内容为空',
    lxInitFailed: '脚本初始化失败',
    lxSourceNoScript: '洛雪音源「{name}」没有脚本内容',
    lxSearchFailed: '洛雪脚本搜索无结果（{count} 个平台均未返回）',
    lxPlatformUnsupported: '脚本「{name}」不支持平台 {platform}',
    lxUrlInvalid: '脚本返回的地址无效',
    lxResolveFailed: '取址失败',
    lxScriptDownload: '脚本下载失败：HTTP {status}',
    lxScriptTooLarge: '脚本体积异常（>{limit}MB），已放弃加载',
    lxTrackRefMissing: '曲目缺少洛雪取址定位信息（lx）',
    lxSourceNotFound: '未找到洛雪音源配置（id={id}）',
    lxNotScriptSource: '音源「{name}」不是洛雪脚本源（kind={kind}）',
    lxSourceDisabled: '洛雪音源「{name}」已停用',
    lxScriptUnavailable: '洛雪音源「{name}」的脚本源码不可得',
    lxMetaMissing: '平台 {platform} 取址缺少必要字段：{fields}',

    // ── 在线搜索执行器（musicSource） ────────────────────────────────
    sourceUrlNoQuery: '源「{name}」的接口地址无效，必须包含 {query} 占位符',
    sourceTimeout: '源「{name}」请求超时（{ms}ms）',
    sourceRequestFailed: '源「{name}」请求失败：{reason}',
    sourceHttpStatus: '源「{name}」返回 HTTP {status}',
    sourceUnavailable: '源不可用',
    allSourcesFailed: '所有音乐源请求失败，请检查网络连接或源配置',

    // ── 歌词执行器（lyricsSource） ──────────────────────────────────
    lyricsUrlNoPlaceholder: '歌词源「{name}」的接口地址无效，必须包含 {track} 或 {query} 占位符',
    lyricsTimeout: '歌词源「{name}」请求超时（{ms}ms）',
    lyricsRequestFailed: '歌词源「{name}」请求失败：{reason}',
    lyricsHttpStatus: '歌词源「{name}」返回 HTTP {status}',

    // ── 在线音乐读取执行器（musicHall） ──────────────────────────────
    hallTimeout: '音源「{name}」请求超时（{ms}ms）',
    hallRequestFailed: '音源「{name}」请求失败：{reason}',
    hallHttpStatus: '音源「{name}」返回 HTTP {status}',
    hallNotJson: '音源「{name}」返回的不是 JSON',

    // ── 歌单解析执行器（playlistResolver） ───────────────────────────
    playlistUrlMissing: '音源「{name}」未配置歌单解析接口地址，需包含 {url} 占位符',
    playlistTimeout: '音源「{name}」请求超时（{ms}ms）',
    playlistRequestFailed: '音源「{name}」请求失败：{reason}',
    playlistHttpStatus: '音源「{name}」返回 HTTP {status}',
    playlistEmpty: '音源「{name}」未返回任何歌曲',
    playlistNoSource: '尚未配置可解析歌单的音源，请在设置页添加音源（填一条音源地址即可），或改用纯文本粘贴导入',
    playlistFailed: '歌单解析失败',

    // ── WebDAV 媒体库（webdav） ──────────────────────────────────────
    webdavConnect: '无法连接到网络存储「{name}」：{reason}',
    webdavAuth: '网络存储「{name}」鉴权失败（HTTP {status}），请检查用户名与口令',
    webdavPathMissing: '网络存储「{name}」路径不存在：{path}',
    webdavStatus: '网络存储「{name}」返回异常状态 HTTP {status}',
    webdavRead: '无法读取网络存储「{name}」：{reason}',

    // ── 设置页表单校验与服务探测（auroraPreset） ─────────────────────
    formLinkInvalid: '地址格式不正确，示例：{example}',
    formLinkPlaceholder: '地址需包含占位符：{placeholders}',
    serviceUrlInvalid: '服务地址格式不正确',
    serviceUnreachable: '连接失败：地址不可达或端口不正确',
    serviceStatus: '服务返回 {status}，请确认服务地址',
    serviceKeyRejected: '密钥不正确（服务端拒绝了该密钥）',
  },
}

export default core
