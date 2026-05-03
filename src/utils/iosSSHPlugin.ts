import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'

export interface SSHConnectOptions {
  connectionId: string
  host: string
  port?: number
  username: string
  password?: string
  privateKey?: string
  passphrase?: string
  cols?: number
  rows?: number
}

export interface SSHPlugin {
  connect(options: SSHConnectOptions): Promise<{ ok: boolean }>
  disconnect(options: { connectionId: string }): Promise<void>
  write(options: { connectionId: string; data: string }): Promise<void>
  resize(options: { connectionId: string; cols: number; rows: number }): Promise<void>
  isConnected(options: { connectionId: string }): Promise<{ connected: boolean }>
  getShellSshdPid(options: { connectionId: string }): Promise<{ sshdPid: number | null }>
  addListener(
    eventName: 'connected',
    listener: (event: { connectionId: string }) => void
  ): Promise<PluginListenerHandle>
  addListener(
    eventName: 'data',
    listener: (event: { connectionId: string; data: string }) => void
  ): Promise<PluginListenerHandle>
  addListener(
    eventName: 'closed',
    listener: (event: { connectionId: string }) => void
  ): Promise<PluginListenerHandle>
  addListener(
    eventName: 'error',
    listener: (event: { connectionId: string; error: string }) => void
  ): Promise<PluginListenerHandle>
}

export const SSH = registerPlugin<SSHPlugin>('SSH')
