// electron/main.ts
import { app, BrowserWindow, ipcMain, dialog, Menu, shell, clipboard, nativeImage } from 'electron';
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
// MCP 서버 스크립트를 번들에 임베드 (vite ?raw) — 런타임에 임시 파일로 추출 후 spawn
// @ts-ignore
import mcpSshServerScript from './mcpSshServer.cjs?raw';
// @ts-ignore
import claudeHookScript from './claudeHookScript.cjs?raw';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
(globalThis as any).__dirname = __dirname;

// 멀티 인스턴스 캐시 충돌 방지
const instanceId = `${process.pid}-${Date.now()}`;
const sessionDataPath = path.join(app.getPath('userData'), `session-${instanceId}`);
app.setPath('sessionData', sessionDataPath);

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

app.whenReady().then(() => {
  sessionsData = loadSessionsData();
  createWindow();
  installX11DisplayHook();

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
        mainWindow.webContents.send('sftp:progress', { panelId: msg.panelId, data: msg.data });
        break;
      case 'sftp-complete':
        mainWindow.webContents.send('sftp:complete', { panelId: msg.panelId, data: msg.data });
        break;
      case 'sftp-error':
        mainWindow.webContents.send('sftp:error', { panelId: msg.panelId, error: msg.error });
        break;
      case 'auto-track':
        mainWindow.webContents.send('ssh:auto-track', { panelId: msg.panelId, enabled: msg.enabled });
        break;
      case 'x11-log':
        // x11 관련 로그를 renderer 콘솔로 — DevTools 에서 확인
        mainWindow.webContents.executeJavaScript(`console.log('[X11]', ${JSON.stringify(msg.data)})`).catch(() => {});
        break;
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 앱 종료 직전 — 띄워놓은 모든 VcXsrv/embedded X 서버 정리
app.on('before-quit', () => {
  try { stopAllBundledX11(); } catch {}
});

// 앱 시작 5초 후 비동기로 session-* 정리 (시작 속도에 영향 없음)
setTimeout(() => {
  try {
    const userDataDir = app.getPath('userData');
    for (const entry of fs.readdirSync(userDataDir)) {
      if (!entry.startsWith('session-')) continue;
      if (entry === `session-${instanceId}`) continue;
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
    title: '세션 저장 경로 선택',
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
    title: '여러 줄 붙여넣기',
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
      <strong>여러 줄 붙여넣기</strong>
      <button id="x">✕</button>
    </div>
    <div class="body">
      <p>다음 텍스트를 붙여넣을까요?</p>
      <textarea id="t" autofocus spellcheck="false"></textarea>
      <div class="actions">
        <button id="c" class="btn-cancel">취소 (Esc)</button>
        <button id="p" class="btn-paste">붙여넣기 (Ctrl+Enter)</button>
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
    title: '옵션',
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
    title: '세션 편집',
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
    title: '검색',
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
      <span class="grip" title="드래그하여 이동">⋮⋮</span>
      <div class="input-wrap">
        <input id="q" type="text" placeholder="검색..." autofocus spellcheck="false" />
        <button class="hist-toggle" id="hist" title="검색 이력" tabindex="-1">▾</button>
      </div>
      <span class="count" id="cnt">0/0</span>
      <button id="prev" title="Previous (Shift+Enter)">▲</button>
      <button id="next" title="Next (Enter)">▼</button>
      <button id="aa" title="대소문자">Aa</button>
      <button id="re" title="정규식">.*</button>
      <div class="mode">
        <button id="m-cur" class="active" title="현재 탭">현재탭</button>
        <button id="m-all" title="전체 탭">전체</button>
      </div>
      <button id="dock" title="앱 안으로 되돌리기">📌</button>
      <button id="x" class="close" title="닫기 (Esc)">✕</button>
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
    title: multi ? '파일 선택 (다중)' : '파일 선택',
    properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
  });
  if (result.canceled) return { paths: [] };
  return { paths: result.filePaths };
});

ipcMain.handle('dialog:pick-folder', async () => {
  if (!mainWindow) return { path: null };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '폴더 선택',
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return { path: null };
  return { path: result.filePaths[0] };
});

ipcMain.handle('fe:list-dir', async (_e, { mode, termId, dirPath }: { mode: string; termId?: string; dirPath: string }) => {
  try {
    const bridge = getSSHBridge();
    if (mode === 'local') {
      return { files: await bridge.handleLocalListDir(dirPath) };
    } else {
      if (!termId) return { error: '연결 ID가 없습니다' };
      return { files: await bridge.handleSFTPListDir(termId, dirPath) };
    }
  } catch (err: any) { return { error: `${dirPath}: ${String(err)}` }; }
});

ipcMain.handle('fe:get-drives', async () => {
  // Windows 드라이브 목록
  if (process.platform === 'win32') {
    const drives: string[] = [];
    for (let i = 65; i <= 90; i++) {
      const d = String.fromCharCode(i) + ':\\';
      try { await fs.promises.access(d); drives.push(d); } catch {}
    }
    return drives;
  }
  return ['/'];
});

ipcMain.handle('fe:get-home', () => {
  return require('os').homedir();
});

ipcMain.handle('fe:transfer', async (_e, { src, dst, filename }: any) => {
  try {
    const bridge = getSSHBridge();
    await bridge.handleTransfer(src, dst, filename);
    return { success: true };
  } catch (err: any) { return { success: false, error: String(err) }; }
});

ipcMain.handle('fe:mkdir', async (_e, { mode, termId, dirPath }: any) => {
  try {
    const bridge = getSSHBridge();
    if (mode === 'local') await bridge.handleLocalMkdir(dirPath);
    else await bridge.handleSFTPMkdir(termId, dirPath);
    return { success: true };
  } catch (err: any) { return { success: false, error: String(err) }; }
});

ipcMain.handle('fe:delete', async (_e, { mode, termId, filePath }: any) => {
  try {
    const bridge = getSSHBridge();
    if (mode === 'local') await bridge.handleLocalDelete(filePath);
    else await bridge.handleSFTPDelete(termId, filePath);
    return { success: true };
  } catch (err: any) { return { success: false, error: String(err) }; }
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
      title: '다운로드 받을 위치 선택',
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
    title: '원격 파일 저장',
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
    title: `${items.length}개 항목 다운로드 — 저장 폴더 선택`,
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
    title: isFolder ? '업로드할 폴더 선택' : (isMulti ? '업로드할 파일 선택 (다중)' : '업로드할 파일 선택'),
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
    shells.push({ name: '명령 프롬프트 (CMD)', path: 'cmd.exe', icon: '▪' });
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

// 셸 별 OSC 7 cwd hook 을 spawn 인자로 주입 — 사용자에게 echo 되지 않음.
// WSL 등 인자로 주입 불가한 케이스는 postSpawnInject 로 첫 프롬프트 후 stdin 주입.
function buildShellLaunch(shellPath: string): { args: string[]; postSpawnInject?: string } {
  const lc = shellPath.toLowerCase();
  // PowerShell (Windows PowerShell 5.1 / pwsh 7+) — [char]27 사용해 호환
  if (lc.includes('powershell') || lc.includes('pwsh')) {
    const psHook = "if (-not $global:__pepePromptOrig) { $global:__pepePromptOrig = $function:prompt }; function global:prompt { [Console]::Write([char]27 + ']7;file:///' + ($PWD.Path -replace '\\\\','/') + [char]27 + '\\'); & $global:__pepePromptOrig }";
    return { args: ['-NoLogo', '-NoExit', '-Command', psHook] };
  }
  // cmd.exe — /K 인자는 echo 안 됨. prompt 명령은 출력 없음.
  if (lc.endsWith('cmd.exe') || lc.endsWith('\\cmd') || lc.endsWith('/cmd')) {
    return { args: ['/K', 'prompt $E]7;file:///$P$E\\$P$G'] };
  }
  // bash (git bash / Linux / macOS) — --init-file 로 임시 rc 사용 (사용자 .bashrc 도 source).
  // 단, WSL 진입용 wsl.exe 는 별도 처리.
  if (lc.endsWith('wsl.exe') || lc.endsWith('\\wsl') || lc.endsWith('/wsl')) {
    // wsl.exe 는 인자로 inner shell 의 init 을 직접 못 줌 (복잡한 escape 필요).
    // 대신 첫 프롬프트 후 stdin 주입으로 fallback. echo 가 한 줄 보일 수 있음.
    const bashHook = " __pepe_osc7() { printf '\\e]7;file://localhost%s\\e\\\\' \"$PWD\"; }; PROMPT_COMMAND=\"__pepe_osc7${PROMPT_COMMAND:+;$PROMPT_COMMAND}\"";
    return { args: [], postSpawnInject: bashHook };
  }
  if (lc.includes('bash') || lc.endsWith('/sh') || lc.endsWith('\\sh.exe')) {
    try {
      const tmpDir = os.tmpdir();
      const rcPath = path.join(tmpDir, `pepe-bashrc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sh`);
      const rcContent = [
        '# pepe-terminal: source user rc files first',
        '[ -f /etc/bash.bashrc ] && . /etc/bash.bashrc',
        '[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"',
        '# pepe cwd auto-track (OSC 7)',
        "__pepe_osc7() { printf '\\e]7;file://localhost%s\\e\\\\' \"$PWD\"; }",
        'PROMPT_COMMAND="__pepe_osc7${PROMPT_COMMAND:+;$PROMPT_COMMAND}"',
      ].join('\n');
      fs.writeFileSync(rcPath, rcContent, 'utf8');
      // bash 종료 후 임시 rc 파일 정리는 OS 의 tmp 정리에 맡김
      return { args: ['--init-file', rcPath] };
    } catch {
      return { args: [] };
    }
  }
  // zsh
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
      return { args: [], postSpawnInject: undefined };
      // zsh 의 경우 ZDOTDIR 는 env 로 전달 — 호출 측에서 setEnv 처리 필요
    } catch {
      return { args: [] };
    }
  }
  return { args: [] };
}

ipcMain.handle('pty:spawn', (_e, { panelId, shell: shellPath, cols, rows, cwd }: { panelId: string; shell?: string; cols?: number; rows?: number; cwd?: string }) => {
  if (ptyProcesses.has(panelId)) return 'already';
  const sh = shellPath || (process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash');
  const launch = buildShellLaunch(sh);
  const proc = pty.spawn(sh, launch.args, {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: cwd || process.env.USERPROFILE || process.env.HOME || '.',
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>,
  });
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

// ── Claude Code CLI 연동 ──
const claudeProcesses: Map<string, any> = new Map();

ipcMain.handle('claude:check', async () => {
  try {
    const { spawn } = require('child_process');
    return await new Promise<{ installed: boolean; version?: string }>(resolve => {
      const proc = spawn('claude', ['--version'], { shell: true });
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

    // npm global bin 을 PATH 에 보강 (Electron 실행 환경에서 누락될 수 있음)
    const extraPaths: string[] = [];
    if (isWin) {
      if (process.env.APPDATA) extraPaths.push(path.join(process.env.APPDATA, 'npm'));
      if (process.env.USERPROFILE) extraPaths.push(path.join(process.env.USERPROFILE, 'AppData', 'Roaming', 'npm'));
      if (process.env.ProgramFiles) extraPaths.push(path.join(process.env.ProgramFiles, 'nodejs'));
    } else {
      extraPaths.push('/usr/local/bin', '/opt/homebrew/bin', path.join(os.homedir(), '.npm-global', 'bin'), path.join(os.homedir(), '.nvm', 'versions'));
    }
    const sep = isWin ? ';' : ':';
    const augmentedPath = [process.env.PATH || '', ...extraPaths].filter(Boolean).join(sep);
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
