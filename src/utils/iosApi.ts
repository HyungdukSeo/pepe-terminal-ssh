import { Preferences } from '@capacitor/preferences'
import { SSH } from './iosSSHPlugin'

type Session = {
  id: string
  name: string
  host: string
  port: number
  username: string
  auth?: { type: 'password'; password: string } | { type: 'key'; keyPath: string }
  encoding?: string
  folderId?: string
  [k: string]: any
}

type Folder = { id: string; name: string; parentId?: string }

type SessionsData = {
  folders: Folder[]
  sessions: Session[]
  childOrder?: Record<string, string[]>
}

const SESSIONS_KEY = 'pepe.sessions.data'
const UI_PREFS_KEY = 'pepe.ui.prefs'

async function loadSessionsData(): Promise<SessionsData> {
  const r = await Preferences.get({ key: SESSIONS_KEY })
  if (!r.value) return { folders: [], sessions: [], childOrder: {} }
  try {
    const d = JSON.parse(r.value) as SessionsData
    return {
      folders: d.folders || [],
      sessions: d.sessions || [],
      childOrder: d.childOrder || {},
    }
  } catch {
    return { folders: [], sessions: [], childOrder: {} }
  }
}

async function saveSessionsData(d: SessionsData) {
  await Preferences.set({ key: SESSIONS_KEY, value: JSON.stringify(d) })
}

type Cb = (p: any) => void
type EventName = 'connected' | 'data' | 'closed' | 'error'

const callbacks: Record<EventName, Set<Cb>> = {
  connected: new Set(),
  data: new Set(),
  closed: new Set(),
  error: new Set(),
}
let listenersInstalled = false

async function ensureListeners() {
  if (listenersInstalled) return
  listenersInstalled = true
  await SSH.addListener('connected', (e) => {
    callbacks.connected.forEach((cb) => {
      try { cb({ panelId: e.connectionId }) } catch {}
    })
  })
  await SSH.addListener('data', (e) => {
    callbacks.data.forEach((cb) => {
      try { cb({ panelId: e.connectionId, data: e.data }) } catch {}
    })
  })
  await SSH.addListener('closed', (e) => {
    callbacks.closed.forEach((cb) => {
      try { cb({ panelId: e.connectionId }) } catch {}
    })
  })
  await SSH.addListener('error', (e) => {
    callbacks.error.forEach((cb) => {
      try { cb({ panelId: e.connectionId, error: e.error }) } catch {}
    })
  })
}

function makeOn(event: EventName) {
  return (cb: Cb) => {
    void ensureListeners()
    callbacks[event].add(cb)
    return () => callbacks[event].delete(cb)
  }
}

async function connectBySessionId(panelId: string, sessionId: string, password?: string, cols?: number, rows?: number) {
  const data = await loadSessionsData()
  const sess = data.sessions.find((s) => s.id === sessionId)
  if (!sess) {
    callbacks.error.forEach((cb) => cb({ panelId, error: 'Session not found' }))
    return 'session-not-found'
  }
  return connectBySession(panelId, sess, password, cols, rows)
}

async function connectBySession(panelId: string, sess: Session, password?: string, cols?: number, rows?: number) {
  await ensureListeners()
  if (sess.jumpTargetHost) {
    const msg = 'Jump host (ProxyJump) is not yet supported on iOS'
    callbacks.error.forEach((cb) => cb({ panelId, error: msg }))
    return msg
  }
  const auth = sess.auth as Session['auth']
  let pw: string | undefined = password
  if (!pw && auth && auth.type === 'password') pw = auth.password
  try {
    await SSH.connect({
      connectionId: panelId,
      host: sess.host,
      port: sess.port || 22,
      username: sess.username,
      password: pw,
      cols,
      rows,
    })
    return 'ok'
  } catch (e: any) {
    const msg = e?.message || String(e)
    callbacks.error.forEach((cb) => cb({ panelId, error: msg }))
    return msg
  }
}

const noop = (..._args: any[]) => undefined
const asyncNoop = async (..._args: any[]) => undefined
const eventNoop = (..._args: any[]) => () => {}

