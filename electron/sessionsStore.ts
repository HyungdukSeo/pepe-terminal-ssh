// electron/sessionsStore.ts
import fs from 'fs';
import path from 'path';
import { app } from 'electron';

export type LoginScriptRule = {
  expect: string;
  send: string;
  isRegex?: boolean;
};

export type Session = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth?: { type: 'password'; password: string } | { type: 'key'; keyPath: string };
  encoding?: string;
  folderId?: string;
  loginScript?: LoginScriptRule[];
  theme?: string;
  fontFamily?: string;
  fontSize?: number;
  scrollback?: number;
  icon?: string;
  initialPath?: string; // SSH 연결 시 파일 트리 초기 경로 (없으면 홈 디렉토리)
  fileTreeEnabled?: boolean; // 세션 연결 즉시 파일트리(SFTP) 자동 연결. false 면 사용자가 버튼으로 명시 연결할 때까지 SFTP 안 열림.
  autoTrackPwd?: boolean; // 터미널에서 cd 하면 파일 트리 경로 자동 갱신 (파일트리가 연결되어 있을 때만 의미 있음)
  // 터미널 키 시퀀스 (stty-like) — 세션별 설정. 미설정이면 xterm 기본.
  backspaceKeyMode?: 'vt220' | 'ascii127' | 'backspace'; // VT220 Del(Esc[3~) / ASCII 127(0x7F) / Backspace(0x08)
  deleteKeyMode?: 'vt220' | 'ascii127' | 'backspace';
  logPath?: string;  // LogAnalyzer 가 이 세션 선택 시 자동으로 채울 로그 파일 경로
  codePath?: string; // CompareWorkspace 가 이 세션 선택 시 자동으로 채울 base 디렉토리
  x11Forward?: boolean; // X11 forwarding 활성화 (원격 GUI 앱 → 로컬 X 서버)
  x11Display?: number;  // 로컬 X 서버 display 번호 (기본 0 → localhost:6000)
  // 점프 호스트 설정 (ProxyJump). 채우면 primary 호스트를 경유해서 점프 타겟으로 SSH+SFTP 직결.
  // primary 호스트의 ~/.ssh/ 에 등록된 키를 자동으로 읽어서 점프 타겟 인증에 재사용.
  // 비우면 기존처럼 primary 직접 연결.
  jumpTargetHost?: string;  // 예: "I-MPM01"
  jumpTargetUser?: string;  // 예: "root"
  jumpTargetPort?: number;  // 기본 22
  jumpTargetPassword?: string; // 있으면 비밀번호 인증, 비어 있으면 primary 의 ~/.ssh/id_rsa 등 자동 사용
  // DBMS (Altibase) 연결 정보 — 채우면 우클릭 메뉴에 "SQL Tool" 노출됨.
  // 동일 SSH 연결의 exec 채널로 isql 을 실행해서 DB 쿼리.
  dbms?: {
    type: 'altibase';
    port: number;       // 기본 20300
    user: string;
    password: string;
    host?: string;      // 기본 127.0.0.1 (SSH 연결한 서버 내부에서 isql 실행)
  };
};

export type Folder = {
  id: string;
  name: string;
  parentId?: string;
};

export type SessionsData = {
  folders: Folder[];
  sessions: Session[];
  childOrder?: Record<string, string[]>; // parentId → 자식 ID 목록 (폴더+세션 혼합 순서)
};

let customSessionsPath: string | null = null;

function getConfigPath(): string {
  try { return path.join(app.getPath('userData'), 'config.json'); }
  catch { return path.join(process.cwd(), 'config.json'); }
}

export function loadCustomPath(): string | null {
  try {
    const cfg = JSON.parse(fs.readFileSync(getConfigPath(), 'utf8'));
    return cfg.sessionsPath || null;
  } catch { return null; }
}

export function saveCustomPath(p: string | null) {
  customSessionsPath = p;
  const cfgPath = getConfigPath();
  let cfg: any = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
  cfg.sessionsPath = p || undefined;
  const dir = path.dirname(cfgPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
}

export function loadUIPrefs(): Record<string, any> {
  try {
    const cfg = JSON.parse(fs.readFileSync(getConfigPath(), 'utf8'));
    return (cfg && typeof cfg.uiPrefs === 'object' && cfg.uiPrefs) ? cfg.uiPrefs : {};
  } catch { return {}; }
}

export function saveUIPrefs(prefs: Record<string, any>) {
  const cfgPath = getConfigPath();
  let cfg: any = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
  cfg.uiPrefs = { ...(cfg.uiPrefs || {}), ...prefs };
  const dir = path.dirname(cfgPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
}

export function getSessionsPath(): string {
  if (customSessionsPath) return customSessionsPath;
  const loaded = loadCustomPath();
  if (loaded) { customSessionsPath = loaded; return loaded; }
  try {
    return path.join(app.getPath('userData'), 'sessions.json');
  } catch {
    return path.join(process.cwd(), 'sessions.json');
  }
}

// fileTreeEnabled/autoTrackPwd 옵션 분리 이전에 만든 세션 마이그레이션.
// 과거엔 autoTrackPwd 만으로 파일트리 자동연결+추적이 동작했으므로,
// autoTrackPwd=true 이고 fileTreeEnabled 가 미설정(undefined)이면 fileTreeEnabled 도 true 로 본다.
// (안 하면 신규 게이트 `autoTrackPwd && fileTreeEnabled` 에서 추적이 꺼져 /vobs 등 cwd 추적이 안 됨)
function migrateSessions(sessions: Session[]): Session[] {
  // 신규 UI 는 fileTreeEnabled 가 꺼지면 autoTrackPwd 체크박스를 비활성화하므로
  // {autoTrackPwd:true, fileTreeEnabled:false/undefined} 조합은 과거 데이터(또는 전환기)에서만 발생.
  // autoTrack 이 켜져 있으면 파일트리도 켜진 것으로 정규화한다.
  for (const s of sessions) {
    if (s && s.autoTrackPwd === true && s.fileTreeEnabled !== true) {
      s.fileTreeEnabled = true;
    }
  }
  return sessions;
}

export function loadSessionsData(): SessionsData {
  const filePath = getSessionsPath();
  if (!fs.existsSync(filePath)) return { folders: [], sessions: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    // 기존 flat array 마이그레이션
    if (Array.isArray(raw)) return { folders: [], sessions: migrateSessions(raw) };
    return { folders: raw.folders ?? [], sessions: migrateSessions(raw.sessions ?? []), childOrder: raw.childOrder ?? undefined };
  } catch {
    return { folders: [], sessions: [] };
  }
}

export function saveSessionsData(data: SessionsData) {
  const filePath = getSessionsPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}
