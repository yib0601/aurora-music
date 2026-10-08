# 音源协议

> 应用不内置任何音源：在线搜索、歌词匹配与歌单解析都依赖用户自行配置的 HTTP 接口，
> 或按洛雪格式自备的音源脚本（设置 → 在线源）。**一条音源同时提供这三种能力**。

## aurora 音源服务

填一条服务地址即可，端点优先读服务端的自描述（`GET {服务地址}/` 响应里的 `endpoints`），
读不到按默认路径组装；密钥可直接写在链接里（`https://host?key=xxx`），「测试连接」会校验连通性与密钥。

| 能力 | 默认端点 |
|---|---|
| 搜索 | `/aurora?query={query}&quality={quality}&key=` |
| 歌词 | `/aurora/lyric?track={track}&artist={artist}&duration={duration}&key=` |
| 歌单解析 | `/aurora/playlist?url={url}&key=` |
| 推荐 / 榜单 | `/aurora/recommend`、`/aurora/toplists`、`/aurora/toplist` |

响应为 JSON 数组，或 `{results:[]}` / `{data:[]}` / `{songs:[]}` / `{list:[]}` 包裹。
搜索每项 `audioUrl` 必填，另有 `title` / `artist` / `album` / `duration` / `coverUrl`，
多音质用 `qualityUrls` 或 `url_128` / `url_320` / `url_flac`；歌词兼容
`syncedLyrics` / `lrc` / `lyric` / `plainLyrics`，全部音源未命中时回落内置 LRCLIB。
链接含 `{query}` 时按「接口模板」原样使用（该形态没有歌词能力）。

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
