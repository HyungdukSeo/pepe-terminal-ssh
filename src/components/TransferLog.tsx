// src/components/TransferLog.tsx
// 파일 전송 트리 진행률 표시 컴포넌트
import React, { useState, useEffect, useRef } from 'react';
import { ContextMenu, MenuItem } from './ContextMenu';

const api = (window as any).api || {};

export type TransferFile = {
  rel: string;            // 루트 기준 상대 경로 ('' = 루트 자체)
  size: number;           // 총 크기 (bytes)
  transferred: number;    // 전송된 크기
  status: 'pending' | 'active' | 'done' | 'error' | 'skipped';
  startTime?: number;
  endTime?: number;
  srcPath?: string;
  dstPath?: string;
  speedSampleAt?: number;
  speedSampleVal?: number;
  speed?: number;         // 순간 속도 (bytes/sec)
  error?: string;
};

export type TransferGroup = {
  id: string;
  rootName: string;
  isDir: boolean;
  direction: 'upload' | 'download' | 'local-copy' | 'remote-remote';
  status: 'preparing' | 'active' | 'done' | 'error' | 'partial' | 'skipped' | 'cancelled';
  totalSize: number;
  transferredSize: number;
  startTime: number;
  endTime?: number;
  srcPath: string;
  dstPath: string;
  srcMode: string;
  dstMode: string;
  files: Record<string, TransferFile>;  // rel → File
  expanded: boolean;
  // 누적 속도 샘플
  speed?: number;
  speedSampleAt?: number;
  speedSampleVal?: number;
};

type LogEntry = { at: number; level: 'info' | 'error'; text: string };

const formatBytes = (n: number): string => {
  if (n == null || isNaN(n)) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
};

const formatSpeed = (bps: number): string => {
  if (!bps || bps <= 0) return '';
  return formatBytes(bps) + '/s';
};

const formatDuration = (ms: number): string => {
  if (!isFinite(ms) || ms < 0) return '00:00:00';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
};

const shorten = (p: string, max = 40): string => {
  if (!p) return '';
  if (p.length <= max) return p;
  return p.slice(0, max - 1) + '…';
};

