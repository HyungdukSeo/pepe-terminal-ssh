// src/components/CompareWorkspace.tsx
// 파일 비교 워크스페이스 — 두 디렉토리(로컬/원격 SFTP) 를 재귀 walk 한 후
// 동일 상대경로의 파일 쌍에 대해 size 기반 상태(same/changed/left-only/right-only) 산출.
// 행 클릭 시 하단 Monaco DiffEditor 에서 양쪽 파일 내용 비교.
import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { FixedSizeList as VList, ListChildComponentProps } from 'react-window';
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react';
import type { PanelSession } from '../utils/layoutUtils';
import { matchKeybinding, getKeybinding, formatKeyComboForOS } from '../utils/keybindings';
import { RemotePathPicker } from './RemotePathPicker';

const api = (window as any).api || {};

type Side = 'left' | 'right';
type SourceMode = 'local' | 'remote';
type Source = {
  mode: SourceMode;
  termId?: string;        // remote 모드에서 SFTP 연결 ID
  sessionId?: string;     // lazy 연결용 (terminal SSH 와 동일 sessionId 사용 가능)
  label: string;
  basePath: string;
};
type WalkEntry = { relPath: string; isDir: boolean; size: number; mtime: number };
type DiffStatus = 'same' | 'changed' | 'left-only' | 'right-only';
type DiffRow = {
  relPath: string;
  isDir: boolean;
  status: DiffStatus;
  leftSize?: number;
  rightSize?: number;
  changes?: number;     // 변경된 라인 수 (compare:diff-count 결과)
  changesPending?: boolean; // 계산 중
};

type Props = {
  sessions: PanelSession[];
};

const ROW_H = 22;
const LIST_HEADER_H = 26;

function statusColor(s: DiffStatus): string {
  switch (s) {
    case 'changed': return '#d8b556';
    case 'left-only': return '#e36b6b';
    case 'right-only': return '#7fcf6e';
    case 'same': return '#888';
  }
}
function statusBg(s: DiffStatus, selected: boolean): string {
  if (selected) return '#2b4e74';
  switch (s) {
    case 'changed': return 'rgba(216, 181, 86, 0.10)';
    case 'left-only': return 'rgba(227, 107, 107, 0.10)';
    case 'right-only': return 'rgba(127, 207, 110, 0.10)';
    case 'same': return 'transparent';
  }
}
function statusLabel(s: DiffStatus, t: (k: string) => string): string {
  switch (s) {
    case 'changed': return t('changed');
    case 'left-only': return t('sourceOnly');
    case 'right-only': return t('targetOnly');
    case 'same': return t('same');
  }
}
function formatSize(n: number | undefined): string {
  if (n === undefined) return '-';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'K';
  return (n / 1024 / 1024).toFixed(1) + 'M';
}

