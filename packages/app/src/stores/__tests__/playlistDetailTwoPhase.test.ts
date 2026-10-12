import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 歌单详情两段式加载的行为回归。
 *
 * 钉住三件事（都是「首屏快」与「列表别被补齐失败打翻」的关键）：
 *  1. 首次请求带 `?limit=`（首屏只取一页），源回 `truncated` 时再补一次全量；
 *  2. 老源不给 `truncated` → 只请求一次，不白发一次全量；
 *  3. 补全量失败 → 静默保留首屏曲目，不把已经显示出来的列表换成错误态。
 *
 * 用 `vi.mock('@aurora/shared')` 把执行器换成受控替身：这里测的是**编排**，
 * 协议执行器自身的替换/剔除占位符行为由 shared 的 playlistResolver 测试覆盖。
 */
vi.mock('@aurora/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aurora/shared')>()
  return { ...actual, parsePlaylistLink: vi.fn() }
})

const { parsePlaylistLink } = await import('@aurora/shared')
const { useMusicHallStore } = await import('@/stores/musicHallStore')
const { useLibraryStore } = await import('@/stores/libraryStore')

const mocked = vi.mocked(parsePlaylistLink)

const SONG_A = { title: '七里香', artist: '周杰伦' }
const SONG_B = { title: '晴天', artist: '周杰伦' }

beforeEach(() => {
  mocked.mockReset()
  useMusicHallStore.setState({ playlistDetail: {} })
  // 一条服务地址形态的音源：歌单解析能力由协议派生
  useLibraryStore.setState({
    onlineSources: [
      {
        id: 'src-1',
        name: '我的音源',
        sourceUrl: 'https://music.example.com?key=K1',
        enabled: true,
      },
    ] as never,
  })
})

describe('歌单详情两段式加载', () => {
  it('首屏带 limit，truncated 后再补全量', async () => {
    mocked
      .mockResolvedValueOnce({ name: '大歌单', songs: [SONG_A], truncated: true })
      .mockResolvedValueOnce({ name: '大歌单', songs: [SONG_A, SONG_B] })

    await useMusicHallStore.getState().loadPlaylistDetail('647')

    expect(mocked).toHaveBeenCalledTimes(2)
    expect(mocked.mock.calls[0][2]).toEqual({ limit: 200 })
    expect(mocked.mock.calls[1][2]).toBeUndefined()

    const entry = useMusicHallStore.getState().playlistDetail['647']
    expect(entry.loading).toBe(false)
    expect(entry.error).toBeNull()
    expect(entry.data?.name).toBe('大歌单')
    expect(entry.data?.songs).toHaveLength(2)
  })

  it('老源不给 truncated 时只请求一次（不白发全量）', async () => {
    mocked.mockResolvedValueOnce({ name: '小歌单', songs: [SONG_A] })

    await useMusicHallStore.getState().loadPlaylistDetail('66')

    expect(mocked).toHaveBeenCalledTimes(1)
    expect(useMusicHallStore.getState().playlistDetail['66'].data?.songs).toHaveLength(1)
  })

  it('补全量失败时保留首屏曲目，不改成错误态', async () => {
    mocked
      .mockResolvedValueOnce({ name: '大歌单', songs: [SONG_A], truncated: true })
      .mockRejectedValueOnce(new Error('补齐失败'))

    await useMusicHallStore.getState().loadPlaylistDetail('647')

    const entry = useMusicHallStore.getState().playlistDetail['647']
    expect(entry.error).toBeNull()
    expect(entry.data?.songs).toEqual([SONG_A])
  })

  it('首屏就失败才进错误态', async () => {
    mocked.mockRejectedValueOnce(new Error('首屏失败'))

    await useMusicHallStore.getState().loadPlaylistDetail('647')

    const entry = useMusicHallStore.getState().playlistDetail['647']
    expect(entry.data).toBeNull()
    expect(entry.error).toBeTruthy()
  })
})
