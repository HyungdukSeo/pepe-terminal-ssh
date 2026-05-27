// src/components/LogAnalyzer.tsx
// 로그 분석 워크스페이스 — Wireshark 스타일.
// 필드별 멀티셀렉트 드롭다운 + 가상화 테이블 + 상세 패널.
// 파싱 포맷 (제시된 로그 전용):
//   MMDD HH:MM:SS.ffff TID (file, line) LEVEL <function> message
import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { FixedSizeList as VList, ListChildComponentProps } from 'react-window';
import type { PanelSession } from '../utils/layoutUtils';
import { RemotePathPicker } from './RemotePathPicker';

const api = (window as any).api || {};

type Props = {
  sessions: PanelSession[];
};

type LogEntry = {
  idx: number;
  raw: string;
  date?: string;
  time?: string;
  tid?: string;
  file?: string;
  line?: string;
  level?: string;
  fn?: string;
  msg?: string;
  parsed: boolean;
};

const LOG_RE = /^(\d{4})\s+(\d{2}:\d{2}:\d{2}\.\d+)\s+(\d+)\s+\(([^,]+?)\s*,\s*(\d+)\)\s+([A-Z][A-Z0-9]+)\s*(?:<([^>]+)>\s*)?(.*)$/;

function parseLog(text: string): LogEntry[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: LogEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln.trim()) continue;
    const m = ln.match(LOG_RE);
    if (m) {
      out.push({
        idx: i, raw: ln,
        date: m[1], time: m[2], tid: m[3],
        file: m[4].trim(), line: m[5],
        level: m[6], fn: m[7]?.trim(), msg: m[8].trim(),
        parsed: true,
      });
    } else if (out.length > 0 && out[out.length - 1].parsed) {
      // 직전 파싱 항목의 연장선 (DUMP CE MSG 의 줄바꿈된 본문 등) — 별도 row 가 아니라
      // raw 와 msg 양쪽에 합쳐서 테이블에서도 +N줄 펼치면 보이고, 상세 패널은 전체 표시.
      const last = out[out.length - 1];
      last.raw = last.raw + '\n' + ln;
      last.msg = (last.msg || '') + '\n' + ln;
    } else {
      // 파싱 가능한 선행 항목이 없으면 그대로 unparsed row
      out.push({ idx: i, raw: ln, parsed: false });
    }
  }
  return out;
}

const LEVEL_COLOR: Record<string, string> = {
  DEB1: '#666', DEB2: '#777', DEB3: '#888',
  INFO: '#7fbeea', MIN: '#d8b556', MAJ: '#e8965a',
  WARN: '#e8965a', ERR: '#e36b6b', FATAL: '#ff4f4f',
};
const LEVEL_BG: Record<string, string> = {
  MIN: 'rgba(216, 181, 86, 0.06)', WARN: 'rgba(232, 150, 90, 0.08)',
  ERR: 'rgba(227, 107, 107, 0.1)', FATAL: 'rgba(255, 79, 79, 0.15)',
};

const ROW_H = 22;

