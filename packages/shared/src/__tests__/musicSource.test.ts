import { isSuspiciousAudio, correctSuspiciousAudioSources } from '../musicSource'
import type { OnlineTrackSearchResult } from '../types'

function make(partial: Partial<OnlineTrackSearchResult>): OnlineTrackSearchResult {
  return {
    id: 'src-1',
    title: '对不起',
    artist: '周杰伦',
    album: '范特西',
    duration: 225,
    audioUrl: 'https://x/a.mp3',
    source: 'src',
    sourceName: 'src',
    ...partial,
  }
}

describe('isSuspiciousAudio', () => {
  it('声称 flac 但地址为有损格式（.ogg/.mp3）判定为可疑', () => {
    expect(isSuspiciousAudio(make({ audioQuality: 'flac', audioUrl: 'http://kuwo/x.ogg' }))).toBe(true)
    expect(isSuspiciousAudio(make({ audioQuality: 'flac', audioUrl: 'http://x/a.mp3?vkey=1' }))).toBe(true)
    expect(isSuspiciousAudio(make({ audioQuality: 'flac', audioUrl: 'http://x/a.m4a' }))).toBe(true)
  })
  it('声称 flac 且地址为无损格式不判可疑', () => {
    expect(isSuspiciousAudio(make({ audioQuality: 'flac', audioUrl: 'http://x/a.flac' }))).toBe(false)
    expect(isSuspiciousAudio(make({ audioQuality: 'flac', audioUrl: 'http://x/a.wav?x=1' }))).toBe(false)
  })
  it('未声称 flac（128/320/未知）不判可疑', () => {
    expect(isSuspiciousAudio(make({ audioQuality: '128', audioUrl: 'http://x/a.mp3' }))).toBe(false)
    expect(isSuspiciousAudio(make({ audioQuality: 'unknown', audioUrl: 'http://x/a.mp3' }))).toBe(false)
    expect(isSuspiciousAudio(make({ audioUrl: 'http://x/a.mp3' }))).toBe(false)
  })
})

describe('correctSuspiciousAudioSources', () => {
  it('可疑条目用基线档同 id 结果的音频地址替换', () => {
    const suspicious = make({
      id: 'src-000F0lmz1cBq4c',
      audioQuality: 'flac',
      audioSource: 'kuwo',
      audioUrl: 'http://kuwo/x.ogg',
    })
    const baseline = make({
      id: 'src-000F0lmz1cBq4c',
      audioQuality: 'unknown',
      audioSource: 'meting',
      audioUrl: 'https://meting/api?id=000F0lmz1cBq4c',
    })
    const out = correctSuspiciousAudioSources([suspicious], [baseline])
    expect(out[0].audioUrl).toBe('https://meting/api?id=000F0lmz1cBq4c')
    expect(out[0].audioSource).toBe('meting')
    expect(out[0].audioQuality).toBe('unknown')
    // 元数据保持不变
    expect(out[0].title).toBe('对不起')
    expect(out[0].artist).toBe('周杰伦')
  })
  it('非可疑条目原样返回', () => {
    const ok = make({ id: 'src-a', audioQuality: 'flac', audioUrl: 'http://x/a.flac' })
    const out = correctSuspiciousAudioSources([ok], [])
    expect(out[0]).toBe(ok)
  })
  it('基线档无同 id 时保持原样', () => {
    const suspicious = make({ id: 'src-a', audioQuality: 'flac', audioUrl: 'http://x/a.ogg' })
    const out = correctSuspiciousAudioSources([suspicious], [make({ id: 'src-b' })])
    expect(out[0].audioUrl).toBe('http://x/a.ogg')
  })
  it('基线档同 id 条目本身也可疑时不替换', () => {
    const suspicious = make({ id: 'src-a', audioQuality: 'flac', audioUrl: 'http://x/a.ogg' })
    const badBaseline = make({ id: 'src-a', audioQuality: 'flac', audioUrl: 'http://x/b.mp3' })
    const out = correctSuspiciousAudioSources([suspicious], [badBaseline])
    expect(out[0].audioUrl).toBe('http://x/a.ogg')
  })
})
