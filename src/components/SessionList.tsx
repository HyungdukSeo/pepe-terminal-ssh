// src/components/SessionList.tsx
import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { SessionEditor } from './SessionEditor';

type LoginScriptRule = {
  expect: string;
  send: string;
  isRegex?: boolean;
};

type Session = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth?: any;
  encoding?: string;
  folderId?: string;
  loginScript?: LoginScriptRule[];
  theme?: string;
  fontFamily?: string;
  fontSize?: number;
  scrollback?: number;
  icon?: string;
  dbms?: { type: 'altibase'; port: number; user: string; password: string; host?: string };
  x11Forward?: boolean;
  x11Display?: number;
};

type Folder = {
  id: string;
  name: string;
  parentId?: string;
};

type Props = {
  onConnect: (sessionId: string, sessionName: string, targetPanelId?: string | null, sessionTheme?: string, fontFamily?: string, fontSize?: number, scrollback?: number) => void;
  onMultiConnect?: (sessions: Session[], mode: 'minitab' | 'split-h' | 'split-v' | 'split-tile', opts?: { newWorkspace?: boolean; targetTabId?: string }) => void;
  onFileTransfer?: (sessionId: string, sessionName: string) => void;
  onOpenSqlTool?: (sessionId: string, sessionName: string) => void;
  onDisconnect?: (targetPanelId?: string | null) => void;
  targetPanelId?: string | null;
  workspaceTabs?: { id: string; title: string }[];
  activeTabId?: string;
};

