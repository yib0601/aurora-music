import type errors from '../zh-CN/errors'
import type { LocalizedOf } from '../schema'

const en: LocalizedOf<typeof errors> = {
  unknown: 'Operation failed',
  raw: '{message}',
  network: {
    unreachable: 'Network unreachable: check that the service is running and the address and port are correct',
    timeout: 'Request timed out: the service did not respond in time',
    dns: 'DNS lookup failed: check the address spelling and your DNS settings',
    tls: 'Secure connection failed: the certificate is invalid or untrusted',
    offline: 'You are offline, please check your network connection',
  },
  storage: {
    full: 'Not enough disk space, free some space and try again',
    permission: 'Permission denied: check the permissions of the file or folder',
    missing: 'File or folder does not exist',
    database: 'Database operation failed',
    write: 'Failed to write the file',
  },
  media: {
    decode: 'Cannot decode this audio: the file may be corrupted or the format unsupported',
    unsupported: 'Unsupported audio format',
    loadFailed: 'Audio failed to load: the link may have expired',
  },
  permission: {
    denied: 'Required permission was not granted',
    storage: 'Storage permission is required to read local music',
  },
}

export default en
