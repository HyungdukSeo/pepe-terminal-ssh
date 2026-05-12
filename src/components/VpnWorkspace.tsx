// src/components/VpnWorkspace.tsx
// OpenVPN 연결 관리 UI — 설정 파일 import, 연결/끊기, 상태 + 로그 표시.
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { FixedSizeList as VList, ListChildComponentProps } from 'react-window';

const api = (window as any).api || {};

type VpnState = {
  status: 'disconnected' | 'starting' | 'connecting' | 'auth' | 'connected' | 'reconnecting' | 'error';
  configPath?: string;
  configName?: string;
  assignedIp?: string;
  connectedSince?: number;
  bytesIn?: number;
  bytesOut?: number;
  lastError?: string;
};
type Config = { name: string; path: string };

const STATUS_COLOR: Record<VpnState['status'], string> = {
  disconnected: '#888',
  starting: '#d8b556',
  connecting: '#d8b556',
  auth: '#d8b556',
  connected: '#7fcf6e',
  reconnecting: '#e8965a',
  error: '#e36b6b',
};
const STATUS_LABEL: Record<VpnState['status'], string> = {
  disconnected: '연결 안됨',
  starting: '시작 중',
  connecting: '연결 중',
  auth: '인증 중',
  connected: '연결됨',
  reconnecting: '재연결 중',
  error: '오류',
};

