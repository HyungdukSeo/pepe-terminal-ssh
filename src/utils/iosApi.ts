import { Preferences } from '@capacitor/preferences'
import { SSH } from './iosSSHPlugin'
import { SFTP, type SFTPFile } from './iosSFTPPlugin'

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

async function exportSessionsToFile() {
  const data = await loadSessionsData()
  const json = JSON.stringify(data, null, 2)
  const stamp = new Date().toISOString().slice(0, 10)
  const filename = `pepe-sessions-${stamp}.json`

  // iPadOS 15+ 의 Web Share API 는 파일 공유를 지원 — 시트에서 "파일에 저장" 선택 시
  // Files 앱(iCloud Drive / On My iPad)에 저장 가능. AirDrop, 메일 첨부 등도 동일 시트.
  try {
    const file = new File([json], filename, { type: 'application/json' })
    const nav = navigator as any
    if (typeof nav.canShare === 'function' && nav.canShare({ files: [file] })) {
      await nav.share({ files: [file], title: 'PePe Sessions Export' })
      return { success: true }
    }
  } catch (e: any) {
    // 사용자 취소(AbortError)도 여기로 — 폴백 다운로드까진 진행하지 않고 종료.
    if (e?.name === 'AbortError') return { success: false, canceled: true }
  }

  // 폴백: Blob URL → <a download>. WKWebView 가 Web Share 를 거부하는 환경/웹 브라우저용.
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  setTimeout(() => { try { document.body.removeChild(a) } catch {}; URL.revokeObjectURL(url) }, 200)
  return { success: true }
}

async function importSessionsFromFile(): Promise<{ addedCount: number; totalParsed: number } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/json,.json'
    input.style.display = 'none'
    let resolved = false
    const finish = (v: { addedCount: number; totalParsed: number } | null) => {
      if (resolved) return
      resolved = true
      try { document.body.removeChild(input) } catch {}
      resolve(v)
    }

    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) { finish(null); return }
      try {
        const text = await file.text()
        const raw = JSON.parse(text)
        const imported: SessionsData = Array.isArray(raw)
          ? { folders: [], sessions: raw, childOrder: {} }
          : {
              folders: raw.folders ?? [],
              sessions: raw.sessions ?? [],
              childOrder: raw.childOrder ?? {},
            }
        const data = await loadSessionsData()
        // 폴더 머지: name+parentId 동일하면 기존 ID 로 remap, 아니면 새로 추가.
        for (const f of imported.folders) {
          const existing = data.folders.find((x) => x.name === f.name && x.parentId === f.parentId)
          if (existing) {
            for (const s of imported.sessions) {
              if (s.folderId === f.id) s.folderId = existing.id
            }
            for (const cf of imported.folders) {
              if (cf.parentId === f.id) cf.parentId = existing.id
            }
          } else {
            data.folders.push(f)
          }
        }
        // 세션 머지: host+port+username+name 동일하면 중복 스킵.
        let addedCount = 0
        for (const s of imported.sessions) {
          const dup = data.sessions.some(
            (x) => x.host === s.host && x.port === s.port && x.username === s.username && x.name === s.name,
          )
          if (!dup) { data.sessions.push(s); addedCount++ }
        }
        await saveSessionsData(data)
        finish({ addedCount, totalParsed: imported.sessions.length })
      } catch {
        finish(null)
      }
    }

    // 사용자 취소 시 change 이벤트가 안 옴 → window focus 복귀 후 파일 미선택이면 null 반환.
    const onFocus = () => {
      setTimeout(() => {
        if (!input.files || input.files.length === 0) finish(null)
      }, 500)
    }
    window.addEventListener('focus', onFocus, { once: true })

    document.body.appendChild(input)
    input.click()
  })
}

type Cb = (p: any) => void
type EventName = 'connected' | 'data' | 'closed' | 'error' | 'autoTrack'

