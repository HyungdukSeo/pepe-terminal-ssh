import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'

export interface ClaudeStreamEvent {
  requestId: string
  type: 'sse' | 'done' | 'error' | 'cancelled'
  data?: any
  error?: string
}

export interface ClaudePlugin {
  setApiKey(options: { apiKey: string }): Promise<{ ok: boolean }>
  getApiKey(): Promise<{ apiKey: string; hasKey: boolean }>
  streamChat(options: { body: string; requestId?: string }): Promise<{ requestId: string }>
  cancelRequest(options: { requestId: string }): Promise<void>
  addListener(
    eventName: 'stream',
    listener: (event: ClaudeStreamEvent) => void,
  ): Promise<PluginListenerHandle>
}

export const Claude = registerPlugin<ClaudePlugin>('Claude')
