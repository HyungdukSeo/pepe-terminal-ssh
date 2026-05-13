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
};

type Props = {
  sessions: PanelSession[];
};

const ROW_H = 22;

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
  // 양쪽 소스 + 경로 — UI 입력
  const [leftSrc, setLeftSrc] = useState<Source>({ mode: 'local', label: t('local'), basePath: '' });
  const [rightSrc, setRightSrc] = useState<Source>({ mode: 'local', label: t('local'), basePath: '' });

  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState('');
  const [rows, setRows] = useState<DiffRow[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [hideSame, setHideSame] = useState(true);
  const [hideUnpaired, setHideUnpaired] = useState(false); // 한쪽만 있는 항목 숨김

  const [selectedRel, setSelectedRel] = useState<string | null>(null);
  const [leftContent, setLeftContent] = useState<string>('');
  const [rightContent, setRightContent] = useState<string>('');
  const [leftOriginal, setLeftOriginal] = useState<string>(''); // 디스크에서 읽은 원본 (dirty 판단용)
  const [rightOriginal, setRightOriginal] = useState<string>('');
  const [contentErr, setContentErr] = useState<string>('');
  const [contentLoading, setContentLoading] = useState(false);
  const [savingMsg, setSavingMsg] = useState<string>('');
  // 선택된 파일의 양쪽 절대경로 (저장용)
  const [leftFilePath, setLeftFilePath] = useState<string>('');
  const [rightFilePath, setRightFilePath] = useState<string>('');

  // 위/아래 영역 비율 — 사용자가 드래그로 조절
  const [topPct, setTopPct] = useState(50);
  // 디렉토리 picker — 어느 쪽 소스의 경로를 선택 중인지
  const [pickerSide, setPickerSide] = useState<Side | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 가용 소스 목록 (드롭다운) — 연결된 세션(termId 있음) 만 SFTP 비교 가능. lazy 는 일단 제외.
  const sourceOptions = useMemo<Source[]>(() => {
    const opts: Source[] = [{ mode: 'local', label: t('local'), basePath: '' }];
    for (const s of sessions) {
      if (!s.termId) continue;
      opts.push({ mode: 'remote', termId: s.termId, sessionId: s.sessionId, label: `🟢 ${s.sessionName}`, basePath: '' });
    }
    return opts;
  }, [sessions.map(s => s.termId).join(',')]);

  const filteredRows = useMemo(() => rows.filter(r => {
    if (hideSame && r.status === 'same') return false;
    if (hideUnpaired && (r.status === 'left-only' || r.status === 'right-only')) return false;
    return true;
  }), [rows, hideSame, hideUnpaired]);

  const startCompare = useCallback(async () => {
    setScanError('');
    setRows([]);
    setSelectedRel(null);
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
    } catch (err: any) {
      setScanError(String(err?.message || err));
    } finally {
      setScanning(false);
    }
  }, [leftSrc, rightSrc]);

  const loadDiff = useCallback(async (row: DiffRow) => {
    setContentErr('');
    setSavingMsg('');
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
      if (l?.error) setContentErr(t('sourceReadFail', { error: l.error }));
      else { setLeftContent(l?.content ?? ''); setLeftOriginal(l?.content ?? ''); }
      if (r?.error) setContentErr((prev) => prev ? prev + ' / ' + t('targetReadFail', { error: r.error }) : t('targetReadFail', { error: r.error }));
      else { setRightContent(r?.content ?? ''); setRightOriginal(r?.content ?? ''); }
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
    const startY = e.clientY;
    const rect = rootRef.current?.getBoundingClientRect();
    const startPct = topPct;
    const onMove = (ev: MouseEvent) => {
      if (!rect) return;
      const dy = ev.clientY - startY;
      const dPct = (dy / rect.height) * 100;
      setTopPct(Math.max(15, Math.min(85, startPct + dPct)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // 소스 변경 시 basePath 보존
  const updateSrc = (side: Side, patch: Partial<Source>) => {
    if (side === 'left') setLeftSrc(s => ({ ...s, ...patch }));
    else setRightSrc(s => ({ ...s, ...patch }));
  };

  const renderSourcePicker = (side: Side, src: Source) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
      <span style={{ fontSize: 12, color: '#bbb', width: 50, flexShrink: 0 }}>{side === 'left' ? t('source') : t('target')}</span>
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
        style={{ width: 180, fontSize: 12 }}
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

  // 가상 리스트 높이 추적
  const listWrapRef = useRef<HTMLDivElement | null>(null);
  const [listHeight, setListHeight] = useState(300);
  const listRoRef = useRef<ResizeObserver | null>(null);
  const setListWrapRef = useCallback((el: HTMLDivElement | null) => {
    listWrapRef.current = el;
    if (listRoRef.current) { listRoRef.current.disconnect(); listRoRef.current = null; }
    if (!el) return;
    const update = () => setListHeight(el.clientHeight || 300);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    listRoRef.current = ro;
    update();
  }, []);
  useEffect(() => () => { listRoRef.current?.disconnect(); }, []);

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
    <div ref={rootRef} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: '#1a1a1a' }}>
      {/* 헤더: 양쪽 소스 + 비교 버튼 */}
      <div style={{ padding: '8px 10px', background: '#222', borderBottom: '1px solid #333', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {renderSourcePicker('left', leftSrc)}
        {renderSourcePicker('right', rightSrc)}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button className="primary" onClick={startCompare} disabled={scanning} style={{ padding: '4px 14px' }}>
            {scanning ? t('comparing') : t('compare')}
          </button>
          <button onClick={() => {
            // 소스 ↔ 타겟 스위치 — 서버/세션/경로 통째로 교환
            setLeftSrc(rightSrc);
            setRightSrc(leftSrc);
            setRows([]);
            setSelectedRel(null);
          }} title={t('switchTitle')} style={{ padding: '4px 10px' }}>{t('switch')}</button>
          <label style={{ fontSize: 12, color: '#bbb', display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={hideSame} onChange={e => setHideSame(e.target.checked)} />
            {t('hideSame')}
          </label>
          <label style={{ fontSize: 12, color: '#bbb', display: 'flex', alignItems: 'center', gap: 4 }} title={t('hideUnpairedTitle')}>
            <input type="checkbox" checked={hideUnpaired} onChange={e => setHideUnpaired(e.target.checked)} />
            {t('hideUnpaired')}
          </label>
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

      {/* 상단: 비교 결과 트리 (가상화) */}
      <div ref={setListWrapRef} style={{ height: `${topPct}%`, minHeight: 100, overflow: 'hidden', background: '#161616', position: 'relative' }}>
        {rows.length === 0 ? (
          <div style={{ color: '#666', fontSize: 12, padding: 16, textAlign: 'center' }}>
            {t('enterBothHint')}
          </div>
        ) : (
          <VList height={listHeight} width="100%" itemCount={filteredRows.length} itemSize={ROW_H} overscanCount={12}>
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
                  <span style={{ width: 70, color: statusColor(row.status), fontSize: 11 }}>{statusLabel(row.status, t)}</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {row.isDir ? '📁' : '📄'} {row.relPath}
                  </span>
                  <span style={{ width: 60, textAlign: 'right', color: '#888' }}>{formatSize(row.leftSize)}</span>
                  <span style={{ width: 20, textAlign: 'center', color: '#555' }}>·</span>
                  <span style={{ width: 60, textAlign: 'right', color: '#888' }}>{formatSize(row.rightSize)}</span>
                </div>
              );
            }}
          </VList>
        )}
      </div>

      {/* 리사이저 */}
      <div
        onMouseDown={onResizeStart}
        style={{ height: 4, cursor: 'row-resize', background: '#333', flexShrink: 0 }}
        title={t('resizerTooltip')}
      />

      {/* 하단: Monaco DiffEditor — 양쪽 편집 가능 + 적용/저장 툴바 */}
      <div style={{ flex: 1, minHeight: 100, position: 'relative', background: '#1e1e1e', display: 'flex', flexDirection: 'column' }}>
        {!selectedRel ? (
          <div style={{ color: '#666', fontSize: 12, padding: 16, textAlign: 'center' }}>
            {t('selectFileHint')}
          </div>
        ) : contentLoading ? (
          <div style={{ color: '#888', fontSize: 12, padding: 16, textAlign: 'center' }}>{t('loading')}</div>
        ) : contentErr ? (
          <div style={{ color: '#e36b6b', fontSize: 12, padding: 16 }}>{contentErr}</div>
        ) : (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '4px 8px', background: '#222', borderBottom: '1px solid #333', fontSize: 11 }}>
              {/* 1행: 경로 + 저장 + 전체 적용 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ color: leftDirty ? '#d8b556' : '#888', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={leftFilePath}>
                  {leftDirty && '● '}{t('sourceLabelLine', { path: leftFilePath || t('noPath') })}
                </span>
                <button onClick={() => saveSide('left')} disabled={!leftDirty} title={t('saveSourceTitle')} style={{ padding: '2px 8px', fontSize: 11 }}>{t('saveSource')}</button>
                <button onClick={() => applyAll('right-to-left')} title={t('applyAllRightToLeftTitle')} style={{ padding: '2px 8px', fontSize: 11 }}>{t('applyAllToSource')}</button>
                <button onClick={() => applyAll('left-to-right')} title={t('applyAllLeftToRightTitle')} style={{ padding: '2px 8px', fontSize: 11 }}>{t('applyAllToTarget')}</button>
                <button onClick={() => saveSide('right')} disabled={!rightDirty} title={t('saveTargetTitle')} style={{ padding: '2px 8px', fontSize: 11 }}>{t('saveTarget')}</button>
                <span style={{ color: rightDirty ? '#d8b556' : '#888', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'right' }} title={rightFilePath}>
                  {t('targetLabelLine', { path: rightFilePath || t('noPath') })}{rightDirty && ' ●'}
                </span>
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
            </div>
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
                  minimap: { enabled: false },
                  fontSize: 12,
                  wordWrap: 'off',
                }}
              />
            </div>
          </>
        )}
      </div>

      {pickerSide && (
        <RemotePathPicker
          mode="folder"
          source={pickerSide === 'left' ? leftSrc.mode : rightSrc.mode}
          termId={pickerSide === 'left' ? leftSrc.termId : rightSrc.termId}
          sourceLabel={pickerSide === 'left' ? leftSrc.label : rightSrc.label}
          initialPath={pickerSide === 'left' ? (leftSrc.basePath || undefined) : (rightSrc.basePath || undefined)}
          onPick={(p) => updateSrc(pickerSide!, { basePath: p })}
          onClose={() => setPickerSide(null)}
        />
      )}
    </div>
  );
};
