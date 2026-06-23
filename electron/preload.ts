// electron/preload.ts — updated with folder support
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  // Sessions
  getSessionsPath: () => ipcRenderer.invoke('sessions:path'),
  openSessionsFolder: () => ipcRenderer.invoke('sessions:open-folder'),
  openSessionsEditor: () => ipcRenderer.invoke('sessions:open-editor'),
  setSessionsPath: () => ipcRenderer.invoke('sessions:set-path'),
  resetSessionsPath: () => ipcRenderer.invoke('sessions:reset-path'),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  saveSession: (s: any) => ipcRenderer.invoke('sessions:save', s),
  deleteSession: (id: string) => ipcRenderer.invoke('sessions:delete', id),
  moveToFolder: (sessionId: string, targetFolderId: string | null) => ipcRenderer.invoke('sessions:move-to-folder', { sessionId, targetFolderId }),
  reorderSession: (id: string, type: 'session' | 'folder', direction: 'up' | 'down' | 'top' | 'bottom') => ipcRenderer.invoke('sessions:reorder', { id, type, direction }),
  dropReorderSession: (id: string, type: 'session' | 'folder', targetParentId: string | null, beforeId?: string | null) => ipcRenderer.invoke('sessions:drop-reorder', { id, type, targetParentId, beforeId }),

  // UI Prefs (config.json 에 저장 — sessionData 멀티인스턴스 분리와 무관하게 영속)
  getUIPrefs: () => ipcRenderer.invoke('ui-prefs:get'),
  setUIPrefs: (prefs: Record<string, any>) => ipcRenderer.invoke('ui-prefs:set', prefs),

  // PePe Messenger
  messengerStart: (prefs?: any) => ipcRenderer.invoke('messenger:start', prefs),
  messengerStop: () => ipcRenderer.invoke('messenger:stop'),
  messengerGetState: () => ipcRenderer.invoke('messenger:get-state'),
  messengerUpdatePrefs: (prefs: any) => ipcRenderer.invoke('messenger:update-prefs', prefs),
  messengerSendMessage: (peerId: string, text: string) => ipcRenderer.invoke('messenger:send-message', { peerId, text }),
  messengerSendFiles: (peerId: string) => ipcRenderer.invoke('messenger:send-files', { peerId }),
  messengerSendRemoteFiles: (peerId: string, connId: string, remotePaths: string[]) => ipcRenderer.invoke('messenger:send-remote-files', { peerId, connId, remotePaths }),
  messengerScanRange: (prefix?: string) => ipcRenderer.invoke('messenger:scan-range', { prefix }),
  messengerDeleteConversation: (peerId: string) => ipcRenderer.invoke('messenger:delete-conversation', { peerId }),
  messengerDeletePeer: (peerId: string) => ipcRenderer.invoke('messenger:delete-peer', { peerId }),
  messengerClearAll: () => ipcRenderer.invoke('messenger:clear-all'),
  messengerClearPeers: () => ipcRenderer.invoke('messenger:clear-peers'),
  onMessengerEvent: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('messenger:event', handler);
    return () => ipcRenderer.removeListener('messenger:event', handler);
  },

  // Folders
  saveFolder: (f: any) => ipcRenderer.invoke('folders:save', f),
  deleteFolder: (id: string) => ipcRenderer.invoke('folders:delete', id),

  // Export/Import
  exportSessions: () => ipcRenderer.invoke('sessions:export'),
  importSessions: () => ipcRenderer.invoke('sessions:import'),
  sessionsClear: () => ipcRenderer.invoke('sessions:clear'),
  sessionsReplaceAll: (data: any) => ipcRenderer.invoke('sessions:replace-all', data),

  // File Explorer
  feListDir: (mode: string, dirPath: string, termId?: string, encoding?: string) => ipcRenderer.invoke('fe:list-dir', { mode, termId, dirPath, encoding }),
  feGetDrives: () => ipcRenderer.invoke('fe:get-drives'),
  feGetFileIcon: (filePath: string, size?: 'small' | 'normal' | 'large') => ipcRenderer.invoke('fe:get-file-icon', { filePath, size }),
  feGetFileIconsBatch: (filePaths: string[]) => ipcRenderer.invoke('fe:get-file-icons-batch', { filePaths }),
  feGetIconsByExt: (exts: string[], isDir?: boolean) => ipcRenderer.invoke('fe:get-icons-by-ext', { exts, isDir }),
  feGetHome: () => ipcRenderer.invoke('fe:get-home'),
  feTransfer: (src: any, dst: any, filename: string, workspaceId?: string) => ipcRenderer.invoke('fe:transfer', { src, dst, filename, workspaceId }),
  onFeTransferDone: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('fe:transfer-done', handler);
    return () => ipcRenderer.removeListener('fe:transfer-done', handler);
  },
  onFeDeleteDone: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('fe:delete-done', handler);
    return () => ipcRenderer.removeListener('fe:delete-done', handler);
  },
  onSFTPDirList: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('sftp:dir-list', handler);
    return () => ipcRenderer.removeListener('sftp:dir-list', handler);
  },
  onSFTPDeleteStart: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('sftp:delete-start', handler);
    return () => ipcRenderer.removeListener('sftp:delete-start', handler);
  },
  onSFTPDeleteProgress: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('sftp:delete-progress', handler);
    return () => ipcRenderer.removeListener('sftp:delete-progress', handler);
  },
  onSFTPDeleteComplete: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('sftp:delete-complete', handler);
    return () => ipcRenderer.removeListener('sftp:delete-complete', handler);
  },
  feMkdir: (mode: string, dirPath: string, termId?: string) => ipcRenderer.invoke('fe:mkdir', { mode, termId, dirPath }),
  feCreateFile: (mode: string, filePath: string, termId?: string) => ipcRenderer.invoke('fe:create-file', { mode, termId, filePath }),
  feDelete: (mode: string, filePath: string, termId?: string, workspaceId?: string) => ipcRenderer.invoke('fe:delete', { mode, termId, filePath, workspaceId }),
  feRename: (mode: string, oldPath: string, newPath: string, termId?: string) => ipcRenderer.invoke('fe:rename', { mode, termId, oldPath, newPath }),
  feHomeDir: (mode: string, termId?: string) => ipcRenderer.invoke('fe:home-dir', { mode, termId }),
  feSftpConnect: (connId: string, host: string, port: number, username: string, auth?: any, jumpOpts?: { host: string; user?: string; port?: number; password?: string }, jumps?: { host: string; user?: string; port?: number; password?: string }[]) => ipcRenderer.invoke('fe:sftp-connect', { connId, host, port, username, auth, jumpOpts, jumps }),
  pickFiles: (multi?: boolean) => ipcRenderer.invoke('dialog:pick-files', { multi }),
  pickFolder: () => ipcRenderer.invoke('dialog:pick-folder'),
  feSftpDisconnect: (connId: string) => ipcRenderer.invoke('fe:sftp-disconnect', { connId }),
  feReleaseSftp: (panelId: string) => ipcRenderer.invoke('fe:release-sftp', { panelId }),
  sqlExec: (connId: string, command: string, timeoutMs?: number) => ipcRenderer.invoke('sql:exec', { connId, command, timeoutMs }),
  sqlSaveCsv: (defaultName: string, content: string) => ipcRenderer.invoke('sql:save-csv', { defaultName, content }),
  // JDBC 사이드카 진단 — Java 프로세스 ping. 성공 시 { success, result:{version,javaVersion,...}, jar, java }
  jdbcPing: () => ipcRenderer.invoke('jdbc:ping'),
  // 사이드카 JVM 재시작 — JAR 업데이트 후 새 코드 적용용. 모든 활성 JDBC 연결 끊김.
  jdbcRestartSidecar: () => ipcRenderer.invoke('jdbc:restart-sidecar'),
  // Driver Manager (DBeaver 스타일).
  jdbcListDrivers: () => ipcRenderer.invoke('jdbc:list-drivers'),
  jdbcSaveDriver: (def: any) => ipcRenderer.invoke('jdbc:save-driver', def),
  jdbcRemoveDriver: (id: string) => ipcRenderer.invoke('jdbc:remove-driver', id),
  jdbcDriverRoots: () => ipcRenderer.invoke('jdbc:driver-roots'),
  jdbcPickAndImportJar: () => ipcRenderer.invoke('jdbc:pick-and-import-jar'),
  jdbcResolveJars: (def: any) => ipcRenderer.invoke('jdbc:resolve-jars', def),
  // 사이드카 정식 RPC 래퍼. 모두 { success, result|error } 반환.
  jdbcLoadDriver: (def: any) => ipcRenderer.invoke('jdbc:load-driver', def),
  jdbcConnect: (args: { connectionId: string; driver: any; url: string; user?: string; password?: string; props?: Record<string,string> }) =>
    ipcRenderer.invoke('jdbc:connect', args),
  jdbcDisconnect: (connectionId: string) => ipcRenderer.invoke('jdbc:disconnect', connectionId),
  jdbcExec: (args: { connectionId: string; sql: string; maxRows?: number }) => ipcRenderer.invoke('jdbc:exec', args),
  jdbcTxBegin: (args: { connectionId: string }) => ipcRenderer.invoke('jdbc:tx-begin', args),
  jdbcTxCommit: (args: { connectionId: string }) => ipcRenderer.invoke('jdbc:tx-commit', args),
  jdbcTxRollback: (args: { connectionId: string }) => ipcRenderer.invoke('jdbc:tx-rollback', args),
  jdbcAltibaseExplain: (args: { connectionId: string; sql: string }) => ipcRenderer.invoke('jdbc:altibase-explain', args),
  jdbcPickAndImportFolder: () => ipcRenderer.invoke('jdbc:pick-and-import-folder'),
  jdbcDownloadMavenArtifact: (args: { groupId: string; artifactId: string; version: string }) =>
    ipcRenderer.invoke('jdbc:download-maven-artifact', args),
  jdbcDownloadDriverLibraries: (def: any) => ipcRenderer.invoke('jdbc:download-driver-libraries', def),
  sshOpenLocalForward: (args: { sessionId: string; remoteHost: string; remotePort: number }) =>
    ipcRenderer.invoke('ssh:open-local-forward', args),
  sshCloseLocalForward: (args: { forwardId: string }) =>
    ipcRenderer.invoke('ssh:close-local-forward', args),
  sshListActiveSessions: () => ipcRenderer.invoke('ssh:list-active-sessions'),
  sshOpenSocksProxy: (args: { panelId: string }) => ipcRenderer.invoke('ssh:open-socks-proxy', args),
  sshCloseSocksProxy: (args: { proxyId: string }) => ipcRenderer.invoke('ssh:close-socks-proxy', args),
  sshTestWebTarget: (args: { panelId: string; url: string }) => ipcRenderer.invoke('ssh:test-web-target', args),
  sshGetShellCwd: (args: { termId: string }) => ipcRenderer.invoke('ssh:get-shell-cwd', args),
  saveTextFile: (args: { defaultName?: string; content: string; filters?: { name: string; extensions: string[] }[] }) =>
    ipcRenderer.invoke('dialog:save-text-file', args),
  jdbcMetaTables: (args: { connectionId: string; catalog?: string; schema?: string; types?: string[] }) =>
    ipcRenderer.invoke('jdbc:meta-tables', args),
  jdbcMetaColumns: (args: { connectionId: string; catalog?: string; schema?: string; table: string }) =>
    ipcRenderer.invoke('jdbc:meta-columns', args),
  jdbcMetaPrimaryKeys: (args: { connectionId: string; catalog?: string; schema?: string; table: string }) =>
    ipcRenderer.invoke('jdbc:meta-primary-keys', args),
  jdbcMetaSchemas: (args: { connectionId: string }) => ipcRenderer.invoke('jdbc:meta-schemas', args),
  jdbcMetaFunctions: (args: { connectionId: string; catalog?: string; schema?: string }) => ipcRenderer.invoke('jdbc:meta-functions', args),
  jdbcMetaProcedures: (args: { connectionId: string; catalog?: string; schema?: string }) => ipcRenderer.invoke('jdbc:meta-procedures', args),
  jdbcMetaIndexes: (args: { connectionId: string; catalog?: string; schema?: string; table: string }) => ipcRenderer.invoke('jdbc:meta-indexes', args),
  jdbcMetaProcedureColumns: (args: { connectionId: string; catalog?: string; schema?: string; procedureName: string }) => ipcRenderer.invoke('jdbc:meta-procedure-columns', args),
  jdbcMetaFunctionColumns: (args: { connectionId: string; catalog?: string; schema?: string; functionName: string }) => ipcRenderer.invoke('jdbc:meta-function-columns', args),
  // SQL Tool 세션 상태 영속화 (localStorage 대체)
  sqlToolGetState: (sessionId: string) => ipcRenderer.invoke('sql-tool:get-state', sessionId),
  sqlToolSetState: (sessionId: string, partial: any) => ipcRenderer.invoke('sql-tool:set-state', { sessionId, partial }),
  feConnectedSessions: () => ipcRenderer.invoke('fe:connected-sessions'),

  // SFTP
  sftpDownload: (panelId: string, remotePath: string, isDir?: boolean) => ipcRenderer.invoke('sftp:download', { panelId, remotePath, isDir }),
  sftpDownloadMulti: (panelId: string, items: { path: string; isDir: boolean }[]) => ipcRenderer.invoke('sftp:download-multi', { panelId, items }),
  sftpQuickShare: (panelId: string, items: { path: string; isDir: boolean }[]) => ipcRenderer.invoke('sftp:quick-share', { panelId, items }),
  sftpUpload: (panelId: string, remotePath: string, kind?: 'file' | 'folder' | 'multi-file') => ipcRenderer.invoke('sftp:upload', { panelId, remotePath, kind }),
  sftpListDir: (panelId: string, remotePath: string) => ipcRenderer.invoke('sftp:list-dir', { panelId, remotePath }),
  sftpReadFile: (panelId: string, remotePath: string, encoding?: string) => ipcRenderer.invoke('sftp:read-file', { panelId, remotePath, encoding }),
  sftpWriteFile: (panelId: string, remotePath: string, content: string, encoding?: string) => ipcRenderer.invoke('sftp:write-file', { panelId, remotePath, content, encoding }),
  onSFTPProgress: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('sftp:progress', handler);
    return () => ipcRenderer.removeListener('sftp:progress', handler);
  },
  onSFTPComplete: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('sftp:complete', handler);
    return () => ipcRenderer.removeListener('sftp:complete', handler);
  },
  onSFTPTransferStart: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('sftp:transfer-start', handler);
    return () => ipcRenderer.removeListener('sftp:transfer-start', handler);
  },
  onSFTPFileStart: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('sftp:file-start', handler);
    return () => ipcRenderer.removeListener('sftp:file-start', handler);
  },
  onSFTPBatch: (cb: (batch: Array<{ channel: string; payload: any }>) => void) => {
    const handler = (_: any, batch: any) => cb(batch);
    ipcRenderer.on('sftp:batch', handler);
    return () => ipcRenderer.removeListener('sftp:batch', handler);
  },
  onSFTPError: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('sftp:error', handler);
    return () => ipcRenderer.removeListener('sftp:error', handler);
  },
  onSFTPConflict: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('sftp:conflict', handler);
    return () => ipcRenderer.removeListener('sftp:conflict', handler);
  },
  feResolveConflict: (requestId: string, decision: any) => ipcRenderer.invoke('fe:resolve-conflict', { requestId, decision }),
  feCancelTransfer: (transferId: string) => ipcRenderer.invoke('fe:cancel-transfer', { transferId }),
  shellShowItem: (fullPath: string) => ipcRenderer.invoke('shell:show-item', { fullPath }),
  shellOpenPath: (dirPath: string) => ipcRenderer.invoke('shell:open-path', { dirPath }),
  feChmod: (opts: { mode: string; termId?: string; paths: string[]; octal: number; recursive?: boolean }) => ipcRenderer.invoke('fe:chmod', opts),

  // Window
  windowStartDrag: (mouseX: number, mouseY: number) => ipcRenderer.send('window:start-drag', { mouseX, mouseY }),
  windowDragMove: (mouseX: number, mouseY: number) => ipcRenderer.send('window:drag-move', { mouseX, mouseY }),
  windowEndDrag: () => ipcRenderer.send('window:end-drag'),
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowToggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
  windowClose: () => ipcRenderer.invoke('window:close'),
  windowFocus: () => ipcRenderer.invoke('window:focus'),
  windowIsMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  // 탭 분리(멀티 윈도우)
  detachTab: (payload: any, bounds?: any) => ipcRenderer.invoke('window:detach-tab', { payload, bounds }),
  dropTab: (payload: any, point?: any) => ipcRenderer.invoke('window:drop-tab', { payload, point }),
  onAdoptTab: (cb: (payload: any) => void) => {
    const listener = (_e: any, payload: any) => cb(payload);
    ipcRenderer.on('window:adopt-tab', listener);
    return () => ipcRenderer.removeListener('window:adopt-tab', listener);
  },
  getDetachedInit: () => ipcRenderer.invoke('window:get-detached-init'),
  getConnectedPanels: () => ipcRenderer.invoke('ssh:connected-panels'),
  setWebviewProxy: (args: { webContentsId: number; proxyRules: string | null }) => ipcRenderer.invoke('browser:set-proxy', args),
  agentIsRunning: (args: { sessionId?: string; requestId?: string }) => ipcRenderer.invoke('agent:is-running', args),
  getCursorPoint: () => ipcRenderer.invoke('window:cursor-point'),
  getWindowBounds: () => ipcRenderer.invoke('window:get-bounds'),
  onWindowMaximized: (cb: (m: boolean) => void) => {
    const listener = (_e: any, m: boolean) => cb(m);
    ipcRenderer.on('window:maximized', listener);
    return () => ipcRenderer.removeListener('window:maximized', listener);
  },
  onDebugLog: (cb: (msg: string) => void) => {
    const listener = (_e: any, msg: string) => cb(msg);
    ipcRenderer.on('debug:log', listener);
    return () => ipcRenderer.removeListener('debug:log', listener);
  },

  // SSH control
  resetSSHState: (panelId: string) => ipcRenderer.invoke('ssh:reset-state', panelId),
  connectSSH: (panelId: string, sessionId: string, cols?: number, rows?: number) =>
    ipcRenderer.invoke('ssh:connect', { panelId, sessionId, cols, rows }),
  connectSSHWithPassword: (panelId: string, sessionId: string, password: string, cols?: number, rows?: number) =>
    ipcRenderer.invoke('ssh:connect-with-password', { panelId, sessionId, password, cols, rows }),
  quickConnectSSH: (panelId: string, session: any, cols?: number, rows?: number) =>
    ipcRenderer.invoke('ssh:quick-connect', { panelId, session, cols, rows }),
  // 텔넷(raw TCP) 접속 — 접근통제 솔루션 로컬 평문 프록시용
  telnetConnect: (panelId: string, host: string, port: number, cols?: number, rows?: number, encoding?: string) =>
    ipcRenderer.invoke('telnet:connect', { panelId, host, port, cols, rows, encoding }),
  isSSHConnected: (panelId: string) =>
    ipcRenderer.invoke('ssh:is-connected', panelId),
  sendSSHInput: (panelId: string, data?: string, b64?: string) =>
    ipcRenderer.send('ssh:input', { panelId, data, b64 }),
  disconnectSSH: (panelId: string) =>
    ipcRenderer.send('ssh:disconnect', { panelId }),
  resizeSSH: (panelId: string, cols: number, rows: number, force?: boolean) =>
    ipcRenderer.send('ssh:resize', { panelId, cols, rows, force }),
  setSSHEncoding: (panelId: string, encoding: string) =>
    ipcRenderer.invoke('ssh:set-encoding', { panelId, encoding }),
  getSSHEncoding: (panelId: string) =>
    ipcRenderer.invoke('ssh:get-encoding', panelId),
  setSSHAutoTrack: (panelId: string, enabled: boolean) =>
    ipcRenderer.invoke('ssh:set-auto-track', { panelId, enabled }),

  // App
  refocusWindow: () => ipcRenderer.invoke('win:refocus'),
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  getReleaseNotes: () => ipcRenderer.invoke('app:get-release-notes'),
  // AI Chat: paste/drop 된 이미지·바이너리를 디스크 임시 파일로 저장 후 경로 반환
  chatSavePastedBlob: (dataUrl: string, name?: string, mimeType?: string) => ipcRenderer.invoke('chat:save-pasted-blob', { dataUrl, name, mimeType }),
  // 외부 드래그(Explorer) 로 받은 File 의 실제 파일시스템 경로 조회 (Electron 30+ webUtils API)
  getPathForFile: (file: File): string | null => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { webUtils } = require('electron');
      const p = webUtils?.getPathForFile?.(file);
      return p || null;
    } catch { return null; }
  },
  // 메인 프로세스에서 절대경로 파일을 chat 첨부 디렉토리로 복사 후 경로 반환
  chatCopyExternalFile: (srcPath: string, displayName?: string) => ipcRenderer.invoke('chat:copy-external-file', { srcPath, displayName }),
  // transparent BrowserWindow drag-drop 우회 — 메인의 will-navigate 가 file:// 을 가로채면
  // 여기로 파일 경로가 도착. ClaudeChat 이 구독해 첨부 처리.
  onChatExternalFileDropped: (handler: (payload: { path: string }) => void) => {
    const listener = (_e: any, payload: any) => handler(payload);
    ipcRenderer.on('chat:external-file-dropped', listener);
    return () => ipcRenderer.removeListener('chat:external-file-dropped', listener);
  },
  // native drag-drop 등록 결과 진단용 (DevTools 콘솔에서 확인 가능)
  onChatDragDropStatus: (handler: (payload: { ok: boolean; msg: string }) => void) => {
    const listener = (_e: any, payload: any) => handler(payload);
    ipcRenderer.on('chat:drag-drop-status', listener);
    return () => ipcRenderer.removeListener('chat:drag-drop-status', listener);
  },

  // ── 자동 업데이트 (electron-updater / GitHub Releases) ──
  updaterCheck: () => ipcRenderer.invoke('updater:check'),
  updaterDownload: () => ipcRenderer.invoke('updater:download'),
  updaterQuitAndInstall: () => ipcRenderer.invoke('updater:quit-and-install'),
  updaterGetState: () => ipcRenderer.invoke('updater:state'),
  onUpdaterStatus: (handler: (payload: any) => void) => {
    const listener = (_e: any, payload: any) => handler(payload);
    ipcRenderer.on('updater:status', listener);
    return () => ipcRenderer.removeListener('updater:status', listener);
  },
  getStartupCwd: () => ipcRenderer.invoke('app:startup-cwd'),
  clearStartupCwd: () => ipcRenderer.invoke('app:clear-startup-cwd'),
  // 외부 프로그램이 ssh://host:port 인자로 호출 시 자동 접속 대상
  getStartupSshTarget: () => ipcRenderer.invoke('app:startup-ssh-target'),
  clearStartupSshTarget: () => ipcRenderer.invoke('app:clear-startup-ssh-target'),
  registerContextMenu: () => ipcRenderer.invoke('app:register-context-menu'),
  unregisterContextMenu: () => ipcRenderer.invoke('app:unregister-context-menu'),
  checkContextMenu: () => ipcRenderer.invoke('app:check-context-menu'),

  // Local Shell (PTY)
  ptyListShells: () => ipcRenderer.invoke('pty:list-shells'),
  ptySpawn: (panelId: string, shell?: string, cols?: number, rows?: number, cwd?: string) =>
    ipcRenderer.invoke('pty:spawn', { panelId, shell, cols, rows, cwd }),
  ptyInput: (panelId: string, data: string) =>
    ipcRenderer.send('pty:input', { panelId, data }),
  ptyResize: (panelId: string, cols: number, rows: number) =>
    ipcRenderer.send('pty:resize', { panelId, cols, rows }),
  ptyKill: (panelId: string) =>
    ipcRenderer.send('pty:kill', { panelId }),
  onPtyData: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('pty:data', handler);
    return () => ipcRenderer.removeListener('pty:data', handler);
  },
  onPtyExit: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('pty:exit', handler);
    return () => ipcRenderer.removeListener('pty:exit', handler);
  },

  // SSH events
  onSSHData: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('ssh:data', handler);
    return () => ipcRenderer.removeListener('ssh:data', handler);
  },
  onSSHConnected: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('ssh:connected', handler);
    return () => ipcRenderer.removeListener('ssh:connected', handler);
  },
  onSSHClosed: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('ssh:closed', handler);
    return () => ipcRenderer.removeListener('ssh:closed', handler);
  },
  onSSHError: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('ssh:error', handler);
    return () => ipcRenderer.removeListener('ssh:error', handler);
  },
  onSSHAutoTrack: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('ssh:auto-track', handler);
    return () => ipcRenderer.removeListener('ssh:auto-track', handler);
  },
  onSSHPwd: (cb: (p: { panelId: string; pwd: string }) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('ssh:pwd', handler);
    return () => ipcRenderer.removeListener('ssh:pwd', handler);
  },
  onSSHAuthPrompt: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('ssh:auth-prompt', handler);
    return () => ipcRenderer.removeListener('ssh:auth-prompt', handler);
  },
  sshAuthResponse: (panelId: string, responses: string[]) =>
    ipcRenderer.invoke('ssh:auth-response', { panelId, responses }),

  // Git 상태 — local cwd 또는 원격 SSH 세션의 git repo
  gitStatus: (params: { mode: 'local' | 'remote'; termId?: string; cwd?: string }) => ipcRenderer.invoke('git:status', params),

  // Claude Code CLI
  claudeCheck: () => ipcRenderer.invoke('claude:check'),
  claudeSend: (sessionId: string, prompt: string, addDirs?: string[], disallowBash?: boolean, sshTermId?: string, resumeSessionId?: string | null, permissionMode?: string, model?: string, perToolApproval?: boolean, requestId?: string, effort?: string, sshSessions?: { id: string; label: string }[]) =>
    ipcRenderer.invoke('claude:send', { sessionId, prompt, addDirs, disallowBash, sshTermId, resumeSessionId, permissionMode, model, perToolApproval, requestId, effort, sshSessions }),
  claudeHookRespond: (approvalId: string, decision: 'allow' | 'deny', reason?: string) =>
    ipcRenderer.invoke('claude:hook-respond', { approvalId, decision, reason }),
  onClaudeHookApprovalRequest: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('claude:hook-approval-request', handler);
    return () => ipcRenderer.removeListener('claude:hook-approval-request', handler);
  },
  claudeRegisterMount: (panelId: string, sessionLabel: string) =>
    ipcRenderer.invoke('claude:register-mount', { panelId, sessionLabel }),
  claudeUnregisterMount: (panelId: string) =>
    ipcRenderer.invoke('claude:unregister-mount', { panelId }),
  claudeGetMountPath: (panelId: string, remotePath: string) =>
    ipcRenderer.invoke('claude:get-mount-path', { panelId, remotePath }),
  claudeStop: (sessionId: string, requestId?: string) => ipcRenderer.invoke('claude:stop', { sessionId, requestId }),
  geminiCheck: () => ipcRenderer.invoke('gemini:check'),
  geminiModelInfo: () => ipcRenderer.invoke('gemini:modelInfo'),
  debugDump: (name: string, content: string) => ipcRenderer.invoke('debug:dump', { name, content }),
  geminiSend: (sessionId: string, prompt: string, requestId?: string, model?: string, yolo?: boolean, addDirs?: string[], sshTermId?: string, sshSessions?: { id: string; label: string }[]) =>
    ipcRenderer.invoke('gemini:send', { sessionId, prompt, requestId, model, yolo, addDirs, sshTermId, sshSessions }),
  geminiStop: (sessionId: string, requestId?: string) => ipcRenderer.invoke('gemini:stop', { sessionId, requestId }),
  codexCheck: () => ipcRenderer.invoke('codex:check'),
  codexRateLimits: () => ipcRenderer.invoke('codex:rateLimits'),
  codexSend: (sessionId: string, prompt: string, requestId?: string, model?: string, approvalPolicy?: string, effort?: string, sshTermId?: string, sshSessions?: Array<{ id: string; label: string }>) =>
    ipcRenderer.invoke('codex:send', { sessionId, prompt, requestId, model, approvalPolicy, effort, sshTermId, sshSessions }),
  codexStop: (sessionId: string, requestId?: string) => ipcRenderer.invoke('codex:stop', { sessionId, requestId }),
  claudeProbeUsage: () => ipcRenderer.invoke('claude:probe-usage'),
  claudeProbeUsageTui: () => ipcRenderer.invoke('claude:probe-usage-tui'),
  claudeFetchUsageApi: () => ipcRenderer.invoke('claude:fetch-usage-api'),
  claudeFetchModels: () => ipcRenderer.invoke('claude:fetch-models'),
  claudeReadSettings: () => ipcRenderer.invoke('claude:read-settings'),
  clipboardWriteImage: (dataUrl: string) => ipcRenderer.invoke('clipboard:write-image', { dataUrl }),
  x11Start: (displayNum?: number) => ipcRenderer.invoke('x11:start', displayNum ?? 0),
  x11Stop: (displayNum?: number) => ipcRenderer.invoke('x11:stop', displayNum ?? 0),
  x11Status: () => ipcRenderer.invoke('x11:status'),
  pasteModalOpen: (id: string, text: string, accumulate?: boolean) => ipcRenderer.invoke('paste-modal:open', { id, text, accumulate: !!accumulate }),
  onPasteModalResult: (cb: (p: { id: string; action: 'paste' | 'cancel'; text: string }) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('paste-modal:result', handler);
    return () => ipcRenderer.removeListener('paste-modal:result', handler);
  },
  searchOpenWindow: () => ipcRenderer.invoke('search:open-window'),
  optionsOpen: () => ipcRenderer.invoke('options:open'),
  optionsClose: () => ipcRenderer.send('options:close'),
  optionsSaved: () => ipcRenderer.send('options:saved'),
  onOptionsSaved: (cb: () => void) => {
    const h = () => cb(); ipcRenderer.on('options:saved', h);
    return () => ipcRenderer.removeListener('options:saved', h);
  },
  sessionEditorOpen: (sessionId: string) => ipcRenderer.invoke('session-editor:open', { sessionId }),
  sessionEditorClose: () => ipcRenderer.send('session-editor:close'),
  sessionEditorSaved: (payload: any) => ipcRenderer.send('session-editor:saved', payload),
  onSessionEditorSaved: (cb: (p: any) => void) => {
    const h = (_: any, p: any) => cb(p); ipcRenderer.on('session-editor:saved', h);
    return () => ipcRenderer.removeListener('session-editor:saved', h);
  },
  sendSearchResult: (payload: { current: number; total: number }) => ipcRenderer.send('search:result', payload),
  onSearchQuery: (cb: (p: { q: string; caseSensitive: boolean; useRegex: boolean }) => void) => {
    const h = (_: any, p: any) => cb(p); ipcRenderer.on('search:query', h);
    return () => ipcRenderer.removeListener('search:query', h);
  },
  onSearchNext: (cb: (p?: any) => void) => { const h = (_: any, p: any) => cb(p); ipcRenderer.on('search:next', h); return () => ipcRenderer.removeListener('search:next', h); },
  onSearchPrev: (cb: (p?: any) => void) => { const h = (_: any, p: any) => cb(p); ipcRenderer.on('search:prev', h); return () => ipcRenderer.removeListener('search:prev', h); },
  onSearchClosed: (cb: () => void) => { const h = () => cb(); ipcRenderer.on('search:closed', h); return () => ipcRenderer.removeListener('search:closed', h); },
  onSearchDock: (cb: () => void) => { const h = () => cb(); ipcRenderer.on('search:dock', h); return () => ipcRenderer.removeListener('search:dock', h); },
  // i18n
  i18nListLanguages: () => ipcRenderer.invoke('i18n:list-languages'),
  i18nListNamespaces: (lang: string) => ipcRenderer.invoke('i18n:list-namespaces', { lang }),
  i18nLoad: (lang: string, ns: string) => ipcRenderer.invoke('i18n:load', { lang, ns }),
  i18nLoadBundled: (lang: string, ns: string) => ipcRenderer.invoke('i18n:load-bundled', { lang, ns }),
  i18nLoadOverride: (lang: string, ns: string) => ipcRenderer.invoke('i18n:load-override', { lang, ns }),
  i18nSaveOverride: (lang: string, ns: string, kv: Record<string, string>) => ipcRenderer.invoke('i18n:save-override', { lang, ns, kv }),
  i18nAddLanguage: (lang: string) => ipcRenderer.invoke('i18n:add-language', { lang }),
  i18nRemoveLanguage: (lang: string) => ipcRenderer.invoke('i18n:remove-language', { lang }),
  i18nAutoTranslate: (sourceLang: string, targetLang: string, items: Record<string, string>, apiKey?: string) =>
    ipcRenderer.invoke('i18n:auto-translate', { sourceLang, targetLang, items, apiKey }),
  i18nSetLang: (lang: string) => ipcRenderer.invoke('i18n:set-lang', { lang }),

  // OpenVPN
  vpnAvailable: () => ipcRenderer.invoke('vpn:available'),
  vpnState: () => ipcRenderer.invoke('vpn:state'),
  vpnLogs: () => ipcRenderer.invoke('vpn:logs'),
  vpnListConfigs: () => ipcRenderer.invoke('vpn:list-configs'),
  vpnImportConfig: (srcPath?: string) => ipcRenderer.invoke('vpn:import-config', { srcPath }),
  vpnRemoveConfig: (filePath: string) => ipcRenderer.invoke('vpn:remove-config', { filePath }),
  vpnConnect: (configPath: string, username?: string, password?: string) =>
    ipcRenderer.invoke('vpn:connect', { configPath, username, password }),
  vpnDisconnect: () => ipcRenderer.invoke('vpn:disconnect'),
  vpnSaveCreds: (configPath: string, username: string, password: string) => ipcRenderer.invoke('vpn:save-creds', { configPath, username, password }),
  vpnLoadCreds: (configPath: string) => ipcRenderer.invoke('vpn:load-creds', { configPath }),
  vpnClearCreds: (configPath: string) => ipcRenderer.invoke('vpn:clear-creds', { configPath }),
  vpnHasCreds: (configPath: string) => ipcRenderer.invoke('vpn:has-creds', { configPath }),
  onVpnState: (cb: (state: any) => void) => {
    const h = (_: any, st: any) => cb(st);
    ipcRenderer.on('vpn:state', h);
    return () => ipcRenderer.removeListener('vpn:state', h);
  },
  onVpnLog: (cb: (line: string) => void) => {
    const h = (_: any, line: string) => cb(line);
    ipcRenderer.on('vpn:log', h);
    return () => ipcRenderer.removeListener('vpn:log', h);
  },

  // 파일 비교 (CompareWorkspace)
  compareWalk: (mode: string, basePath: string, termId?: string, maxEntries?: number) =>
    ipcRenderer.invoke('compare:walk', { mode, termId, basePath, maxEntries }),
  compareHash: (mode: string, filePath: string, termId?: string, maxBytes?: number, wsMode?: string) =>
    ipcRenderer.invoke('compare:hash', { mode, termId, filePath, maxBytes, wsMode }),
  compareDownload: (defaultName: string, content: string, encoding?: string) =>
    ipcRenderer.invoke('compare:download', { defaultName, content, encoding }),
  logWatchStart: (watchId: string, mode: string, filePath: string, termId?: string) =>
    ipcRenderer.invoke('log:watch-start', { watchId, mode, termId, filePath }),
  logWatchStop: (watchId: string) =>
    ipcRenderer.invoke('log:watch-stop', { watchId }),
  onLogWatchData: (cb: (p: { watchId: string; text: string }) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('log:watch-data', handler);
    return () => ipcRenderer.removeListener('log:watch-data', handler);
  },
  onLogWatchError: (cb: (p: { watchId: string; error: string }) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('log:watch-error', handler);
    return () => ipcRenderer.removeListener('log:watch-error', handler);
  },
  compareDiffCount: (
    leftMode: string, leftPath: string, leftTermId: string | undefined,
    rightMode: string, rightPath: string, rightTermId: string | undefined,
    maxBytes?: number, wsMode?: string,
  ) => ipcRenderer.invoke('compare:diff-count', {
    leftMode, leftTermId, leftPath, rightMode, rightTermId, rightPath, maxBytes, wsMode,
  }),
  compareRead: (mode: string, filePath: string, termId?: string, maxBytes?: number) =>
    ipcRenderer.invoke('compare:read', { mode, termId, filePath, maxBytes }),
  compareWrite: (mode: string, filePath: string, content: string, termId?: string) =>
    ipcRenderer.invoke('compare:write', { mode, termId, filePath, content }),

  // Terminal recording (REC)
  recStart: (panelId: string, sessionName?: string) => ipcRenderer.invoke('rec:start', { panelId, sessionName }),
  recStop: (panelId: string) => ipcRenderer.invoke('rec:stop', { panelId }),
  recAppend: (panelId: string, data: string, kind?: 'out' | 'in' | 'mark') => ipcRenderer.send('rec:append', { panelId, data, kind }),
  recStatus: (panelId?: string) => ipcRenderer.invoke('rec:status', { panelId }),
  recListActive: () => ipcRenderer.invoke('rec:list-active'),
  onRecError: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('rec:error', handler);
    return () => ipcRenderer.removeListener('rec:error', handler);
  },
  onClaudeStream: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('claude:stream', handler);
    return () => ipcRenderer.removeListener('claude:stream', handler);
  },
});
