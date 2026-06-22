// src/components/SessionEditor.tsx
import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getThemeList, getThemeByName } from '../utils/terminalThemes';
import { getAvailableMonoFonts } from '../utils/monoFonts';
import { isValidHost, normalizeHost } from '../utils/hostValidate';

type LoginScriptRule = {
  expect: string;
  send: string;
  isRegex?: boolean;
};

export type JumpHop = {
  host: string;
  user?: string;
  port?: number;
  password?: string;
};

export type Session = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth?: { type: string; password?: string; keyPath?: string };
  encoding?: string;
  folderId?: string;
  loginScript?: LoginScriptRule[];
  theme?: string;
  fontFamily?: string;
  fontSize?: number;
  scrollback?: number;
  icon?: string;
  initialPath?: string;
  fileTreeEnabled?: boolean;
  autoTrackPwd?: boolean;
  backspaceKeyMode?: 'vt220' | 'ascii127' | 'backspace';
  deleteKeyMode?: 'vt220' | 'ascii127' | 'backspace';
  // 워크스페이스 자동 입력용 경로 — 비어있으면 사용 안 함
  logPath?: string;      // LogAnalyzer 가 이 세션 선택 시 기본 경로
  codePath?: string;     // CompareWorkspace 가 이 세션 선택 시 기본 base 디렉토리
  x11Forward?: boolean;
  x11Display?: number;
  browserUrl?: string;
  jumps?: JumpHop[];
  dbms?: {
    type: 'altibase' | 'mysql' | 'postgres' | 'oracle' | 'mssql' | 'sqlite';
    driverId?: string;
    database?: string;
    useSshTunnel?: boolean;
    urlOverride?: string;
    props?: Record<string, string>;
    port: number;
    user: string;
    password: string;
    host?: string;
  };
  cursorStyle?: 'block' | 'underline' | 'bar' | 'flame' | 'star' | 'heart' | 'circle' | 'rainbow' | 'power' | 'prism';
  cursorBlink?: boolean;
};

export type Folder = {
  id: string;
  name: string;
  parentId?: string;
};

type Props = {
  session?: Session | null;
  folders?: Folder[];
  onSave: (s: Session) => void;
  onCancel: () => void;
  onSaveAndConnect?: (s: Session) => void;
};