function formatBytes(n?: number): string {
  if (n === undefined) return '-';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
function formatDuration(since?: number): string {
  if (!since) return '-';
  const s = Math.floor((Date.now() - since) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

export const VpnWorkspace: React.FC = () => {
  const [avail, setAvail] = useState<{ ok: boolean; reason?: string; binaryPath?: string } | null>(null);
  const [state, setState] = useState<VpnState>({ status: 'disconnected' });
  const [configs, setConfigs] = useState<Config[]>([]);
  const [selectedConfig, setSelectedConfig] = useState<string>('');
  const [logs, setLogs] = useState<string[]>([]);
  const [authPrompt, setAuthPrompt] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [rememberCreds, setRememberCreds] = useState(true);
  const [hasSavedCreds, setHasSavedCreds] = useState(false);
  // 모달 열릴 때마다 input 을 강제 재마운트하려는 키 (focus 끈적임 회피).
  const [authOpenCounter, setAuthOpenCounter] = useState(0);
  // 외부 변경 ref (입력 유지용)
  const authPassRef = useRef<HTMLInputElement | null>(null);
  // 모달 열기 헬퍼.
  // 핵심: refocusWindow() 호출 — sudo-prompt UAC / confirm() 등 native 다이얼로그 후 BrowserWindow 가
  // OS 포커스를 잃은 상태로 남는 Windows 동작 회피. 윈도우 포커스 회복 후에야 안의 input 이 포커스 가능.
  const openAuthPrompt = useCallback(() => {
    try { api.refocusWindow?.(); } catch {}
    try { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); } catch {}
    setAuthOpenCounter(c => c + 1);
    setAuthPrompt(true);
  }, []);
  // 사용자명 input — callback ref. 마운트 시점에 포커스. openAuthPrompt 에서 refocusWindow 로
  // BrowserWindow 자체 포커스를 회복한 후 호출되므로 단순한 RAF + focus 면 충분.
  const userInputRef = useCallback((el: HTMLInputElement | null) => {
    if (!el) return;
    requestAnimationFrame(() => { try { el.focus(); el.select?.(); } catch {} });
  }, [authOpenCounter]);
  const [, tickRender] = useState(0); // 매초 duration 갱신

  // 초기 + 이벤트 구독
  useEffect(() => {
    (async () => {
      try {
        setAvail(await api.vpnAvailable?.());
        setState(await api.vpnState?.());
        const cs: Config[] = await api.vpnListConfigs?.() || [];
        setConfigs(cs);
        // 자동 선택 — 1) localStorage 의 마지막 선택이 아직 유효하면 그것, 2) 아니면 첫 항목
        const last = (() => { try { return localStorage.getItem('vpn:lastSelectedConfig') || ''; } catch { return ''; } })();
        if (last && cs.some(c => c.path === last)) setSelectedConfig(last);
        else if (cs.length > 0) setSelectedConfig(cs[0].path);
        setLogs(await api.vpnLogs?.() || []);
      } catch {}
    })();
    const offState = api.onVpnState?.((s: VpnState) => setState(s));
    const offLog = api.onVpnLog?.((line: string) => setLogs(prev => {
      const next = [...prev, line];
      if (next.length > 5000) next.splice(0, next.length - 5000);
      return next;
    }));
    return () => { offState?.(); offLog?.(); };
  }, []);

  // 선택 변경 → localStorage 영속화 + 자격증명 prefill 준비.
  // hasCreds + loadCreds 두 호출은 desync 위험 (파일은 있는데 복호화 실패 케이스).
  // → loadCreds 하나로 통일: 성공 시 has=true, 실패 시 has=false 둘 다 동기.
  useEffect(() => {
    if (!selectedConfig) { setHasSavedCreds(false); setUsername(''); setPassword(''); return; }
    try { localStorage.setItem('vpn:lastSelectedConfig', selectedConfig); } catch {}
    (async () => {
      const c = await api.vpnLoadCreds?.(selectedConfig);
      if (c?.ok && c.username) {
        setHasSavedCreds(true);
        setUsername(c.username);
        setPassword(c.password || '');
      } else {
        setHasSavedCreds(false);
        setUsername(''); setPassword('');
        // 디버그 — 파일은 있는데 load 실패한 케이스 알리기
        if (c?.error) console.warn('[vpn] 자격증명 load 실패:', c.error);
      }
    })();
  }, [selectedConfig]);

  // 연결됨 상태에서 매 1초 duration 갱신
  useEffect(() => {
    if (state.status !== 'connected') return;
    const t = setInterval(() => tickRender(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [state.status]);

  const refreshConfigs = useCallback(async () => {
    setConfigs(await api.vpnListConfigs?.() || []);
  }, []);

  const importConfig = useCallback(async () => {
    const r = await api.vpnImportConfig?.();
    if (r?.canceled) return;
    if (r?.ok && r.storedPath) {
      await refreshConfigs();
      setSelectedConfig(r.storedPath);
    } else if (r?.reason) {
      alert('가져오기 실패: ' + r.reason);
    }
  }, [refreshConfigs]);

  const removeConfig = useCallback(async (p: string) => {
    if (!confirm(`삭제하시겠습니까?\n${p}`)) return;
    await api.vpnRemoveConfig?.(p);
    await api.vpnClearCreds?.(p); // 저장된 자격증명도 삭제
    const remaining: Config[] = await api.vpnListConfigs?.() || [];
    setConfigs(remaining);
    if (selectedConfig === p) {
      setSelectedConfig(remaining.length > 0 ? remaining[0].path : '');
    }
  }, [selectedConfig]);

  // 연결 — withAuth=true 면 모달에서 입력받은 ID/PW 사용, false 면 저장된 자격증명이 있으면 자동 사용
  const connect = useCallback(async (withAuth = false) => {
    if (!selectedConfig) return;
    let useUser: string | undefined;
    let usePass: string | undefined;
    if (withAuth) {
      useUser = username; usePass = password;
      if (rememberCreds && username) {
        await api.vpnSaveCreds?.(selectedConfig, username, password);
        setHasSavedCreds(true);
      }
    } else if (hasSavedCreds) {
      // 저장된 자격증명 자동 사용 — auth-user-pass 가 필요한 .ovpn 도 hang 안 됨
      useUser = username; usePass = password;
    }
    const r = await api.vpnConnect?.(selectedConfig, useUser, usePass);
    if (!r?.ok && r?.reason) {
      alert('연결 실패: ' + r.reason);
    }
    if (withAuth) setAuthPrompt(false);
  }, [selectedConfig, username, password, rememberCreds, hasSavedCreds]);

  const clearSavedCreds = useCallback(async () => {
    if (!selectedConfig) return;
    if (!confirm('저장된 ID/비밀번호를 삭제하시겠습니까?')) return;
    await api.vpnClearCreds?.(selectedConfig);
    setHasSavedCreds(false);
    setUsername(''); setPassword('');
    // confirm() 다이얼로그가 닫힌 후 윈도우 포커스 복원 (Electron 의 Windows 버그 회피)
    try { api.refocusWindow?.(); } catch {}
  }, [selectedConfig]);

  const disconnect = useCallback(async () => {
    await api.vpnDisconnect?.();
  }, []);

  const canConnect = state.status === 'disconnected' || state.status === 'error';
  const isConnected = state.status === 'connected';

  // 로그 가상화
  const logWrapRef = useRef<HTMLDivElement | null>(null);
  const [logHeight, setLogHeight] = useState(300);
  const logRoRef = useRef<ResizeObserver | null>(null);
  const setLogWrapRef = useCallback((el: HTMLDivElement | null) => {
    logWrapRef.current = el;
    if (logRoRef.current) { logRoRef.current.disconnect(); logRoRef.current = null; }
    if (!el) return;
    const update = () => setLogHeight(el.clientHeight || 300);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    logRoRef.current = ro;
    update();
  }, []);
  useEffect(() => () => { logRoRef.current?.disconnect(); }, []);

  // 새 로그 추가 시 자동 스크롤
  const logListRef = useRef<VList | null>(null);
  const autoScrollRef = useRef(true);
  useEffect(() => {
    if (autoScrollRef.current && logs.length > 0) {
      logListRef.current?.scrollToItem(logs.length - 1, 'end');
    }
  }, [logs.length]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: '#1a1a1a' }}>
      {/* 헤더 — 가용성 + 상태 */}
      <div style={{ padding: '12px 16px', background: '#222', borderBottom: '1px solid #333' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
          <span style={{
            width: 12, height: 12, borderRadius: '50%',
            background: STATUS_COLOR[state.status],
            boxShadow: state.status === 'connected' ? '0 0 8px ' + STATUS_COLOR[state.status] : 'none',
          }} />
          <span style={{ fontSize: 16, fontWeight: 600, color: STATUS_COLOR[state.status] }}>
            {STATUS_LABEL[state.status]}
          </span>
          {state.configName && <span style={{ fontSize: 12, color: '#888' }}>· {state.configName}</span>}
          {state.assignedIp && <span style={{ fontSize: 12, color: '#7fcf6e' }}>· IP: {state.assignedIp}</span>}
          {isConnected && <span style={{ fontSize: 12, color: '#888' }}>· {formatDuration(state.connectedSince)}</span>}
        </div>
        {avail && !avail.ok && (
          <div style={{ padding: 8, background: '#3a1a1a', border: '1px solid #5a2a2a', borderRadius: 4, color: '#e36b6b', fontSize: 12 }}>
            ⚠ OpenVPN 바이너리를 찾을 수 없습니다 — {avail.reason}
            <div style={{ color: '#aaa', fontSize: 11, marginTop: 4 }}>
              번들 누락 (개발 빌드라면 resources/openvpn-win/ 또는 resources/openvpn-mac/ 에 바이너리 + 의존 DLL/dylib 가 필요)
            </div>
          </div>
        )}
        {state.lastError && (
          <div style={{ padding: 6, background: '#2a1a1a', border: '1px solid #4a2a2a', borderRadius: 4, color: '#e36b6b', fontSize: 11, marginTop: 6 }}>
            {state.lastError}
          </div>
        )}
        {isConnected && (
          <div style={{ display: 'flex', gap: 16, fontSize: 11, color: '#aaa', marginTop: 6 }}>
            <span>⬇ 수신: {formatBytes(state.bytesIn)}</span>
            <span>⬆ 송신: {formatBytes(state.bytesOut)}</span>
          </div>
        )}
      </div>

      {/* 본문 — 좌: 설정 목록, 우: 로그 */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* 좌측 — 설정 목록 */}
        <div style={{ width: 320, display: 'flex', flexDirection: 'column', borderRight: '1px solid #333', background: '#161616' }}>
          <div style={{ padding: '8px 10px', borderBottom: '1px solid #333', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 12, color: '#bbb', flex: 1 }}>설정 ({configs.length})</span>
            <button onClick={importConfig} style={{ fontSize: 11, padding: '3px 8px' }}>📥 .ovpn 가져오기</button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {configs.length === 0 ? (
              <div style={{ padding: 16, fontSize: 12, color: '#666', textAlign: 'center' }}>
                .ovpn 파일을 가져오세요
              </div>
            ) : configs.map(c => {
              const isSel = c.path === selectedConfig;
              return (
                <div key={c.path}
                  onClick={() => setSelectedConfig(c.path)}
                  style={{
                    padding: '6px 10px', fontSize: 12, cursor: 'pointer',
                    background: isSel ? '#2b4e74' : 'transparent',
                    color: isSel ? '#fff' : '#ccc',
                    display: 'flex', alignItems: 'center', gap: 6,
                    borderLeft: '3px solid ' + (isSel ? '#7fbeea' : 'transparent'),
                  }}>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.path}>📄 {c.name}</span>
                  <button onClick={e => { e.stopPropagation(); removeConfig(c.path); }} style={{ fontSize: 10, padding: '1px 6px', color: '#e36b6b' }}>삭제</button>
                </div>
              );
            })}
          </div>

          {/* 연결 컨트롤 — 상태별로 표시 변경 */}
          <div style={{ padding: 10, borderTop: '1px solid #333', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {canConnect ? (
              <>
                <button
                  onClick={() => connect(false)}
                  disabled={!selectedConfig || !avail?.ok}
                  className="primary"
                  style={{ padding: '8px 12px', fontSize: 13 }}>
                  🔒 연결{hasSavedCreds ? ' (저장된 ID/PW 사용)' : ''}
                </button>
                <button
                  onMouseDown={e => e.preventDefault()}
                  onClick={openAuthPrompt}
                  disabled={!selectedConfig || !avail?.ok}
                  style={{ padding: '6px 12px', fontSize: 11 }}>
                  {hasSavedCreds ? 'ID/비밀번호 다시 입력' : '사용자/비밀번호 입력 후 연결'}
                </button>
                {hasSavedCreds && (
                  <button onMouseDown={e => e.preventDefault()} onClick={clearSavedCreds} style={{ padding: '4px 12px', fontSize: 10, color: '#e36b6b' }}>
                    저장된 자격증명 삭제
                  </button>
                )}
              </>
            ) : (
              // disconnected/error 가 아닌 모든 상태에서 항상 끊기 가능 — 상태 라벨만 변경
              <button onClick={disconnect}
                style={{ padding: '8px 12px', fontSize: 13, background: isConnected ? '#5a2a2a' : '#5a3a1a', color: '#fff', fontWeight: 600 }}>
                {isConnected ? '⏏ 연결 해제' : '✕ 연결 시도 취소'}
              </button>
            )}
          </div>
        </div>

        {/* 우측 — 로그 */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div style={{ padding: '8px 10px', borderBottom: '1px solid #333', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 12, color: '#bbb', flex: 1 }}>OpenVPN 로그 ({logs.length})</span>
            <label style={{ fontSize: 11, color: '#aaa', display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="checkbox" defaultChecked={true} onChange={e => { autoScrollRef.current = e.target.checked; }} />
              자동 스크롤
            </label>
            <button onClick={() => setLogs([])} style={{ fontSize: 11, padding: '3px 8px' }}>지우기</button>
          </div>
          <div ref={setLogWrapRef} style={{ flex: 1, minHeight: 0, background: '#0c0c0c' }}>
            <VList ref={logListRef} height={logHeight} width="100%" itemCount={logs.length} itemSize={18} overscanCount={15}>
              {({ index, style }: ListChildComponentProps) => (
                <div style={{ ...style, fontFamily: 'monospace', fontSize: 11, color: '#aaa', padding: '0 8px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={logs[index]}>
                  {logs[index]}
                </div>
              )}
            </VList>
          </div>
        </div>
      </div>

      {/* 인증 모달 — 백드롭 클릭으로 안 닫음 (실수로 입력 날아가는 거 방지) */}
      {authPrompt && (
        <div className="session-editor-backdrop">
          <div className="session-editor" onClick={e => e.stopPropagation()} style={{ width: 360, display: 'flex', flexDirection: 'column' }}>
            <h3>🔑 사용자 인증</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
              <label style={{ fontSize: 12, color: '#bbb' }}>사용자명</label>
              {/* key 로 강제 재마운트 — 매 모달 open 마다 새 input → autoFocus + callback ref 가 확실히 발동 */}
              <input
                key={`u-${authOpenCounter}`}
                ref={userInputRef}
                autoFocus
                value={username} onChange={e => setUsername(e.target.value)}
                onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') { if (username && !password) authPassRef.current?.focus(); else connect(true); } }}
                style={{ fontSize: 13, padding: '6px 8px', width: '100%', boxSizing: 'border-box' }} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 10 }}>
              <label style={{ fontSize: 12, color: '#bbb' }}>비밀번호</label>
              <input
                key={`p-${authOpenCounter}`}
                ref={authPassRef} type="password" value={password} onChange={e => setPassword(e.target.value)}
                onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') connect(true); }}
                style={{ fontSize: 13, padding: '6px 8px', width: '100%', boxSizing: 'border-box' }} />
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, fontSize: 12, color: '#bbb', cursor: 'pointer' }}>
              <input type="checkbox" checked={rememberCreds} onChange={e => setRememberCreds(e.target.checked)} />
              기억하기 (다음부터 자동 사용 — OS 안전 저장소 암호화)
            </label>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
              <button onClick={() => { setAuthPrompt(false); }}>취소</button>
              <button className="primary" onClick={() => connect(true)}>연결</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
