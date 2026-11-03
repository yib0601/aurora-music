/**
 * Linux 真机链路（真实 session bus + 真实 MPRIS 播放器）→ provider → interlock。
 *
 * 与其余单测的分工：那些用假 bus 钉住失败分支，这里验证**真实 D-Bus 能真的暂停/恢复**——
 * 「D-Bus 方法名写对了」「PlaybackStatus 解析正确」这类问题只有真 bus 才暴露。
 *
 * 本机/开发机有会话总线时跑；CI runner 没有 session bus，整组按需跳过。
 * 用 mpris-service 在测试进程内起一个假播放器（它已是桌面端依赖，不引入新包）。
 */
import { describe, expect, it } from 'vitest'
import { AudioFocusInterlock } from '../interlock'
import { createLinuxProvider } from '../providers/linux'
import type { ExternalPlayer } from '../types'

/* eslint-disable @typescript-eslint/no-var-requires */
const Player = require('mpris-service') as (opts: unknown) => any
const NAME = 'org.mpris.MediaPlayer2.smoke-target'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const hasSessionBus = Boolean(process.env.DBUS_SESSION_BUS_ADDRESS)

describe.skipIf(!hasSessionBus)('真机链路：真实 session bus + 真实 MPRIS 播放器', () => {
  it('起播抢占 → 真的暂停；停止 → 真的归还并恢复播放', async () => {
    const fake = Player({ name: 'smoke-target', identity: 'Smoke Target', supportedInterfaces: ['player'] })
    fake.playbackStatus = 'Playing'
    fake.canPause = true
    fake.canPlay = true
    fake.on('pause', () => { fake.playbackStatus = 'Paused' })
    fake.on('play', () => { fake.playbackStatus = 'Playing' })

    // PID 过滤关掉：假播放器与测试同进程，否则会被自身排除（自身排除另有用例）
    const provider = createLinuxProvider({ selfPids: [] })
    const interlock = new AudioFocusInterlock()
    try {
      let list: ExternalPlayer[] = []
      for (let i = 0; i < 20 && !list.some((p) => p.id === NAME); i += 1) {
        list = await provider.list()
        if (!list.some((p) => p.id === NAME)) await sleep(200)
      }
      const target = list.find((p) => p.id === NAME)
      expect(target, '假播放器应出现在列举里: ' + JSON.stringify(list)).toBeTruthy()
      expect(target!.status).toBe('Playing')

      interlock.onSnapshot(list)
      const effects = interlock.onOursPlaying(true)
      expect(effects.pauseExternals).toEqual([NAME])
      await provider.pause(NAME)
      await sleep(300)
      const paused = (await provider.list()).find((p) => p.id === NAME)
      expect(paused?.status, 'Pause 应真的生效').toBe('Paused')

      interlock.onSnapshot([paused!])
      expect(interlock.onOursPlaying(false).scheduleResumeExternals).toBe(true)
      const due = interlock.onResumeExternalsDue()
      expect(due.resumeExternals).toEqual([NAME])
      await provider.play(NAME)
      await sleep(300)
      const resumed = (await provider.list()).find((p) => p.id === NAME)
      expect(resumed?.status, 'Play 应真的生效').toBe('Playing')
    } finally {
      await provider.dispose()
      fake.releaseName?.()
    }
  }, 20000)

  it('PID 自身排除：本进程持有的 MPRIS 名（Chromium 形态）不会进列表', async () => {
    const fake = Player({ name: 'chromium.instance999', identity: 'Chromium', supportedInterfaces: ['player'] })
    fake.playbackStatus = 'Playing'
    const provider = createLinuxProvider()
    try {
      await sleep(300)
      const names = (await provider.list()).map((p) => p.id)
      expect(names).not.toContain('org.mpris.MediaPlayer2.chromium.instance999')
    } finally {
      await provider.dispose()
      fake.releaseName?.()
    }
  }, 20000)
})
