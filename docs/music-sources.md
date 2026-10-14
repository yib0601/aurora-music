# 音源协议

> 应用不内置任何音源：在线搜索、歌词匹配与歌单解析都依赖用户自行配置的 HTTP 接口，
> 或按洛雪格式自备的音源脚本（设置 → 在线源）。**一条音源同时提供这几种能力**。

## aurora 音源服务

填一条服务地址即可，端点优先读服务端的自描述（`GET {服务地址}/` 响应里的 `endpoints`），
读不到按默认路径组装；密钥可直接写在链接里（`https://host?key=xxx`），「测试连接」会校验连通性与密钥。

| 能力 | 默认端点 |
|---|---|
| 搜索 | `/aurora?query={query}&quality={quality}&key=` |
| 单曲取址 | `/aurora/track?id={id}&quality={quality}&key=` |
| 歌词 | `/aurora/lyric?track={track}&artist={artist}&duration={duration}&key=` |
| 歌单解析 | `/aurora/playlist?url={url}&key=` |
| 推荐 / 榜单 | `/aurora/recommend`、`/aurora/toplists`、`/aurora/toplist` |

响应为 JSON 数组，或 `{results:[]}` / `{data:[]}` / `{songs:[]}` / `{list:[]}` 包裹。
搜索每项 `audioUrl` 必填，另有 `title` / `artist` / `album` / `duration` / `coverUrl`，
多音质用 `qualityUrls` 或 `url_128` / `url_320` / `url_flac`；歌词兼容
`syncedLyrics` / `lrc` / `lyric` / `plainLyrics`，全部音源未命中时回落内置 LRCLIB。
链接含 `{query}` 时按「接口模板」原样使用（该形态没有歌词与取址能力，那两项无从派生）。

### 单曲取址：曲目已定就别按名重搜

曲目**已经定了**的时候（重启后的播放队列、导入歌单、音乐馆榜单与歌单条目按约定都不持久化
直链——直链几十分钟即过期），应用按**源内 id** 向 `/aurora/track` 取址，而不是拿
「歌名 + 歌手」重搜一遍：同名不同版本（变速版 / 翻唱 / DJ 版 / Live）按名匹配时与目标
同分，会串到别人的录音——元数据、时长、歌词都是原唱，播出来却是另一条（实测：《雨天》
汪苏泷 274s 的原唱被判给「雨天 (变速版)」115s 那条，界面显示 4:34、播放条显示 1:55）。

```json
{ "songmid": "002A97IJ2D6KYA", "found": true, "reason": null,
  "track": { "songmid": "002A97IJ2D6KYA", "title": "雨天", "artist": "汪苏泷", "duration": 274 },
  "results": [ { "audioUrl": "…", "quality": "128", "qualityUrls": { "128": "…" } } ],
  "quality": { "requested": null, "effective": "128" } }
```

- 应用只认 `id` 与 `results[0].audioUrl`，其余字段（`songmid` / `quality` / `qualityUrls` /
  `coverUrl` / `duration` / `track`）全部可选：实现了就回填，不实现也能用。
- `found=false`（`reason=not-found`）表示源端没有这条 id；`found=true` 而 `results` 为空表示
  有这条曲目但取不到直链（无权益等）。两种失败都让应用**回落按名搜索**，所以老服务端不实现
  这个端点只是回到旧路径，不会播不出来。
- 搜索与歌单响应里带 `songmid` 时，应用会把它存成曲目的源内 id（缺省回落条目 `id`）；
  取址时若遇到历史形态的 `<来源 id>-<id>`（早期搜索条目把来源拼进了 id）会自动剥前缀，
  但新服务端回填 `songmid` 才是正路。

## 洛雪音源脚本

可直接使用[洛雪音乐](https://github.com/lyswhut/lx-music-desktop)（桌面版 / 手机版）的用户自定义
音源脚本：添加脚本链接（GitHub Raw、jsDelivr 或自建托管均可），源码不落库。脚本在客户端沙箱内
执行：`document` / `navigator` / `location` / `localStorage` 与 Node 标识一律置为 `undefined`，
网络请求只能经宿主的 `lx.request` 转发，拿不到宿主配置、数据库与文件系统接口。

绝大多数脚本只实现 `musicUrl`、没有公共搜索接口，因此搜索走你自己的搜索音源，取址再把曲目的
平台标识交给脚本（酷我 `kw` / 酷狗 `kg` 用 `hash` | `songmid`；QQ `tx` / 网易 `wy` 用 `songmid`，
网易另认 `id`；咪咕 `mg` 用歌名 + 歌手）。取址**按需**触发：搜到的条目只有元信息，播放或下载时
才取直链回填队列，不写库也不落盘；脚本源没有歌词能力。

## WebDAV 媒体库（桌面端）

与在线音源不同，这是入库的持久曲库来源：配置服务器地址、账号与口令，测试连接后扫描入库。
口令仅存本机；移除来源会连同其曲目一起从曲库删除（远端文件不受影响）。

> 应用不内置、也不推荐任何源站。
