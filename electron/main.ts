// electron/main.ts
import { app, BrowserWindow, ipcMain, dialog, Menu, shell, clipboard, nativeImage, safeStorage } from 'electron';

// 백그라운드/blur 상태에서도 렌더러가 정상 동작하도록
// (Windows 에서 자식 프로세스 spawn 이 잠깐 foreground 를 뺏어가도 input/caret 영향 최소화)
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-background-timer-throttling');
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import * as pty from 'node-pty';
import { fileURLToPath } from 'url';
import { loadSessionsData, saveSessionsData, getSessionsPath, saveCustomPath, loadUIPrefs, saveUIPrefs, Session, Folder, SessionsData } from './sessionsStore';
import { getSSHBridge } from './sshBridge';
import { createWebDAVBridge } from './webdavBridge';
import { installX11DisplayHook } from './x11Display';
import { startBundledX11, stopBundledX11, stopAllBundledX11, listRunningX11 } from './x11Bundled';
import { stopEmbeddedX11 } from './x11Server';
import { getVpnService } from './vpnService';
import { listLanguages, listNamespaces, loadNamespace, loadBundledNamespace, loadOverrideNamespace, saveOverrideNamespace, addLanguage, removeLanguage } from './i18nStore';
import { t, setCurrentLang } from './i18n';
// MCP 서버 스크립트를 번들에 임베드 (vite ?raw) — 런타임에 임시 파일로 추출 후 spawn
// @ts-ignore
import mcpSshServerScript from './mcpSshServer.cjs?raw';
// @ts-ignore
import claudeHookScript from './claudeHookScript.cjs?raw';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
(globalThis as any).__dirname = __dirname;

// 멀티 인스턴스 캐시 충돌 방지 — 매 실행 unique sessionData 로 분리하던 코드.
// 단점: Electron 의 safeStorage 가 sessionData 안에 키 파일(Local State 등) 두는 경우
//        매 실행마다 키가 사라져서 자격증명 복호화 실패. 그래서 비활성화.
// 대안 검토 필요: 단일 인스턴스 lock + window focus 회수 패턴 (전형적 Electron 멀티 인스턴스 처리).
// const instanceId = `${process.pid}-${Date.now()}`;
// const sessionDataPath = path.join(app.getPath('userData'), `session-${instanceId}`);
// app.setPath('sessionData', sessionDataPath);

let mainWindow: BrowserWindow | null = null;
let sessionsData: SessionsData = { folders: [], sessions: [] };
const connectedPanels = new Set<string>();
const connectingPanels = new Set<string>();

// Safety net — ssh2 같은 라이브러리에서 뒤늦게 던지는 stray error 로 앱 전체가
// 다이얼로그와 함께 죽지 않도록 uncaught 를 로깅만 하고 삼킨다.
// 치명적 원인은 소스에서 제대로 처리해야 하지만, 최소한 사용자 경험 보호용.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.stack || err);
  try { mainWindow?.webContents.send('debug:log', `[uncaughtException] ${err?.message || err}`); } catch {}
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
  try { mainWindow?.webContents.send('debug:log', `[unhandledRejection] ${(reason as any)?.message || reason}`); } catch {}
});

// 커맨드라인에서 전달된 초기 경로 (탐색기 우클릭 → "터미널에서 열기")
function getStartupCwd(): string | null {
  // 1) 커맨드라인 인자에서 경로 탐색
  const args = process.argv.slice(app.isPackaged ? 1 : 2);
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    try {
      const stat = fs.statSync(arg);
      if (stat.isDirectory()) return arg;
      if (stat.isFile()) return path.dirname(arg);
    } catch {}
  }
  // 2) 임시 파일에서 경로 읽기 (portable 대응)
  const tmpFile = path.join(require('os').tmpdir(), '.pepe-terminal-cwd');
  try {
    const fileStat = fs.statSync(tmpFile);
    // 30초 이내 생성된 파일만 사용 (이전 세션 잔여 파일 무시)
    const tooOld = Date.now() - fileStat.mtimeMs > 30000;
    // 읽기 후 즉시 삭제 (어떤 경우든 파일은 삭제)
    const cwd = tooOld ? '' : fs.readFileSync(tmpFile, 'utf8').trim();
    fs.unlinkSync(tmpFile);
    if (cwd) {
      try {
        const dirStat = fs.statSync(cwd);
        if (dirStat.isDirectory()) return cwd;
        if (dirStat.isFile()) return path.dirname(cwd);
      } catch {}
    }
  } catch {
    // 파일이 없거나 읽기 실패 — 삭제 한번 더 시도
    try { fs.unlinkSync(tmpFile); } catch {}
  }
  return null;
}
let startupCwd: string | null = getStartupCwd();

// 창 최대화 상태 + 복원 좌표
let isMaximized = false;
let savedBounds = { x: 100, y: 100, width: 1400, height: 900 };

function createWindow() {
  if (app.isPackaged) Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    icon: path.join(__dirname, '../public/icon.ico'),
    frame: false,
    transparent: true,
    hasShadow: false,
    show: false, // 준비 완료 후 표시
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true, // 브라우저 워크스페이스 (<webview>) 활성화
    },
  });

  // 콘텐츠 렌더링 완료 후 창 표시 (빈 화면 방지)
  mainWindow.once('ready-to-show', () => { mainWindow?.show(); });

  const devServerUrl = process.env['ELECTRON_RENDERER_URL'] || process.env['VITE_DEV_SERVER_URL'];
  if (!app.isPackaged && devServerUrl) {
    mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  // 타이틀바 더블클릭 → 최대화 토글
  mainWindow.on('maximize', () => {
    console.log('[window] maximize event, bounds:', mainWindow?.getBounds());
    isMaximized = true;
    mainWindow?.webContents.send('window:maximized', true);
  });
  mainWindow.on('unmaximize', () => {
    console.log('[window] unmaximize event, bounds:', mainWindow?.getBounds(), 'savedBounds:', savedBounds);
    isMaximized = false;
    // savedBounds의 위치/크기로 강제 복원 (Windows native restore 좌표 오류 방지)
    if (mainWindow) {
      const cur = mainWindow.getBounds();
      if (cur.x !== savedBounds.x || cur.y !== savedBounds.y || cur.width !== savedBounds.width || cur.height !== savedBounds.height) {
        mainWindow.setBounds(savedBounds);
      }
    }
    mainWindow?.webContents.send('window:maximized', false);
  });
  // non-maximized 상태에서 resize/move가 멈춘 후 300ms 뒤 savedBounds 갱신 (debounce)
  let savedBoundsTimer: NodeJS.Timeout | null = null;
  const updateSaved = () => {
    if (savedBoundsTimer) clearTimeout(savedBoundsTimer);
    savedBoundsTimer = setTimeout(() => {
      if (!mainWindow || isMaximized || mainWindow.isMaximized() || mainWindow.isFullScreen()) return;
      savedBounds = mainWindow.getBounds();
    }, 300);
  };
  mainWindow.on('resize', updateSaved);
  mainWindow.on('move', updateSaved);

  mainWindow.on('closed', () => {
    mainWindow = null;
    // 메인 창 닫히면 검색창/이력 dropdown 도 같이 닫음
    try { if (searchWindow && !searchWindow.isDestroyed()) searchWindow.close(); } catch {}
    try { if (histDropdownWindow && !histDropdownWindow.isDestroyed()) histDropdownWindow.close(); } catch {}
    // 페이스트 모달 창들도 정리
    for (const [, pw] of pasteWindows) { try { if (!pw.isDestroyed()) pw.close(); } catch {} }
  });
}

// ── App lifecycle ──

// 자기서명 인증서 / 사설 CA 서버 접속 허용 — 내부 인프라 (172.x, 10.x, 192.168.x) 가 흔히 self-signed.
// 브라우저 워크스페이스의 <webview> 와 fetch 모두에 영향. 외부 공용 사이트는 일반적으로 정상 cert 라 영향 없음.
// 보안 트레이드오프: 이 앱은 신뢰된 내부 도구 환경 가정. 공용 사이트의 MITM 까지 허용되므로 주의.
app.on('certificate-error', (event, _webContents, url, error, _certificate, callback) => {
  console.warn('[certificate-error] allowing', { url, error });
  event.preventDefault();
  callback(true);
});

app.whenReady().then(() => {
  sessionsData = loadSessionsData();
  createWindow();
  installX11DisplayHook();

  // ── SFTP 고빈도 이벤트 배치 버퍼 ──────────────────────────────────────────
  // file-start / dir-list / complete / progress 를 setImmediate 로 묶어
  // webContents.send 호출 횟수를 최소화 → 터미널 I/O 이벤트 우선 처리 보장.
  // (setImmediate 는 Node 이벤트루프 "check" 단계 실행 — I/O poll 이후이므로
  //  SSH 소켓 수신 데이터가 먼저 처리된 뒤 IPC 전송이 일어남)
  const sftpBatchBuf: Array<{ channel: string; payload: any }> = [];
  let sftpBatchScheduled = false;
  function flushSftpBatch() {
    sftpBatchScheduled = false;
    if (!sftpBatchBuf.length || !mainWindow) return;
    const batch = sftpBatchBuf.splice(0);
    mainWindow.webContents.send('sftp:batch', batch);
  }
  function queueSftpEvent(channel: string, payload: any) {
    sftpBatchBuf.push({ channel, payload });
    if (!sftpBatchScheduled) { sftpBatchScheduled = true; setImmediate(flushSftpBatch); }
  }

  const bridge = getSSHBridge();
  bridge.onMessage((msg) => {
    if (!mainWindow) return;

    switch (msg.type) {
      case 'data':
        mainWindow.webContents.send('ssh:data', { panelId: msg.panelId, data: msg.data });
        break;
      case 'connected':
        connectingPanels.delete(msg.panelId);
        connectedPanels.add(msg.panelId);
        mainWindow.webContents.send('ssh:connected', { panelId: msg.panelId });
        break;
      case 'closed':
        connectingPanels.delete(msg.panelId);
        connectedPanels.delete(msg.panelId);
        mainWindow.webContents.send('ssh:closed', { panelId: msg.panelId });
        break;
      case 'error':
        connectingPanels.delete(msg.panelId);
        mainWindow.webContents.send('ssh:error', { panelId: msg.panelId, error: msg.error });
        break;
      case 'auth-prompt':
        mainWindow.webContents.send('ssh:auth-prompt', { panelId: msg.panelId, prompts: msg.prompts });
        break;
      case 'sftp-progress':
        // progress 는 고빈도 — 배치로 묶어 전송
        queueSftpEvent('sftp:progress', { panelId: msg.panelId, data: msg.data });
        break;
      case 'sftp-complete':
        // complete 는 고빈도 — 배치로 묶어 전송
        queueSftpEvent('sftp:complete', { panelId: msg.panelId, data: msg.data });
        break;
      case 'sftp-error':
        mainWindow.webContents.send('sftp:error', { panelId: msg.panelId, error: msg.error, data: (msg as any).data });
        break;
      case 'sftp-transfer-start':
        // 전송 시작은 즉시 — UI 에 즉각 표시
        mainWindow.webContents.send('sftp:transfer-start', { panelId: msg.panelId, data: msg.data });
        break;
      case 'sftp-file-start':
        // file-start 는 고빈도 — 배치로 묶어 전송
        queueSftpEvent('sftp:file-start', { panelId: msg.panelId, data: msg.data });
        break;
      case 'sftp-dir-list':
        // dir-list 는 고빈도 — 배치로 묶어 전송
        queueSftpEvent('sftp:dir-list', { panelId: msg.panelId, data: msg.data });
        break;
      case 'sftp-conflict':
        // conflict 는 즉시 — 사용자 응답 대기
        mainWindow.webContents.send('sftp:conflict', { panelId: msg.panelId, data: msg.data });
        break;
      case 'auto-track':
        mainWindow.webContents.send('ssh:auto-track', { panelId: msg.panelId, enabled: msg.enabled });
        break;
      case 'x11-log':
        // x11 관련 로그를 renderer 콘솔로 — DevTools 에서 확인
        mainWindow.webContents.executeJavaScript(`console.log('[X11]', ${JSON.stringify(msg.data)})`).catch(() => {});
        break;
      case 'sftp-delete-start':
        mainWindow.webContents.send('sftp:delete-start', { panelId: msg.panelId, data: msg.data });
        break;
      case 'sftp-delete-progress':
        // delete-progress 고빈도 — 배치로 묶어 전송
        queueSftpEvent('sftp:delete-progress', { panelId: msg.panelId, data: msg.data });
        break;
      case 'sftp-delete-complete':
        mainWindow.webContents.send('sftp:delete-complete', { panelId: msg.panelId, data: msg.data });
        break;
    }
  });
});

app.on('window-all-closed', () => {
  // 단일 윈도우 앱 — macOS 에서도 마지막 창 닫히면 완전 종료 (activate 핸들러 없어 dock 클릭으로 복귀 불가).
  app.quit();
});

// 앱 종료 직전 — 띄워놓은 모든 VcXsrv/embedded X 서버 + 활성 SSH 세션 정리.
// PTY/Claude 자식 프로세스 정리는 파일 하단에서 추가 등록 (Map 선언 후).
// WebDAV 는 별도 종료 API 가 없지만 SSH 끊으면 의존 스트림이 모두 close.
app.on('before-quit', () => {
  try { stopAllBundledX11(); } catch {}
  try { getSSHBridge().disconnectAll(); } catch {}
});

// 앱 시작 5초 후 비동기로 과거 session-* 폴더 정리 (현재 더 이상 안 만드는데 기존 orphan 잔존 가능)
setTimeout(() => {
  try {
    const userDataDir = app.getPath('userData');
    for (const entry of fs.readdirSync(userDataDir)) {
      if (!entry.startsWith('session-')) continue;
      try { fs.rmSync(path.join(userDataDir, entry), { recursive: true }); } catch {}
    }
  } catch {}
}, 5000);

// ── Session IPC ──

ipcMain.handle('sessions:path', () => {
  try { return getSessionsPath(); }
  catch { return ''; }
});

ipcMain.handle('sessions:set-path', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: t('dialog.sessionsPathTitle'),
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const newPath = path.join(result.filePaths[0], 'sessions.json');
  saveCustomPath(newPath);
  // 새 경로에서 데이터 다시 로드
  sessionsData = loadSessionsData();
  return { path: newPath, data: sessionsData };
});

ipcMain.handle('sessions:reset-path', () => {
  saveCustomPath(null);
  sessionsData = loadSessionsData();
  return { path: getSessionsPath(), data: sessionsData };
});

ipcMain.handle('sessions:open-folder', () => {
  try { shell.openPath(path.dirname(path.join(app.getPath('userData'), 'sessions.json'))); }
  catch {}
});

ipcMain.handle('sessions:open-editor', () => {
  try { shell.openPath(path.join(app.getPath('userData'), 'sessions.json')); }
  catch {}
});

ipcMain.handle('ui-prefs:get', () => loadUIPrefs());
ipcMain.handle('ui-prefs:set', (_e, prefs: Record<string, any>) => { saveUIPrefs(prefs); return true; });

ipcMain.handle('app:get-version', () => app.getVersion());
ipcMain.handle('app:get-release-notes', () => {
  // 빌드 후 패키지된 release notes 파일들 — 최신 버전 우선 매칭
  const v = app.getVersion();
  const candidates = [
    path.join(process.resourcesPath, 'docs', `RELEASE_v${v}.md`),
    path.join(app.getAppPath(), 'docs', `RELEASE_v${v}.md`),
    path.join(__dirname, '..', '..', 'docs', `RELEASE_v${v}.md`),
    path.join(__dirname, '..', 'docs', `RELEASE_v${v}.md`),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
    } catch {}
  }
  return null;
});
// Electron native confirm/alert 후 Chromium renderer focus 가 멈춰서 caret 이 안 그려지는 버그 우회.
// OS 레벨 blur → focus 사이클을 강제로 한 번 돌리면 alt-tab 한 효과와 동일하게 focus 정상 복귀.
ipcMain.handle('win:refocus', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  try { win.blur(); win.focus(); } catch {}
});

ipcMain.handle('app:startup-cwd', () => startupCwd);
ipcMain.handle('app:clear-startup-cwd', () => {
  startupCwd = null;
  // 임시 파일도 확실히 삭제
  try { fs.unlinkSync(path.join(require('os').tmpdir(), '.pepe-terminal-cwd')); } catch {}
});