export const TransferLog: React.FC<{ onClear?: () => void }> = () => {
  const [groups, setGroups] = useState<Record<string, TransferGroup>>({});
  const groupsRef = useRef<Record<string, TransferGroup>>({});
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [tab, setTab] = useState<'transfer' | 'log'>('transfer');
  const [, forceTick] = useState(0);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; groupId?: string } | null>(null);

  // 그룹 상태 동기화
  useEffect(() => { groupsRef.current = groups; }, [groups]);

  const updateGroup = (id: string, mutator: (g: TransferGroup) => TransferGroup) => {
    setGroups(prev => {
      const g = prev[id];
      if (!g) return prev;
      return { ...prev, [id]: mutator(g) };
    });
  };

  const log = (level: 'info' | 'error', text: string) => {
    setLogs(prev => [...prev.slice(-499), { at: Date.now(), level, text }]);
  };

  useEffect(() => {
    const unsubs: Array<() => void> = [];

    // 전송 시작 (최상위)
    unsubs.push(api.onSFTPTransferStart?.((p: any) => {
      try {
        const d = JSON.parse(p.data);
        const id = d.transferId;
        if (!id) return;
        setGroups(prev => {
          if (prev[id]) return prev;
          const g: TransferGroup = {
            id, rootName: d.rootName, isDir: !!d.isDir, direction: d.direction,
            status: 'active', totalSize: d.totalSize || 0, transferredSize: 0,
            startTime: Date.now(),
            srcPath: d.srcPath, dstPath: d.dstPath,
            srcMode: d.srcMode, dstMode: d.dstMode,
            files: {},
            expanded: !!d.isDir, // 디렉토리만 기본 펼쳐서 표시
          };
          return { ...prev, [id]: g };
        });
        log('info', `전송 시작: ${d.rootName} (${d.direction}, ${formatBytes(d.totalSize || 0)})`);
      } catch {}
    }) || (() => {}));

    // 파일별 시작 (실제 IO 직전)
    unsubs.push(api.onSFTPFileStart?.((p: any) => {
      try {
        const d = JSON.parse(p.data);
        const id = d.transferId;
        if (!id) return;
        updateGroup(id, g => {
          const rel = d.rel || '';
          const f: TransferFile = {
            rel, size: d.size || 0, transferred: 0, status: 'active', startTime: Date.now(),
            srcPath: d.srcPath, dstPath: d.dstPath,
          };
          return { ...g, files: { ...g.files, [rel]: f } };
        });
      } catch {}
    }) || (() => {}));

    // 진행률
    unsubs.push(api.onSFTPProgress?.((p: any) => {
      try {
        const d = JSON.parse(p.data);
        const id = d.transferId;
        if (!id) return; // transferId 없는 레거시 이벤트는 무시 (다른 UI 용)
        const rel = d.rel || '';
        updateGroup(id, g => {
          const prevFile = g.files[rel] || { rel, size: d.total || 0, transferred: 0, status: 'active' as const, startTime: Date.now() };
          const now = Date.now();
          // 파일 속도 — 1초 윈도우
          let fSpeed = prevFile.speed || 0;
          if (!prevFile.speedSampleAt || now - prevFile.speedSampleAt >= 500) {
            const dt = prevFile.speedSampleAt ? (now - prevFile.speedSampleAt) / 1000 : 1;
            fSpeed = dt > 0 ? Math.max(0, (d.transferred - (prevFile.speedSampleVal || 0)) / dt) : prevFile.speed || 0;
          }
          const updFile: TransferFile = {
            ...prevFile,
            transferred: d.transferred,
            size: d.total || prevFile.size,
            status: 'active',
            speed: fSpeed,
            speedSampleAt: (!prevFile.speedSampleAt || now - prevFile.speedSampleAt >= 500) ? now : prevFile.speedSampleAt,
            speedSampleVal: (!prevFile.speedSampleAt || now - prevFile.speedSampleAt >= 500) ? d.transferred : prevFile.speedSampleVal,
          };
          // 그룹 누적 — files 의 transferred 합산
          const files = { ...g.files, [rel]: updFile };
          let sum = 0; for (const k in files) sum += files[k].transferred;
          // 그룹 속도 — 1초 윈도우
          let gSpeed = g.speed || 0;
          if (!g.speedSampleAt || now - g.speedSampleAt >= 500) {
            const dt = g.speedSampleAt ? (now - g.speedSampleAt) / 1000 : 1;
            gSpeed = dt > 0 ? Math.max(0, (sum - (g.speedSampleVal || 0)) / dt) : g.speed || 0;
          }
          return {
            ...g, files, transferredSize: sum, speed: gSpeed,
            speedSampleAt: (!g.speedSampleAt || now - g.speedSampleAt >= 500) ? now : g.speedSampleAt,
            speedSampleVal: (!g.speedSampleAt || now - g.speedSampleAt >= 500) ? sum : g.speedSampleVal,
            // 사전 totalSize 가 0(원격 디렉토리 등)이면 진행 합 으로 추정
            totalSize: g.totalSize > 0 ? g.totalSize : Math.max(sum, g.totalSize),
          };
        });
      } catch {}
    }) || (() => {}));

    // 완료
    unsubs.push(api.onSFTPComplete?.((p: any) => {
      try {
        const d = JSON.parse(p.data);
        const id = d.transferId;
        if (!id) return;
        const rel = d.rel || '';
        const isDirDone = d.direction === 'dir-done';
        const isSkipped = d.direction === 'skipped';
        const isCancelled = d.direction === 'cancelled';

        // 건너뛰기/취소 — phantom 자식 행 만들지 말고 상태만 표시
        if (isSkipped || isCancelled) {
          updateGroup(id, g => {
            // 루트 자체가 skip/cancel 이면 그룹 전체 상태 변경
            if (rel === '') {
              return { ...g, status: isCancelled ? 'cancelled' : 'skipped', endTime: Date.now() };
            }
            // 자식 파일 skip — 자식 행에 'skipped' 상태로 표시
            const prevFile = g.files[rel];
            const updFile: TransferFile = {
              ...(prevFile || { rel, size: 0, transferred: 0, status: 'skipped' as const, startTime: Date.now() }),
              status: isCancelled ? 'error' : 'skipped',
              endTime: Date.now(),
            };
            return { ...g, files: { ...g.files, [rel]: updFile } };
          });
          return;
        }

        updateGroup(id, g => {
          // 파일 완료 — transferred = size
          if (!isDirDone) {
            const prevFile = g.files[rel];
            const fSize = prevFile?.size || 0;
            const updFile: TransferFile = {
              ...(prevFile || { rel, size: fSize, transferred: fSize, status: 'done' as const }),
              transferred: fSize,
              status: 'done',
              endTime: Date.now(),
            };
            const files = { ...g.files, [rel]: updFile };
            let sum = 0; for (const k in files) sum += files[k].transferred;
            return { ...g, files, transferredSize: sum };
          }
          // 디렉토리 완료 — 루트면 그룹 종료
          if (rel === '' && g.isDir) {
            return { ...g, status: 'done', endTime: Date.now(), transferredSize: g.totalSize || g.transferredSize };
          }
          return g;
        });
        // 비-디렉토리 루트 전송이면 그룹 종료
        if (!isDirDone && rel === '') {
          updateGroup(id, g => g.isDir ? g : { ...g, status: 'done', endTime: Date.now(), transferredSize: g.totalSize || g.transferredSize });
        }
      } catch {}
    }) || (() => {}));

    // 에러
    unsubs.push(api.onSFTPError?.((p: any) => {
      try {
        const d = p.data ? JSON.parse(p.data) : {};
        const id = d.transferId;
        const errStr = p.error || '알 수 없는 오류';
        log('error', `전송 오류: ${d.filename || ''} - ${errStr}`);
        if (!id) return;
        updateGroup(id, g => {
          const rel = d.rel || '';
          const prevFile = g.files[rel];
          const files = prevFile ? { ...g.files, [rel]: { ...prevFile, status: 'error' as const, error: errStr } } : g.files;
          return { ...g, files, status: 'error', endTime: Date.now() };
        });
      } catch {}
    }) || (() => {}));

    return () => { for (const u of unsubs) try { u(); } catch {} };
  }, []);

  // 200ms 마다 강제 리렌더 (경과 시간/속도 표시 업데이트)
  useEffect(() => {
    const id = setInterval(() => {
      const anyActive = Object.values(groupsRef.current).some(g => g.status === 'active' || g.status === 'preparing');
      if (anyActive) forceTick(t => t + 1);
    }, 250);
    return () => clearInterval(id);
  }, []);

  const toggleExpand = (id: string) => {
    setGroups(prev => prev[id] ? { ...prev, [id]: { ...prev[id], expanded: !prev[id].expanded } } : prev);
  };

  const clearDone = () => {
    setGroups(prev => {
      const next: Record<string, TransferGroup> = {};
      for (const k in prev) if (prev[k].status === 'active' || prev[k].status === 'preparing') next[k] = prev[k];
      return next;
    });
  };

  // 한 항목 제거 — 진행 중이면 cancel 호출, 그 다음 UI 에서 삭제
  const removeOne = async (id: string) => {
    const g = groupsRef.current[id];
    if (g && (g.status === 'active' || g.status === 'preparing')) {
      try { await api.feCancelTransfer?.(id); } catch {}
    }
    setGroups(prev => { const next = { ...prev }; delete next[id]; return next; });
  };

  // 전체 제거 — 모든 진행 중 작업 cancel + 리스트 비움
  const removeAll = async () => {
    const ids = Object.keys(groupsRef.current);
    for (const id of ids) {
      const g = groupsRef.current[id];
      if (g && (g.status === 'active' || g.status === 'preparing')) {
        try { await api.feCancelTransfer?.(id); } catch {}
      }
    }
    setGroups({});
  };

  // 파일 탐색기에서 열기 — 로컬 측 경로 사용
  const showInExplorer = (g: TransferGroup) => {
    const path = g.srcMode === 'local' ? g.srcPath : (g.dstMode === 'local' ? g.dstPath : '');
    if (path) api.shellShowItem?.(path);
  };

  // 로컬 폴더 열기 — 파일의 부모 디렉토리
  const openLocalFolder = (g: TransferGroup) => {
    const path = g.srcMode === 'local' ? g.srcPath : (g.dstMode === 'local' ? g.dstPath : '');
    if (!path) return;
    // Windows / POSIX 모두 처리
    const lastSep = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
    const dir = lastSep >= 0 ? path.slice(0, lastSep) : path;
    if (dir) api.shellOpenPath?.(dir);
  };

  // 컨텍스트 메뉴 항목 빌더
  const buildCtxItems = (groupId?: string): MenuItem[] => {
    const g = groupId ? groupsRef.current[groupId] : undefined;
    const hasLocalPath = !!(g && (g.srcMode === 'local' || g.dstMode === 'local'));
    const isActive = !!(g && (g.status === 'active' || g.status === 'preparing'));
    const hasDone = Object.values(groupsRef.current).some(x => x.status === 'done' || x.status === 'error' || x.status === 'skipped' || x.status === 'cancelled');
    const items: MenuItem[] = [];
    if (g) {
      items.push({ label: '파일 탐색기에서 열기', onClick: () => showInExplorer(g), disabled: !hasLocalPath });
      items.push({ label: '로컬 폴더 열기', onClick: () => openLocalFolder(g), disabled: !hasLocalPath });
      items.push({ separator: true });
      items.push({ label: isActive ? '전송 취소' : '제거', onClick: () => removeOne(g.id) });
    }
    items.push({ label: '모두 제거', onClick: removeAll, disabled: Object.keys(groupsRef.current).length === 0 });
    items.push({ label: '완료된 작업 제거', onClick: clearDone, disabled: !hasDone });
    return items;
  };

  const groupList = Object.values(groups).sort((a, b) => a.startTime - b.startTime);

  // 행 렌더링 — 그룹과 자식 파일들 평탄화
  type Row =
    | { kind: 'group'; group: TransferGroup }
    | { kind: 'file'; group: TransferGroup; file: TransferFile };

  const rows: Row[] = [];
  for (const g of groupList) {
    rows.push({ kind: 'group', group: g });
    if (g.isDir && g.expanded) {
      const files = Object.values(g.files).sort((a, b) => a.rel.localeCompare(b.rel));
      for (const f of files) rows.push({ kind: 'file', group: g, file: f });
    }
  }

  const statusText = (s: string) => ({
    pending: '준비',
    active: '진행 중',
    preparing: '준비',
    done: '완료',
    error: '오류',
    partial: '부분 완료',
    skipped: '건너뜀',
    cancelled: '취소됨',
  } as any)[s] || s;

  const directionArrow = (g: TransferGroup) => {
    if (g.direction === 'upload') return <span className="tl-arrow tl-up">↑</span>;
    if (g.direction === 'download') return <span className="tl-arrow tl-down">↓</span>;
    if (g.direction === 'remote-remote') return <span className="tl-arrow">⇄</span>;
    return <span className="tl-arrow">⇒</span>;
  };

  const localPath = (g: TransferGroup) => g.srcMode === 'local' ? g.srcPath : g.dstPath;
  const remotePath = (g: TransferGroup) => g.srcMode === 'remote' ? g.srcPath : (g.dstMode === 'remote' ? g.dstPath : '');

  return (
    <div className="tl-root">
      <div className="tl-tabs">
        <button className={`tl-tab ${tab === 'transfer' ? 'active' : ''}`} onClick={() => setTab('transfer')}>전송</button>
        <button className={`tl-tab ${tab === 'log' ? 'active' : ''}`} onClick={() => setTab('log')}>로그</button>
        <div className="tl-tab-spacer" />
        {tab === 'transfer' && groupList.some(g => g.status === 'done' || g.status === 'error') && (
          <button className="tl-clear-btn" onClick={clearDone} title="완료/오류 항목 지우기">완료 정리</button>
        )}
      </div>
      {tab === 'transfer' && (
        <div className="tl-table">
          <div className="tl-header tl-row">
            <div className="tl-col tl-col-name">이름</div>
            <div className="tl-col tl-col-status">상태</div>
            <div className="tl-col tl-col-progress">진행률</div>
            <div className="tl-col tl-col-size">크기</div>
            <div className="tl-col tl-col-local">로컬 경로</div>
            <div className="tl-col tl-col-dir">{'<->'}</div>
            <div className="tl-col tl-col-remote">원격 경로</div>
            <div className="tl-col tl-col-speed">속도</div>
            <div className="tl-col tl-col-eta">남은 시간</div>
            <div className="tl-col tl-col-elapsed">경과 시간</div>
          </div>
          <div className="tl-body"
            onContextMenu={e => {
              // 행 안에서 발생했으면 행 핸들러가 처리 — 빈 영역만 group=undefined 메뉴
              const target = e.target as HTMLElement;
              if (target.closest('.tl-row-group') || target.closest('.tl-row-file')) return;
              e.preventDefault();
              setCtxMenu({ x: e.clientX, y: e.clientY, groupId: undefined });
            }}
          >
            {rows.length === 0 && <div className="tl-empty">전송 대기 중..</div>}
            {rows.map((row, idx) => {
              if (row.kind === 'group') {
                const g = row.group;
                const pct = g.totalSize > 0 ? Math.min(100, Math.round(g.transferredSize / g.totalSize * 100)) : 0;
                const now = Date.now();
                const elapsed = (g.endTime || now) - g.startTime;
                const eta = g.status === 'done' ? 0 : (g.speed && g.totalSize > g.transferredSize ? (g.totalSize - g.transferredSize) / g.speed * 1000 : NaN);
                return (
                  <div key={g.id} className={`tl-row tl-row-group ${g.status}`}
                    onContextMenu={e => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, groupId: g.id }); }}>
                    <div className="tl-col tl-col-name">
                      {g.isDir ? (
                        <span className="tl-toggle" onClick={() => toggleExpand(g.id)}>{g.expanded ? '▼' : '▶'}</span>
                      ) : <span className="tl-toggle-spacer" />}
                      <span className="tl-row-icon">{g.isDir ? '📁' : '📄'}</span>
                      <span className="tl-name-text" title={g.rootName}>{g.rootName}</span>
                    </div>
                    <div className="tl-col tl-col-status">{statusText(g.status)}</div>
                    <div className="tl-col tl-col-progress">
                      <div className="tl-bar"><div className="tl-bar-fill" style={{ width: pct + '%' }} /></div>
                      <span className="tl-bar-pct">{pct}%</span>
                    </div>
                    <div className="tl-col tl-col-size">{formatBytes(g.transferredSize)}/{formatBytes(g.totalSize)}</div>
                    <div className="tl-col tl-col-local" title={localPath(g)}>{shorten(localPath(g))}</div>
                    <div className="tl-col tl-col-dir">{directionArrow(g)}</div>
                    <div className="tl-col tl-col-remote" title={remotePath(g)}>{shorten(remotePath(g))}</div>
                    <div className="tl-col tl-col-speed">{formatSpeed(g.speed || 0)}</div>
                    <div className="tl-col tl-col-eta">{formatDuration(eta)}</div>
                    <div className="tl-col tl-col-elapsed">{formatDuration(elapsed)}</div>
                  </div>
                );
              } else {
                const f = row.file;
                const g = row.group;
                const pct = f.size > 0 ? Math.min(100, Math.round(f.transferred / f.size * 100)) : 0;
                const now = Date.now();
                const elapsed = (f.endTime || now) - (f.startTime || now);
                const eta = f.status === 'done' ? 0 : (f.speed && f.size > f.transferred ? (f.size - f.transferred) / f.speed * 1000 : NaN);
                const baseName = f.rel.split('/').pop() || f.rel;
                const depth = (f.rel.match(/\//g) || []).length;
                return (
                  <div key={`${g.id}/${f.rel}/${idx}`} className={`tl-row tl-row-file ${f.status}`}
                    onContextMenu={e => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, groupId: g.id }); }}>
                    <div className="tl-col tl-col-name" style={{ paddingLeft: 16 + depth * 12 }}>
                      <span className="tl-toggle-spacer" />
                      <span className="tl-row-icon">📄</span>
                      <span className="tl-name-text" title={f.rel}>{baseName}</span>
                    </div>
                    <div className="tl-col tl-col-status">{statusText(f.status)}</div>
                    <div className="tl-col tl-col-progress">
                      <div className="tl-bar"><div className="tl-bar-fill" style={{ width: pct + '%' }} /></div>
                      <span className="tl-bar-pct">{pct}%</span>
                    </div>
                    <div className="tl-col tl-col-size">{formatBytes(f.size)}</div>
                    <div className="tl-col tl-col-local" title={g.srcMode === 'local' ? f.srcPath : f.dstPath}>{shorten(g.srcMode === 'local' ? (f.srcPath || '') : (f.dstPath || ''))}</div>
                    <div className="tl-col tl-col-dir">{directionArrow(g)}</div>
                    <div className="tl-col tl-col-remote" title={g.srcMode === 'remote' ? f.srcPath : f.dstPath}>{shorten(g.srcMode === 'remote' ? (f.srcPath || '') : (f.dstPath || ''))}</div>
                    <div className="tl-col tl-col-speed">{formatSpeed(f.speed || 0)}</div>
                    <div className="tl-col tl-col-eta">{formatDuration(eta)}</div>
                    <div className="tl-col tl-col-elapsed">{formatDuration(elapsed)}</div>
                  </div>
                );
              }
            })}
          </div>
        </div>
      )}
      {tab === 'log' && (
        <div className="tl-log">
          {logs.length === 0 && <div className="tl-empty">로그 없음</div>}
          {logs.map((l, i) => (
            <div key={i} className={`tl-log-line ${l.level}`}>
              <span className="tl-log-time">{new Date(l.at).toLocaleTimeString()}</span>
              <span className="tl-log-text">{l.text}</span>
            </div>
          ))}
        </div>
      )}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={buildCtxItems(ctxMenu.groupId)}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
};
