import React, { useEffect, useMemo, useRef, useState } from 'react';

type Peer = { id: string; name: string; host: string; port: number; lastSeen: number; online?: boolean };
type Msg = { id: string; peerId: string; direction: 'in' | 'out'; kind: 'text' | 'file'; text?: string; fileName?: string; filePath?: string; size?: number; ts: number };
type Prefs = { enabled?: boolean; displayName?: string; retainEnabled?: boolean; retainDays?: number; downloadDir?: string; hidePresence?: boolean };
type State = { self?: { id: string; name: string; port: number; hidden?: boolean }; peers: Peer[]; messages: Msg[]; prefs: Prefs };
type RemoteEntry = { name: string; isDir: boolean; size?: number; mtime?: number };

const emptyState: State = { peers: [], messages: [], prefs: {} };

function fmtTime(ts: number) {
  try { return new Date(ts).toLocaleString(); } catch { return ''; }
}

function buildJumpChain(sess: any): { host: string; user?: string; port?: number; password?: string }[] {
  const arr = Array.isArray(sess?.jumps) ? sess.jumps : [];
  const out: { host: string; user?: string; port?: number; password?: string }[] = [];
  for (const j of arr) {
    const host = (j && typeof j.host === 'string') ? j.host.trim() : '';
    if (!host) break;
    out.push({ host, user: j.user || 'root', port: Number(j.port) || 22, password: j.password || undefined });
  }
  return out;
}

function joinRemotePath(base: string, name: string) {
  const root = (base || '/').replace(/\/+$/, '') || '/';
  return root === '/' ? `/${name}` : `${root}/${name}`;
}

function parentRemotePath(cur: string) {
  const p = (cur || '/').replace(/\/+$/, '') || '/';
  if (p === '/') return '/';
  const idx = p.lastIndexOf('/');
  return idx <= 0 ? '/' : p.slice(0, idx);
}

function canRevealFile(msg: Msg) {
  const p = msg.filePath || '';
  return msg.direction === 'in' || /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p);
}

function scanLabel(payload: any) {
  const ranges = Array.isArray(payload?.prefixes) ? payload.prefixes.map((v: string) => `${v}.x.x`) : [];
  const directCount = Array.isArray(payload?.directHosts) ? payload.directHosts.length : 0;
  if (directCount > 0) ranges.push(`Tailscale/overlay ${directCount}개`);
  return ranges.length ? ranges.join(', ') : '할당 IP 대역';
}