const callbacks: Record<EventName, Set<Cb>> = {
  connected: new Set(),
  data: new Set(),
  closed: new Set(),
  error: new Set(),
  autoTrack: new Set(),
}
// Promise 캐시 — 동시 호출이 모두 같은 등록 완료를 기다리도록.
// 단순 boolean flag 면 첫 호출이 await 중인 동안 후속 호출이 통과해서
// listener 미등록 상태로 SSH.connect 가 발생, 'connected' 이벤트 놓침.
let listenersPromise: Promise<void> | null = null

function ensureListeners(): Promise<void> {
  if (listenersPromise) return listenersPromise
  listenersPromise = (async () => {
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
  // SFTP-side auto-track polling → fake OSC 7 into the SSH data stream so
  // xterm parses it and the file tree picks up the new cwd, mirroring Electron.
  await SFTP.addListener('cwdChanged', (e) => {
    const osc = `]7;file://localhost${e.path}\\`
    callbacks.data.forEach((cb) => {
      try { cb({ panelId: e.connectionId, data: osc }) } catch {}
    })
  })
  await SFTP.addListener('autoTrackChanged', (e) => {
    callbacks.autoTrack.forEach((cb) => {
      try { cb({ panelId: e.connectionId, enabled: e.enabled }) } catch {}
    })
  })
  })()
  return listenersPromise
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
  const privateKey = auth && auth.type === 'key' ? (auth as any).keyPath : undefined
  try {
    await SSH.connect({
      connectionId: panelId,
      host: sess.host,
      port: sess.port || 22,
      username: sess.username,
      password: pw,
      privateKey,
      cols,
      rows,
    })
    // Also open an SFTP session on the same panelId so the auto-opened file
    // tree (RemoteFileTree, FilePanel) can list directories without a
    // separate feSftpConnect call. Failure here is non-fatal — shell-only
    // accounts will still get the terminal.
    SFTP.connect({
      connectionId: panelId,
      host: sess.host,
      port: sess.port || 22,
      username: sess.username,
      password: pw,
      privateKey,
    }).catch(() => { /* non-fatal */ })
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
    exportSessions: () => exportSessionsToFile(),
    importSessions: () => importSessionsFromFile(),

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
      // Best-effort tear down of the auto-opened SFTP session for the same panel.
      SFTP.disconnect({ connectionId: panelId }).catch(() => {})
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
    setSSHAutoTrack: async (panelId: string, enabled: boolean) => {
      await ensureListeners()
      for (let i = 0; i < 5; i++) {
        try {
          const r = await SFTP.setAutoTrack({ connectionId: panelId, enabled })
          return { success: true, enabled: r.enabled }
        } catch {
          if (!enabled || i >= 4) return { success: false, error: 'not connected' }
          await new Promise(res => setTimeout(res, 500))
        }
      }
      return { success: false, error: 'timeout' }
    },
    resetSSHState: asyncNoop,
    sshAuthResponse: asyncNoop,

    // SSH events
    onSSHConnected: makeOn('connected'),
    onSSHData: makeOn('data'),
    onSSHClosed: makeOn('closed'),
    onSSHError: makeOn('error'),
    onSSHAutoTrack: makeOn('autoTrack'),
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

    // File explorer / SFTP
    feSftpConnect: async (
      connId: string,
      host: string,
      port: number,
      username: string,
      auth?: { type: 'password'; password: string } | { type: 'key'; keyPath: string },
      jumpOpts?: any,
    ) => {
      if (jumpOpts && jumpOpts.host) {
        return { success: false, error: 'Jump host (ProxyJump) is not yet supported on iOS' }
      }
      try {
        const password = auth && auth.type === 'password' ? auth.password : undefined
        const privateKey = auth && auth.type === 'key' ? auth.keyPath : undefined
        await SFTP.connect({
          connectionId: connId,
          host,
          port: port || 22,
          username,
          password,
          privateKey,
        })
        return { success: true }
      } catch (e: any) {
        return { success: false, error: e?.message || String(e) }
      }
    },
    feSftpDisconnect: async (connId: string) => {
      try { await SFTP.disconnect({ connectionId: connId }) } catch {}
    },
    feConnectedSessions: async () => [],
    feGetDrives: async () => ['/'],
    feGetHome: async () => '/',
    feHomeDir: async (mode: string, termId?: string) => {
      if (mode !== 'remote' || !termId) return '/'
      try {
        const r = await SFTP.realPath({ connectionId: termId, path: '.' })
        return r.path || '/'
      } catch {
        return '/'
      }
    },
    feListDir: async (mode: string, dirPath: string, termId?: string) => {
      if (mode !== 'remote' || !termId) return { error: 'iOS supports remote SFTP only' }
      try {
        const r = await SFTP.listDir({ connectionId: termId, path: dirPath })
        const files = (r.files || []).map((f: SFTPFile) => ({
          name: f.name,
          isDir: f.isDirectory,
          size: f.size,
          modifiedAt: f.modifiedAt,
          permissions: f.permissions,
        }))
        return { files }
      } catch (e: any) {
        return { error: `${dirPath}: ${e?.message || String(e)}` }
      }
    },
    feMkdir: async (mode: string, dirPath: string, termId?: string) => {
      if (mode !== 'remote' || !termId) return { success: false, error: 'remote only' }
      try { await SFTP.mkdir({ connectionId: termId, path: dirPath }); return { success: true } }
      catch (e: any) { return { success: false, error: e?.message || String(e) } }
    },
    feDelete: async (mode: string, filePath: string, termId?: string) => {
      if (mode !== 'remote' || !termId) return { success: false, error: 'remote only' }
      try {
        // best-effort: try as file first, then as directory
        try { await SFTP.deletePath({ connectionId: termId, path: filePath, isDirectory: false }) }
        catch { await SFTP.deletePath({ connectionId: termId, path: filePath, isDirectory: true }) }
        return { success: true }
      } catch (e: any) { return { success: false, error: e?.message || String(e) } }
    },
    feRename: async (mode: string, oldPath: string, newPath: string, termId?: string) => {
      if (mode !== 'remote' || !termId) return { success: false, error: 'remote only' }
      try { await SFTP.rename({ connectionId: termId, oldPath, newPath }); return { success: true } }
      catch (e: any) { return { success: false, error: e?.message || String(e) } }
    },
    feTransfer: async () => ({ success: false, error: 'cross-mode transfer not supported on iOS' }),
    pickFiles: async () => [],
    pickFolder: async () => null,

    sftpListDir: async (panelId: string, remotePath: string) => {
      try {
        const r = await SFTP.listDir({ connectionId: panelId, path: remotePath })
        const entries = (r.files || []).map((f: SFTPFile) => ({
          name: f.name,
          isDir: f.isDirectory,
          size: f.size,
          modifiedAt: f.modifiedAt,
        }))
        return { entries }
      } catch (e: any) {
        return { entries: [], error: e?.message || String(e) }
      }
    },
    sftpReadFile: async (panelId: string, remotePath: string, encoding?: string) => {
      try {
        const r = await SFTP.readFile({ connectionId: panelId, path: remotePath, encoding: encoding || 'utf-8' })
        const text = r.content || ''
        // size 는 byte 길이 (utf-8 가정 — 정확한 byte 수는 native 가 따로 안 줌).
        const size = new TextEncoder().encode(text).length
        return { success: true, text, size }
      } catch (e: any) {
        return { success: false, error: e?.message || String(e) }
      }
    },
    sftpWriteFile: async (panelId: string, remotePath: string, content: string, encoding?: string) => {
      try {
        await SFTP.writeFile({ connectionId: panelId, path: remotePath, content, encoding: encoding || 'utf-8' })
        return { success: true }
      } catch (e: any) {
        return { success: false, error: e?.message || String(e) }
      }
    },
    sftpDownload: async () => ({ success: false, error: 'download not supported on iOS yet' }),
    sftpDownloadMulti: async () => ({ success: false, error: 'download not supported on iOS yet' }),
    sftpUpload: async () => ({ success: false, error: 'upload not supported on iOS yet' }),
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