export const CompareWorkspace: React.FC<Props> = ({ sessions }) => {
  const { t } = useTranslation('compare');

  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState('');
  const [rows, setRows] = useState<DiffRow[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [hideSame, setHideSame] = useState(true);
  const [hideUnpaired, setHideUnpaired] = useState(false); // 한쪽만 있는 항목 숨김
  const [filterText, setFilterText] = useState('');
  const [filterStatus, setFilterStatus] = useState<'' | DiffStatus>('');
  const [sortBy, setSortBy] = useState<'path' | 'status' | 'leftSize' | 'rightSize'>('path');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const [selectedRel, setSelectedRel] = useState<string | null>(null);
  const [leftContent, setLeftContent] = useState<string>('');
  const [rightContent, setRightContent] = useState<string>('');
  const [leftOriginal, setLeftOriginal] = useState<string>(''); // 디스크에서 읽은 원본 (dirty 판단용)
  const [rightOriginal, setRightOriginal] = useState<string>('');
  const [contentErr, setContentErr] = useState<string>('');
  const [contentLoading, setContentLoading] = useState(false);
  const [savingMsg, setSavingMsg] = useState<string>('');
  const [sameNote, setSameNote]   = useState<string>(''); // 크기 달라도 내용 동일 안내
  // All match 모달 — 두 파일이 완전히 일치할 때 띄움. 사용자가 X 닫기 전까지 유지.
  const [allMatchModal, setAllMatchModal] = useState<{ left: string; right: string } | null>(null);
  const [leftEol,  setLeftEol]    = useState('');
  const [rightEol, setRightEol]   = useState('');
  const [leftEnc,  setLeftEnc]    = useState('');
  const [rightEnc, setRightEnc]   = useState('');
  // 선택된 파일의 양쪽 절대경로 (저장용)
  const [leftFilePath, setLeftFilePath] = useState<string>('');
  const [rightFilePath, setRightFilePath] = useState<string>('');
  // 상단 경로 input 의 편집 중 값 — Enter 누르기 전까지는 실제 경로와 분리되어 있음
  const [leftPathDraft, setLeftPathDraft] = useState<string>('');
  const [rightPathDraft, setRightPathDraft] = useState<string>('');
  useEffect(() => { setLeftPathDraft(leftFilePath); }, [leftFilePath]);
  useEffect(() => { setRightPathDraft(rightFilePath); }, [rightFilePath]);

  // 위/아래 영역 비율 — 사용자가 드래그로 조절
  const [topPct, setTopPct] = useState(50);
  // Araxis Merge 스타일 diff 옵션
  type WhitespaceMode = 'significant' | 'ignoreLeading' | 'ignoreTrailing' | 'ignoreConsecutive' | 'ignoreAll';
  const [wsMode, setWsMode] = useState<WhitespaceMode>('significant');
  const [showEol, setShowEol] = useState(false);
  const [collapseUnchanged, setCollapseUnchanged] = useState(true);
  const [wsMenuOpen, setWsMenuOpen] = useState(false);
  // 비교 모드: dir=디렉토리 vs 디렉토리, file=파일 vs 파일
  const [compareMode, setCompareMode] = useState<'dir' | 'file'>('dir');
  // 양쪽 소스 + 경로 — 디렉토리 모드 / 파일 모드 별도 관리
  const [leftDirSrc,   setLeftDirSrc]  = useState<Source>({ mode: 'local', label: t('local'), basePath: '' });
  const [rightDirSrc,  setRightDirSrc] = useState<Source>({ mode: 'local', label: t('local'), basePath: '' });
  const [leftFileSrc,  setLeftFileSrc] = useState<Source>({ mode: 'local', label: t('local'), basePath: '' });
  const [rightFileSrc, setRightFileSrc]= useState<Source>({ mode: 'local', label: t('local'), basePath: '' });
  // 현재 모드에 따른 활성 소스 (읽기 전용 — 쓰기는 updateSrc 사용)
  const leftSrc  = compareMode === 'dir' ? leftDirSrc  : leftFileSrc;
  const rightSrc = compareMode === 'dir' ? rightDirSrc : rightFileSrc;
  // 디렉토리/파일 picker — 어느 쪽 소스의 경로를 선택 중인지
  const [pickerSide, setPickerSide] = useState<Side | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 탭 전환 시 각 모드의 content 상태를 보존하기 위한 스냅샷 ref
  type ModeSnap = {
    selectedRel: string | null;
    leftContent: string; rightContent: string;
    leftOriginal: string; rightOriginal: string;
    leftFilePath: string; rightFilePath: string;
    contentErr: string; savingMsg: string; sameNote: string;
    leftEol: string; rightEol: string; leftEnc: string; rightEnc: string;
    rows: DiffRow[]; truncated: boolean;
  };
  const dirSnapRef  = useRef<ModeSnap | null>(null);
  const fileSnapRef = useRef<ModeSnap | null>(null);

  // 파일 비교용 picker (단일 파일 선택)
  const renderFilePicker = (side: Side, src: Source) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      <span style={{ fontSize: 12, color: '#bbb', width: 42, flexShrink: 0 }}>{side === 'left' ? t('source') : t('target')}</span>
      <select
        value={src.mode === 'remote' ? (src.termId || '') : 'local'}
        onChange={e => {
          const v = e.target.value;
          if (v === 'local') updateSrc(side, { mode: 'local', termId: undefined, sessionId: undefined, label: t('local') });
          else {
            const opt = sourceOptions.find(o => o.termId === v);
            if (opt) updateSrc(side, { mode: 'remote', termId: opt.termId, sessionId: opt.sessionId, label: opt.label });
          }
        }}
        style={{ width: 130, minWidth: 80, flexShrink: 1, fontSize: 12 }}
      >
        <option value="local">{t('local')}</option>
        {sourceOptions.filter(o => o.mode === 'remote').map(o => (
          <option key={o.termId} value={o.termId}>{o.label}</option>
        ))}
      </select>
      <input
        type="text"
        value={src.basePath}
        placeholder={src.mode === 'local' ? t('filePathPlaceholderLocal', '파일 경로...') : t('filePathPlaceholderRemote', '원격 파일 경로...')}
        onChange={e => updateSrc(side, { basePath: e.target.value })}
        onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') startFileCompare(); }}
        style={{ flex: 1, minWidth: 0, fontSize: 12, padding: '3px 6px' }}
      />
      <button
        onClick={async () => {
          if (src.mode === 'local') {
            try {
              const r = await api.pickFiles?.(false);
              if (r?.paths?.[0]) updateSrc(side, { basePath: r.paths[0] });
            } catch {}
          } else {
            if (!src.termId) { setScanError(side === 'left' ? t('sourceNoSession') : t('targetNoSession')); return; }
            setPickerSide(side);
          }
        }}
        title={t('filePicker', '파일 선택')}
        style={{ padding: '3px 8px', fontSize: 12, flexShrink: 0 }}
      >📄</button>
    </div>
  );

  // 가용 소스 목록 (드롭다운) — 연결된 세션(termId 있음) 만 SFTP 비교 가능. lazy 는 일단 제외.
  const sourceOptions = useMemo<Source[]>(() => {
    const opts: Source[] = [{ mode: 'local', label: t('local'), basePath: '' }];
    for (const s of sessions) {
      if (!s.termId) continue;
      opts.push({ mode: 'remote', termId: s.termId, sessionId: s.sessionId, label: `🟢 ${s.sessionName}`, basePath: '' });
    }
    return opts;
  }, [sessions.map(s => s.termId).join(',')]);

  const filteredRows = useMemo(() => {
    const statusOrder: Record<DiffStatus, number> = { changed: 0, 'left-only': 1, 'right-only': 2, same: 3 };
    const arr = rows.filter(r => {
      if (hideSame && r.status === 'same') return false;
      if (hideUnpaired && (r.status === 'left-only' || r.status === 'right-only')) return false;
      if (filterStatus && r.status !== filterStatus) return false;
      if (filterText && !r.relPath.toLowerCase().includes(filterText.toLowerCase())) return false;
      return true;
    });
    arr.sort((a, b) => {
      let cmp = 0;
      if      (sortBy === 'path')      cmp = a.relPath.localeCompare(b.relPath);
      else if (sortBy === 'status')    cmp = (statusOrder[a.status] ?? 0) - (statusOrder[b.status] ?? 0);
      else if (sortBy === 'leftSize')  cmp = (a.leftSize  ?? -1) - (b.leftSize  ?? -1);
      else if (sortBy === 'rightSize') cmp = (a.rightSize ?? -1) - (b.rightSize ?? -1);
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [rows, hideSame, hideUnpaired, filterStatus, filterText, sortBy, sortDir]);

  const toggleSort = useCallback((col: 'path' | 'status' | 'leftSize' | 'rightSize') => {
    setSortBy(prev => {
      if (prev === col) { setSortDir(d => d === 'asc' ? 'desc' : 'asc'); return col; }
      setSortDir('asc'); return col;
    });
  }, []);

  const startCompare = useCallback(async () => {
    setScanError('');
    setRows([]);
    setSelectedRel(null);
    setFilterText('');
    setFilterStatus('');
    setLeftContent(''); setRightContent('');
    if (!leftSrc.basePath || !rightSrc.basePath) { setScanError(t('enterBothPaths')); return; }
    if (leftSrc.mode === 'remote' && !leftSrc.termId) { setScanError(t('sourceNoSession')); return; }
    if (rightSrc.mode === 'remote' && !rightSrc.termId) { setScanError(t('targetNoSession')); return; }
    setScanning(true);
    try {
      const [lRes, rRes] = await Promise.all([
        api.compareWalk?.(leftSrc.mode, leftSrc.basePath, leftSrc.termId),
        api.compareWalk?.(rightSrc.mode, rightSrc.basePath, rightSrc.termId),
      ]);
      if (lRes?.error) throw new Error(t('sourceErrorPrefix', { error: lRes.error }));
      if (rRes?.error) throw new Error(t('targetErrorPrefix', { error: rRes.error }));
      const lEntries: WalkEntry[] = lRes?.entries || [];
      const rEntries: WalkEntry[] = rRes?.entries || [];
      setTruncated(!!(lRes?.truncated || rRes?.truncated));

      const lMap = new Map<string, WalkEntry>();
      for (const e of lEntries) lMap.set(e.relPath, e);
      const rMap = new Map<string, WalkEntry>();
      for (const e of rEntries) rMap.set(e.relPath, e);

      const allKeys = new Set<string>([...lMap.keys(), ...rMap.keys()]);
      const merged: DiffRow[] = [];
      for (const k of allKeys) {
        const l = lMap.get(k);
        const r = rMap.get(k);
        if (l && r) {
          // 둘 다 존재
          if (l.isDir && r.isDir) {
            merged.push({ relPath: k, isDir: true, status: 'same' });
          } else if (l.isDir !== r.isDir) {
            // 한쪽은 폴더, 한쪽은 파일 → changed 로 분류
            merged.push({ relPath: k, isDir: false, status: 'changed', leftSize: l.size, rightSize: r.size });
          } else {
            const same = l.size === r.size; // 1차 휴리스틱
            merged.push({ relPath: k, isDir: false, status: same ? 'same' : 'changed', leftSize: l.size, rightSize: r.size });
          }
        } else if (l) {
          merged.push({ relPath: k, isDir: l.isDir, status: 'left-only', leftSize: l.size });
        } else if (r) {
          merged.push({ relPath: k, isDir: r.isDir, status: 'right-only', rightSize: r.size });
        }
      }
      merged.sort((a, b) => a.relPath.localeCompare(b.relPath));
      setRows(merged);
      // 2차 검증: 크기 차이로 changed 로 분류된 작은 파일들은 EOL/BOM 정규화 해시로 재확인
      // (양쪽 모두 ≤ 256KB 면 hash 비교, 같으면 same 으로 강등)
      const HASH_CAP = 256 * 1024;
      const candidates = merged.filter(r =>
        !r.isDir && r.status === 'changed'
        && (r.leftSize ?? 0) > 0 && (r.rightSize ?? 0) > 0
        && (r.leftSize ?? 0) <= HASH_CAP && (r.rightSize ?? 0) <= HASH_CAP
      );
      if (candidates.length > 0) {
        const sep = (m: SourceMode) => m === 'local' && navigator.platform.startsWith('Win') ? '\\' : '/';
        const join = (base: string, mode: SourceMode, rel: string) => base.endsWith(sep(mode)) ? base + rel.replace(/\//g, sep(mode)) : base + sep(mode) + rel.replace(/\//g, sep(mode));
        const CONCURRENCY = 6;
        let cursor = 0;
        const sameSet = new Set<string>();
        const runOne = async () => {
          while (cursor < candidates.length) {
            const i = cursor++;
            const row = candidates[i];
            try {
              const [lh, rh] = await Promise.all([
                (window as any).api?.compareHash?.(leftSrc.mode, join(leftSrc.basePath, leftSrc.mode, row.relPath), leftSrc.termId, HASH_CAP, wsMode),
                (window as any).api?.compareHash?.(rightSrc.mode, join(rightSrc.basePath, rightSrc.mode, row.relPath), rightSrc.termId, HASH_CAP, wsMode),
              ]);
              if (lh?.hash && rh?.hash && lh.hash === rh.hash) sameSet.add(row.relPath);
            } catch {}
          }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, runOne));
        if (sameSet.size > 0) {
          setRows(prev => prev.map(r => sameSet.has(r.relPath) && r.status === 'changed' ? { ...r, status: 'same' as DiffStatus } : r));
        }
        // 남은 진짜 'changed' 행에 대해 diff line count 계산 (양쪽 ≤ HASH_CAP)
        const stillChanged = candidates.filter(r => !sameSet.has(r.relPath));
        if (stillChanged.length > 0) {
          setRows(prev => prev.map(r => stillChanged.find(s => s.relPath === r.relPath) ? { ...r, changesPending: true } : r));
          let cursor2 = 0;
          const runCount = async () => {
            while (cursor2 < stillChanged.length) {
              const i = cursor2++;
              const row = stillChanged[i];
              try {
                const r: any = await (window as any).api?.compareDiffCount?.(
                  leftSrc.mode, join(leftSrc.basePath, leftSrc.mode, row.relPath), leftSrc.termId,
                  rightSrc.mode, join(rightSrc.basePath, rightSrc.mode, row.relPath), rightSrc.termId,
                  HASH_CAP, wsMode,
                );
                if (typeof r?.changes === 'number') {
                  setRows(prev => prev.map(rr => rr.relPath === row.relPath ? { ...rr, changes: r.changes, changesPending: false } : rr));
                } else {
                  setRows(prev => prev.map(rr => rr.relPath === row.relPath ? { ...rr, changesPending: false } : rr));
                }
              } catch {
                setRows(prev => prev.map(rr => rr.relPath === row.relPath ? { ...rr, changesPending: false } : rr));
              }
            }
          };
          await Promise.all(Array.from({ length: Math.min(CONCURRENCY, stillChanged.length) }, runCount));
        }
      }
    } catch (err: any) {
      setScanError(String(err?.message || err));
    } finally {
      setScanning(false);
    }
  }, [leftSrc, rightSrc]);

  const detectEol = (raw: string): string => {
    if (!raw) return '';
    const hasCRLF = raw.includes('\r\n');
    const hasCR   = /\r(?!\n)/.test(raw);
    const hasLF   = /(?<!\r)\n/.test(raw);
    const kinds   = [hasCRLF, hasCR, hasLF].filter(Boolean).length;
    if (kinds > 1) return 'Mixed';
    if (hasCRLF) return 'Windows (CRLF)';
    if (hasCR)   return 'Classic Mac (CR)';
    return 'Unix (LF)';
  };

  const loadDiff = useCallback(async (row: DiffRow) => {
    setContentErr('');
    setSavingMsg('');
    setSameNote('');
    setLeftEol(''); setRightEol('');
    setLeftEnc(''); setRightEnc('');
    setLeftContent('');
    setRightContent('');
    setLeftOriginal('');
    setRightOriginal('');
    setLeftFilePath('');
    setRightFilePath('');
    if (row.isDir) return; // 폴더는 diff 의미 없음
    setContentLoading(true);
    try {
      const sep = (m: SourceMode) => m === 'local' && navigator.platform.startsWith('Win') ? '\\' : '/';
      const joinL = leftSrc.basePath.endsWith(sep(leftSrc.mode)) ? leftSrc.basePath + row.relPath.replace(/\//g, sep(leftSrc.mode)) : leftSrc.basePath + sep(leftSrc.mode) + row.relPath.replace(/\//g, sep(leftSrc.mode));
      const joinR = rightSrc.basePath.endsWith(sep(rightSrc.mode)) ? rightSrc.basePath + row.relPath.replace(/\//g, sep(rightSrc.mode)) : rightSrc.basePath + sep(rightSrc.mode) + row.relPath.replace(/\//g, sep(rightSrc.mode));
      setLeftFilePath(joinL);
      setRightFilePath(joinR);
      const tasks: Promise<any>[] = [];
      if (row.status !== 'right-only') tasks.push(api.compareRead?.(leftSrc.mode, joinL, leftSrc.termId)); else tasks.push(Promise.resolve({ content: '' }));
      if (row.status !== 'left-only') tasks.push(api.compareRead?.(rightSrc.mode, joinR, rightSrc.termId)); else tasks.push(Promise.resolve({ content: '' }));
      const [l, r] = await Promise.all(tasks);
      // EOL 정규화 — 플랫폼 무관하게 CRLF/CR → LF 통일
      // (크기 기반 휴리스틱에서 개행 차이로 오탐하는 경우 방지)
      const normEol = (s: string) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      let leftC = '', rightC = '', leftErr = false, rightErr = false;
      if (l?.error) { setContentErr(t('sourceReadFail', { error: l.error })); leftErr = true; }
      else {
        setLeftEol(detectEol(l.content ?? '')); setLeftEnc(l.encoding || 'UTF-8');
        leftC = normEol(l.content ?? ''); setLeftContent(leftC); setLeftOriginal(leftC);
      }
      if (r?.error) { setContentErr((prev) => prev ? prev + ' / ' + t('targetReadFail', { error: r.error }) : t('targetReadFail', { error: r.error })); rightErr = true; }
      else {
        setRightEol(detectEol(r.content ?? '')); setRightEnc(r.encoding || 'UTF-8');
        rightC = normEol(r.content ?? ''); setRightContent(rightC); setRightOriginal(rightC);
      }
      // 내용 동일 안내 — 크기 휴리스틱 오탐(EOL 차이) 케이스 + 진짜 동일 케이스 모두
      if (!leftErr && !rightErr && leftC === rightC) {
        if (row.status === 'changed') {
          setSameNote('내용이 동일합니다 (개행 방식만 다름)');
        } else {
          setSameNote('두 파일이 완전히 일치합니다 (All match)');
          setAllMatchModal({ left: row.relPath || '', right: row.relPath || '' });
        }
      }
    } catch (err: any) {
      setContentErr(String(err?.message || err));
    } finally {
      setContentLoading(false);
    }
  }, [leftSrc, rightSrc]);

  // 상단 경로 input 에서 Enter — 해당 쪽 파일만 새 경로로 다시 로드 (비교 즉시 갱신)
  const reloadFileByPath = useCallback(async (side: Side, newPath: string) => {
    if (!newPath || !newPath.trim()) return;
    setContentErr('');
    setSavingMsg('');
    setSameNote('');
    setContentLoading(true);
    try {
      const src = side === 'left' ? leftSrc : rightSrc;
      const r = await api.compareRead?.(src.mode, newPath.trim(), src.termId);
      const normEol = (s: string) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      if (r?.error) {
        setContentErr(side === 'left' ? t('sourceReadFail', { error: r.error }) : t('targetReadFail', { error: r.error }));
      } else {
        const c = normEol(r.content ?? '');
        if (side === 'left') {
          setLeftEol(detectEol(r.content ?? '')); setLeftEnc(r.encoding || 'UTF-8');
          setLeftContent(c); setLeftOriginal(c); setLeftFilePath(newPath.trim());
        } else {
          setRightEol(detectEol(r.content ?? '')); setRightEnc(r.encoding || 'UTF-8');
          setRightContent(c); setRightOriginal(c); setRightFilePath(newPath.trim());
        }
        // 파일 비교 모드라면 source 의 basePath 도 동기화 → 이후 다시 비교 시작 시 일관
        if (compareMode === 'file') {
          updateSrc(side, { basePath: newPath.trim() });
        }
        if (!selectedRel) setSelectedRel('__file__');
        // 양쪽 내용 비교 — 동일하면 안내
        const otherC = side === 'left' ? rightContent : leftContent;
        if (c === otherC) {
          setSameNote('두 파일이 완전히 일치합니다 (All match)');
          const lp = side === 'left' ? newPath.trim() : leftFilePath;
          const rp = side === 'right' ? newPath.trim() : rightFilePath;
          setAllMatchModal({ left: lp, right: rp });
        }
      }
    } catch (err: any) {
      setContentErr(String(err?.message || err));
    } finally {
      setContentLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leftSrc, rightSrc, compareMode, selectedRel, t]);

  // 파일 vs 파일 직접 비교 — walk 없이 양쪽 파일 내용 로드
  const startFileCompare = useCallback(async () => {
    setScanError('');
    setContentErr('');
    setSameNote('');
    setLeftEol(''); setRightEol('');
    setLeftEnc(''); setRightEnc('');
    setLeftContent(''); setRightContent('');
    setLeftOriginal(''); setRightOriginal('');
    if (!leftSrc.basePath || !rightSrc.basePath) { setScanError(t('enterBothPaths')); return; }
    if (leftSrc.mode === 'remote' && !leftSrc.termId) { setScanError(t('sourceNoSession')); return; }
    if (rightSrc.mode === 'remote' && !rightSrc.termId) { setScanError(t('targetNoSession')); return; }
    setContentLoading(true);
    setLeftFilePath(leftSrc.basePath);
    setRightFilePath(rightSrc.basePath);
    setSelectedRel('__file__');
    try {
      const [l, r] = await Promise.all([
        api.compareRead?.(leftSrc.mode, leftSrc.basePath, leftSrc.termId),
        api.compareRead?.(rightSrc.mode, rightSrc.basePath, rightSrc.termId),
      ]);
      const normEol = (s: string) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      let lC = '', rC = '', lOK = false, rOK = false;
      if (l?.error) setContentErr(t('sourceReadFail', { error: l.error }));
      else {
        setLeftEol(detectEol(l.content ?? '')); setLeftEnc(l.encoding || 'UTF-8');
        lC = normEol(l.content ?? ''); setLeftContent(lC); setLeftOriginal(lC); lOK = true;
      }
      if (r?.error) setContentErr(p => p ? p + ' / ' + t('targetReadFail', { error: r.error }) : t('targetReadFail', { error: r.error }));
      else {
        setRightEol(detectEol(r.content ?? '')); setRightEnc(r.encoding || 'UTF-8');
        rC = normEol(r.content ?? ''); setRightContent(rC); setRightOriginal(rC); rOK = true;
      }
      // 양쪽 모두 성공 + 내용 동일 → 안내 + 모달
      if (lOK && rOK && lC === rC) {
        setSameNote('두 파일이 완전히 일치합니다 (All match)');
        setAllMatchModal({ left: leftSrc.basePath, right: rightSrc.basePath });
      }
    } catch (err: any) {
      setContentErr(String(err?.message || err));
    } finally {
      setContentLoading(false);
    }
  }, [leftSrc, rightSrc]);

  const leftDirty = leftContent !== leftOriginal;
  const rightDirty = rightContent !== rightOriginal;

  const saveSide = useCallback(async (side: Side) => {
    if (side === 'left') {
      if (!leftFilePath || !leftDirty) return;
      setSavingMsg(t('saving', { side: t('source') }));
      const r = await api.compareWrite?.(leftSrc.mode, leftFilePath, leftContent, leftSrc.termId);
      if (r?.ok) {
        setLeftOriginal(leftContent);
        setSavingMsg(t('saveSuccess', { side: t('source'), path: leftFilePath }));
        setTimeout(() => setSavingMsg(''), 2500);
      } else {
        setSavingMsg(t('saveFailed', { side: t('source'), reason: r?.error || 'unknown' }));
      }
    } else {
      if (!rightFilePath || !rightDirty) return;
      setSavingMsg(t('saving', { side: t('target') }));
      const r = await api.compareWrite?.(rightSrc.mode, rightFilePath, rightContent, rightSrc.termId);
      if (r?.ok) {
        setRightOriginal(rightContent);
        setSavingMsg(t('saveSuccess', { side: t('target'), path: rightFilePath }));
        setTimeout(() => setSavingMsg(''), 2500);
      } else {
        setSavingMsg(t('saveFailed', { side: t('target'), reason: r?.error || 'unknown' }));
      }
    }
  }, [leftFilePath, leftContent, leftOriginal, leftSrc, rightFilePath, rightContent, rightOriginal, rightSrc, leftDirty, rightDirty]);

  // 전체 적용 — 한 쪽 내용을 다른 쪽 에디터에 통째 복사 (메모리만 변경, 저장은 별도 버튼)
  const applyAll = useCallback((direction: 'left-to-right' | 'right-to-left') => {
    if (direction === 'left-to-right') setRightContent(leftContent);
    else setLeftContent(rightContent);
  }, [leftContent, rightContent]);

  // DiffEditor 인스턴스 보관 — hunk 단위 양방향 적용에 사용
  const diffEditorRef = useRef<any>(null);

  // 커서 위치의 hunk 를 찾아서 한 방향으로 적용
  const applyCurrentHunk = useCallback((direction: 'left-to-right' | 'right-to-left') => {
    const ed = diffEditorRef.current;
    if (!ed) return;
    const changes = ed.getLineChanges?.() as any[] | null;
    if (!changes || changes.length === 0) {
      setSavingMsg(t('noChangesToApply'));
      setTimeout(() => setSavingMsg(''), 1500);
      return;
    }
    const origEditor = ed.getOriginalEditor();
    const modEditor = ed.getModifiedEditor();
    const origModel = origEditor.getModel();
    const modModel = modEditor.getModel();
    if (!origModel || !modModel) return;

    // 활성 에디터의 커서 라인 기준으로 가장 가까운 hunk 선택
    const isModFocused = modEditor.hasTextFocus?.() || direction === 'left-to-right';
    const cursorLine = isModFocused
      ? (modEditor.getPosition()?.lineNumber ?? 1)
      : (origEditor.getPosition()?.lineNumber ?? 1);

    let target: any = null;
    let bestDist = Infinity;
    for (const c of changes) {
      const refStart = isModFocused ? c.modifiedStartLineNumber : c.originalStartLineNumber;
      const refEnd = isModFocused ? (c.modifiedEndLineNumber || c.modifiedStartLineNumber) : (c.originalEndLineNumber || c.originalStartLineNumber);
      // hunk 내부면 거리 0, 외부면 최단 거리
      let dist: number;
      if (cursorLine >= refStart && cursorLine <= refEnd) dist = 0;
      else if (cursorLine < refStart) dist = refStart - cursorLine;
      else dist = cursorLine - refEnd;
      if (dist < bestDist) { bestDist = dist; target = c; }
    }
    if (!target) return;

    // hunk 의 원본 / 수정본 텍스트 추출
    const getRangeText = (model: any, startLn: number, endLn: number) => {
      if (endLn === 0) return ''; // 순수 삽입 — 해당 쪽엔 라인 없음
      const lastCol = model.getLineMaxColumn(endLn);
      return model.getValueInRange({ startLineNumber: startLn, startColumn: 1, endLineNumber: endLn, endColumn: lastCol });
    };
    const origText = getRangeText(origModel, target.originalStartLineNumber, target.originalEndLineNumber);
    const modText = getRangeText(modModel, target.modifiedStartLineNumber, target.modifiedEndLineNumber);

    if (direction === 'left-to-right') {
      // 왼쪽(orig) 내용을 오른쪽(mod) hunk 범위에 적용
      if (target.modifiedEndLineNumber === 0) {
        // 오른쪽엔 라인 없음 (왼쪽에서 추가됨) → modifiedStartLineNumber 위치에 라인 삽입
        const insertLine = target.modifiedStartLineNumber;
        const eol = modModel.getEOL();
        modModel.applyEdits([{
          range: { startLineNumber: insertLine + 1, startColumn: 1, endLineNumber: insertLine + 1, endColumn: 1 },
          text: origText + eol,
        }]);
      } else {
        const endCol = modModel.getLineMaxColumn(target.modifiedEndLineNumber);
        modModel.applyEdits([{
          range: { startLineNumber: target.modifiedStartLineNumber, startColumn: 1, endLineNumber: target.modifiedEndLineNumber, endColumn: endCol },
          text: origText,
        }]);
      }
    } else {
      // 오른쪽(mod) 내용을 왼쪽(orig) hunk 범위에 적용
      if (target.originalEndLineNumber === 0) {
        const insertLine = target.originalStartLineNumber;
        const eol = origModel.getEOL();
        origModel.applyEdits([{
          range: { startLineNumber: insertLine + 1, startColumn: 1, endLineNumber: insertLine + 1, endColumn: 1 },
          text: modText + eol,
        }]);
      } else {
        const endCol = origModel.getLineMaxColumn(target.originalEndLineNumber);
        origModel.applyEdits([{
          range: { startLineNumber: target.originalStartLineNumber, startColumn: 1, endLineNumber: target.originalEndLineNumber, endColumn: endCol },
          text: modText,
        }]);
      }
    }
  }, []);

  // hunk 간 이동
  const navigateHunk = useCallback((dir: 'next' | 'prev') => {
    const ed = diffEditorRef.current;
    if (!ed) return;
    const changes = ed.getLineChanges?.() as any[] | null;
    if (!changes || changes.length === 0) return;
    const modEditor = ed.getModifiedEditor();
    const cursorLine = modEditor.getPosition()?.lineNumber ?? 1;
    let target: any = null;
    if (dir === 'next') target = changes.find((c: any) => c.modifiedStartLineNumber > cursorLine) || changes[0];
    else { const prev = [...changes].reverse().find((c: any) => c.modifiedStartLineNumber < cursorLine); target = prev || changes[changes.length - 1]; }
    if (target) {
      modEditor.revealLineInCenter(target.modifiedStartLineNumber);
      modEditor.setPosition({ lineNumber: target.modifiedStartLineNumber, column: 1 });
      modEditor.focus();
    }
  }, []);

  // 포커스된 에디터 (origin/modified) 반환 헬퍼 — 없으면 modified 기본
  const getFocusedSubEditor = useCallback(() => {
    const ed = diffEditorRef.current;
    if (!ed) return null;
    if (ed.getOriginalEditor()?.hasTextFocus?.()) return ed.getOriginalEditor();
    return ed.getModifiedEditor();
  }, []);

  // 사용자 정의 단축키 — 윈도우 레벨 keydown. DiffEditor 가 마운트되어 있을 때만 동작.
  useEffect(() => {
    if (!selectedRel) return;
    const handler = (e: KeyboardEvent) => {
      if (!diffEditorRef.current) return;
      const tgt = e.target as HTMLElement;
      const inMonaco = tgt && tgt.closest && tgt.closest('.monaco-editor');
      // Monaco 외부의 일반 input/textarea 에선 단축키 무시 — typing 우선
      const isOtherInput = tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA') && !inMonaco;

      // 되돌리기/다시 실행 — Monaco 의 트리거를 명시적으로 호출 (글로벌 핸들러 / 포커스 이슈로 안 먹히는 케이스 대비)
      // Monaco 외부 input 에서는 브라우저 기본 undo 사용
      if (!isOtherInput && inMonaco) {
        const ctrl = e.ctrlKey || e.metaKey;
        if (ctrl && !e.altKey && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
          e.preventDefault();
          getFocusedSubEditor()?.trigger('keyboard', 'undo', null);
          return;
        }
        if (ctrl && ((e.shiftKey && (e.key === 'z' || e.key === 'Z')) || (!e.shiftKey && (e.key === 'y' || e.key === 'Y')))) {
          e.preventDefault();
          getFocusedSubEditor()?.trigger('keyboard', 'redo', null);
          return;
        }
      }

      if (isOtherInput) return;
      if (matchKeybinding(e, 'diffPrevHunk')) { e.preventDefault(); navigateHunk('prev'); }
      else if (matchKeybinding(e, 'diffNextHunk')) { e.preventDefault(); navigateHunk('next'); }
      else if (matchKeybinding(e, 'diffApplyLeft')) { e.preventDefault(); applyCurrentHunk('right-to-left'); }
      else if (matchKeybinding(e, 'diffApplyRight')) { e.preventDefault(); applyCurrentHunk('left-to-right'); }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [selectedRel, navigateHunk, applyCurrentHunk, getFocusedSubEditor]);

  // top/bottom resize drag
  const onResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    // split 컨테이너 높이 기준으로 dPct 계산 → 마우스 이동과 1:1
    const baseH = (splitWrapRef.current?.clientHeight || splitH) - RESIZER_H;
    const startPct = topPct;
    const prevSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'row-resize';
    const onMove = (ev: MouseEvent) => {
      if (baseH <= 0) return;
      const dy = ev.clientY - startY; // 아래로 끌면 + (리스트 커짐)
      const dPct = (dy / baseH) * 100;
      setTopPct(Math.max(8, Math.min(92, startPct + dPct)));
    };
    const onUp = () => {
      document.body.style.userSelect = prevSelect;
      document.body.style.cursor = prevCursor;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // 소스 변경 시 basePath 보존
  const updateSrc = (side: Side, patch: Partial<Source>) => {
    if (compareMode === 'dir') {
      if (side === 'left') setLeftDirSrc(s => ({ ...s, ...patch }));
      else                 setRightDirSrc(s => ({ ...s, ...patch }));
    } else {
      if (side === 'left') setLeftFileSrc(s => ({ ...s, ...patch }));
      else                 setRightFileSrc(s => ({ ...s, ...patch }));
    }
  };

  const renderSourcePicker = (side: Side, src: Source) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      <span style={{ fontSize: 12, color: '#bbb', width: 42, flexShrink: 0 }}>{side === 'left' ? t('source') : t('target')}</span>
      <select
        value={src.mode === 'remote' ? (src.termId || '') : 'local'}
        onChange={e => {
          const v = e.target.value;
          if (v === 'local') updateSrc(side, { mode: 'local', termId: undefined, sessionId: undefined, label: t('local') });
          else {
            const opt = sourceOptions.find(o => o.termId === v);
            if (opt) updateSrc(side, { mode: 'remote', termId: opt.termId, sessionId: opt.sessionId, label: opt.label });
          }
        }}
        style={{ width: 130, minWidth: 80, flexShrink: 1, fontSize: 12 }}
      >
        <option value="local">{t('local')}</option>
        {sourceOptions.filter(o => o.mode === 'remote').map(o => (
          <option key={o.termId} value={o.termId}>{o.label}</option>
        ))}
      </select>
      <input
        type="text"
        value={src.basePath}
        placeholder={src.mode === 'local' ? t('pathPlaceholderLocal') : t('pathPlaceholderRemote')}
        onChange={e => updateSrc(side, { basePath: e.target.value })}
        onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') startCompare(); }}
        style={{ flex: 1, minWidth: 0, fontSize: 12, padding: '3px 6px' }}
      />
      <button
        onClick={async () => {
          if (src.mode === 'local') {
            try {
              const r = await api.pickFolder?.();
              if (r?.path) updateSrc(side, { basePath: r.path });
            } catch {}
          } else {
            if (!src.termId) { setScanError(side === 'left' ? t('sourceNoSession') : t('targetNoSession')); return; }
            setPickerSide(side);
          }
        }}
        title={t('directoryPicker')}
        style={{ padding: '3px 8px', fontSize: 12, flexShrink: 0 }}
      >📁</button>
    </div>
  );

  const [diffExpanded, setDiffExpanded] = useState(false);
  // list+resizer+diff 를 담는 split 컨테이너 높이 측정 → 픽셀 단위로 명확히 분할 (LogAnalyzer 와 동일 방식)
  const splitWrapRef = useRef<HTMLDivElement | null>(null);
  const [splitH, setSplitH] = useState(500);
  const splitRoRef = useRef<ResizeObserver | null>(null);
  const setSplitWrapRef = useCallback((el: HTMLDivElement | null) => {
    splitWrapRef.current = el;
    if (splitRoRef.current) { splitRoRef.current.disconnect(); splitRoRef.current = null; }
    if (!el) return;
    const update = () => setSplitH(el.clientHeight || 500);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    splitRoRef.current = ro;
    update();
  }, []);
  useEffect(() => () => { splitRoRef.current?.disconnect(); }, []);
  const RESIZER_H = 4;
  // 디렉토리 모드: 리스트 높이 = (split - 리사이저) * topPct/100, diff 최소 80 보장하도록 cap.
  // file 모드 / diffExpanded 면 리스트 0, diff 전체.
  const showList = !diffExpanded && compareMode === 'dir';
  const splitAvail = Math.max(0, splitH - (showList ? RESIZER_H : 0));
  const listHeight = showList
    ? Math.min(Math.max(60, splitAvail - 80), Math.max(60, Math.round(splitAvail * topPct / 100)))
    : 0;
  const diffH = showList ? Math.max(80, splitAvail - listHeight) : splitH;
  // 리스트 VList 하단 앵커 — 맨 밑 상태면 리스트 높이 변경 시에도 맨 밑 유지
  const listVlistRef = useRef<any>(null);
  const listAtBottomRef = useRef(false);
  useEffect(() => {
    if (!listVlistRef.current || filteredRows.length === 0) return;
    try {
      const selIdx = selectedRel ? filteredRows.findIndex(r => r.relPath === selectedRel) : -1;
      if (selIdx >= 0) {
        listVlistRef.current.scrollToItem(selIdx, 'smart');
      } else if (listAtBottomRef.current) {
        listVlistRef.current.scrollToItem(filteredRows.length - 1, 'end');
      }
    } catch {}
  }, [listHeight]); // eslint-disable-line react-hooks/exhaustive-deps
  // diff 영역 높이 변경 시 Monaco DiffEditor 강제 relayout (automaticLayout 보강)
  useEffect(() => {
    const ed = diffEditorRef.current;
    if (!ed) return;
    [0, 60, 180].forEach(ms => setTimeout(() => { try { ed.layout(); } catch {} }, ms));
  }, [diffH]); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = useMemo(() => {
    let c = 0, l = 0, r = 0, s = 0;
    for (const x of rows) {
      if (x.status === 'changed') c++;
      else if (x.status === 'left-only') l++;
      else if (x.status === 'right-only') r++;
      else s++;
    }
    return { c, l, r, s };
  }, [rows]);

  return (
    <div ref={rootRef} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0, overflow: 'hidden', background: '#1a1a1a' }}>
      {/* 헤더: 양쪽 소스 + 비교 버튼 */}
      <div style={{ padding: '8px 10px', background: '#222', borderBottom: '1px solid #333', display: diffExpanded ? 'none' : 'flex', flexDirection: 'column', gap: 6, minWidth: 0, overflow: 'hidden' }}>
        {/* 모드 탭 */}
        <div style={{ display: 'flex', gap: 0, alignSelf: 'flex-start' }}>
          {(['dir', 'file'] as const).map((m, i) => (
            <button key={m} onClick={() => {
              if (compareMode === m) return;
              // 현재 모드 상태 스냅샷 저장
              const snap: ModeSnap = {
                selectedRel, leftContent, rightContent, leftOriginal, rightOriginal,
                leftFilePath, rightFilePath, contentErr, savingMsg, sameNote,
                leftEol, rightEol, leftEnc, rightEnc, rows, truncated,
              };
              if (compareMode === 'dir') dirSnapRef.current = snap;
              else fileSnapRef.current = snap;
              // 새 모드 상태 복원 (없으면 초기화)
              const restore = m === 'dir' ? dirSnapRef.current : fileSnapRef.current;
              setCompareMode(m);
              setScanError('');
              if (restore) {
                setSelectedRel(restore.selectedRel);
                setLeftContent(restore.leftContent);   setRightContent(restore.rightContent);
                setLeftOriginal(restore.leftOriginal); setRightOriginal(restore.rightOriginal);
                setLeftFilePath(restore.leftFilePath); setRightFilePath(restore.rightFilePath);
                setContentErr(restore.contentErr);     setSavingMsg(restore.savingMsg);  setSameNote(restore.sameNote);
                setLeftEol(restore.leftEol);           setRightEol(restore.rightEol);
                setLeftEnc(restore.leftEnc);           setRightEnc(restore.rightEnc);
                setRows(restore.rows);                 setTruncated(restore.truncated);
              } else {
                setSelectedRel(null);
                setLeftContent(''); setRightContent('');
                setLeftOriginal(''); setRightOriginal('');
                setLeftFilePath(''); setRightFilePath('');
                setContentErr(''); setSavingMsg(''); setSameNote('');
                setLeftEol(''); setRightEol('');
                setLeftEnc(''); setRightEnc('');
                setRows([]); setTruncated(false);
              }
            }} style={{
              padding: '3px 12px', fontSize: 12, cursor: 'pointer',
              borderRadius: i === 0 ? '4px 0 0 4px' : '0 4px 4px 0',
              background: compareMode === m ? '#4a7a9b' : '#2a2a2a',
              color: compareMode === m ? '#fff' : '#888',
              border: '1px solid #444', borderLeft: i === 0 ? undefined : 'none',
            }}>
              {m === 'dir' ? `📁 ${t('dirMode', '디렉토리')}` : `📄 ${t('fileMode', '파일')}`}
            </button>
          ))}
        </div>
        {compareMode === 'dir' ? (
          <>
            {renderSourcePicker('left', leftSrc)}
            {renderSourcePicker('right', rightSrc)}
          </>
        ) : (
          <>
            {renderFilePicker('left', leftSrc)}
            {renderFilePicker('right', rightSrc)}
          </>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
          {compareMode === 'dir' ? (
            <>
              <button className="primary" onClick={startCompare} disabled={scanning} style={{ padding: '4px 14px' }}>
                {scanning ? t('comparing') : t('compare')}
              </button>
              <button onClick={() => {
                setLeftDirSrc(rightDirSrc); setRightDirSrc(leftDirSrc);
                setRows([]); setSelectedRel(null);
              }} title={t('switchTitle')} style={{ padding: '4px 10px' }}>{t('switch')}</button>
              <label style={{ fontSize: 12, color: '#bbb', display: 'flex', alignItems: 'center', gap: 4 }}>
                <input type="checkbox" checked={hideSame} onChange={e => setHideSame(e.target.checked)} />
                {t('hideSame')}
              </label>
              {/* 비교 옵션 — Araxis Merge 스타일 */}
              <div style={{ position: 'relative' }}>
                <button
                  onClick={() => setWsMenuOpen(v => !v)}
                  title="비교 옵션 (Whitespace / Line endings / Collapse)"
                  style={{ padding: '4px 10px', fontSize: 12, background: wsMode !== 'significant' || showEol || !collapseUnchanged ? '#2b4e74' : undefined }}
                >⚙ 옵션</button>
                {wsMenuOpen && (
                  <div
                    onMouseLeave={() => setWsMenuOpen(false)}
                    style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 100, background: '#222', border: '1px solid #444', borderRadius: 4, padding: 8, minWidth: 260, fontSize: 12, color: '#ccc', boxShadow: '0 4px 12px rgba(0,0,0,0.5)' }}
                  >
                    <div style={{ fontSize: 11, color: '#888', marginBottom: 4, textTransform: 'uppercase' }}>Whitespace</div>
                    {([
                      ['significant', 'All significant'],
                      ['ignoreLeading', 'Ignore leading'],
                      ['ignoreTrailing', 'Ignore trailing'],
                      ['ignoreConsecutive', 'Ignore consecutive'],
                      ['ignoreAll', 'Ignore all'],
                    ] as [WhitespaceMode, string][]).map(([k, label]) => (
                      <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 4px', cursor: 'pointer', borderRadius: 3, background: wsMode === k ? '#2b4e74' : undefined }}>
                        <input type="radio" name="ws" checked={wsMode === k} onChange={() => setWsMode(k)} />
                        {label}
                      </label>
                    ))}
                    <div style={{ height: 1, background: '#333', margin: '6px 0' }} />
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 4px', cursor: 'pointer' }}>
                      <input type="checkbox" checked={showEol} onChange={e => setShowEol(e.target.checked)} />
                      Show line endings
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 4px', cursor: 'pointer' }}>
                      <input type="checkbox" checked={collapseUnchanged} onChange={e => setCollapseUnchanged(e.target.checked)} />
                      Collapse unchanged regions
                    </label>
                  </div>
                )}
              </div>
              <label style={{ fontSize: 12, color: '#bbb', display: 'flex', alignItems: 'center', gap: 4 }} title={t('hideUnpairedTitle')}>
                <input type="checkbox" checked={hideUnpaired} onChange={e => setHideUnpaired(e.target.checked)} />
                {t('hideUnpaired')}
              </label>
            </>
          ) : (
            <>
              <button className="primary" onClick={startFileCompare} disabled={contentLoading} style={{ padding: '4px 14px' }}>
                {contentLoading ? t('loading') : t('compare')}
              </button>
              <button onClick={() => {
                setLeftFileSrc(rightFileSrc); setRightFileSrc(leftFileSrc);
                setSelectedRel(null); setLeftContent(''); setRightContent('');
              }} title={t('switchTitle')} style={{ padding: '4px 10px' }}>{t('switch')}</button>
            </>
          )}
          {rows.length > 0 && (
            <span style={{ fontSize: 11, color: '#888' }}>
              {t('countChanged')} <span style={{ color: statusColor('changed') }}>{counts.c}</span> ·
              {t('countSourceOnly')} <span style={{ color: statusColor('left-only') }}>{counts.l}</span> ·
              {t('countTargetOnly')} <span style={{ color: statusColor('right-only') }}>{counts.r}</span> ·
              {t('countSame')} <span style={{ color: statusColor('same') }}>{counts.s}</span>
              {truncated && <span style={{ color: '#d8b556', marginLeft: 8 }}>{t('resultTruncated')}</span>}
            </span>
          )}
          {scanError && <span style={{ color: '#e36b6b', fontSize: 12 }}>{scanError}</span>}
        </div>
      </div>

      {/* 상단: 비교 결과 트리 (가상화) — 디렉토리 모드만 표시 */}
      {!diffExpanded && compareMode === 'file' && <div style={{ height: 4, background: '#333', flexShrink: 0 }} />}
      {/* list+resizer+diff 를 함께 담는 split 컨테이너 — 남은 공간 전체 차지, 내부를 픽셀로 분할 */}
      <div ref={setSplitWrapRef} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{
        // 디렉토리 모드: 픽셀 높이 (split * topPct/100). file 모드/diffExpanded 면 0.
        height:    showList ? listHeight : 0,
        minHeight: 0,
        flexShrink: 0,
        overflow: 'hidden', background: '#161616', position: 'relative',
      }}>
        {rows.length === 0 ? (
          <div style={{ color: '#666', fontSize: 12, padding: 16, textAlign: 'center' }}>
            {t('enterBothHint')}
          </div>
        ) : (
          <>
          {/* 목록 헤더 — 정렬 + 필터 */}
          <div style={{
            display: 'flex', alignItems: 'center', height: LIST_HEADER_H,
            padding: '0 10px', background: '#1c1c1c', borderBottom: '1px solid #2d2d2d',
            fontSize: 11, color: '#888', flexShrink: 0, userSelect: 'none', boxSizing: 'border-box',
          }}>
            <span style={{ width: 70, display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
              <span
                onClick={() => toggleSort('status')}
                style={{ cursor: 'pointer', opacity: sortBy === 'status' ? 1 : 0.4 }}
                title="상태로 정렬"
              >{sortBy === 'status' ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}</span>
              <select
                value={filterStatus}
                onChange={e => setFilterStatus(e.target.value as '' | DiffStatus)}
                style={{
                  flex: 1, minWidth: 0, fontSize: 10, padding: '1px 2px',
                  background: filterStatus ? '#2a1e1e' : '#252525',
                  border: `1px solid ${filterStatus ? '#7a3a3a' : '#333'}`,
                  borderRadius: 3,
                  color: filterStatus ? statusColor(filterStatus) : '#888',
                  outline: 'none', cursor: 'pointer',
                }}
              >
                <option value="">상태</option>
                <option value="changed">변경됨</option>
                <option value="left-only">소스만</option>
                <option value="right-only">타겟만</option>
                <option value="same">동일</option>
              </select>
            </span>
            {/* 좌측: Source 폴더 */}
            <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
              <span
                onClick={() => toggleSort('path')}
                style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0 }}
                title="경로로 정렬"
              >
                Source
                <span style={{ opacity: sortBy === 'path' ? 1 : 0.3 }}>{sortBy === 'path' ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}</span>
              </span>
              <input
                type="text"
                value={filterText}
                onChange={e => setFilterText(e.target.value)}
                onKeyDown={e => e.stopPropagation()}
                placeholder="필터..."
                style={{
                  flex: 1, minWidth: 0, fontSize: 11, padding: '1px 5px',
                  background: filterText ? '#1e2a1e' : '#252525',
                  border: `1px solid ${filterText ? '#3a5a3a' : '#333'}`,
                  borderRadius: 3, color: '#ccc', outline: 'none',
                }}
              />
              {filterText && (
                <button onClick={() => setFilterText('')} style={{ padding: '0 4px', fontSize: 11, background: 'transparent', border: 'none', color: '#888', cursor: 'pointer', flexShrink: 0 }}>✕</button>
              )}
            </span>
            {/* 중앙: Δ Lines + size 정렬 (콤팩트) */}
            <span style={{ width: 70, textAlign: 'center', flexShrink: 0, color: '#aaa' }} title="변경된 라인 수">Δ Lines</span>
            {/* 우측: Target 폴더 */}
            <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
              <span style={{ flexShrink: 0 }}>Target</span>
              <span
                onClick={() => toggleSort('leftSize')}
                style={{ marginLeft: 'auto', width: 50, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 3, flexShrink: 0, fontSize: 10, color: '#666' }}
                title="소스 크기로 정렬"
              >
                <span style={{ opacity: sortBy === 'leftSize' ? 1 : 0.3 }}>{sortBy === 'leftSize' ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}</span>
                Lsize
              </span>
              <span
                onClick={() => toggleSort('rightSize')}
                style={{ width: 50, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 3, flexShrink: 0, fontSize: 10, color: '#666' }}
                title="타겟 크기로 정렬"
              >
                <span style={{ opacity: sortBy === 'rightSize' ? 1 : 0.3 }}>{sortBy === 'rightSize' ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}</span>
                Rsize
              </span>
            </span>
          </div>
          <VList
            ref={listVlistRef}
            height={Math.max(0, (showList ? listHeight : 0) - LIST_HEADER_H)}
            width="100%" itemCount={filteredRows.length} itemSize={ROW_H} overscanCount={12}
            onScroll={({ scrollOffset }: { scrollOffset: number }) => {
              const max = filteredRows.length * ROW_H - Math.max(0, listHeight - LIST_HEADER_H);
              listAtBottomRef.current = scrollOffset >= max - 4;
            }}
          >
            {({ index, style }: ListChildComponentProps) => {
              const row = filteredRows[index];
              if (!row) return null;
              const sel = row.relPath === selectedRel;
              return (
                <div
                  key={row.relPath}
                  style={{
                    ...style,
                    display: 'flex',
                    alignItems: 'center',
                    padding: '0 10px',
                    fontSize: 12,
                    cursor: row.isDir ? 'default' : 'pointer',
                    background: statusBg(row.status, sel),
                    color: sel ? '#fff' : '#ccc',
                    boxSizing: 'border-box',
                  }}
                  onClick={() => {
                    if (row.isDir) return;
                    setSelectedRel(row.relPath);
                    loadDiff(row);
                  }}
                >
                  {/* Status badge */}
                  <span style={{ width: 70, color: statusColor(row.status), fontSize: 11, flexShrink: 0 }}>{statusLabel(row.status, t)}</span>
                  {/* Source side */}
                  <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden', minWidth: 0, opacity: row.status === 'right-only' ? 0.25 : 1 }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                      {row.status === 'right-only' ? '' : `${row.isDir ? '📁' : '📄'} ${row.relPath}`}
                    </span>
                    <span style={{ width: 50, textAlign: 'right', color: '#888', fontSize: 11, flexShrink: 0 }}>
                      {row.status !== 'right-only' ? formatSize(row.leftSize) : ''}
                    </span>
                  </span>
                  {/* Center: Δ Lines */}
                  <span style={{ width: 70, textAlign: 'center', color: row.changes && row.changes > 0 ? '#d8b556' : '#666', fontVariantNumeric: 'tabular-nums', flexShrink: 0, fontSize: 11 }}>
                    {row.changesPending ? '…' : (typeof row.changes === 'number' ? row.changes.toLocaleString() : (row.status === 'changed' ? '?' : ''))}
                  </span>
                  {/* Target side */}
                  <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden', minWidth: 0, opacity: row.status === 'left-only' ? 0.25 : 1 }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                      {row.status === 'left-only' ? '' : `${row.isDir ? '📁' : '📄'} ${row.relPath}`}
                    </span>
                    <span style={{ width: 50, textAlign: 'right', color: '#888', fontSize: 11, flexShrink: 0 }}>
                      {row.status !== 'left-only' ? formatSize(row.rightSize) : ''}
                    </span>
                  </span>
                </div>
              );
            }}
          </VList>
          </>
        )}
      </div>

      {/* 리사이저 — 디렉토리 모드만 */}
      {showList && (
        <div
          onMouseDown={onResizeStart}
          style={{ height: RESIZER_H, cursor: 'row-resize', background: '#333', flexShrink: 0 }}
          title={t('resizerTooltip')}
        />
      )}

      {/* 하단: Monaco DiffEditor — 픽셀 높이 (split * (100-topPct)/100). file 모드/diffExpanded 면 전체 */}
      <div style={{ height: diffH, flexShrink: 0, minHeight: 80, position: 'relative', background: '#1e1e1e', display: 'flex', flexDirection: 'column' }}>
        {!selectedRel ? (
          <div style={{ color: '#666', fontSize: 12, padding: 16, textAlign: 'center' }}>
            {compareMode === 'file' ? t('fileCompareHint', '양쪽 파일 경로를 입력하고 비교 버튼을 누르세요') : t('selectFileHint')}
          </div>
        ) : contentLoading ? (
          <div style={{ color: '#888', fontSize: 12, padding: 16, textAlign: 'center' }}>{t('loading')}</div>
        ) : contentErr ? (
          <div style={{ color: '#e36b6b', fontSize: 12, padding: 16 }}>{contentErr}</div>
        ) : (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '4px 8px', background: '#222', borderBottom: '1px solid #333', fontSize: 11, minWidth: 0, overflow: 'hidden' }}>
              {/* 1행: 경로(편집 가능 input) + 저장 + 전체 적용 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0 }}>
                <span style={{ color: '#888', fontSize: 11, flexShrink: 0 }}>{leftDirty && '● '}{t('source')}</span>
                <input
                  type="text"
                  value={leftPathDraft}
                  onChange={e => setLeftPathDraft(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); reloadFileByPath('left', leftPathDraft); } }}
                  onBlur={() => { if (leftPathDraft && leftPathDraft !== leftFilePath) reloadFileByPath('left', leftPathDraft); }}
                  placeholder={t('noPath')}
                  title={t('sourceLabelLine', { path: leftPathDraft || '' })}
                  spellCheck={false}
                  style={{ flex: 1, minWidth: 80, padding: '2px 6px', fontSize: 11, background: '#1a1a1a', color: leftDirty ? '#d8b556' : '#ddd', border: '1px solid #333', borderRadius: 3, fontFamily: 'monospace' }}
                />
                <button onClick={() => saveSide('left')} disabled={!leftDirty} title={t('saveSourceTitle')} style={{ padding: '2px 8px', fontSize: 11 }}>{t('saveSource')}</button>
                <button
                  onClick={async () => {
                    const name = (leftFilePath.split(/[\\/]/).pop() || 'source.txt');
                    const r: any = await (window as any).api?.compareDownload?.(name, leftContent, leftEnc);
                    if (r?.success) setSavingMsg(`✓ 다운로드: ${r.path}`);
                    else if (!r?.canceled) setSavingMsg(`✕ 다운로드 실패: ${r?.error || ''}`);
                    setTimeout(() => setSavingMsg(''), 2500);
                  }}
                  title="Source 내용(편집된 상태 포함)을 로컬로 다운로드"
                  style={{ padding: '2px 8px', fontSize: 11 }}
                >⬇ 소스</button>
                <button onClick={() => applyAll('right-to-left')} title={t('applyAllRightToLeftTitle')} style={{ padding: '2px 8px', fontSize: 11 }}>{t('applyAllToSource')}</button>
                <button onClick={() => applyAll('left-to-right')} title={t('applyAllLeftToRightTitle')} style={{ padding: '2px 8px', fontSize: 11 }}>{t('applyAllToTarget')}</button>
                <button onClick={() => saveSide('right')} disabled={!rightDirty} title={t('saveTargetTitle')} style={{ padding: '2px 8px', fontSize: 11 }}>{t('saveTarget')}</button>
                <button
                  onClick={async () => {
                    const name = (rightFilePath.split(/[\\/]/).pop() || 'target.txt');
                    const r: any = await (window as any).api?.compareDownload?.(name, rightContent, rightEnc);
                    if (r?.success) setSavingMsg(`✓ 다운로드: ${r.path}`);
                    else if (!r?.canceled) setSavingMsg(`✕ 다운로드 실패: ${r?.error || ''}`);
                    setTimeout(() => setSavingMsg(''), 2500);
                  }}
                  title="Target 내용(편집된 상태 포함)을 로컬로 다운로드"
                  style={{ padding: '2px 8px', fontSize: 11 }}
                >⬇ 타겟</button>
                <span style={{ color: '#888', fontSize: 11, flexShrink: 0 }}>{t('target')}{rightDirty && ' ●'}</span>
                <input
                  type="text"
                  value={rightPathDraft}
                  onChange={e => setRightPathDraft(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); reloadFileByPath('right', rightPathDraft); } }}
                  onBlur={() => { if (rightPathDraft && rightPathDraft !== rightFilePath) reloadFileByPath('right', rightPathDraft); }}
                  placeholder={t('noPath')}
                  title={t('targetLabelLine', { path: rightPathDraft || '' })}
                  spellCheck={false}
                  style={{ flex: 1, minWidth: 80, padding: '2px 6px', fontSize: 11, background: '#1a1a1a', color: rightDirty ? '#d8b556' : '#ddd', border: '1px solid #333', borderRadius: 3, fontFamily: 'monospace' }}
                />
                <button
                  onClick={() => setDiffExpanded(v => !v)}
                  title={diffExpanded ? '축소' : '전체 화면으로 확대'}
                  style={{ padding: '2px 6px', lineHeight: 1, flexShrink: 0, background: diffExpanded ? '#2a3a2a' : undefined, border: diffExpanded ? '1px solid #3a5a3a' : undefined, color: diffExpanded ? '#7fcf6e' : '#aaa', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                >
                  {diffExpanded ? (
                    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                      {/* 뒤 사각형 — 앞 사각형에 가려진 우상단 모서리 제외한 L자 경로 */}
                      <path d="M4 4 L1 4 L1 12 L9 12 L9 9"/>
                      {/* 앞 사각형 — 전체 */}
                      <rect x="4" y="1" width="8" height="8"/>
                    </svg>
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 5V1h4M8 1h4v4M12 8v4H8M5 12H1V8"/>
                    </svg>
                  )}
                </button>
              </div>
              {/* 2행: hunk 단위 양방향 적용 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ color: '#888', flex: 1 }}>{t('currentChange')}</span>
                <button onClick={() => navigateHunk('prev')} title={t('prevHunkTitle', { combo: formatKeyComboForOS(getKeybinding('diffPrevHunk')) })} style={{ padding: '2px 8px', fontSize: 11 }}>{t('prevHunk')}</button>
                <button onClick={() => navigateHunk('next')} title={t('nextHunkTitle', { combo: formatKeyComboForOS(getKeybinding('diffNextHunk')) })} style={{ padding: '2px 8px', fontSize: 11 }}>{t('nextHunk')}</button>
                <button onClick={() => applyCurrentHunk('right-to-left')} title={t('applyLeftTitle', { combo: formatKeyComboForOS(getKeybinding('diffApplyLeft')) })} style={{ padding: '2px 8px', fontSize: 11 }}>{t('applyToSource')}</button>
                <button onClick={() => applyCurrentHunk('left-to-right')} title={t('applyRightTitle', { combo: formatKeyComboForOS(getKeybinding('diffApplyRight')) })} style={{ padding: '2px 8px', fontSize: 11 }}>{t('applyToTarget')}</button>
                <span style={{ flex: 1 }} />
              </div>
              {/* 3행: EOL / 인코딩 뱃지 */}
              {(leftEol || leftEnc || rightEol || rightEnc) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, paddingTop: 2 }}>
                  <span style={{ flex: 1, display: 'flex', gap: 4 }}>
                    {leftEol && <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3, background: '#2a3a4a', color: '#8bbcda', border: '1px solid #3a5a7a', letterSpacing: '0.02em' }}>{leftEol}</span>}
                    {leftEnc && <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3, background: '#2a3a2a', color: '#8dcc8d', border: '1px solid #3a5a3a', letterSpacing: '0.02em' }}>{leftEnc}</span>}
                  </span>
                  <span style={{ flex: 1, display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                    {rightEnc && <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3, background: '#2a3a2a', color: '#8dcc8d', border: '1px solid #3a5a3a', letterSpacing: '0.02em' }}>{rightEnc}</span>}
                    {rightEol && <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3, background: '#2a3a4a', color: '#8bbcda', border: '1px solid #3a5a7a', letterSpacing: '0.02em' }}>{rightEol}</span>}
                  </span>
                </div>
              )}
            </div>
            {sameNote && (
              <div style={{ padding: '3px 10px', fontSize: 11, color: '#a0c4ff', background: '#1a2a3a', borderBottom: '1px solid #333' }}>ℹ {sameNote}</div>
            )}
            {savingMsg && (
              <div style={{ padding: '3px 10px', fontSize: 11, color: savingMsg.startsWith('✕') ? '#e36b6b' : '#7fcf6e', background: '#1a1a1a', borderBottom: '1px solid #333' }}>{savingMsg}</div>
            )}
            <div style={{ flex: 1, minHeight: 0 }}>
              <DiffEditor
                height="100%"
                language="plaintext"
                original={leftContent}
                modified={rightContent}
                theme="vs-dark"
                onMount={((editor) => {
                  diffEditorRef.current = editor;
                  // 양쪽 모델 변경 감지 → state 동기화
                  const origModel = editor.getOriginalEditor().getModel();
                  const modModel = editor.getModifiedEditor().getModel();
                  origModel?.onDidChangeContent(() => setLeftContent(origModel.getValue()));
                  modModel?.onDidChangeContent(() => setRightContent(modModel.getValue()));
                  // Ctrl+S 만 Monaco 단축키로 (저장 — 키 변경 빈도 적음)
                  const CTRL = 2048;
                  const KEY_S = 49;
                  editor.getModifiedEditor().addCommand(CTRL | KEY_S, () => saveSide('right'));
                  editor.getOriginalEditor().addCommand(CTRL | KEY_S, () => saveSide('left'));
                  // hunk 이동/적용 단축키는 window-level matchKeybinding 으로 처리 (사용자 커스터마이즈 가능)
                }) as DiffOnMount}
                options={{
                  readOnly: false,
                  originalEditable: true,
                  renderSideBySide: true,
                  automaticLayout: true,
                  minimap: { enabled: false },
                  fontSize: 12,
                  wordWrap: 'off',
                  // Whitespace 무시 — Monaco 의 trim-trailing 옵션 (다른 모드는 표시 텍스트를 별도로 정규화)
                  ignoreTrimWhitespace: wsMode === 'ignoreTrailing' || wsMode === 'ignoreAll',
                  // Show line endings — 제어문자 렌더링으로 CR/LF 가시화
                  renderControlCharacters: showEol,
                  // Mac 에서 우측 한 줄 밀림 증상의 근본 원인은 EOL 불일치(LF vs CRLF) — onSelect 에서 정규화 처리.
                  // 추가 UX 보조 옵션: 비슷한 라인 매칭 + 변경 없는 영역 접기.
                  diffAlgorithm: 'advanced',
                  experimental: { showMoves: true },
                  hideUnchangedRegions: { enabled: collapseUnchanged, contextLineCount: 3, revealLineCount: 20, minimumLineCount: 3 },
                }}
              />
            </div>
          </>
        )}
      </div>
      </div>{/* split 컨테이너 끝 */}

      {pickerSide && (
        <RemotePathPicker
          mode={compareMode === 'file' ? 'file' : 'folder'}
          source={pickerSide === 'left' ? leftSrc.mode : rightSrc.mode}
          termId={pickerSide === 'left' ? leftSrc.termId : rightSrc.termId}
          sourceLabel={pickerSide === 'left' ? leftSrc.label : rightSrc.label}
          initialPath={pickerSide === 'left' ? (leftSrc.basePath || undefined) : (rightSrc.basePath || undefined)}
          onPick={(p) => updateSrc(pickerSide!, { basePath: p })}
          onClose={() => setPickerSide(null)}
        />
      )}
      {/* All match 안내 모달 — 두 파일 내용이 완전히 일치할 때 */}
      {allMatchModal && (
        <div
          onClick={() => setAllMatchModal(null)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 5000,
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: 'linear-gradient(180deg, #1f2e1f 0%, #182518 100%)',
              border: '1px solid #4caf50',
              borderRadius: 10,
              padding: '22px 28px',
              minWidth: 360, maxWidth: 560,
              boxShadow: '0 12px 40px rgba(0,0,0,0.6), 0 0 24px rgba(76,175,80,0.25)',
              color: '#e0f0e0',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <span style={{ fontSize: 28, color: '#7fcf6e', textShadow: '0 0 12px rgba(127,207,110,0.7)' }}>✓</span>
              <span style={{ fontSize: 16, fontWeight: 600 }}>All match — 두 파일이 완전히 일치합니다</span>
            </div>
            <div style={{ fontSize: 12, color: '#a0c8a0', marginBottom: 4 }}>비교 결과 차이가 없습니다.</div>
            {(allMatchModal.left || allMatchModal.right) && (
              <div style={{ marginTop: 12, padding: '10px 12px', background: 'rgba(0,0,0,0.3)', borderRadius: 6, fontSize: 11, fontFamily: 'monospace', lineHeight: 1.5 }}>
                {allMatchModal.left && <div><span style={{ color: '#7a9' }}>L</span> {allMatchModal.left}</div>}
                {allMatchModal.right && <div><span style={{ color: '#7a9' }}>R</span> {allMatchModal.right}</div>}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 18 }}>
              <button
                onClick={() => setAllMatchModal(null)}
                autoFocus
                style={{
                  background: '#3b6e3b', color: '#fff', border: 0,
                  padding: '7px 18px', borderRadius: 5, cursor: 'pointer',
                  fontSize: 13, fontWeight: 500,
                }}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') setAllMatchModal(null); }}
              >확인</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
