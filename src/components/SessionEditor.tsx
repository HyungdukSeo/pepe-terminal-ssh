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
  autoTrackPwd?: boolean;
  x11Forward?: boolean;
  x11Display?: number;
  jumpTargetHost?: string;
  jumpTargetUser?: string;
  jumpTargetPort?: number;
  jumpTargetPassword?: string;
  dbms?: {
    type: 'altibase';
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
  const [autoTrackPwd, setAutoTrackPwd] = useState<boolean>(!!session?.autoTrackPwd);
  const [x11Forward, setX11Forward] = useState<boolean>(!!session?.x11Forward);
  const [x11Display, setX11Display] = useState<number>(session?.x11Display ?? 0);
  const [jumpTargetHost, setJumpTargetHost] = useState(session?.jumpTargetHost ?? '');
  const [jumpTargetUser, setJumpTargetUser] = useState(session?.jumpTargetUser ?? '');
  const [jumpTargetPort, setJumpTargetPort] = useState<number | ''>(session?.jumpTargetPort ?? '');
  const [jumpTargetPassword, setJumpTargetPassword] = useState(session?.jumpTargetPassword ?? '');
  const [showJumpPassword, setShowJumpPassword] = useState(false);
  const [dbmsEnabled, setDbmsEnabled] = useState<boolean>(!!session?.dbms);
  const [dbmsPort, setDbmsPort] = useState<number>(session?.dbms?.port ?? 20300);
  const [dbmsUser, setDbmsUser] = useState<string>(session?.dbms?.user ?? '');
  const [dbmsPassword, setDbmsPassword] = useState<string>(session?.dbms?.password ?? '');
  const [dbmsHost, setDbmsHost] = useState<string>(session?.dbms?.host ?? '127.0.0.1');
  const [showDbmsPassword, setShowDbmsPassword] = useState(false);
  const [showIconPicker, setShowIconPicker] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [category, setCategory] = useState<string>('connection');
  const [cursorStyle, setCursorStyle] = useState<'block' | 'underline' | 'bar' | 'flame' | 'star' | 'heart' | 'circle' | 'rainbow' | 'power' | 'prism'>(session?.cursorStyle ?? 'block');
  const [cursorBlink, setCursorBlink] = useState<boolean>(!!session?.cursorBlink);

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
    setAutoTrackPwd(!!session?.autoTrackPwd);
    setX11Forward(!!session?.x11Forward);
    setX11Display(session?.x11Display ?? 0);
    setJumpTargetHost(session?.jumpTargetHost ?? '');
    setJumpTargetUser(session?.jumpTargetUser ?? '');
    setJumpTargetPort(session?.jumpTargetPort ?? '');
    setJumpTargetPassword(session?.jumpTargetPassword ?? '');
    setDbmsEnabled(!!session?.dbms);
    setDbmsPort(session?.dbms?.port ?? 20300);
    setDbmsUser(session?.dbms?.user ?? '');
    setDbmsPassword(session?.dbms?.password ?? '');
    setDbmsHost(session?.dbms?.host ?? '127.0.0.1');
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
    const dbms = dbmsEnabled && dbmsUser.trim()
      ? { type: 'altibase' as const, port: dbmsPort || 20300, user: dbmsUser.trim(), password: dbmsPassword, host: dbmsHost.trim() || '127.0.0.1' }
      : undefined;
    return { id, name, host: normalizeHost(host), port, username, auth, encoding, folderId: folderId || undefined, loginScript: script.length > 0 ? script : undefined, theme: theme || undefined, fontFamily: fontFamily || undefined, fontSize: fontSize || undefined, scrollback: scrollback || undefined, icon: icon || undefined, initialPath: initialPath.trim() || undefined, autoTrackPwd: autoTrackPwd || undefined, x11Forward: x11Forward || undefined, x11Display: x11Forward ? x11Display : undefined, jumpTargetHost: jumpTargetHost.trim() || undefined, jumpTargetUser: jumpTargetUser.trim() || undefined, jumpTargetPort: typeof jumpTargetPort === 'number' && jumpTargetPort > 0 ? jumpTargetPort : undefined, jumpTargetPassword: jumpTargetPassword || undefined, cursorStyle: cursorStyle !== 'block' ? cursorStyle : undefined, cursorBlink: !!cursorBlink, dbms } as Session;
  };
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
              <div className="session-editor-grid">
                <label>{t('fields.jumpTargetHost')}</label>
                <input type="text" value={jumpTargetHost} onChange={e => setJumpTargetHost(e.target.value)} placeholder={t('placeholders.jumpTargetHost')} />
                <label>{t('fields.jumpTargetUser')}</label>
                <input type="text" value={jumpTargetUser} onChange={e => setJumpTargetUser(e.target.value)} placeholder={t('placeholders.jumpTargetUser')} disabled={!jumpTargetHost.trim()} />
                <label>{t('fields.jumpTargetPort')}</label>
                <input type="number" value={jumpTargetPort} onChange={e => setJumpTargetPort(Number(e.target.value) || '')} placeholder="22" disabled={!jumpTargetHost.trim()} min={1} max={65535} />
                <label>{t('fields.jumpTargetPassword')}</label>
                <div style={{ display: 'flex', gap: 4 }}>
                  <input type={showJumpPassword ? 'text' : 'password'} value={jumpTargetPassword} onChange={e => setJumpTargetPassword(e.target.value)} placeholder={t('placeholders.jumpTargetPassword')} disabled={!jumpTargetHost.trim()} style={{ flex: 1 }} autoComplete="off" />
                  <button type="button" onClick={() => setShowJumpPassword(v => !v)} disabled={!jumpTargetHost.trim()}>{showJumpPassword ? '🙈' : '👁'}</button>
                </div>
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
            {category === 'advanced' && (
              <div style={{ color: '#888', padding: 12 }}>{t('advancedHint')}</div>
            )}
            {category === 'filetree' && (
              <div className="session-editor-grid">
                <label>{t('fields.initialPath')}</label>
                <input type="text" value={initialPath} onChange={e => setInitialPath(e.target.value)} placeholder={t('placeholders.initialPath')} />
                <label>{t('fields.autoTrack')}</label>
                <label className="autotrack-checkbox-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', justifySelf: 'start' }}>
                  <input type="checkbox" checked={autoTrackPwd} onChange={e => setAutoTrackPwd(e.target.checked)} style={{ margin: 0 }} />
                  <span className="autotrack-info-icon" title={t('tooltips.autoTrackInfo')}>ⓘ</span>
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
            {category === 'dbms' && (
              <div className="session-editor-grid">
                <label>{t('fields.altibaseUse')}</label>
                <label className="dbms-checkbox-label">
                  <input type="checkbox" checked={dbmsEnabled} onChange={e => setDbmsEnabled(e.target.checked)} />
                  <span>{t('fields.sqlToolEnable')}</span>
                </label>
                <label>{t('fields.dbPort')}</label>
                <input type="number" value={dbmsPort} onChange={e => setDbmsPort(Number(e.target.value) || 20300)} placeholder="20300" disabled={!dbmsEnabled} min={1} max={65535} />
                <label>{t('fields.dbHost')}</label>
                <input type="text" value={dbmsHost} onChange={e => setDbmsHost(e.target.value)} placeholder="127.0.0.1" disabled={!dbmsEnabled} />
                <label>{t('fields.dbUser')}</label>
                <input type="text" value={dbmsUser} onChange={e => setDbmsUser(e.target.value)} placeholder="ipageon" disabled={!dbmsEnabled} autoComplete="off" />
                <label>{t('fields.dbPassword')}</label>
                <div style={{ display: 'flex', gap: 4 }}>
                  <input type={showDbmsPassword ? 'text' : 'password'} value={dbmsPassword} onChange={e => setDbmsPassword(e.target.value)} disabled={!dbmsEnabled} style={{ flex: 1 }} autoComplete="off" />
                  <button type="button" onClick={() => setShowDbmsPassword(v => !v)} disabled={!dbmsEnabled}>{showDbmsPassword ? '🙈' : '👁'}</button>
                </div>
              </div>
            )}
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
