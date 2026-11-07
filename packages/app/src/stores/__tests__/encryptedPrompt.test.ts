/**
 * 「扫描到加密歌曲 → 自动弹窗提示」的**去重**回归。
 *
 * 这条链路最容易出的错是打扰用户而不是功能坏掉：扫描是高频的
 * （启动一次 + 手动重扫 + 文件变化触发的增量重扫都会重报同一批文件），
 * 只要去重写错，就会变成「每扫一次弹一次窗」，用户只能被逼着关掉提示。
 *
 * 要钉住的四条：
 *   1. 同一批文件只提示一次（关掉后再扫描不重弹）；
 *   2. 新出现的文件仍然提示（不能因为「提示过一次」就永久闭嘴）；
 *   3. 用户点「忽略」（清空列表）之后，同一批文件重扫不再提示；
 *   4. 弹窗已经开着时不再叠开，也不提前记账。
 */
import { describe, expect, it, vi } from 'vitest'
import type { EncryptedAudioFile } from '@/types'

const STORAGE_KEY = 'aurora-library-state'

function installLocalStorage(): Map<string, string> {
  const bag = new Map<string, string>()
  const storage = {
    getItem: (key: string) => (bag.has(key) ? (bag.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      bag.set(key, String(value))
    },
    removeItem: (key: string) => {
      bag.delete(key)
    },
    clear: () => bag.clear(),
    key: (index: number) => [...bag.keys()][index] ?? null,
    get length() {
      return bag.size
    },
  }
  ;(globalThis as unknown as { window: unknown }).window = { localStorage: storage }
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = storage
  return bag
}

/** 每个用例从干净单例开始；persist 的 hydrate 是异步的，必须等它 */
async function freshStore() {
  vi.resetModules()
  const bag = installLocalStorage()
  const mod = await import('../libraryStore')
  const persistApi = (
    mod.useLibraryStore as unknown as { persist?: { rehydrate: () => Promise<void> } }
  ).persist
  await persistApi?.rehydrate?.()
  return { store: mod.useLibraryStore, bag }
}

function file(path: string, title = '十年'): EncryptedAudioFile {
  return { path, family: 'qqmusic', token: 'mflac0', title, artist: '陈奕迅' }
}

describe('promptEncryptedIfNew', () => {
  it('首次扫到加密文件时开弹窗', async () => {
    const { store } = await freshStore()
    store.getState().addEncryptedFile(file('/m/a.mflac0.flac'))

    store.getState().promptEncryptedIfNew()

    expect(store.getState().encryptedDialogOpen).toBe(true)
  })

  it('同一批文件只提示一次：关掉后重扫不重弹', async () => {
    const { store } = await freshStore()
    store.getState().addEncryptedFile(file('/m/a.mflac0.flac'))
    store.getState().promptEncryptedIfNew()
    store.getState().closeEncryptedDialog()

    // 模拟下一次扫描：同一批文件重新上报
    store.getState().addEncryptedFile(file('/m/a.mflac0.flac'))
    store.getState().promptEncryptedIfNew()

    expect(store.getState().encryptedDialogOpen).toBe(false)
  })

  it('出现新文件时仍然提示', async () => {
    const { store } = await freshStore()
    store.getState().addEncryptedFile(file('/m/a.mflac0.flac'))
    store.getState().promptEncryptedIfNew()
    store.getState().closeEncryptedDialog()

    store.getState().addEncryptedFile(file('/m/b.mflac0.flac', '富士山下'))
    store.getState().promptEncryptedIfNew()

    expect(store.getState().encryptedDialogOpen).toBe(true)
  })

  it('忽略（清空列表）后同一批文件不再提示，但新文件照常提示', async () => {
    const { store } = await freshStore()
    store.getState().addEncryptedFile(file('/m/a.mflac0.flac'))
    store.getState().promptEncryptedIfNew()
    store.getState().closeEncryptedDialog()
    store.getState().clearEncryptedFiles()

    // 重扫把同一批文件又报上来
    store.getState().addEncryptedFile(file('/m/a.mflac0.flac'))
    store.getState().promptEncryptedIfNew()
    expect(store.getState().encryptedDialogOpen).toBe(false)

    store.getState().addEncryptedFile(file('/m/新歌.mflac0.flac', '新歌'))
    store.getState().promptEncryptedIfNew()
    expect(store.getState().encryptedDialogOpen).toBe(true)
  })

  it('没有加密文件时不开弹窗', async () => {
    const { store } = await freshStore()
    store.getState().promptEncryptedIfNew()
    expect(store.getState().encryptedDialogOpen).toBe(false)
  })

  it('弹窗已开着时不重复开，也不提前记账', async () => {
    const { store } = await freshStore()
    store.getState().addEncryptedFile(file('/m/a.mflac0.flac'))
    store.getState().promptEncryptedIfNew()
    const prompted = store.getState().encryptedPromptedPaths

    store.getState().addEncryptedFile(file('/m/b.mflac0.flac', '新歌'))
    store.getState().promptEncryptedIfNew()

    // 已经开着：不追加记账，关掉之后这批新文件仍会在下次扫描时提示
    expect(store.getState().encryptedPromptedPaths).toEqual(prompted)
    expect(store.getState().encryptedDialogOpen).toBe(true)
  })

  it('列表、开关与「已提示」记账都不落盘（重启后重新提示一次是预期行为）', async () => {
    const { store, bag } = await freshStore()
    store.getState().addEncryptedFile(file('/m/a.mflac0.flac'))
    store.getState().promptEncryptedIfNew()

    const raw = bag.get(STORAGE_KEY)
    expect(raw, 'persist 没有写任何东西').toBeTruthy()
    const persisted = (JSON.parse(raw as string) as { state: Record<string, unknown> }).state
    // 这三项都是本会话的运行期状态：落盘只会与磁盘现实脱节（文件可能已被删/换目录）
    expect(persisted.encryptedFiles).toBeUndefined()
    expect(persisted.encryptedDialogOpen).toBeUndefined()
    expect(persisted.encryptedPromptedPaths).toBeUndefined()
  })
})