// 여러 줄 붙여넣기 — 별도 BrowserWindow (다른 모니터로도 이동 가능)
const pasteWindows = new Map<string, BrowserWindow>();
ipcMain.handle('paste-modal:open', (_e, { id, text }: { id: string; text: string }) => {
  // 같은 id 의 기존 창은 닫기
  const exist = pasteWindows.get(id);
  if (exist && !exist.isDestroyed()) { try { exist.close(); } catch {} }

  // 메인 창의 우상단 부근에 위치 (검색창과 같은 영역)
  let pasteX = 100, pasteY = 100;
  if (mainWindow && !mainWindow.isDestroyed()) {
    const b = mainWindow.getBounds();
    pasteX = Math.max(b.x + 24, b.x + b.width - 600 - 100);
    pasteY = b.y + 60;
  }
  const win = new BrowserWindow({
    x: pasteX, y: pasteY,
    width: 620, height: 460,
    minWidth: 360, minHeight: 240,
    frame: false, resizable: true,
    thickFrame: false,                 // Windows Aero Snap (자석) 비활성
    transparent: false, hasShadow: true,
    backgroundColor: '#1a1a1a',
    parent: mainWindow ?? undefined,
    modal: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    title: t('popup.pasteModalTitle'),
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  try { win.setAlwaysOnTop(true, 'floating'); } catch {}
  win.once('ready-to-show', () => { try { win.show(); win.focus(); } catch {} });
  pasteWindows.set(id, win);
  win.on('closed', () => { pasteWindows.delete(id); });

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    html,body { margin:0; padding:0; background:#1a1a1a; color:#eee; font-family: 'Segoe UI', sans-serif; height:100%; overflow:hidden; -webkit-user-select:none; user-select:none; }
    .header { padding:10px 14px; border-bottom:1px solid #333; display:flex; align-items:center; justify-content:space-between; -webkit-app-region:drag; cursor:move; background:#222; }
    .header strong { font-size:13px; }
    .header button { -webkit-app-region:no-drag; background:transparent; border:none; color:#aaa; cursor:pointer; font-size:16px; padding:0 4px; }
    .body { padding:14px; display:flex; flex-direction:column; height: calc(100% - 41px); box-sizing:border-box; }
    .body p { color:#888; font-size:12px; margin:0 0 8px; }
    textarea { flex:1; min-height:0; width:100%; box-sizing:border-box; background:#111; color:#eee; border:1px solid #333; border-radius:4px; padding:8px; font-size:12px; font-family:monospace; resize:none; -webkit-user-select:text; user-select:text; }
    .actions { display:flex; gap:8px; margin-top:12px; justify-content:flex-end; }
    .actions button { padding:6px 16px; border:none; border-radius:4px; cursor:pointer; font-size:12px; }
    .btn-cancel { background:#333; border:1px solid #555 !important; color:#eee; }
    .btn-paste { background:#2b6b9b; border:1px solid #3a8bc8 !important; color:#fff; }
  </style></head><body>
    <div class="header">
      <strong>${t('paste.title')}</strong>
      <button id="x">✕</button>
    </div>
    <div class="body">
      <p>${t('paste.prompt')}</p>
      <textarea id="t" autofocus spellcheck="false"></textarea>
      <div class="actions">
        <button id="c" class="btn-cancel">${t('paste.cancel')}</button>
        <button id="p" class="btn-paste">${t('paste.paste')}</button>
      </div>
    </div>
    <script>
      const { ipcRenderer } = require('electron');
      const t = document.getElementById('t');
      t.value = ${JSON.stringify(text)};
      t.focus();
      const sendResult = (action) => ipcRenderer.send('paste-modal:result', { id: ${JSON.stringify(id)}, action, text: t.value });
      document.getElementById('x').onclick = () => sendResult('cancel');
      document.getElementById('c').onclick = () => sendResult('cancel');
      document.getElementById('p').onclick = () => sendResult('paste');
      t.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') sendResult('cancel');
        else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendResult('paste'); }
      });
    </script>
  </body></html>`;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  return { success: true };
});

// 결과 IPC — id 별로 main → renderer 로 forward
ipcMain.on('paste-modal:result', (_e, payload: { id: string; action: 'paste' | 'cancel'; text: string }) => {
  const win = pasteWindows.get(payload.id);
  if (win && !win.isDestroyed()) { try { win.close(); } catch {} }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('paste-modal:result', payload);
  }
});

// 옵션 popout 창
let optionsWindow: BrowserWindow | null = null;
ipcMain.handle('options:open', () => {
  if (optionsWindow && !optionsWindow.isDestroyed()) { optionsWindow.focus(); return { success: true }; }
  if (!mainWindow || mainWindow.isDestroyed()) return { success: false };
  const baseUrl = mainWindow.webContents.getURL().split('?')[0].split('#')[0];
  const sep = baseUrl.includes('?') ? '&' : '?';
  const popUrl = `${baseUrl}${sep}popout=options`;
  const win = new BrowserWindow({
    width: 560, height: 720,
    minWidth: 480, minHeight: 500,
    frame: false, resizable: true,
    backgroundColor: '#111',
    parent: mainWindow,
    skipTaskbar: true,
    title: t('popup.optionsTitle'),
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
  });
  win.setMenu(null);
  optionsWindow = win;
  win.on('closed', () => { optionsWindow = null; });
  win.loadURL(popUrl);
  return { success: true };
});
ipcMain.on('options:close', () => {
  if (optionsWindow && !optionsWindow.isDestroyed()) { try { optionsWindow.close(); } catch {} }
});
ipcMain.on('options:saved', () => {
  // 메인 창에 알림 (필요하면 설정 reload)
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('options:saved');
  if (optionsWindow && !optionsWindow.isDestroyed()) { try { optionsWindow.close(); } catch {} }
});

// 세션 편집기 popout 창 — 동일 renderer URL 을 ?popout=session-editor 로 다시 로드
let sessionEditorWindow: BrowserWindow | null = null;
ipcMain.handle('session-editor:open', (_e, { sessionId }: { sessionId: string }) => {
  if (sessionEditorWindow && !sessionEditorWindow.isDestroyed()) { sessionEditorWindow.focus(); return { success: true }; }
  if (!mainWindow || mainWindow.isDestroyed()) return { success: false };
  const baseUrl = mainWindow.webContents.getURL().split('?')[0].split('#')[0];
  const sep = baseUrl.includes('?') ? '&' : '?';
  const popUrl = `${baseUrl}${sep}popout=session-editor&sessionId=${encodeURIComponent(sessionId || 'new')}`;
  const win = new BrowserWindow({
    width: 560, height: 780,
    minWidth: 480, minHeight: 600,
    frame: false, resizable: true, thickFrame: false,
    transparent: false, hasShadow: true,
    roundedCorners: false,            // Windows 11 둥근 모서리 / 보라색 accent border 비활성
    backgroundColor: '#111',
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    title: t('popup.sessionEditorTitle'),
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
  });
  try { win.setAlwaysOnTop(true, 'floating'); } catch {}
  win.once('ready-to-show', () => { try { win.show(); win.focus(); } catch {} });
  win.setMenu(null); // File/Edit/... 메뉴 제거
  sessionEditorWindow = win;
  win.on('closed', () => { sessionEditorWindow = null; });
  win.loadURL(popUrl);
  return { success: true };
});
ipcMain.on('session-editor:close', () => {
  if (sessionEditorWindow && !sessionEditorWindow.isDestroyed()) { try { sessionEditorWindow.close(); } catch {} }
});
ipcMain.on('session-editor:saved', (_e, payload) => {
  // 저장 완료 후 메인 창에 알림 → 세션 목록 갱신
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('session-editor:saved', payload);
  if (sessionEditorWindow && !sessionEditorWindow.isDestroyed()) { try { sessionEditorWindow.close(); } catch {} }
});

// 검색 창 — 별도 BrowserWindow (다른 모니터로도 이동 가능)
let searchWindow: BrowserWindow | null = null;
ipcMain.handle('search:open-window', () => {
  if (searchWindow && !searchWindow.isDestroyed()) { searchWindow.focus(); return { success: true }; }
  const SEARCH_W = 470;
  const SEARCH_H = 32;
  // 처음 위치 — 메인 창의 우측 상단에 정렬
  let posX = 100, posY = 100;
  if (mainWindow && !mainWindow.isDestroyed()) {
    const b = mainWindow.getBounds();
    // 메인 창 상단 가운데 부근 — 타이틀바 영역과 겹치지 않게 우측 시스템 버튼 (_□X) 좌측에 배치
    posX = Math.max(b.x + 24, b.x + b.width - SEARCH_W - 140);
    posY = b.y + 4;
  }
  const win = new BrowserWindow({
    x: posX, y: posY,
    width: SEARCH_W, height: SEARCH_H,
    minWidth: SEARCH_W, minHeight: SEARCH_H, maxWidth: SEARCH_W, maxHeight: SEARCH_H,
    frame: false, resizable: false,
    transparent: false, hasShadow: true,
    backgroundColor: '#1a1a1a',
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: t('popup.searchTitle'),
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
  });
  // 메인 창보다 위, 다른 alwaysOnTop 창보다는 아래 (UI 레벨)
  try { win.setAlwaysOnTop(true, 'floating'); } catch {}
  win.once('ready-to-show', () => { try { win.show(); win.focus(); } catch {} });
  searchWindow = win;
  win.on('closed', () => {
    searchWindow = null;
    closeHistDropdown();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('search:closed');
  });
  win.on('move', () => closeHistDropdown());      // 검색창 이동 시 dropdown 닫기 (위치 안 맞아짐)
  win.on('resize', () => closeHistDropdown());

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:#1a1a1a;color:#eee;font-family:'Segoe UI',sans-serif;height:100%;overflow:visible;-webkit-user-select:none;user-select:none;font-size:11px;}
    .row{display:flex;align-items:center;gap:2px;padding:0 4px;height:100%;-webkit-app-region:drag;cursor:move;}
    .grip{font-size:10px;color:#666;padding:0 1px;-webkit-app-region:drag;cursor:move;user-select:none;}
    .input-wrap{position:relative;display:flex;-webkit-app-region:no-drag;width:180px;flex:0 0 auto;margin-right:2px;}
    input{flex:1;min-width:0;background:#111;color:#eee;border:1px solid #333;border-radius:3px 0 0 3px;padding:2px 5px;font-size:11px;outline:none;-webkit-user-select:text;user-select:text;cursor:text;}
    input:focus{border-color:#2b6b9b;}
    .hist-toggle{background:#222;color:#aaa;border:1px solid #333;border-left:none;border-radius:0 3px 3px 0;padding:0 3px;cursor:pointer;font-size:9px;}
    button{-webkit-app-region:no-drag;background:#333;color:#eee;border:1px solid #555;border-radius:3px;padding:1px 3px;cursor:pointer;font-size:11px;min-width:18px;line-height:1.3;}
    button:hover{background:#444;}
    button.active{background:#2b6b9b;border-color:#3a8bc8;}
    .mode{display:flex;border:1px solid #555;border-radius:3px;overflow:hidden;-webkit-app-region:no-drag;margin-left:2px;flex-shrink:0;}
    .mode button{border:none;border-radius:0;min-width:auto;padding:1px 6px;background:#2a2a2a;font-size:10px;white-space:nowrap;}
    .mode button.active{background:#2b6b9b;}
    .mode button + button{border-left:1px solid #555;}
    .count{font-size:10px;color:#aaa;min-width:32px;text-align:center;-webkit-app-region:drag;padding:0 2px;}
    .close{padding:1px 5px;}
  </style></head><body>
    <div class="row">
      <span class="grip" title="${t('search.dragToMove')}">⋮⋮</span>
      <div class="input-wrap">
        <input id="q" type="text" placeholder="${t('search.placeholder')}" autofocus spellcheck="false" />
        <button class="hist-toggle" id="hist" title="${t('search.history')}" tabindex="-1">▾</button>
      </div>
      <span class="count" id="cnt">0/0</span>
      <button id="prev" title="Previous (Shift+Enter)">▲</button>
      <button id="next" title="Next (Enter)">▼</button>
      <button id="aa" title="${t('search.caseSensitive')}">Aa</button>
      <button id="re" title="${t('search.regex')}">.*</button>
      <div class="mode">
        <button id="m-cur" class="active" title="${t('search.currentTab')}">${t('search.currentTabShort')}</button>
        <button id="m-all" title="${t('search.allTabs')}">${t('search.allShort')}</button>
      </div>
      <button id="dock" title="${t('search.dockToApp')}">📌</button>
      <button id="x" class="close" title="${t('search.closeEsc')}">✕</button>
    </div>
    <script>
      const { ipcRenderer } = require('electron');
      const q = document.getElementById('q');
      const cnt = document.getElementById('cnt');
      const aa = document.getElementById('aa');
      const re = document.getElementById('re');
      const mCur = document.getElementById('m-cur');
      const mAll = document.getElementById('m-all');
      const histBtn = document.getElementById('hist');
      let cs = false, ureg = false, mode = 'current';
      const addHist = (s) => { if (s && s.trim()) ipcRenderer.send('search:history-add', s); };
      // 검색창에 이력 항목이 채워질 때 (native menu 에서 클릭)
      ipcRenderer.on('search:fill', (_e, text) => { q.value = text; sendQ(); q.focus(); });
      const sendQ = () => ipcRenderer.send('search:query', { q: q.value, caseSensitive: cs, useRegex: ureg, mode });
      q.addEventListener('input', () => sendQ());
      q.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (q.value) addHist(q.value);
          ipcRenderer.send(e.shiftKey ? 'search:prev' : 'search:next', { mode });
        }
        else if (e.key === 'Escape') ipcRenderer.send('search:close');
        else if (e.key === 'ArrowDown') { e.preventDefault(); ipcRenderer.send('search:show-history-menu'); }
      });
      histBtn.onclick = (e) => { e.preventDefault(); ipcRenderer.send('search:show-history-menu'); };
      document.getElementById('prev').onclick = () => { if (q.value) addHist(q.value); ipcRenderer.send('search:prev', { mode }); };
      document.getElementById('next').onclick = () => { if (q.value) addHist(q.value); ipcRenderer.send('search:next', { mode }); };
      document.getElementById('x').onclick = () => ipcRenderer.send('search:close');
      document.getElementById('dock').onclick = () => ipcRenderer.send('search:dock');
      aa.onclick = () => { cs = !cs; aa.classList.toggle('active', cs); sendQ(); };
      re.onclick = () => { ureg = !ureg; re.classList.toggle('active', ureg); sendQ(); };
      mCur.onclick = () => { mode = 'current'; mCur.classList.add('active'); mAll.classList.remove('active'); sendQ(); };
      mAll.onclick = () => { mode = 'all'; mAll.classList.add('active'); mCur.classList.remove('active'); sendQ(); };
      ipcRenderer.on('search:result', (_e, p) => { cnt.textContent = (p.current ?? 0) + '/' + (p.total ?? 0); });
      q.focus();
    </script>
  </body></html>`;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  return { success: true };
});

// 검색 창 ↔ 메인 렌더러 IPC 중계
const forwardToMain = (channel: string) => (_e: any, payload?: any) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
};
ipcMain.on('search:query', forwardToMain('search:query'));
ipcMain.on('search:next', forwardToMain('search:next'));
ipcMain.on('search:prev', forwardToMain('search:prev'));
ipcMain.on('search:close', (_e) => {
  if (searchWindow && !searchWindow.isDestroyed()) { try { searchWindow.close(); } catch {} }
});
ipcMain.on('search:dock', () => {
  // 외부 창 닫고 메인 창에 인라인 검색바 열도록 알림
  if (searchWindow && !searchWindow.isDestroyed()) { try { searchWindow.close(); } catch {} }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('search:dock');
});
// 검색 이력 — 메모리에만 보관 (앱 종료 시 자동 소멸, 영속 저장 X)
let searchHistory: string[] = [];
ipcMain.handle('search:history-get', () => searchHistory);
ipcMain.on('search:history-add', (_e, q: string) => {
  if (!q || !q.trim()) return;
  searchHistory = searchHistory.filter(x => x !== q);
  searchHistory.unshift(q);
  if (searchHistory.length > 50) searchHistory = searchHistory.slice(0, 50);
});

// 검색 이력 dropdown — 별도 BrowserWindow (검색창 바로 아래, 스타일 커스텀)
let histDropdownWindow: BrowserWindow | null = null;
const closeHistDropdown = () => {
  if (histDropdownWindow && !histDropdownWindow.isDestroyed()) {
    try { histDropdownWindow.close(); } catch {}
  }
  histDropdownWindow = null;
};
ipcMain.on('search:show-history-menu', () => {
  if (!searchWindow || searchWindow.isDestroyed()) return;
  closeHistDropdown();
  if (searchHistory.length === 0) return;
  const sb = searchWindow.getBounds();
  const items = searchHistory.slice(0, 30);
  const itemH = 22;
  const ddH = Math.min(220, items.length * itemH + 4);
  const ddX = sb.x + 20;
  const ddY = sb.y + sb.height + 2;
  const ddW = Math.max(240, sb.width - 60);
  const dd = new BrowserWindow({
    x: ddX, y: ddY, width: ddW, height: ddH,
    frame: false, resizable: false, movable: false,
    transparent: false, backgroundColor: '#1a1a1a',
    show: false, skipTaskbar: true, alwaysOnTop: true, focusable: true,
    parent: searchWindow,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  histDropdownWindow = dd;
  dd.on('closed', () => { if (histDropdownWindow === dd) histDropdownWindow = null; });
  dd.on('blur', () => closeHistDropdown());
  const ddHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:#1a1a1a;color:#eee;font-family:'Segoe UI',sans-serif;height:100%;overflow-y:auto;border:1px solid #333;border-radius:3px;box-sizing:border-box;-webkit-user-select:none;user-select:none;font-size:11px;}
    body::-webkit-scrollbar{width:6px;}
    body::-webkit-scrollbar-track{background:#1a1a1a;}
    body::-webkit-scrollbar-thumb{background:#444;border-radius:3px;}
    .item{padding:4px 10px;font-size:11px;cursor:pointer;color:#ccc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.3;}
    .item:hover,.item.active{background:#2b6b9b;color:#fff;}
  </style></head><body>
    ${items.map((s, i) => '<div class="item" data-idx="' + i + '" title="' + s.replace(/"/g, '&quot;') + '">' + s.replace(/[<>&"]/g, c => (({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'} as Record<string,string>)[c] || c)) + '</div>').join('')}
    <script>
      const { ipcRenderer } = require('electron');
      const items = ${JSON.stringify(items)};
      let active = 0;
      const els = document.querySelectorAll('.item');
      const setActive = (i) => { els.forEach((el, k) => el.classList.toggle('active', k === i)); active = i; els[i]?.scrollIntoView({block:'nearest'}); };
      setActive(0);
      els.forEach((el, i) => {
        el.onmouseenter = () => setActive(i);
        el.onmousedown = (e) => { e.preventDefault(); ipcRenderer.send('search:hist-pick', items[i]); };
      });
      window.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(items.length - 1, active + 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(0, active - 1)); }
        else if (e.key === 'Enter') { e.preventDefault(); ipcRenderer.send('search:hist-pick', items[active]); }
        else if (e.key === 'Escape') { ipcRenderer.send('search:hist-cancel'); }
      });
    </script>
  </body></html>`;
  dd.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(ddHtml));
  dd.once('ready-to-show', () => { try { dd.show(); } catch {} });
});
ipcMain.on('search:hist-pick', (_e, text: string) => {
  if (searchWindow && !searchWindow.isDestroyed()) searchWindow.webContents.send('search:fill', text);
  closeHistDropdown();
});
ipcMain.on('search:hist-cancel', () => closeHistDropdown());
// 메인 렌더러 → 검색 창 (결과 카운트)
ipcMain.on('search:result', (_e, payload) => {
  if (searchWindow && !searchWindow.isDestroyed()) searchWindow.webContents.send('search:result', payload);
});

// X11 서버 제어 IPC
ipcMain.handle('x11:start', async (_e, displayNum: number = 0) => {
  const logs: string[] = [];
  const result = await startBundledX11(displayNum, (m) => logs.push(m));
  return { usedBundled: result.usedBundled, pid: result.proc?.pid ?? null, logs };
});
ipcMain.handle('x11:stop', (_e, displayNum: number = 0) => {
  stopBundledX11(displayNum);
  stopEmbeddedX11();
  return { success: true };
});
ipcMain.handle('x11:status', () => {
  const running = listRunningX11();
  return { running, anyRunning: running.length > 0 };
});

// 클립보드에 이미지(PNG bytes) 쓰기 — renderer 의 navigator.clipboard.write 가 실패하는 환경 대비
ipcMain.handle('clipboard:write-image', (_e, { dataUrl }: { dataUrl: string }) => {
  try {
    const img = nativeImage.createFromDataURL(dataUrl);
    if (img.isEmpty()) return { success: false, error: 'empty image' };
    clipboard.writeImage(img);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: String(err) };
  }
});

// 탐색기 우클릭 컨텍스트 메뉴 등록/해제
ipcMain.handle('app:register-context-menu', () => {
  if (process.platform !== 'win32') return { success: false, error: 'Windows only' };
  const { execSync } = require('child_process');
  const os = require('os');
  try {
    // Portable: PORTABLE_EXECUTABLE_FILE 환경변수로 원본 exe 경로 사용
    const exePath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const tmpCwdFile = path.join(os.tmpdir(), '.pepe-terminal-cwd');
    const iconPath = app.isPackaged ? exePath : path.join(__dirname, '..', 'public', 'icon.ico');

    // 런처 vbs 생성 — 창 없이 경로를 임시파일에 쓰고 exe 실행
    const vbsPath = path.join(app.getPath('userData'), 'pepe-open-here.vbs');
    const vbsContent = [
      'Set fso = CreateObject("Scripting.FileSystemObject")',
      `Set f = fso.CreateTextFile("${tmpCwdFile}", True)`,
      'f.Write WScript.Arguments(0)',
      'f.Close',
      'Set sh = CreateObject("WScript.Shell")',
      `sh.Run """${exePath}""" & " """ & WScript.Arguments(0) & """", 1, False`,
    ].join('\r\n');
    fs.writeFileSync(vbsPath, vbsContent, 'utf8');

    const vbsEsc = vbsPath.replace(/\\/g, '\\\\');
    const iconEsc = iconPath.replace(/\\/g, '\\\\');

    execSync(`reg add "HKCU\\Software\\Classes\\Directory\\Background\\shell\\PepeTerminal" /ve /d "Open PePe Terminal here" /f`, { stdio: 'pipe' });
    execSync(`reg add "HKCU\\Software\\Classes\\Directory\\Background\\shell\\PepeTerminal" /v Icon /d "${iconEsc}" /f`, { stdio: 'pipe' });
    execSync(`reg add "HKCU\\Software\\Classes\\Directory\\Background\\shell\\PepeTerminal\\command" /ve /d "wscript \\"${vbsEsc}\\" \\"%V\\"" /f`, { stdio: 'pipe' });
    execSync(`reg add "HKCU\\Software\\Classes\\Directory\\shell\\PepeTerminal" /ve /d "Open PePe Terminal here" /f`, { stdio: 'pipe' });
    execSync(`reg add "HKCU\\Software\\Classes\\Directory\\shell\\PepeTerminal" /v Icon /d "${iconEsc}" /f`, { stdio: 'pipe' });
    execSync(`reg add "HKCU\\Software\\Classes\\Directory\\shell\\PepeTerminal\\command" /ve /d "wscript \\"${vbsEsc}\\" \\"%1\\"" /f`, { stdio: 'pipe' });
    return { success: true };
  } catch (err: any) { return { success: false, error: String(err) }; }
});

ipcMain.handle('app:unregister-context-menu', () => {
  if (process.platform !== 'win32') return { success: false, error: 'Windows only' };
  const { execSync } = require('child_process');
  try {
    execSync(`reg delete "HKCU\\Software\\Classes\\Directory\\Background\\shell\\PepeTerminal" /f`, { stdio: 'pipe' });
    execSync(`reg delete "HKCU\\Software\\Classes\\Directory\\shell\\PepeTerminal" /f`, { stdio: 'pipe' });
    return { success: true };
  } catch (err: any) { return { success: false, error: String(err) }; }
});

ipcMain.handle('app:check-context-menu', () => {
  if (process.platform !== 'win32') return false;
  const { execSync } = require('child_process');
  try {
    execSync(`reg query "HKCU\\Software\\Classes\\Directory\\Background\\shell\\PepeTerminal"`, { stdio: 'pipe' });
    return true;
  } catch { return false; }
});

ipcMain.handle('sessions:list', () => sessionsData);

ipcMain.handle('sessions:save', (_e, s: Session) => {
  const idx = sessionsData.sessions.findIndex(x => x.id === s.id);
  if (idx >= 0) sessionsData.sessions[idx] = s;
  else sessionsData.sessions.push(s);
  saveSessionsData(sessionsData);
  return sessionsData;
});

// childOrder 헬퍼: 부모의 자식 순서 목록 가져오기 (없으면 폴더 먼저, 세션 나중 기본값 생성)
function getChildOrder(parentId?: string): string[] {
  const key = parentId || '__root__';
  if (!sessionsData.childOrder) sessionsData.childOrder = {};
  if (!sessionsData.childOrder[key]) {
    // 기본값: 폴더 먼저, 세션 나중 (기존 동작 호환)
    const folders = sessionsData.folders.filter(f => (f.parentId ?? undefined) === parentId).map(f => f.id);
    const sessions = sessionsData.sessions.filter(s => (s.folderId ?? undefined) === parentId).map(s => s.id);
    sessionsData.childOrder[key] = [...folders, ...sessions];
  }
  // 실제 존재하는 항목만 필터 + 누락된 항목 추가
  const allIds = new Set([
    ...sessionsData.folders.filter(f => (f.parentId ?? undefined) === parentId).map(f => f.id),
    ...sessionsData.sessions.filter(s => (s.folderId ?? undefined) === parentId).map(s => s.id),
  ]);
  const order = sessionsData.childOrder[key].filter(id => allIds.has(id));
  for (const aid of allIds) { if (!order.includes(aid)) order.push(aid); }
  sessionsData.childOrder[key] = order;
  return order;
}

function setChildOrder(parentId: string | undefined, order: string[]) {
  if (!sessionsData.childOrder) sessionsData.childOrder = {};
  sessionsData.childOrder[parentId || '__root__'] = order;
}

function removeFromChildOrder(parentId: string | undefined, itemId: string) {
  const order = getChildOrder(parentId);
  const idx = order.indexOf(itemId);
  if (idx >= 0) order.splice(idx, 1);
  setChildOrder(parentId, order);
}

function addToChildOrder(parentId: string | undefined, itemId: string, position: 'first' | 'last' | { before: string } | { after: string }) {
  const order = getChildOrder(parentId);
  // 이미 있으면 제거
  const existIdx = order.indexOf(itemId);
  if (existIdx >= 0) order.splice(existIdx, 1);
  if (position === 'first') order.unshift(itemId);
  else if (position === 'last') order.push(itemId);
  else if ('before' in position) {
    const ti = order.indexOf(position.before);
    order.splice(ti >= 0 ? ti : 0, 0, itemId);
  } else {
    const ti = order.indexOf(position.after);
    order.splice(ti >= 0 ? ti + 1 : order.length, 0, itemId);
  }
  setChildOrder(parentId, order);
}

ipcMain.handle('sessions:reorder', (_e, { id, type, direction }: { id: string; type: 'session' | 'folder'; direction: 'up' | 'down' | 'top' | 'bottom' }) => {
  // 현재 부모 찾기
  let parentId: string | undefined;
  if (type === 'session') {
    const sess = sessionsData.sessions.find(s => s.id === id);
    if (!sess) return sessionsData;
    parentId = sess.folderId;
  } else {
    const folder = sessionsData.folders.find(f => f.id === id);
    if (!folder) return sessionsData;
    parentId = folder.parentId;
  }

  const order = getChildOrder(parentId);
  const idx = order.indexOf(id);
  if (idx < 0) return sessionsData;

  if (direction === 'top') {
    // 같은 폴더 내 맨 처음
    order.splice(idx, 1);
    order.unshift(id);
    setChildOrder(parentId, order);
  } else if (direction === 'bottom') {
    // 같은 폴더 내 맨 끝
    order.splice(idx, 1);
    order.push(id);
    setChildOrder(parentId, order);
  } else if (direction === 'up') {
    if (idx > 0) {
      const prevId = order[idx - 1];
      const prevIsFolder = sessionsData.folders.some(f => f.id === prevId);
      if (prevIsFolder) {
        // 위가 폴더 → 그 폴더 안으로 진입 (마지막 자식으로)
        removeFromChildOrder(parentId, id);
        if (type === 'session') {
          sessionsData.sessions.find(s => s.id === id)!.folderId = prevId;
        } else {
          sessionsData.folders.find(f => f.id === id)!.parentId = prevId;
        }
        addToChildOrder(prevId, id, 'last');
      } else {
        // 위가 세션 → swap
        [order[idx], order[idx - 1]] = [order[idx - 1], order[idx]];
        setChildOrder(parentId, order);
      }
    } else if (parentId) {
      // 폴더 맨 위 → 부모 폴더로 올라감
      removeFromChildOrder(parentId, id);
      if (type === 'session') {
        sessionsData.sessions.find(s => s.id === id)!.folderId = sessionsData.folders.find(f => f.id === parentId)?.parentId;
      } else {
        sessionsData.folders.find(f => f.id === id)!.parentId = sessionsData.folders.find(f => f.id === parentId)?.parentId;
      }
      const grandParentId = sessionsData.folders.find(f => f.id === parentId)?.parentId;
      addToChildOrder(grandParentId, id, { before: parentId });
    }
  } else { // down
    if (idx < order.length - 1) {
      // 아래 항목 확인: 폴더면 진입, 아니면 swap
      const nextId = order[idx + 1];
      const isFolder = sessionsData.folders.some(f => f.id === nextId);
      if (isFolder) {
        // 다음이 폴더 → 그 폴더에 진입 (첫 번째 자식으로)
        removeFromChildOrder(parentId, id);
        if (type === 'session') {
          sessionsData.sessions.find(s => s.id === id)!.folderId = nextId;
        } else {
          sessionsData.folders.find(f => f.id === id)!.parentId = nextId;
        }
        addToChildOrder(nextId, id, 'first');
      } else {
        // 다음이 세션 → swap
        [order[idx], order[idx + 1]] = [order[idx + 1], order[idx]];
        setChildOrder(parentId, order);
      }
    } else if (parentId) {
      // 폴더 맨 아래 → 부모 폴더 밖으로 (부모 뒤에 배치)
      removeFromChildOrder(parentId, id);
      if (type === 'session') {
        sessionsData.sessions.find(s => s.id === id)!.folderId = sessionsData.folders.find(f => f.id === parentId)?.parentId;
      } else {
        sessionsData.folders.find(f => f.id === id)!.parentId = sessionsData.folders.find(f => f.id === parentId)?.parentId;
      }
      const grandParentId = sessionsData.folders.find(f => f.id === parentId)?.parentId;
      addToChildOrder(grandParentId, id, { after: parentId });
    }
  }

  saveSessionsData(sessionsData);
  return sessionsData;
});

ipcMain.handle('sessions:move-to-folder', (_e, { sessionId, targetFolderId }: { sessionId: string; targetFolderId: string | null }) => {
  const sess = sessionsData.sessions.find(s => s.id === sessionId);
  if (!sess) return sessionsData;
  sess.folderId = targetFolderId ?? undefined;
  saveSessionsData(sessionsData);
  return sessionsData;
});

ipcMain.handle('sessions:delete', (_e, id: string) => {
  sessionsData.sessions = sessionsData.sessions.filter(s => s.id !== id);
  saveSessionsData(sessionsData);
  return sessionsData;
});

ipcMain.handle('folders:save', (_e, f: Folder) => {
  const idx = sessionsData.folders.findIndex(x => x.id === f.id);
  if (idx >= 0) sessionsData.folders[idx] = f;
  else sessionsData.folders.push(f);
  saveSessionsData(sessionsData);
  return sessionsData;
});

ipcMain.handle('folders:delete', (_e, id: string) => {
  // 하위 폴더의 parentId를 삭제된 폴더의 parentId로 올림
  const deleted = sessionsData.folders.find(f => f.id === id);
  const parentId = deleted?.parentId;
  sessionsData.folders = sessionsData.folders.filter(f => f.id !== id);
  sessionsData.folders.forEach(f => { if (f.parentId === id) f.parentId = parentId; });
  // 하위 세션의 folderId도 올림
  sessionsData.sessions.forEach(s => { if (s.folderId === id) s.folderId = parentId; });
  saveSessionsData(sessionsData);
  return sessionsData;
});

// ── SSH IPC ──

// ── Export/Import Sessions ──

ipcMain.handle('sessions:export', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Sessions',
    defaultPath: 'sessions-export.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return null;
  try {
    fs.writeFileSync(result.filePath, JSON.stringify(sessionsData, null, 2), 'utf8');
    return result.filePath;
  } catch { return null; }
});

ipcMain.handle('sessions:import', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Sessions',
    filters: [
      { name: 'All Supported', extensions: ['json', 'xml', 'xts'] },
      { name: 'PePe Terminal JSON', extensions: ['json'] },
      { name: 'SecureCRT XML', extensions: ['xml'] },
      { name: 'Xshell Backup (xts)', extensions: ['xts'] },
    ],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  const ext = path.extname(filePath).toLowerCase();
  try {
    let imported: SessionsData;
    if (ext === '.xml') {
      imported = parseSecureCRTXml(filePath);
    } else if (ext === '.xts') {
      imported = parseXshellXts(filePath);
    } else {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      imported = Array.isArray(raw)
        ? { folders: [], sessions: raw }
        : { folders: raw.folders ?? [], sessions: raw.sessions ?? [] };
    }
    // 기존 데이터에 머지 (중복: host+port+username 동일하면 스킵)
    for (const f of imported.folders) {
      const exists = sessionsData.folders.some(x => x.name === f.name && x.parentId === f.parentId);
      if (!exists) sessionsData.folders.push(f);
      else {
        // 같은 이름+부모의 기존 폴더 ID로 세션의 folderId를 매핑
        const existing = sessionsData.folders.find(x => x.name === f.name && x.parentId === f.parentId)!;
        for (const s of imported.sessions) {
          if (s.folderId === f.id) s.folderId = existing.id;
        }
        // 하위 폴더의 parentId도 매핑
        for (const cf of imported.folders) {
          if (cf.parentId === f.id) cf.parentId = existing.id;
        }
      }
    }
    let addedCount = 0;
    for (const s of imported.sessions) {
      const dup = sessionsData.sessions.some(x => x.host === s.host && x.port === s.port && x.username === s.username && x.name === s.name);
      if (!dup) { sessionsData.sessions.push(s); addedCount++; }
    }
    saveSessionsData(sessionsData);
    return { data: sessionsData, addedCount, totalParsed: imported.sessions.length };
  } catch (err: any) { console.error('Import error:', err); return null; }
});

// ── SecureCRT XML 파서 ──
function parseSecureCRTXml(filePath: string): SessionsData {
  const xml = fs.readFileSync(filePath, 'utf8');
  const lines = xml.split('\n');
  const folders: Folder[] = [];
  const sessions: Session[] = [];

  let inSessions = false;
  let depth = 0;
  const keyStack: { name: string; folderId?: string; props: Record<string, string> }[] = [];

  for (const line of lines) {
    if (line.includes('<key name="Sessions">')) { inSessions = true; depth = 0; continue; }
    if (!inSessions) continue;

    const keyMatch = line.match(/<key name="([^"]+)">/);
    if (keyMatch) {
      depth++;
      const parentFolderId = keyStack.length > 0 ? keyStack[keyStack.length - 1].folderId : undefined;
      keyStack.push({ name: keyMatch[1], folderId: undefined, props: {} });
      // 부모 폴더 ID 기억
      keyStack[keyStack.length - 1].folderId = `folder-scrt-${Date.now()}-${depth}-${Math.random().toString(36).slice(2, 6)}`;
      keyStack[keyStack.length - 1].props['_parentFolderId'] = parentFolderId || '';
      continue;
    }

    if (line.includes('</key>')) {
      if (keyStack.length > 0) {
        const item = keyStack.pop()!;
        const hostname = item.props['Hostname'];
        if (hostname) {
          // 이것은 세션
          const portStr = item.props['[SSH2] Port'] || '22';
          const username = item.props['Username'] || '';
          const encodingRaw = item.props['Output Transformer Name'] || '';
          let encoding = 'utf-8';
          if (encodingRaw.toLowerCase().includes('euc-kr') || encodingRaw.toLowerCase().includes('euc_kr')) encoding = 'euc-kr';
          else if (encodingRaw.toLowerCase().includes('cp949')) encoding = 'cp949';
          else if (encodingRaw.toLowerCase().includes('utf-8') || encodingRaw.toLowerCase().includes('utf8') || encodingRaw === 'UTF-8') encoding = 'utf-8';
          else if (encodingRaw) encoding = encodingRaw.toLowerCase();

          const parentFolderId = item.props['_parentFolderId'] || undefined;
          sessions.push({
            id: `sess-scrt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: item.name,
            host: hostname,
            port: parseInt(portStr, 10) || 22,
            username,
            encoding,
            folderId: parentFolderId || undefined,
            auth: { type: 'password', password: '' },
          });
        } else {
          // 하위 세션이 있었다면 이것은 폴더
          const hasSessions = sessions.some(s => s.folderId === item.folderId);
          const hasSubFolders = folders.some(f => f.parentId === item.folderId);
          if (hasSessions || hasSubFolders) {
            const parentFolderId = item.props['_parentFolderId'] || undefined;
            folders.push({
              id: item.folderId!,
              name: item.name,
              parentId: parentFolderId || undefined,
            });
          }
        }
      }
      depth--;
      if (depth < 0) break;
      continue;
    }

    // 프로퍼티 파싱
    if (keyStack.length > 0) {
      const strMatch = line.match(/<string name="([^"]+)">([^<]*)<\/string>/);
      if (strMatch) { keyStack[keyStack.length - 1].props[strMatch[1]] = strMatch[2]; continue; }
      const dwordMatch = line.match(/<dword name="([^"]+)">(\d+)<\/dword>/);
      if (dwordMatch) { keyStack[keyStack.length - 1].props[dwordMatch[1]] = dwordMatch[2]; continue; }
      const emptyStr = line.match(/<string name="([^"]+)"\/>/);
      if (emptyStr) { keyStack[keyStack.length - 1].props[emptyStr[1]] = ''; continue; }
    }
  }

  return { folders, sessions };
}

// ── Xshell xts(ZIP) 파서 ──
function parseXshellXts(filePath: string): SessionsData {
  const folders: Folder[] = [];
  const sessions: Session[] = [];
  const folderMap = new Map<string, string>(); // path → folderId

  // 임시 디렉토리에 추출
  const tmpDir = path.join(os.tmpdir(), `pepe-xshell-import-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // PowerShell Expand-Archive는 .zip만 허용하므로 .xts → .zip 복사 후 추출
    const zipCopy = path.join(tmpDir, 'import.zip');
    fs.copyFileSync(filePath, zipCopy);
    execSync(`powershell -Command "Expand-Archive -Path '${zipCopy}' -DestinationPath '${tmpDir}' -Force"`, { timeout: 30000 });
    try { fs.unlinkSync(zipCopy); } catch {}

    // Xshell 폴더 찾기
    const xshellDir = path.join(tmpDir, 'Xshell');
    if (!fs.existsSync(xshellDir)) {
      // Xshell 폴더가 없으면 tmpDir 자체를 탐색
      walkXshellDir(tmpDir, '', folders, sessions, folderMap);
    } else {
      walkXshellDir(xshellDir, '', folders, sessions, folderMap);
    }
  } finally {
    // 임시 디렉토리 정리
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  return { folders, sessions };
}

// Xshell encoding 숫자 → 문자열 매핑
function xshellEncodingMap(val: string): string {
  switch (val) {
    case '2': return 'euc-kr';
    case '0': case '65001': return 'utf-8';
    case '1': return 'cp949';
    case '28591': return 'latin1';
    default: return 'utf-8';
  }
}

function getOrCreateFolder(folderPath: string, folders: Folder[], folderMap: Map<string, string>): string | undefined {
  if (!folderPath || folderPath === '.') return undefined;
  if (folderMap.has(folderPath)) return folderMap.get(folderPath)!;

  const parts = folderPath.split(/[\\/]/);
  let currentPath = '';
  let parentId: string | undefined;

  for (const part of parts) {
    currentPath = currentPath ? `${currentPath}/${part}` : part;
    if (folderMap.has(currentPath)) {
      parentId = folderMap.get(currentPath)!;
      continue;
    }
    const folderId = `folder-xsh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    folders.push({ id: folderId, name: part, parentId });
    folderMap.set(currentPath, folderId);
    parentId = folderId;
  }
  return parentId;
}

function walkXshellDir(dir: string, relPath: string, folders: Folder[], sessions: Session[], folderMap: Map<string, string>) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkXshellDir(fullPath, relPath ? `${relPath}/${entry.name}` : entry.name, folders, sessions, folderMap);
    } else if (entry.name.endsWith('.xsh')) {
      try {
        const buf = fs.readFileSync(fullPath);
        const txt = buf.toString('utf16le');
        const lines = txt.split(/\r?\n/);
        let host = '', port = '22', user = '', enc = 'utf-8';
        let useExpectSend = false, expectSendCount = 0;
        const expectMap: Record<string, string> = {};
        const sendMap: Record<string, string> = {};
        for (const l of lines) {
          const m = l.match(/^(.+?)=(.*)$/);
          if (!m) continue;
          const k = m[1].trim(), v = m[2].trim();
          if (k === 'Host') host = v;
          if (k === 'Port') port = v;
          if (k === 'UserName') user = v;
          if (k === 'Encoding') enc = xshellEncodingMap(v);
          if (k === 'UseExpectSend' && v === '1') useExpectSend = true;
          if (k === 'ExpectSend_Count') expectSendCount = parseInt(v, 10) || 0;
          const expectMatch = k.match(/^ExpectSend_Expect_(\d+)$/);
          if (expectMatch) expectMap[expectMatch[1]] = v;
          const sendMatch = k.match(/^ExpectSend_Send_(\d+)$/);
          if (sendMatch) sendMap[sendMatch[1]] = v;
        }
        if (host) {
          const folderId = getOrCreateFolder(relPath, folders, folderMap);
          const name = entry.name.replace(/\.xsh$/, '');
          // Expect/Send 로그인 스크립트 변환
          const loginScript: { expect: string; send: string }[] = [];
          if (useExpectSend && expectSendCount > 0) {
            for (let i = 0; i < expectSendCount; i++) {
              const expect = expectMap[String(i)] ?? '';
              const send = sendMap[String(i)] ?? '';
              if (send) loginScript.push({ expect, send });
            }
          }
          sessions.push({
            id: `sess-xsh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name,
            host,
            port: parseInt(port, 10) || 22,
            username: user,
            encoding: enc,
            folderId,
            auth: { type: 'password', password: '' },
            loginScript: loginScript.length > 0 ? loginScript : undefined,
          });
        }
      } catch {}
    }
  }
}

// ── 파일 탐색기 IPC ──

// 로컬 파일 다중 선택 다이얼로그 — 일괄 파일전송 모달 등에서 사용
ipcMain.handle('dialog:pick-files', async (_e, { multi }: { multi?: boolean }) => {
  if (!mainWindow) return { paths: [] };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: multi ? t('dialog.pickFilesMulti') : t('dialog.pickFile'),
    properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
  });
  if (result.canceled) return { paths: [] };
  return { paths: result.filePaths };
});

ipcMain.handle('dialog:pick-folder', async () => {
  if (!mainWindow) return { path: null };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: t('dialog.pickFolder'),
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return { path: null };
  return { path: result.filePaths[0] };
});

// Windows Explorer 의 "바탕 화면" 가상 항목들을 Shell.Application 으로 열거.
// Windows 의 바탕 화면 namespace = 0x00. 가상 항목 (내 PC, 네트워크, 라이브러리 등) 도 포함.
function getShellDesktopVirtualItems(): any[] {
  try {
    const { execFileSync } = require('child_process');
    const psScript = `chcp 65001 > $null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$shell = New-Object -ComObject Shell.Application
$desk = $shell.Namespace(0)
# 알려진 shell CLSID → 친화 shell:* 매핑 (My Computer / Network / Recycle Bin 등)
$clsidMap = @{
  '::{20D04FE0-3AEA-1069-A2D8-08002B30309D}' = 'shell:MyComputerFolder'
  '::{F02C1A0D-BE21-4350-88B0-7367FC96EF3C}' = 'shell:NetworkPlacesFolder'
  '::{645FF040-5081-101B-9F08-00AA002F954E}' = 'shell:RecycleBinFolder'
}
if ($desk) {
  $items = @()
  foreach ($it in $desk.Items()) {
    $name = $it.Name
    $path = $it.Path
    $isFolder = $it.IsFolder
    if (-not $name) { continue }
    # 가상 항목 — 알려진 CLSID 면 친화 shell:* 로, 알려지지 않은 CLSID 는 Desktop 체인 (ParseName)
    # 일반 파일 경로면 그대로
    $shellPath = if ($path -and $clsidMap.ContainsKey($path)) {
      $clsidMap[$path]
    } elseif ($path -and $path.StartsWith('::')) {
      # 체인 포맷: shell-pidl:shell:Desktop||<name> — 친화 표시 ('바탕 화면 › 갤러리') + ParseName 트래버설
      'shell-pidl:shell:Desktop||' + $name
    } else {
      $path
    }
    $items += [PSCustomObject]@{ Name = $name; Path = $shellPath; IsDir = [bool]$isFolder }
  }
  $items | ConvertTo-Json -Compress
}`;
    const tmpPs = path.join(os.tmpdir(), `pepe-desktop-${Date.now()}.ps1`);
    try {
      fs.writeFileSync(tmpPs, '﻿' + psScript, { encoding: 'utf8' });
      const out: string = execFileSync('powershell', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpPs,
      ], { windowsHide: true, timeout: 10000 }).toString('utf-8');
      try { fs.unlinkSync(tmpPs); } catch {}
      const data = JSON.parse(out.trim() || '[]');
      const arr: any[] = Array.isArray(data) ? data : [data];
      const now = Math.floor(Date.now() / 1000);
      const seen = new Set<string>();
      const result: any[] = [];
      for (const x of arr) {
        const name = String(x.Name || '');
        const p = String(x.Path || '');
        if (!name || seen.has(name)) continue;
        seen.add(name);
        result.push({ name, isDir: !!x.IsDir, size: 0, mtime: now, shellPath: p });
      }
      return result;
    } catch {
      try { fs.unlinkSync(tmpPs); } catch {}
      // fallback: 최소한의 가상 항목
      return [
        { name: '내 PC', isDir: true, size: 0, mtime: Math.floor(Date.now()/1000), shellPath: 'shell:MyComputerFolder' },
        { name: '네트워크', isDir: true, size: 0, mtime: Math.floor(Date.now()/1000), shellPath: 'shell:NetworkPlacesFolder' },
        { name: '홈', isDir: true, size: 0, mtime: Math.floor(Date.now()/1000), shellPath: require('os').homedir() },
      ];
    }
  } catch {
    return [];
  }
}

ipcMain.handle('fe:list-dir', async (_e, { mode, termId, dirPath: dirPathArg, encoding }: { mode: string; termId?: string; dirPath: string; encoding?: string }) => {
  let dirPath = dirPathArg;
  try {
    const bridge = getSSHBridge();
    if (mode === 'local') {
      // 특수 shell path 처리
      // shell:Desktop — 가상 데스크톱 (내 PC, 네트워크, 라이브러리, 갤러리 등 + 물리 데스크톱 파일)
      if (dirPath === 'shell:Desktop') {
        const virtuals = getShellDesktopVirtualItems();
        // 물리 데스크톱 폴더의 파일도 같이 enumerate
        try {
          const desktopDir = path.join(os.homedir(), 'Desktop');
          const onedriveDesktop = path.join(os.homedir(), 'OneDrive', '바탕 화면');
          const onedriveDesktopEn = path.join(os.homedir(), 'OneDrive', 'Desktop');
          const candidates = [onedriveDesktop, onedriveDesktopEn, desktopDir];
          for (const d of candidates) {
            if (fs.existsSync(d)) {
              const entries = await fs.promises.readdir(d, { withFileTypes: true });
              const now = Math.floor(Date.now() / 1000);
              const seenNames = new Set(virtuals.map((x: any) => x.name));
              for (const e of entries) {
                if (seenNames.has(e.name)) continue;
                const fp = path.join(d, e.name);
                let size = 0, mtime = now;
                try { const st = await fs.promises.stat(fp); size = st.size; mtime = Math.floor(st.mtimeMs / 1000); } catch {}
                virtuals.push({ name: e.name, isDir: e.isDirectory(), size, mtime, shellPath: fp, realPath: fp });
              }
              break; // 첫 번째 매칭하는 desktop 폴더만
            }
          }
        } catch {}
        return { files: virtuals };
      }
      if (dirPath === 'shell:MyComputerFolder') {
        // "내 PC" — Shell.Application NameSpace(0x11) 로 enumerate: 드라이브 + MTP 디바이스 + 네트워크 단축
        try {
          const { execFileSync } = require('child_process');
          const psScript = `chcp 65001 > $null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$shell = New-Object -ComObject Shell.Application
$wsh = New-Object -ComObject WScript.Shell

function Resolve-NetHoodPath {
  param([string]$p)
  if (-not $p) { return $p }
  if ($p.StartsWith('\\\\')) { return $p }
  if (-not (Test-Path $p)) { return $p }
  $tlnk = Join-Path $p 'target.lnk'
  if (Test-Path $tlnk) {
    try {
      $lk = $wsh.CreateShortcut($tlnk)
      if ($lk.TargetPath -and $lk.TargetPath.StartsWith('\\\\')) { return $lk.TargetPath }
    } catch {}
  }
  try {
    $lnks = Get-ChildItem -Path $p -Filter '*.lnk' -File -ErrorAction SilentlyContinue
    foreach ($f in $lnks) {
      try {
        $lk = $wsh.CreateShortcut($f.FullName)
        if ($lk.TargetPath -and $lk.TargetPath.StartsWith('\\\\')) { return $lk.TargetPath }
      } catch {}
    }
  } catch {}
  return $p
}

$items = @()
try {
  $pc = $shell.Namespace(0x11)
  if ($pc) {
    foreach ($it in $pc.Items()) {
      $p = $it.Path
      $n = $it.Name
      if (-not $p -or -not $n) { continue }
      $isDir = [bool]$it.IsFolder
      $resolved = Resolve-NetHoodPath $p
      # shell namespace (::{guid}) → shell-pidl: prefix (디바이스 등)
      $finalPath = if ($resolved -and $resolved.StartsWith('::')) { 'shell-pidl:' + $resolved } else { $resolved }
      # Order: 드라이브 1, 디바이스 2, 네트워크 3, 기타 4
      $order = if ($resolved -match '^[A-Z]:') { 1 } elseif ($resolved.StartsWith('::')) { 2 } elseif ($resolved.StartsWith('\\\\')) { 3 } else { 4 }
      $items += [PSCustomObject]@{ Name = $n; IsDir = $isDir; Path = $finalPath; Order = $order }
    }
  }
} catch {}
$items | Sort-Object Order, Name | ConvertTo-Json -Compress`;
          const tmpPs = path.join(os.tmpdir(), `pepe-mypc-${Date.now()}.ps1`);
          fs.writeFileSync(tmpPs, '﻿' + psScript, { encoding: 'utf8' });
          const out: string = execFileSync('powershell', [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpPs,
          ], { windowsHide: true, timeout: 15000 }).toString('utf-8').trim();
          try { fs.unlinkSync(tmpPs); } catch {}
          const data = JSON.parse(out || '[]');
          const arr: any[] = Array.isArray(data) ? data : [data];
          const now = Math.floor(Date.now() / 1000);
          return { files: arr.map((x: any) => ({
            name: String(x.Name || ''),
            isDir: !!x.IsDir,
            size: 0,
            mtime: now,
            shellPath: String(x.Path || ''),
          })).filter((x: any) => x.name) };
        } catch (err: any) {
          // PowerShell 실패시 fallback — A-Z 드라이브 letter 만
          const drives: any[] = [];
          for (let i = 65; i <= 90; i++) {
            const d = String.fromCharCode(i) + ':\\';
            try { await fs.promises.access(d); drives.push({ name: String.fromCharCode(i) + ':', isDir: true, size: 0, mtime: Math.floor(Date.now()/1000), shellPath: d }); } catch {}
          }
          return { files: drives, error: 'My Computer 열거 fallback (A-Z 드라이브만)' };
        }
      }
      if (dirPath === 'shell:NetworkPlacesFolder') {
        // "네트워크" — NetHood 항목들 UNC 로
        try {
          const netHood = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Network Shortcuts');
          const list: any[] = [];
          if (fs.existsSync(netHood)) {
            const entries = fs.readdirSync(netHood, { withFileTypes: true });
            for (const e of entries) {
              if (!e.isDirectory()) continue;
              const tlnk = path.join(netHood, e.name, 'target.lnk');
              if (fs.existsSync(tlnk)) {
                list.push({ name: e.name, isDir: true, size: 0, mtime: Math.floor(Date.now()/1000), shellPath: 'lnk:' + tlnk });
              }
            }
          }
          return { files: list };
        } catch {
          return { files: [] };
        }
      }
      // shell:* 경로 (위에서 명시적으로 처리되지 않은 것 — RecycleBinFolder, Downloads, Documents 등)
      // shell-pidl:<dirPath> 로 라우팅해서 Shell.Application NameSpace 로 열거.
      if (dirPath.startsWith('shell:') && !dirPath.startsWith('shell-pidl:')) {
        // shell-pidl 경로로 변환해서 동일 로직 진입 (아래 if 블록과 같은 PowerShell enum)
        dirPath = 'shell-pidl:' + dirPath;
      }
      // shell-pidl:: PIDL — Shell.Application 으로 enum
      // path 형식: 'shell-pidl:<root>' (단일) 또는 'shell-pidl:<root>||<name1>||<name2>' (체인)
      // MTP 디바이스 등은 직접 NameSpace 가 안 돼서, root 에서 ParseName 으로 한 단계씩 descend
      if (dirPath.startsWith('shell-pidl:')) {
        const pidlPath = dirPath.slice('shell-pidl:'.length);
        const segs = pidlPath.split('||');
        const rootPath = segs[0];
        const chain = segs.slice(1); // 이름 체인 (각 ParseName 단계)
        // 다음 단계 child 들의 path prefix
        const childPrefix = `shell-pidl:${pidlPath}||`;
        try {
          const { execFileSync } = require('child_process');
          // PowerShell 에 root + 체인 이름 목록 전달
          const psChain = chain.map(c => `'${c.replace(/'/g, "''")}'`).join(',');
          // shell:Desktop 은 파일시스템 데스크톱 만 반환하므로, 가상 항목 enumerate 하려면 CSIDL 0 사용
          const rootArg = rootPath === 'shell:Desktop'
            ? '0'
            : `'${rootPath.replace(/'/g, "''")}'`;
          const psScript = `chcp 65001 > $null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$shell = New-Object -ComObject Shell.Application
$ns = $shell.NameSpace(${rootArg})
if (-not $ns) {
  Write-Error "NameSpace 실패"
  '[]'
  exit
}
$folder = $ns
$chainNames = @(${psChain})
$ok = $true
foreach ($name in $chainNames) {
  if (-not $folder) { $ok = $false; break }
  # 1차: ParseName (실제 파일 경로 기반 항목에 안정적)
  $child = $folder.ParseName($name)
  # 2차: Items() 순회로 이름 매칭 (가상 항목 fallback)
  if (-not $child) {
    foreach ($c in $folder.Items()) {
      if ($c.Name -eq $name) { $child = $c; break }
    }
  }
  if (-not $child) { $ok = $false; break }
  $sub = $child.GetFolder
  if (-not $sub) {
    # GetFolder 가 null 인 경우 — Path 로 다시 NameSpace 시도
    if ($child.Path) {
      $sub = $shell.NameSpace($child.Path)
    }
  }
  if (-not $sub) { $ok = $false; break }
  $folder = $sub
}
if ($ok -and $folder) {
  $items = @()
  $epoch = (Get-Date '1970-01-01').ToUniversalTime()
  foreach ($it in $folder.Items()) {
    $name = $it.Name
    $isFolder = $it.IsFolder
    if (-not $name) { continue }
    $size = 0
    $mtime = 0
    $realPath = ''
    $itPath = $it.Path
    # 실제 파일시스템 경로면 Get-Item 으로 정확한 size/mtime + realPath 조회
    if ($itPath -and -not $itPath.StartsWith('::') -and (Test-Path -LiteralPath $itPath -ErrorAction SilentlyContinue)) {
      $realPath = $itPath
      try {
        $fi = Get-Item -LiteralPath $itPath -ErrorAction Stop
        if (-not $isFolder) { $size = [int64]$fi.Length }
        if ($fi.LastWriteTime) {
          $mtime = [int][Math]::Floor(($fi.LastWriteTime.ToUniversalTime() - $epoch).TotalSeconds)
        }
      } catch {}
    } else {
      try {
        $d = $it.ModifyDate
        if ($d -is [DateTime]) { $mtime = [int][Math]::Floor(($d.ToUniversalTime() - $epoch).TotalSeconds) }
      } catch {}
      try { if (-not $isFolder) { $size = [int64]$it.Size } } catch {}
    }
    $items += [PSCustomObject]@{ Name = $name; IsDir = [bool]$isFolder; Size = $size; MTime = $mtime; RealPath = $realPath }
  }
  if ($items.Count -gt 0) { $items | ConvertTo-Json -Compress } else { '[]' }
} else {
  '[]'
}`;
          const tmpPs = path.join(os.tmpdir(), `pepe-shell-${Date.now()}.ps1`);
          try {
            fs.writeFileSync(tmpPs, '﻿' + psScript, { encoding: 'utf8' });
            const out: string = execFileSync('powershell', [
              '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpPs,
            ], { windowsHide: true, timeout: 15000 }).toString('utf-8');
            try { fs.unlinkSync(tmpPs); } catch {}
            const data = JSON.parse(out.trim() || '[]');
            const arr: any[] = Array.isArray(data) ? data : [data];
            const now = Math.floor(Date.now() / 1000);
            // 각 child 의 shellPath = 현재 path + '||' + 이름 (ParseName 체인 다음 단계)
            // realPath: 실제 파일시스템 경로 (있으면 fs 연산용)
            return { files: arr.map((x: any) => ({
              name: String(x.Name || ''),
              isDir: !!x.IsDir,
              size: Number(x.Size) || 0,
              mtime: Number(x.MTime) || now,
              shellPath: String(x.RealPath || (childPrefix + String(x.Name || ''))),
              realPath: String(x.RealPath || ''),
            })).filter((x: any) => x.name) };
          } catch (e) {
            try { fs.unlinkSync(tmpPs); } catch {}
            return { files: [], error: 'shell namespace 열거 실패' };
          }
        } catch {
          return { files: [], error: 'shell namespace 접근 실패' };
        }
      }
      // .lnk 단축 — 파싱해서 target 으로 리다이렉트
      if (dirPath.startsWith('lnk:')) {
        const lnk = dirPath.slice(4);
        try {
          const { execFileSync } = require('child_process');
          const out: string = execFileSync('powershell', [
            '-NoProfile', '-NonInteractive', '-Command',
            `(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replace(/'/g, "''")}').TargetPath`,
          ], { windowsHide: true, timeout: 5000 }).toString('utf-8').trim();
          if (out) {
            return { files: await bridge.handleLocalListDir(out), resolvedPath: out };
          }
        } catch {}
        return { files: [], error: 'shortcut 해석 실패' };
      }
      // 일반 로컬 디렉토리 — 물리 파일만 (가상 항목은 shell:Desktop 경로에서만)
      const physical = await bridge.handleLocalListDir(dirPath);
      return { files: physical };
    } else {
      if (!termId) return { error: t('error.noConnectionId') };
      const files = await bridge.handleSFTPListDir(termId, dirPath);
      // 인코딩 변환 — UTF-8 외에 cp949/euc-kr 등 선택 시 filename 을 재디코딩
      // ssh2 가 utf-8 로 디코딩한 string 을 latin1 바이트로 보존했다 다시 iconv 로 재해석
      if (encoding && encoding !== 'utf-8' && encoding !== 'utf8') {
        try {
          const iconv = require('iconv-lite');
          if (iconv.encodingExists(encoding)) {
            for (const f of files) {
              if (typeof f.name === 'string' && f.name) {
                try {
                  const bytes = Buffer.from(f.name, 'binary');
                  const decoded = iconv.decode(bytes, encoding);
                  if (decoded && !decoded.includes('�')) f.name = decoded;
                } catch {}
              }
            }
          }
        } catch {}
      }
      return { files };
    }
  } catch (err: any) { return { error: `${dirPath}: ${String(err)}` }; }
});

// ── 파일 비교 (CompareWorkspace) ──
// 재귀 walk — 한 번의 IPC 로 폴더 전체 트리를 평탄화해서 반환. 대용량 폴더에서 N번 round-trip 회피.
// 결과는 [{ relPath, isDir, size, mtime }] flat 배열. 상한 옵션으로 walk 폭주 방지.
const COMPARE_WALK_MAX_ENTRIES = 50000;
ipcMain.handle('compare:walk', async (_e, { mode, termId, basePath, maxEntries }: { mode: string; termId?: string; basePath: string; maxEntries?: number }) => {
  const cap = Math.min(maxEntries || COMPARE_WALK_MAX_ENTRIES, COMPARE_WALK_MAX_ENTRIES);
  const out: { relPath: string; isDir: boolean; size: number; mtime: number }[] = [];
  let truncated = false;
  try {
    const bridge = getSSHBridge();
    const sep = mode === 'local' && process.platform === 'win32' ? '\\' : '/';
    const join = (a: string, b: string) => a.endsWith(sep) ? a + b : a + sep + b;
    const walk = async (cur: string, rel: string): Promise<void> => {
      if (out.length >= cap) { truncated = true; return; }
      let entries: any[];
      try {
        if (mode === 'local') entries = await bridge.handleLocalListDir(cur);
        else entries = await bridge.handleSFTPListDir(termId!, cur);
      } catch { return; }
      // 정렬 — 폴더 먼저, 이름순
      entries.sort((a, b) => (a.isDir !== b.isDir) ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name));
      for (const e of entries) {
        if (e.name === '.' || e.name === '..') continue;
        if (out.length >= cap) { truncated = true; return; }
        const childRel = rel ? rel + '/' + e.name : e.name;
        out.push({ relPath: childRel, isDir: e.isDir, size: e.size ?? 0, mtime: e.mtime ?? 0 });
        if (e.isDir) await walk(join(cur, e.name), childRel);
      }
    };
    await walk(basePath, '');
    return { entries: out, truncated };
  } catch (err: any) {
    return { entries: out, truncated, error: String(err) };
  }
});

// 파일 쓰기 — Compare 에디터에서 수정 후 저장. 로컬은 fs, 원격은 SFTP.
ipcMain.handle('compare:write', async (_e, { mode, termId, filePath, content }: { mode: string; termId?: string; filePath: string; content: string }) => {
  try {
    if (mode === 'local') {
      await fs.promises.writeFile(filePath, content, 'utf-8');
      return { ok: true };
    } else {
      if (!termId) return { ok: false, error: t('error.noConnectionId') };
      const bridge = getSSHBridge();
      await bridge.handleSFTPWriteFile(termId, filePath, content);
      return { ok: true };
    }
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) };
  }
});

// 파일 읽기 — 텍스트 diff 용. 로컬은 fs, 원격은 SFTP. 텍스트로 디코드 (utf-8 기본).
// UTF-8 디코딩 후 대체 문자(U+FFFD)가 있으면 CP949(EUC-KR 상위집합)로 재시도
function decodeFileBuffer(buf: Buffer): { text: string; encoding: string } {
  const utf8 = buf.toString('utf-8');
  if (!utf8.includes('�')) return { text: utf8, encoding: 'UTF-8' };
  try {
    const iconv = require('iconv-lite');
    if (iconv.encodingExists('cp949')) return { text: iconv.decode(buf, 'cp949'), encoding: 'CP949' };
  } catch {}
  return { text: utf8, encoding: 'UTF-8' };
}
ipcMain.handle('compare:read', async (_e, { mode, termId, filePath, maxBytes }: { mode: string; termId?: string; filePath: string; maxBytes?: number }) => {
  const cap = maxBytes || 5 * 1024 * 1024; // 기본 5MB
  try {
    if (mode === 'local') {
      const stat = await fs.promises.stat(filePath);
      if (stat.size > cap) return { error: t('error.fileTooLargeCap', { mb: (stat.size / 1024 / 1024).toFixed(1), cap: (cap / 1024 / 1024).toFixed(0) }), size: stat.size };
      const buf = await fs.promises.readFile(filePath);
      const { text, encoding } = decodeFileBuffer(buf);
      return { content: text, encoding, size: stat.size };
    } else {
      if (!termId) return { error: t('error.noConnectionId') };
      const bridge = getSSHBridge();
      const buf = await bridge.handleSFTPReadFile(termId, filePath);
      if (buf.length > cap) return { error: t('error.fileTooLarge', { mb: (buf.length / 1024 / 1024).toFixed(1) }), size: buf.length };
      const { text, encoding } = decodeFileBuffer(buf);
      return { content: text, encoding, size: buf.length };
    }
  } catch (err: any) {
    return { error: String(err?.message || err) };
  }
});

// 파일/폴더의 Windows shell 아이콘을 data URL 로 반환 — FilePanel 에서 lazy 로딩
const fileIconCache = new Map<string, string>(); // path → dataUrl
// 확장자 → 아이콘 (SFTP/SSH 원격 파일용 — 로컬에 파일 없어도 확장자만으로 Windows 아이콘 추출)
const extIconCache = new Map<string, string>(); // ext → dataUrl
ipcMain.handle('fe:get-icons-by-ext', async (_e, { exts, isDir }: { exts: string[]; isDir?: boolean }) => {
  if (!Array.isArray(exts) || exts.length === 0) return { icons: {} };
  if (process.platform !== 'win32') return { icons: {} };
  const result: Record<string, string> = {};
  const remaining: string[] = [];
  const keyOf = (e: string) => `${isDir ? 'dir' : 'file'}:${e || ''}`;
  for (const e of exts) {
    const k = keyOf(e);
    if (extIconCache.has(k)) result[e] = extIconCache.get(k) || '';
    else remaining.push(e);
  }
  if (remaining.length === 0) return { icons: result };
  try {
    const { execFile } = require('child_process');
    // 확장자별로 가짜 경로 ".${ext}" 만들어 SHGFI_USEFILEATTRIBUTES 로 확장자 아이콘 조회
    const fakeList = remaining.map(e => isDir ? 'dummyfolder' : `dummy.${e}`).join('\n');
    const tmpList = path.join(os.tmpdir(), `pepe-ext-icon-list-${Date.now()}.txt`);
    fs.writeFileSync(tmpList, fakeList, { encoding: 'utf8' });
    const psScript = `chcp 65001 > $null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class IconHelper2 {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
  public struct SHFILEINFO {
    public IntPtr hIcon;
    public int iIcon;
    public uint dwAttributes;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szDisplayName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)] public string szTypeName;
  }
  [DllImport("shell32.dll", CharSet = CharSet.Auto)]
  public static extern IntPtr SHGetFileInfo(string pszPath, uint dwFileAttributes, ref SHFILEINFO psfi, uint cbFileInfo, uint uFlags);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool DestroyIcon(IntPtr hIcon);
}
"@ -ErrorAction SilentlyContinue
$SHGFI_ICON = 0x100
$SHGFI_SMALLICON = 0x1
$SHGFI_USEFILEATTRIBUTES = 0x10
$FILE_ATTRIBUTE_NORMAL = 0x80
$FILE_ATTRIBUTE_DIRECTORY = 0x10
$attr = ${isDir ? '$FILE_ATTRIBUTE_DIRECTORY' : '$FILE_ATTRIBUTE_NORMAL'}
$paths = Get-Content -LiteralPath '${tmpList.replace(/'/g, "''")}' -Encoding UTF8
$results = @{}
foreach ($p in $paths) {
  if (-not $p) { continue }
  try {
    $shfi = New-Object IconHelper2+SHFILEINFO
    $sz = [System.Runtime.InteropServices.Marshal]::SizeOf($shfi)
    [IconHelper2]::SHGetFileInfo($p, $attr, [ref]$shfi, $sz, $SHGFI_ICON -bor $SHGFI_SMALLICON -bor $SHGFI_USEFILEATTRIBUTES) | Out-Null
    if ($shfi.hIcon -ne [IntPtr]::Zero) {
      $icon = [System.Drawing.Icon]::FromHandle($shfi.hIcon)
      $bmp = $icon.ToBitmap()
      $ms = New-Object System.IO.MemoryStream
      $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
      $results[$p] = [Convert]::ToBase64String($ms.ToArray())
      $ms.Dispose(); $bmp.Dispose(); $icon.Dispose()
      [IconHelper2]::DestroyIcon($shfi.hIcon) | Out-Null
    } else { $results[$p] = '' }
  } catch { $results[$p] = '' }
}
$results | ConvertTo-Json -Compress`;
    const tmpPs = path.join(os.tmpdir(), `pepe-ext-icons-${Date.now()}.ps1`);
    try {
      fs.writeFileSync(tmpPs, '﻿' + psScript, { encoding: 'utf8' });
      console.log(`[ps-dbg main] SPAWN PowerShell (ext-icons) exts=${remaining.length} isDir=${isDir} mainHasFocus=${mainWindow?.isFocused()}`);
      const psStart = Date.now();
      const out: string = await new Promise<string>((resolve, reject) => {
        execFile('powershell', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpPs,
        ], { windowsHide: true, timeout: 30000, encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 },
        (err: any, stdout: string) => {
          console.log(`[ps-dbg main] PowerShell (ext-icons) DONE ${Date.now() - psStart}ms mainHasFocus=${mainWindow?.isFocused()} err=${!!err}`);
          if (err) reject(err);
          else resolve((stdout || '').trim());
        });
      });
      try { fs.unlinkSync(tmpPs); } catch {}
      try { fs.unlinkSync(tmpList); } catch {}
      if (out) {
        const parsed = JSON.parse(out);
        for (const e of remaining) {
          const fake = isDir ? 'dummyfolder' : `dummy.${e}`;
          const b64 = parsed[fake];
          if (b64 && typeof b64 === 'string' && b64.length > 50) {
            const dataUrl = `data:image/png;base64,${b64}`;
            result[e] = dataUrl;
            extIconCache.set(keyOf(e), dataUrl);
          } else {
            result[e] = '';
          }
        }
      }
    } catch {
      try { fs.unlinkSync(tmpPs); } catch {}
      try { fs.unlinkSync(tmpList); } catch {}
    }
  } catch {}
  return { icons: result };
});

// 배치 아이콘 추출 — 한 번의 PowerShell 호출로 여러 파일 처리 (개별 호출 시 process spawn 오버헤드 + 일부 실패 회피)
ipcMain.handle('fe:get-file-icons-batch', async (_e, { filePaths }: { filePaths: string[] }) => {
  if (!Array.isArray(filePaths) || filePaths.length === 0) return { icons: {} };
  if (process.platform !== 'win32') return { icons: {} };
  const result: Record<string, string> = {};
  // 캐시 hit 먼저 처리
  const remaining: string[] = [];
  for (const fp of filePaths) {
    const key = `${fp}|small`;
    if (fileIconCache.has(key)) {
      result[fp] = fileIconCache.get(key) || '';
    } else if (fs.existsSync(fp)) {
      remaining.push(fp);
    } else {
      result[fp] = '';
    }
  }
  if (remaining.length === 0) return { icons: result };
  try {
    const { execFile } = require('child_process');
    // 임시 파일에 경로 리스트 작성 (UTF-8) → PowerShell 이 읽어 한 번에 처리
    const tmpList = path.join(os.tmpdir(), `pepe-icon-list-${Date.now()}.txt`);
    fs.writeFileSync(tmpList, remaining.join('\n'), { encoding: 'utf8' });
    const psScript = `chcp 65001 > $null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
# Windows Explorer 와 동일한 SHGetFileInfo API 로 아이콘 추출 — 폴더 custom icon (desktop.ini),
# .lnk target icon, 파일 확장자 아이콘 등 모두 정확히 처리
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class IconHelper {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
  public struct SHFILEINFO {
    public IntPtr hIcon;
    public int iIcon;
    public uint dwAttributes;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szDisplayName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)] public string szTypeName;
  }
  [DllImport("shell32.dll", CharSet = CharSet.Auto)]
  public static extern IntPtr SHGetFileInfo(string pszPath, uint dwFileAttributes, ref SHFILEINFO psfi, uint cbFileInfo, uint uFlags);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool DestroyIcon(IntPtr hIcon);
}
"@ -ErrorAction SilentlyContinue
$SHGFI_ICON = 0x100
$SHGFI_SMALLICON = 0x1
$paths = Get-Content -LiteralPath '${tmpList.replace(/'/g, "''")}' -Encoding UTF8
$results = @{}
foreach ($p in $paths) {
  if (-not $p) { continue }
  try {
    $shfi = New-Object IconHelper+SHFILEINFO
    $sz = [System.Runtime.InteropServices.Marshal]::SizeOf($shfi)
    $r = [IconHelper]::SHGetFileInfo($p, 0, [ref]$shfi, $sz, $SHGFI_ICON -bor $SHGFI_SMALLICON)
    if ($shfi.hIcon -ne [IntPtr]::Zero) {
      $icon = [System.Drawing.Icon]::FromHandle($shfi.hIcon)
      $bmp = $icon.ToBitmap()
      $ms = New-Object System.IO.MemoryStream
      $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
      $results[$p] = [Convert]::ToBase64String($ms.ToArray())
      $ms.Dispose(); $bmp.Dispose(); $icon.Dispose()
      [IconHelper]::DestroyIcon($shfi.hIcon) | Out-Null
    } else {
      # SHGetFileInfo 실패 시 ExtractAssociatedIcon 으로 폴백
      try {
        $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($p)
        if ($icon) {
          $bmp = $icon.ToBitmap()
          $ms = New-Object System.IO.MemoryStream
          $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
          $results[$p] = [Convert]::ToBase64String($ms.ToArray())
          $ms.Dispose(); $bmp.Dispose(); $icon.Dispose()
        } else { $results[$p] = '' }
      } catch { $results[$p] = '' }
    }
  } catch {
    $results[$p] = ''
  }
}
$results | ConvertTo-Json -Compress`;
    const tmpPs = path.join(os.tmpdir(), `pepe-icons-batch-${Date.now()}.ps1`);
    try {
      fs.writeFileSync(tmpPs, '﻿' + psScript, { encoding: 'utf8' });
      console.log(`[ps-dbg main] SPAWN PowerShell (icons-batch) paths=${remaining.length} mainHasFocus=${mainWindow?.isFocused()} at=${new Date().toISOString()}`);
      const psStart = Date.now();
      // async execFile — main process 블록 안 함 → 렌더러의 windowFocus 요청 등이 즉시 처리됨
      const out: string = await new Promise<string>((resolve, reject) => {
        execFile('powershell', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpPs,
        ], { windowsHide: true, timeout: 30000, encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 },
        (err: any, stdout: string) => {
          console.log(`[ps-dbg main] PowerShell (icons-batch) DONE ${Date.now() - psStart}ms mainHasFocus=${mainWindow?.isFocused()} err=${!!err}`);
          if (err) reject(err);
          else resolve((stdout || '').trim());
        });
      });
      try { fs.unlinkSync(tmpPs); } catch {}
      try { fs.unlinkSync(tmpList); } catch {}
      if (out) {
        const parsed = JSON.parse(out);
        for (const fp of remaining) {
          const b64 = parsed[fp];
          if (b64 && typeof b64 === 'string' && b64.length > 50) {
            const dataUrl = `data:image/png;base64,${b64}`;
            result[fp] = dataUrl;
            if (fileIconCache.size > 500) {
              const firstKey = fileIconCache.keys().next().value;
              if (firstKey) fileIconCache.delete(firstKey);
            }
            fileIconCache.set(`${fp}|small`, dataUrl);
          } else {
            result[fp] = '';
          }
        }
      }
    } catch (err) {
      try { fs.unlinkSync(tmpPs); } catch {}
      try { fs.unlinkSync(tmpList); } catch {}
    }
  } catch {}
  return { icons: result };
});

ipcMain.handle('fe:get-file-icon', async (_e, { filePath, size }: { filePath: string; size?: 'small' | 'normal' | 'large' }) => {
  if (!filePath || typeof filePath !== 'string') return { dataUrl: '' };
  const cacheKey = `${filePath}|${size || 'small'}`;
  if (fileIconCache.has(cacheKey)) return { dataUrl: fileIconCache.get(cacheKey) };
  // shell:* / shell-pidl:* / ::CLSID 가상 항목 — Shell.Application ParseName 체인 + SHGetFileInfo(SHGFI_PIDL) 로 네이티브 아이콘 추출
  const isVirtual = /^(shell:|shell-pidl:|::\{)/i.test(filePath);
  if (isVirtual && process.platform === 'win32') {
    try {
      const { execFileSync } = require('child_process');
      // shell-pidl:<root>||a||b 형식 분해
      let rootPath: string;
      let chain: string[] = [];
      if (filePath.startsWith('shell-pidl:')) {
        const body = filePath.slice('shell-pidl:'.length);
        const segs = body.split('||');
        rootPath = segs[0];
        chain = segs.slice(1);
      } else {
        rootPath = filePath;
      }
      const psChain = chain.map(c => `'${c.replace(/'/g, "''")}'`).join(',');
      const rootArg = rootPath === 'shell:Desktop' ? '0' : `'${rootPath.replace(/'/g, "''")}'`;
      const psScript = `chcp 65001 > $null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Drawing;
using System.Runtime.InteropServices;
public class ShellIcon {
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)]
  public static extern int SHParseDisplayName(string pszName, IntPtr pbc, out IntPtr ppidl, uint sfgaoIn, out uint psfgaoOut);
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)]
  public static extern IntPtr SHGetFileInfo(IntPtr pidl, uint dwFileAttributes, ref SHFILEINFO psfi, uint cbFileInfo, uint uFlags);
  [DllImport("user32.dll")]
  public static extern bool DestroyIcon(IntPtr hIcon);
  [DllImport("ole32.dll")]
  public static extern void CoTaskMemFree(IntPtr ptr);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct SHFILEINFO {
    public IntPtr hIcon;
    public int iIcon;
    public uint dwAttributes;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string szDisplayName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=80)] public string szTypeName;
  }
}
"@
# 1) ParseName chain 으로 최종 FolderItem 의 Path 를 얻는다 (체인 없으면 root 자체)
$shell = New-Object -ComObject Shell.Application
$resolved = ''
$ns = $shell.NameSpace(${rootArg})
if ($ns) {
  $chainNames = @(${psChain})
  if ($chainNames.Count -eq 0) {
    # root 자체 — Self.Path
    try { $resolved = $ns.Self.Path } catch {}
  } else {
    $folder = $ns
    $finalItem = $null
    foreach ($name in $chainNames) {
      if (-not $folder) { break }
      $child = $folder.ParseName($name)
      if (-not $child) {
        foreach ($c in $folder.Items()) { if ($c.Name -eq $name) { $child = $c; break } }
      }
      if (-not $child) { break }
      $finalItem = $child
      $sub = $null
      try { $sub = $child.GetFolder } catch {}
      if (-not $sub -and $child.Path) {
        try { $sub = $shell.NameSpace($child.Path) } catch { $sub = $null }
      }
      $folder = $sub
    }
    if ($finalItem) { try { $resolved = $finalItem.Path } catch {} }
  }
}
if (-not $resolved) { $resolved = '${rootPath.replace(/'/g, "''")}' }
# 2) resolved Path 로 SHParseDisplayName → SHGetFileInfo
$pidl = [IntPtr]::Zero
$attr = [uint32]0
$hr = [ShellIcon]::SHParseDisplayName($resolved, [IntPtr]::Zero, [ref]$pidl, 0, [ref]$attr)
if ($hr -eq 0 -and $pidl -ne [IntPtr]::Zero) {
  $info = New-Object ShellIcon+SHFILEINFO
  $sz = [System.Runtime.InteropServices.Marshal]::SizeOf($info)
  $flags = 0x100 -bor 0x008  # SHGFI_ICON | SHGFI_PIDL
  [void][ShellIcon]::SHGetFileInfo($pidl, 0, [ref]$info, $sz, $flags)
  if ($info.hIcon -ne [IntPtr]::Zero) {
    try {
      $icon = [System.Drawing.Icon]::FromHandle($info.hIcon)
      $bmp = $icon.ToBitmap()
      $ms = New-Object System.IO.MemoryStream
      $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
      Write-Output ([Convert]::ToBase64String($ms.ToArray()))
      $ms.Dispose()
      $bmp.Dispose()
      $icon.Dispose()
    } catch {}
    [void][ShellIcon]::DestroyIcon($info.hIcon)
  }
  [ShellIcon]::CoTaskMemFree($pidl)
}`;
      const tmpPs = path.join(os.tmpdir(), `pepe-shellicon-${Date.now()}.ps1`);
      try {
        fs.writeFileSync(tmpPs, '﻿' + psScript, { encoding: 'utf8' });
        const out: string = execFileSync('powershell', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpPs,
        ], { windowsHide: true, timeout: 7000 }).toString('utf-8').trim();
        try { fs.unlinkSync(tmpPs); } catch {}
        if (out && out.length > 50) {
          const dataUrl = `data:image/png;base64,${out}`;
          if (fileIconCache.size > 500) {
            const firstKey = fileIconCache.keys().next().value;
            if (firstKey) fileIconCache.delete(firstKey);
          }
          fileIconCache.set(cacheKey, dataUrl);
          return { dataUrl };
        }
      } catch {
        try { fs.unlinkSync(tmpPs); } catch {}
      }
    } catch {}
    return { dataUrl: '' };
  }
  try {
    if (!fs.existsSync(filePath)) return { dataUrl: '' };
    let dataUrl = '';
    // 1차: PowerShell System.Drawing.Icon.ExtractAssociatedIcon — .lnk 의 실제 target 아이콘까지
    //   처리. Win32 SHGetFileInfo 와 동일 결과로, 거의 모든 케이스에서 동작.
    if (process.platform === 'win32') {
      try {
        const { execFileSync } = require('child_process');
        const psScript = `chcp 65001 > $null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
try {
  $icon = [System.Drawing.Icon]::ExtractAssociatedIcon('${filePath.replace(/'/g, "''")}')
  if ($icon) {
    $bmp = $icon.ToBitmap()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Output ([Convert]::ToBase64String($ms.ToArray()))
    $ms.Dispose()
    $bmp.Dispose()
    $icon.Dispose()
  }
} catch {}`;
        const tmpPs = path.join(os.tmpdir(), `pepe-icon-${Date.now()}.ps1`);
        try {
          fs.writeFileSync(tmpPs, '﻿' + psScript, { encoding: 'utf8' });
          const out: string = execFileSync('powershell', [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpPs,
          ], { windowsHide: true, timeout: 5000 }).toString('utf-8').trim();
          try { fs.unlinkSync(tmpPs); } catch {}
          if (out && out.length > 50) dataUrl = `data:image/png;base64,${out}`;
        } catch {
          try { fs.unlinkSync(tmpPs); } catch {}
        }
      } catch {}
    }
    // 2차 fallback: Electron app.getFileIcon (cross-platform)
    if (!dataUrl) {
      try {
        const img = await app.getFileIcon(filePath, { size: (size || 'small') as any });
        if (img && !img.isEmpty()) dataUrl = img.toDataURL();
      } catch {}
    }
    if (!dataUrl) return { dataUrl: '' };
    if (fileIconCache.size > 500) {
      const firstKey = fileIconCache.keys().next().value;
      if (firstKey) fileIconCache.delete(firstKey);
    }
    fileIconCache.set(cacheKey, dataUrl);
    return { dataUrl };
  } catch {
    return { dataUrl: '' };
  }
});

ipcMain.handle('fe:get-drives', async () => {
  if (process.platform === 'win32') {
    try {
      const { execFileSync } = require('child_process');
      // PowerShell 스크립트 — 임시 파일로 저장 후 실행 (UTF-8 인코딩 안정성 + NetHood 항목 UNC 해석)
      const psScript = `chcp 65001 > $null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$shell = New-Object -ComObject Shell.Application
$wsh = New-Object -ComObject WScript.Shell

function Resolve-NetHoodPath {
  param([string]$p)
  # NetHood 의 단축아이콘 폴더면 target.lnk 또는 내부 .lnk 의 UNC 타깃 반환
  if (-not $p) { return $p }
  if ($p.StartsWith('\\')) { return $p }
  if (-not (Test-Path $p)) { return $p }
  $tlnk = Join-Path $p 'target.lnk'
  if (Test-Path $tlnk) {
    try {
      $lk = $wsh.CreateShortcut($tlnk)
      if ($lk.TargetPath -and $lk.TargetPath.StartsWith('\\')) { return $lk.TargetPath }
    } catch {}
  }
  # *.lnk 파일 직접 검색
  try {
    $lnks = Get-ChildItem -Path $p -Filter '*.lnk' -File -ErrorAction SilentlyContinue
    foreach ($f in $lnks) {
      try {
        $lk = $wsh.CreateShortcut($f.FullName)
        if ($lk.TargetPath -and $lk.TargetPath.StartsWith('\\')) { return $lk.TargetPath }
      } catch {}
    }
  } catch {}
  return $p
}

function Get-DriveIcon {
  param([string]$path, [int]$driveType)
  if ($path -match '^[A-Z]:') {
    # DriveType: 2=Removable, 3=Local, 4=Network, 5=CDROM
    switch ($driveType) {
      2 { return '🔌' }
      3 { return '💾' }
      4 { return '🌐' }
      5 { return '💿' }
      default { return '💾' }
    }
  }
  if ($path.StartsWith('\\')) { return '🌐' }
  return '📁'
}

# Win32_LogicalDisk 로 DriveType 정보 미리 수집 (드라이브 letter → type 매핑)
$driveTypes = @{}
try {
  Get-CimInstance Win32_LogicalDisk -ErrorAction SilentlyContinue | ForEach-Object {
    $driveTypes[$_.DeviceID.ToUpper()] = [int]$_.DriveType
  }
} catch {}

$items = @()
# 트리 구조:
# 바탕 화면 (depth 0, 가상 데스크톱 = shell:Desktop)
#   내 PC (depth 1)
#     드라이브 / MTP / 네트워크 (depth 2)
#   다운로드, 문서, 사진, 동영상, 음악, 홈 (depth 1, 내 PC 아래에 위치)
# 바탕 화면 (depth 0) — 가상 데스크톱으로 navigate (안에 내 PC / 갤러리 / 라이브러리 등)
$items += [PSCustomObject]@{
  Path = 'shell:Desktop'
  Label = '🖼 바탕 화면'
  Depth = 0
  Order = 0
}
# 내 PC (depth 1, 첫 번째)
$items += [PSCustomObject]@{
  Path = 'shell:MyComputerFolder'
  Label = '💻 내 PC'
  Depth = 1
  Order = 100
}
# 내 PC 자식 (depth 2) — 드라이브 / MTP / 네트워크
$childIdx = 0
try {
  $pc = $shell.Namespace(0x11)
  if ($pc) {
    foreach ($it in $pc.Items()) {
      $p = $it.Path
      $n = $it.Name
      if (-not $p -or -not $n) { continue }
      $resolved = Resolve-NetHoodPath $p
      $icon = '📁'
      if ($resolved -match '^([A-Z]:)') {
        $dev = $Matches[1].ToUpper()
        $dt = if ($driveTypes.ContainsKey($dev)) { $driveTypes[$dev] } else { 3 }
        $icon = Get-DriveIcon -path $resolved -driveType $dt
      } elseif ($resolved.StartsWith('\\')) {
        $icon = '🌐'
      } elseif ($p -match 'samsung|android|iphone|ipad|usb|mtp') {
        $icon = '📱'
      } else {
        $icon = '📁'
      }
      $groupOrder = if ($resolved -match '^[A-Z]:') { 0 } elseif ($resolved.StartsWith('::')) { 1 } elseif ($resolved.StartsWith('\\')) { 2 } else { 3 }
      $finalPath = if ($resolved -and $resolved.StartsWith('::')) { 'shell-pidl:' + $resolved } else { $resolved }
      $items += [PSCustomObject]@{
        Path = $finalPath
        Label = "$icon $n"
        Depth = 2
        Order = 100 + 0.01 + $groupOrder * 0.001 + ($childIdx * 0.0001)
      }
      $childIdx++
    }
  }
} catch {}
# 다운로드, 문서, 사진, 동영상, 음악 (depth 1, 내 PC 아래)
$specialFolders = @(
  @{ Name = 'Downloads'; Label = '⬇ 다운로드' },
  @{ Name = 'MyDocuments'; Label = '📄 문서' },
  @{ Name = 'MyPictures'; Label = '🖼 사진' },
  @{ Name = 'MyVideos'; Label = '🎬 동영상' },
  @{ Name = 'MyMusic'; Label = '🎵 음악' }
)
$sfOrder = 200
foreach ($sf in $specialFolders) {
  try {
    $p = $null
    if ($sf.Name -eq 'Downloads') {
      $shellFolder = $shell.Namespace('shell:Downloads')
      if ($shellFolder) { $p = $shellFolder.Self.Path }
    } else {
      $p = [Environment]::GetFolderPath($sf.Name)
    }
    if ($p -and (Test-Path $p)) {
      $items += [PSCustomObject]@{
        Path = $p
        Label = $sf.Label
        Depth = 1
        Order = $sfOrder
      }
      $sfOrder++
    }
  } catch {}
}
# 홈 (depth 1, 마지막)
try {
  $userProfile = [Environment]::GetFolderPath('UserProfile')
  if ($userProfile) {
    $items += [PSCustomObject]@{
      Path = $userProfile
      Label = "🏠 홈 ($([System.IO.Path]::GetFileName($userProfile)))"
      Depth = 1
      Order = $sfOrder
    }
  }
} catch {}
$items | Sort-Object Order | ConvertTo-Json -Compress`;
      // 스크립트를 UTF-8 (BOM 포함) 임시 파일로 — PowerShell 이 한글 안전하게 파싱하도록
      const tmpPs = path.join(os.tmpdir(), `pepe-drives-${Date.now()}.ps1`);
      try {
        fs.writeFileSync(tmpPs, '﻿' + psScript, { encoding: 'utf8' });
        const out: string = execFileSync('powershell', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpPs,
        ], { windowsHide: true, timeout: 10000 }).toString('utf-8');
        try { fs.unlinkSync(tmpPs); } catch {}
        const data = JSON.parse(out.trim() || '[]');
        const arr: any[] = Array.isArray(data) ? data : [data];
        return arr.map(x => ({
          path: String(x.Path || ''),
          label: String(x.Label || x.Path || ''),
          depth: Number(x.Depth) || 0,
        })).filter(x => x.path);
      } catch (innerErr) {
        try { fs.unlinkSync(tmpPs); } catch {}
        throw innerErr;
      }
    } catch (err: any) {
      console.error('[fe:get-drives] PS failed:', err?.message || err);
      // PowerShell 실패 시 fallback — drive letter 만
      const letters: { path: string; label: string }[] = [];
      for (let i = 65; i <= 90; i++) {
        const d = String.fromCharCode(i) + ':\\';
        try { await fs.promises.access(d); letters.push({ path: d, label: d }); } catch {}
      }
      return letters;
    }
  }
  return [{ path: '/', label: '/' }];
});

ipcMain.handle('fe:get-home', () => {
  return require('os').homedir();
});

// 파일 전송 — 백그라운드 실행하여 IPC 채널 즉시 해제 (progress 이벤트 실시간 수신 가능)
let _feTransferSeq = 0;
ipcMain.handle('fe:transfer', (_e, { src, dst, filename, workspaceId }: any) => {
  const seq = ++_feTransferSeq;
  const bridge = getSSHBridge();
  bridge.handleTransfer(src, dst, filename, undefined, workspaceId)
    .then(() => mainWindow?.webContents.send('fe:transfer-done', { seq, success: true }))
    .catch((err: any) => mainWindow?.webContents.send('fe:transfer-done', { seq, success: false, error: String(err) }));
  return { seq }; // 즉시 반환 — 완료는 fe:transfer-done 이벤트로 수신
});

ipcMain.handle('fe:resolve-conflict', (_e, { requestId, decision }: any) => {
  const bridge = getSSHBridge();
  bridge.resolveConflict(requestId, decision);
  return { success: true };
});

ipcMain.handle('fe:cancel-transfer', (_e, { transferId }: any) => {
  const bridge = getSSHBridge();
  bridge.cancelTransfer(transferId);
  return { success: true };
});

// 파일 탐색기에서 파일/폴더 위치 보기 (Windows Explorer 에 선택 상태로 열기)
ipcMain.handle('shell:show-item', (_e, { fullPath }: { fullPath: string }) => {
  try { shell.showItemInFolder(fullPath); return { success: true }; }
  catch (err: any) { return { success: false, error: String(err) }; }
});

// 폴더 직접 열기
ipcMain.handle('shell:open-path', async (_e, { dirPath }: { dirPath: string }) => {
  try { const err = await shell.openPath(dirPath); return { success: !err, error: err || undefined }; }
  catch (err: any) { return { success: false, error: String(err) }; }
});

ipcMain.handle('fe:chmod', async (_e, { mode, termId, paths, octal, recursive }: any) => {
  try {
    const bridge = getSSHBridge();
    if (mode === 'local') {
      const walkAndChmod = async (p: string): Promise<void> => {
        const fs = require('fs');
        try {
          const st = await fs.promises.stat(p);
          await fs.promises.chmod(p, octal);
          if (recursive && st.isDirectory()) {
            const entries = await fs.promises.readdir(p);
            for (const e of entries) await walkAndChmod(require('path').join(p, e));
          }
        } catch (err) { /* 권한 변경 실패한 항목은 무시 — Windows 는 mode 매핑이 제한적 */ }
      };
      for (const p of paths) await walkAndChmod(p);
      return { success: true };
    }
    // 원격 — SSH exec 로 chmod 실행
    const flag = recursive ? '-R ' : '';
    const octStr = octal.toString(8).padStart(3, '0');
    // 경로 쉘 escape (single-quote)
    const quote = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;
    const cmd = `chmod ${flag}${octStr} ${paths.map(quote).join(' ')}`;
    const result = await bridge.handleExec(termId, cmd, 30000);
    if (result.exitCode !== 0) {
      return { success: false, error: result.stderr || `exit ${result.exitCode}` };
    }
    return { success: true };
  } catch (err: any) { return { success: false, error: String(err?.message || err) }; }
});

ipcMain.handle('fe:mkdir', async (_e, { mode, termId, dirPath }: any) => {
  try {
    const bridge = getSSHBridge();
    if (mode === 'local') await bridge.handleLocalMkdir(dirPath);
    else await bridge.handleSFTPMkdir(termId, dirPath);
    return { success: true };
  } catch (err: any) { return { success: false, error: String(err) }; }
});

ipcMain.handle('fe:create-file', async (_e, { mode, termId, filePath }: any) => {
  try {
    if (mode === 'local') {
      const fs = require('fs');
      await fs.promises.writeFile(filePath, '', { flag: 'wx' });
    } else {
      const bridge = getSSHBridge();
      const sftp: any = await bridge.getSftp(termId);
      await new Promise<void>((res, rej) => {
        // 'wx' = exclusive write, 이미 있으면 실패
        sftp.open(filePath, 'wx', (err: any, handle: any) => {
          if (err) return rej(err);
          sftp.close(handle, (e: any) => e ? rej(e) : res());
        });
      });
    }
    return { success: true };
  } catch (err: any) { return { success: false, error: String(err?.message || err) }; }
});

ipcMain.handle('fe:delete', (_e, { mode, termId, filePath, workspaceId }: any) => {
  const deleteId = `del-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const bridge = getSSHBridge();
  bridge.handleDeleteWithProgress(deleteId, mode, termId, filePath, workspaceId)
    .then(() => mainWindow?.webContents.send('fe:delete-done', { deleteId, success: true }))
    .catch((err: any) => mainWindow?.webContents.send('fe:delete-done', { deleteId, success: false, error: String(err) }));
  return { deleteId };
});

ipcMain.handle('fe:rename', async (_e, { mode, termId, oldPath, newPath }: any) => {
  try {
    const bridge = getSSHBridge();
    if (mode === 'local') await bridge.handleLocalRename(oldPath, newPath);
    else await bridge.handleSFTPRename(termId, oldPath, newPath);
    return { success: true };
  } catch (err: any) { return { success: false, error: String(err) }; }
});

ipcMain.handle('fe:home-dir', async (_e, { mode, termId }: { mode: string; termId?: string }) => {
  try {
    const bridge = getSSHBridge();
    if (mode === 'local') return require('os').homedir();
    const home = await bridge.handleSFTPRealPath(termId!, '.');
    // 경로 접근 가능한지 확인
    try { await bridge.handleSFTPListDir(termId!, home); return home; } catch {}
    // 접근 불가하면 / 시도
    try { await bridge.handleSFTPListDir(termId!, '/'); return '/'; } catch {}
    return home;
  } catch { return '/'; }
});

ipcMain.handle('fe:sftp-connect', async (_e, { connId, host, port, username, auth, jumpOpts }: any) => {
  try {
    const bridge = getSSHBridge();
    await bridge.handleSFTPConnect(connId, host, port || 22, username, auth, jumpOpts);
    return { success: true };
  } catch (err: any) { return { success: false, error: String(err) }; }
});

ipcMain.handle('fe:sftp-disconnect', (_e, { connId }: any) => {
  const bridge = getSSHBridge();
  bridge.handleSFTPDisconnect(connId);
});

// SQL Tool — CSV 파일 저장 다이얼로그
ipcMain.handle('sql:save-csv', async (_e, { defaultName, content }: { defaultName?: string; content: string }) => {
  if (!mainWindow) return { success: false, error: 'no window' };
  const r = await dialog.showSaveDialog(mainWindow, {
    title: t('dialog.saveCsv'),
    defaultPath: defaultName || 'query-result.csv',
    filters: [{ name: 'CSV', extensions: ['csv'] }, { name: 'All Files', extensions: ['*'] }],
  });
  if (r.canceled || !r.filePath) return { success: false, canceled: true };
  try {
    fs.writeFileSync(r.filePath, '﻿' + content, 'utf8'); // BOM for Excel
    return { success: true, path: r.filePath };
  } catch (err: any) {
    return { success: false, error: String(err?.message || err) };
  }
});

// SQL Tool — 동일 SSH 연결의 exec 채널로 isql 등 임의 명령 실행
ipcMain.handle('sql:exec', async (_e, { connId, command, timeoutMs }: { connId: string; command: string; timeoutMs?: number }) => {
  try {
    const bridge = getSSHBridge();
    const r = await bridge.handleSQLExec(connId, command, timeoutMs);
    return { success: true, ...r };
  } catch (err: any) {
    return { success: false, error: String(err?.message || err) };
  }
});

ipcMain.handle('fe:connected-sessions', () => {
  const bridge = getSSHBridge();
  return bridge.getConnectedPanelIds();
});

// ── SFTP IPC ──

ipcMain.handle('sftp:download', async (_e, { panelId, remotePath, isDir }: { panelId: string; remotePath: string; isDir?: boolean }) => {
  if (!mainWindow) return null;
  const bridge = getSSHBridge();
  const baseName = remotePath.split('/').filter(Boolean).pop() || 'download';
  if (isDir) {
    // 폴더 다운로드 — 부모 폴더 고른 뒤 그 안에 원격 폴더 이름으로 재귀 복사
    const pick = await dialog.showOpenDialog(mainWindow, {
      title: t('dialog.saveDownloadLocation'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (pick.canceled || pick.filePaths.length === 0) return null;
    const parentDir = pick.filePaths[0];
    const localDst = path.join(parentDir, baseName);
    try {
      await bridge.handleTransfer(
        { mode: 'remote', termId: panelId, path: remotePath },
        { mode: 'local', path: localDst },
        baseName,
      );
      return { success: true, localPath: localDst };
    } catch (err: any) {
      return { success: false, error: String(err) };
    }
  }
  // 파일 다운로드 — 저장 이름까지 지정
  const result = await dialog.showSaveDialog(mainWindow, {
    title: t('dialog.saveRemoteFile'),
    defaultPath: baseName,
  });
  if (result.canceled || !result.filePath) return null;
  try {
    await bridge.handleSFTPDownload(panelId, remotePath, result.filePath);
    return { success: true, localPath: result.filePath };
  } catch (err: any) {
    return { success: false, error: String(err) };
  }
});

// 다중 파일 다운로드 — 한번 폴더 고른 뒤 모든 항목을 그 폴더 안에 저장
ipcMain.handle('sftp:download-multi', async (_e, { panelId, items }: { panelId: string; items: { path: string; isDir: boolean }[] }) => {
  if (!mainWindow || !items || items.length === 0) return null;
  const bridge = getSSHBridge();
  const pick = await dialog.showOpenDialog(mainWindow, {
    title: t('dialog.downloadMultiTitle', { count: items.length }),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (pick.canceled || pick.filePaths.length === 0) return null;
  const parentDir = pick.filePaths[0];
  const results: { path: string; success: boolean; error?: string }[] = [];
  for (const item of items) {
    const baseName = item.path.split('/').filter(Boolean).pop() || 'download';
    const localDst = path.join(parentDir, baseName);
    try {
      await bridge.handleTransfer(
        { mode: 'remote', termId: panelId, path: item.path },
        { mode: 'local', path: localDst },
        baseName,
      );
      results.push({ path: item.path, success: true });
    } catch (err: any) {
      results.push({ path: item.path, success: false, error: String(err) });
    }
  }
  const okCount = results.filter(r => r.success).length;
  return { success: okCount > 0, total: items.length, ok: okCount, results, localDir: parentDir };
});

ipcMain.handle('sftp:upload', async (_e, { panelId, remotePath, kind }: { panelId: string; remotePath: string; kind?: 'file' | 'folder' | 'multi-file' }) => {
  if (!mainWindow) return null;
  const isFolder = kind === 'folder';
  const isMulti = kind === 'multi-file';
  const result = await dialog.showOpenDialog(mainWindow, {
    title: isFolder ? t('dialog.uploadFolder') : (isMulti ? t('dialog.uploadFileMulti') : t('dialog.uploadFile')),
    properties: isFolder ? ['openDirectory'] : (isMulti ? ['openFile', 'multiSelections'] : ['openFile']),
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  // 다중 파일 업로드 — 각 파일을 순차 업로드
  if (isMulti) {
    const bridge = getSSHBridge();
    const results: { filename: string; success: boolean; error?: string }[] = [];
    for (const localPath of result.filePaths) {
      const filename = localPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
      const fullRemote = remotePath.endsWith('/') ? remotePath + filename : remotePath + '/' + filename;
      try {
        await bridge.handleTransfer(
          { mode: 'local', path: localPath },
          { mode: 'remote', termId: panelId, path: fullRemote },
          filename,
        );
        results.push({ filename, success: true });
      } catch (err: any) {
        results.push({ filename, success: false, error: String(err) });
      }
    }
    const okCount = results.filter(r => r.success).length;
    return { success: okCount > 0, total: result.filePaths.length, ok: okCount, results };
  }
  const localPath = result.filePaths[0];
  const filename = localPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
  const fullRemote = remotePath.endsWith('/') ? remotePath + filename : remotePath + '/' + filename;
  try {
    const bridge = getSSHBridge();
    if (isFolder) {
      await bridge.handleTransfer(
        { mode: 'local', path: localPath },
        { mode: 'remote', termId: panelId, path: fullRemote },
        filename,
      );
    } else {
      await bridge.handleSFTPUpload(panelId, localPath, fullRemote);
    }
    return { success: true, remotePath: fullRemote };
  } catch (err: any) {
    return { success: false, error: String(err) };
  }
});

ipcMain.handle('sftp:list-dir', async (_e, { panelId, remotePath }: { panelId: string; remotePath: string }) => {
  try {
    const bridge = getSSHBridge();
    return await bridge.handleSFTPListDir(panelId, remotePath);
  } catch (err: any) {
    return { error: String(err) };
  }
});

ipcMain.handle('sftp:read-file', async (_e, { panelId, remotePath, encoding }: { panelId: string; remotePath: string; encoding?: string }) => {
  try {
    const bridge = getSSHBridge();
    const buf = await bridge.handleSFTPReadFile(panelId, remotePath);
    const iconv = require('iconv-lite');
    const enc = (encoding || 'utf-8').toLowerCase();
    let text: string;
    try {
      if (enc === 'utf-8' || enc === 'utf8') {
        text = buf.toString('utf-8');
      } else if (iconv.encodingExists(enc)) {
        text = iconv.decode(buf, enc);
      } else {
        text = buf.toString('utf-8');
      }
    } catch {
      text = buf.toString('utf-8');
    }
    return { success: true, text, size: buf.length };
  } catch (err: any) {
    return { success: false, error: String(err) };
  }
});

ipcMain.handle('sftp:write-file', async (_e, { panelId, remotePath, content, encoding }: { panelId: string; remotePath: string; content: string; encoding?: string }) => {
  try {
    const bridge = getSSHBridge();
    const iconv = require('iconv-lite');
    const enc = (encoding || 'utf-8').toLowerCase();
    let buf: Buffer;
    if (enc === 'utf-8' || enc === 'utf8') {
      buf = Buffer.from(content, 'utf-8');
    } else if (iconv.encodingExists(enc)) {
      buf = iconv.encode(content, enc);
    } else {
      buf = Buffer.from(content, 'utf-8');
    }
    await bridge.handleSFTPWriteFile(panelId, remotePath, buf);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: String(err) };
  }
});



// ── 창 제어 ──
let dragStartPos: { x: number; y: number } | null = null;

ipcMain.on('window:start-drag', (_e, { mouseX, mouseY }: any) => {
  if (!mainWindow) return;
  const [wx, wy] = mainWindow.getPosition();
  dragStartPos = { x: mouseX - wx, y: mouseY - wy };
});

ipcMain.on('window:drag-move', (_e, { mouseX, mouseY }: any) => {
  if (!mainWindow || !dragStartPos) return;
  // 최대화 상태에서 드래그하면 자동 복원
  if (mainWindow.isMaximized()) {
    const restoreW = savedBounds.width;
    const restoreH = savedBounds.height;
    const offsetX = Math.min(dragStartPos.x, restoreW - 80);
    const newX = mouseX - offsetX;
    const newY = mouseY - Math.min(dragStartPos.y, 20);
    mainWindow.unmaximize();
    mainWindow.setBounds({ x: newX, y: newY, width: restoreW, height: restoreH });
    dragStartPos = { x: offsetX, y: Math.min(dragStartPos.y, 20) };
    isMaximized = false;
    return;
  }
  mainWindow.setPosition(mouseX - dragStartPos.x, mouseY - dragStartPos.y);
});

ipcMain.on('window:end-drag', () => { dragStartPos = null; });

ipcMain.handle('window:minimize', () => mainWindow?.minimize());
ipcMain.handle('window:toggle-maximize', () => {
  if (!mainWindow) return;
  dragStartPos = null;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
    isMaximized = false;
  } else {
    savedBounds = mainWindow.getBounds();
    mainWindow.maximize();
    isMaximized = true;
  }
  mainWindow.webContents.send('window:maximized', isMaximized);
});
ipcMain.handle('window:is-maximized', () => !!mainWindow?.isMaximized());
ipcMain.handle('window:close', () => mainWindow?.close());
ipcMain.handle('window:focus', () => {
  if (!mainWindow) return;
  console.log(`[ps-dbg main] window:focus IPC received mainHasFocus(before)=${mainWindow.isFocused()} minimized=${mainWindow.isMinimized()}`);
  try {
    if (mainWindow.isMinimized()) mainWindow.restore();
    // Windows 에서 백그라운드 process(PowerShell 등) 가 잠시 foreground 를 채간 경우,
    // 단순한 focus() 는 무시될 수 있음 → alwaysOnTop 토글 트릭으로 강제 foreground
    mainWindow.show();
    // alwaysOnTop 토글: 잠시 최상위로 올렸다 내림. Windows 에서 foreground 강제 효과적.
    const wasOnTop = mainWindow.isAlwaysOnTop();
    if (!wasOnTop) {
      mainWindow.setAlwaysOnTop(true);
    }
    mainWindow.moveTop();
    mainWindow.focus();
    // 명시적 webContents focus — 키보드 입력 capture 보장
    try { mainWindow.webContents.focus(); } catch {}
    // 토글 복귀 — 다음 tick 에 alwaysOnTop 해제 (이때는 이미 foreground 됨)
    if (!wasOnTop) {
      setTimeout(() => {
        try { mainWindow?.setAlwaysOnTop(false); } catch {}
      }, 50);
    }
    // app.focus() 도 추가 — Electron 앱 자체를 foreground 로
    try { app.focus({ steal: true }); } catch {}
    console.log(`[ps-dbg main] window:focus IPC DONE mainHasFocus(after)=${mainWindow.isFocused()}`);
  } catch (err) { console.log('[ps-dbg main] window:focus IPC ERR', err); }
});

ipcMain.handle('ssh:auth-response', (_e, { panelId, responses }: { panelId: string; responses: string[] }) => {
  const bridge = getSSHBridge();
  bridge.handleAuthResponse(panelId, responses);
  return 'ok';
});

ipcMain.handle('ssh:reset-state', (_e, panelId: string) => {
  connectedPanels.delete(panelId);
  connectingPanels.delete(panelId);
  return 'ok';
});

ipcMain.handle('ssh:connect', (_e, { panelId, sessionId, cols, rows }) => {
  if (connectingPanels.has(panelId)) return 'already';
  if (connectedPanels.has(panelId)) return 'already';

  const session = sessionsData.sessions.find(s => s.id === sessionId);
  if (!session) throw new Error('Session not found');

  // 비밀번호가 비어있으면 renderer에 비밀번호 요청
  const needsPassword = !session.auth || (session.auth.type === 'password' && !session.auth.password);
  if (needsPassword) {
    return 'need-password';
  }

  connectingPanels.add(panelId);

  const bridge = getSSHBridge();
  bridge.handleConnect(panelId, session, cols, rows);
  return 'ok';
});

ipcMain.handle('ssh:connect-with-password', (_e, { panelId, sessionId, password, cols, rows }) => {
  if (connectingPanels.has(panelId)) return 'already';
  if (connectedPanels.has(panelId)) return 'already';
  const session = sessionsData.sessions.find(s => s.id === sessionId);
  if (!session) throw new Error('Session not found');
  connectingPanels.add(panelId);
  const bridge = getSSHBridge();
  // 임시로 비밀번호를 설정해서 연결
  const sessionWithPw = { ...session, auth: { type: 'password' as const, password } };
  bridge.handleConnect(panelId, sessionWithPw, cols, rows);
  return 'ok';
});

ipcMain.handle('ssh:quick-connect', (_e, { panelId, session, cols, rows }) => {
  if (connectingPanels.has(panelId)) return 'already';
  if (connectedPanels.has(panelId)) return 'already';
  if (!session || !session.host) throw new Error('Invalid session');
  // username 이나 비밀번호가 비어있으면 renderer 에 자격증명 요청
  if (!session.username) return 'need-credentials';
  const needsPassword = !session.auth || (session.auth.type === 'password' && !session.auth.password);
  if (needsPassword) return 'need-password';

  connectingPanels.add(panelId);
  const bridge = getSSHBridge();
  bridge.handleConnect(panelId, session, cols, rows);
  return 'ok';
});

ipcMain.handle('ssh:is-connected', (_e, panelId: string) => {
  return connectedPanels.has(panelId);
});

ipcMain.on('ssh:input', (_e, { panelId, data, b64 }) => {
  getSSHBridge().handleInput(panelId, data, b64);
});

ipcMain.on('ssh:disconnect', (_e, { panelId }) => {
  getSSHBridge().handleDisconnect(panelId);
  if (webdavBridge) {
    try { webdavBridge.unregisterSession(panelId); } catch {}
  }
});

const _lastSshResize = new Map<string, { cols: number; rows: number }>();
ipcMain.on('ssh:resize', (_e, { panelId, cols, rows, force }: { panelId: string; cols: number; rows: number; force?: boolean }) => {
  if (!cols || !rows || !isFinite(cols) || !isFinite(rows) || cols < 1 || rows < 1) return;
  const last = _lastSshResize.get(panelId);
  // force 가 명시되면 dedup 우회 (vim 등 alt-buffer 진입 시 PTY 사이즈 재동기화)
  if (!force && last && last.cols === cols && last.rows === rows) return;
  _lastSshResize.set(panelId, { cols, rows });
  getSSHBridge().handleResize(panelId, cols, rows);
});

ipcMain.handle('ssh:set-encoding', (_e, { panelId, encoding }) => {
  return getSSHBridge().setEncoding(panelId, encoding);
});

ipcMain.handle('ssh:set-auto-track', (_e, { panelId, enabled }: { panelId: string; enabled: boolean }) => {
  return getSSHBridge().setAutoTrack(panelId, !!enabled);
});

ipcMain.handle('ssh:get-encoding', (_e, panelId: string) => {
  return getSSHBridge().getEncoding(panelId);
});

// ── Local Shell (node-pty) ──
const ptyProcesses = new Map<string, pty.IPty>();

// 앱 종료 직전 — PTY/Claude 자식 프로세스 일괄 정리. (SSH/X11 정리는 위쪽 핸들러)
app.on('before-quit', () => {
  for (const proc of ptyProcesses.values()) { try { proc.kill(); } catch {} }
  ptyProcesses.clear();
  for (const proc of claudeProcesses.values()) {
    try {
      if (process.platform === 'win32') {
        require('child_process').spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F']);
      } else {
        proc.kill('SIGTERM');
      }
    } catch {}
  }
  claudeProcesses.clear();
  for (const proc of geminiProcesses.values()) {
    try {
      if (process.platform === 'win32') {
        require('child_process').spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F']);
      } else {
        proc.kill('SIGTERM');
      }
    } catch {}
  }
  geminiProcesses.clear();
  for (const proc of codexProcesses.values()) {
    try {
      if (process.platform === 'win32') {
        require('child_process').spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F']);
      } else {
        proc.kill('SIGTERM');
      }
    } catch {}
  }
  codexProcesses.clear();
});

let shellsCache: { name: string; path: string; icon?: string }[] | null = null;
ipcMain.handle('pty:list-shells', async () => {
  if (shellsCache) return shellsCache;
  const shells: { name: string; path: string; icon?: string }[] = [];
  if (process.platform === 'win32') {
    shells.push({ name: 'Windows PowerShell', path: 'powershell.exe', icon: '⚡' });
    const pwshPaths = [
      path.join(process.env.ProgramFiles || '', 'PowerShell', '7', 'pwsh.exe'),
      path.join(process.env.ProgramFiles || '', 'PowerShell', '6', 'pwsh.exe'),
    ];
    for (const p of pwshPaths) {
      try { fs.accessSync(p); shells.push({ name: 'PowerShell Core', path: p, icon: '⚡' }); break; } catch {}
    }
    shells.push({ name: 'CMD', path: 'cmd.exe', icon: '▪' });
    const gitBashPaths = [
      path.join(process.env.ProgramFiles || '', 'Git', 'bin', 'bash.exe'),
      path.join(process.env['ProgramFiles(x86)'] || '', 'Git', 'bin', 'bash.exe'),
      'C:\\Program Files\\Git\\bin\\bash.exe',
    ];
    for (const p of gitBashPaths) {
      try { fs.accessSync(p); shells.push({ name: 'Git Bash', path: p, icon: '' }); break; } catch {}
    }
    try { fs.accessSync('C:\\Windows\\System32\\wsl.exe'); shells.push({ name: 'WSL', path: 'wsl.exe', icon: '🐧' }); } catch {}
  } else {
    const sh = process.env.SHELL || '/bin/bash';
    shells.push({ name: 'Default Shell', path: sh });
    if (sh !== '/bin/bash') try { fs.accessSync('/bin/bash'); shells.push({ name: 'Bash', path: '/bin/bash' }); } catch {}
    if (sh !== '/bin/zsh') try { fs.accessSync('/bin/zsh'); shells.push({ name: 'Zsh', path: '/bin/zsh' }); } catch {}
  }
  shellsCache = shells;
  return shells;
});

// node-pty 의 spawn-helper(macOS/Linux) 가 asar.unpacked 에 unpack 되었지만 실행권한이 빠질 수 있음 → 매 spawn 직전에 검사 + chmod.
function ensurePtyHelperExecutable() {
  if (process.platform === 'win32') return;
  try {
    let dir: string;
    try { dir = path.dirname(require.resolve('node-pty/package.json')); }
    catch { dir = path.join(__dirname, '..', 'node_modules', 'node-pty'); }
    dir = dir.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep).replace('app.asar/', 'app.asar.unpacked/');
    const helper = path.join(dir, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
    if (fs.existsSync(helper)) {
      const st = fs.statSync(helper);
      if (!(st.mode & 0o111)) { fs.chmodSync(helper, 0o755); console.log('[pty] chmod +x', helper); }
    } else {
      console.warn('[pty] spawn-helper not found at', helper);
    }
  } catch (e: any) { console.warn('[pty] chmod helper failed:', e?.message || e); }
}

// 셸 별 OSC 7 cwd hook 을 spawn 인자로 주입 — 사용자에게 echo 되지 않음.
// zsh 의 경우 임시 ZDOTDIR 를 만들어 두고, 호출 측에서 env.ZDOTDIR 로 주입해야 함 (zdotdir 필드 반환).
// WSL 등 인자로 주입 불가한 케이스는 postSpawnInject 로 첫 프롬프트 후 stdin 주입.
function buildShellLaunch(shellPath: string): { args: string[]; postSpawnInject?: string; zdotdir?: string; promptEnv?: string } {
  const lc = shellPath.toLowerCase();
  // PowerShell (Windows PowerShell 5.1 / pwsh 7+) — [char]27 사용해 호환
  // -Command 는 배너를 자동 억제하므로, 배너를 직접 Write-Host 로 출력 + OSC 7 hook 을 silently 설치.
  // 이 방식은 stdin 주입이 없어서 에코가 전혀 발생하지 않음.
  if (lc.includes('powershell') || lc.includes('pwsh')) {
    const banner = "if ($PSVersionTable.PSEdition -eq 'Desktop') { Write-Host 'Windows PowerShell'; Write-Host 'Copyright (C) Microsoft Corporation. All rights reserved.'; Write-Host ''; if ((Get-UICulture).Name -like 'ko*') { Write-Host '새로운 기능 및 개선 사항에 대 한 최신 PowerShell을 설치 하세요! https://aka.ms/PSWindows' } else { Write-Host 'Try the new cross-platform PowerShell https://aka.ms/pscore6' }; Write-Host '' } else { Write-Host ('PowerShell ' + $PSVersionTable.PSVersion); Write-Host '' }";
    const psHook = "if (-not $global:__pepePromptOrig) { $global:__pepePromptOrig = $function:prompt }; function global:prompt { [Console]::Write([char]27 + ']7;file:///' + ($PWD.Path -replace '\\\\','/') + [char]27 + '\\'); & $global:__pepePromptOrig }";
    return { args: ['-NoExit', '-Command', `${banner}; ${psHook}`] };
  }
  // cmd.exe — PROMPT 환경변수로 프롬프트 형식 설정. /K prompt 명령 방식은 명령 실행 후
  // 빈 줄(\r\n)이 생기므로 사용 안 함. 환경변수는 호출 측 spawnEnv 에서 직접 주입.
  if (lc.endsWith('cmd.exe') || lc.endsWith('\\cmd') || lc.endsWith('/cmd')) {
    return { args: [], promptEnv: '$E]7;file:///$P$E\\$P$G' };
  }
  // wsl.exe 진입은 인자로 inner shell init 주입 불가 → 첫 프롬프트 후 stdin 주입 fallback.
  if (lc.endsWith('wsl.exe') || lc.endsWith('\\wsl') || lc.endsWith('/wsl')) {
    const bashHook = " __pepe_osc7() { printf '\\e]7;file://localhost%s\\e\\\\' \"$PWD\"; }; PROMPT_COMMAND=\"__pepe_osc7${PROMPT_COMMAND:+;$PROMPT_COMMAND}\"";
    return { args: [], postSpawnInject: bashHook };
  }
  // bash (git bash / Linux / macOS) — --init-file 로 임시 rc 사용 (사용자 .bashrc 도 source).
  // 주의: --init-file 은 non-login interactive 에서만 ~/.bashrc 자리를 대체. -l 과 함께 쓰면 무시되므로 login 모드는 사용 안 함.
  if (lc.includes('bash') || lc.endsWith('/sh') || lc.endsWith('\\sh.exe')) {
    try {
      const tmpDir = os.tmpdir();
      const rcPath = path.join(tmpDir, `pepe-bashrc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sh`);
      const rcContent = [
        '# pepe-terminal: source user rc files first',
        '[ -f /etc/bash.bashrc ] && . /etc/bash.bashrc',
        '[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"',
        // macOS bash 사용자는 보통 ~/.bash_profile 만 두므로 그것도 시도
        '[ -f "$HOME/.bash_profile" ] && . "$HOME/.bash_profile"',
        '# pepe cwd auto-track (OSC 7)',
        "__pepe_osc7() { printf '\\e]7;file://localhost%s\\e\\\\' \"$PWD\"; }",
        'PROMPT_COMMAND="__pepe_osc7${PROMPT_COMMAND:+;$PROMPT_COMMAND}"',
      ].join('\n');
      fs.writeFileSync(rcPath, rcContent, 'utf8');
      return { args: ['--init-file', rcPath] };
    } catch {
      return { args: [] };
    }
  }
  // zsh — ZDOTDIR 를 임시 디렉토리로 바꿔 .zshrc 에 hook 주입. 호출 측에서 env.ZDOTDIR 설정 필수.
  if (lc.includes('zsh')) {
    try {
      const tmpDir = os.tmpdir();
      const dirPath = path.join(tmpDir, `pepe-zdotdir-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      fs.mkdirSync(dirPath, { recursive: true });
      const userZdotdir = process.env.ZDOTDIR || process.env.HOME || '';
      const rcContent = [
        '# pepe-terminal: source user .zshrc',
        userZdotdir ? `ZDOTDIR='${userZdotdir}' . '${userZdotdir}/.zshrc' 2>/dev/null` : '',
        '# pepe cwd auto-track (OSC 7)',
        "__pepe_osc7() { printf '\\e]7;file://localhost%s\\e\\\\' \"$PWD\"; }",
        'precmd_functions+=(__pepe_osc7)',
      ].filter(Boolean).join('\n');
      fs.writeFileSync(path.join(dirPath, '.zshrc'), rcContent, 'utf8');
      return { args: [], zdotdir: dirPath };
    } catch {
      return { args: [] };
    }
  }
  return { args: [] };
}

ipcMain.handle('pty:spawn', (_e, { panelId, shell: shellPath, cols, rows, cwd }: { panelId: string; shell?: string; cols?: number; rows?: number; cwd?: string }) => {
  if (ptyProcesses.has(panelId)) return 'already';
  ensurePtyHelperExecutable();
  // OS 별 기본 셸 결정. GUI 앱은 SHELL 환경변수 미설정인 경우가 있어 darwin 은 /bin/zsh, linux 는 /bin/bash 로 폴백.
  const isWin = process.platform === 'win32';
  const isDarwin = process.platform === 'darwin';
  let sh = shellPath;
  if (!sh) {
    if (isWin) sh = 'powershell.exe';
    else if (isDarwin) sh = process.env.SHELL || '/bin/zsh';
    else sh = process.env.SHELL || '/bin/bash';
  }
  // 셸별 OSC 7 hook 인자 — bash 는 --init-file, zsh 는 ZDOTDIR(env), powershell/cmd 는 -Command/-K, 기타는 빈 args
  const launch = buildShellLaunch(sh);
  const baseName = (sh.split('/').pop() || sh).toLowerCase();
  const isUnixShell = !isWin && /^(zsh|bash|sh|fish|ksh|dash)$/.test(baseName);
  const spawnEnv: Record<string, string> = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>;
  if (isUnixShell) spawnEnv.SHELL = sh;
  if (!spawnEnv.HOME && process.env.USERPROFILE) spawnEnv.HOME = process.env.USERPROFILE;
  // zsh 는 임시 ZDOTDIR 를 환경변수로 주입해야 OSC 7 hook 적용됨
  if (launch.zdotdir) spawnEnv.ZDOTDIR = launch.zdotdir;
  // cmd.exe: PROMPT 환경변수로 OSC 7 프롬프트 형식 설정 (/K prompt 명령 없이)
  if (launch.promptEnv) spawnEnv.PROMPT = launch.promptEnv;
  const spawnCwd = cwd || spawnEnv.HOME || process.env.HOME || process.env.USERPROFILE || (isWin ? 'C:\\' : '/');
  console.log('[pty:spawn]', { panelId, sh, args: launch.args, cwd: spawnCwd, hasShellEnv: !!process.env.SHELL });
  const trySpawn = (shellPath: string, shellArgs: string[]): pty.IPty | Error => {
    try {
      return pty.spawn(shellPath, shellArgs, {
        name: 'xterm-256color',
        cols: cols || 80,
        rows: rows || 24,
        cwd: spawnCwd,
        env: spawnEnv,
      });
    } catch (e: any) { return e; }
  };
  let proc = trySpawn(sh, launch.args);
  // ENOENT 등으로 실패 시 macOS/Linux 기본 셸로 재시도 (이때는 OSC 7 hook 없이라도 우선 살림)
  if (proc instanceof Error && !isWin) {
    console.warn('[pty:spawn] first attempt failed:', proc.message, '— falling back to /bin/zsh');
    const fbLaunch = buildShellLaunch('/bin/zsh');
    if (fbLaunch.zdotdir) spawnEnv.ZDOTDIR = fbLaunch.zdotdir;
    const fb = trySpawn('/bin/zsh', fbLaunch.args);
    if (!(fb instanceof Error)) proc = fb;
    else {
      const fb2Launch = buildShellLaunch('/bin/bash');
      const fb2 = trySpawn('/bin/bash', fb2Launch.args);
      if (!(fb2 instanceof Error)) proc = fb2;
    }
  }
  if (proc instanceof Error) {
    console.error('[pty:spawn] all attempts failed:', proc.message);
    mainWindow?.webContents.send('pty:data', { panelId, data: `\r\n[shell spawn 실패] ${proc.message}\r\n` });
    return 'error';
  }
  ptyProcesses.set(panelId, proc);
  proc.onData((data: string) => {
    mainWindow?.webContents.send('pty:data', { panelId, data });
  });
  proc.onExit(({ exitCode }: { exitCode: number }) => {
    ptyProcesses.delete(panelId);
    mainWindow?.webContents.send('pty:exit', { panelId, exitCode });
  });
  // wsl.exe 등 인자 주입 불가 셸: 첫 프롬프트 후 stdin 으로 hook 주입
  if (launch.postSpawnInject) {
    setTimeout(() => {
      try { proc.write(launch.postSpawnInject + '\r'); } catch {}
    }, 1500);
  }
  return 'ok';
});

ipcMain.on('pty:input', (_e, { panelId, data }: { panelId: string; data: string }) => {
  ptyProcesses.get(panelId)?.write(data);
});

const _lastPtyResize = new Map<string, { cols: number; rows: number }>();
ipcMain.on('pty:resize', (_e, { panelId, cols, rows }: { panelId: string; cols: number; rows: number }) => {
  if (!cols || !rows || !isFinite(cols) || !isFinite(rows) || cols < 1 || rows < 1) return;
  const last = _lastPtyResize.get(panelId);
  if (last && last.cols === cols && last.rows === rows) return;
  _lastPtyResize.set(panelId, { cols, rows });
  try { ptyProcesses.get(panelId)?.resize(cols, rows); } catch {}
});

ipcMain.on('pty:kill', (_e, { panelId }: { panelId: string }) => {
  const proc = ptyProcesses.get(panelId);
  if (proc) { proc.kill(); ptyProcesses.delete(panelId); }
});

// ── i18n ──
ipcMain.handle('i18n:list-languages', () => listLanguages());
ipcMain.handle('i18n:list-namespaces', (_e, { lang }: { lang: string }) => listNamespaces(lang));
ipcMain.handle('i18n:load', (_e, { lang, ns }: { lang: string; ns: string }) => loadNamespace(lang, ns));
ipcMain.handle('i18n:load-bundled', (_e, { lang, ns }: { lang: string; ns: string }) => loadBundledNamespace(lang, ns));
ipcMain.handle('i18n:load-override', (_e, { lang, ns }: { lang: string; ns: string }) => loadOverrideNamespace(lang, ns));
ipcMain.handle('i18n:save-override', (_e, { lang, ns, kv }: { lang: string; ns: string; kv: Record<string, string> }) => saveOverrideNamespace(lang, ns, kv));
ipcMain.handle('i18n:add-language', (_e, { lang }: { lang: string }) => addLanguage(lang));
ipcMain.handle('i18n:remove-language', (_e, { lang }: { lang: string }) => removeLanguage(lang));
ipcMain.handle('i18n:set-lang', (_e, { lang }: { lang: string }) => { setCurrentLang(lang); return { ok: true }; });
// AI 자동 번역 — Anthropic Claude API. ko 기준으로 target 언어로 번역. 빈 값/혹은 전체 강제 갱신.
// API 키 우선순위: 인자로 받은 키 > 환경변수 ANTHROPIC_API_KEY
ipcMain.handle('i18n:auto-translate', async (_e, { sourceLang, targetLang, items, apiKey }: { sourceLang: string; targetLang: string; items: Record<string, string>; apiKey?: string }) => {
  const key = (apiKey || process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) return { ok: false, error: 'ANTHROPIC_API_KEY 환경변수가 없거나 빈 값입니다 (또는 인자로 전달)' };
  const keys = Object.keys(items);
  if (keys.length === 0) return { ok: true, translations: {} };
  // 키-값 쌍 JSON 으로 만들어 Claude 에게 줌. {{var}} 자리표시자는 보존 요구.
  const prompt = `다음 ${sourceLang} 번역 키-값 JSON 을 ${targetLang} 로 번역해 주세요. 규칙:
- 출력은 정확히 같은 키를 갖는 JSON 객체 1개만 (설명/마크다운 코드블럭 없이 순수 JSON).
- 값만 ${targetLang} 로 번역. 키는 그대로.
- {{변수}} 같은 자리표시자는 변형 없이 그대로 유지.
- 이모지/특수문자는 유지.
- 짧고 자연스러운 UI 문구로.

입력 JSON:
${JSON.stringify(items, null, 2)}`;
  try {
    const resp = await (globalThis as any).fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      return { ok: false, error: `API ${resp.status}: ${errText.slice(0, 300)}` };
    }
    const data: any = await resp.json();
    const text: string = data?.content?.[0]?.text || '';
    // 응답이 마크다운 코드블럭 안에 있을 수도 있음 — 추출
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { ok: false, error: '응답에서 JSON 을 찾지 못함', raw: text.slice(0, 300) };
    let translations: Record<string, string>;
    try {
      translations = JSON.parse(match[0]);
    } catch (e: any) {
      return { ok: false, error: 'JSON 파싱 실패: ' + e.message, raw: match[0].slice(0, 300) };
    }
    return { ok: true, translations };
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) };
  }
});

// ── OpenVPN ──
const vpn = getVpnService();
const safeSend = (channel: string, payload: any) => {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const wc = mainWindow.webContents;
    if (!wc || wc.isDestroyed?.()) return;
    wc.send(channel, payload);
  } catch {}
};
vpn.on('state', (st: any) => safeSend('vpn:state', st));
vpn.on('log', (line: string) => safeSend('vpn:log', line));
// 앱 종료 시 VPN 정리 — management SIGTERM 보내서 elevated openvpn.exe 가 스스로 깔끔히 종료하도록
app.on('before-quit', () => {
  try { vpn.disconnect(); } catch {}
});

// 자격증명 영속화 — OS 안전 저장소(Windows DPAPI / macOS Keychain) 로 암호화 후 JSON 저장.
// 파일: <userData>/vpn-credentials.json. Key = config 절대경로, Value = base64(encrypted).
function vpnCredsFile(): string { return path.join(app.getPath('userData'), 'vpn-credentials.json'); }
// 진단 로그 — renderer DevTools console 에 [main] 프리픽스로 표시됨
function credsLog(msg: string) {
  console.log('[vpn-creds]', msg);
  try { mainWindow?.webContents.send('debug:log', `[vpn-creds] ${msg}`); } catch {}
}
function loadCredsMap(): Record<string, string> {
  try {
    const p = vpnCredsFile();
    if (!fs.existsSync(p)) { credsLog(`loadCredsMap: 파일 없음 (${p})`); return {}; }
    const raw = fs.readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw) || {};
    credsLog(`loadCredsMap: ${p} (${Object.keys(parsed).length}개 항목, 파일 ${raw.length}바이트)`);
    return parsed;
  } catch (err: any) {
    credsLog(`loadCredsMap 실패: ${err?.message || err}`);
    return {};
  }
}
function saveCredsMap(m: Record<string, string>) {
  const p = vpnCredsFile();
  try {
    const text = JSON.stringify(m, null, 2);
    fs.writeFileSync(p, text, { mode: 0o600 });
    const exists = fs.existsSync(p);
    const size = exists ? fs.statSync(p).size : -1;
    credsLog(`saveCredsMap: ${p} (${text.length}바이트 쓰기 시도, 실제 ${size}바이트, exists=${exists})`);
  } catch (err: any) {
    credsLog(`saveCredsMap 실패: ${err?.message || err}`);
  }
}
ipcMain.handle('vpn:save-creds', (_e, { configPath, username, password }: { configPath: string; username: string; password: string }) => {
  const avail = safeStorage.isEncryptionAvailable();
  credsLog(`save 요청: configPath="${configPath}", user="${username}", pw길이=${password?.length || 0}, isEncryptionAvailable=${avail}`);
  if (!avail) return { ok: false, error: 'OS 안전 저장소 사용 불가 (저장 안 됨)' };
  try {
    const plain = JSON.stringify({ username, password });
    const encBuf = safeStorage.encryptString(plain);
    const enc = encBuf.toString('base64');
    credsLog(`encryptString OK (평문 ${plain.length}바이트 → 암호 ${encBuf.length}바이트, base64 ${enc.length}바이트)`);
    const m = loadCredsMap();
    m[configPath] = enc;
    saveCredsMap(m);
    // 즉시 검증 — write 직후 다시 읽어서 항목 존재 확인
    const verify = loadCredsMap();
    const verifyOk = !!verify[configPath];
    credsLog(`save 검증: 다시 읽었을 때 해당 키 존재=${verifyOk}`);
    return { ok: true };
  } catch (err: any) {
    credsLog(`save 실패: ${err?.message || err}`);
    return { ok: false, error: String(err?.message || err) };
  }
});
ipcMain.handle('vpn:load-creds', (_e, { configPath }: { configPath: string }) => {
  credsLog(`load 요청: configPath="${configPath}"`);
  try {
    const m = loadCredsMap();
    const enc = m[configPath];
    if (!enc) {
      credsLog(`load: 키 없음 (저장된 키: ${Object.keys(m).join(', ') || '없음'})`);
      return { ok: false };
    }
    credsLog(`load: 암호화 데이터 발견 (base64 ${enc.length}바이트), decryptString 시도`);
    const buf = Buffer.from(enc, 'base64');
    const dec = safeStorage.decryptString(buf);
    const parsed = JSON.parse(dec);
    credsLog(`load 성공: user="${parsed.username}", pw길이=${parsed.password?.length || 0}`);
    return { ok: true, username: parsed.username || '', password: parsed.password || '' };
  } catch (err: any) {
    credsLog(`load 실패: ${err?.message || err}`);
    return { ok: false, error: String(err?.message || err) };
  }
});
ipcMain.handle('vpn:clear-creds', (_e, { configPath }: { configPath: string }) => {
  credsLog(`clear 요청: configPath="${configPath}"`);
  try {
    const m = loadCredsMap();
    delete m[configPath];
    saveCredsMap(m);
    return { ok: true };
  } catch (err: any) { return { ok: false, error: String(err?.message || err) }; }
});
ipcMain.handle('vpn:has-creds', (_e, { configPath }: { configPath: string }) => {
  const m = loadCredsMap();
  const has = !!m[configPath];
  credsLog(`has 요청: configPath="${configPath}" → ${has}`);
  return { has };
});
ipcMain.handle('vpn:available', () => vpn.isAvailable());
ipcMain.handle('vpn:state', () => vpn.getState());
ipcMain.handle('vpn:logs', () => vpn.getLogs());
ipcMain.handle('vpn:list-configs', () => vpn.listConfigs());
ipcMain.handle('vpn:import-config', async (_e, { srcPath }: { srcPath?: string }) => {
  if (!srcPath) {
    const r = await dialog.showOpenDialog(mainWindow!, {
      title: t('dialog.vpnImportTitle'),
      filters: [{ name: 'OpenVPN config', extensions: ['ovpn'] }, { name: 'All Files', extensions: ['*'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
    srcPath = r.filePaths[0];
  }
  return vpn.importConfig(srcPath);
});
ipcMain.handle('vpn:remove-config', (_e, { filePath }: { filePath: string }) => ({ ok: vpn.removeConfig(filePath) }));
ipcMain.handle('vpn:connect', (_e, { configPath, username, password }: { configPath: string; username?: string; password?: string }) =>
  vpn.connect(configPath, { username, password }));
ipcMain.handle('vpn:disconnect', () => vpn.disconnect());

// ── 터미널 녹화 (REC) ──
// 렌더러는 term.write() 직전에 tap 을 걸어 raw 바이트와 사용자 입력을 IPC 로 흘려보내고,
// main 은 단순히 WriteStream 으로 append. flush 는 OS 가 알아서 하지만 추가 보호로 매 라인
// 결정마다 fsyncSync 는 하지 않는다 (성능 이슈). 앱 종료/세션 닫기 시 stop 호출 보장 필요.
const recordingStreams: Map<string, { stream: fs.WriteStream; path: string; startedAt: number }> = new Map();
function recPickFilePath(suggested: string): string | null {
  if (!mainWindow) return null;
  const res = dialog.showSaveDialogSync(mainWindow, {
    title: t('dialog.recordingSaveTitle'),
    defaultPath: suggested,
    filters: [{ name: 'Recording Log (ANSI)', extensions: ['log'] }, { name: 'All Files', extensions: ['*'] }],
  });
  return res || null;
}
ipcMain.handle('rec:start', async (_e, { panelId, sessionName }: { panelId: string; sessionName?: string }) => {
  if (recordingStreams.has(panelId)) return { ok: false, reason: 'already-recording' };
  const ts = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
  const safeName = (sessionName || 'terminal').replace(/[\\/:*?"<>|]/g, '_');
  const suggested = path.join(app.getPath('documents') || os.homedir(), `pepe-${safeName}-${stamp}.log`);
  const target = recPickFilePath(suggested);
  if (!target) return { ok: false, reason: 'cancelled' };
  try {
    const stream = fs.createWriteStream(target, { flags: 'a' });
    stream.on('error', (err) => {
      try { mainWindow?.webContents.send('rec:error', { panelId, message: String(err?.message || err) }); } catch {}
    });
    const header = `\r\n--- recording started at ${ts.toLocaleString()} (${path.basename(target)}) ---\r\n`;
    stream.write(header);
    recordingStreams.set(panelId, { stream, path: target, startedAt: Date.now() });
    return { ok: true, path: target };
  } catch (err: any) {
    return { ok: false, reason: 'open-failed', message: String(err?.message || err) };
  }
});
// ANSI escape / control sequence stripper — 녹화 파일이 화면과 동일한 plain text 로 보이도록.
// CSI (\x1b[...), OSC (\x1b]...\x07 or \x1b\\), 단일 ESC 시퀀스, 기타 제어문자 (carriage return 제외) 제거.
function stripAnsi(s: string): string {
  if (!s) return s;
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC
    .replace(/\x1b[@-Z\\-_]/g, '')                       // single-char ESC seq
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')             // CSI
    .replace(/\x1b\([AB012]/g, '');                      // charset designator
}
ipcMain.on('rec:append', (_e, { panelId, data, kind }: { panelId: string; data: string; kind?: 'out' | 'in' | 'mark' }) => {
  const rec = recordingStreams.get(panelId);
  if (!rec) return;
  try {
    // 입력은 별도 기록 안 함 — 셸이 echo 한 문자가 'out' 으로 이미 들어옴 (중복/마커 노이즈 방지)
    if (kind === 'in') return;
    if (kind === 'mark') rec.stream.write(`\r\n--- ${stripAnsi(data)} ---\r\n`);
    else rec.stream.write(stripAnsi(data));
  } catch {}
});
ipcMain.handle('rec:stop', async (_e, { panelId }: { panelId: string }) => {
  const rec = recordingStreams.get(panelId);
  if (!rec) return { ok: false, reason: 'not-recording' };
  recordingStreams.delete(panelId);
  try {
    const footer = `\r\n--- recording stopped at ${new Date().toLocaleString()} ---\r\n`;
    await new Promise<void>(resolve => rec.stream.write(footer, () => resolve()));
    await new Promise<void>(resolve => rec.stream.end(() => resolve()));
    return { ok: true, path: rec.path };
  } catch (err: any) {
    return { ok: false, message: String(err?.message || err) };
  }
});
ipcMain.handle('rec:status', (_e, { panelId }: { panelId?: string }) => {
  if (panelId) {
    const r = recordingStreams.get(panelId);
    return r ? { recording: true, path: r.path, startedAt: r.startedAt } : { recording: false };
  }
  return { panels: Array.from(recordingStreams.keys()) };
});
ipcMain.handle('rec:list-active', () => Array.from(recordingStreams.keys()));
// 앱 종료 시 모든 stream flush — 사용자가 모달에서 "종료" 선택했을 때 데이터 유실 방지
app.on('before-quit', () => {
  for (const [, rec] of recordingStreams) {
    try { rec.stream.write(`\r\n--- recording interrupted (app quit) ---\r\n`); rec.stream.end(); } catch {}
  }
  recordingStreams.clear();
});

// ── Claude Code CLI 연동 ──
const claudeProcesses: Map<string, any> = new Map();

// ── Gemini CLI 연동 ──
const geminiProcesses: Map<string, any> = new Map();

// ── Codex CLI 연동 ──
const codexProcesses: Map<string, any> = new Map();

// GUI .app 실행 환경의 minimal PATH 보강 — npm global bin / Homebrew / nvm 경로 추가.
// claude:send 와 claude:check 양쪽에서 사용. nvm 은 versions/node/* glob 으로 모든 버전 bin 포함.
// nvm alias 체인 resolve → 활성 버전의 bin 경로 반환
function resolveNvmActiveBin(nvmDir: string): string | null {
  try {
    const aliasFile = path.join(nvmDir, 'alias', 'default');
    if (!fs.existsSync(aliasFile)) return null;
    let cur = fs.readFileSync(aliasFile, 'utf-8').trim();
    for (let i = 0; i < 5; i++) {
      if (cur.startsWith('v')) {
        const binPath = path.join(nvmDir, 'versions', 'node', cur, 'bin');
        return fs.existsSync(binPath) ? binPath : null;
      }
      const next = path.join(nvmDir, 'alias', cur);
      if (!fs.existsSync(next)) break;
      cur = fs.readFileSync(next, 'utf-8').trim();
    }
  } catch {}
  return null;
}

function buildAugmentedPath(): string {
  const isWin = process.platform === 'win32';
  const extraPaths: string[] = [];
  if (isWin) {
    if (process.env.APPDATA) extraPaths.push(path.join(process.env.APPDATA, 'npm'));
    if (process.env.USERPROFILE) extraPaths.push(path.join(process.env.USERPROFILE, 'AppData', 'Roaming', 'npm'));
    if (process.env.ProgramFiles) extraPaths.push(path.join(process.env.ProgramFiles, 'nodejs'));
  } else {
    const home = os.homedir();
    extraPaths.push('/usr/local/bin', '/opt/homebrew/bin', path.join(home, '.npm-global', 'bin'), path.join(home, '.volta', 'bin'));
    // nvm — alias/default 체인으로 활성 버전 bin 먼저, 나머지 버전도 폴백으로 추가
    try {
      const nvmDir = path.join(home, '.nvm');
      const activeBin = resolveNvmActiveBin(nvmDir);
      if (activeBin) extraPaths.unshift(activeBin); // 활성 버전 최우선
      const nvmRoot = path.join(nvmDir, 'versions', 'node');
      if (fs.existsSync(nvmRoot)) {
        for (const v of fs.readdirSync(nvmRoot).filter((v: string) => v.startsWith('v'))) {
          const p = path.join(nvmRoot, v, 'bin');
          if (p !== activeBin) extraPaths.push(p);
        }
      }
    } catch {}
    // fnm — ~/.local/share/fnm/node-versions/<ver>/installation/bin
    try {
      const fnmRoot = path.join(home, '.local', 'share', 'fnm', 'node-versions');
      if (fs.existsSync(fnmRoot)) {
        for (const v of fs.readdirSync(fnmRoot).filter((v: string) => v.startsWith('v'))) {
          extraPaths.push(path.join(fnmRoot, v, 'installation', 'bin'));
        }
      }
    } catch {}
    // n (node version manager) — /usr/local/lib/node_modules/.bin
    extraPaths.push('/usr/local/lib/node_modules/.bin');
    // Homebrew prefix (Apple Silicon vs Intel)
    extraPaths.push('/opt/homebrew/bin', '/usr/local/bin');
  }
  const sep = isWin ? ';' : ':';
  return [process.env.PATH || '', ...extraPaths].filter(Boolean).join(sep);
}

// Git 상태 조회 — 로컬 cwd 또는 SSH 세션에서 branch + diff stats 추출
ipcMain.handle('git:status', async (_e, { mode, termId, cwd }: { mode: 'local' | 'remote'; termId?: string; cwd?: string }) => {
  try {
    if (mode === 'remote' && termId) {
      const bridge = getSSHBridge();
      if (typeof bridge.execCommand !== 'function') return { ok: false, error: 'ssh exec 미지원' };
      // 원격 cwd 가 있으면 그 디렉토리에서 실행, 없으면 현재 셸 cwd. (cd 실패 시 즉시 NOTREPO)
      const cdPart = cwd ? `cd '${cwd.replace(/'/g, "'\\''")}' && ` : '';
      const script = `(${cdPart}git rev-parse --is-inside-work-tree 2>/dev/null && echo "---BR---" && git rev-parse --abbrev-ref HEAD 2>/dev/null && echo "---ST---" && git diff --shortstat HEAD 2>/dev/null) || echo "NOTREPO"`;
      try {
        const out: string = await bridge.execCommand(termId, script);
        if (!out || /NOTREPO/.test(out)) return { ok: false, notRepo: true };
        const parts = out.split('---BR---');
        if (parts.length < 2) return { ok: false, notRepo: true };
        const rest = parts[1].split('---ST---');
        const branch = (rest[0] || '').trim();
        const statLine = (rest[1] || '').trim();
        const insMatch = statLine.match(/(\d+)\s+insertion/);
        const delMatch = statLine.match(/(\d+)\s+deletion/);
        return { ok: true, branch, additions: insMatch ? parseInt(insMatch[1], 10) : 0, deletions: delMatch ? parseInt(delMatch[1], 10) : 0 };
      } catch (e: any) {
        return { ok: false, error: String(e?.message || e) };
      }
    } else {
      // local
      const { execFileSync } = require('child_process');
      const opts: any = { cwd: cwd || process.cwd(), encoding: 'utf-8', windowsHide: true, timeout: 3000 };
      try {
        execFileSync('git', ['rev-parse', '--is-inside-work-tree'], opts);
      } catch { return { ok: false, notRepo: true }; }
      let branch = '';
      let stat = '';
      try { branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], opts).trim(); } catch {}
      try { stat = execFileSync('git', ['diff', '--shortstat', 'HEAD'], opts).trim(); } catch {}
      const insMatch = stat.match(/(\d+)\s+insertion/);
      const delMatch = stat.match(/(\d+)\s+deletion/);
      return { ok: true, branch, additions: insMatch ? parseInt(insMatch[1], 10) : 0, deletions: delMatch ? parseInt(delMatch[1], 10) : 0 };
    }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('claude:check', async () => {
  try {
    const { spawn } = require('child_process');
    const augmentedPath = buildAugmentedPath();
    const env = { ...process.env, PATH: augmentedPath, Path: augmentedPath };
    return await new Promise<{ installed: boolean; version?: string }>(resolve => {
      const proc = spawn('claude', ['--version'], { shell: true, env });
      let output = '';
      proc.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
      proc.on('error', () => resolve({ installed: false }));
      proc.on('close', (code: number) => {
        if (code === 0) resolve({ installed: true, version: output.trim() });
        else resolve({ installed: false });
      });
    });
  } catch {
    return { installed: false };
  }
});

// ── MCP/Hook 공용 Control TCP 서버 ──
let mcpControlPort = 0;
let mcpControlToken = '';
// hook-approve pending: 렌더러로 요청 보내고 응답 받아올 때까지 sock 보관
const pendingApprovals = new Map<string, { sock: any; reqId: any }>();
(globalThis as any).__pepePendingApprovals = pendingApprovals;

const startMcpControl = async (): Promise<void> => {
  if (mcpControlPort) return;
  const net = require('net');
  const crypto = require('crypto');
  mcpControlToken = crypto.randomBytes(16).toString('hex');
  await new Promise<void>((resolve) => {
    const srv = net.createServer((sock: any) => {
      let buf = '';
      sock.on('data', (d: Buffer) => {
        buf += d.toString('utf-8');
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (!line.trim()) continue;
          (async () => {
            try {
              const req = JSON.parse(line);
              if (req.token !== mcpControlToken) {
                sock.write(JSON.stringify({ id: req.id, error: 'invalid token' }) + '\n');
                return;
              }
              if (req.op === 'exec') {
                const bridge = getSSHBridge();
                const result = await bridge.handleExec(req.termId, req.command, req.timeoutMs || 60000);
                sock.write(JSON.stringify({ id: req.id, result }) + '\n');
              } else if (req.op === 'hook-approve') {
                // 승인 요청을 렌더러로 전달. 응답은 ipcMain.handle('claude:hook-respond') 에서 처리
                const approvalId = `app-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                pendingApprovals.set(approvalId, { sock, reqId: req.id });
                mainWindow?.webContents.send('claude:hook-approval-request', {
                  approvalId,
                  toolName: req.toolName,
                  toolInput: req.toolInput,
                  sessionId: req.sessionId,
                });
              } else {
                sock.write(JSON.stringify({ id: req.id, error: 'unknown op' }) + '\n');
              }
            } catch (err: any) {
              try { sock.write(JSON.stringify({ id: null, error: String(err) }) + '\n'); } catch {}
            }
          })();
        }
      });
      sock.on('error', () => {});
    });
    srv.listen(0, '127.0.0.1', () => {
      mcpControlPort = srv.address().port;
      console.log(`[mcp-control] listening on 127.0.0.1:${mcpControlPort}`);
      resolve();
    });
  });
};

// 렌더러에서 승인/거부 결과 수신
ipcMain.handle('claude:hook-respond', (_e, { approvalId, decision, reason }: { approvalId: string; decision: 'allow' | 'deny'; reason?: string }) => {
  const pending = pendingApprovals.get(approvalId);
  if (!pending) return { success: false, error: 'no pending approval' };
  pendingApprovals.delete(approvalId);
  try {
    pending.sock.write(JSON.stringify({ id: pending.reqId, result: decision, reason: reason || '' }) + '\n');
  } catch {}
  return { success: true };
});

// ── WebDAV 브리지: 원격 SSH 를 로컬 UNC 경로로 마운트 ──
let webdavBridge: any = null;
const getWebDAVBridge = () => {
  if (!webdavBridge) {
    webdavBridge = createWebDAVBridge(getSSHBridge());
  }
  return webdavBridge;
};

ipcMain.handle('claude:register-mount', async (_e, { panelId, sessionLabel }: { panelId: string; sessionLabel: string }) => {
  try {
    const bridge = getWebDAVBridge();
    await bridge.ensureStarted();
    bridge.registerSession(panelId, sessionLabel);
    return { success: true, mountRoot: bridge.getMountRoot(panelId), port: bridge.getPort() };
  } catch (err: any) {
    console.error('[claude:register-mount] error:', err);
    return { success: false, error: String(err) };
  }
});

ipcMain.handle('claude:unregister-mount', async (_e, { panelId }: { panelId: string }) => {
  try {
    if (webdavBridge) webdavBridge.unregisterSession(panelId);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: String(err) };
  }
});

ipcMain.handle('claude:get-mount-path', async (_e, { panelId, remotePath }: { panelId: string; remotePath: string }) => {
  try {
    const bridge = getWebDAVBridge();
    if (!bridge.hasSession(panelId)) return { success: false, error: '세션이 등록되지 않음' };
    return { success: true, uncPath: bridge.toUncPath(panelId, remotePath), httpUrl: bridge.toHttpUrl(panelId, remotePath) };
  } catch (err: any) {
    return { success: false, error: String(err) };
  }
});

// claude CLI 실행 + 스트리밍 응답 (print 모드)
ipcMain.handle('claude:send', async (_e, { sessionId, prompt, addDirs, disallowBash, sshTermId, resumeSessionId, permissionMode, model, perToolApproval, requestId, effort }: { sessionId: string; prompt: string; addDirs?: string[]; disallowBash?: boolean; sshTermId?: string; resumeSessionId?: string | null; permissionMode?: string; model?: string; perToolApproval?: boolean; requestId?: string; effort?: string }) => {
  try {
    const { spawn } = require('child_process');
    // requestId 가 있으면 그걸 프로세스 키로 사용 — 동일 sessionId 안에서 여러 대화가 동시에 진행될 수 있음.
    // (이전 동작: sessionId 만 키 → 새 send 때마다 이전 프로세스 강제종료 → 백그라운드 대화 죽음)
    const procKey = requestId || sessionId;
    const os = require('os');
    const path = require('path');
    const fs = require('fs');
    console.log('[claude] spawn start, prompt length:', prompt.length);

    const isWin = process.platform === 'win32';

    // 긴 프롬프트는 임시 파일로 → shell 파이프로 stdin 주입 (Windows .cmd 스크립트에서 node spawn stdin 이 안먹히는 문제 회피)
    const tmpFile = path.join(os.tmpdir(), `claude-prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
    fs.writeFileSync(tmpFile, prompt, 'utf-8');

    // npm global bin 을 PATH 에 보강 (Electron 실행 환경에서 누락될 수 있음). claude:check 와 동일 helper.
    const augmentedPath = buildAugmentedPath();
    const spawnEnv = {
      ...process.env,
      PATH: augmentedPath,
      Path: augmentedPath,
      // UTF-8 강제 (한글 깨짐 방지)
      PYTHONIOENCODING: 'utf-8',
      LANG: process.env.LANG || 'en_US.UTF-8',
      LC_ALL: process.env.LC_ALL || 'en_US.UTF-8',
    };

    // --add-dir 옵션으로 스테이징된 디렉토리를 작업 범위에 추가
    const addDirArgs = (addDirs && addDirs.length > 0)
      ? addDirs.map(d => `--add-dir "${d.replace(/"/g, '\\"')}"`).join(' ')
      : '';
    console.log('[claude] addDirs:', addDirs);

    // 권한 모드: bypassPermissions=모두허용 / acceptEdits=편집만자동 / plan=계획만 / default=요청시
    // -p (print) 모드는 인터랙티브 불가 → 대부분 bypassPermissions 가 안전
    let permFlag: string;
    if (permissionMode === 'plan') permFlag = '--permission-mode plan';
    else if (permissionMode === 'acceptEdits') permFlag = '--permission-mode acceptEdits';
    else if (permissionMode === 'default') permFlag = '--permission-mode default';
    else permFlag = '--dangerously-skip-permissions'; // bypassPermissions (기본)
    // MCP 서버 설정 (원격 SSH 명령 실행용) — sshTermId 가 있을 때만 활성화
    let mcpConfigArg = '';
    let mcpCfgTmp = '';
    let mcpLogPath = '';
    if (sshTermId) {
      await startMcpControl();
      // 임베드된 스크립트를 임시 파일로 추출 (dev/prod 모두 작동)
      const mcpScriptPath = path.join(os.tmpdir(), 'pepe-mcp-ssh-server.cjs');
      try {
        const existing = fs.existsSync(mcpScriptPath) ? fs.readFileSync(mcpScriptPath, 'utf-8') : '';
        if (existing !== mcpSshServerScript) {
          fs.writeFileSync(mcpScriptPath, mcpSshServerScript, 'utf-8');
        }
      } catch (err) {
        console.error('[claude] MCP script extract failed:', err);
      }
      mcpLogPath = path.join(os.tmpdir(), `pepe-mcp-${Date.now()}.log`);
      const mcpCfg = {
        mcpServers: {
          pepe_ssh: {
            command: process.execPath,
            args: [mcpScriptPath],
            env: {
              PEPE_CTRL_PORT: String(mcpControlPort),
              PEPE_CTRL_TOKEN: mcpControlToken,
              PEPE_TERM_ID: sshTermId,
              PEPE_LOG_PATH: mcpLogPath,
              ELECTRON_RUN_AS_NODE: '1',
            },
          },
        },
      };
      mcpCfgTmp = path.join(os.tmpdir(), `claude-mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
      fs.writeFileSync(mcpCfgTmp, JSON.stringify(mcpCfg), 'utf-8');
      mcpConfigArg = `--mcp-config "${mcpCfgTmp}"`;
      console.log('[claude] MCP config written:', mcpCfgTmp, 'termId:', sshTermId, 'scriptExists:', fs.existsSync(mcpScriptPath), 'path:', mcpScriptPath);
    }

    // SSH 컨텍스트: 로컬 Bash 금지 (Unix 경로 접근 불가) — Read/Edit/Grep/Glob/LS + MCP ssh_exec 허용
    // 파일 편집은 WebDAV UNC 경로로 Edit/Write → SFTP 프록시로 원격 반영
    // 원격 명령 실행은 mcp__pepe_ssh__ssh_exec (MCP 서버 경유)
    const mcpToolAllow = sshTermId ? `"mcp__pepe_ssh__ssh_exec"` : '';
    const allowedFlag = disallowBash
      ? `--allowedTools "Read" "Edit" "Write" "Glob" "Grep" "LS" ${mcpToolAllow} "WebFetch" "WebSearch"`
      : '';
    // 사용자 인터랙션 도구는 비대화형 모드에서 무용지물 (ToolSearch 로 동적 로드 시도까지 차단)
    // SSH 컨텍스트면 Bash 도 명시적으로 차단 (allowedTools 만으론 일부 빌드에서 빠져나가는 케이스 방지)
    const sshDisallow = disallowBash ? `"Bash"` : '';
    const disallowedFlag = `--disallowedTools "AskUserQuestion" "ToolSearch" ${sshDisallow}`;

    // 이전 대화 세션 이어가기 (--resume <session_id>)
    const resumeFlag = resumeSessionId ? `--resume "${resumeSessionId}"` : '';
    console.log('[claude] resume:', resumeSessionId || '(new)');

    // 모델 선택 (--model)
    const modelFlag = (model && model !== 'default') ? `--model ${model}` : '';
    const effortFlag = (effort && ['low', 'medium', 'high', 'max'].includes(effort)) ? `--effort ${effort}` : '';
    console.log('[claude] model:', model || 'default');

    // 툴 단위 승인 (hooks) — perToolApproval true 일 때만 활성화
    let settingsFlag = '';
    let settingsTmp = '';
    let hookScriptPath = '';
    if (perToolApproval) {
      await startMcpControl();
      hookScriptPath = path.join(os.tmpdir(), 'pepe-claude-hook.cjs');
      try {
        const existing = fs.existsSync(hookScriptPath) ? fs.readFileSync(hookScriptPath, 'utf-8') : '';
        if (existing !== claudeHookScript) fs.writeFileSync(hookScriptPath, claudeHookScript, 'utf-8');
      } catch (err) { console.error('[claude] hook script extract failed:', err); }
      // 환경변수를 hook 프로세스에 전달 (settings 에서 직접 env 주입 불가하므로 래퍼 배치 사용)
      const wrapperPath = path.join(os.tmpdir(), 'pepe-claude-hook-wrap.cmd');
      const wrapperContent = `@echo off\r\nset "ELECTRON_RUN_AS_NODE=1"\r\nset "PEPE_CTRL_PORT=${mcpControlPort}"\r\nset "PEPE_CTRL_TOKEN=${mcpControlToken}"\r\n"${process.execPath}" "${hookScriptPath}"\r\n`;
      try { fs.writeFileSync(wrapperPath, wrapperContent, 'utf-8'); } catch (err) { console.error('[claude] hook wrapper write failed:', err); }

      const settings = {
        hooks: {
          PreToolUse: [{
            matcher: 'Bash|Edit|Write|Create|Delete|Move|Rename|mcp__.*',
            hooks: [{
              type: 'command',
              command: isWin ? `"${wrapperPath}"` : `node "${hookScriptPath}"`,
            }],
          }],
        },
      };
      settingsTmp = path.join(os.tmpdir(), `claude-settings-${Date.now()}.json`);
      fs.writeFileSync(settingsTmp, JSON.stringify(settings, null, 2), 'utf-8');
      settingsFlag = `--settings "${settingsTmp}"`;
      console.log('[claude] per-tool approval enabled. settings:', settingsTmp);
    }

    // shell 커맨드로 파이프 구성 (claude 는 PATHEXT 로 .cmd 자동 해석)
    // Windows: chcp 65001 로 UTF-8 코드페이지 전환 (한글 깨짐 방지)
    const shellCmd = isWin
      ? `chcp 65001 >nul && type "${tmpFile}" | claude -p ${resumeFlag} ${modelFlag} ${effortFlag} ${permFlag} ${allowedFlag} ${disallowedFlag} ${settingsFlag} ${mcpConfigArg} ${addDirArgs} --output-format stream-json --verbose`
      : `cat "${tmpFile}" | claude -p ${resumeFlag} ${modelFlag} ${effortFlag} ${permFlag} ${allowedFlag} ${disallowedFlag} ${settingsFlag} ${mcpConfigArg} ${addDirArgs} --output-format stream-json --verbose`;
    console.log('[claude] shell cmd:', shellCmd);
    console.log('[claude] PATH has npm:', augmentedPath.toLowerCase().includes('npm'));

    // claude 프로세스 cwd — Electron 앱 폴더가 기본인데 그러면 Claude 가 이 앱을 분석 대상으로 오해.
    // 사용자 홈으로 시작 (사용자 의도 상 작업 대상은 --add-dir 또는 SSH mount 로 명시됨)
    const claudeCwd = process.env.USERPROFILE || process.env.HOME || os.homedir();
    const proc = spawn(shellCmd, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: spawnEnv, cwd: claudeCwd });
    claudeProcesses.set(procKey, proc);

    // 임시 파일 정리 (프로세스 종료 후)
    const cleanupTmp = () => {
      try { fs.unlinkSync(tmpFile); } catch {}
      if (mcpCfgTmp) { try { fs.unlinkSync(mcpCfgTmp); } catch {} }
      if (settingsTmp) { try { fs.unlinkSync(settingsTmp); } catch {} }
    };

    let stdoutBuf = '';
    proc.stdout.setEncoding('utf-8');
    proc.stdout.on('data', (data: string) => {
      stdoutBuf += data;
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() || ''; // 마지막 불완전 라인은 보류
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        console.log('[claude] stdout line:', trimmed.slice(0, 200));
        try {
          const msg = JSON.parse(trimmed);
          mainWindow?.webContents.send('claude:stream', { sessionId, requestId, message: msg });
        } catch {
          mainWindow?.webContents.send('claude:stream', { sessionId, requestId, message: { type: 'text', text: trimmed } });
        }
      }
    });
    proc.stderr.on('data', (data: Buffer) => {
      const err = data.toString();
      console.log('[claude] stderr:', err);
      mainWindow?.webContents.send('claude:stream', { sessionId, requestId, message: { type: 'error', text: err } });
    });
    proc.on('error', (err: any) => {
      console.log('[claude] spawn error:', err);
      mainWindow?.webContents.send('claude:stream', { sessionId, requestId, message: { type: 'error', text: String(err) } });
    });
    proc.on('close', (code: number) => {
      console.log('[claude] close, code:', code);
      cleanupTmp();
      claudeProcesses.delete(procKey);
      mainWindow?.webContents.send('claude:stream', { sessionId, requestId, message: { type: 'done', code } });
    });
    return { success: true };
  } catch (err: any) {
    console.log('[claude] exception:', err);
    return { success: false, error: String(err) };
  }
});

// claude 설정 읽기 (model 변형으로 컨텍스트 max 추론 — opus[1m] 등)
ipcMain.handle('claude:read-settings', async () => {
  const fs = require('fs');
  const pathMod = require('path');
  const os = require('os');
  try {
    const p = pathMod.join(os.homedir(), '.claude', 'settings.json');
    const obj = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return { success: true, settings: obj };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});

// Anthropic 모델 목록 조회 — /v1/models
ipcMain.handle('claude:fetch-models', async () => {
  const fs = require('fs');
  const pathMod = require('path');
  const os = require('os');
  const credPath = pathMod.join(os.homedir(), '.claude', '.credentials.json');
  let token: string | null = null;
  try {
    const raw = fs.readFileSync(credPath, 'utf-8');
    const obj = JSON.parse(raw);
    token = obj?.claudeAiOauth?.accessToken;
  } catch {}
  if (!token) return { success: false, error: 'no token' };
  try {
    const fetchFn: any = (global as any).fetch;
    const resp = await fetchFn('https://api.anthropic.com/v1/models', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });
    const text = await resp.text();
    if (!resp.ok) return { success: false, error: `HTTP ${resp.status}`, body: text.slice(0, 300) };
    const data = JSON.parse(text);
    return { success: true, models: data.data || [] };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});

// Anthropic OAuth API 직접 호출 — ~/.claude/.credentials.json 의 accessToken 사용
ipcMain.handle('claude:fetch-usage-api', async () => {
  const fs = require('fs');
  const pathMod = require('path');
  const os = require('os');
  const credPath = pathMod.join(os.homedir(), '.claude', '.credentials.json');
  let token: string | null = null;
  try {
    const raw = fs.readFileSync(credPath, 'utf-8');
    const obj = JSON.parse(raw);
    token = obj?.claudeAiOauth?.accessToken;
  } catch (e: any) {
    return { success: false, error: 'credentials 읽기 실패: ' + e?.message };
  }
  if (!token) return { success: false, error: 'accessToken 없음 (claude login 필요)' };
  try {
    const fetchFn: any = (global as any).fetch;
    if (!fetchFn) return { success: false, error: 'fetch 미지원 (Node 18+ 필요)' };
    const resp = await fetchFn('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'claude-code/oauth',
      },
    });
    const status = resp.status;
    const text = await resp.text();
    if (!resp.ok) return { success: false, error: `HTTP ${status}`, body: text.slice(0, 500) };
    const data = JSON.parse(text);
    return { success: true, data };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});

// claude TUI 를 PTY 로 띄우고 /usage 명령 보내서 출력 캡처 (Anthropic 구독 한도 정보)
ipcMain.handle('claude:probe-usage-tui', async () => {
  return new Promise((resolve) => {
    let proc: any = null;
    let buf = '';
    let resolved = false;
    const finish = (result: any) => {
      if (resolved) return;
      resolved = true;
      try { proc?.write?.('\x03'); } catch {}
      try { proc?.write?.('/exit\n'); } catch {}
      setTimeout(() => { try { proc?.kill?.(); } catch {} }, 300);
      resolve(result);
    };
    try {
      const { execSync } = require('child_process');
      const isWin = process.platform === 'win32';
      // claude 실행 경로 직접 찾기 (cmd.exe wrapper 우회)
      let claudeBin = 'claude';
      try {
        const which = execSync(isWin ? 'where claude' : 'which claude', { encoding: 'utf-8' }).split(/\r?\n/)[0].trim();
        if (which) claudeBin = which;
      } catch {}
      proc = pty.spawn(claudeBin, [], {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: process.env.USERPROFILE || process.env.HOME || process.cwd(),
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' } as any,
      });
    } catch (e: any) {
      return resolve({ success: false, error: 'PTY spawn 실패: ' + (e?.message || e) });
    }
    let trustHandled = false;
    let usageStartLen = 0;
    let usageSent = false;
    const captureAndFinish = () => {
      const after = usageStartLen ? buf.slice(usageStartLen) : buf;
      const stripped = after
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
        .replace(/\x1b\][^\x07]*\x07/g, '')
        .replace(/\x1b[()][AB012]/g, '')
        .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
      finish({ success: true, raw: stripped, length: buf.length });
    };
    proc.onData((d: string) => {
      buf += d;
      if (!trustHandled && /trust this folder|이 폴더를 신뢰|1\.\s*Yes/i.test(buf)) {
        trustHandled = true;
        try { proc.write('1\r'); } catch {}
      }
      // /usage 패널 완성 감지 — "Esc to cancel" 마커 (TUI 패널 완전히 그려진 시점)
      if (usageSent && /Esc\s*to\s*cancel/i.test(buf.slice(usageStartLen))) {
        setTimeout(captureAndFinish, 200);
      }
    });
    proc.onExit(() => {});
    // 5초 후 /usage 송신 — 우선 더미 키(스페이스+백스페이스)로 입력 박스 활성화
    setTimeout(() => {
      if (usageSent) return;
      usageSent = true;
      // 입력 박스 깨우기 — 스페이스 후 백스페이스
      try { proc.write(' '); } catch {}
      setTimeout(() => { try { proc.write('\b'); } catch {} }, 100);
      setTimeout(() => {
        usageStartLen = buf.length;
        const cmd = '/usage';
        let i = 0;
        const typer = () => {
          if (i < cmd.length) {
            try { proc.write(cmd[i]); } catch {}
            i++;
            setTimeout(typer, 50);
          } else {
            // ENTER 두 번 시도 — \r 와 \n 모두
            setTimeout(() => { try { proc.write('\r\n'); } catch {} }, 300);
          }
        };
        typer();
      }, 300);
    }, 5000);
    // 최대 12초 후 무조건 캡처
    setTimeout(captureAndFinish, 12000);
    // 안전 타임아웃
    setTimeout(() => finish({ success: false, error: 'timeout', raw: buf }), 15000);
  });
});

// ~/.claude/projects 의 모든 세션 jsonl 을 스캔해 usage 합산 (전체 누적 사용량)
ipcMain.handle('claude:probe-usage', async () => {
  const fs = require('fs');
  const pathMod = require('path');
  const os = require('os');
  const claudeDir = pathMod.join(os.homedir(), '.claude', 'projects');
  let totalIn = 0, totalOut = 0, totalCacheCreate = 0, totalCacheRead = 0, sessionCount = 0, msgCount = 0;
  const projectStats: { project: string; in: number; out: number; cacheRead: number; sessions: number }[] = [];
  try {
    if (!fs.existsSync(claudeDir)) return { success: false, error: '~/.claude/projects 폴더 없음' };
    const projects = fs.readdirSync(claudeDir);
    for (const proj of projects) {
      const projPath = pathMod.join(claudeDir, proj);
      let stat;
      try { stat = fs.statSync(projPath); } catch { continue; }
      if (!stat.isDirectory()) continue;
      let projIn = 0, projOut = 0, projCacheRead = 0, projSessions = 0;
      const walk = (dir: string) => {
        let items: string[] = [];
        try { items = fs.readdirSync(dir); } catch { return; }
        for (const it of items) {
          const full = pathMod.join(dir, it);
          let s; try { s = fs.statSync(full); } catch { continue; }
          if (s.isDirectory()) { walk(full); continue; }
          if (!it.endsWith('.jsonl')) continue;
          projSessions++;
          sessionCount++;
          let content = '';
          try { content = fs.readFileSync(full, 'utf-8'); } catch { continue; }
          for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            try {
              const obj = JSON.parse(line);
              const u = obj?.message?.usage;
              if (u) {
                msgCount++;
                projIn += u.input_tokens || 0;
                projOut += u.output_tokens || 0;
                projCacheRead += u.cache_read_input_tokens || 0;
                totalIn += u.input_tokens || 0;
                totalOut += u.output_tokens || 0;
                totalCacheCreate += u.cache_creation_input_tokens || 0;
                totalCacheRead += u.cache_read_input_tokens || 0;
              }
            } catch {}
          }
        }
      };
      walk(projPath);
      if (projIn || projOut) projectStats.push({ project: proj, in: projIn, out: projOut, cacheRead: projCacheRead, sessions: projSessions });
    }
    projectStats.sort((a, b) => (b.in + b.out) - (a.in + a.out));
    return { success: true, totalIn, totalOut, totalCacheCreate, totalCacheRead, sessionCount, msgCount, projects: projectStats.slice(0, 20) };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('claude:stop', (_e, { sessionId, requestId }: { sessionId: string; requestId?: string }) => {
  const { spawn } = require('child_process');
  // requestId 가 명시되면 해당 프로세스만 종료, 아니면 sessionId 키로 fallback (legacy)
  const procKey = requestId || sessionId;
  const proc = claudeProcesses.get(procKey);
  if (proc) {
    // shell 을 통해 spawn 했으므로 proc.kill() 만으로는 자식 claude 가 살아남는다.
    // Windows: taskkill /T /F 로 프로세스 트리 전체 종료
    // Unix: process group 시그널 (-pid) — 단 detached 가 아니어도 일반적으론 SIGTERM 전파됨, 강제는 SIGKILL
    try {
      if (process.platform === 'win32') {
        const pid = proc.pid;
        if (pid) {
          spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        }
      } else {
        try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch {} }
      }
    } catch {}
    try { proc.kill('SIGKILL'); } catch {}
    claudeProcesses.delete(procKey);
  }
  return { success: true };
});


ipcMain.handle('gemini:check', async () => {
  try {
    const { spawn } = require('child_process');
    const augmentedPath = buildAugmentedPath();
    const env = { ...process.env, PATH: augmentedPath, Path: augmentedPath };
    return await new Promise<{ installed: boolean; version?: string }>(resolve => {
      const proc = spawn('gemini', ['--version'], { shell: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      proc.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
      proc.on('error', () => resolve({ installed: false }));
      proc.on('close', (code: number) => {
        if (code === 0) resolve({ installed: true, version: output.trim() });
        else resolve({ installed: false });
      });
    });
  } catch {
    return { installed: false };
  }
});

// 진단용 임시 dump — 렌더러가 sanitize 결과를 파일에 기록 (mermaid 디버그)
ipcMain.handle('debug:dump', (_e, { name, content }: { name: string; content: string }) => {
  try {
    const os = require('os'), path = require('path'), fs = require('fs');
    const safe = String(name || 'pepe-debug.txt').replace(/[^A-Za-z0-9._-]/g, '_');
    fs.writeFileSync(path.join(os.tmpdir(), safe), String(content ?? ''), 'utf-8');
  } catch {}
  return { ok: true };
});

ipcMain.handle('gemini:modelInfo', async () => {
  try {
    const fs = require('fs'), path = require('path'), os = require('os'), https = require('https');
    const credPath = path.join(os.homedir(), '.gemini', 'oauth_creds.json');
    if (!fs.existsSync(credPath)) return { success: false, error: 'no oauth creds' };
    const cred = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    // 토큰은 gemini CLI 가 oauth_creds.json 에 관리/갱신 — 그대로 사용 (만료 시 API 가 401 → 실패 처리)
    const token = cred.access_token;
    if (!token) return { success: false, error: 'no token' };
    const codeAssistPost = (endpoint: string, bodyObj: any, pick: (j: any) => any): Promise<any> => new Promise(resolve => {
      const body = JSON.stringify(bodyObj);
      const req = https.request(`https://cloudcode-pa.googleapis.com/v1internal:${endpoint}`,
        { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } },
        (res: any) => { let d = ''; res.on('data', (x: any) => d += x); res.on('end', () => { try { resolve(pick(JSON.parse(d))); } catch { resolve(null); } }); });
      req.on('error', () => resolve(null));
      req.write(body); req.end();
    });
    // 1) loadCodeAssist → 요금제(tier) + cloudaicompanionProject
    const ca: any = await codeAssistPost('loadCodeAssist',
      { metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' } }, j => j);
    const tier = ca?.currentTier;
    if (!tier) return { success: false, error: 'tier query failed' };
    // 2) retrieveUserQuota — ⚠ project 파라미터 필수. 없으면 전부 remainingFraction=1 인 placeholder 가 옴.
    const project = ca?.cloudaicompanionProject;
    const quota = project
      ? await codeAssistPost('retrieveUserQuota', { project }, j => j.buckets || null)
      : null;
    const quotaBuckets = Array.isArray(quota)
      ? quota.filter((b: any) => b && b.modelId).map((b: any) => ({
          modelId: b.modelId,
          remainingFraction: typeof b.remainingFraction === 'number' ? b.remainingFraction : null,
          resetTime: b.resetTime || null,
        }))
      : [];
    return { success: true, tierId: tier.id, tierName: tier.name, isPaid: tier.id !== 'free-tier', quotaBuckets };
  } catch (e: any) {
    return { success: false, error: String(e) };
  }
});

ipcMain.handle('gemini:send', async (_e, { sessionId, prompt, requestId, model, yolo, addDirs, sshTermId }: { sessionId: string; prompt: string; requestId?: string; model?: string; yolo?: boolean; addDirs?: string[]; sshTermId?: string }) => {
  try {
    // 같은 sessionId로 실행 중인 Codex 프로세스 정리
    const prevCodex = codexProcesses.get(sessionId);
    if (prevCodex) { try { prevCodex.kill('SIGKILL'); } catch {} codexProcesses.delete(sessionId); }
    const { spawn } = require('child_process');
    const procKey = requestId || sessionId;
    const os = require('os');
    const path = require('path');
    const fs = require('fs');

    const tmpFile = path.join(os.tmpdir(), `gemini-prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
    // 기본 응답 언어를 한국어로 (사용자가 다른 언어를 명시 요청하지 않는 한)
    const geminiLangPrefix = '[시스템 지시] 특별한 언어 요청이 없으면 항상 한국어로 응답하세요.\n\n';
    fs.writeFileSync(tmpFile, geminiLangPrefix + prompt, 'utf-8');

    const augmentedPath = buildAugmentedPath();
    const spawnEnv: any = {
      ...process.env,
      PATH: augmentedPath,
      Path: augmentedPath,
      PYTHONIOENCODING: 'utf-8',
      LANG: process.env.LANG || 'en_US.UTF-8',
      LC_ALL: process.env.LC_ALL || 'en_US.UTF-8',
    };

    // ── SSH MCP 서버 연결 — sshTermId 가 있으면 gemini 에 pepe_ssh MCP(ssh_exec/read/write) 제공 ──
    // gemini 는 WebDAV UNC 워크스페이스를 못 쓰므로(realpathSync hang) 원격 파일은 MCP 로 처리.
    // GEMINI_CLI_SYSTEM_SETTINGS_PATH 로 임시 system settings 를 주입 → ~/.gemini/settings.json 오염 없음.
    let geminiSettingsTmp = '';
    if (sshTermId) {
      try {
        await startMcpControl();
        const mcpScriptPath = path.join(os.tmpdir(), 'pepe-mcp-ssh-server.cjs');
        try {
          const existing = fs.existsSync(mcpScriptPath) ? fs.readFileSync(mcpScriptPath, 'utf-8') : '';
          if (existing !== mcpSshServerScript) fs.writeFileSync(mcpScriptPath, mcpSshServerScript, 'utf-8');
        } catch (e) { console.error('[gemini] MCP script extract failed:', e); }
        const geminiSettings = {
          mcpServers: {
            pepe_ssh: {
              command: process.execPath,
              args: [mcpScriptPath],
              env: {
                PEPE_CTRL_PORT: String(mcpControlPort),
                PEPE_CTRL_TOKEN: mcpControlToken,
                PEPE_TERM_ID: sshTermId,
                ELECTRON_RUN_AS_NODE: '1',
              },
              trust: true,
            },
          },
        };
        geminiSettingsTmp = path.join(os.tmpdir(), `gemini-mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
        fs.writeFileSync(geminiSettingsTmp, JSON.stringify(geminiSettings), 'utf-8');
        spawnEnv.GEMINI_CLI_SYSTEM_SETTINGS_PATH = geminiSettingsTmp;
        console.log('[gemini] MCP(pepe_ssh) configured — termId:', sshTermId, '| settings:', geminiSettingsTmp);
      } catch (e) {
        console.error('[gemini] MCP setup failed:', e);
      }
    }

    const modelFlag = model ? ` -m ${model}` : '';
    // gemini 는 비대화형이라 항상 --yolo 필요 (없으면 도구가 막힘).
    // 승인 게이트는 렌더러의 "계획 승인" 흐름이 담당.
    void yolo;
    const yoloFlag = ' --yolo';
    const localDirs = Array.isArray(addDirs) ? addDirs.filter(d => d && !d.startsWith('\\\\')) : [];
    const skippedUnc = Array.isArray(addDirs) ? addDirs.filter(d => d && d.startsWith('\\\\')) : [];
    const includeFlag = localDirs.length > 0
      ? ' ' + localDirs.map(d => `--include-directories "${d}"`).join(' ')
      : '';
    const trustFlag = ' --skip-trust';
    const isWin = process.platform === 'win32';
    const cwd = process.env.USERPROFILE || process.env.HOME || os.homedir();
    // -o stream-json: 도구 호출/응답을 JSONL 이벤트로 출력 → 도구 타임라인 표시
    const shellCmd = isWin
      ? `chcp 65001 >nul && type "${tmpFile}" | gemini -o stream-json${modelFlag}${yoloFlag}${trustFlag}${includeFlag}`
      : `cat "${tmpFile}" | gemini -o stream-json${modelFlag}${yoloFlag}${trustFlag}${includeFlag}`;
    console.log('[gemini] include-dirs(local):', localDirs.length ? localDirs.join(', ') : '(none)');
    if (skippedUnc.length) console.log('[gemini] UNC dirs skipped (realpathSync hang 회피):', skippedUnc.join(', '));
    const proc = spawn(shellCmd, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: spawnEnv, cwd });
    geminiProcesses.set(procKey, proc);

    const cleanupTmp = () => {
      try { fs.unlinkSync(tmpFile); } catch {}
      if (geminiSettingsTmp) { try { fs.unlinkSync(geminiSettingsTmp); } catch {} }
    };

    console.log('[gemini] spawn — model:', model || 'default', '| yolo:', yolo !== false);
    const sendStream = (message: any) => mainWindow?.webContents.send('claude:stream', { sessionId, requestId, message });
    // gemini stream-json 이벤트 → claude:stream (Claude 호환 포맷) 변환
    const gIdPrefix = requestId || `gmn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let geminiHadOutput = false;
    let gTextBuf = '';
    let gSegment = 0;
    // flush 시 누적 텍스트에 대한 최종 정리. 모델이 update_topic 의 내부
    // 파라미터(strategic_intent 등)를 평문으로 흘리는 경우가 있는데, 이 누수는
    // 여러 델타에 걸쳐 쪼개져 오므로 per-delta 정리로는 못 잡고 flush 시 한 번 더 거른다.
    // 'strategic_intent:' 다음부터 첫 마침표(.) 또는 줄바꿈까지를 한 단위로 제거.
    // update_topic / save_memory 같은 메타 도구의 함수 호출 형태를 균형 잡힌 괄호 파서로 제거.
    // (regex 만으로는 따옴표 안 ')' / unescape 된 따옴표 / 긴 multiline 값을 안정적으로 처리 못함)
    const stripFnCall = (s: string, fnName: string): string => {
      const re = new RegExp(`\\b${fnName}\\s*\\(`);
      let result = s;
      // 반복 — 같은 fnName 호출이 여러 개 있을 수 있음
      for (let safety = 0; safety < 20; safety++) {
        const m = re.exec(result);
        if (!m) break;
        const start = m.index;
        let depth = 1;
        let i = m.index + m[0].length;
        let inStr: string | null = null;
        while (i < result.length && depth > 0) {
          const c = result[i];
          if (inStr) {
            if (c === '\\' && i + 1 < result.length) { i += 2; continue; }
            if (c === inStr) inStr = null;
          } else {
            if (c === '"' || c === "'") inStr = c;
            else if (c === '(') depth++;
            else if (c === ')') depth--;
          }
          i++;
        }
        if (depth === 0) {
          // 닫는 ')' 찾음 → 그 뒤 선행 개행 1개까지 같이 제거
          let end = i;
          if (result[end] === '\n') end++;
          result = result.slice(0, start) + result.slice(end);
        } else {
          // 닫는 ')' 못 찾음 (모델이 미완 출력) → 줄 끝까지 잘라냄. 줄 없으면 전체.
          const nlIdx = result.indexOf('\n', m.index);
          if (nlIdx !== -1) result = result.slice(0, start) + result.slice(nlIdx + 1);
          else result = result.slice(0, start);
          break;
        }
      }
      return result;
    };
    const finalizeGeminiText = (s: string): string => {
      let out = s;
      // 1) update_topic(...) / save_memory(...) 함수 호출 — 균형 괄호 파서로 안전하게 제거
      out = stripFnCall(out, 'update_topic');
      out = stripFnCall(out, 'save_memory');
      // 2) bare 'strategic_intent: ...' narration 누수 — 첫 마침표/줄바꿈까지 제거
      out = out.replace(/\bstrategic_intent\s*:[^.\n]*[.\n]?/gi, '');
      // 3) 제거 후 선두 공백/개행 정리
      out = out.replace(/^\s+/, '');
      return out;
    };
    const flushGeminiText = () => {
      const cleaned = finalizeGeminiText(gTextBuf);
      if (cleaned.trim()) {
        sendStream({ type: 'assistant', message: { id: `${gIdPrefix}-m-${gSegment}`, content: [{ type: 'text', text: cleaned }] } });
        gSegment++;
      }
      gTextBuf = '';
    };
    // gemini 내부 메타 도구 — 화면에 표시하지 않음 (대화 토픽 관리용 bookkeeping)
    const GEMINI_META_TOOLS = new Set(['update_topic', 'save_memory']);
    const geminiMetaToolIds = new Set<string>();
    // 모델이 텍스트에 섞어 내보내는 update_topic(...) 등 토픽 지시문 제거
    // ⚠ trimStart() 금지 — 스트리밍 delta 마다 호출되므로 줄바꿈으로 시작하는 delta 의
    // 선행 개행이 잘려 인접 줄이 붙어버림(코드블록/mermaid 깨짐). 지시문만 제거.
    const stripGeminiDirectives = (s: string): string =>
      s.replace(/update_topic\s*\(\s*\w+\s*=\s*(['"])[\s\S]*?\1(?:\s*,\s*\w+\s*=\s*(['"])[\s\S]*?\2)*\s*\)/g, '');

    const handleGeminiEvent = (evt: any) => {
      const t = evt?.type;
      if (t === 'message') {
        // role=user 는 입력 에코 → 무시. assistant 만 누적.
        if (evt.role === 'assistant' && typeof evt.content === 'string' && evt.content) {
          const cleaned = stripGeminiDirectives(evt.content);
          if (cleaned) {
            geminiHadOutput = true;
            gTextBuf += cleaned;
          }
        }
      } else if (t === 'tool_use') {
        // 메타 도구는 타임라인에 표시 안 함
        if (GEMINI_META_TOOLS.has(evt.tool_name)) { geminiMetaToolIds.add(evt.tool_id); return; }
        geminiHadOutput = true;
        flushGeminiText(); // 도구 앞의 텍스트를 먼저 메시지로 확정 (타임라인 인터리브)
        sendStream({ type: 'assistant', message: { id: `${gIdPrefix}-a-${evt.tool_id}`, content: [{ type: 'tool_use', id: `${gIdPrefix}-${evt.tool_id}`, name: evt.tool_name || 'tool', input: evt.parameters || {} }] } });
      } else if (t === 'tool_result') {
        if (geminiMetaToolIds.has(evt.tool_id)) return; // 메타 도구 결과 무시
        const out = evt.output ?? evt.content ?? evt.result ?? evt.error ?? evt.status ?? '';
        sendStream({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `${gIdPrefix}-${evt.tool_id}`, content: typeof out === 'string' ? out : JSON.stringify(out), is_error: !!evt.status && evt.status !== 'success' }] } });
      } else if (t === 'error') {
        // Gemini CLI 는 응답 끝에 meta 도구(update_topic 등)가 있으면
        // "Invalid stream: empty response or malformed tool call" 같은 거짓 에러를 종종 뿜는다.
        // 이미 텍스트/도구 출력이 있었다면(geminiHadOutput) 응답은 정상 전달된 것이므로
        // 보류 중인 텍스트를 먼저 flush 하고 거짓 에러는 무시한다.
        const msg = String(evt.message || evt.error || '');
        if (geminiHadOutput || gTextBuf.trim()) {
          flushGeminiText();
          if (/invalid stream|empty response|malformed tool call/i.test(msg)) return;
        }
        sendStream({ type: 'error', text: msg || 'gemini error' });
      } else if (t === 'result') {
        // 토큰 사용량(컨텍스트) — 렌더러 usage 표시용
        if (evt.stats) sendStream({ type: 'gemini_usage', stats: evt.stats });
      }
      // init / thought → 무시 (done 은 close 에서)
    };

    let stdoutBuf = '';
    proc.stdout.setEncoding('utf-8');
    proc.stdout.on('data', (data: string) => {
      stdoutBuf += data;
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        console.log('[gemini] stdout:', line.slice(0, 200));
        try { handleGeminiEvent(JSON.parse(line)); }
        catch { /* JSONL 아닌 노이즈 라인 → 무시 */ }
      }
    });
    // stderr 노이즈 — 재시도 백오프/경고 (gemini 가 내부 재시도 후 성공하면 무시)
    const GEMINI_NOISE = /YOLO mode is enabled|Ripgrep is not available|Falling back to GrepTool|256-color|overriding the built-in|^\s*$/;
    let stderrBuf = '';
    proc.stderr.on('data', (data: Buffer) => {
      const s = data.toString();
      stderrBuf += s;
      console.log('[gemini] stderr:', s.slice(0, 300).replace(/\n/g, ' '));
    });
    proc.on('error', (err: any) => {
      console.log('[gemini] spawn error:', err);
      sendStream({ type: 'error', text: String(err) });
    });
    proc.on('close', (code: number) => {
      // 남은 stdout 버퍼 + 마지막 텍스트 세그먼트 플러시
      if (stdoutBuf.trim()) {
        try { handleGeminiEvent(JSON.parse(stdoutBuf)); } catch {}
      }
      flushGeminiText();
      console.log('[gemini] close, code:', code, '| had output:', geminiHadOutput);
      // ⚠ 에러는 gemini 가 실제 실패(출력 없음)했을 때만 표시.
      // gemini 는 일시적 429/rate-limit 시 stderr 에 "quota will reset after 5s" 를 찍고
      // 내부 재시도 → 성공함. 출력이 있으면 stderr 는 재시도 노이즈이므로 무시.
      if (!geminiHadOutput) {
        const lines = stderrBuf.split('\n').filter(l => l.trim() && !GEMINI_NOISE.test(l));
        const joined = lines.join('\n');
        if (joined.trim()) {
          let errText = joined;
          if (/ModelNotFoundError|Requested entity was not found|code:\s*404/i.test(joined)) {
            errText = `❌ Gemini 모델을 찾을 수 없습니다 (404). 모델 선택에서 Flash 계열 모델을 선택하세요.`;
          } else if (/TerminalQuotaError|QUOTA_EXHAUSTED|RESOURCE_EXHAUSTED|\b429\b/.test(joined)) {
            const qm = joined.match(/quota will reset after ([^\n.]+)/i);
            errText = qm
              ? `❌ Gemini API 할당량 초과. ${qm[1]} 후 재시도하세요.`
              : `❌ Gemini API 한도 초과. 잠시 후 다시 시도하세요.`;
          }
          console.log('[gemini] error reported:', errText.slice(0, 120));
          sendStream({ type: 'error', text: errText });
        }
      }
      cleanupTmp();
      geminiProcesses.delete(procKey);
      sendStream({ type: 'done', code });
    });
    return { success: true };
  } catch (err: any) {
    return { success: false, error: String(err) };
  }
});

ipcMain.handle('gemini:stop', (_e, { sessionId, requestId }: { sessionId: string; requestId?: string }) => {
  const { spawn } = require('child_process');
  const procKey = requestId || sessionId;
  const proc = geminiProcesses.get(procKey);
  if (proc) {
    try {
      if (process.platform === 'win32') {
        const pid = proc.pid;
        if (pid) spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } else {
        try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch {} }
      }
    } catch {}
    try { proc.kill('SIGKILL'); } catch {}
    geminiProcesses.delete(procKey);
  }
  return { success: true };
});

ipcMain.handle('codex:check', async () => {
  try {
    const { spawn } = require('child_process');
    const augmentedPath = buildAugmentedPath();
    const env = { ...process.env, PATH: augmentedPath, Path: augmentedPath };
    return await new Promise<{ installed: boolean; version?: string }>(resolve => {
      const proc = spawn('codex', ['--version'], { shell: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      proc.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
      proc.on('error', () => resolve({ installed: false }));
      proc.on('close', (code: number) => {
        if (code === 0) resolve({ installed: true, version: output.trim() });
        else resolve({ installed: false });
      });
    });
  } catch {
    return { installed: false };
  }
});

// codex 토큰/요금 한도 — 가장 최근 세션 rollout 파일에서 추출 (대화 없이도 탭 진입 시 표시용)
ipcMain.handle('codex:rateLimits', async () => {
  try {
    const fs = require('fs'), path = require('path'), os = require('os');
    const sessionsDir = path.join(os.homedir(), '.codex', 'sessions');
    if (!fs.existsSync(sessionsDir)) return { success: false };
    let newest: string | null = null, newestMtime = 0;
    const walk = (dir: string, depth: number) => {
      if (depth > 4) return;
      let entries: string[] = [];
      try { entries = fs.readdirSync(dir); } catch { return; }
      for (const name of entries) {
        const p = path.join(dir, name);
        let st: any;
        try { st = fs.statSync(p); } catch { continue; }
        if (st.isDirectory()) walk(p, depth + 1);
        else if (name.startsWith('rollout-') && name.endsWith('.jsonl') && st.mtimeMs > newestMtime) {
          newestMtime = st.mtimeMs; newest = p;
        }
      }
    };
    walk(sessionsDir, 0);
    if (!newest) return { success: false };
    const lines = fs.readFileSync(newest, 'utf-8').split('\n').filter(Boolean);
    let lastUsage: any = null, totalUsage: any = null, ctxWindow: any = null, rateLimits: any = null, saw = false;
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (e?.payload?.type === 'token_count') {
          saw = true;
          const inf = e.payload.info;
          if (inf?.last_token_usage) lastUsage = inf.last_token_usage;
          if (inf?.total_token_usage) totalUsage = inf.total_token_usage;
          if (inf?.model_context_window) ctxWindow = inf.model_context_window;
          if (e.payload.rate_limits) rateLimits = e.payload.rate_limits;
        }
      } catch {}
    }
    if (!saw) return { success: false };
    return { success: true, info: { last_token_usage: lastUsage, total_token_usage: totalUsage, model_context_window: ctxWindow }, rateLimits };
  } catch (e: any) {
    return { success: false, error: String(e) };
  }
});

ipcMain.handle('codex:send', async (_e, { sessionId, prompt, requestId, model, approvalPolicy, effort }: { sessionId: string; prompt: string; requestId?: string; model?: string; approvalPolicy?: 'suggest' | 'auto-edit' | 'full-auto'; effort?: string }) => {
  try {
    // 같은 sessionId로 실행 중인 Gemini 프로세스 정리
    const prevGemini = geminiProcesses.get(sessionId);
    if (prevGemini) { try { prevGemini.kill('SIGKILL'); } catch {} geminiProcesses.delete(sessionId); }
    const { spawn } = require('child_process');
    const procKey = requestId || sessionId;
    const os = require('os');
    const path = require('path');
    const fs = require('fs');

    console.log('[codex] spawn start, prompt length:', prompt.length);
    console.log('[codex] model:', model || 'default', '| effort:', effort || 'default', '| approval:', approvalPolicy || 'suggest');

    const isWin = process.platform === 'win32';
    const tmpFile = path.join(os.tmpdir(), `codex-prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
    // codex.exe(Rust)는 stdin을 raw UTF-8로 검증하며 읽음 (invalid UTF-8 시 에러 후 종료)
    // → 반드시 UTF-8 바이트를 전달해야 함 (fallback shell 방식용 tmpFile)
    fs.writeFileSync(tmpFile, prompt, 'utf-8');

    const augmentedPath = buildAugmentedPath();
    const spawnEnv = {
      ...process.env,
      PATH: augmentedPath,
      Path: augmentedPath,
      PYTHONIOENCODING: 'utf-8',
      LANG: process.env.LANG || 'en_US.UTF-8',
      LC_ALL: process.env.LC_ALL || 'en_US.UTF-8',
    };

    const codexEffort = effort === 'max' ? 'xhigh' : effort;
    // codex 는 항상 danger-full-access(샌드박스 OFF)로 실행 — claude 와 동일하게 OS 샌드박스 없음.
    // Windows 샌드박스(restricted token)는 UNC/WebDAV 네트워크 경로를 차단하므로 반드시 꺼야 함.
    void approvalPolicy;
    const cwd = process.env.USERPROFILE || process.env.HOME || os.homedir();

    const modelFlag = model ? ` -m ${model}` : '';
    // effort: 값이 단순 영문(low/medium/high/xhigh)이므로 cmd.exe 에서 따옴표 불필요
    const effortFlag = codexEffort && ['low', 'medium', 'high', 'xhigh'].includes(codexEffort)
      ? ` -c model_reasoning_effort=${codexEffort}`
      : '';

    // Windows: codex.exe 직접 spawn — cmd.exe/type/chcp/codex.cmd/codex.js 계층을
    // 전부 우회. 이 계층들이 UTF-8 바이트를 코드페이지 변환해서 한글이 깨짐.
    // (claude 는 codex.js 같은 sub-binary spawn 계층이 없어 정상 동작)
    // codex.exe 에 Node pipe 로 UTF-8 바이트 직접 write → Rust 가 raw UTF-8 정상 수신.
    const findCodexExe = (): string | null => {
      try {
        const codexCmdLine = execSync('where codex.cmd', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }) as string;
        const codexCmdPath = codexCmdLine.split('\n')[0].trim();
        const npmDir = path.dirname(codexCmdPath);
        const codexPkgDir = path.join(npmDir, 'node_modules', '@openai', 'codex');
        const archName = process.arch === 'x64' ? 'x64' : 'arm64';
        const triple = process.arch === 'x64' ? 'x86_64-pc-windows-msvc' : 'aarch64-pc-windows-msvc';
        const candidates = [
          path.join(codexPkgDir, 'node_modules', '@openai', `codex-win32-${archName}`, 'vendor', triple, 'codex', 'codex.exe'),
          path.join(codexPkgDir, 'vendor', triple, 'codex', 'codex.exe'),
        ];
        for (const p of candidates) { if (fs.existsSync(p)) return p; }
      } catch {}
      return null;
    };

    // 직접 spawn 용 인수 배열 (shell 없음 → 따옴표/이스케이프 불필요)
    const buildCodexArgs = (): string[] => {
      const args = ['exec', '--json'];
      if (model) args.push('-m', model);
      if (codexEffort && ['low', 'medium', 'high', 'xhigh'].includes(codexEffort)) {
        args.push('-c', `model_reasoning_effort="${codexEffort}"`);
      }
      args.push('--skip-git-repo-check');
      // 샌드박스 OFF — UNC/WebDAV 네트워크 경로 접근 허용
      args.push('--sandbox', 'danger-full-access');
      return args;
    };

    let proc: any;
    let usedDirectExe = false;
    const codexExePath = isWin ? findCodexExe() : null;

    if (isWin && codexExePath) {
      // ✅ codex.exe 직접 spawn + stdin pipe → UTF-8 바이트 그대로 전달
      const args = buildCodexArgs();
      console.log('[codex] direct exe:', codexExePath);
      console.log('[codex] args:', args.join(' '));
      proc = spawn(codexExePath, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: spawnEnv, cwd });
      usedDirectExe = true;
    } else if (isWin) {
      // fallback: codex.exe 못 찾으면 shell 방식 (한글 깨질 수 있음)
      const sandbox = `--sandbox danger-full-access`;
      const shellCmd = `chcp 65001 >nul && type "${tmpFile}" | codex exec --json${modelFlag}${effortFlag} --skip-git-repo-check ${sandbox}`;
      console.log('[codex] shell fallback (win):', shellCmd);
      proc = spawn(shellCmd, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: spawnEnv, cwd });
    } else {
      // Mac/Linux
      const sandbox = `--sandbox danger-full-access`;
      const shellCmd = `cat "${tmpFile}" | codex exec --json${modelFlag}${effortFlag} --skip-git-repo-check ${sandbox}`;
      console.log('[codex] shell cmd (unix):', shellCmd);
      proc = spawn(shellCmd, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: spawnEnv, cwd });
    }
    console.log('[codex] PATH has npm:', augmentedPath.toLowerCase().includes('npm'));
    codexProcesses.set(procKey, proc);

    // 직접 spawn 시: 프롬프트 UTF-8 바이트를 stdin 에 직접 write (cmd.exe 우회)
    if (usedDirectExe) {
      try {
        proc.stdin.write(Buffer.from(prompt, 'utf-8'));
        proc.stdin.end();
      } catch (e) {
        console.log('[codex] stdin write error:', e);
      }
    }

    const cleanupTmp = () => { try { fs.unlinkSync(tmpFile); } catch {} };

    let stdoutBuf = '';
    let stdoutHadContent = false;
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[mGKHF]/g, '').replace(/\r/g, '');
    proc.stdout.setEncoding('utf-8');

    // ── codex --json (JSONL) 이벤트 → claude:stream (Claude 호환 포맷) 변환 ──
    // codex 의 도구 사용 내역(command_execution, file_change, mcp_tool_call 등)을
    // Claude 의 tool_use/tool_result 포맷으로 매핑 → 렌더러가 그대로 타임라인에 표시.
    const sendStream = (message: any) =>
      mainWindow?.webContents.send('claude:stream', { sessionId, requestId, message });
    // codex item id(item_0, item_1...)는 매 실행마다 0부터 재사용됨 → 요청별 prefix 로
    // 전역 고유 id 생성 (없으면 메시지/툴 id 가 이전 응답과 충돌해 새 응답이 묻힘)
    const idPrefix = requestId || `cdx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let codexThreadId = '';

    // codex 세션 rollout 파일에서 token_count(토큰 사용량 + rate_limits) 추출.
    // exec --json stdout 에는 rate_limits 가 안 나오지만 ~/.codex/sessions/.../rollout-*.jsonl 에 기록됨.
    const readCodexSessionInfo = (threadId: string): any => {
      try {
        const sessionsDir = path.join(os.homedir(), '.codex', 'sessions');
        if (!fs.existsSync(sessionsDir)) return null;
        let target: string | null = null;
        const walk = (dir: string, depth: number) => {
          if (target || depth > 4) return;
          let entries: string[] = [];
          try { entries = fs.readdirSync(dir).sort().reverse(); } catch { return; }
          for (const name of entries) {
            if (target) return;
            const p = path.join(dir, name);
            let st: any;
            try { st = fs.statSync(p); } catch { continue; }
            if (st.isDirectory()) walk(p, depth + 1);
            else if (name.startsWith('rollout-') && name.endsWith('.jsonl') && threadId && name.includes(threadId)) {
              target = p;
              return;
            }
          }
        };
        walk(sessionsDir, 0);
        if (!target) return null;
        const lines = fs.readFileSync(target, 'utf-8').split('\n').filter(Boolean);
        // 모든 token_count 이벤트를 순회하며 필드별 최신값을 누적 수집.
        // (특정 이벤트가 rate_limits / model_context_window 를 누락해도 다른 이벤트에서 보강)
        let lastUsage: any = null, totalUsage: any = null, ctxWindow: any = null, rateLimits: any = null;
        let sawTokenCount = false;
        for (const line of lines) {
          try {
            const e = JSON.parse(line);
            if (e?.payload?.type === 'token_count') {
              sawTokenCount = true;
              const inf = e.payload.info;
              if (inf?.last_token_usage) lastUsage = inf.last_token_usage;
              if (inf?.total_token_usage) totalUsage = inf.total_token_usage;
              if (inf?.model_context_window) ctxWindow = inf.model_context_window;
              if (e.payload.rate_limits) rateLimits = e.payload.rate_limits;
            }
          } catch {}
        }
        if (!sawTokenCount) return null;
        return {
          info: { last_token_usage: lastUsage, total_token_usage: totalUsage, model_context_window: ctxWindow },
          rateLimits,
        };
      } catch {}
      return null;
    };
    const isToolItem = (t: string) => !!t && t !== 'agent_message' && t !== 'reasoning' && t !== 'error';
    const codexToolName = (it: any): string => {
      switch (it?.type) {
        case 'command_execution': return 'Shell';
        case 'file_change': return 'FileChange';
        case 'mcp_tool_call': return it.tool ? `${it.server || 'mcp'}.${it.tool}` : 'McpTool';
        case 'web_search': return 'WebSearch';
        case 'todo_list': return 'TodoList';
        case 'patch_apply': return 'PatchApply';
        default: return it?.type || 'Tool';
      }
    };
    const codexToolInput = (it: any): any => {
      switch (it?.type) {
        case 'command_execution': return { command: it.command };
        case 'file_change': return { changes: it.changes };
        case 'mcp_tool_call': return it.arguments || it.input || {};
        case 'web_search': return { query: it.query };
        case 'todo_list': return { items: it.items };
        default: { const { id, type, status, aggregated_output, ...rest } = it || {}; return rest; }
      }
    };
    const codexToolResult = (it: any): string => {
      if (it?.type === 'command_execution') return it.aggregated_output || '';
      if (it?.type === 'mcp_tool_call') return typeof it.result === 'string' ? it.result : JSON.stringify(it.result ?? '');
      if (it?.type === 'file_change') return (it.changes || []).map((c: any) => `${c.kind || ''} ${c.path || ''}`.trim()).join('\n') || 'applied';
      if (it?.type === 'web_search') return it.query || '';
      if (it?.type === 'todo_list') return (it.items || []).map((t: any) => `${t.completed ? '✓' : '○'} ${t.text ?? t}`).join('\n');
      try { return JSON.stringify(it); } catch { return ''; }
    };
    const codexIsError = (it: any): boolean =>
      it?.status === 'failed' || (typeof it?.exit_code === 'number' && it.exit_code !== 0);

    const handleCodexEvent = (evt: any) => {
      const t = evt?.type;
      if (t === 'thread.started') {
        codexThreadId = evt?.thread_id || '';
      } else if (t === 'item.started' || t === 'item.updated') {
        const it = evt.item;
        if (it && isToolItem(it.type)) {
          stdoutHadContent = true;
          sendStream({ type: 'assistant', message: { id: `${idPrefix}-a-${it.id}`, content: [{ type: 'tool_use', id: `${idPrefix}-${it.id}`, name: codexToolName(it), input: codexToolInput(it) }] } });
        }
      } else if (t === 'item.completed') {
        const it = evt.item;
        if (!it) return;
        if (it.type === 'agent_message') {
          if (it.text) {
            stdoutHadContent = true;
            sendStream({ type: 'assistant', message: { id: `${idPrefix}-m-${it.id}`, content: [{ type: 'text', text: it.text }] } });
          }
        } else if (it.type === 'reasoning') {
          // 추론 단계 — 화면 표시 안 함
        } else if (it.type === 'error') {
          sendStream({ type: 'error', text: it.message || it.text || 'codex error' });
        } else if (isToolItem(it.type)) {
          stdoutHadContent = true;
          // tool_use (started 이벤트 누락 대비 — 중복 id 는 렌더러가 무시) + tool_result
          sendStream({ type: 'assistant', message: { id: `${idPrefix}-a-${it.id}`, content: [{ type: 'tool_use', id: `${idPrefix}-${it.id}`, name: codexToolName(it), input: codexToolInput(it) }] } });
          sendStream({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `${idPrefix}-${it.id}`, content: codexToolResult(it), is_error: codexIsError(it) }] } });
        }
      } else if (t === 'turn.completed') {
        // 토큰 사용량은 close 시점에 rollout 파일에서 더 정확히 읽음 (여기선 skip)
      } else if (t === 'error' || t === 'turn.failed') {
        const m = evt?.error?.message || evt?.message || evt?.error || 'codex error';
        sendStream({ type: 'error', text: typeof m === 'string' ? m : JSON.stringify(m) });
      }
      // thread.started / turn.started → 무시 (done 은 close 에서 전송)
    };

    const handleCodexLine = (rawLine: string) => {
      const line = stripAnsi(rawLine);
      if (!line.trim()) return;
      console.log('[codex] stdout line:', line.slice(0, 200));
      const trimmed = line.trimStart();
      // JSONL 이벤트
      if (trimmed.startsWith('{')) {
        try { handleCodexEvent(JSON.parse(trimmed)); return; }
        catch { /* JSON 아님 → 평문 처리로 폴백 */ }
      }
      // ERROR: {json} 평문
      if (trimmed.startsWith('ERROR:')) {
        const jsonStr = trimmed.slice('ERROR:'.length).trim();
        try {
          const obj = JSON.parse(jsonStr);
          sendStream({ type: 'error', text: obj?.error?.message || obj?.message || jsonStr });
        } catch {
          sendStream({ type: 'error', text: jsonStr || line });
        }
        return;
      }
      // 그 외 평문 → 텍스트
      stdoutHadContent = true;
      sendStream({ type: 'text', text: line + '\n' });
    };

    proc.stdout.on('data', (data: string) => {
      stdoutBuf += data;
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() || '';
      for (const rawLine of lines) handleCodexLine(rawLine);
    });
    // Codex stderr = stdin echo + 세션 메타데이터
    let codexStderrBuf = '';
    const CODEX_STDERR_ERR = /^(error|Error|failed|invalid|quota|unauthorized|rate.limit|\d{3}\s)/i;
    const CODEX_META_RE = /^(Reading prompt from stdin|OpenAI Codex v|-----+|workdir:|model:|provider:|approval:|sandbox:|reasoning effort:|reasoning summaries:|session id:|tokens used|user$|codex$)/m;
    proc.stderr.on('data', (data: Buffer | string) => {
      const s = Buffer.isBuffer(data) ? data.toString('utf-8') : data;
      console.log('[codex] stderr:', s.slice(0, 300));
      codexStderrBuf += s;
    });
    proc.on('error', (err: any) => {
      console.log('[codex] spawn error:', err);
      mainWindow?.webContents.send('claude:stream', { sessionId, requestId, message: { type: 'error', text: String(err) } });
    });
    proc.on('close', (code: number) => {
      console.log('[codex] close, code:', code);
      // 남은 stdout 버퍼 플러시
      if (stdoutBuf.trim()) handleCodexLine(stdoutBuf);
      // stderr: stdout 에 아무 내용도 없을 때만 명백한 에러 라인 표시
      if (!stdoutHadContent && code !== 0 && codexStderrBuf.trim()) {
        const errLines = codexStderrBuf.split('\n')
          .filter(l => l.trim() && !CODEX_META_RE.test(l) && CODEX_STDERR_ERR.test(l));
        if (errLines.length) {
          mainWindow?.webContents.send('claude:stream', { sessionId, requestId, message: { type: 'error', text: errLines.join('\n') } });
        }
      }
      // 토큰 사용량 + rate_limits(요금 한도) — codex 세션 rollout 파일에서 추출
      try {
        const sess = readCodexSessionInfo(codexThreadId);
        console.log('[codex] rollout read — thread:', codexThreadId, '| found:', !!sess,
          sess ? `| info keys: ${sess.info ? Object.keys(sess.info).join(',') : 'none'} | ctxWin: ${sess.info?.model_context_window} | rateLimits: ${sess.rateLimits ? 'yes' : 'no'}` : '');
        if (sess && (sess.info || sess.rateLimits)) {
          sendStream({ type: 'codex_usage', info: sess.info, rateLimits: sess.rateLimits });
        }
      } catch (e) { console.log('[codex] session info read fail:', e); }
      cleanupTmp();
      codexProcesses.delete(procKey);
      mainWindow?.webContents.send('claude:stream', { sessionId, requestId, message: { type: 'done', code } });
    });
    return { success: true };
  } catch (err: any) {
    console.log('[codex] exception:', err);
    return { success: false, error: String(err) };
  }
});

ipcMain.handle('codex:stop', (_e, { sessionId, requestId }: { sessionId: string; requestId?: string }) => {
  const { spawn } = require('child_process');
  const procKey = requestId || sessionId;
  const proc = codexProcesses.get(procKey);
  if (proc) {
    try {
      if (process.platform === 'win32') {
        const pid = proc.pid;
        if (pid) spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } else {
        try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch {} }
      }
    } catch {}
    try { proc.kill('SIGKILL'); } catch {}
    codexProcesses.delete(procKey);
  }
  return { success: true };
});