export const SessionList: React.FC<Props> = ({ onConnect, onMultiConnect, onDisconnect, onFileTransfer, onOpenSqlTool, targetPanelId, workspaceTabs = [], activeTabId }) => {
  const { t } = useTranslation('sessionList');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [width, setWidth] = useState<number>(() => {
    const saved = window.localStorage.getItem('sessionListWidth');
    return saved ? Number(saved) : 260;
  });
  const [pinned, setPinned] = useState<boolean>(true);
  const pinnedLoadedRef = useRef(false);
  const [visible, setVisible] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<'session' | 'folder'>('session');
  const [editing, setEditing] = useState<Session | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    // 초기엔 localStorage 값으로 시작 (호환용) — UIPrefs 로드 후 덮어씀
    try { return new Set(JSON.parse(window.localStorage.getItem('collapsedFolders') ?? '[]')); }
    catch { return new Set(); }
  });
  const collapsedLoadedRef = useRef(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamingType, setRenamingType] = useState<'session' | 'folder'>('folder');
  const [renameValue, setRenameValue] = useState('');
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; id: string; type: 'session' | 'folder'; name: string } | null>(null);
  // 다중 선택 시 연결할 워크스페이스 — 'current' / 'new' / 특정 탭 id
  const [multiTargetWs, setMultiTargetWs] = useState<string>('current');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [folderPicker, setFolderPicker] = useState<{ sessionId: string } | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef<{ startX: number; startWidth: number } | null>(null);
  const widthRef = useRef(width);
  widthRef.current = width;

  useEffect(() => { reload(); }, []);

  useEffect(() => {
    const handler = () => reload();
    window.addEventListener('sessions-reload', handler);
    return () => window.removeEventListener('sessions-reload', handler);
  }, []);

  // collapsed 폴더 목록 UIPrefs 에 저장 (재시작 후 유지)
  useEffect(() => {
    if (!collapsedLoadedRef.current) return;
    try { (window as any).api?.setUIPrefs?.({ collapsedFolders: [...collapsed] }); } catch {}
  }, [collapsed]);

  // ui-prefs 에서 pinned + collapsedFolders 로드
  useEffect(() => {
    (async () => {
      try {
        const prefs = await (window as any).api?.getUIPrefs?.();
        if (prefs && typeof prefs.sidebarPinned === 'boolean') {
          setPinned(prefs.sidebarPinned);
          if (!prefs.sidebarPinned) setVisible(false);
        }
        if (prefs && Array.isArray(prefs.collapsedFolders)) {
          setCollapsed(new Set(prefs.collapsedFolders));
        }
      } catch {}
      pinnedLoadedRef.current = true;
      collapsedLoadedRef.current = true;
    })();
  }, []);
  useEffect(() => {
    if (!pinnedLoadedRef.current) return;
    try { (window as any).api?.setUIPrefs?.({ sidebarPinned: pinned }); } catch {}
    if (pinned) {
      setVisible(true);
    } else {
      // 고정 해제 즉시 숨김 (클릭 없이도 바로 사라짐)
      setVisible(false);
    }
  }, [pinned]);

  // 컨텍스트 메뉴 외부 클릭 시 닫기
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [contextMenu]);

  const [childOrder, setChildOrder] = useState<Record<string, string[]>>({});

  const reload = async () => {
    const data = await window.api?.listSessions?.();
    if (data && !Array.isArray(data)) {
      setSessions(data.sessions || []);
      setFolders(data.folders || []);
      setChildOrder(data.childOrder || {});
    } else {
      setSessions(data || []);
      setFolders([]);
    }
  };

  // popout 세션 편집기에서 저장 완료 시 자동 reload + 설정 변경 감지
  useEffect(() => {
    const off = (window as any).api?.onSessionEditorSaved?.((p: { session?: Session }) => {
      const s = p?.session;
      if (s?.id) {
        // 변경 전 세션 (현재 state) 와 비교 — X11 변경 시 활성 연결 재접속
        const prev = sessions.find(x => x.id === s.id);
        const x11Changed = !!prev && (!!prev.x11Forward !== !!s.x11Forward || (prev.x11Display ?? 0) !== (s.x11Display ?? 0));
        if (x11Changed) {
          try {
            window.dispatchEvent(new CustomEvent('session-setting-changed', {
              detail: { sessionId: s.id, fields: ['x11Forward', 'x11Display'], requiresReconnect: true },
            }));
          } catch {}
        }
      }
      reload();
      if (s?.id) { setSelectedId(s.id); setSelectedType('session'); }
    });
    return () => { try { off?.(); } catch {} };
  }, [sessions]);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    e.preventDefault();
    dragging.current = { startX: e.clientX, startWidth: width };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  const onPointerMove = useCallback((ev: PointerEvent) => {
    if (!dragging.current) return;
    const delta = ev.clientX - dragging.current.startX;
    setWidth(Math.max(180, dragging.current.startWidth + delta));
  }, []);

  const onPointerUp = useCallback(() => {
    window.localStorage.setItem('sessionListWidth', String(widthRef.current));
    dragging.current = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
  }, [onPointerMove]);

  const [copiedSession, setCopiedSession] = useState<Session | null>(null);
  const [copiedFolder, setCopiedFolder] = useState<{ folder: Folder; allFolders: Folder[]; allSessions: Session[] } | null>(null);

  // 폴더 복사 — 하위 폴더/세션 전체 수집
  const handleCopyFolder = (folderId: string) => {
    const folder = folders.find(x => x.id === folderId);
    if (!folder) return;
    const getAllSubFolders = (parentId: string): Folder[] => {
      const children = folders.filter(f => f.parentId === parentId);
      return [...children, ...children.flatMap(c => getAllSubFolders(c.id))];
    };
    const subFolders = getAllSubFolders(folderId);
    const allFolders = [folder, ...subFolders];
    const folderIds = new Set(allFolders.map(f => f.id));
    const allSessions = sessions.filter(s => s.folderId && folderIds.has(s.folderId));
    setCopiedFolder({ folder, allFolders, allSessions });
    setCopiedSession(null); // 세션 복사 클립보드 초기화
  };

  // 폴더 붙여넣기 — 새 ID 생성 후 재귀적으로 폴더/세션 저장
  // targetParentId: undefined=원본과 같은 레벨, string=해당 폴더 안에 붙여넣기
  const handlePasteFolder = async (targetParentId?: string | null) => {
    if (!copiedFolder) return;
    const { folder, allFolders, allSessions } = copiedFolder;
    let seq = 0;
    const makeId = (prefix: string) => `${prefix}-${Date.now()}-${(++seq).toString(36)}`;
    // 구 ID → 새 ID 매핑
    const idMap = new Map<string, string>();
    for (const f of allFolders) idMap.set(f.id, makeId('folder'));
    // 폴더 저장 (루트부터 순서대로)
    for (const f of allFolders) {
      const newId = idMap.get(f.id)!;
      let newParentId: string | undefined;
      if (f.id === folder.id) {
        // 루트 폴더: targetParentId 지정 시 그 안에, 아니면 원본과 같은 레벨
        newParentId = targetParentId != null ? targetParentId : (folder.parentId ?? undefined);
      } else {
        newParentId = f.parentId ? idMap.get(f.parentId) : undefined;
      }
      const name = f.id === folder.id ? `${f.name} (${t('copySuffix')})` : f.name;
      await (window as any).api.saveFolder({ id: newId, name, parentId: newParentId });
    }
    // 세션 저장
    for (const s of allSessions) {
      const newFolderId = s.folderId ? idMap.get(s.folderId) : undefined;
      await (window as any).api.saveSession({ ...s, id: makeId('sess'), folderId: newFolderId });
    }
    await reload();
  };

  const handleConnect = (s: Session) => onConnect(s.id, s.name, targetPanelId ?? null, s.theme, s.fontFamily, s.fontSize, s.scrollback);
  const _handleDisconnect = () => onDisconnect?.(targetPanelId ?? null); void _handleDisconnect;

  const handleAdd = () => {
    const folderId = selectedType === 'folder' ? selectedId : undefined;
    setEditing({ id: `sess-${Date.now()}`, name: 'New Session', host: '', port: 22, username: '', auth: { type: 'password', password: '' }, encoding: 'utf-8', folderId: folderId ?? undefined });
  };

  const handleEdit = () => {
    if (!selectedId) return;
    const s = sessions.find(x => x.id === selectedId);
    if (s) setEditing(s);
  };

  const handleDelete = async () => {
    // confirm() 후 Windows BrowserWindow 포커스 복원 (입력칸 커서 회복용)
    const refocus = () => { try { (window as any).api?.refocusWindow?.(); } catch {} };
    // 다중 선택 삭제
    if (selectedIds.size > 0) {
      const ids = [...selectedIds];
      const ok = confirm(t('deleteItems', { count: ids.length }));
      refocus();
      if (!ok) return;
      for (const id of ids) {
        if (sessions.some(x => x.id === id)) await window.api?.deleteSession?.(id);
        if (folders.some(x => x.id === id)) await (window as any).api.deleteFolder(id);
      }
      await reload();
      setSelectedId(null);
      setSelectedIds(new Set());
      return;
    }
    // 단일 선택 삭제
    if (!selectedId) return;
    if (selectedType === 'folder') {
      const f = folders.find(x => x.id === selectedId);
      if (!f) return;
      const ok = confirm(t('deleteFolder', { name: f.name }));
      refocus();
      if (!ok) return;
      await (window as any).api.deleteFolder(selectedId);
      await reload();
      setSelectedId(null);
      return;
    }
    const s = sessions.find(x => x.id === selectedId);
    if (!s) return;
    const ok = confirm(t('deleteSession', { name: s.name }));
    refocus();
    if (!ok) return;
    await window.api?.deleteSession?.(selectedId);
    await reload();
    setSelectedId(null);
  };

  const handleAddFolder = async () => {
    const parentId = selectedType === 'folder' ? selectedId : undefined;
    const folder = { id: `folder-${Date.now()}`, name: t('newFolderDefault'), parentId: parentId ?? undefined };
    await (window as any).api.saveFolder(folder);
    await reload();
  };

  const handleRenameSubmit = async () => {
    if (!renamingId || !renameValue.trim()) { setRenamingId(null); return; }
    if (renamingType === 'folder') {
      const f = folders.find(x => x.id === renamingId);
      if (f) { await (window as any).api.saveFolder({ ...f, name: renameValue.trim() }); }
    } else {
      const s = sessions.find(x => x.id === renamingId);
      if (s) { await (window as any).api.saveSession({ ...s, name: renameValue.trim() }); }
    }
    setRenamingId(null);
    await reload();
  };

  const startRename = (id: string, type: 'session' | 'folder', currentName: string) => {
    setRenamingId(id);
    setRenamingType(type);
    setRenameValue(currentName);
  };

  const toggleCollapse = (folderId: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      next.has(folderId) ? next.delete(folderId) : next.add(folderId);
      return next;
    });
  };

  // @ts-expect-error unused (kept for future)
  const handleEncodingChange = async (sessionId: string, encoding: string) => {
    const s = sessions.find(x => x.id === sessionId);
    if (!s) return;
    await window.api?.saveSession?.({ ...s, encoding });
    await reload();
    setSelectedId(sessionId);
  };

  const onSaveSession = async (s: Session) => {
    // 변경 전 세션 — 일부 설정 (X11 forwarding 등) 변경 시 활성 연결 재접속 필요
    const prev = sessions.find(x => x.id === s.id);
    await (window as any).api.saveSession(s);
    // 저장만 — 창 유지
    await reload();
    setSelectedId(s.id);
    setSelectedType('session');
    // X11 forwarding / display 변경 — 재접속 없이는 효과 없음. 활성 연결에 즉시 적용 위해 reconnect.
    const x11Changed = !!prev && (!!prev.x11Forward !== !!s.x11Forward || (prev.x11Display ?? 0) !== (s.x11Display ?? 0));
    if (x11Changed) {
      try {
        window.dispatchEvent(new CustomEvent('session-setting-changed', {
          detail: { sessionId: s.id, fields: ['x11Forward', 'x11Display'], requiresReconnect: true },
        }));
      } catch {}
    }
  };

  // 저장 + 창 닫기 + 연결
  const onSaveAndConnect = async (s: Session) => {
    await (window as any).api.saveSession(s);
    setEditing(null);
    await reload();
    setSelectedId(s.id);
    setSelectedType('session');
    // 모달 닫힘 + 리로드 후 약간 대기 후 연결 (state 갱신 시간 확보)
    setTimeout(() => { try { handleConnect(s); } catch (e) { console.error('[saveAndConnect] connect failed:', e); } }, 50);
  };

  // 드래그로 세션을 폴더에 이동
  const handleSessionDrop = async (sessionId: string, targetFolderId: string | undefined) => {
    const s = sessions.find(x => x.id === sessionId);
    if (!s) return;
    await (window as any).api.saveSession({ ...s, folderId: targetFolderId });
    await reload();
  };

  const _selectedSession = selectedType === 'session' ? sessions.find(x => x.id === selectedId) : null; void _selectedSession;

  // 현재 렌더되는 세션 ID 의 순서 (shift-click 범위 선택용)
  const visibleSessionIds = useMemo<string[]>(() => {
    const result: string[] = [];
    const walk = (parentId?: string) => {
      const key = parentId || '__root__';
      const order = childOrder[key];
      const childFolders = folders.filter(f => (f.parentId ?? undefined) === parentId);
      const childSessions = sessions.filter(s => (s.folderId ?? undefined) === parentId);
      const allIds = order
        ? [...order.filter(id => childFolders.some(f => f.id === id) || childSessions.some(s => s.id === id)),
           ...childFolders.filter(f => !order.includes(f.id)).map(f => f.id),
           ...childSessions.filter(s => !order.includes(s.id)).map(s => s.id)]
        : [...childFolders.map(f => f.id), ...childSessions.map(s => s.id)];
      for (const id of allIds) {
        const f = childFolders.find(x => x.id === id);
        if (f) {
          if (!collapsed.has(f.id)) walk(f.id);
          continue;
        }
        const s = childSessions.find(x => x.id === id);
        if (s) result.push(s.id);
      }
    };
    walk(undefined);
    return result;
  }, [sessions, folders, childOrder, collapsed]);

  // 재귀 트리 렌더링 — childOrder 기반 혼합 순서
  const renderTree = (parentId?: string, depth = 0) => {
    const key = parentId || '__root__';
    const order = childOrder[key];
    const childFolders = folders.filter(f => (f.parentId ?? undefined) === parentId);
    const childSessions = sessions.filter(s => (s.folderId ?? undefined) === parentId);

    // childOrder가 있으면 그 순서로, 없으면 폴더 먼저 세션 나중
    const allIds = order
      ? [...order.filter(id => childFolders.some(f => f.id === id) || childSessions.some(s => s.id === id)),
         ...childFolders.filter(f => !order.includes(f.id)).map(f => f.id),
         ...childSessions.filter(s => !order.includes(s.id)).map(s => s.id)]
      : [...childFolders.map(f => f.id), ...childSessions.map(s => s.id)];

    return (
      <>
        {allIds.map(itemId => {
          const f = childFolders.find(x => x.id === itemId);
          if (f) {
            const isCollapsed = collapsed.has(f.id);
            const isSelected = selectedId === f.id && selectedType === 'folder';
            return (
              <React.Fragment key={f.id}>
                <div
                  data-folder-id={f.id}
                  className={`session-item folder-item ${isSelected || selectedIds.has(f.id) ? 'selected' : ''} ${dragOverId === f.id ? 'drag-over' : ''}`}
                  style={{ paddingLeft: 8 + depth * 16 }}
                  onClick={e => {
                    if (e.ctrlKey || e.metaKey) {
                      setSelectedIds(prev => { const next = new Set(prev); if (next.size === 0 && selectedId) next.add(selectedId); next.has(f.id) ? next.delete(f.id) : next.add(f.id); return next; });
                    } else { setSelectedId(f.id); setSelectedType('folder'); setSelectedIds(new Set()); }
                  }}
                  onDoubleClick={() => toggleCollapse(f.id)}
                  onContextMenu={e => { e.preventDefault(); setSelectedId(f.id); setSelectedType('folder'); setContextMenu({ x: e.clientX, y: e.clientY, id: f.id, type: 'folder', name: f.name }); }}
                  onDragOver={e => { if (e.dataTransfer.types.includes('text/session-id')) { e.preventDefault(); e.stopPropagation(); setDragOverId(f.id); } }}
                  onDragLeave={e => { e.stopPropagation(); setDragOverId(null); }}
                  onDrop={e => { e.stopPropagation(); const sid = e.dataTransfer.getData('text/session-id'); if (sid) { e.preventDefault(); handleSessionDrop(sid, f.id); } setDragOverId(null); }}
                >
                  <span className="folder-toggle" onClick={e => { e.stopPropagation(); toggleCollapse(f.id); }}>{isCollapsed ? '▶' : '▼'}</span>
                  <span className="folder-icon">📁</span>
                  {renamingId === f.id ? (
                    <input className="folder-rename-input" value={renameValue} onChange={e => setRenameValue(e.target.value)} onBlur={handleRenameSubmit} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') handleRenameSubmit(); if (e.key === 'Escape') setRenamingId(null); }} autoFocus onClick={e => e.stopPropagation()} />
                  ) : (<span className="folder-name">{f.name}</span>)}
                </div>
                {!isCollapsed && renderTree(f.id, depth + 1)}
              </React.Fragment>
            );
          }
          const s = childSessions.find(x => x.id === itemId);
          if (s) {
            return (
              <div key={s.id}
                data-session-id={s.id}
                className={`session-item ${(selectedId === s.id && selectedType === 'session') || selectedIds.has(s.id) ? 'selected' : ''}`}
                style={{ paddingLeft: 8 + depth * 16 }}
                onClick={e => {
                  if (e.shiftKey) {
                    // 범위 선택: anchor(selectedId) ~ 클릭 위치까지 모두 추가
                    const anchor = selectedId && visibleSessionIds.includes(selectedId) ? selectedId : (visibleSessionIds[0] || s.id);
                    const startIdx = visibleSessionIds.indexOf(anchor);
                    const endIdx = visibleSessionIds.indexOf(s.id);
                    if (startIdx >= 0 && endIdx >= 0) {
                      const [lo, hi] = startIdx <= endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
                      setSelectedIds(new Set(visibleSessionIds.slice(lo, hi + 1)));
                    }
                  } else if (e.ctrlKey || e.metaKey) {
                    setSelectedIds(prev => { const next = new Set(prev); if (next.size === 0 && selectedId) next.add(selectedId); next.has(s.id) ? next.delete(s.id) : next.add(s.id); return next; });
                  } else {
                    // 같은 세션 재클릭 → 선택 해제 (encoding 창 닫힘)
                    if (selectedId === s.id && selectedType === 'session') {
                      setSelectedId(null);
                      setSelectedIds(new Set());
                    } else {
                      setSelectedId(s.id);
                      setSelectedType('session');
                      setSelectedIds(new Set());
                    }
                  }
                }}
                onDoubleClick={() => { if (renamingId !== s.id) handleConnect(s); }}
                onContextMenu={e => { e.preventDefault(); setSelectedId(s.id); setSelectedType('session'); setContextMenu({ x: e.clientX, y: e.clientY, id: s.id, type: 'session', name: s.name }); }}
                draggable={renamingId !== s.id}
                onDragStart={e => { e.dataTransfer.setData('text/session-id', s.id); e.dataTransfer.effectAllowed = 'move'; const el = e.currentTarget as HTMLElement; e.dataTransfer.setDragImage(el, el.offsetWidth / 2, el.offsetHeight / 2); }}
                onDragEnd={() => setDragOverId(null)}
              >
                {renamingId === s.id ? (
                  <input className="folder-rename-input" value={renameValue} onChange={e => setRenameValue(e.target.value)} onBlur={handleRenameSubmit} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') handleRenameSubmit(); if (e.key === 'Escape') setRenamingId(null); }} autoFocus onClick={e => e.stopPropagation()} />
                ) : (
                  <div className="session-item-name" title={`${s.host}:${s.port}${s.username ? ' ('+s.username+')' : ''}`}>
                    <span className="session-icon">{s.icon || '📡'}</span>{s.name}
                    <span className="session-item-host-tooltip">{s.host}:{s.port}</span>
                  </div>
                )}
              </div>
            );
          }
          return null;
        })}
      </>
    );
  };

  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverShowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mouseInsideRef = useRef(false);

  // 컨텍스트 메뉴가 닫힐 때 마우스가 사이드바 밖이면 숨김 타이머 시작
  useEffect(() => {
    if (pinned || contextMenu) return;
    if (!mouseInsideRef.current) {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setVisible(false), 500);
    }
  }, [contextMenu, pinned]);

  const handleClickTrigger = () => {
    if (pinned) return;
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
    if (hoverShowTimer.current) { clearTimeout(hoverShowTimer.current); hoverShowTimer.current = null; }
    setVisible(v => !v);
  };

  const handleMouseEnterTrigger = () => {
    if (pinned) return;
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
    if (hoverShowTimer.current) clearTimeout(hoverShowTimer.current);
    // 2.5 초 hover 시 자동 열림 (Claude 트리거와 동일 UX)
    hoverShowTimer.current = setTimeout(() => setVisible(true), 2500);
  };

  const handleMouseLeaveSidebar = () => {
    mouseInsideRef.current = false;
    if (pinned) return;
    if (contextMenu) return; // 컨텍스트 메뉴 열려있으면 숨기지 않음
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setVisible(false), 500);
  };

  const handleMouseEnterSidebar = () => {
    mouseInsideRef.current = true;
    if (pinned) return;
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
  };

  const handleMouseLeaveTrigger = () => {
    if (pinned) return;
    if (hoverShowTimer.current) { clearTimeout(hoverShowTimer.current); hoverShowTimer.current = null; }
  };

  return (
    <div className="session-sidebar">
      {/* 자동숨기기 모드: 세로 탭 트리거 */}
      {!pinned && (
        <div className="session-sidebar-trigger">
          <div className="session-sidebar-trigger-top" onClick={handleClickTrigger} onMouseEnter={handleMouseEnterTrigger} onMouseLeave={handleMouseLeaveTrigger} style={{ cursor: 'pointer' }} title={t('triggerTitle')}>
            <span className="session-sidebar-trigger-text">{t('triggerLabel')}</span>
          </div>
          <div className="session-sidebar-trigger-bottom" />
        </div>
      )}
      {(pinned || visible) && <div
        ref={containerRef}
        className={`session-sidebar-inner ${!pinned ? 'auto-hide' : ''}`}
        style={{ width }}
        onMouseLeave={handleMouseLeaveSidebar}
        onMouseEnter={handleMouseEnterSidebar}
      >
        <div className="session-toolbar">
          <div className="session-toolbar-title">{t('toolbarTitle')}</div>
          <button
            className={`btn-pin ${pinned ? 'pinned' : ''}`}
            onClick={() => {
              const next = !pinned;
              // flushSync: 상태 업데이트를 즉시 동기적으로 DOM에 반영
              flushSync(() => {
                setPinned(next);
                setVisible(next); // 고정 해제 → false(즉시 숨김), 고정 → true
              });
            }}
            title={pinned ? t('unpinTooltip') : t('pinTooltip')}
          >
            📌
          </button>
        </div>

        <div className="session-bottom-actions">
          <button className="btn-add" onClick={handleAddFolder} title={t('addFolder')}>📁+</button>
          <button className="btn-add" onClick={handleAdd}>{t('add')}</button>
          <button className="btn-edit" onClick={handleEdit} disabled={!selectedId}>{t('edit')}</button>
          <button className="btn-delete" onClick={handleDelete} disabled={!selectedId}>{t('delete')}</button>
        </div>

        <div
          className="session-list-scroll"
          tabIndex={0}
          onClick={e => { if (e.target === e.currentTarget) { setSelectedId(null); setSelectedType('session'); setSelectedIds(new Set()); } }}
          onKeyDown={e => {
            if (e.key === 'F2' && selectedId) {
              e.preventDefault();
              if (selectedType === 'folder') {
                const f = folders.find(x => x.id === selectedId);
                if (f) startRename(f.id, 'folder', f.name);
              } else {
                const s = sessions.find(x => x.id === selectedId);
                if (s) startRename(s.id, 'session', s.name);
              }
            }
            // Ctrl+↑/↓: 순서 이동
            if ((e.ctrlKey || e.metaKey) && e.key === 'ArrowUp' && selectedId) {
              e.preventDefault();
              (async () => { await (window as any).api.reorderSession(selectedId, selectedType, 'up'); await reload(); })();
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 'ArrowDown' && selectedId) {
              e.preventDefault();
              (async () => { await (window as any).api.reorderSession(selectedId, selectedType, 'down'); await reload(); })();
            }
            // Delete: 선택 항목 삭제
            if (e.key === 'Delete' && selectedId) {
              e.preventDefault();
              handleDelete();
            }
            // Ctrl+C: 세션/폴더 복사
            if ((e.ctrlKey || e.metaKey) && e.key === 'c' && selectedId) {
              e.preventDefault();
              if (selectedType === 'session') {
                const s = sessions.find(x => x.id === selectedId);
                if (s) { setCopiedSession(s); setCopiedFolder(null); }
              } else if (selectedType === 'folder') {
                handleCopyFolder(selectedId);
              }
            }
            // prefix 점프 — 파일 트리와 동일: startsWith, 가시 항목 순회, 같은 키 반복 시 순환
            if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && !renamingId) {
              const items: { id: string; name: string; type: 'session' | 'folder' }[] = [];
              const walk = (parentId?: string) => {
                const fs = folders.filter(f => (f.parentId ?? undefined) === (parentId ?? undefined));
                const ss = sessions.filter(s => (s.folderId ?? undefined) === (parentId ?? undefined));
                for (const f of fs) {
                  items.push({ id: f.id, name: f.name, type: 'folder' });
                  if (!collapsed.has(f.id)) walk(f.id);
                }
                for (const s of ss) items.push({ id: s.id, name: s.name, type: 'session' });
              };
              walk(undefined);
              const ch = e.key.toLowerCase();
              const curIdx = items.findIndex(x => x.id === selectedId);
              for (let i = 1; i <= items.length; i++) {
                const idx = (curIdx + i) % items.length;
                if (items[idx].name.toLowerCase().startsWith(ch)) {
                  e.preventDefault();
                  setSelectedId(items[idx].id);
                  setSelectedType(items[idx].type);
                  setSelectedIds(new Set());
                  setTimeout(() => {
                    const el = document.querySelector(`[data-session-id="${items[idx].id}"],[data-folder-id="${items[idx].id}"]`) as HTMLElement | null;
                    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                  }, 0);
                  break;
                }
              }
              return;
            }
            // Ctrl+V: 세션/폴더 붙여넣기
            if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
              if (copiedFolder) {
                e.preventDefault();
                // 폴더 선택 중이면 그 안에, 아니면 원본과 같은 레벨
                const target = selectedType === 'folder' && selectedId ? selectedId : null;
                handlePasteFolder(target);
              } else if (copiedSession) {
                e.preventDefault();
                const newSess = { ...copiedSession, id: `sess-${Date.now()}`, name: `${copiedSession.name} (${t('copySuffix')})` };
                (async () => { await (window as any).api.saveSession(newSess); await reload(); setSelectedId(newSess.id); setSelectedType('session'); })();
              }
            }
          }}
          onDragOver={e => { if (e.dataTransfer.types.includes('text/session-id')) { e.preventDefault(); setDragOverId('root'); } }}
          onDragLeave={() => setDragOverId(null)}
          onDrop={e => {
            const sid = e.dataTransfer.getData('text/session-id');
            if (sid) { e.preventDefault(); handleSessionDrop(sid, undefined); }
            setDragOverId(null);
          }}
        >
          {renderTree(undefined, 0)}
        </div>


        <div className="session-resize-handle" onPointerDown={onPointerDown} />
      </div>}

      {editing && <SessionEditor session={editing} folders={folders} onSave={onSaveSession} onSaveAndConnect={onSaveAndConnect} onCancel={() => setEditing(null)} />}

      {folderPicker && (() => {
        const renderTree = (parentId?: string, depth = 0): React.ReactNode[] => {
          const children = folders.filter(f => (f.parentId ?? undefined) === parentId);
          const nodes: React.ReactNode[] = [];
          for (const f of children) {
            const sess = sessions.find(s => s.id === folderPicker.sessionId);
            if (sess && (sess.folderId ?? undefined) === f.id) continue;
            nodes.push(
              <div key={f.id} className="folder-picker-item" style={{ paddingLeft: 12 + depth * 16 }} onClick={() => {
                (async () => { await (window as any).api.moveToFolder(folderPicker.sessionId, f.id); await reload(); })();
                setFolderPicker(null);
              }}>
                📁 {f.name}
              </div>
            );
            nodes.push(...renderTree(f.id, depth + 1));
          }
          return nodes;
        };
        return (
          <div className="folder-picker-backdrop" onClick={() => setFolderPicker(null)}>
            <div className="folder-picker" onClick={e => e.stopPropagation()}>
              <div className="folder-picker-title">{t('folderPickerTitle')}</div>
              <div className="folder-picker-list">
                <div className="folder-picker-item" onClick={() => {
                  (async () => { await (window as any).api.moveToFolder(folderPicker.sessionId, null); await reload(); })();
                  setFolderPicker(null);
                }}>
                  {t('folderRoot')}
                </div>
                {renderTree(undefined, 0)}
              </div>
              <div className="folder-picker-actions">
                <button onClick={() => setFolderPicker(null)}>{t('cancel')}</button>
              </div>
            </div>
          </div>
        );
      })()}

      {contextMenu && (
        <div
          className="context-menu"
          ref={el => {
            if (el) {
              const rect = el.getBoundingClientRect();
              const maxTop = window.innerHeight - rect.height - 8;
              if (rect.top > maxTop) el.style.top = `${Math.max(8, maxTop)}px`;
            }
          }}
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={e => e.stopPropagation()}
        >
          {selectedIds.size > 1 && selectedIds.has(contextMenu.id) ? (
            <>
              {(() => {
                const selectedSessions = sessions.filter(s => selectedIds.has(s.id));
                if (selectedSessions.length === 0) return null;
                return (
                  <>
                    <div className="context-menu-label">{t('ctxSelectedCount', { count: selectedSessions.length })}</div>
                    <div className="context-menu-label" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px' }}>
                      <span style={{ fontSize: 11, color: '#aaa' }}>{t('ctxTarget')}</span>
                      <select
                        value={multiTargetWs}
                        onChange={e => setMultiTargetWs(e.target.value)}
                        onClick={e => e.stopPropagation()}
                        style={{ flex: 1, background: '#222', color: '#eee', border: '1px solid #444', borderRadius: 3, padding: '2px 4px', fontSize: 11 }}
                      >
                        <option value="current">{t('ctxCurrentWs')}</option>
                        <option value="new">{t('ctxNewWs')}</option>
                        {workspaceTabs.filter(tab => tab.id !== activeTabId).map(tab => (
                          <option key={tab.id} value={tab.id}>{tab.title}</option>
                        ))}
                      </select>
                    </div>
                    {(() => {
                      const opts = multiTargetWs === 'current' ? undefined
                        : multiTargetWs === 'new' ? { newWorkspace: true }
                        : { targetTabId: multiTargetWs };
                      const doConnect = (mode: 'minitab' | 'split-h' | 'split-v' | 'split-tile') => {
                        onMultiConnect?.(selectedSessions, mode, opts);
                        setContextMenu(null); setSelectedIds(new Set());
                      };
                      return (
                        <>
                          <div className="context-menu-item" onClick={() => doConnect('minitab')}>{t('ctxConnectMini')}</div>
                          <div className="context-menu-item" onClick={() => doConnect('split-v')}>{t('ctxConnectVSplit')}</div>
                          <div className="context-menu-item" onClick={() => doConnect('split-h')}>{t('ctxConnectHSplit')}</div>
                          <div className="context-menu-item" onClick={() => doConnect('split-tile')}>{t('ctxConnectTile')}</div>
                        </>
                      );
                    })()}
                    <div className="context-menu-separator" />
                  </>
                );
              })()}
              <div className="context-menu-item" onClick={() => { setContextMenu(null); handleDelete(); }}>
                {t('ctxDeleteSelected')}
              </div>
            </>
          ) : (
          <>
          <div className="context-menu-item" onClick={() => { startRename(contextMenu.id, contextMenu.type, contextMenu.name); setContextMenu(null); }}>
            {t('ctxRename')}
          </div>
          <div className="context-menu-item" onClick={() => {
            setSelectedId(contextMenu.id);
            setSelectedType(contextMenu.type);
            setContextMenu(null);
            handleDelete();
          }}>
            {t('delete')}
          </div>
          {contextMenu.type === 'session' && (
            <>
              <div className="context-menu-item" onClick={() => {
                const s = sessions.find(x => x.id === contextMenu.id);
                if (s) setEditing(s);
                setContextMenu(null);
              }}>
                {t('edit')}
              </div>
              <div className="context-menu-item" onClick={() => {
                const s = sessions.find(x => x.id === contextMenu.id);
                if (s) { setCopiedSession(s); setCopiedFolder(null); }
                setContextMenu(null);
              }}>
                {t('ctxCopy')}
              </div>
            </>
          )}
          {contextMenu.type === 'folder' && (
            <div className="context-menu-item" onClick={() => {
              handleCopyFolder(contextMenu.id);
              setContextMenu(null);
            }}>
              {t('ctxCopy')}
            </div>
          )}
          {(copiedSession || copiedFolder) && (
            <div className="context-menu-item" onClick={() => {
              if (copiedFolder) {
                // 우클릭 대상이 폴더이면 그 안에, 아니면 원본과 같은 레벨
                const target = contextMenu.type === 'folder' ? contextMenu.id : null;
                handlePasteFolder(target);
              } else if (copiedSession) {
                const newSess = { ...copiedSession, id: `sess-${Date.now()}`, name: `${copiedSession.name} (${t('copySuffix')})` };
                (async () => { await (window as any).api.saveSession(newSess); await reload(); setSelectedId(newSess.id); setSelectedType('session'); })();
              }
              setContextMenu(null);
            }}>
              {t('ctxPaste')}
            </div>
          )}
          {contextMenu.type === 'session' && (
            <div className="context-menu-item" onClick={() => {
              const s = sessions.find(x => x.id === contextMenu.id);
              if (s) onFileTransfer?.(s.id, s.name);
              setContextMenu(null);
            }}>
              {t('ctxFileTransfer')}
            </div>
          )}
          {contextMenu.type === 'session' && (() => {
            const s = sessions.find(x => x.id === contextMenu.id);
            return s?.dbms ? (
              <div className="context-menu-item" onClick={() => {
                onOpenSqlTool?.(s.id, s.name);
                setContextMenu(null);
              }}>
                🗄️ SQL Tool
              </div>
            ) : null;
          })()}
          <div className="context-menu-separator" />
          <div className="context-menu-item" onClick={() => { (async () => { await (window as any).api.reorderSession(contextMenu.id, contextMenu.type, 'up'); await reload(); })(); setContextMenu(null); }}>{t('ctxUp')}</div>
          <div className="context-menu-item" onClick={() => { (async () => { await (window as any).api.reorderSession(contextMenu.id, contextMenu.type, 'down'); await reload(); })(); setContextMenu(null); }}>{t('ctxDown')}</div>
          <div className="context-menu-item" onClick={() => { (async () => { await (window as any).api.reorderSession(contextMenu.id, contextMenu.type, 'top'); await reload(); })(); setContextMenu(null); }}>{t('ctxTop')}</div>
          <div className="context-menu-item" onClick={() => { (async () => { await (window as any).api.reorderSession(contextMenu.id, contextMenu.type, 'bottom'); await reload(); })(); setContextMenu(null); }}>{t('ctxBottom')}</div>
          {contextMenu.type === 'session' && folders.length > 0 && (
            <>
              <div className="context-menu-separator" />
              <div className="context-menu-item" onClick={() => {
                setFolderPicker({ sessionId: contextMenu.id });
                setContextMenu(null);
              }}>
                {t('ctxMoveToFolder')}
              </div>
            </>
          )}
          </>
          )}
        </div>
      )}
    </div>
  );
};
