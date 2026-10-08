import { useState, useEffect } from 'react'
import { appTranslate } from '@/i18n'

export interface AudioDevice {
  deviceId: string
  label: string
}

export function useAudioDevices() {
  const [devices, setDevices] = useState<AudioDevice[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('default')

  useEffect(() => {
    let mounted = true

    async function loadDevices() {
      try {
        // enumerateDevices 无需任何权限即可拿到输出设备列表（deviceId 可直接用于 setSinkId），
        // 仅 label 需要授权才暴露。不请求麦克风权限（Electron 默认静默拒绝且音乐播放器
        // 不应申请麦克风），label 为空时用序号兜底
        const list = await navigator.mediaDevices.enumerateDevices()
        let index = 0
        const audioOutputs = list
          .filter((d) => d.kind === 'audiooutput')
          .map((d) => ({
            deviceId: d.deviceId,
            // label 由系统给出（数据，不进字典）；未授权时为空串，用带序号的兜底名。
            // 这里是设备枚举回调、没有渲染周期，故走 appTranslate()（读实时语言快照）
            label: d.label || appTranslate()('player.device.fallbackLabel', { index: ++index }),
          }))

        if (mounted) {
          setDevices(audioOutputs)
        }
      } catch (e) {
        console.warn('Failed to enumerate audio devices:', e)
      }
    }

    loadDevices()

    const handler = () => loadDevices()
    navigator.mediaDevices.addEventListener('devicechange', handler)
    return () => {
      mounted = false
      navigator.mediaDevices.removeEventListener('devicechange', handler)
    }
  }, [])

  return { devices, selectedDeviceId, setSelectedDeviceId }
}
