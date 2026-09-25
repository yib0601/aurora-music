import type { OnlineSourceConfig, PlaylistResolverConfig } from './types'

/**
 * 音源合并迁移（持久化数据 v9）：
 * v0.4.x 的「歌单解析源」是独立列表（PlaylistResolverConfig），音源与它分别配置；
 * 现两者合并为一条音源（OnlineSourceConfig.playlistUrl）。
 *
 * 迁移规则：
 * 1. 解析地址与某条音源的搜索地址同主机 → 挂到那条音源上（一条音源两种能力）；
 * 2. 找不到同主机音源 → 转为「只做歌单解析」的音源（apiUrl 留空，不参与在线搜索）；
 * 3. 地址不含 {url} 的旧条目丢弃（本就不是歌单解析接口）。
 * 纯函数：不修改入参数组，返回新的音源列表，便于单测。
 */
export function mergeLegacyPlaylistSources(
  onlineSources: OnlineSourceConfig[] | null | undefined,
  legacySources: PlaylistResolverConfig[] | null | undefined,
  makeId: () => string = defaultId
): OnlineSourceConfig[] {
  const merged: OnlineSourceConfig[] = (Array.isArray(onlineSources) ? onlineSources : [])
    .filter((s): s is OnlineSourceConfig => Boolean(s))
    .map((s) => ({ ...s }))
  const legacy = Array.isArray(legacySources) ? legacySources : []

  for (const p of legacy) {
    if (!p) continue
    const apiUrl = typeof p.apiUrl === 'string' ? p.apiUrl : ''
    if (!apiUrl.includes('{url}')) continue

    const host = hostOf(apiUrl)
    const target = host
      ? merged.find(
          (s) => typeof s.apiUrl === 'string' && s.apiUrl && !s.playlistUrl && hostOf(s.apiUrl) === host
        )
      : undefined

    if (target) {
      target.playlistUrl = apiUrl
      if (!target.name && p.name) target.name = p.name
      if (!target.headers && p.headers) target.headers = p.headers
      continue
    }

    merged.push({
      id: p.id || makeId(),
      name: p.name || '歌单解析源',
      apiUrl: '',
      playlistUrl: apiUrl,
      ...(p.headers ? { headers: p.headers } : {}),
      enabled: p.enabled !== false,
    })
  }

  return merged
}

/** 取 URL 主机名（判断「同一音源服务的两个端点」）；解析失败返回空串 */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function defaultId(): string {
  return `src-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}