export const MessengerWorkspace: React.FC = () => {
  const [state, setState] = useState<State>(emptyState);
  const [selectedPeerId, setSelectedPeerId] = useState('');
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [scanText, setScanText] = useState('');
  const [settingsExpanded, setSettingsExpanded] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const nameComposing = useRef(false);
  const [readMarks, setReadMarks] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem('messenger:readMarks') || '{}') || {}; } catch { return {}; }
  });
  const [menu, setMenu] = useState<{ x: number; y: number; peerId: string } | null>(null);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [remoteSessions, setRemoteSessions] = useState<any[]>([]);
  const [remoteSessionId, setRemoteSessionId] = useState('');
  const [remoteUser, setRemoteUser] = useState('');
  const [remotePass, setRemotePass] = useState('');
  const [remoteConnId, setRemoteConnId] = useState('');
  const [remotePath, setRemotePath] = useState('/');
  const [remoteFiles, setRemoteFiles] = useState<RemoteEntry[]>([]);
  const [remoteSelected, setRemoteSelected] = useState<Set<string>>(new Set());
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState('');

  useEffect(() => {
    let disposed = false;
    (async () => {
      const prefs = await (window as any).api?.getUIPrefs?.().catch(() => ({}));
      const res = await (window as any).api?.messengerStart?.(prefs?.messenger || {});
      if (!disposed && res?.state) {
        setState(res.state);
        setSelectedPeerId((cur) => cur || res.state.peers?.[0]?.id || '');
      }
    })();
    const off = (window as any).api?.onMessengerEvent?.((p: any) => {
      if (p?.state) {
        setState(p.state);
        setSelectedPeerId((cur) => cur || p.state.peers?.[0]?.id || '');
      }
      if (p?.type === 'scan-progress') {
        setScanText(`${scanLabel(p)} 검색 중... ${p.sent}/${p.total}`);
      } else if (p?.type === 'scan-complete') {
        setScanText(`${scanLabel(p)} 검색 완료 (${p.sent}개 확인)`);
        setTimeout(() => setScanText(''), 5000);
      }
    });
    return () => {
      disposed = true;
      if (off) off();
      void (window as any).api?.messengerStop?.();
    };
  }, []);

  const selectedPeer = state.peers.find(p => p.id === selectedPeerId);
  const messages = useMemo(() => state.messages.filter(m => m.peerId === selectedPeerId).sort((a, b) => a.ts - b.ts), [state.messages, selectedPeerId]);
  const storedName = state.prefs.displayName ?? '';
  const fallbackName = state.self?.name || '';

  const markRead = (peerId: string, upToTs: number) => {
    if (!peerId) return;
    setReadMarks(cur => {
      if ((cur[peerId] || 0) >= upToTs) return cur;
      const next = { ...cur, [peerId]: upToTs };
      try { localStorage.setItem('messenger:readMarks', JSON.stringify(next)); } catch {}
      return next;
    });
  };

  // Viewing a peer's conversation marks all of its incoming messages as read,
  // including any that arrive while it stays selected.
  useEffect(() => {
    if (!selectedPeerId) return;
    let latest = 0;
    for (const m of state.messages) {
      if (m.peerId === selectedPeerId && m.direction === 'in' && m.ts > latest) latest = m.ts;
    }
    if (latest > 0) markRead(selectedPeerId, latest);
  }, [selectedPeerId, state.messages]);

  // Seed the local name input from prefs, but never clobber what the user is
  // typing (especially mid Hangul IME composition) — only sync when the value
  // actually diverges and the user is not actively editing the field.
  useEffect(() => {
    if (nameComposing.current) return;
    const el = document.activeElement as HTMLElement | null;
    if (el?.dataset?.messengerName === '1') return;
    setNameInput(storedName);
  }, [storedName]);

  const retainEnabled = !!state.prefs.retainEnabled;
  const retainDays = Number(state.prefs.retainDays) || 30;
  const hidePresence = !!state.prefs.hidePresence;
  const selectedOnline = !!selectedPeer?.online;
  const canSend = !!selectedPeerId && selectedOnline && !hidePresence;

  const updatePrefs = async (patch: Prefs) => {
    setSaving(true);
    try {
      const next = { ...(state.prefs || {}), ...patch };
      const res = await (window as any).api?.messengerUpdatePrefs?.(next);
      if (res?.state) setState(res.state);
    } finally {
      setSaving(false);
    }
  };

  const send = async () => {
    const body = text.trim();
    if (!body || !canSend) return;
    setText('');
    const res = await (window as any).api?.messengerSendMessage?.(selectedPeerId, body);
    if (!res?.success) setText(body);
  };

  const sendFiles = async () => {
    if (!canSend) return;
    await (window as any).api?.messengerSendFiles?.(selectedPeerId);
  };

  useEffect(() => {
    if (!remoteOpen) return;
    (async () => {
      const data = await (window as any).api?.listSessions?.().catch(() => null);
      const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
      setRemoteSessions(sessions);
      setRemoteSessionId(cur => cur || sessions[0]?.id || '');
      setRemoteUser(cur => cur || sessions[0]?.username || '');
    })();
  }, [remoteOpen]);

  const loadRemoteDir = async (connId: string, dir: string) => {
    setRemoteLoading(true);
    setRemoteError('');
    try {
      const res = await (window as any).api?.feListDir?.('remote', dir, connId);
      const files = Array.isArray(res?.files) ? res.files : [];
      setRemoteFiles(files.sort((a: RemoteEntry, b: RemoteEntry) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name)));
      setRemotePath(dir);
      setRemoteSelected(new Set());
    } catch (err: any) {
      setRemoteFiles([]);
      setRemoteError(String(err?.message || err));
    } finally {
      setRemoteLoading(false);
    }
  };

  const closeRemotePicker = async () => {
    if (remoteConnId) {
      try { await (window as any).api?.feSftpDisconnect?.(remoteConnId); } catch {}
    }
    setRemoteOpen(false);
    setRemoteConnId('');
    setRemoteFiles([]);
    setRemoteSelected(new Set());
    setRemoteError('');
  };

  const connectRemoteSession = async () => {
    const sess = remoteSessions.find(s => s.id === remoteSessionId);
    if (!sess) return;
    setRemoteLoading(true);
    setRemoteError('');
    try {
      if (remoteConnId) {
        try { await (window as any).api?.feSftpDisconnect?.(remoteConnId); } catch {}
      }
      const connId = `msg-sftp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const jumps = buildJumpChain(sess);
      const username = remoteUser || sess.username || '';
      const auth = remotePass ? { type: 'password', password: remotePass } : sess.auth;
      if (!username || (!auth && !remotePass)) {
        setRemoteError('사용자명/비밀번호를 입력해 주세요.');
        return;
      }
      const res = await (window as any).api?.feSftpConnect?.(connId, sess.host, sess.port || 22, username, auth, undefined, jumps.length ? jumps : undefined);
      if (!res?.success) {
        setRemoteError(`연결 실패: ${res?.error || 'unknown'}`);
        return;
      }
      setRemoteConnId(connId);
      const home = await (window as any).api?.feHomeDir?.('remote', connId).catch(() => '/');
      await loadRemoteDir(connId, home || '/');
    } finally {
      setRemoteLoading(false);
    }
  };

  const sendRemoteFiles = async () => {
    if (!canSend || !remoteConnId || remoteSelected.size === 0) return;
    setRemoteLoading(true);
    setRemoteError('');
    try {
      const res = await (window as any).api?.messengerSendRemoteFiles?.(selectedPeerId, remoteConnId, [...remoteSelected]);
      if (!res?.success) {
        setRemoteError(`전송 실패: ${res?.error || 'unknown'}`);
        return;
      }
      await closeRemotePicker();
    } finally {
      setRemoteLoading(false);
    }
  };

  const deleteConversation = async (peerId: string) => {
    await (window as any).api?.messengerDeleteConversation?.(peerId);
    setMenu(null);
  };

  const deletePeer = async (peerId: string) => {
    const peer = state.peers.find(p => p.id === peerId);
    if (!confirm(`${peer?.name || '선택한 사용자'}를 목록에서 삭제할까요?\n대화내역도 함께 삭제됩니다.`)) return;
    const res = await (window as any).api?.messengerDeletePeer?.(peerId);
    if (res?.success) {
      setMenu(null);
      setSelectedPeerId(cur => cur === peerId ? '' : cur);
      setState(prev => ({
        ...prev,
        peers: prev.peers.filter(p => p.id !== peerId),
        messages: prev.messages.filter(m => m.peerId !== peerId),
      }));
    }
  };

  const clearAll = async () => {
    if (!confirm('모든 메신저 대화내역을 삭제할까요?')) return;
    await (window as any).api?.messengerClearAll?.();
  };
  const scanAssignedRanges = async () => {
    setScanText('할당 IP B 클래스 대역 검색 시작...');
    const res = await (window as any).api?.messengerScanRange?.();
    if (!res?.success) setScanText(res?.error === 'presence hidden' ? '나의 접속 숨기기 상태에서는 검색할 수 없습니다.' : `검색 시작 실패: ${res?.error || 'unknown'}`);
  };

  return (
    <div className="messenger-ws" onClick={() => setMenu(null)}>
      <aside className="messenger-side">
        <div className="messenger-brand">
          <div>
            <div className="messenger-title">PePe Messenger</div>
            <div className="messenger-sub">같은 네트워크 PePe 사용자</div>
          </div>
          <span className={`messenger-dot ${hidePresence ? 'hidden' : ''}`} title={hidePresence ? 'presence hidden' : 'discovery active'} />
        </div>

        <div className="messenger-settings">
          <label>
            <span>내 이름</span>
            <input
              data-messenger-name="1"
              value={nameInput}
              placeholder={fallbackName || '표시 이름'}
              onChange={e => setNameInput(e.target.value)}
              onCompositionStart={() => { nameComposing.current = true; }}
              onCompositionEnd={e => { nameComposing.current = false; setNameInput((e.target as HTMLInputElement).value); }}
              onBlur={() => { if (nameInput !== storedName) updatePrefs({ displayName: nameInput }); }}
              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            />
          </label>
          <button
            type="button"
            className="messenger-expand"
            onClick={() => setSettingsExpanded(v => !v)}
            aria-expanded={settingsExpanded}
          >
            {settingsExpanded ? '설정 접기' : '설정 펼치기'}
          </button>
          {settingsExpanded && (
            <div className="messenger-settings-more">
              <label className="messenger-check">
                <input type="checkbox" checked={retainEnabled} onChange={e => updatePrefs({ retainEnabled: e.target.checked })} />
                <span>지난 대화 자동 삭제</span>
              </label>
              <label className="messenger-check">
                <input type="checkbox" checked={hidePresence} onChange={e => updatePrefs({ hidePresence: e.target.checked })} />
                <span>나의 접속 숨기기</span>
              </label>
              <label>
                <span>저장 기간(일)</span>
                <input type="number" min={1} max={3650} disabled={!retainEnabled} value={retainDays} onChange={e => updatePrefs({ retainDays: Number(e.target.value) || 30 })} />
              </label>
              <button className="messenger-danger" onClick={clearAll}>대화내역 모두 초기화</button>
              <div className="messenger-scan compact">
                <button onClick={scanAssignedRanges} disabled={hidePresence}>리스트 업데이트</button>
                <small>{scanText || (hidePresence ? '숨김 상태에서는 사용자 검색과 응답을 하지 않습니다.' : '네트워크 카드에 할당된 IPv4의 B 클래스 대역을 직접 찾습니다.')}</small>
              </div>
            </div>
          )}
          {saving && <div className="messenger-saving">저장 중...</div>}
        </div>

        <div className="messenger-peers">
          {state.peers.length === 0 && <div className="messenger-empty">발견된 사용자가 없습니다. 같은 네트워크에서 PePe 메신저 워크스페이스를 열면 표시됩니다.</div>}
          {state.peers.map(peer => {
            const readTs = readMarks[peer.id] || 0;
            const unread = state.messages.filter(m => m.peerId === peer.id && m.direction === 'in' && m.ts > readTs).length;
            return (
              <button
                key={peer.id}
                className={`messenger-peer ${peer.id === selectedPeerId ? 'active' : ''} ${peer.online ? 'online' : 'offline'}`}
                onClick={() => setSelectedPeerId(peer.id)}
                onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, peerId: peer.id }); }}
              >
                <span className="messenger-avatar">{peer.name.slice(0, 1).toUpperCase()}</span>
                <span className="messenger-peer-main">
                  <b>{peer.name}</b>
                  <small>{peer.online ? `${peer.host}:${peer.port}` : `오프라인 · 마지막 발견 ${fmtTime(peer.lastSeen)}`}</small>
                </span>
                {unread > 0 && <span className="messenger-count">{unread}</span>}
              </button>
            );
          })}
        </div>
      </aside>

      <main className="messenger-chat">
        <header className="messenger-chat-head">
          {selectedPeer ? (
            <>
              <div>
                <h2>{selectedPeer.name}</h2>
                <p>{selectedOnline ? `${selectedPeer.host}:${selectedPeer.port}` : '오프라인'} · 마지막 발견 {fmtTime(selectedPeer.lastSeen)}</p>
              </div>
              <button onClick={() => deleteConversation(selectedPeer.id)}>이 대화 삭제</button>
            </>
          ) : (
            <div>
              <h2>대화 상대를 선택하세요</h2>
              <p>왼쪽에 같은 네트워크 PePe 사용자가 표시됩니다.</p>
            </div>
          )}
        </header>

        <section className="messenger-messages">
          {messages.length === 0 && <div className="messenger-empty large">아직 대화가 없습니다.</div>}
          {messages.map(m => (
            <div key={m.id} className={`messenger-bubble ${m.direction}`}>
              {m.kind === 'file' ? (
                <div>
                  <b>파일</b> {m.fileName} <small>{m.size ? `${(m.size / 1024).toFixed(1)}KB` : ''}</small>
                  {m.filePath && (
                    <>
                      <div className="messenger-file-path">{m.filePath}</div>
                      {canRevealFile(m) && <button className="messenger-file-action" onClick={() => (window as any).api?.shellShowItem?.(m.filePath)}>위치 열기</button>}
                    </>
                  )}
                </div>
              ) : (
                <div>{m.text}</div>
              )}
              <time>{fmtTime(m.ts)}</time>
            </div>
          ))}
        </section>

        <footer className="messenger-compose">
          <button disabled={!canSend} onClick={sendFiles}>로컬 파일</button>
          <button disabled={!canSend} onClick={() => setRemoteOpen(true)}>원격 파일</button>
          <textarea
            value={text}
            disabled={!canSend}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={selectedPeer ? (hidePresence ? '나의 접속 숨기기 상태에서는 전송할 수 없습니다' : (selectedOnline ? '메시지 입력 (Enter 전송, Shift+Enter 줄바꿈)' : '오프라인 사용자에게는 전송할 수 없습니다')) : '대화 상대를 선택하세요'}
          />
          <button disabled={!canSend || !text.trim()} onClick={send}>전송</button>
        </footer>
      </main>

      {menu && (
        <div className="messenger-context" style={{ left: menu.x, top: menu.y }} onClick={e => e.stopPropagation()}>
          <button className="danger" onClick={() => deletePeer(menu.peerId)}>사용자 삭제</button>
        </div>
      )}

      {remoteOpen && (
        <div className="messenger-modal-backdrop" onClick={closeRemotePicker}>
          <div className="messenger-remote-modal" onClick={e => e.stopPropagation()}>
            <header>
              <div>
                <h3>원격 파일 전송</h3>
                <p>{selectedPeer?.name || '사용자'}에게 서버 파일을 바로 보냅니다.</p>
              </div>
              <button onClick={closeRemotePicker}>닫기</button>
            </header>

            <div className="messenger-remote-connect">
              <select
                value={remoteSessionId}
                onChange={e => {
                  const id = e.target.value;
                  const sess = remoteSessions.find(s => s.id === id);
                  setRemoteSessionId(id);
                  setRemoteUser(sess?.username || '');
                  setRemotePass('');
                  setRemoteConnId('');
                  setRemoteFiles([]);
                  setRemoteSelected(new Set());
                }}
              >
                {remoteSessions.length === 0 && <option value="">저장된 세션 없음</option>}
                {remoteSessions.map(sess => <option key={sess.id} value={sess.id}>{sess.name || sess.host} ({sess.host})</option>)}
              </select>
              <input value={remoteUser} onChange={e => setRemoteUser(e.target.value)} placeholder="사용자" />
              <input value={remotePass} onChange={e => setRemotePass(e.target.value)} placeholder="비밀번호 필요 시 입력" type="password" />
              <button onClick={connectRemoteSession} disabled={remoteLoading || !remoteSessionId}>{remoteConnId ? '재연결' : '연결'}</button>
            </div>

            <div className="messenger-remote-path">
              <button disabled={!remoteConnId || remotePath === '/'} onClick={() => loadRemoteDir(remoteConnId, parentRemotePath(remotePath))}>상위</button>
              <input value={remotePath} onChange={e => setRemotePath(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && remoteConnId) void loadRemoteDir(remoteConnId, remotePath); }} />
              <button disabled={!remoteConnId} onClick={() => loadRemoteDir(remoteConnId, remotePath)}>이동</button>
            </div>

            {remoteError && <div className="messenger-remote-error">{remoteError}</div>}
            <div className="messenger-remote-list">
              {!remoteConnId && <div className="messenger-empty">세션을 선택하고 연결하면 원격 파일 목록이 표시됩니다.</div>}
              {remoteConnId && remoteFiles.length === 0 && <div className="messenger-empty">{remoteLoading ? '불러오는 중...' : '파일이 없습니다.'}</div>}
              {remoteFiles.map(file => {
                const full = joinRemotePath(remotePath, file.name);
                const checked = remoteSelected.has(full);
                return (
                  <button
                    key={full}
                    className={`messenger-remote-row ${file.isDir ? 'dir' : 'file'} ${checked ? 'selected' : ''}`}
                    onDoubleClick={() => file.isDir && loadRemoteDir(remoteConnId, full)}
                    onClick={() => {
                      if (file.isDir) return;
                      setRemoteSelected(prev => {
                        const next = new Set(prev);
                        if (next.has(full)) next.delete(full);
                        else next.add(full);
                        return next;
                      });
                    }}
                  >
                    <span>{file.isDir ? '📁' : '📄'}</span>
                    <b>{file.name}</b>
                    <small>{file.isDir ? '폴더' : `${(((file.size || 0) / 1024)).toFixed(1)}KB`}</small>
                  </button>
                );
              })}
            </div>

            <footer>
              <span>{remoteSelected.size}개 선택됨</span>
              <button onClick={sendRemoteFiles} disabled={!canSend || remoteLoading || remoteSelected.size === 0}>선택 파일 전송</button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
};
