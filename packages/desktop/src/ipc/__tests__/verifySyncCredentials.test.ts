/**
 * 对抗性验证（verifier 任务 task-4）用的**临时证据测试**。
 *
 * 钉住 docs/playlist-sync.md §10 / 用户 checklist 里最硬的一条安全要求：
 * **safeStorage 不可用时必须拒绝写明文口令**（而不是降级写盘）。
 *
 * 这里用假的 electron 模块把「有无 keyring」两种状态都跑一遍，
 * 断言 ①加密不可用时磁盘上不出现任何文件；②可用时落盘的是密文且权限 0600。
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ available: false, dir: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => state.dir },
  safeStorage: {
    isEncryptionAvailable: () => state.available,
    // 用 XOR 掩码模拟「密文」：重点是磁盘字节里不能出现口令原文
    encryptString: (text: string) =>
      Buffer.concat([Buffer.from('enc:'), Buffer.from(text, 'utf8').map((b) => b ^ 0x5a)]),
    decryptString: (cipher: Buffer) => {
      const body = cipher.subarray(4)
      return Buffer.from(body.map((b) => b ^ 0x5a)).toString('utf8')
    },
  },
}))

import {
  saveSyncCredential,
  readSyncCredential,
  hasSyncCredential,
  clearSyncCredential,
  syncCredentialState,
} from '../syncCredentials'

const credentialsDir = () => path.join(state.dir, 'aurora-music', 'plugin-credentials')

beforeEach(() => {
  state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-sync-cred-'))
  state.available = false
})

afterEach(() => {
  fs.rmSync(state.dir, { recursive: true, force: true })
})

describe('加密不可用：拒绝写明文', () => {
  it('save 返回 saved:false / encryptionAvailable:false，且磁盘上不留任何文件', () => {
    const result = saveSyncCredential('sync-1', { password: 'plain-text-password' })

    expect(result).toEqual({ saved: false, encryptionAvailable: false })
    expect(fs.existsSync(credentialsDir())).toBe(false)
    expect(hasSyncCredential('sync-1')).toBe(false)
    expect(syncCredentialState('sync-1')).toEqual({ saved: false, encryptionAvailable: false })
  })

  it('clear 在没有任何文件时也不抛（退出/删配置路径不该卡住）', () => {
    expect(() => clearSyncCredential('sync-1')).not.toThrow()
  })
})

describe('加密可用：落盘必须是密文 + 0600', () => {
  it('磁盘内容不含口令原文，读回仍是原值', () => {
    state.available = true
    const result = saveSyncCredential('sync-1', { password: 'top-secret-value' })

    expect(result).toEqual({ saved: true, encryptionAvailable: true })
    const raw = fs.readFileSync(path.join(credentialsDir(), 'sync-1.bin'))
    expect(raw.toString('utf8')).not.toContain('top-secret-value')
    expect(readSyncCredential('sync-1')).toEqual({ password: 'top-secret-value' })
  })

  it('文件权限是 0600', () => {
    state.available = true
    saveSyncCredential('sync-1', { password: 'x' })

    const mode = fs.statSync(path.join(credentialsDir(), 'sync-1.bin')).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('空载荷 = 清除，不写空气密文', () => {
    state.available = true
    saveSyncCredential('sync-1', { password: 'x' })
    const cleared = saveSyncCredential('sync-1', {})

    expect(cleared.saved).toBe(false)
    expect(hasSyncCredential('sync-1')).toBe(false)
  })

  it('非法 configId 被拒绝（id 来自渲染层，按不可信处理）', () => {
    state.available = true
    expect(() => saveSyncCredential('../escape', { password: 'x' })).toThrow()
    expect(() => saveSyncCredential('', { password: 'x' })).toThrow()
  })
})