// ── 멀티셀렉트 드롭다운 ──
// 각 필드의 가능한 값들을 카운트와 함께 보여주고, 체크박스로 멀티 선택.
type MSOption = { value: string; count: number; color?: string };
const MultiSelectDropdown: React.FC<{
  label: string;
  options: MSOption[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  width?: number;
  popupWidth?: number;
}> = ({ label, options, selected, onChange, width = 100, popupWidth = 260 }) => {
  const { t } = useTranslation('logAnalyzer');
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const ref = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // 외부 클릭으로 닫기
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node) && !btnRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const openMenu = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ left: r.left, top: r.bottom + 2 });
    setOpen(o => !o);
    setFilter('');
  };

  const filtered = filter.trim()
    ? options.filter(o => o.value.toLowerCase().includes(filter.toLowerCase()))
    : options;

  const allSelected = options.length > 0 && options.every(o => selected.has(o.value));
  const someSelected = selected.size > 0 && !allSelected;
  const summary = selected.size === 0 ? t('all') : selected.size === 1 ? [...selected][0] : t('selectedSummary', { count: selected.size });

  return (
    <>
      <button
        ref={btnRef}
        onClick={openMenu}
        title={t('filterTooltip', { label, state: selected.size === 0 ? t('noFilter') : t('selectedCount', { count: selected.size }) })}
        style={{
          width, fontSize: 11, padding: '3px 6px', textAlign: 'left',
          background: selected.size > 0 ? '#2b4e74' : '#222',
          border: '1px solid #444', color: selected.size > 0 ? '#fff' : '#bbb',
          cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4,
          whiteSpace: 'nowrap', overflow: 'hidden',
        }}>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}: {summary}</span>
        <span style={{ fontSize: 9 }}>▼</span>
      </button>
      {open && pos && (
        <div ref={ref}
          style={{
            position: 'fixed', left: pos.left, top: pos.top, width: popupWidth,
            background: '#1c1c1c', border: '1px solid #444', borderRadius: 4,
            boxShadow: '0 4px 16px rgba(0,0,0,0.5)', zIndex: 9999,
            display: 'flex', flexDirection: 'column', maxHeight: 400,
          }}>
          <div style={{ padding: '6px 8px', borderBottom: '1px solid #333', display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              autoFocus
              type="text"
              value={filter}
              onChange={e => setFilter(e.target.value)}
              onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') setOpen(false); }}
              placeholder={t('searchPlaceholder')}
              style={{ flex: 1, fontSize: 11, padding: '2px 4px' }}
            />
          </div>
          <div style={{ padding: '4px 8px', display: 'flex', gap: 6, borderBottom: '1px solid #2a2a2a', fontSize: 11 }}>
            <button onClick={() => onChange(new Set(options.map(o => o.value)))} style={{ fontSize: 10, padding: '1px 6px' }}>{t('all')}</button>
            <button onClick={() => onChange(new Set())} style={{ fontSize: 10, padding: '1px 6px' }}>{t('deselect')}</button>
            <span style={{ marginLeft: 'auto', color: '#888' }}>
              {someSelected ? `${selected.size}/${options.length}` : (allSelected ? t('allSelected') : t('none'))}
            </span>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
            {filtered.length === 0 ? (
              <div style={{ padding: 10, fontSize: 11, color: '#666', textAlign: 'center' }}>{t('none')}</div>
            ) : filtered.map(opt => {
              const isSel = selected.has(opt.value);
              return (
                <label key={opt.value} style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '3px 8px',
                  fontSize: 11, cursor: 'pointer',
                  background: isSel ? 'rgba(127,190,234,0.10)' : 'transparent',
                }}>
                  <input type="checkbox" checked={isSel} onChange={() => {
                    const next = new Set(selected);
                    if (isSel) next.delete(opt.value); else next.add(opt.value);
                    onChange(next);
                  }} />
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: opt.color || '#ccc' }} title={opt.value}>{opt.value}</span>
                  <span style={{ color: '#666', fontSize: 10 }}>{opt.count}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
};

export const LogAnalyzer: React.FC<Props> = ({ sessions }) => {
  const { t } = useTranslation('logAnalyzer');
  const [srcMode, setSrcMode] = useState<'local' | 'remote'>('local');
  const [srcTermId, setSrcTermId] = useState<string>('');
  const [srcPath, setSrcPath] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState<string>('');

  const [entries, setEntries] = useState<LogEntry[]>([]);
  // 실시간 watch 모드 — 옵션 생성용 seed (초기 파일 내용 파싱). 화면 entries 와 분리.
  const [seedEntries, setSeedEntries] = useState<LogEntry[]>([]);
  const [watching, setWatching] = useState(false);
  const watchIdRef = useRef<string>('');
  const watchBufRef = useRef<string>('');
  const watchSeqRef = useRef<number>(0);
  const [watchStats, setWatchStats] = useState<{ bytes: number; chunks: number; entries: number; lastAt: number; lastChunk?: string }>({ bytes: 0, chunks: 0, entries: 0, lastAt: 0 });
  const [sourceLabel, setSourceLabel] = useState<string>('');
  // AI 분석 프롬프트
  const [aiPrompt, setAiPrompt] = useState<string>('이 로그에서 에러/이상 패턴을 찾아 원인과 해결책을 한국어로 요약해주세요.');
  const [aiMaxLines, setAiMaxLines] = useState<number>(500);

  // 필터들 — 비어있으면 해당 필드 무시
  const [search, setSearch] = useState('');
  const [levelFilter, setLevelFilter] = useState<Set<string>>(new Set());
  const [fileFilter, setFileFilter] = useState<Set<string>>(new Set());
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set());
  const [fnFilter, setFnFilter] = useState<Set<string>>(new Set());
  const [hideUnparsed, setHideUnparsed] = useState(false);

  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [bottomPct, setBottomPct] = useState(25);
  const [filePickerOpen, setFilePickerOpen] = useState(false);

  // 컬럼 너비 — 마우스 드래그로 조절. message 는 flex:1 (잔여 공간) 이라 별도 너비 불필요.
  const [colW, setColW] = useState({ idx: 60, time: 110, level: 50, file: 180, line: 60, fn: 220 });
  const onColResizeStart = (col: keyof typeof colW, e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX;
    const startW = colW[col];
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(30, Math.min(800, startW + (ev.clientX - startX)));
      setColW(prev => ({ ...prev, [col]: next }));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  const rootRef = useRef<HTMLDivElement | null>(null);

  const sourceOptions = useMemo(() => {
    const opts: { termId: string; label: string }[] = [];
    for (const s of sessions) {
      if (!s.termId) continue;
      opts.push({ termId: s.termId, label: `🟢 ${s.sessionName}` });
    }
    return opts;
  }, [sessions.map(s => s.termId).join(',')]);

  const loadFile = useCallback(async () => {
    setLoadErr('');
    setEntries([]);
    setSelectedIdx(null);
    setLevelFilter(new Set()); setFileFilter(new Set()); setTagFilter(new Set()); setFnFilter(new Set());
    if (!srcPath) { setLoadErr(t('enterPath')); return; }
    if (srcMode === 'remote' && !srcTermId) { setLoadErr(t('selectRemote')); return; }
    setLoading(true);
    try {
      const r = await api.compareRead?.(srcMode, srcPath, srcMode === 'remote' ? srcTermId : undefined, 50 * 1024 * 1024);
      if (r?.error) throw new Error(r.error);
      const txt: string = r?.content ?? '';
      const parsed = parseLog(txt);
      setEntries(parsed);
      setSourceLabel(t('sourceLabel', { icon: srcMode === 'local' ? '🖥️' : '🟢', path: srcPath, count: parsed.length }));
    } catch (err: any) {
      setLoadErr(String(err?.message || err));
    } finally {
      setLoading(false);
    }
  }, [srcMode, srcTermId, srcPath]);

  // 실시간 watch — 기존 파일 내용은 옵션 seed 로만 사용, 화면 entries 는 새 라인만 누적
  const stopWatch = useCallback(async () => {
    if (watchIdRef.current) {
      try { await (api as any).logWatchStop?.(watchIdRef.current); } catch {}
      watchIdRef.current = '';
    }
    setWatching(false);
    watchBufRef.current = '';
  }, []);
  const startWatch = useCallback(async () => {
    setLoadErr('');
    if (!srcPath) { setLoadErr(t('enterPath')); return; }
    if (srcMode === 'remote' && !srcTermId) { setLoadErr(t('selectRemote')); return; }
    // 진행 중인 watch 중지
    await stopWatch();
    setEntries([]);
    setSeedEntries([]);
    setSelectedIdx(null);
    setLevelFilter(new Set()); setFileFilter(new Set()); setTagFilter(new Set()); setFnFilter(new Set());
    setWatchStats({ bytes: 0, chunks: 0, entries: 0, lastAt: 0 });
    watchSeqRef.current = 0;
    watchBufRef.current = '';
    setLoading(true);
    try {
      // 1) 기존 파일 읽어 옵션 seed 만 채움 (display 는 비움)
      const r = await api.compareRead?.(srcMode, srcPath, srcMode === 'remote' ? srcTermId : undefined, 50 * 1024 * 1024);
      if (r?.error) throw new Error(r.error);
      const txt: string = r?.content ?? '';
      const parsed = parseLog(txt);
      setSeedEntries(parsed);
      // 2) watch 시작
      const wid = 'lw-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
      watchIdRef.current = wid;
      const wr: any = await (api as any).logWatchStart?.(wid, srcMode, srcPath, srcMode === 'remote' ? srcTermId : undefined);
      if (!wr?.success) throw new Error(wr?.error || 'watch 시작 실패');
      setWatching(true);
      setSourceLabel(t('sourceLabel', { icon: srcMode === 'local' ? '🖥️' : '🟢', path: srcPath, count: parsed.length }) + ' · ⏱ watch');
    } catch (err: any) {
      setLoadErr(String(err?.message || err));
    } finally {
      setLoading(false);
    }
  }, [srcMode, srcTermId, srcPath, stopWatch]);
  // watch-data 수신: 라인 경계 처리 + parse → entries 누적
  useEffect(() => {
    const onData = (p: { watchId: string; text: string }) => {
      if (!p || p.watchId !== watchIdRef.current) return;
      // 도착한 raw 데이터 통계 — 백엔드 → 프론트 흐름 확인용
      setWatchStats(prev => ({ bytes: prev.bytes + (p.text?.length || 0), chunks: prev.chunks + 1, entries: prev.entries, lastAt: Date.now(), lastChunk: (p.text || '').slice(-200) }));
      const combined = watchBufRef.current + p.text;
      const lastNl = combined.lastIndexOf(String.fromCharCode(10));
      let chunk = '';
      if (lastNl >= 0) {
        chunk = combined.slice(0, lastNl + 1);
        watchBufRef.current = combined.slice(lastNl + 1);
      } else {
        watchBufRef.current = combined;
      }
      if (!chunk) return;
      const newOnes = parseLog(chunk);
      if (newOnes.length === 0) return;
      setEntries(prev => {
        const base = watchSeqRef.current;
        const reIdxed = newOnes.map((e, i) => ({ ...e, idx: base + i }));
        watchSeqRef.current = base + newOnes.length;
        return [...prev, ...reIdxed];
      });
      setWatchStats(prev => ({ ...prev, entries: prev.entries + newOnes.length }));
    };
    const onErr = (p: { watchId: string; error: string }) => {
      if (!p || p.watchId !== watchIdRef.current) return;
      setLoadErr(String(p.error || ''));
    };
    const off1 = (api as any).onLogWatchData?.(onData);
    const off2 = (api as any).onLogWatchError?.(onErr);
    return () => { try { off1?.(); } catch {} try { off2?.(); } catch {} };
  }, []);
  // 언마운트 시 watch 중지
  useEffect(() => () => { stopWatch(); }, [stopWatch]);

  // 인덱스 생성 — 각 필드의 가능한 값과 카운트
  const levelOptions = useMemo<MSOption[]>(() => {
    const m = new Map<string, number>();
    for (const e of [...seedEntries, ...entries]) if (e.level) m.set(e.level, (m.get(e.level) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([v, c]) => ({ value: v, count: c, color: LEVEL_COLOR[v] }));
  }, [entries, seedEntries]);
  const fileOptions = useMemo<MSOption[]>(() => {
    const m = new Map<string, number>();
    for (const e of [...seedEntries, ...entries]) if (e.file) m.set(e.file, (m.get(e.file) || 0) + 1);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([v, c]) => ({ value: v, count: c }));
  }, [entries, seedEntries]);
  // 메시지 내 [XXX] 형태의 태그 추출 — 대괄호 안 영숫자/언더스코어/한글/콜론/공백 등 일반 토큰
  const tagOptions = useMemo<MSOption[]>(() => {
    const m = new Map<string, number>();
    // 메시지 시작 부분의 연속된 [XXX][YYY] 만 추출 — value 형태(=[123]) 는 제외 (entries+seedEntries)
    const leadingTagRe = /^(\s*\[[^\[\]]{1,40}\])+/;
    const singleTagRe = /\[([^\[\]]{1,40})\]/g;
    for (const e of [...seedEntries, ...entries]) {
      if (!e.msg) continue;
      const lead = e.msg.match(leadingTagRe);
      if (!lead) continue;
      const block = lead[0];
      let mm: RegExpExecArray | null;
      const seen = new Set<string>();
      while ((mm = singleTagRe.exec(block)) !== null) {
        const tag = mm[1].trim();
        if (!tag) continue;
        if (seen.has(tag)) continue;
        seen.add(tag);
        m.set(tag, (m.get(tag) || 0) + 1);
      }
      singleTagRe.lastIndex = 0;
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([v, c]) => ({ value: v, count: c }));
  }, [entries, seedEntries]);
  const fnOptions = useMemo<MSOption[]>(() => {
    const m = new Map<string, number>();
    for (const e of [...seedEntries, ...entries]) if (e.fn) m.set(e.fn, (m.get(e.fn) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([v, c]) => ({ value: v, count: c }));
  }, [entries, seedEntries]);

  // 검색어 — 쉼표로 구분된 멀티 키워드 (OR 검색). 예: "A,B,C" → A 또는 B 또는 C 포함 라인 매칭.
  // 단일 키워드 안에 쉼표를 포함하려면 백슬래시 이스케이프 "\,"
  const searchTerms = useMemo(() => {
    const raw = search.trim();
    if (!raw) return [];
    // \, → 임시 토큰 → split → 복원
    const TOKEN = ' COMMA ';
    return raw.replace(/\\,/g, TOKEN)
      .split(',')
      .map(s => s.replace(new RegExp(TOKEN, 'g'), ',').trim().toLowerCase())
      .filter(Boolean);
  }, [search]);

  // 필터 적용 — 모든 활성 필터가 AND 결합. 검색어 내부는 OR.
  const filtered = useMemo(() => {
    return entries.filter(e => {
      if (hideUnparsed && !e.parsed) return false;
      if (levelFilter.size > 0 && (!e.level || !levelFilter.has(e.level))) return false;
      if (fileFilter.size > 0 && (!e.file || !fileFilter.has(e.file))) return false;
      if (tagFilter.size > 0) {
        if (!e.msg) return false;
        // msg 의 선두 [XXX][YYY] 만 검사 — value 형태(=[123]) 는 무시
        const lead = e.msg.match(/^(\s*\[[^\[\]]{1,40}\])+/);
        if (!lead) return false;
        const block = lead[0];
        const tagRe = /\[([^\[\]]{1,40})\]/g;
        let mm: RegExpExecArray | null; let hit = false;
        while ((mm = tagRe.exec(block)) !== null) { if (tagFilter.has(mm[1].trim())) { hit = true; break; } }
        if (!hit) return false;
      }
      if (fnFilter.size > 0 && (!e.fn || !fnFilter.has(e.fn))) return false;
      if (searchTerms.length > 0) {
        // 연장 라인은 raw 에 합쳐져 있으므로 raw 까지 검색 — DUMP 본문에서 키 검색 가능
        const hay = (e.parsed ? (e.fn || '') + ' ' + (e.msg || '') + ' ' + (e.file || '') + ' ' + e.raw : e.raw).toLowerCase();
        if (!searchTerms.some(t => hay.includes(t))) return false;
      }
      return true;
    });
  }, [entries, searchTerms, levelFilter, fileFilter, tagFilter, fnFilter, hideUnparsed]);

  // CSV 내보내기 — 현재 필터링된 파싱 항목만 저장. 멀티라인 message 는 quoted 셀에 줄바꿈 보존.
  const exportCsv = useCallback(async () => {
    const parsedRows = filtered.filter(e => e.parsed);
    if (parsedRows.length === 0) {
      setLoadErr(t('noExportData'));
      setTimeout(() => setLoadErr(''), 2500);
      return;
    }
    const esc = (v: string | undefined) => {
      const s = v ?? '';
      if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    };
    const header = ['#', 'Date', 'Time', 'TID', 'Level', 'File', 'Line', 'Function', 'Message'];
    const lines = [header.join(',')];
    for (const e of parsedRows) {
      lines.push([
        String(e.idx + 1), esc(e.date), esc(e.time), esc(e.tid),
        esc(e.level), esc(e.file), esc(e.line), esc(e.fn), esc(e.msg),
      ].join(','));
    }
    // main 의 sql:save-csv 핸들러가 BOM 을 prefix 로 추가하므로 여기선 안 붙임
    const content = lines.join('\r\n');
    const baseName = (srcPath.split(/[\\/]/).pop() || 'log').replace(/\.[^.]+$/, '');
    const ts = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
    const defaultName = `${baseName}-${stamp}.csv`;
    try {
      const r = await api.sqlSaveCsv?.(defaultName, content);
      if (r?.success && r?.path) {
        setLoadErr(''); setSourceLabel(prev => prev + t('csvSaved', { path: r.path }));
        setTimeout(() => setSourceLabel(prev => prev.replace(/ · CSV 저장됨: .+$/, '')), 4000);
      }
    } catch (err: any) {
      setLoadErr(t('csvSaveFail', { error: String(err?.message || err) }));
    }
  }, [filtered, srcPath]);

  // AI 분석 요청 — 현재 필터된 행을 텍스트 블록으로 만들어 ClaudeChat 에 prefill
  const sendToAi = useCallback(() => {
    if (filtered.length === 0 || !aiPrompt.trim()) return;
    const slice = filtered.slice(-aiMaxLines); // 최근 N행 (꼬리 부분이 보통 더 유효)
    const lines: string[] = [];
    lines.push(aiPrompt.trim());
    lines.push('');
    lines.push('### 로그 컨텍스트');
    lines.push('- 소스: ' + (srcMode === 'local' ? '🖥️ ' : '🟢 ') + srcPath);
    lines.push('- 전체 행 수: ' + filtered.length + ' (첨부: 최근 ' + slice.length + '행)');
    const activeFilters: string[] = [];
    if (levelFilter.size > 0) activeFilters.push('Level=' + [...levelFilter].join(','));
    if (fileFilter.size > 0) activeFilters.push('File=' + [...fileFilter].join(','));
    if (tagFilter.size > 0) activeFilters.push('Tag=' + [...tagFilter].join(','));
    if (fnFilter.size > 0) activeFilters.push('Function=' + [...fnFilter].join(','));
    if (search) activeFilters.push('Search=' + search);
    if (activeFilters.length > 0) lines.push('- 활성 필터: ' + activeFilters.join(' / '));
    lines.push('');
    lines.push('```log');
    for (const e of slice) {
      lines.push(e.raw);
    }
    lines.push('```');
    const payload = lines.join(String.fromCharCode(10));
    try {
      window.dispatchEvent(new CustomEvent('claude-prefill', { detail: { text: payload } }));
    } catch {}
  }, [filtered, aiPrompt, aiMaxLines, srcMode, srcPath, levelFilter, fileFilter, tagFilter, fnFilter, search]);

  // 테이블 컨테이너 높이
  const tableWrapRef = useRef<HTMLDivElement | null>(null);
  const [tableHeight, setTableHeight] = useState(400);
  const tableRoRef = useRef<ResizeObserver | null>(null);
  const setTableWrapRef = useCallback((el: HTMLDivElement | null) => {
    tableWrapRef.current = el;
    if (tableRoRef.current) { tableRoRef.current.disconnect(); tableRoRef.current = null; }
    if (!el) return;
    const update = () => setTableHeight(el.clientHeight || 400);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    tableRoRef.current = ro;
    update();
  }, []);
  useEffect(() => () => { tableRoRef.current?.disconnect(); }, []);

  const onResizeStart = (e: React.MouseEvent) => {
    const startY = e.clientY;
    const rect = rootRef.current?.getBoundingClientRect();
    const startPct = bottomPct;
    const onMove = (ev: MouseEvent) => {
      if (!rect) return;
      const dy = startY - ev.clientY;
      const dPct = (dy / rect.height) * 100;
      setBottomPct(Math.max(10, Math.min(70, startPct + dPct)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const selectedEntry = selectedIdx !== null ? filtered[selectedIdx] : null;
  const totalActiveFilters = (levelFilter.size > 0 ? 1 : 0) + (fileFilter.size > 0 ? 1 : 0) + (tagFilter.size > 0 ? 1 : 0) + (fnFilter.size > 0 ? 1 : 0);
  const clearAllFilters = () => {
    setLevelFilter(new Set()); setFileFilter(new Set()); setTagFilter(new Set()); setFnFilter(new Set());
  };

  return (
    <div ref={rootRef} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: '#1a1a1a' }}>
      {/* 헤더 — 소스 + 로드 */}
      <div style={{ padding: '8px 10px', background: '#222', borderBottom: '1px solid #333', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
          <select value={srcMode === 'remote' ? srcTermId : 'local'}
            onChange={e => {
              const v = e.target.value;
              if (v === 'local') { setSrcMode('local'); setSrcTermId(''); }
              else { setSrcMode('remote'); setSrcTermId(v); }
            }}
            style={{ width: 220, fontSize: 12 }}>
            <option value="local">{t('local')}</option>
            {sourceOptions.map(o => <option key={o.termId} value={o.termId}>{o.label}</option>)}
          </select>
          <input type="text" value={srcPath} placeholder={srcMode === 'local' ? t('pathPlaceholderLocal') : t('pathPlaceholderRemote')}
            onChange={e => setSrcPath(e.target.value)}
            onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') loadFile(); }}
            style={{ flex: 1, minWidth: 0, fontSize: 12, padding: '3px 6px' }} />
          <button
            onClick={async () => {
              if (srcMode === 'local') {
                try {
                  const r = await api.pickFiles?.(false);
                  if (r?.paths?.[0]) setSrcPath(r.paths[0]);
                } catch {}
              } else {
                if (!srcTermId) { setLoadErr(t('selectRemote')); return; }
                setFilePickerOpen(true);
              }
            }}
            title={t('pickFile')} style={{ padding: '3px 10px', fontSize: 12 }}>📂</button>
          <button className="primary" onClick={loadFile} disabled={loading || watching} style={{ padding: '4px 14px' }}>
            {loading ? t('loading') : t('load')}
          </button>
          {!watching ? (
            <button onClick={startWatch} disabled={loading} title="실시간 감시: 기존 데이터는 옵션 생성용으로만 사용. 새로 추가되는 라인만 필터에 맞춰 표시됨." style={{ padding: '4px 12px', background: '#2b4e74', color: '#fff', border: '1px solid #3a6593', borderRadius: 3 }}>
              ⏱ 실시간 시작
            </button>
          ) : (
            <button onClick={stopWatch} title="실시간 감시 중지" style={{ padding: '4px 12px', background: '#74402b', color: '#fff', border: '1px solid #934e3a', borderRadius: 3 }}>
              ⏹ 실시간 중지
            </button>
          )}
          <button onClick={exportCsv} disabled={loading || entries.length === 0} title={t('exportCsvTooltip')} style={{ padding: '4px 12px' }}>
            {t('exportCsv')}
          </button>
        </div>
        {/* AI 분석 바 — 필터 적용된 행을 컨텍스트로 채팅창에 전달 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
          <span style={{ fontSize: 12, color: '#bbb', flexShrink: 0 }}>🤖 AI 분석</span>
          <input
            type="text"
            value={aiPrompt}
            onChange={e => setAiPrompt(e.target.value)}
            onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') sendToAi(); }}
            placeholder="분석 요청 문구 입력 (Enter 로 전송)"
            style={{ flex: 1, minWidth: 200, fontSize: 12, padding: '3px 6px', background: '#1a1a1a', color: '#eee', border: '1px solid #333', borderRadius: 3 }}
          />
          <label style={{ fontSize: 11, color: '#888', display: 'flex', alignItems: 'center', gap: 4 }} title="최대 N개의 (필터된) 로그 행을 컨텍스트로 첨부">
            최대
            <input
              type="number"
              value={aiMaxLines}
              onChange={e => setAiMaxLines(Math.max(10, Math.min(5000, Number(e.target.value) || 500)))}
              style={{ width: 60, fontSize: 11, padding: '2px 4px', background: '#1a1a1a', color: '#eee', border: '1px solid #333', borderRadius: 3 }}
            />행
          </label>
          <button
            onClick={sendToAi}
            disabled={filtered.length === 0 || !aiPrompt.trim()}
            title={`현재 필터된 ${filtered.length}행 중 최대 ${aiMaxLines}행을 AI 채팅창에 전달`}
            style={{ padding: '4px 12px', fontSize: 12, background: '#2b4e74', color: '#fff', border: '1px solid #3a6593', borderRadius: 3 }}
          >
            🤖 분석 요청
          </button>
        </div>
        {sourceLabel && !loading && <div style={{ fontSize: 11, color: '#888' }}>{sourceLabel}</div>}
        {watching && (
          <div style={{ fontSize: 11, color: '#aac', background: '#1a2a3a', padding: '3px 8px', borderRadius: 3, border: '1px solid #2a3a5a' }}>
            ⏱ 수신 chunk={watchStats.chunks}, bytes={watchStats.bytes.toLocaleString()}, 파싱 항목={watchStats.entries}
            {watchStats.lastAt > 0 && ' · 마지막=' + Math.round((Date.now() - watchStats.lastAt) / 1000) + '초 전'}
            {watchStats.chunks === 0 && ' · (아직 데이터 수신 없음 — 파일에 새 라인이 append 되어야 표시됨)'}
          </div>
        )}
        {loadErr && <div style={{ color: '#e36b6b', fontSize: 12 }}>{loadErr}</div>}

        {/* 필터 바 — 검색 + 멀티셀렉트 드롭다운들 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', flexWrap: 'wrap' }}>
          <input type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder={t('searchMsg')}
            title={t('searchTooltip')}
            onKeyDown={e => e.stopPropagation()}
            style={{ flex: 1, minWidth: 200, fontSize: 12, padding: '3px 6px' }} />
          <MultiSelectDropdown label={t('filterLabels.level')} options={levelOptions} selected={levelFilter} onChange={setLevelFilter} width={120} popupWidth={220} />
          <MultiSelectDropdown label={t('filterLabels.file')} options={fileOptions} selected={fileFilter} onChange={setFileFilter} width={150} popupWidth={300} />
          <MultiSelectDropdown label={t('filterLabels.tag', { defaultValue: '태그' })} options={tagOptions} selected={tagFilter} onChange={setTagFilter} width={140} popupWidth={260} />
          <MultiSelectDropdown label={t('filterLabels.function')} options={fnOptions} selected={fnFilter} onChange={setFnFilter} width={170} popupWidth={320} />
          {totalActiveFilters > 0 && (
            <button onClick={clearAllFilters} style={{ fontSize: 11, padding: '3px 8px', color: '#d8b556' }} title={t('clearFiltersTitle')}>
              {t('clearFilters', { count: totalActiveFilters })}
            </button>
          )}
          <label style={{ fontSize: 11, color: '#bbb', display: 'flex', alignItems: 'center', gap: 3 }}>
            <input type="checkbox" checked={hideUnparsed} onChange={e => setHideUnparsed(e.target.checked)} />
            {t('hideUnparsed')}
          </label>
          <span style={{ fontSize: 11, color: '#888' }}>
            {filtered.length.toLocaleString()} / {entries.length.toLocaleString()}
          </span>
        </div>
      </div>

      {/* 테이블 */}
      <div ref={setTableWrapRef} style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
        <div style={{ display: 'flex', padding: '0 8px', background: '#1c1c1c', borderBottom: '1px solid #333', fontSize: 11, color: '#888', height: 24, boxSizing: 'border-box', alignItems: 'center' }}>
          {/* 컬럼 헤더 + 우측 리사이저 (마지막 message 제외) */}
          {([
            ['idx', t('columns.idx')], ['time', t('columns.time')], ['level', t('columns.level')], ['file', t('columns.file')], ['line', t('columns.line')], ['fn', t('columns.function')],
          ] as [keyof typeof colW, string][]).map(([key, label]) => (
            <div key={key} style={{ width: colW[key], display: 'flex', alignItems: 'center', flexShrink: 0, position: 'relative' }}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingRight: 4 }}>{label}</span>
              <div onMouseDown={e => onColResizeStart(key, e)}
                style={{ width: 6, height: '100%', cursor: 'col-resize', position: 'absolute', right: -3, top: 0, zIndex: 2 }}
                title={t('resizeColumn')} />
              <div style={{ width: 1, height: 14, background: '#444', position: 'absolute', right: 0, top: '50%', transform: 'translateY(-50%)' }} />
            </div>
          ))}
          <div style={{ flex: 1, paddingLeft: 6 }}>{t('columns.message')}</div>
        </div>
        <VList
          height={tableHeight - 24}
          width="100%"
          itemCount={filtered.length}
          itemSize={ROW_H}
          overscanCount={15}
        >
          {({ index, style }: ListChildComponentProps) => {
            const e = filtered[index];
            if (!e) return null;
            const sel = index === selectedIdx;
            const bg = sel ? '#2b4e74' : (e.level ? (LEVEL_BG[e.level] || (index % 2 ? '#181818' : '#1a1a1a')) : (index % 2 ? '#181818' : '#1a1a1a'));
            const cellSep: React.CSSProperties = { borderRight: '1px solid #2a2a2a', paddingRight: 6, paddingLeft: 0, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', boxSizing: 'border-box' };
            return (
              <div style={{ ...style, display: 'flex', padding: '0 8px', fontSize: 11, fontFamily: 'monospace', background: bg, color: sel ? '#fff' : '#ccc', cursor: 'pointer', boxSizing: 'border-box', alignItems: 'center' }}
                   onClick={() => setSelectedIdx(index)}>
                <div style={{ ...cellSep, width: colW.idx, color: '#666' }}>{e.idx + 1}</div>
                <div style={{ ...cellSep, width: colW.time, paddingLeft: 6, color: '#9ab' }}>{e.time || '-'}</div>
                <div style={{ ...cellSep, width: colW.level, paddingLeft: 6, color: e.level ? LEVEL_COLOR[e.level] || '#aaa' : '#666', fontWeight: e.level === 'MIN' || e.level === 'WARN' || e.level === 'ERR' ? 600 : 400 }}>{e.level || ''}</div>
                <div style={{ ...cellSep, width: colW.file, paddingLeft: 6, color: '#999' }} title={e.file || ''}>{e.file || ''}</div>
                <div style={{ ...cellSep, width: colW.line, paddingLeft: 6, color: '#9ab' }}>{e.line || ''}</div>
                <div style={{ ...cellSep, width: colW.fn, paddingLeft: 6, color: '#7fbeea' }} title={e.fn || ''}>{e.fn || ''}</div>
                <div style={{ flex: 1, paddingLeft: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: e.parsed ? '#ccc' : '#666' }} title={e.msg || e.raw}>
                  {e.msg || e.raw}
                  {e.parsed && e.raw.includes('\n') && (
                    <span style={{ color: '#d8b556', marginLeft: 6, fontSize: 10 }}>{t('extraLines', { count: e.raw.split('\n').length - 1 })}</span>
                  )}
                </div>
              </div>
            );
          }}
        </VList>
      </div>

      <div onMouseDown={onResizeStart} style={{ height: 4, cursor: 'row-resize', background: '#333', flexShrink: 0 }} />

      {/* 상세 패널 */}
      <div style={{ height: `${bottomPct}%`, minHeight: 80, background: '#1e1e1e', borderTop: '1px solid #333', overflow: 'auto', padding: 8, fontSize: 11, fontFamily: 'monospace' }}>
        {!selectedEntry ? (
          <div style={{ color: '#666', textAlign: 'center', padding: 16 }}>{t('selectLineHint')}</div>
        ) : (
          <div>
            <div style={{ color: '#888', marginBottom: 6, fontSize: 10 }}>{t('lineNum', { num: selectedEntry.idx + 1 })}</div>
            {selectedEntry.parsed ? (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <tbody>
                  <tr><td style={{ color: '#888', width: 80, verticalAlign: 'top' }}>{t('field.date')}</td><td>{selectedEntry.date}</td></tr>
                  <tr><td style={{ color: '#888', verticalAlign: 'top' }}>{t('field.time')}</td><td style={{ color: '#9ab' }}>{selectedEntry.time}</td></tr>
                  <tr><td style={{ color: '#888', verticalAlign: 'top' }}>{t('field.tid')}</td><td>{selectedEntry.tid}</td></tr>
                  <tr><td style={{ color: '#888', verticalAlign: 'top' }}>{t('field.level')}</td><td style={{ color: LEVEL_COLOR[selectedEntry.level || ''] || '#ccc' }}>{selectedEntry.level}</td></tr>
                  <tr><td style={{ color: '#888', verticalAlign: 'top' }}>{t('field.file')}</td><td style={{ color: '#999' }}>{selectedEntry.file}</td></tr>
                  <tr><td style={{ color: '#888', verticalAlign: 'top' }}>{t('field.line')}</td><td style={{ color: '#9ab' }}>{selectedEntry.line}</td></tr>
                  {selectedEntry.fn && <tr><td style={{ color: '#888', verticalAlign: 'top' }}>{t('field.function')}</td><td style={{ color: '#7fbeea' }}>{selectedEntry.fn}</td></tr>}
                  <tr><td style={{ color: '#888', verticalAlign: 'top' }}>{t('field.message')}</td><td style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{selectedEntry.msg}</td></tr>
                  <tr><td style={{ color: '#888', verticalAlign: 'top', paddingTop: 6 }}>{t('field.raw')}</td><td style={{ color: '#666', whiteSpace: 'pre-wrap', wordBreak: 'break-all', paddingTop: 6 }}>{selectedEntry.raw}</td></tr>
                </tbody>
              </table>
            ) : (
              <div>
                <div style={{ color: '#d8b556', marginBottom: 4 }}>{t('unparsedHeading')}</div>
                <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: '#aaa' }}>{selectedEntry.raw}</pre>
              </div>
            )}
          </div>
        )}
      </div>

      {filePickerOpen && srcMode === 'remote' && srcTermId && (
        <RemotePathPicker
          mode="file"
          source="remote"
          termId={srcTermId}
          sourceLabel={sourceOptions.find(o => o.termId === srcTermId)?.label || ''}
          initialPath={srcPath || undefined}
          onPick={(p) => setSrcPath(p)}
          onClose={() => setFilePickerOpen(false)}
        />
      )}
    </div>
  );
};