export const SessionEditor: React.FC<Props> = ({ session, folders = [], onSave, onCancel, onSaveAndConnect }) => {
  const { t } = useTranslation('sessionEditor');
  const [id] = useState(session?.id ?? `sess-${Date.now()}`);
  const [name, setName] = useState(session?.name ?? 'New Session');
  const [host, setHost] = useState(session?.host ?? '');
  const [port, setPort] = useState(session?.port ?? 22);
  const [username, setUsername] = useState(session?.username ?? '');
  const [authType, setAuthType] = useState(session?.auth?.type ?? 'password');
  const [password, setPassword] = useState(session?.auth?.password ?? '');
  const [keyPath, setKeyPath] = useState(session?.auth?.keyPath ?? '');
  const [encoding, setEncoding] = useState(session?.encoding ?? 'utf-8');
  const [folderId, setFolderId] = useState(session?.folderId ?? '');
  const [loginScript, setLoginScript] = useState<LoginScriptRule[]>(session?.loginScript ?? []);
  const [theme, setTheme] = useState(session?.theme ?? '');
  const [fontFamily, setFontFamily] = useState(session?.fontFamily ?? '');
  const [fontSize, setFontSize] = useState(session?.fontSize ?? 0);
  const [scrollback, setScrollback] = useState(session?.scrollback ?? 0);
  const [icon, setIcon] = useState(session?.icon ?? '🖥️');
  const [initialPath, setInitialPath] = useState(session?.initialPath ?? '');
  const [fileTreeEnabled, setFileTreeEnabled] = useState<boolean>(session?.fileTreeEnabled ?? false);
  const [autoTrackPwd, setAutoTrackPwd] = useState<boolean>(!!session?.autoTrackPwd);
  type KeySeqMode = 'vt220' | 'ascii127' | 'backspace';
  const [backspaceKeyMode, setBackspaceKeyMode] = useState<KeySeqMode>((session?.backspaceKeyMode as KeySeqMode) || 'backspace');
  const [deleteKeyMode, setDeleteKeyMode] = useState<KeySeqMode>((session?.deleteKeyMode as KeySeqMode) || 'vt220');
  const [logPath, setLogPath] = useState(session?.logPath ?? '');
  const [codePath, setCodePath] = useState(session?.codePath ?? '');
  const [x11Forward, setX11Forward] = useState<boolean>(!!session?.x11Forward);
  const [x11Display, setX11Display] = useState<number>(session?.x11Display ?? 0);
  const [browserUrl, setBrowserUrl] = useState(session?.browserUrl ?? '');
  // 다단계 점프 — 편집용 행 배열. host/user/password 는 문자열, port 는 number|'' 로 보관.
  type JumpRow = { host: string; user: string; port: number | ''; password: string };
  const toJumpRows = (sess?: Session | null): JumpRow[] => (sess?.jumps ?? []).map(j => ({
    host: j.host ?? '', user: j.user ?? '', port: (typeof j.port === 'number' ? j.port : ''), password: j.password ?? '',
  }));
  const [jumps, setJumps] = useState<JumpRow[]>(() => toJumpRows(session));
  const [showJumpPw, setShowJumpPw] = useState<Set<number>>(new Set());
  const [dbmsEnabled, setDbmsEnabled] = useState<boolean>(!!session?.dbms);
  const [dbmsPort, setDbmsPort] = useState<number>(session?.dbms?.port ?? 20300);
  const [dbmsUser, setDbmsUser] = useState<string>(session?.dbms?.user ?? '');
  const [dbmsPassword, setDbmsPassword] = useState<string>(session?.dbms?.password ?? '');
  const [dbmsHost, setDbmsHost] = useState<string>(session?.dbms?.host ?? '127.0.0.1');
  const [dbmsDatabase, setDbmsDatabase] = useState<string>(session?.dbms?.database ?? '');
  const [dbmsDriverId, setDbmsDriverId] = useState<string>(session?.dbms?.driverId ?? 'altibase-builtin');
  const [dbmsUseSshTunnel, setDbmsUseSshTunnel] = useState<boolean>(!!session?.dbms?.useSshTunnel);
  const [dbmsUrlEditMode, setDbmsUrlEditMode] = useState<boolean>(!!session?.dbms?.urlOverride);
  const [dbmsUrlOverride, setDbmsUrlOverride] = useState<string>(session?.dbms?.urlOverride ?? '');
  const [showDbmsPassword, setShowDbmsPassword] = useState(false);
  // 등록된 JDBC 드라이버 목록 (Driver Manager 와 동일 소스)
  const [jdbcDrivers, setJdbcDrivers] = useState<any[]>([]);
  useEffect(() => {
    (async () => {
      try {
        const list = await (window as any).api?.jdbcListDrivers?.();
        if (Array.isArray(list)) setJdbcDrivers(list);
      } catch {}
    })();
  }, []);
  const [dbmsTestResult, setDbmsTestResult] = useState<string>('');
  const [dbmsTesting, setDbmsTesting] = useState<boolean>(false);
  const [showIconPicker, setShowIconPicker] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [category, setCategory] = useState<string>('connection');
  const [cursorStyle, setCursorStyle] = useState<'block' | 'underline' | 'bar' | 'flame' | 'star' | 'heart' | 'circle' | 'rainbow' | 'power' | 'prism'>(session?.cursorStyle ?? 'block');
  const [cursorBlink, setCursorBlink] = useState<boolean>(!!session?.cursorBlink);
  const hasConfiguredJumps = () => jumps.some(j => (j.host || '').trim());
  const dbmsRemoteHostForCurrentSession = () => hasConfiguredJumps() ? '127.0.0.1' : (dbmsHost || '127.0.0.1');

  useEffect(() => {
    setName(session?.name ?? 'New Session');
    setHost(session?.host ?? '');
    setPort(session?.port ?? 22);
    setUsername(session?.username ?? '');
    setAuthType(session?.auth?.type ?? 'password');
    setPassword(session?.auth?.password ?? '');
    setKeyPath(session?.auth?.keyPath ?? '');
    setEncoding(session?.encoding ?? 'utf-8');
    setFolderId(session?.folderId ?? '');
    setLoginScript(session?.loginScript ?? []);
    setTheme(session?.theme ?? '');
    setFontFamily(session?.fontFamily ?? '');
    setFontSize(session?.fontSize ?? 0);
    setScrollback(session?.scrollback ?? 0);
    setIcon(session?.icon ?? '🖥️');
    setInitialPath(session?.initialPath ?? '');
    setFileTreeEnabled(session?.fileTreeEnabled ?? false);
    setAutoTrackPwd(!!session?.autoTrackPwd);
    setBackspaceKeyMode((session?.backspaceKeyMode as KeySeqMode) || 'ascii127');
    setDeleteKeyMode((session?.deleteKeyMode as KeySeqMode) || 'vt220');
    setLogPath(session?.logPath ?? '');
    setCodePath(session?.codePath ?? '');
    setX11Forward(!!session?.x11Forward);
    setX11Display(session?.x11Display ?? 0);
    setBrowserUrl(session?.browserUrl ?? '');
    setJumps(toJumpRows(session));
    setShowJumpPw(new Set());
    setDbmsEnabled(!!session?.dbms);
    setDbmsPort(session?.dbms?.port ?? 20300);
    setDbmsUser(session?.dbms?.user ?? '');
    setDbmsPassword(session?.dbms?.password ?? '');
    setDbmsHost(session?.dbms?.host ?? '127.0.0.1');
    setDbmsDatabase(session?.dbms?.database ?? '');
    setDbmsDriverId(session?.dbms?.driverId ?? 'altibase-builtin');
    setDbmsUseSshTunnel(!!session?.dbms?.useSshTunnel);
    setDbmsUrlEditMode(!!session?.dbms?.urlOverride);
    setDbmsUrlOverride(session?.dbms?.urlOverride ?? '');
    setDbmsTestResult('');
  }, [session]);

  const getFolderPath = (f: Folder): string => {
    const parts: string[] = [f.name];
    let current = f;
    while (current.parentId) {
      const parent = folders.find(x => x.id === current.parentId);
      if (!parent) break;
      parts.unshift(parent.name);
      current = parent;
    }
    return parts.join(' / ');
  };

  const iconList = ['🖥️','💻','🌐','🔒','📡','🐧','🪟','🍎','☁️','🗄️','🔧','📂','🏠','🏢','🧪','🚀','⚙️','🛡️','📊','🎯','💾','🔌','📟','🖧'];

  const addRule = () => setLoginScript(prev => [...prev, { expect: '', send: '' }]);
  const removeRule = (idx: number) => setLoginScript(prev => prev.filter((_, i) => i !== idx));
  const updateRule = (idx: number, field: keyof LoginScriptRule, value: any) => {
    setLoginScript(prev => prev.map((r, i) => i === idx ? { ...r, [field]: value } : r));
  };
  const moveRule = (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= loginScript.length) return;
    setLoginScript(prev => {
      const arr = [...prev];
      [arr[idx], arr[target]] = [arr[target], arr[idx]];
      return arr;
    });
  };

  const buildSession = (): Session | null => {
    if (!host || !username) { setSaveError(t('errors.hostUserRequired')); return null; }
    if (!isValidHost(host)) { setSaveError(t('errors.invalidHost')); return null; }
    setSaveError('');
    const auth = authType === 'password' ? { type: 'password', password } : { type: 'key', keyPath };
    const script = loginScript.filter(r => r.expect.trim() !== '' || r.send.trim() !== '');
    // SQL Tool 활성화 체크가 켜져 있으면 user 미입력이어도 dbms 를 저장 — 우클릭 메뉴 노출 보장.
    // (user 가 비면 SqlToolWorkspace 가 연결 시점에 안내)
    // dialect 는 선택된 driverId 에서 추론 (E-6).
    const selectedDriver = jdbcDrivers.find(d => d.id === dbmsDriverId);
    const dialect = (selectedDriver?.dialect || 'altibase') as 'altibase' | 'mysql' | 'postgres' | 'oracle' | 'mssql' | 'sqlite';
    const cleanedJumps: JumpHop[] = [];
    for (const row of jumps) {
      const h = (row.host || '').trim();
      if (!h) break;
      cleanedJumps.push({
        host: h,
        user: (row.user || '').trim() || undefined,
        port: (typeof row.port === 'number' && row.port > 0) ? row.port : undefined,
        password: row.password || undefined,
      });
    }
    const dbms = dbmsEnabled
      ? {
          type: dialect,
          driverId: dbmsDriverId || undefined,
          port: dbmsPort || (selectedDriver?.defaultPort || 20300),
          user: dbmsUser.trim(),
          password: dbmsPassword,
          host: dbmsHost.trim() || '127.0.0.1',
          database: dbmsDatabase.trim() || undefined,
          useSshTunnel: (dbmsUseSshTunnel || cleanedJumps.length > 0) || undefined,
          urlOverride: dbmsUrlEditMode && dbmsUrlOverride.trim() ? dbmsUrlOverride.trim() : undefined,
        }
      : undefined;
    return { id, name, host: normalizeHost(host), port, username, auth, encoding, folderId: folderId || undefined, loginScript: script.length > 0 ? script : undefined, theme: theme || undefined, fontFamily: fontFamily || undefined, fontSize: fontSize || undefined, scrollback: scrollback || undefined, icon: icon || undefined, initialPath: initialPath.trim() || undefined, fileTreeEnabled: fileTreeEnabled || undefined, autoTrackPwd: (fileTreeEnabled && autoTrackPwd) ? true : undefined, backspaceKeyMode, deleteKeyMode, logPath: logPath.trim() || undefined, codePath: codePath.trim() || undefined, x11Forward: x11Forward || undefined, x11Display: x11Forward ? x11Display : undefined, browserUrl: browserUrl.trim() || undefined, jumps: cleanedJumps.length > 0 ? cleanedJumps : undefined, cursorStyle: cursorStyle !== 'block' ? cursorStyle : undefined, cursorBlink: !!cursorBlink, dbms } as Session;
  };
  // ── 점프 행 조작 ──
  const addJump = () => setJumps(prev => [...prev, { host: '', user: '', port: '', password: '' }]);
  const removeJump = (idx: number) => {
    setJumps(prev => prev.filter((_, i) => i !== idx));
    setShowJumpPw(prev => {
      // 제거된 인덱스 이후의 표시 상태를 한 칸씩 당김
      const next = new Set<number>();
      for (const i of prev) { if (i < idx) next.add(i); else if (i > idx) next.add(i - 1); }
      return next;
    });
  };
  const updateJump = (idx: number, patch: Partial<JumpRow>) =>
    setJumps(prev => prev.map((r, i) => i === idx ? { ...r, ...patch } : r));
  const toggleJumpPw = (idx: number) =>
    setShowJumpPw(prev => { const n = new Set(prev); n.has(idx) ? n.delete(idx) : n.add(idx); return n; });

  const save = () => {
    const s = buildSession();
    if (s) onSave(s);
  };
  const saveAndConnect = () => {
    const s = buildSession();
    if (!s) return;
    if (onSaveAndConnect) onSaveAndConnect(s);
    else onSave(s);
  };

  // 모달 드래그 이동 — 헤더 (h3) 잡고 끌기
  const onHeaderMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, input, select, textarea, label')) return;
    e.preventDefault();
    const modal = (e.currentTarget as HTMLElement).parentElement as HTMLElement;
    const rect = modal.getBoundingClientRect();
    const offX = e.clientX - rect.left;
    const offY = e.clientY - rect.top;
    modal.style.position = 'fixed';
    modal.style.left = rect.left + 'px';
    modal.style.top = rect.top + 'px';
    modal.style.transform = 'none';
    modal.style.margin = '0';
    const onMove = (ev: MouseEvent) => {
      modal.style.left = Math.max(0, Math.min(window.innerWidth - rect.width, ev.clientX - offX)) + 'px';
      modal.style.top = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - offY)) + 'px';
    };
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // 카테고리 트리 정의
  const categories: { id: string; label: string; depth: number }[] = [
    { id: 'connection', label: t('categories.connection'), depth: 0 },
    { id: 'auth', label: t('categories.auth'), depth: 1 },
    { id: 'jump', label: t('categories.jump'), depth: 1 },
    { id: 'login-script', label: t('categories.loginScript'), depth: 1 },
    { id: 'terminal', label: t('categories.terminal'), depth: 0 },
    { id: 'appearance', label: t('categories.appearance'), depth: 1 },
    { id: 'keys', label: '키 시퀀스', depth: 1 },
    { id: 'advanced', label: t('categories.advanced'), depth: 0 },
    { id: 'filetree', label: t('categories.filetree'), depth: 1 },
    { id: 'x11', label: t('categories.x11'), depth: 1 },
    { id: 'dbms', label: t('categories.dbms'), depth: 1 },
  ];

  return (
    <div className="session-editor-backdrop">
      <div className="session-editor session-editor-tree" onClick={e => e.stopPropagation()}>
        <h3 style={{ cursor: 'move', userSelect: 'none' }} onMouseDown={onHeaderMouseDown} title={t('dragMove')}>{t('header')}</h3>
        <div className="session-editor-body">
          {/* 좌측 카테고리 트리 */}
          <div className="session-editor-categories">
            {categories.map(c => (
              <div
                key={c.id}
                className={`category-item ${category === c.id ? 'active' : ''}`}
                style={{ paddingLeft: 8 + c.depth * 14 }}
                onClick={() => setCategory(c.id)}
              >{c.label}</div>
            ))}
          </div>
          {/* 우측 콘텐츠 */}
          <div className="session-editor-pane">
            {category === 'connection' && (
              <div className="session-editor-grid">
                <label>{t('fields.icon')}</label>
                <div className="icon-picker-wrapper">
                  <button className="icon-picker-btn" onClick={() => setShowIconPicker(p => !p)} type="button">{icon || '—'}</button>
                  {icon && <button className="icon-clear-btn" onClick={() => setIcon('')} type="button">&times;</button>}
                  {showIconPicker && (
                    <div className="icon-picker-grid">
                      {iconList.map(ic => (
                        <span key={ic} className={`icon-picker-item ${icon === ic ? 'active' : ''}`} onClick={() => { setIcon(ic); setShowIconPicker(false); }}>{ic}</span>
                      ))}
                    </div>
                  )}
                </div>
                <label>{t('fields.name')}</label>
                <input value={name} onChange={e => setName(e.target.value)} />
                <label>{t('fields.folder')}</label>
                <select value={folderId} onChange={e => setFolderId(e.target.value)}>
                  <option value="">{t('fields.rootFolder')}</option>
                  {folders.map(f => (<option key={f.id} value={f.id}>{getFolderPath(f)}</option>))}
                </select>
                <label>{t('fields.host')}</label>
                <input className={host && !isValidHost(host) ? 'invalid' : ''} value={host} onChange={e => setHost(e.target.value)} placeholder={t('placeholders.hostExample')} />
                <label>{t('fields.port')}</label>
                <input type="number" value={port} onChange={e => setPort(Number(e.target.value) || 22)} />
                <label>{t('fields.browserUrl')}</label>
                <input value={browserUrl} onChange={e => setBrowserUrl(e.target.value)} placeholder={t('placeholders.browserUrl')} />
              </div>
            )}
            {category === 'auth' && (
              <div className="session-editor-grid">
                <label>{t('fields.username')}</label>
                <input value={username} onChange={e => setUsername(e.target.value)} placeholder="root" />
                <label>{t('fields.auth')}</label>
                <div className="session-editor-auth">
                  <label><input type="radio" checked={authType === 'password'} onChange={() => setAuthType('password')} /> {t('fields.authPassword')}</label>
                  <label><input type="radio" checked={authType === 'key'} onChange={() => setAuthType('key')} /> {t('fields.authKey')}</label>
                </div>
                {authType === 'password' ? (
                  <>
                    <label>{t('fields.password')}</label>
                    <div className="password-field">
                      <input type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} />
                      <button type="button" className="password-toggle" onClick={() => setShowPassword(p => !p)}>{showPassword ? '🙈' : '👁'}</button>
                    </div>
                  </>
                ) : (
                  <>
                    <label>{t('fields.keyPath')}</label>
                    <input value={keyPath} onChange={e => setKeyPath(e.target.value)} placeholder="~/.ssh/id_rsa" />
                  </>
                )}
              </div>
            )}
            {category === 'jump' && (
              <div className="session-jump-section">
                <div style={{ fontSize: 12, color: '#8aa', marginBottom: 10, lineHeight: 1.5 }}>{t('fields.jumpChainHint')}</div>
                {jumps.length === 0 && (
                  <div style={{ fontSize: 12, color: '#778', fontStyle: 'italic', padding: '8px 0' }}>{t('fields.jumpChainEmpty')}</div>
                )}
                {jumps.map((row, idx) => (
                  <div key={idx} style={{ border: '1px solid #2a3a50', borderRadius: 6, padding: '10px 12px', marginBottom: 10, background: '#10161f' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: '#9cf' }}>{t('fields.jumpHopTitle', { n: idx + 1 })}</span>
                      <button type="button" onClick={() => removeJump(idx)} style={{ background: 'transparent', border: '1px solid #5a3a3a', color: '#e88', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontSize: 11 }}>{t('fields.jumpHopRemove')}</button>
                    </div>
                    <div className="session-editor-grid">
                      <label>{t('fields.jumpTargetHost')}</label>
                      <input type="text" value={row.host} onChange={e => updateJump(idx, { host: e.target.value })} placeholder={t('placeholders.jumpTargetHost')} />
                      <label>{t('fields.jumpTargetUser')}</label>
                      <input type="text" value={row.user} onChange={e => updateJump(idx, { user: e.target.value })} placeholder={t('placeholders.jumpTargetUser')} disabled={!row.host.trim()} />
                      <label>{t('fields.jumpTargetPort')}</label>
                      <input type="number" value={row.port} onChange={e => updateJump(idx, { port: Number(e.target.value) || '' })} placeholder="22" disabled={!row.host.trim()} min={1} max={65535} />
                      <label>{t('fields.jumpTargetPassword')}</label>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <input type={showJumpPw.has(idx) ? 'text' : 'password'} value={row.password} onChange={e => updateJump(idx, { password: e.target.value })} placeholder={t('placeholders.jumpTargetPassword')} disabled={!row.host.trim()} style={{ flex: 1 }} autoComplete="off" />
                        <button type="button" onClick={() => toggleJumpPw(idx)} disabled={!row.host.trim()}>{showJumpPw.has(idx) ? '🙈' : '👁'}</button>
                      </div>
                    </div>
                  </div>
                ))}
                <button type="button" onClick={addJump} style={{ background: '#1a2a3a', border: '1px solid #3a5075', color: '#9cf', borderRadius: 6, padding: '6px 14px', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>{t('fields.jumpHopAdd')}</button>
              </div>
            )}
            {category === 'login-script' && (
              <div className="login-script-section">
                <div className="login-script-header">
                  <span className="login-script-title">{t('fields.loginScript')}</span>
                  <button className="login-script-add" onClick={addRule}>{t('fields.addRule')}</button>
                </div>
                {loginScript.length > 0 && (
                  <div className="login-script-list">
                    <div className="login-script-labels"><span>{t('fields.expect')}</span><span>{t('fields.send')}</span><span></span></div>
                    {loginScript.map((rule, idx) => (
                      <div key={idx} className="login-script-rule">
                        <input className="login-script-input" value={rule.expect} onChange={e => updateRule(idx, 'expect', e.target.value)} placeholder='e.g. password:' />
                        <input className="login-script-input" value={rule.send} onChange={e => updateRule(idx, 'send', e.target.value)} placeholder='e.g. mypassword' />
                        <div className="login-script-rule-actions">
                          <label className="login-script-regex"><input type="checkbox" checked={rule.isRegex ?? false} onChange={e => updateRule(idx, 'isRegex', e.target.checked)} /><span>.*</span></label>
                          <button className="login-script-move" onClick={() => moveRule(idx, -1)} disabled={idx === 0}>&#9650;</button>
                          <button className="login-script-move" onClick={() => moveRule(idx, 1)} disabled={idx === loginScript.length - 1}>&#9660;</button>
                          <button className="login-script-remove" onClick={() => removeRule(idx)}>&times;</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {category === 'terminal' && (
              <div className="session-editor-grid">
                <label>{t('fields.encoding')}</label>
                <select value={encoding} onChange={e => setEncoding(e.target.value)}>
                  <option value="utf-8">utf-8</option>
                  <option value="cp949">cp949</option>
                  <option value="euc-kr">euc-kr</option>
                  <option value="latin1">latin1</option>
                </select>
                <label>{t('fields.scrollback')}</label>
                <input type="number" value={scrollback || ''} onChange={e => setScrollback(Number(e.target.value) || 0)} placeholder={t('fields.globalDefault')} min={1000} max={1000000} step={1000} />
              </div>
            )}
            {category === 'appearance' && (() => {
              const previewTheme: any = theme ? getThemeByName(theme) : getThemeByName('Default Dark');
              const bg = (previewTheme.background as string) || '#000';
              const fg = (previewTheme.foreground as string) || '#eee';
              const cur = (previewTheme.cursor as string) || fg;
              const c = (k: string) => (previewTheme[k] as string) || fg;
              const previewFont = fontFamily || 'Cascadia Code, Consolas, monospace';
              // 미리보기 글자 크기는 사용자 fontSize 와 무관하게 고정 (가독성 유지)
              const previewSize = 13;
              // 커서 미리보기 스타일 — span 으로 표시할 항목과 별도 emoji 오버레이
              const blinkCss = cursorBlink ? 'blink 1s step-end infinite' : undefined;
              let cursorStyleSpan: React.CSSProperties = { background: cur, color: bg, padding: '0 2px', animation: blinkCss };
              let cursorEmojiOverlay: string | null = null;
              if (cursorStyle === 'bar') cursorStyleSpan = { borderLeft: `2px solid ${cur}`, color: fg, padding: '0 2px 0 0', animation: blinkCss };
              else if (cursorStyle === 'underline') cursorStyleSpan = { borderBottom: `2px solid ${cur}`, color: fg, animation: blinkCss };
              // 효과 커서(flame/star/heart/circle/rainbow/power) — 실제 동작은 네이티브 block 커서 위에서
              // 테마별 파티클이 분사되는 hyperpower 스타일. 프리뷰도 일관되게 block 으로 표시.
              else if (['flame', 'star', 'heart', 'circle', 'rainbow', 'power'].includes(cursorStyle)) {
                cursorStyleSpan = { background: cur, color: bg, padding: '0 2px', animation: blinkCss };
              }
              // prism: 무지개 그라데이션이 흐르는 반짝이는 블록 (실제 효과는 터미널에서 적용)
              else if (cursorStyle === 'prism') cursorStyleSpan = {
                background: 'linear-gradient(90deg,#ff0000,#ff9900,#ffff00,#00ff00,#00ccff,#3366ff,#cc00ff)',
                backgroundSize: '300% 100%', color: '#fff',
                padding: '0 2px', textShadow: '0 0 3px rgba(0,0,0,0.6)',
                animation: 'rainbow-shift 2s linear infinite',
              };
              return (
                <>
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ color: '#aaa', fontSize: 12, marginBottom: 6 }}>{t('preview')}</div>
                    <div style={{
                      background: bg, color: fg, padding: 12, borderRadius: 4, border: '1px solid #333',
                      fontFamily: previewFont, fontSize: previewSize, lineHeight: 1.4,
                    }}>
                      <div>
                        <span style={{ color: fg }}>Normal </span>
                        <span style={{ color: fg, fontWeight: 'bold' }}>Bold </span>
                        <span style={{ color: fg, textDecoration: 'underline' }}>Underline </span>
                        <span style={{ background: fg, color: bg, padding: '0 2px' }}>Reversed </span>
                        <span style={cursorStyleSpan}>{cursorEmojiOverlay ?? 'Cursor'}</span>
                      </div>
                      <div>
                        <span style={{ color: c('black') }}>black </span>
                        <span style={{ color: c('red') }}>red </span>
                        <span style={{ color: c('green') }}>green </span>
                        <span style={{ color: c('yellow') }}>yellow </span>
                        <span style={{ color: c('blue') }}>blue </span>
                        <span style={{ color: c('magenta') }}>magenta </span>
                        <span style={{ color: c('cyan') }}>cyan </span>
                        <span style={{ color: c('white') }}>white</span>
                      </div>
                      <div>
                        <span style={{ color: c('brightBlack') }}>black </span>
                        <span style={{ color: c('brightRed'), fontWeight: 'bold' }}>red </span>
                        <span style={{ color: c('brightGreen'), fontWeight: 'bold' }}>green </span>
                        <span style={{ color: c('brightYellow'), fontWeight: 'bold' }}>yellow </span>
                        <span style={{ color: c('brightBlue'), fontWeight: 'bold' }}>blue </span>
                        <span style={{ color: c('brightMagenta'), fontWeight: 'bold' }}>magenta </span>
                        <span style={{ color: c('brightCyan'), fontWeight: 'bold' }}>cyan </span>
                        <span style={{ color: c('brightWhite'), fontWeight: 'bold' }}>white</span>
                      </div>
                    </div>
                  </div>
                  <div className="session-editor-grid">
                    <label>{t('fields.theme')}</label>
                    <select value={theme} onChange={e => setTheme(e.target.value)}>
                      <option value="">{t('fields.globalDefault')}</option>
                      {getThemeList().map(th => <option key={th} value={th}>{th}</option>)}
                    </select>
                    <label>{t('fields.fontFamily')}</label>
                    <select value={fontFamily} onChange={e => setFontFamily(e.target.value)}>
                      <option value="">{t('fields.globalDefault')}</option>
                      {getAvailableMonoFonts().map(f => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
                    </select>
                    <label>{t('fields.fontSize')}</label>
                    <input type="number" value={fontSize || ''} onChange={e => setFontSize(Number(e.target.value) || 0)} placeholder={t('fields.globalDefault')} min={8} max={40} />
                    <label>{t('fields.cursorStyle')}</label>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      {[
                        { id: 'block', label: t('cursor.block') },
                        { id: 'underline', label: t('cursor.underline') },
                        { id: 'bar', label: t('cursor.bar') },
                        { id: 'prism', label: t('cursor.prism') },
                        { id: 'flame', label: t('cursor.flame') },
                        { id: 'star', label: t('cursor.star') },
                        { id: 'heart', label: t('cursor.heart') },
                        { id: 'circle', label: t('cursor.circle') },
                        { id: 'rainbow', label: t('cursor.rainbow') },
                        { id: 'power', label: t('cursor.power') },
                      ].map(opt => (
                        <button key={opt.id} type="button" onClick={() => setCursorStyle(opt.id as any)}
                          style={{ padding: '4px 10px', background: cursorStyle === opt.id ? '#2b6b9b' : '#333', color: '#eee', border: '1px solid #555', borderRadius: 3, cursor: 'pointer' }}>
                          {opt.label}
                        </button>
                      ))}
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 8, cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap', flexShrink: 0 }}>
                        <input type="checkbox" checked={cursorBlink} onChange={e => setCursorBlink(e.target.checked)} />
                        <span style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{t('fields.cursorBlink')}</span>
                      </label>
                    </div>
                  </div>
                </>
              );
            })()}
            {category === 'keys' && (() => {
              const opts: { value: KeySeqMode; label: string }[] = [
                { value: 'vt220', label: 'VT220 Del (Esc[3~)' },
                { value: 'ascii127', label: 'ASCII 127 (Ctrl+?)' },
                { value: 'backspace', label: 'Backspace (Ctrl+H)' },
              ];
              return (
                <div style={{ display: 'flex', gap: 20, padding: '8px 4px' }}>
                  <fieldset style={{ flex: 1, border: '1px solid #444', borderRadius: 4, padding: '8px 12px' }}>
                    <legend style={{ padding: '0 6px', color: '#bbb', fontSize: 12 }}>Delete 키 시퀀스</legend>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {opts.map(o => (
                        <label key={o.value} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12 }}>
                          <input type="radio" name="deleteKeyMode" value={o.value} checked={deleteKeyMode === o.value} onChange={() => setDeleteKeyMode(o.value)} />
                          {o.label}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <fieldset style={{ flex: 1, border: '1px solid #444', borderRadius: 4, padding: '8px 12px' }}>
                    <legend style={{ padding: '0 6px', color: '#bbb', fontSize: 12 }}>Backspace 키 시퀀스</legend>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {opts.map(o => (
                        <label key={o.value} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12 }}>
                          <input type="radio" name="backspaceKeyMode" value={o.value} checked={backspaceKeyMode === o.value} onChange={() => setBackspaceKeyMode(o.value)} />
                          {o.label}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                </div>
              );
            })()}
            {category === 'advanced' && (
              <div className="session-editor-grid">
                <label title="LogAnalyzer 에서 이 세션 선택 시 자동으로 채울 로그 파일 경로">로그 위치</label>
                <input
                  type="text"
                  value={logPath}
                  onChange={e => setLogPath(e.target.value)}
                  placeholder="예: /var/log/myapp/app.log"
                />
                <label title="파일 비교 워크스페이스에서 이 세션 선택 시 자동으로 채울 base 디렉토리">코드 위치</label>
                <input
                  type="text"
                  value={codePath}
                  onChange={e => setCodePath(e.target.value)}
                  placeholder="예: /home/user/project/src"
                />
              </div>
            )}
            {category === 'filetree' && (
              <div className="session-editor-grid">
                <label>{t('fields.initialPath')}</label>
                <input type="text" value={initialPath} onChange={e => setInitialPath(e.target.value)} placeholder={t('placeholders.initialPath')} />
                <label>파일트리 보여주기</label>
                <label style={{ display: 'inline-flex', alignItems: 'center', cursor: 'pointer', justifySelf: 'start' }}>
                  <input
                    type="checkbox"
                    checked={fileTreeEnabled}
                    onChange={e => {
                      const v = e.target.checked;
                      setFileTreeEnabled(v);
                      if (!v) setAutoTrackPwd(false);
                    }}
                    style={{ margin: 0 }}
                  />
                </label>
                <label
                  style={{ opacity: fileTreeEnabled ? 1 : 0.45, cursor: fileTreeEnabled ? 'pointer' : 'not-allowed' }}
                  title={!fileTreeEnabled ? '파일트리 보여주기가 켜져 있어야 사용 가능' : '터미널에서 cd 시 파일트리 경로 자동 갱신'}
                >파일트리 자동추적</label>
                <label
                  style={{ display: 'inline-flex', alignItems: 'center', cursor: fileTreeEnabled ? 'pointer' : 'not-allowed', justifySelf: 'start', opacity: fileTreeEnabled ? 1 : 0.45 }}
                  title={!fileTreeEnabled ? '파일트리 보여주기가 켜져 있어야 사용 가능' : '터미널에서 cd 시 파일트리 경로 자동 갱신'}
                >
                  <input
                    type="checkbox"
                    checked={autoTrackPwd && fileTreeEnabled}
                    disabled={!fileTreeEnabled}
                    onChange={e => setAutoTrackPwd(e.target.checked)}
                    style={{ margin: 0 }}
                  />
                </label>
              </div>
            )}
            {category === 'x11' && (
              <div className="session-editor-grid">
                <label>{t('fields.x11Forward')}</label>
                <div className="x11-forwarding-row">
                  <input type="checkbox" checked={x11Forward} onChange={e => setX11Forward(e.target.checked)} />
                  {x11Forward && (
                    <>
                      <span className="x11-label">{t('fields.x11DisplayLabel')}</span>
                      <input type="number" min={0} max={99} value={x11Display} onChange={e => setX11Display(Math.max(0, parseInt(e.target.value) || 0))} className="x11-display-input" />
                      <span className="x11-hint">→ localhost:{6000 + x11Display}</span>
                    </>
                  )}
                  <span className="autotrack-info-icon" title={t('tooltips.x11Info')}>ⓘ</span>
                </div>
              </div>
            )}
            {category === 'dbms' && (() => {
              const selectedDriver = jdbcDrivers.find(d => d.id === dbmsDriverId);
              // URL 자동 합성: 템플릿의 {host}/{port}/{database} 치환. 직접 편집 모드면 override 우선.
              const composedUrl = selectedDriver?.urlTemplate
                ? selectedDriver.urlTemplate
                    .replace('{host}', dbmsHost || '127.0.0.1')
                    .replace('{port}', String(dbmsPort || selectedDriver.defaultPort || 0))
                    .replace('{database}', dbmsDatabase || '')
                    .replace(/\/+$/, '')  // database 미지정으로 끝에 남는 빈 슬래시 제거
                : '';
              const effectiveUrl = dbmsUrlEditMode && dbmsUrlOverride ? dbmsUrlOverride : composedUrl;
              const driverUsable = selectedDriver?.diag?.usable;
              const runTest = async () => {
                if (!selectedDriver) { setDbmsTestResult('❌ 드라이버 미선택'); return; }
                if (!driverUsable) { setDbmsTestResult('❌ 드라이버 JAR 누락 — 드라이버 관리자에서 JAR 추가 필요'); return; }
                setDbmsTesting(true);
                setDbmsTestResult('테스트 중...');
                const cid = `test-${Date.now().toString(36)}`;
                const api: any = (window as any).api || {};
                let testUrl = effectiveUrl;
                let forwardId = '';
                try {
                  // SSH 터널 사용 시 — 로컬 포워드 열고 URL 의 host:port 를 127.0.0.1:localPort 로 재작성
                  const forceSshTunnel = hasConfiguredJumps();
                  const useSshTunnel = dbmsUseSshTunnel || forceSshTunnel;
                  if (useSshTunnel && session?.id) {
                    if (typeof api.sshOpenLocalForward !== 'function') {
                      setDbmsTestResult('❌ SSH 터널 IPC 미등록 — Electron 메인 재시작 필요'); return;
                    }
                    setDbmsTestResult('SSH 터널 여는 중...');
                    const remoteHost = dbmsRemoteHostForCurrentSession();
                    const remotePort = dbmsPort || selectedDriver?.defaultPort || 0;
                    const fwd = await api.sshOpenLocalForward({
                      sessionId: session.id,
                      remoteHost,
                      remotePort,
                      sshHost: host,
                      sshPort: parseInt(String(port || '22'), 10) || 22,
                    });
                    console.log('[SessionEditor] sshOpenLocalForward =', fwd);
                    if (!fwd?.success) {
                      setDbmsTestResult(`❌ SSH 터널 실패: ${fwd?.error || '?'} — 먼저 같은 세션 터미널 연결 필요`); return;
                    }
                    forwardId = fwd.forwardId;
                    // 원래 호스트:포트를 127.0.0.1:localPort 로 치환
                    const orig = `${dbmsHost || '127.0.0.1'}:${dbmsPort || selectedDriver?.defaultPort || 0}`;
                    testUrl = effectiveUrl.replace(orig, `127.0.0.1:${fwd.localPort}`);
                    setDbmsTestResult(`SSH 터널 OK (${remoteHost}:${remotePort} → local=${fwd.localPort}) — JDBC 테스트 중...`);
                  }
                  const cr = await api.jdbcConnect?.({
                    connectionId: cid,
                    driver: selectedDriver,
                    url: testUrl,
                    user: dbmsUser,
                    password: dbmsPassword,
                  });
                  if (!cr?.success) { setDbmsTestResult(`❌ ${cr?.error || '?'} (URL: ${testUrl})`); return; }
                  const info = cr.result || {};
                  setDbmsTestResult(`✅ ${info.productName || ''} ${info.productVersion || ''} (driver: ${info.driverName || '?'})${forwardId ? ' [via SSH tunnel]' : ''}`);
                  await api.jdbcDisconnect?.(cid);
                } catch (e: any) {
                  setDbmsTestResult(`❌ 예외: ${e?.message || e}`);
                } finally {
                  if (forwardId) { try { await api.sshCloseLocalForward?.({ forwardId }); } catch {} }
                  setDbmsTesting(false);
                }
              };
              return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <label className="dbms-checkbox-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input type="checkbox" checked={dbmsEnabled} onChange={e => setDbmsEnabled(e.target.checked)} />
                  <span>{t('fields.sqlToolEnable')}</span>
                </label>
                <div className="session-editor-grid">
                  <label>JDBC 드라이버</label>
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    <select
                      value={dbmsDriverId}
                      onChange={e => {
                        const next = e.target.value;
                        setDbmsDriverId(next);
                        // 새 드라이버 선택 시 기본 포트 채택 (사용자가 직접 바꿨으면 유지)
                        const d = jdbcDrivers.find(x => x.id === next);
                        if (d?.defaultPort && d.defaultPort > 0) setDbmsPort(d.defaultPort);
                      }}
                      disabled={!dbmsEnabled}
                      style={{ flex: 1 }}
                    >
                      {jdbcDrivers.length === 0 && <option value="">(로딩...)</option>}
                      {jdbcDrivers.map(d => (
                        <option key={d.id} value={d.id}>
                          {d.diag?.usable ? '✓' : '⚠'} {d.name} [{d.dialect}]
                        </option>
                      ))}
                    </select>
                  </div>

                  <label>호스트</label>
                  <input type="text" value={dbmsHost} onChange={e => setDbmsHost(e.target.value)} placeholder="127.0.0.1" disabled={!dbmsEnabled} />
                  <label>포트</label>
                  <input type="number" value={dbmsPort} onChange={e => setDbmsPort(Number(e.target.value) || 0)} placeholder={String(selectedDriver?.defaultPort || 0)} disabled={!dbmsEnabled} min={1} max={65535} />
                  <label>Database</label>
                  <input type="text" value={dbmsDatabase} onChange={e => setDbmsDatabase(e.target.value)} placeholder={selectedDriver?.dialect === 'sqlite' ? '/path/to/file.db' : 'mydb'} disabled={!dbmsEnabled} />
                  <label>사용자</label>
                  <input type="text" value={dbmsUser} onChange={e => setDbmsUser(e.target.value)} placeholder="ipageon" disabled={!dbmsEnabled} autoComplete="off" />
                  <label>비밀번호</label>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <input type={showDbmsPassword ? 'text' : 'password'} value={dbmsPassword} onChange={e => setDbmsPassword(e.target.value)} disabled={!dbmsEnabled} style={{ flex: 1 }} autoComplete="off" />
                    <button type="button" onClick={() => setShowDbmsPassword(v => !v)} disabled={!dbmsEnabled}>{showDbmsPassword ? '🙈' : '👁'}</button>
                  </div>
                  <label>SSH 터널</label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#bbb', fontSize: 12 }}>
                    <input type="checkbox" checked={dbmsUseSshTunnel || hasConfiguredJumps()} onChange={e => setDbmsUseSshTunnel(e.target.checked)} disabled={!dbmsEnabled || hasConfiguredJumps()} />
                    <span>{hasConfiguredJumps() ? '점프 최종 SSH 장비 기준으로 JDBC 접속' : 'SSH 세션 위에 포트 포워딩 후 로컬에서 JDBC 접속'}</span>
                  </label>
                </div>

                <div style={{ background: '#1e1e1e', border: '1px solid #333', borderRadius: 3, padding: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontWeight: 600, fontSize: 12, color: '#9cdcfe' }}>JDBC URL</span>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#aaa', fontSize: 11 }}>
                      <input type="checkbox" checked={dbmsUrlEditMode} onChange={e => { setDbmsUrlEditMode(e.target.checked); if (e.target.checked && !dbmsUrlOverride) setDbmsUrlOverride(composedUrl); }} disabled={!dbmsEnabled} />
                      <span>직접 입력</span>
                    </label>
                    {!dbmsUrlEditMode && composedUrl && (
                      <button type="button" onClick={() => navigator.clipboard.writeText(composedUrl)} style={{ marginLeft: 'auto', background: 'transparent', color: '#aaa', border: '1px solid #444', padding: '1px 6px', borderRadius: 2, cursor: 'pointer', fontSize: 11 }}>복사</button>
                    )}
                  </div>
                  {dbmsUrlEditMode ? (
                    <input type="text" value={dbmsUrlOverride} onChange={e => setDbmsUrlOverride(e.target.value)} disabled={!dbmsEnabled} style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'monospace', fontSize: 12 }} />
                  ) : (
                    <code style={{ color: '#d4d4d4', fontSize: 12, fontFamily: 'monospace', wordBreak: 'break-all' }}>{composedUrl || '(드라이버 선택 필요)'}</code>
                  )}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button type="button" onClick={runTest} disabled={!dbmsEnabled || dbmsTesting || !selectedDriver} style={{ background: '#3a7d3a', color: '#fff', border: 0, padding: '5px 12px', borderRadius: 3, cursor: dbmsTesting ? 'wait' : 'pointer', fontSize: 12 }}>
                    {dbmsTesting ? '...' : '🔌 테스트 연결'}
                  </button>
                  {dbmsTestResult && (
                    <span style={{ color: dbmsTestResult.startsWith('✅') ? '#5fb55f' : (dbmsTestResult.startsWith('테스트') ? '#bbb' : '#fcc'), fontSize: 12, fontFamily: 'monospace' }}>{dbmsTestResult}</span>
                  )}
                </div>
              </div>
              );
            })()}
          </div>
        </div>

        <div className="session-editor-actions">
          {saveError && <span className="session-editor-error">{saveError}</span>}
          <button className="btn-cancel" onClick={onCancel}>{t('actions.close')}</button>
          <button className="btn-save" onClick={save} title={t('tooltips.applyTitle')}>{t('actions.apply')}</button>
          <button className="btn-save" style={{ background: '#2b9b6b', borderColor: '#3ac88b' }} onClick={saveAndConnect} title={t('tooltips.connectTitle')}>{t('actions.connect')}</button>
        </div>
      </div>
    </div>
  );
};
