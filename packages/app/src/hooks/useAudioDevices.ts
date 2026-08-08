import { useState, useEffect } from 'react'

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
        // 需要先请求权限才能获取完整 label
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        stream.getTracks().forEach((t) => t.stop())

        const list = await navigator.mediaDevices.enumerateDevices()
        const audioOutputs = list
          .filter((d) => d.kind === 'audiooutput')
          .map((d) => ({
            deviceId: d.deviceId,
            label: d.label || `设备 ${d.deviceId.slice(0, 8)}`,
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
