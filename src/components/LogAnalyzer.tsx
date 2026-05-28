// src/components/LogAnalyzer.tsx
// 로그 분석 워크스페이스 — Wireshark 스타일.
// 필드별 멀티셀렉트 드롭다운 + 가상화 테이블 + 상세 패널.
// 파싱 포맷 (제시된 로그 전용):
//   MMDD HH:MM:SS.ffff TID (file, line) LEVEL <function> message
import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { FixedSizeList as VList, ListChildComponentProps } from 'react-window';
import type { PanelSession } from '../utils/layoutUtils';
import { RemotePathPicker } from './RemotePathPicker';

const api = (window as any).api || {};

// AI 에이전트 브랜드 아이콘 (ClaudeChat 탭과 동일)
const ClaudeIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" fill="#D97757"/>
  </svg>
);
const GeminiIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="laGeminiGrad" x1="12" y1="0" x2="12" y2="24" gradientUnits="userSpaceOnUse"><stop offset="0%" stopColor="#4285F4"/><stop offset="100%" stopColor="#00BFA5"/></linearGradient></defs>
    <path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" fill="url(#laGeminiGrad)"/>
  </svg>
);
const CodexIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" fill="#b0b0b0"/>
  </svg>
);

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
  // AI 에이전트 선택 드롭다운 — overflow 클리핑 회피 위해 portal + fixed 좌표
  const [aiAgentMenu, setAiAgentMenu] = useState<{ x: number; y: number } | null>(null);
  // 분석 요청 시 새 대화로 시작할지 (false=현재 대화에 추가)
  const [aiNewConversation, setAiNewConversation] = useState(true);
  useEffect(() => {
    if (!aiAgentMenu) return;
    const close = () => setAiAgentMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [aiAgentMenu]);

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

  // AI 분석 요청 — 현재 필터된 행을 별도 파일로 첨부 + 사용자 프롬프트 + 메타 컨텍스트 텍스트.
  // ClaudeChat 측은 newConversation:true 면 새 대화로 시작 (이전 컨텍스트 섞임 방지).
  const sendToAi = useCallback((agent: 'claude' | 'gemini' | 'codex' = 'claude') => {
    if (filtered.length === 0 || !aiPrompt.trim()) return;
    const slice = filtered.slice(-aiMaxLines); // 최근 N행 (꼬리 부분이 보통 더 유효)
    const NL = String.fromCharCode(10);
    // 첨부 파일 이름 — 소스 경로의 basename + timestamp
    // 파일명은 소스 기준 안정값 — timestamp 미포함. 현재 대화 이어가기에서 같은 소스 재요청 시
    // 이름이 같아야 첨부가 중복 누적되지 않고 최신 내용으로 교체됨.
    const base = (srcPath.match(/[^\\/]+$/)?.[0] || 'log').replace(/\.[^.]*$/, '');
    const fileName = `${base}.log`;
    // 활성 필터 요약
    const activeFilters: string[] = [];
    if (levelFilter.size > 0) activeFilters.push('Level=' + [...levelFilter].join(','));
    if (fileFilter.size > 0) activeFilters.push('File=' + [...fileFilter].join(','));
    if (tagFilter.size > 0) activeFilters.push('Tag=' + [...tagFilter].join(','));
    if (fnFilter.size > 0) activeFilters.push('Function=' + [...fnFilter].join(','));
    if (search) activeFilters.push('Search=' + search);
    // 첨부 파일 본문 — 헤더 메타 + 원본 행들. 이걸 통째로 파일로 첨부.
    const fileLines: string[] = [];
    fileLines.push('# Log Excerpt');
    fileLines.push('# source: ' + (srcMode === 'local' ? 'local ' : 'remote ') + srcPath);
    fileLines.push('# total filtered lines: ' + filtered.length + ' (attached: last ' + slice.length + ')');
    if (activeFilters.length > 0) fileLines.push('# active filters: ' + activeFilters.join(' / '));
    fileLines.push('# generated: ' + new Date().toISOString());
    fileLines.push('');
    for (const e of slice) fileLines.push(e.raw);
    const fileContent = fileLines.join(NL);
    // prompt 본문 — 사용자 질문 + 간단한 컨텍스트만. 본문은 첨부 파일에 있음.
    const promptLines: string[] = [];
    promptLines.push(aiPrompt.trim());
    promptLines.push('');
    promptLines.push('첨부된 로그 파일 `' + fileName + '` 을 분석해줘.');
    promptLines.push('- 소스: ' + srcPath);
    promptLines.push('- 라인 수: ' + slice.length + ' (전체 필터 결과 ' + filtered.length + '행 중 최근)');
    if (activeFilters.length > 0) promptLines.push('- 활성 필터: ' + activeFilters.join(' / '));
    const promptText = promptLines.join(NL);
    try {
      window.dispatchEvent(new CustomEvent('claude-prefill', {
        detail: {
          text: promptText,
          attachments: [{ name: fileName, content: fileContent }],
          newConversation: aiNewConversation,
          agent,
        },
      }));
    } catch {}
  }, [filtered, aiPrompt, aiMaxLines, srcMode, srcPath, levelFilter, fileFilter, tagFilter, fnFilter, search, aiNewConversation]);

  // 테이블+상세 를 함께 담는 split 컨테이너 높이 측정 — 픽셀 단위로 두 영역을 명확히 분할
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
  // VList 하단 앵커 — 스크롤이 맨 밑이면 테이블 높이 줄어들 때도 맨 밑 유지
  const vlistRef = useRef<any>(null);
  const atBottomRef = useRef(false);
  // 상세 패널 높이 = (split - 리사이저) * bottomPct/100. 테이블 최소 60 보장하도록 cap → 합이 split 초과 안 함.
  const avail = Math.max(0, splitH - RESIZER_H);
  const detailH = Math.min(Math.max(60, avail - 60), Math.max(60, Math.round(avail * bottomPct / 100)));
  const tableHeight = Math.max(60, avail - detailH);
  // 테이블 높이 변경 시 — 선택 항목이 있으면 그 항목을 계속 보이게, 없고 맨 밑이었으면 맨 밑 유지
  useEffect(() => {
    if (!vlistRef.current || filtered.length === 0) return;
    try {
      if (selectedIdx !== null && selectedIdx >= 0 && selectedIdx < filtered.length) {
        vlistRef.current.scrollToItem(selectedIdx, 'smart');
      } else if (atBottomRef.current) {
        vlistRef.current.scrollToItem(filtered.length - 1, 'end');
      }
    } catch {}
  }, [tableHeight]); // eslint-disable-line react-hooks/exhaustive-deps

  const onResizeStart = (e: React.MouseEvent) => {
    e.preventDefault(); // 드래그 중 텍스트 선택 방지
    const startY = e.clientY;
    // dPct 는 split 컨테이너 높이 기준으로 계산해야 마우스 이동과 1:1 로 맞음 (root 기준이면 헤더만큼 어긋남)
    const baseH = (splitWrapRef.current?.clientHeight || splitH) - RESIZER_H;
    const startPct = bottomPct;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    const onMove = (ev: MouseEvent) => {
      if (baseH <= 0) return;
      ev.preventDefault();
      const dy = startY - ev.clientY; // 위로 끌면 + (상세 패널 커짐)
      const dPct = (dy / baseH) * 100;
      setBottomPct(Math.max(8, Math.min(92, startPct + dPct)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = prevUserSelect;
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
    <div ref={rootRef} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0, overflow: 'hidden', background: '#1a1a1a' }}>
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
          <label style={{ fontSize: 11, color: '#aac', display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, cursor: 'pointer' }} title="체크: 새 대화로 시작 / 해제: 현재 대화창에 이어서">
            <input type="checkbox" checked={aiNewConversation} onChange={e => setAiNewConversation(e.target.checked)} style={{ margin: 0 }} />
            새 대화
          </label>
          <button
            onClick={e => {
              e.stopPropagation();
              if (aiAgentMenu) { setAiAgentMenu(null); return; }
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              // 메뉴를 버튼 아래쪽에 띄움 (우측 정렬)
              setAiAgentMenu({ x: r.right, y: r.bottom });
            }}
            disabled={filtered.length === 0 || !aiPrompt.trim()}
            title={`현재 필터된 ${filtered.length}행 중 최대 ${aiMaxLines}행을 AI 채팅창에 전달`}
            style={{ padding: '4px 12px', fontSize: 12, background: '#2b4e74', color: '#fff', border: '1px solid #3a6593', borderRadius: 3 }}
          >
            🤖 분석 요청 ▾
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

      {/* 테이블 + 상세 를 함께 담는 split 컨테이너 — 남은 공간 전체 차지, 내부를 픽셀로 분할 */}
      <div ref={setSplitWrapRef} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* 테이블 — 픽셀 높이 (split * (100-bottomPct)/100) */}
      <div style={{ height: tableHeight, flexShrink: 0, position: 'relative', overflow: 'hidden' }}>
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
          ref={vlistRef}
          height={tableHeight - 24}
          width="100%"
          itemCount={filtered.length}
          itemSize={ROW_H}
          overscanCount={15}
          onScroll={({ scrollOffset }: { scrollOffset: number }) => {
            const max = filtered.length * ROW_H - (tableHeight - 24);
            atBottomRef.current = scrollOffset >= max - 4;
          }}
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

      <div onMouseDown={onResizeStart} style={{ height: RESIZER_H, cursor: 'row-resize', background: '#333', flexShrink: 0 }} />

      {/* 상세 패널 — 픽셀 높이 (split * bottomPct/100). 테이블과 합쳐 split 높이를 정확히 채움 */}
      <div style={{ height: detailH, flexShrink: 0, background: '#1e1e1e', borderTop: '1px solid #333', overflow: 'auto', padding: 8, fontSize: 11, fontFamily: 'monospace', boxSizing: 'border-box' }}>
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
      </div>{/* split 컨테이너 끝 */}

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
      {/* AI 에이전트 선택 메뉴 — portal 로 body 에 렌더 (overflow 클리핑 회피). 버튼 위쪽 정렬. */}
      {aiAgentMenu && createPortal(
        <div
          style={{
            position: 'fixed', left: aiAgentMenu.x, top: aiAgentMenu.y,
            transform: 'translateX(-100%)', marginTop: 4,
            background: '#1a1a2e', border: '1px solid #3a3a5a', borderRadius: 6,
            boxShadow: '0 6px 20px rgba(0,0,0,0.5)', zIndex: 99999,
            minWidth: 160, padding: 4, display: 'flex', flexDirection: 'column', gap: 2,
          }}
          onClick={e => e.stopPropagation()}
        >
          {([
            { id: 'claude' as const, label: 'Claude', Icon: ClaudeIcon, color: '#a070ff' },
            { id: 'gemini' as const, label: 'Gemini', Icon: GeminiIcon, color: '#4a9eff' },
            { id: 'codex'  as const, label: 'Codex',  Icon: CodexIcon,  color: '#5cd97a' },
          ]).map(a => (
            <button
              key={a.id}
              onClick={() => { setAiAgentMenu(null); sendToAi(a.id); }}
              style={{
                background: 'transparent', color: '#ddd', border: 0,
                padding: '6px 10px', textAlign: 'left', cursor: 'pointer',
                borderRadius: 4, fontSize: 12, display: 'flex', alignItems: 'center', gap: 8,
              }}
              onMouseEnter={e => (e.currentTarget.style.background = a.color + '22')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <a.Icon />
              <span>{a.label} 로 분석</span>
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
};
