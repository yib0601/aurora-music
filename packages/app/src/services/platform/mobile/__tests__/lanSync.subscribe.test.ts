/**
 * 移动端局域网同步的**事件订阅**契约（`../lanSync.ts` 的 `subscribeNative`）。
 *
 * 这一层钉的是一个真机事故：v0.8.11 启动即黑屏，根因是订阅时无脑
 * `plugin.addListener(...).then(...)`。Capacitor 的 `addListener` 有两种返回形状 ——
 *   · 有 JS 包的插件（`registerPlugin` 代理）→ Promise；
 *   · 纯原生插件（本项目这些，Capacitor 注入的 shim）→ **同步** `{ remove }`。
 * 纯原生那种在真机上 `.then` 不存在，异常从 App 挂载的 effect 冒到 React，整棵树卸载。
 *
 * 单测环境是 node（没有 `window`），这里手动造一个最小的 `window.Capacitor.Plugins.LanSync`，
 * 两种形状各跑一遍：既要有 `.then` 时不炸，也要没有 `.then` 时不炸。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onMobileLanInbox } from '../lanSync'

interface ListenerRecord {
  eventName: string
  callback: (data: unknown) => void
}

const state = vi.hoisted(() => ({
  /** 插件收到的订阅请求 */
  listeners: [] as ListenerRecord[],
  /** 句柄上的 remove 被调用次数 */
  removed: 0,
}))

function installPlugin(addListener: (eventName: string, cb: (data: unknown) => void) => unknown): void {
  const plugin = {
    status: async () => ({ deviceId: 'device-0000' }),
    setEnabled: async () => ({}),
    addListener: (eventName: string, callback: (data: unknown) => void) => {
      state.listeners.push({ eventName, callback })
      return addListener(eventName, callback)
    },
  }
  ;(globalThis as unknown as { window: unknown }).window = { Capacitor: { Plugins: { LanSync: plugin } } }
}

/** 模拟原生侧推事件 */
function emit(payload: unknown): void {
  for (const listener of state.listeners) listener.callback(payload)
}

beforeEach(() => {
  state.listeners = []
  state.removed = 0
})

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window
})

describe('移动端局域网同步：订阅原生事件', () => {
  it('纯原生 shim 的同步句柄（真机形状）也能订阅，不再抛 TypeError', () => {
    installPlugin(() => ({
      remove: async () => {
        state.removed += 1
      },
    }))

    const received: unknown[] = []
    const unsubscribe = onMobileLanInbox((snapshots) => received.push(snapshots))

    expect(state.listeners).toHaveLength(1)
    expect(state.listeners[0].eventName).toBe('inbox')

    emit({ snapshots: [{ format: 'aurora/1', deviceId: 'peer-0001' }] })
    expect(received).toHaveLength(1)

    unsubscribe()
    expect(state.removed).toBe(1)

    // 退订之后再来事件不该再回灌给业务回调
    emit({ snapshots: [{ format: 'aurora/1', deviceId: 'peer-0002' }] })
    expect(received).toHaveLength(1)
  })

  it('Promise 形状（registerPlugin 代理）照旧可用', async () => {
    installPlugin(async () => ({
      remove: async () => {
        state.removed += 1
      },
    }))

    const received: unknown[] = []
    const unsubscribe = onMobileLanInbox((snapshots) => received.push(snapshots))
    await Promise.resolve()

    emit({ snapshots: [{ format: 'aurora/1', deviceId: 'peer-0001' }] })
    expect(received).toHaveLength(1)

    unsubscribe()
    expect(state.removed).toBe(1)
  })

  it('订阅还没落地就退订：落地后立刻摘掉监听器，不泄漏', async () => {
    installPlugin(async () => ({
      remove: async () => {
        state.removed += 1
      },
    }))

    const unsubscribe = onMobileLanInbox(() => {})
    unsubscribe()
    await Promise.resolve()
    await Promise.resolve()

    expect(state.removed).toBe(1)
  })

  it('插件同步抛错时只吞掉订阅失败，不影响调用方继续渲染', () => {
    installPlugin(() => {
      throw new Error('plugin unavailable')
    })

    expect(() => onMobileLanInbox(() => {})()).not.toThrow()
  })
})