export function createIosApi() {
  return {
    // Sessions
    listSessions: () => loadSessionsData(),
    saveSession: async (s: Session) => {
      const d = await loadSessionsData()
      const idx = d.sessions.findIndex((x) => x.id === s.id)
      if (idx >= 0) d.sessions[idx] = s
      else d.sessions.push(s)
      await saveSessionsData(d)
      return s
    },
    deleteSession: async (id: string) => {
      const d = await loadSessionsData()
      d.sessions = d.sessions.filter((s) => s.id !== id)
      await saveSessionsData(d)
    },
    saveFolder: async (f: Folder) => {
      const d = await loadSessionsData()
      const idx = d.folders.findIndex((x) => x.id === f.id)
      if (idx >= 0) d.folders[idx] = f
      else d.folders.push(f)
      await saveSessionsData(d)
      return f
    },
    deleteFolder: async (id: string) => {
      const d = await loadSessionsData()
      d.folders = d.folders.filter((f) => f.id !== id)
      d.sessions = d.sessions.map((s) => (s.folderId === id ? { ...s, folderId: undefined } : s))
      await saveSessionsData(d)
    },
    moveToFolder: async (sessionId: string, targetFolderId: string | null) => {
      const d = await loadSessionsData()
      const s = d.sessions.find((x) => x.id === sessionId)
      if (s) {
        s.folderId = targetFolderId || undefined
        await saveSessionsData(d)
      }
    },
    reorderSession: asyncNoop,
    getSessionsPath: async () => 'capacitor-preferences://pepe.sessions.data',
    setSessionsPath: asyncNoop,
    resetSessionsPath: asyncNoop,
    openSessionsFolder: asyncNoop,
    openSessionsEditor: asyncNoop,
    exportSessions: async () => loadSessionsData(),
    importSessions: asyncNoop,

    // UI Prefs
    getUIPrefs: async () => {
      const r = await Preferences.get({ key: UI_PREFS_KEY })
      try { return r.value ? JSON.parse(r.value) : {} } catch { return {} }
    },
    setUIPrefs: async (prefs: Record<string, any>) => {
      await Preferences.set({ key: UI_PREFS_KEY, value: JSON.stringify(prefs || {}) })
    },

    // SSH control
    connectSSH: (panelId: string, sessionId: string, cols?: number, rows?: number) =>
      connectBySessionId(panelId, sessionId, undefined, cols, rows),
    connectSSHWithPassword: (panelId: string, sessionId: string, password: string, cols?: number, rows?: number) =>
      connectBySessionId(panelId, sessionId, password, cols, rows),
    quickConnectSSH: (panelId: string, session: Session, cols?: number, rows?: number) =>
      connectBySession(panelId, session, undefined, cols, rows),
    isSSHConnected: async (panelId: string) => {
      const r = await SSH.isConnected({ connectionId: panelId })
      return r.connected
    },
    disconnectSSH: (panelId: string) => {
      SSH.disconnect({ connectionId: panelId }).catch(() => {})
    },
    sendSSHInput: (panelId: string, data?: string, b64?: string) => {
      let payload = data
      if (!payload && b64) {
        try { payload = atob(b64) } catch { payload = '' }
      }
      if (!payload) return
      SSH.write({ connectionId: panelId, data: payload }).catch(() => {})
    },
    resizeSSH: (panelId: string, cols: number, rows: number) => {
      SSH.resize({ connectionId: panelId, cols, rows }).catch(() => {})
    },
    setSSHEncoding: asyncNoop,
    getSSHEncoding: async () => 'utf-8',
    setSSHAutoTrack: asyncNoop,
    resetSSHState: asyncNoop,
    sshAuthResponse: asyncNoop,

    // SSH events
    onSSHConnected: makeOn('connected'),
    onSSHData: makeOn('data'),
    onSSHClosed: makeOn('closed'),
    onSSHError: makeOn('error'),
    onSSHAutoTrack: eventNoop,
    onSSHAuthPrompt: eventNoop,

    // Window controls — no-ops on mobile
    windowStartDrag: noop,
    windowDragMove: noop,
    windowEndDrag: noop,
    windowMinimize: asyncNoop,
    windowToggleMaximize: asyncNoop,
    windowClose: asyncNoop,
    windowIsMaximized: async () => false,
    onWindowMaximized: eventNoop,
    onDebugLog: eventNoop,

    // Local PTY — not available on iOS
    ptyListShells: async () => [],
    ptySpawn: async () => 'unsupported-on-ios',
    ptyInput: noop,
    ptyResize: noop,
    ptyKill: noop,
    onPtyData: eventNoop,
    onPtyExit: eventNoop,

    // File explorer / SFTP — not in Phase 1
    feListDir: async () => ({ entries: [], cwd: '/' }),
    feGetDrives: async () => [],
    feGetHome: async () => '/',
    feTransfer: asyncNoop,
    feMkdir: asyncNoop,
    feDelete: asyncNoop,
    feRename: asyncNoop,
    feHomeDir: async () => '/',
    feSftpConnect: asyncNoop,
    feSftpDisconnect: asyncNoop,
    feConnectedSessions: async () => [],
    pickFiles: async () => [],
    pickFolder: async () => null,
    sftpDownload: asyncNoop,
    sftpDownloadMulti: asyncNoop,
    sftpUpload: asyncNoop,
    sftpListDir: async () => ({ entries: [] }),
    sftpReadFile: async () => '',
    sftpWriteFile: asyncNoop,
    onSFTPProgress: eventNoop,
    onSFTPComplete: eventNoop,

    // App
    getStartupCwd: async () => null,
    clearStartupCwd: asyncNoop,
    registerContextMenu: asyncNoop,
    unregisterContextMenu: asyncNoop,
    checkContextMenu: async () => false,

    // Claude Code CLI — not on iOS (no local CLI)
    claudeCheck: async () => ({ available: false, reason: 'not supported on iOS' }),
    claudeSend: asyncNoop,
    claudeHookRespond: asyncNoop,
    onClaudeHookApprovalRequest: eventNoop,
    claudeRegisterMount: asyncNoop,
    claudeUnregisterMount: asyncNoop,
    claudeGetMountPath: async () => null,
    claudeStop: asyncNoop,
    clipboardWriteImage: asyncNoop,
    onClaudeStream: eventNoop,
  }
}
