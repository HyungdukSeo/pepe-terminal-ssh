import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'

export interface SFTPConnectOptions {
  connectionId: string
  host: string
  port?: number
  username: string
  password?: string
  privateKey?: string
  passphrase?: string
}

export interface SFTPFile {
  name: string
  isDirectory: boolean
  size: number
  permissions: string
  modifiedAt: number
}

export interface SFTPPlugin {
  connect(options: SFTPConnectOptions): Promise<{ ok: boolean }>
  disconnect(options: { connectionId: string }): Promise<void>
  listDir(options: { connectionId: string; path: string }): Promise<{ files: SFTPFile[] }>
  mkdir(options: { connectionId: string; path: string }): Promise<void>
  deletePath(options: { connectionId: string; path: string; isDirectory?: boolean }): Promise<void>
  rename(options: { connectionId: string; oldPath: string; newPath: string }): Promise<void>
  realPath(options: { connectionId: string; path: string }): Promise<{ path: string }>
  readFile(options: { connectionId: string; path: string; encoding?: string }): Promise<{ content: string }>
  writeFile(options: { connectionId: string; path: string; content: string; encoding?: string }): Promise<void>
  setAutoTrack(options: { connectionId: string; enabled: boolean; sshdPid?: number }): Promise<{ enabled: boolean }>
  addListener(
    eventName: 'cwdChanged',
    listener: (event: { connectionId: string; path: string }) => void
  ): Promise<PluginListenerHandle>
  addListener(
    eventName: 'autoTrackChanged',
    listener: (event: { connectionId: string; enabled: boolean }) => void
  ): Promise<PluginListenerHandle>
}

export const SFTP = registerPlugin<SFTPPlugin>('SFTP')
