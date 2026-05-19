// src/components/TransferLog.tsx
// 파일 전송 트리 진행률 표시 컴포넌트
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { ContextMenu, MenuItem } from './ContextMenu';

const api = (window as any).api || {};

export type TransferFile = {
  rel: string;            // 루트 기준 상대 경로 ('' = 루트 자체)
  size: number;           // 총 크기 (bytes)
  transferred: number;    // 전송된 크기
  status: 'pending' | 'active' | 'done' | 'error' | 'skipped';
  isDir?: boolean;        // 디렉토리 행 여부
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

type DeleteOp = {
  id: string;
  rootName: string;
  totalCount: number;
  doneCount: number;
  currentName: string;
  status: 'active' | 'done' | 'error';
  startTime: number;
  endTime?: number;
  path: string;
  mode: string;
  error?: string;
};

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

type DirAgg = { totalSize: number; transferred: number; speed: number; hasActive: boolean; allDone: boolean; count: number; doneCount: number };

// 개별 디렉토리 집계 — fallback 또는 소규모용 (O(N) per call)
function getDirAggregated(files: Record<string, TransferFile>, dirRel: string): DirAgg {
  const prefix = dirRel ? dirRel + '/' : '';
  const descendants = Object.values(files).filter(f => !f.isDir && f.rel.startsWith(prefix));
  const totalSize = descendants.reduce((a, f) => a + f.size, 0);
  const transferred = descendants.reduce((a, f) => a + f.transferred, 0);
  const speed = descendants.reduce((a, f) => a + (f.speed || 0), 0);
  const hasActive = descendants.some(f => f.status === 'active');
  const doneCount = descendants.filter(f => f.status === 'done' || f.status === 'skipped' || f.status === 'error').length;
  const allDone = descendants.length > 0 && doneCount === descendants.length;
  return { totalSize, transferred, speed, hasActive, allDone, count: descendants.length, doneCount };
}

// 모든 디렉토리 집계를 단일 패스로 계산 — O(N × depth) vs 기존 O(N_dirs × N_files)
// Object.values(files) 를 한 번만 순회하여 각 파일이 상위 디렉토리 집계에 직접 누산
function getDirAggregatedAll(files: Record<string, TransferFile>): Record<string, DirAgg> {
  const make = (): DirAgg => ({ totalSize: 0, transferred: 0, speed: 0, hasActive: false, allDone: false, count: 0, doneCount: 0 });
  const result: Record<string, DirAgg> = { '': make() };
  // 디렉토리 항목 초기화
  for (const f of Object.values(files)) {
    if (f.isDir) result[f.rel] = make();
  }
  // 파일 한 번 순회 → 모든 조상 디렉토리에 누산
  for (const f of Object.values(files)) {
    if (f.isDir) continue;
    const isDone = f.status === 'done' || f.status === 'skipped' || f.status === 'error';
    const isActive = f.status === 'active';
    const parts = f.rel.split('/');
    for (let d = 0; d < parts.length; d++) {
      const ancestor = d === 0 ? '' : parts.slice(0, d).join('/');
      const agg = result[ancestor];
      if (!agg) continue;
      agg.totalSize += f.size;
      agg.transferred += f.transferred;
      agg.speed += f.speed || 0;
      if (isActive) agg.hasActive = true;
      agg.count++;
      if (isDone) agg.doneCount++;
    }
  }
  for (const rel in result) {
    const a = result[rel];
    a.allDone = a.count > 0 && a.doneCount === a.count;
  }
  return result;
}

const shorten = (p: string, max = 40): string => {
  if (!p) return '';
  if (p.length <= max) return p;
  return p.slice(0, max - 1) + '…';
};

export const TransferLog: React.FC<{ onClear?: () => void; workspaceId?: string }> = ({ workspaceId }) => {
  const [groups, setGroups] = useState<Record<string, TransferGroup>>({});
  const groupsRef = useRef<Record<string, TransferGroup>>({});
  const [deleteOps, setDeleteOps] = useState<Record<string, DeleteOp>>({});
  const deleteOpsRef = useRef<Record<string, DeleteOp>>({});
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [tab, setTab] = useState<'transfer' | 'log'>('transfer');
  const [, forceTick] = useState(0);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; groupId?: string } | null>(null);
  // 하위 디렉토리 접힘 상태 — `${groupId}/${rel}` 키가 Set에 있으면 접힌 것
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
  // 이벤트 배치 버퍼 — 200ms마다 한 번만 setGroups 호출해 React 렌더링 폭주 방지
  // sftp-file-start / sftp-dir-list / sftp-progress / sftp-complete 모두 배치처리
  const pendingProgressRef      = useRef<Map<string, Map<string, any>>>(new Map()); // transferId → rel → progressData
  const pendingFileStartRef     = useRef<Map<string, Map<string, any>>>(new Map()); // transferId → rel → fileStartData
  const pendingDirListRef       = useRef<Map<string, any[]>>(new Map());            // transferId → dirList[]
  const pendingCompleteRef      = useRef<Map<string, Map<string, any>>>(new Map()); // transferId → rel → completeData
  const pendingCollapseRef      = useRef<Array<string>>([]);                        // "${id}/${rel}" keys to collapse
  const pendingDeleteProgressRef = useRef<Map<string, any>>(new Map());             // deleteId → latest progress data
  const progressFlushRef        = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── 가상 스크롤 (virtual scroll) ──────────────────────────────────────────
  // 1000+개 행을 DOM에 모두 유지하면 레이아웃/페인트 비용이 큼
  // → 뷰포트 내 + 버퍼(OVERSCAN)만 렌더링, 나머지는 빈 div 높이로 자리 확보
  const ROW_H = 26;                   // CSS .tl-row 명시 높이 (px)
  const bodyRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [bodyHeight, setBodyHeight] = useState(300);
  const handleBodyScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop((e.target as HTMLDivElement).scrollTop);
  }, []);

  const toggleSubDir = (groupId: string, rel: string) => {
    const key = `${groupId}/${rel}`;
    setCollapsedDirs(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  // 그룹 상태 동기화
  useEffect(() => { groupsRef.current = groups; }, [groups]);
  useEffect(() => { deleteOpsRef.current = deleteOps; }, [deleteOps]);

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
        // workspaceId 필터 — 자신의 워크스페이스에서 시작한 전송만 표시
        if (workspaceId && d.workspaceId && d.workspaceId !== workspaceId) return;
        setGroups(prev => {
          if (prev[id]) {
            // 두 번째 이벤트 — totalSize/isDir 업데이트 (디렉토리 크기 확인 후 재emit)
            if (d.totalSize > 0 || d.isDir !== prev[id].isDir) {
              // totalSize/isDir 업데이트 — expanded 는 유지 (사용자가 열었을 수 있음)
              return { ...prev, [id]: { ...prev[id], totalSize: d.totalSize || prev[id].totalSize, isDir: !!d.isDir } };
            }
            return prev;
          }
          const g: TransferGroup = {
            id, rootName: d.rootName, isDir: !!d.isDir, direction: d.direction,
            status: 'active', totalSize: d.totalSize || 0, transferredSize: 0,
            startTime: Date.now(),
            srcPath: d.srcPath, dstPath: d.dstPath,
            srcMode: d.srcMode, dstMode: d.dstMode,
            files: {},
            expanded: false,   // 기본 접힘 — 사용자가 ▶ 클릭 시 펼침
          };
          return { ...prev, [id]: g };
        });
        log('info', `전송 시작: ${d.rootName} (${d.direction}, ${formatBytes(d.totalSize || 0)})`);
      } catch {}
    }) || (() => {}));

    // ── 배치 flush ──
    // main.ts 에서 setImmediate 로 묶인 sftp:batch 이벤트를 받아 버퍼에 분배.
    // 그 후 200ms setTimeout 으로 한 번만 setGroups 호출 → React 렌더 최소화.
    const scheduleFlush = () => {
      if (!progressFlushRef.current) {
        progressFlushRef.current = setTimeout(flushPending, 300);
      }
    };

    // sftp:batch 단일 구독 — file-start / dir-list / progress / complete / delete-progress 모두 처리
    // (main.ts 에서 setImmediate 로 묶인 배치를 받아 각 버퍼에 분배)
    unsubs.push(api.onSFTPBatch?.((batch: Array<{ channel: string; payload: any }>) => {
      let hasDeleteProgress = false;
      for (const item of batch) {
        try {
          const p = item.payload;
          const channel = item.channel;
          if (channel === 'sftp:file-start') {
            const d = JSON.parse(p.data);
            const id = d.transferId;
            if (!id) continue;
            const rel = d.rel || '';
            if (!pendingFileStartRef.current.has(id)) pendingFileStartRef.current.set(id, new Map());
            pendingFileStartRef.current.get(id)!.set(rel, d);
          } else if (channel === 'sftp:dir-list') {
            const d = JSON.parse(p.data);
            const id = d.transferId;
            if (!id) continue;
            if (!pendingDirListRef.current.has(id)) pendingDirListRef.current.set(id, []);
            pendingDirListRef.current.get(id)!.push(d);
            if (d.rel) pendingCollapseRef.current.push(`${id}/${d.rel}`);
          } else if (channel === 'sftp:progress') {
            const d = JSON.parse(p.data);
            const id = d.transferId;
            if (!id) continue;
            const rel = d.rel || '';
            if (!pendingProgressRef.current.has(id)) pendingProgressRef.current.set(id, new Map());
            pendingProgressRef.current.get(id)!.set(rel, d);
          } else if (channel === 'sftp:complete') {
            const d = JSON.parse(p.data);
            const id = d.transferId;
            if (!id) continue;
            const rel = d.rel || '';
            if (!pendingCompleteRef.current.has(id)) pendingCompleteRef.current.set(id, new Map());
            pendingCompleteRef.current.get(id)!.set(rel, d);
          } else if (channel === 'sftp:delete-progress') {
            // delete-progress 는 setDeleteOps 직접 처리 (배치 내 마지막 상태만 반영)
            const d = JSON.parse(p.data);
            if (!d.deleteId) continue;
            if (workspaceId && d.workspaceId && d.workspaceId !== workspaceId) continue;
            pendingDeleteProgressRef.current.set(d.deleteId, d);
            hasDeleteProgress = true;
          }
        } catch {}
      }
      // delete-progress 가 있으면 즉시 setDeleteOps (별도 state라 flush 필요)
      if (hasDeleteProgress) {
        const snap = new Map(pendingDeleteProgressRef.current);
        pendingDeleteProgressRef.current.clear();
        setDeleteOps(prev => {
          let next = prev;
          for (const [id, d] of snap) {
            const op = next[id];
            if (!op) continue;
            next = { ...next, [id]: { ...op, doneCount: d.done, currentName: d.currentName || '' } };
          }
          return next;
        });
      }
      scheduleFlush();
    }) || (() => {}));
    const flushPending = () => {
      progressFlushRef.current = null;
      // 버퍼 스냅샷 (flush 중 들어오는 이벤트는 새 버퍼에 쌓임)
      const progBuf  = pendingProgressRef.current;
      const startBuf = pendingFileStartRef.current;
      const dirBuf   = pendingDirListRef.current;
      const doneBuf  = pendingCompleteRef.current;
      const collBuf  = pendingCollapseRef.current;
      const hasWork  = progBuf.size > 0 || startBuf.size > 0 || dirBuf.size > 0 || doneBuf.size > 0 || collBuf.length > 0;
      if (!hasWork) return;
      pendingProgressRef.current  = new Map();
      pendingFileStartRef.current = new Map();
      pendingDirListRef.current   = new Map();
      pendingCompleteRef.current  = new Map();
      pendingCollapseRef.current  = [];

      // 접힘 상태 업데이트 (setCollapsedDirs 는 별도 state)
      if (collBuf.length > 0) {
        setCollapsedDirs(prev => {
          const next = new Set(prev);
          for (const k of collBuf) next.add(k);
          return next;
        });
      }

      setGroups(prev => {
        let next = prev;
        const now = Date.now();

        // 1) sftp-dir-list — 새 파일 행을 'pending' 으로 추가
        // [O(N) 최적화] 변경분을 newEntries 에 모아 ONE spread — 루프당 1000번 복사 방지
        for (const [id, events] of dirBuf) {
          const g = next[id];
          if (!g) continue;
          const newEntries: Record<string, TransferFile> = {};
          for (const ev of events) {
            for (const entry of (ev.entries || [])) {
              if (!g.files[entry.rel] && !newEntries[entry.rel]) {
                newEntries[entry.rel] = { rel: entry.rel, size: 0, transferred: 0, status: 'pending' as const, isDir: !!entry.isDir };
              }
            }
          }
          if (Object.keys(newEntries).length > 0) {
            next = { ...next, [id]: { ...g, files: { ...g.files, ...newEntries } } };
          }
        }

        // 2) sftp-file-start — 파일 행을 'active' 로 전환
        // [O(N) 최적화] updates 맵에 모아 ONE spread
        for (const [id, relMap] of startBuf) {
          const g = next[id];
          if (!g) continue;
          const updates: Record<string, TransferFile> = {};
          let totalSize = g.totalSize;
          for (const [rel, d] of relMap) {
            const isDir = !!d.isDir;
            updates[rel] = { rel, size: d.size || 0, transferred: 0, status: 'active', startTime: now, isDir, srcPath: d.srcPath, dstPath: d.dstPath };
            if (!isDir && totalSize === 0 && d.size > 0) totalSize = g.transferredSize + d.size;
          }
          next = { ...next, [id]: { ...g, files: { ...g.files, ...updates }, totalSize } };
        }

        // 3) sftp-progress — 전송량 업데이트
        // [O(N) 최적화] delta 합산으로 전체 files 순회(sum) 제거 + ONE spread
        for (const [id, relMap] of progBuf) {
          const g = next[id];
          if (!g) continue;
          const updates: Record<string, TransferFile> = {};
          let sumDelta = 0;
          for (const [rel, d] of relMap) {
            const prevFile = g.files[rel] || { rel, size: d.total || 0, transferred: 0, status: 'active' as const, startTime: now };
            sumDelta += d.transferred - (prevFile.transferred || 0);
            let fSpeed = prevFile.speed || 0;
            if (!prevFile.speedSampleAt || now - prevFile.speedSampleAt >= 500) {
              const dt = prevFile.speedSampleAt ? (now - prevFile.speedSampleAt) / 1000 : 1;
              fSpeed = dt > 0 ? Math.max(0, (d.transferred - (prevFile.speedSampleVal || 0)) / dt) : 0;
            }
            updates[rel] = {
              ...prevFile,
              transferred: d.transferred, size: d.total || prevFile.size, status: 'active',
              speed: fSpeed,
              speedSampleAt: (!prevFile.speedSampleAt || now - prevFile.speedSampleAt >= 500) ? now : prevFile.speedSampleAt,
              speedSampleVal: (!prevFile.speedSampleAt || now - prevFile.speedSampleAt >= 500) ? d.transferred : prevFile.speedSampleVal,
            };
          }
          const newSum = Math.max(0, (g.transferredSize || 0) + sumDelta);
          let gSpeed = g.speed || 0;
          if (!g.speedSampleAt || now - g.speedSampleAt >= 500) {
            const dt = g.speedSampleAt ? (now - g.speedSampleAt) / 1000 : 1;
            gSpeed = dt > 0 ? Math.max(0, (newSum - (g.speedSampleVal || 0)) / dt) : 0;
          }
          next = { ...next, [id]: { ...g,
            files: { ...g.files, ...updates },
            transferredSize: newSum, speed: gSpeed,
            speedSampleAt: (!g.speedSampleAt || now - g.speedSampleAt >= 500) ? now : g.speedSampleAt,
            speedSampleVal: (!g.speedSampleAt || now - g.speedSampleAt >= 500) ? newSum : g.speedSampleVal,
            totalSize: g.totalSize > 0 ? g.totalSize : Math.max(newSum, g.totalSize),
          }};
        }

        // 4) sftp-complete — 파일/디렉토리 완료 처리
        // [O(N) 최적화] updates 맵에 모아 ONE spread + delta로 sum 계산
        for (const [id, relMap] of doneBuf) {
          const g = next[id];
          if (!g) continue;
          const updates: Record<string, TransferFile> = {};
          let groupStatus = g.status;
          let groupEndTime = g.endTime;
          let groupTransferred = g.transferredSize;
          let sumDelta = 0;
          for (const [rel, d] of relMap) {
            const isDirDone = d.direction === 'dir-done';
            const isSkipped = d.direction === 'skipped';
            const isCancelled = d.direction === 'cancelled';
            if (isSkipped || isCancelled) {
              if (rel === '') { groupStatus = isCancelled ? 'cancelled' : 'skipped'; groupEndTime = now; }
              else {
                const pf = g.files[rel] || updates[rel];
                updates[rel] = { ...(pf || { rel, size: 0, transferred: 0, startTime: now }), status: isCancelled ? 'error' as const : 'skipped' as const, endTime: now };
              }
            } else if (!isDirDone) {
              const pf = g.files[rel] || updates[rel];
              const fSize = pf?.size || 0;
              sumDelta += fSize - (pf?.transferred || 0);
              updates[rel] = { ...(pf || { rel, size: fSize, transferred: fSize, startTime: now }), transferred: fSize, status: 'done' as const, endTime: now };
              if (rel === '') { groupStatus = 'done'; groupEndTime = now; groupTransferred = g.totalSize || groupTransferred; }
            } else {
              // dir-done
              if (rel === '' && g.isDir) { groupStatus = 'done'; groupEndTime = now; groupTransferred = g.totalSize || groupTransferred; }
              else if (rel !== '') {
                const pf = g.files[rel] || updates[rel];
                if (pf) updates[rel] = { ...pf, status: 'done' as const, endTime: now };
              }
            }
          }
          const newTransferred = Math.max(groupTransferred, groupTransferred + sumDelta);
          next = { ...next, [id]: { ...g,
            files: Object.keys(updates).length > 0 ? { ...g.files, ...updates } : g.files,
            status: groupStatus, endTime: groupEndTime, transferredSize: newTransferred,
          }};
        }

        return next;
      });
    };

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

    // 삭제 시작
    unsubs.push(api.onSFTPDeleteStart?.((p: any) => {
      try {
        const d = JSON.parse(p.data);
        const id = d.deleteId;
        if (!id) return;
        // workspaceId 필터 — 자신의 워크스페이스에서 시작한 삭제만 표시
        if (workspaceId && d.workspaceId && d.workspaceId !== workspaceId) return;
        setDeleteOps(prev => {
          if (prev[id]) {
            // 두 번째 emit — totalCount 업데이트
            if (d.totalCount > 0) return { ...prev, [id]: { ...prev[id], totalCount: d.totalCount } };
            return prev;
          }
          const op: DeleteOp = {
            id, rootName: d.rootName, totalCount: d.totalCount || 0,
            doneCount: 0, currentName: '', status: 'active',
            startTime: Date.now(), path: d.path || '', mode: d.mode || '',
          };
          return { ...prev, [id]: op };
        });
      } catch {}
    }) || (() => {}));

    // 삭제 진행
    // delete-progress 는 onSFTPBatch 에서 처리 (main.ts 가 배치로 묶어 전송)

    // 삭제 완료
    unsubs.push(api.onSFTPDeleteComplete?.((p: any) => {
      try {
        const d = JSON.parse(p.data);
        const id = d.deleteId;
        if (!id) return;
        if (workspaceId && d.workspaceId && d.workspaceId !== workspaceId) return;
        setDeleteOps(prev => {
          const op = prev[id];
          if (!op) return prev;
          return { ...prev, [id]: { ...op, status: d.success ? 'done' : 'error', endTime: Date.now(), doneCount: d.done ?? op.doneCount, error: d.error } };
        });
      } catch {}
    }) || (() => {}));

    return () => {
      for (const u of unsubs) try { u(); } catch {}
      if (progressFlushRef.current) { clearTimeout(progressFlushRef.current); progressFlushRef.current = null; }
      pendingProgressRef.current       = new Map();
      pendingFileStartRef.current      = new Map();
      pendingDirListRef.current        = new Map();
      pendingCompleteRef.current       = new Map();
      pendingCollapseRef.current       = [];
      pendingDeleteProgressRef.current = new Map();
    };
  }, []);

  // 200ms 마다 강제 리렌더 (경과 시간/속도 표시 업데이트)
  useEffect(() => {
    const id = setInterval(() => {
      const anyActive = Object.values(groupsRef.current).some(g => g.status === 'active' || g.status === 'preparing')
        || Object.values(deleteOpsRef.current).some(op => op.status === 'active');
      if (anyActive) forceTick(t => t + 1);
    }, 500);  // 경과시간 표시용 — 500ms면 충분히 자연스러움
    return () => clearInterval(id);
  }, []);

  // tl-body 높이 변화 감지 — virtual scroll 계산에 사용
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    setBodyHeight(el.clientHeight);
    const ro = new ResizeObserver(() => setBodyHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
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
    setDeleteOps(prev => {
      const next: Record<string, DeleteOp> = {};
      for (const k in prev) if (prev[k].status === 'active') next[k] = prev[k];
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
    setDeleteOps({});
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
    const hasDone = Object.values(groupsRef.current).some(x => x.status === 'done' || x.status === 'error' || x.status === 'skipped' || x.status === 'cancelled')
      || Object.values(deleteOpsRef.current).some(x => x.status === 'done' || x.status === 'error');
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

  // 행 렌더링 — 그룹과 자식 파일들 평탄화
  type Row =
    | { kind: 'group'; group: TransferGroup }
    | { kind: 'file'; group: TransferGroup; file: TransferFile };

  const groupList = useMemo(
    () => Object.values(groups).sort((a, b) => a.startTime - b.startTime),
    [groups],
  );

  // ── useMemo 캐시 ──────────────────────────────────────────────────────────
  // groups 변경 시에만 재계산 — forceTick(250ms) 마다 재실행되던 O(N²) 연산 제거

  // 1) 파일 정렬 캐시 — groups 변경 시에만 실행, 정렬 키 사전 계산으로 O(N) 할당
  const sortedFilesCache = useMemo(() => {
    const cache: Record<string, TransferFile[]> = {};
    for (const g of groupList) {
      if (!g.isDir || !g.expanded) continue;  // 접힌 그룹은 정렬 불필요
      const fileList = Object.values(g.files);
      const dirSet = new Set(fileList.filter(f => f.isDir).map(f => f.rel));
      // 정렬 키를 comparator 안에서 매번 생성하면 O(N log N) 할당 → 사전 계산으로 O(N)
      const withKeys = fileList.map(f => ({
        f,
        key: f.rel.split('/').map((seg, i, parts) => {
          const segRel = parts.slice(0, i + 1).join('/');
          return (dirSet.has(segRel) ? '\x00' : '\x01') + seg.toLowerCase();
        }).join('/'),
      }));
      withKeys.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      cache[g.id] = withKeys.map(x => x.f);
    }
    return cache;
  }, [groups, groupList]);

  // 2) 모든 디렉토리 집계 캐시 — getDirAggregatedAll 단일 패스 O(N×depth)
  //    기존: getDirAggregated × N_dirs = O(N_dirs × N_files) 반복 + 매 호출마다 Object.values 배열 생성
  //    개선: 파일 1회 순회로 모든 조상 디렉토리에 누산 → GC 압박·CPU 사용 대폭 감소
  const dirAggCache = useMemo(() => {
    const cache: Record<string, Record<string, DirAgg>> = {};
    for (const g of Object.values(groups)) {
      if (!g.isDir) continue;
      cache[g.id] = getDirAggregatedAll(g.files);
    }
    return cache;
  }, [groups]);

  // 3) rows 배열 캐시 — groups/collapsedDirs 변경 시에만 재구성
  const rows = useMemo<Row[]>(() => {
    const result: Row[] = [];
    for (const g of groupList) {
      result.push({ kind: 'group', group: g });
      if (g.isDir && g.expanded) {
        const files = sortedFilesCache[g.id] || [];
        for (const f of files) {
          const parts = f.rel.split('/');
          let hidden = false;
          for (let i = 1; i < parts.length; i++) {
            if (collapsedDirs.has(`${g.id}/${parts.slice(0, i).join('/')}`)) { hidden = true; break; }
          }
          if (!hidden) result.push({ kind: 'file', group: g, file: f });
        }
      }
    }
    return result;
  }, [groupList, collapsedDirs, sortedFilesCache]);

  // ── 가상 스크롤 계산 ──────────────────────────────────────────────────────
  // deleteOps 행은 항상 최상단에 고정 표시 (개수가 적어 가상화 제외)
  const deleteOpCount = Object.keys(deleteOps).length;
  const deleteOpsHeight = deleteOpCount * ROW_H;
  const OVERSCAN = 4;
  const totalVHeight = rows.length * ROW_H;
  // 스크롤 오프셋에서 deleteOps 고정 높이를 뺀 뒤 transfer rows 내 위치 계산
  const transferScrollTop = Math.max(0, scrollTop - deleteOpsHeight);
  const visStart = Math.max(0, Math.floor(transferScrollTop / ROW_H) - OVERSCAN);
  const visEnd   = Math.min(rows.length, Math.ceil((transferScrollTop + bodyHeight) / ROW_H) + OVERSCAN);
  const padTop    = visStart * ROW_H;
  const padBottom = Math.max(0, (rows.length - visEnd) * ROW_H);

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
          <div className="tl-body" ref={bodyRef} onScroll={handleBodyScroll}
            onContextMenu={e => {
              const target = e.target as HTMLElement;
              if (target.closest('.tl-row-group') || target.closest('.tl-row-file')) return;
              e.preventDefault();
              setCtxMenu({ x: e.clientX, y: e.clientY, groupId: undefined });
            }}
          >
            {/* 가상 스크롤 래퍼 — 전체 높이를 유지하고 뷰포트 내 행만 렌더링 */}
            <div style={{ height: totalVHeight + deleteOpsHeight, position: 'relative' }}>
            <div style={{ paddingTop: padTop, paddingBottom: padBottom }}>
            {rows.length === 0 && Object.keys(deleteOps).length === 0 && <div className="tl-empty">전송 대기 중..</div>}
            {/* 삭제 진행 행 */}
            {Object.values(deleteOps).sort((a, b) => a.startTime - b.startTime).map(op => {
              const now = Date.now();
              const pct = op.totalCount > 0 ? Math.min(100, Math.round(op.doneCount / op.totalCount * 100)) : (op.status === 'done' ? 100 : 0);
              const elapsed = (op.endTime || now) - op.startTime;
              return (
                <div key={op.id} className={`tl-row tl-row-group tl-row-delete ${op.status}`}
                  onContextMenu={e => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, groupId: undefined }); }}>
                  <div className="tl-col tl-col-name">
                    <span className="tl-toggle-spacer" />
                    <span className="tl-row-icon">🗑</span>
                    <span className="tl-name-text" title={op.rootName}>{op.rootName}</span>
                    {op.status === 'active' && op.currentName && (
                      <span className="tl-delete-current" title={op.currentName}> — {op.currentName}</span>
                    )}
                  </div>
                  <div className="tl-col tl-col-status">{op.status === 'active' ? '삭제 중' : op.status === 'done' ? '완료' : '오류'}</div>
                  <div className="tl-col tl-col-progress">
                    <div className="tl-bar"><div className="tl-bar-fill tl-bar-delete" style={{ width: pct + '%' }} /></div>
                    <span className="tl-bar-pct">{pct}%</span>
                  </div>
                  <div className="tl-col tl-col-size">
                    {op.totalCount > 0 ? `${op.doneCount}/${op.totalCount}개` : op.doneCount > 0 ? `${op.doneCount}개` : '—'}
                  </div>
                  <div className="tl-col tl-col-local" title={op.path}>{shorten(op.path)}</div>
                  <div className="tl-col tl-col-dir"><span className="tl-arrow">🗑</span></div>
                  <div className="tl-col tl-col-remote">{op.error || ''}</div>
                  <div className="tl-col tl-col-speed" />
                  <div className="tl-col tl-col-eta" />
                  <div className="tl-col tl-col-elapsed">{formatDuration(elapsed)}</div>
                </div>
              );
            })}
            {/* 가상 스크롤: visStart~visEnd 범위만 렌더 */}
            {rows.slice(visStart, visEnd).map((row, _sliceIdx) => {
              if (row.kind === 'group') {
                const g = row.group;
                let pct: number;
                if (g.isDir) {
                  const agg = dirAggCache[g.id]?.[''];
                  pct = agg && agg.count > 0 ? Math.min(100, Math.round(agg.doneCount / agg.count * 100)) : (g.status === 'done' ? 100 : 0);
                } else {
                  pct = g.totalSize > 0 ? Math.min(100, Math.round(g.transferredSize / g.totalSize * 100)) : (g.status === 'done' ? 100 : 0);
                }
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
                const now = Date.now();
                const baseName = f.rel.split('/').pop() || f.rel;
                const depth = (f.rel.match(/\//g) || []).length;

                if (f.isDir) {
                  // 서브디렉토리 행 — dirAggCache 에서 O(1) 조회 (캐시됨)
                  const agg = dirAggCache[g.id]?.[f.rel] || getDirAggregated(g.files, f.rel);
                  const dirStatus = agg.allDone ? 'done' : agg.hasActive ? 'active' : (f.status === 'done' ? 'done' : 'pending');
                  const dirPct = agg.count > 0 ? Math.min(100, Math.round(agg.doneCount / agg.count * 100)) : (agg.allDone ? 100 : 0);
                  const elapsed = (f.endTime || now) - (f.startTime || now);
                  const dirEta = dirStatus === 'done' ? 0 : (agg.speed > 0 && agg.totalSize > agg.transferred ? (agg.totalSize - agg.transferred) / agg.speed * 1000 : NaN);
                  return (
                    <div key={`${g.id}/${f.rel}`} className={`tl-row tl-row-file tl-row-subdir ${dirStatus}`}
                      onContextMenu={e => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, groupId: g.id }); }}>
                      <div className="tl-col tl-col-name" style={{ paddingLeft: 16 + depth * 12 }}>
                        <span className="tl-toggle" onClick={() => toggleSubDir(g.id, f.rel)}>
                          {collapsedDirs.has(`${g.id}/${f.rel}`) ? '▶' : '▼'}
                        </span>
                        <span className="tl-row-icon">📁</span>
                        <span className="tl-name-text" title={f.rel}>{baseName}</span>
                      </div>
                      <div className="tl-col tl-col-status">{statusText(dirStatus)}</div>
                      <div className="tl-col tl-col-progress">
                        <div className="tl-bar"><div className="tl-bar-fill" style={{ width: dirPct + '%' }} /></div>
                        <span className="tl-bar-pct">{dirPct}%</span>
                      </div>
                      <div className="tl-col tl-col-size">
                        {agg.totalSize > 0 ? `${formatBytes(agg.transferred)}/${formatBytes(agg.totalSize)}` : '—'}
                      </div>
                      <div className="tl-col tl-col-local" title={g.srcMode === 'local' ? f.srcPath : f.dstPath}>{shorten(g.srcMode === 'local' ? (f.srcPath || '') : (f.dstPath || ''))}</div>
                      <div className="tl-col tl-col-dir">{directionArrow(g)}</div>
                      <div className="tl-col tl-col-remote" title={g.srcMode === 'remote' ? f.srcPath : f.dstPath}>{shorten(g.srcMode === 'remote' ? (f.srcPath || '') : (f.dstPath || ''))}</div>
                      <div className="tl-col tl-col-speed">{agg.speed > 0 ? formatSpeed(agg.speed) : ''}</div>
                      <div className="tl-col tl-col-eta">{formatDuration(dirEta)}</div>
                      <div className="tl-col tl-col-elapsed">{formatDuration(elapsed)}</div>
                    </div>
                  );
                }

                // 파일 행
                const pct = f.size > 0 ? Math.min(100, Math.round(f.transferred / f.size * 100)) : 0;
                const elapsed = (f.endTime || now) - (f.startTime || now);
                const eta = f.status === 'done' ? 0 : (f.speed && f.size > f.transferred ? (f.size - f.transferred) / f.speed * 1000 : NaN);
                return (
                  <div key={`${g.id}/${f.rel}`} className={`tl-row tl-row-file ${f.status}`}
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
                    <div className="tl-col tl-col-size">{f.size > 0 ? formatBytes(f.size) : ''}</div>
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
            </div>{/* padTop/padBottom 내부 div 닫기 */}
            </div>{/* totalVHeight 컨테이너 닫기 */}
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
