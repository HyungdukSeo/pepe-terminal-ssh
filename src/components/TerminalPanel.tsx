// src/components/TerminalPanel.tsx
import React, { useEffect, useRef, useState, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import type { Panel, PanelSession } from '../utils/layoutUtils';
import { ContextMenu } from './ContextMenu';
import { RemoteFileTree } from './RemoteFileTree';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { SearchAddon } from 'xterm-addon-search';
import { Unicode11Addon } from 'xterm-addon-unicode11';
import { getThemeByName, terminalThemes } from '../utils/terminalThemes';
import { getTerminalSettings } from '../utils/terminalSettings';
import { matchKeybinding, isKeybindingListening } from '../utils/keybindings';
import 'xterm/css/xterm.css';

// ── 모듈 레벨: 컴포넌트 lifecycle과 독립 ──

// terminal namespace 미리 로드 — 모듈 레벨 함수에서 i18n.t('terminal:...') 호출하기 위함
try { i18n.loadNamespaces('terminal'); } catch {}
const tt = (key: string, opts?: any) => i18n.t(`terminal:${key}`, opts) as string;

let currentThemeName = localStorage.getItem('terminalTheme') || 'Default Dark';
const defaultFontSize = Number(localStorage.getItem('terminalFontSize')) || 14;
const termOpacity: Map<string, number> = new Map();
const termThemeCache: Map<string, string> = new Map(); // termId → 적용된 테마 이름
function applyTermOpacity(termId: string, containerEl?: HTMLElement | null) {
  const opacity = termOpacity.get(termId) ?? 1.0;
  const entry = termStore.get(termId);
  const themeName = termThemeCache.get(termId) || currentThemeName;
  const theme = getThemeByName(themeName) as any;
  const themeBg = theme?.background || '#000000';

  if (entry) {
    if (opacity >= 1) {
      entry.term.options.theme = { ...theme } as any;
    } else {
      const hex6 = themeBg.startsWith('#') && themeBg.length === 7 ? themeBg.slice(1) : '000000';
      const a = Math.round(opacity * 255).toString(16).padStart(2, '0');
      entry.term.options.theme = { ...theme, background: `#${hex6}${a}` } as any;
    }
  }
  if (containerEl) {
    containerEl.style.background = opacity >= 1 ? themeBg : 'transparent';
  }
  // 하나라도 투명한 터미널이 있으면 전체 투명 모드 CSS 클래스 토글
  const anyTransparent = [...termOpacity.values()].some(v => v < 1);
  document.documentElement.classList.toggle('term-transparent-active', anyTransparent);
}
const DEFAULT_WORD_SEPARATORS = ' ./\\()"\'-:,.;<>~!@#$%^&*|+=[]{}`~?';
let currentWordSeparator = localStorage.getItem('terminalWordSeparator') ?? DEFAULT_WORD_SEPARATORS;
// termId별 폰트 크기
const termFontSizes: Map<string, number> = new Map();

export const termStore: Map<string, { term: Terminal; fit: FitAddon; search: SearchAddon }> = new Map();
// 마지막 PTY/SSH resize 크기 — 변경 없을 때 SIGWINCH 송신 안 하기 위함 (vim W11 경고 회피)
const lastResizeMap: Map<string, { cols: number; rows: number }> = new Map();
// 마지막 fit 시점의 컨테이너 px 사이즈 — 같으면 fit 자체 skip (탭 전환 시 잦은 SIGWINCH 회피)
const lastContainerSizeMap: Map<string, { w: number; h: number }> = new Map();
// 탭 활성화 직후 일정 시간 fit/resize 차단 cooldown (per termId)
const fitCooldownUntil: Map<string, number> = new Map();
// 직전 fit 결과 — 연속 2회 동일 cols/rows 일 때만 실제 SIGWINCH (layout 안정화 대기)
const pendingResize: Map<string, { cols: number; rows: number }> = new Map();
// vim 1002h 첫 수신 시 ttymouse=sgr 자동 주입 플래그 (per termId)
const ttymouseSgrInjected: Set<string> = new Set(); void ttymouseSgrInjected;
// xterm 의 focus reporting (\x1b[I/O) 송신 패치 — vim 의 FocusGained → :checktime → W11 경고 방지
function patchSuppressFocusEvents(term: any, termId?: string) {
  try {
    const core = term._core;
    if (!core) return;
    const cs = core.coreService || core._coreService;
    if (!cs) return;
    if (cs && typeof cs.triggerDataEvent === 'function' && !cs.__focusPatched) {
      cs.__focusPatched = true;
      const orig = cs.triggerDataEvent.bind(cs);
      cs.triggerDataEvent = function(data: string, wasUserInput?: boolean) {
        if (data === '\x1b[I' || data === '\x1b[O') return;
        if (typeof data === 'string' && data.includes('\x1b[?1004')) return;
        // DA2 응답 (xterm 버전) 을 380 으로 높여서 vim 이 ttymouse=sgr 자동 선택하도록
        if (typeof data === 'string') {
          const m = data.match(/^\x1b\[>(\d+);(\d+);(\d+)c$/);
          if (m) data = `\x1b[>${m[1]};380;${m[3]}c`;
        }
        return orig(data, wasUserInput);
      };
    }
    if (cs?.decPrivateModes && !cs.__sendFocusFrozen) {
      try {
        cs.decPrivateModes.sendFocus = false;
        Object.defineProperty(cs.decPrivateModes, 'sendFocus', {
          get() { return false; },
          set() {},
          configurable: false,
        });
        // 1007 alt-scroll mode 도 강제 false — 휠 → 화살표 변환 차단
        // (vim 에서 휠 스크롤이 cursor 이동으로 변환되어 CursorMoved → checktime 트리거되는 문제)
        try {
          cs.decPrivateModes.altSendsEscape = cs.decPrivateModes.altSendsEscape;
          if ('altSendsEscape' in cs.decPrivateModes) { /* keep */ }
        } catch {}
        cs.__sendFocusFrozen = true;
      } catch {}
    }
    // alt-scroll mode (DECSET 1007) 비활성화 — term.options.altClickMovesCursor 와는 별도
    try {
      if (term.options) (term.options as any).fastScrollModifier = 'none';
    } catch {}
    // wheel 이벤트 capture phase 에서 가로채 alt 버퍼면 직접 scrollLines 처리
    // 마우스 이벤트 직접 forwarding — xterm v5.3 의 1002 mode click 미작동 회피
    const elem = (term as any).element as HTMLElement | undefined;
    if (elem && !(elem as any).__mouseForwardInstalled) {
      (elem as any).__mouseForwardInstalled = true;
      const getMouseMode = (): string => {
        try {
          const core = term._core;
          if (!core) return 'none';
          const cms = core.coreMouseService || core._mouseService || (core as any)._coreMouseService;
          if (cms) {
            const ap = cms.activeProtocol || cms._activeProtocol;
            if (ap && ap !== 'NONE') return ap;
          }
        } catch {}
        return 'none';
      };
      const getCellPos = (ev: MouseEvent): { col: number; row: number } | null => {
        try {
          const rs = term._core?._renderService;
          const cellW = rs?.dimensions?.css?.cell?.width ?? 9;
          const cellH = rs?.dimensions?.css?.cell?.height ?? 17;
          const screen = elem.querySelector('.xterm-screen') as HTMLElement | null;
          const rect = (screen || elem).getBoundingClientRect();
          const col = Math.max(1, Math.floor((ev.clientX - rect.left) / cellW) + 1);
          const row = Math.max(1, Math.floor((ev.clientY - rect.top) / cellH) + 1);
          return { col, row };
        } catch { return null; }
      };
      const isActive = (m: string) => m === 'X10' || m === 'VT200' || m === 'DRAG' || m === 'ANY';
      const isDragMode = (m: string) => m === 'DRAG' || m === 'ANY';
      const getEncoding = (): 'DEFAULT' | 'SGR' => {
        try {
          const core = term._core;
          const cms = core?.coreMouseService || core?._mouseService || core?._coreMouseService;
          const enc = cms?.activeEncoding || cms?._activeEncoding;
          if (enc === 'SGR' || enc === 'SGR_PIXELS') return 'SGR';
        } catch {}
        return 'DEFAULT';
      };
      void getEncoding;
      const sendMouseEvent = (cb: number, col: number, row: number, release: boolean) => {
        // 항상 SGR 형식으로 송신 — legacy X10/xterm2 이 일부 vim 환경에서 안 먹힘
        const seq = `\x1b[<${cb};${col};${row}${release ? 'm' : 'M'}`;
        try {
          if (!termId) return;
          if (ptyConnected.has(termId)) (window as any).api?.ptyInput?.(termId, seq);
          else (window as any).api?.sendSSHInput?.(termId, seq);
        } catch {}
      };
      let dragging = false;
      let lastBtn = 0;
      elem.addEventListener('mousedown', (ev: MouseEvent) => {
        const mode = getMouseMode();
        if (!isActive(mode)) return;
        // 우클릭(button=2) — 앱 컨텍스트 메뉴 띄움
        if (ev.button === 2) return;
        // Shift+클릭 — vim mouse 모드 bypass, xterm 자체 선택/복사 사용 가능
        if (ev.shiftKey) return;
        const pos = getCellPos(ev);
        if (!pos) return;
        const btn = ev.button;
        lastBtn = btn;
        sendMouseEvent(btn, pos.col, pos.row, false);
        dragging = isDragMode(mode);
        ev.preventDefault();
      }, true);
      elem.addEventListener('mouseup', (ev: MouseEvent) => {
        const mode = getMouseMode();
        if (!isActive(mode) || !dragging) return;
        if (ev.shiftKey) return;
        const pos = getCellPos(ev);
        if (!pos) return;
        sendMouseEvent(lastBtn, pos.col, pos.row, true);
        dragging = false;
      }, true);
      elem.addEventListener('mousemove', (ev: MouseEvent) => {
        if (!dragging) return;
        const mode = getMouseMode();
        if (!isDragMode(mode)) return;
        const pos = getCellPos(ev);
        if (!pos) return;
        sendMouseEvent(lastBtn + 32, pos.col, pos.row, false);
      }, true);
      // 휠은 vim 으로 forwarding 안 함 — alt 버퍼에서 native scroll
      elem.addEventListener('wheel', (ev: WheelEvent) => {
        if (ev.ctrlKey || ev.metaKey) return; // Ctrl+wheel = 폰트 zoom
        try {
          const buf = (term as any).buffer?.active;
          if (!buf || buf.type !== 'alternate') return;
          ev.preventDefault();
          ev.stopImmediatePropagation();
          term.scrollLines(ev.deltaY > 0 ? 3 : -3);
        } catch {}
      }, { capture: true });
    }
    // textarea 의 focus/blur 이벤트 자체에서도 송신 안하도록 핸들러 추가 — capture phase 에서 전파 차단
    const ta = term.textarea as HTMLTextAreaElement | undefined;
    if (ta && !(ta as any).__focusBlockerInstalled) {
      (ta as any).__focusBlockerInstalled = true;
      // xterm 의 focus listener 가 등록되기 전에 추가하기 위해 즉시 적용
      // 단순히 listener 하나 더 — xterm 이 \x1b[I/O 송신해도 위 패치가 차단
    }
  } catch {}
}

// 비활성 워크스페이스/패널의 xterm DOM 을 보관하는 hidden stash — detach 시 scrollbar/viewport 상태 보존
function getXtermStash(): HTMLElement {
  let s = document.getElementById('xterm-stash') as HTMLElement | null;
  if (!s) {
    s = document.createElement('div');
    s.id = 'xterm-stash';
    s.style.cssText = 'position:fixed;left:-99999px;top:-99999px;width:1px;height:1px;overflow:hidden;pointer-events:none;visibility:hidden';
    document.body.appendChild(s);
  }
  return s;
}
// 여러 줄 붙여넣기 BrowserWindow 의 결과 (paste/cancel) 리스너 — 모듈 1회만 등록
// (TerminalPanel 인스턴스가 여러 개일 때 중복 등록되면 paste 가 N번 실행됨)
let _pasteResultListenerInstalled = false;
function ensurePasteResultListener() {
  if (_pasteResultListenerInstalled) return;
  _pasteResultListenerInstalled = true;
  try {
    (window as any).api?.onPasteModalResult?.((p: { id: string; action: 'paste' | 'cancel'; text: string }) => {
      const tid = p.id;
      if (p.action === 'paste') {
        // textarea 가 \r\n → \n 정규화한 결과 → 터미널은 ENTER=\r 기대
        const text = p.text.replace(/\r?\n/g, '\r');
        // bracketed paste 래핑 회피 — PTY/SSH 채널로 직접 송신 (Shift+Insert 와 동일 효과)
        try {
          if (ptyConnected.has(tid)) (window as any).api.ptyInput(tid, text);
          else (window as any).api.sendSSHInput(tid, text);
        } catch {}
      }
      setTimeout(() => focusTerm(tid), 0);
    });
  } catch {}
}
// 앱 초기화 시 한 번 호출
if (typeof window !== 'undefined') {
  setTimeout(ensurePasteResultListener, 0);
}

// 워크스페이스 전환 등으로 .xterm DOM 이 stash 로 이동되면 .xterm-viewport 의 scrollTop 이
// 0 으로 리셋됨 (hidden 1×1 컨테이너라 scrollHeight 가 collapse). 복귀 시 원래 위치로 돌리기 위해
// stash 직전에 xterm 내부 논리 스크롤 라인을 저장.
const termSavedScroll: Map<string, { viewportY: number; atBottom: boolean }> = new Map();

export function stashXtermDom(termId: string) {
  const entry = termStore.get(termId);
  if (!entry) return;
  const term: any = entry.term;
  try {
    const buf = term.buffer?.active;
    if (buf) {
      const viewportY = buf.viewportY ?? 0;
      const baseY = buf.baseY ?? 0;
      termSavedScroll.set(termId, { viewportY, atBottom: viewportY >= baseY });
    }
  } catch {}
  const el = term.element as HTMLElement | undefined;
  if (el && el.parentNode && el.parentNode !== getXtermStash()) {
    getXtermStash().appendChild(el);
  }
}

// stash 에서 꺼낸 후 refit 이 안정화된 시점에 호출 — 저장된 논리 라인 위치로 복원.
// viewportY 는 라인 단위라 fit 으로 cols/rows 가 바뀌어도 유효함.
function restoreSavedScroll(termId: string) {
  const saved = termSavedScroll.get(termId);
  if (!saved) return;
  const entry = termStore.get(termId);
  if (!entry) return;
  const term: any = entry.term;
  try {
    if (saved.atBottom) {
      term.scrollToBottom?.();
    } else {
      const baseY = term.buffer?.active?.baseY ?? 0;
      const target = Math.min(saved.viewportY, baseY);
      if (typeof term.scrollToLine === 'function') term.scrollToLine(target);
      else {
        const curY = term.buffer?.active?.viewportY ?? 0;
        term.scrollLines?.(target - curY);
      }
    }
  } catch {}
}

// xterm 5.3 의 rows 증가 시 grow bug 수동 보정.
// fit() 직후 rows 가 늘어났다면, buffer 끝에 추가된 빈 줄을 제거하고 ybase/ydisp/y 를 재계산해서
// 스크롤 위치(맨 아래에 컨텐츠 보이도록)를 유지. fit() 호출 전후로 prevRows 와 r 을 비교해야 함.
export function applyXtermGrowFix(term: any, prevRows: number) {
  const r = term.rows;
  console.log('[GROWFIX] called prevRows=' + prevRows + ' r=' + r);
  if (r <= prevRows) { console.log('[GROWFIX] skip (no grow)'); return; }
  try {
    const core = term._core;
    const buf = core?.buffer;
    if (!buf || !buf.lines) { console.log('[GROWFIX] skip (no buf)'); return; }
    const cursorAbsolute = buf.ybase + buf.y;
    const before = { ybase: buf.ybase, ydisp: buf.ydisp, y: buf.y, len: buf.lines.length, cursorAbs: cursorAbsolute };
    // 마지막 줄 몇 개가 빈 줄인지 미리 확인
    let trailingBlanks = 0;
    for (let i = buf.lines.length - 1; i >= 0; i--) {
      const ln = buf.lines.get(i);
      if (ln && typeof ln.getTrimmedLength === 'function' && ln.getTrimmedLength() === 0) trailingBlanks++;
      else break;
    }
    console.log('[GROWFIX] before: ' + JSON.stringify(before) + ' trailingBlanks=' + trailingBlanks);
    // 트림 하한: 커서 위치를 포함하면서 viewport rows 이상이어야 함.
    const minLen = Math.max(cursorAbsolute + 1, r);
    const initialLen = buf.lines.length;
    while (buf.lines.length > minLen) {
      const last = buf.lines.get(buf.lines.length - 1);
      if (last && (typeof last.getTrimmedLength === 'function') && last.getTrimmedLength() === 0) {
        buf.lines.length = buf.lines.length - 1;
      } else { break; }
    }
    const trimmed = initialLen - buf.lines.length;
    const newYbase = Math.max(0, buf.lines.length - r);
    const newY = cursorAbsolute - newYbase;
    console.log('[GROWFIX] trim: minLen=' + minLen + ' trimmed=' + trimmed + ' newLen=' + buf.lines.length + ' newYbase=' + newYbase + ' newY=' + newY);
    buf.ybase = newYbase;
    buf.ydisp = newYbase;
    buf.y = newY;
    core._viewport?.syncScrollArea?.();
    try { core._onScroll?.fire?.(newYbase); } catch {}
    const vp = term.element?.querySelector?.('.xterm-viewport') as HTMLElement | null;
    if (vp) {
      const cellH = core._renderService?.dimensions?.css?.cell?.height || 17;
      vp.scrollTop = newYbase * cellH;
    }
    core._renderService?.refreshRows?.(0, r - 1);
    console.log('[GROWFIX] done. final: ybase=' + buf.ybase + ' y=' + buf.y + ' len=' + buf.lines.length);
  } catch (e) { console.error('[GROWFIX] error', e); }
}

// 외부에서 termId 의 fit + resize 강제 — 워크스페이스 전환 후 풀스크린 터미널 크기 보정 등
export function refitTerm(termId: string) {
  const entry = termStore.get(termId);
  if (!entry) return;
  try {
    const term: any = entry.term;
    const prevRows = term.rows;
    const bufA = term._core?.buffer;
    console.log('[REFIT] start prevRows=' + prevRows + ' buf=' + (bufA ? JSON.stringify({ybase:bufA.ybase,y:bufA.y,len:bufA.lines?.length}) : 'null'));
    entry.fit.fit();
    const c = term.cols;
    const r = term.rows;
    const bufB = term._core?.buffer;
    console.log('[REFIT] after fit rows=' + r + ' buf=' + (bufB ? JSON.stringify({ybase:bufB.ybase,y:bufB.y,len:bufB.lines?.length}) : 'null'));
    if (c && r) {
      if (ptyConnected.has(termId)) schedulePtyResize(termId, c, r);
      else (window as any).api?.resizeSSH?.(termId, c, r);
    }
    if (r > prevRows) {
      applyXtermGrowFix(term, prevRows);
    } else {
      try { term._core?._viewport?.syncScrollArea?.(); } catch {}
    }
    const bufC = term._core?.buffer;
    console.log('[REFIT] before refresh buf=' + (bufC ? JSON.stringify({ybase:bufC.ybase,y:bufC.y,len:bufC.lines?.length}) : 'null'));
    term.refresh?.(0, term.rows - 1);
    const bufD = term._core?.buffer;
    console.log('[REFIT] after refresh buf=' + (bufD ? JSON.stringify({ybase:bufD.ybase,y:bufD.y,len:bufD.lines?.length}) : 'null'));
    // viewport 의 overflow 토글 + scrollTop 만지기로 브라우저 scrollbar 재렌더 강제
    const elem = term.element as HTMLElement | undefined;
    const viewport = elem?.querySelector?.('.xterm-viewport') as HTMLElement | null;
    if (viewport) {
      const orig = viewport.style.overflowY;
      viewport.style.overflowY = 'hidden';
      void viewport.offsetHeight;
      viewport.style.overflowY = orig || 'auto';
      const st = viewport.scrollTop;
      viewport.scrollTop = st + 1;
      viewport.scrollTop = st;
    }
    const bufE = term._core?.buffer;
    console.log('[REFIT] end buf=' + (bufE ? JSON.stringify({ybase:bufE.ybase,y:bufE.y,len:bufE.lines?.length}) : 'null'));
    // 80ms 후 다시 확인 — 누가 cursor 를 되돌리는지 추적
    setTimeout(() => {
      const bufF = term._core?.buffer;
      console.log('[REFIT] +80ms buf=' + (bufF ? JSON.stringify({ybase:bufF.ybase,y:bufF.y,len:bufF.lines?.length}) : 'null'));
    }, 80);
  } catch {}
}
const sshInitialized = new Set<string>();
const globalConnected = new Set<string>();
const connectedListeners = new Set<() => void>();
// 빠른연결 등 'sessionId 가 비어 있지만 곧 SSH 연결될' 종류의 termId.
// PTY 스폰 분기를 차단하고 SSH 핸드셰이크 결과를 기다리게 함.
const quickConnectPending = new Set<string>();
// "▶ SSH 연결을 시도하는 중..." placeholder 메시지를 termId 당 1회만 출력하기 위한 표식
const quickConnectPlaceholderShown = new Set<string>();
export function markQuickConnectPending(termId: string) {
  quickConnectPending.add(termId);
}
export function clearQuickConnectPending(termId: string) {
  quickConnectPending.delete(termId);
}
// IME 조합 상태: 조합 중에는 onData를 건너뛰고, 완료 시 최종 텍스트를 1회 전송
// 파일 트리 표시 여부 — 전역 플래그 (예전엔 termId 별 Map 이었는데 패널 전환 시
// 각 패널이 따로 토글 상태 가져서 불편 → 전체 앱 단위 단일 값으로 변경).
let globalTreeVisible = true;
const treeVisibleChangeListeners: Set<() => void> = new Set();

// 자격증명 입력 모달 등 오버레이가 열려있을 때 터미널 자동 포커스 억제 플래그
let termFocusBlocked = false;
export function setTermFocusBlocked(v: boolean) { termFocusBlocked = v; }
/** term.focus() 래퍼 — 모달 오픈 중이면 무시 */
function safeTermFocus(term: any) { if (!termFocusBlocked) { try { term.focus(); } catch {} } }
export function isTreeVisibleForTerm(_termId: string): boolean {
  return globalTreeVisible;
}
export function toggleTreeVisibleForTerm(_termId: string) {
  globalTreeVisible = !globalTreeVisible;
  treeVisibleChangeListeners.forEach(fn => fn());
}


// 각 터미널(세션)의 현재 원격 디렉토리. sshBridge 에서 주입한 OSC 7 hook 의 출력을
// xterm 의 OSC 핸들러가 여기에 저장. 트리 열 때 initialPath 로 사용.
const termCurrentPwd: Map<string, string> = new Map();
const pwdChangeListeners: Map<string, Set<(pwd: string) => void>> = new Map();
export function getCurrentPwdForTerm(termId: string): string | undefined {
  return termCurrentPwd.get(termId);
}
export function subscribePwdChange(termId: string, fn: (pwd: string) => void): () => void {
  let set = pwdChangeListeners.get(termId);
  if (!set) { set = new Set(); pwdChangeListeners.set(termId, set); }
  set.add(fn);
  return () => { set?.delete(fn); };
}
function notifyPwdChange(termId: string, pwd: string) {
  pwdChangeListeners.get(termId)?.forEach(fn => { try { fn(pwd); } catch {} });
}

const termIMEComposing: Map<string, boolean> = new Map();
// 조합 완료 직후 xterm이 동일 문자열로 onData를 한 번 더 발화할 수 있어 중복 차단용
const termJustComposed: Map<string, { text: string; at: number }> = new Map();

function notifyConnectedChange() { connectedListeners.forEach(fn => fn()); }

export function isTermConnected(termId: string): boolean {
  return globalConnected.has(termId);
}

export function subscribeConnectedChange(fn: () => void): () => void {
  connectedListeners.add(fn);
  return () => { connectedListeners.delete(fn); };
}

let fontOsdTimer: ReturnType<typeof setTimeout> | null = null;
let fontOsdEl: HTMLDivElement | null = null;


function showFontSizeOSD(parent: HTMLElement, size: number) {
  if (fontOsdTimer) clearTimeout(fontOsdTimer);
  if (!fontOsdEl) {
    fontOsdEl = document.createElement('div');
    fontOsdEl.className = 'font-size-osd';
    document.body.appendChild(fontOsdEl);
  }
  fontOsdEl.textContent = `${size}pt`;
  fontOsdEl.style.display = 'flex';
  fontOsdEl.style.opacity = '1';
  // 위치: 화면 중앙
  const rect = parent.getBoundingClientRect();
  fontOsdEl.style.top = `${rect.top + rect.height / 2 - 25}px`;
  fontOsdEl.style.left = `${rect.left + rect.width / 2 - 40}px`;
  fontOsdTimer = setTimeout(() => {
    if (fontOsdEl) { fontOsdEl.style.opacity = '0'; }
    fontOsdTimer = setTimeout(() => {
      if (fontOsdEl) fontOsdEl.style.display = 'none';
    }, 300);
  }, 800);
}

// ── 터미널 녹화 (REC) ──
// recording 상태 추적 + write tap. term.write 를 monkey-patch 해서 모든 출력을 main 으로 흘려보냄.
// UI 가 구독할 수 있도록 listener 패턴.
export const recordingState: Map<string, { path: string; startedAt: number }> = new Map();
const recordingListeners: Set<(termId: string) => void> = new Set();
export function subscribeRecording(fn: (termId: string) => void): () => void {
  recordingListeners.add(fn);
  return () => { recordingListeners.delete(fn); };
}
function notifyRecording(termId: string) { recordingListeners.forEach(fn => { try { fn(termId); } catch {} }); }
export function isRecording(termId: string): boolean { return recordingState.has(termId); }
export async function startRecording(termId: string, sessionName: string): Promise<{ ok: boolean; path?: string; reason?: string }> {
  if (recordingState.has(termId)) return { ok: false, reason: 'already-recording' };
  const r = await (window as any).api?.recStart?.(termId, sessionName);
  if (r?.ok) {
    recordingState.set(termId, { path: r.path, startedAt: Date.now() });
    notifyRecording(termId);
  }
  return r || { ok: false, reason: 'no-api' };
}
export async function stopRecording(termId: string): Promise<{ ok: boolean; path?: string }> {
  if (!recordingState.has(termId)) return { ok: false };
  const r = await (window as any).api?.recStop?.(termId);
  recordingState.delete(termId);
  notifyRecording(termId);
  return r || { ok: true };
}
function recAppend(termId: string, data: string, kind?: 'out' | 'in' | 'mark') {
  if (!recordingState.has(termId)) return;
  try { (window as any).api?.recAppend?.(termId, data, kind); } catch {}
}
export function recordMark(termId: string, text: string) { recAppend(termId, text, 'mark'); }
export function recordInput(termId: string, data: string) { recAppend(termId, data, 'in'); }

function getOrCreateTerm(termId: string): { term: Terminal; fit: FitAddon; search: SearchAddon } {
  let entry = termStore.get(termId);
  if (!entry) {
    // 세션 복제 등으로 미리 설정된 값이 있으면 우선 적용
    const initThemeName = termThemeCache.get(termId) || currentThemeName;
    const initFontSize = termFontSizes.get(termId) ?? defaultFontSize;
    const initScrollback = termScrollbackOverride.get(termId) ?? getTerminalSettings().scrollback;
    const savedFont = localStorage.getItem('terminalFontFamily') || '';
    // 복제 시 cloneTermStyle 가 미리 캐시해둔 cursor blink/style 우선 적용 — 기본은 true (깜박임)
    const initCursorBlink = termCursorBlinkCache.has(termId) ? termCursorBlinkCache.get(termId)! : true;
    const cachedCursorStyle = termCursorStyleCache.get(termId);
    // xterm 네이티브 cursorStyle 만 init 옵션으로 (커스텀 오버레이 스타일은 mount 이후 applyCursorStyleToTerm 가 처리)
    const nativeCursorStyle: 'block' | 'underline' | 'bar' | undefined =
      cachedCursorStyle === 'block' || cachedCursorStyle === 'underline' || cachedCursorStyle === 'bar'
        ? cachedCursorStyle as any
        : undefined;
    const term = new Terminal({
      cursorBlink: initCursorBlink,
      cursorStyle: nativeCursorStyle,
      fontSize: initFontSize,
      fontFamily: savedFont || "'Cascadia Mono', Consolas, monospace",
      theme: getThemeByName(initThemeName) as any,
      allowProposedApi: true,
      allowTransparency: true,
      customGlyphs: true,
      wordSeparator: currentWordSeparator,
      scrollback: initScrollback,
    });
    // REC tap — term.write 를 monkey-patch 해서 모든 출력 데이터를 녹화 stream 으로 흘림.
    // PTY/SSH bridge 가 보낸 raw 데이터 + 앱 자체가 합성한 메시지(연결됨/끊김 등) 모두 캡처.
    try {
      const origWrite = term.write.bind(term);
      (term as any).write = function (data: string | Uint8Array, cb?: () => void) {
        if (recordingState.has(termId)) {
          try {
            const s = typeof data === 'string' ? data : new TextDecoder('utf-8').decode(data);
            recAppend(termId, s, 'out');
          } catch {}
        }
        return origWrite(data as any, cb);
      };
    } catch {}
    if (!termFontSizes.has(termId)) termFontSizes.set(termId, defaultFontSize);
    const fit = new FitAddon();
    // FitAddon.fit() 안전 패치 — 컨테이너가 layout 갱신 중 일시적으로 0-size 가 될 때
    // proposeDimensions 가 {cols:2, rows:1} 같은 비현실 값을 반환 → term.resize(2,1) 가
    // 호출되면서 xterm 화면이 2-col 로 reflow 됐다가 다시 reflow 되어 프롬프트가 잘려
    // 보이는 잔상 (예: "[r") 이 발생.
    // 사용자가 의도적으로 패널을 작게 만든 케이스(작은 cols/rows)는 정상 처리해야 하므로,
    // cols/rows 가 아니라 부모 컨테이너의 실제 픽셀 크기를 기준으로 판단.
    try {
      const origFit = fit.fit.bind(fit);
      (fit as any).fit = function () {
        try {
          // FitAddon 은 term.element.parentElement 를 기준으로 계산
          const parent = (term as any).element?.parentElement as HTMLElement | undefined;
          if (parent) {
            const w = parent.clientWidth;
            const h = parent.clientHeight;
            // 부모가 사실상 0-size — 분명히 layout 갱신 중. 사용자가 정상적으로
            // 만들 수 있는 최소 패널 크기보다 훨씬 작은 임계 (수 픽셀) 만 차단.
            if (w < 20 || h < 20) return;
          }
          // proposeDimensions 결과가 0/NaN 이면 (부모 dimensions 측정 실패) 차단
          const p = (fit as any).proposeDimensions?.();
          if (!p || !p.cols || !p.rows || !isFinite(p.cols) || !isFinite(p.rows)) return;
        } catch { /* 계산 실패 시 그래도 origFit 시도 */ }
        return origFit();
      };
    } catch {}
    const search = new SearchAddon();
    const unicode11 = new Unicode11Addon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(unicode11);
    term.unicode.activeVersion = '11';
    // Alt-buffer 진입 감지 (DECSET 1049 / 47 / 1047) — vim/less/htop 등 풀스크린 TUI 가
    // 열릴 때마다 PTY 사이즈를 강제 재동기화. 초기 fit 이 비활성 탭/숨김 컨테이너에서
    // 실패했어도 vim 이 작은 사이즈로 렌더되지 않도록 안전망.
    try {
      const csiHandler = (params: any) => {
        try {
          const arr = Array.isArray(params) ? params : (params?.params || []);
          const p = arr[0];
          if (p === 1049 || p === 47 || p === 1047) {
            // 다음 마이크로태스크에 fit + force resize — buffer 전환이 완료된 후
            setTimeout(() => {
              try {
                const entry = termStore.get(termId);
                if (!entry) return;
                entry.fit.fit();
                const c = (entry.term as any).cols;
                const r = (entry.term as any).rows;
                if (c && r && isFinite(c) && isFinite(r)) {
                  if (ptyConnected.has(termId)) (window as any).api?.ptyResize?.(termId, c, r);
                  else (window as any).api?.resizeSSH?.(termId, c, r, true);
                }
              } catch {}
            }, 0);
          }
        } catch {}
        return false; // xterm 이 정상적으로 계속 처리하도록
      };
      (term as any).parser?.registerCsiHandler?.({ final: 'h', prefix: '?' }, csiHandler);
    } catch { /* 미지원 xterm 버전 무시 */ }
    // OSC 7 핸들러 — 셸이 보낸 file://host/path 를 파싱해서 현재 pwd 저장.
    // 지원 형식:
    //   file://host/abs/posix/path        → /abs/posix/path
    //   file:///C:/Users/foo              → C:/Users/foo (Windows local)
    //   file:///C:\Users\foo              → C:\Users\foo (Windows local, backslash 도 허용)
    try {
      (term as any).parser?.registerOscHandler?.(7, (data: string) => {
        // file:// 접두 제거
        let raw = data.replace(/^file:\/\/[^/]*/, '');
        if (!raw) return true;
        // 선두 슬래시가 두 개면 (//) 한 개 제거 — file://localhost//path 케이스
        try { raw = decodeURIComponent(raw); } catch { /* keep encoded */ }
        let p: string;
        // Windows 드라이브: 선두 / 다음 [A-Z]: 면 / 제거
        const winMatch = raw.match(/^\/([a-zA-Z]:[\\/].*)$/);
        if (winMatch) {
          p = winMatch[1];
          // forward slash → backslash 통일 (Windows fs 호환)
          p = p.replace(/\//g, '\\');
        } else {
          p = raw.startsWith('/') ? raw : '/' + raw;
        }
        const prev = termCurrentPwd.get(termId);
        termCurrentPwd.set(termId, p);
        if (prev !== p) notifyPwdChange(termId, p);
        return true;
      });
    } catch { /* older xterm 없으면 무시 */ }
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      // 단축키 변경 중이면 모든 키 통과
      if (isKeybindingListening()) return true;
      // Backspace / Delete 키 시퀀스 커스터마이즈 (세션 옵션) — 기본값은 xterm 기본 시퀀스
      // Ctrl+Backspace / Ctrl+Delete 도 동일하게 세션 설정 시퀀스로 전송 (xterm 기본은 ^H 만 보냄)
      {
        const send = (seq: string) => {
          try {
            if (ptyConnected.has(termId)) (window as any).api?.ptyInput?.(termId, seq);
            else (window as any).api?.sendSSHInput?.(termId, seq);
          } catch {}
        };
        const plain = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
        const ctrlOnly = e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
        // Xshell/PuTTY 호환: Ctrl 누르면 설정의 "반대" 시퀀스를 보냄
        // ascii127 ↔ backspace(^H) 토글, vt220 은 그대로 유지
        const flipBs = (m: KeySeqMode | undefined): KeySeqMode | undefined => {
          if (m === 'ascii127') return 'backspace';
          if (m === 'backspace') return 'ascii127';
          if (m === undefined) return 'backspace'; // 기본 ASCII 127 가정 → 반대는 ^H
          return m;
        };
        const flipDel = (m: KeySeqMode | undefined): KeySeqMode | undefined => {
          if (m === 'vt220') return 'ascii127';
          if (m === 'ascii127') return 'vt220';
          if (m === 'backspace') return 'vt220';
          return 'ascii127';
        };
        const seqOf = (m: KeySeqMode | undefined): string | null => {
          if (m === 'vt220') return '\x1b[3~';
          if (m === 'ascii127') return '\x7f';
          if (m === 'backspace') return '\x08';
          return null;
        };
        if ((plain || ctrlOnly) && (e.code === 'Backspace' || e.key === 'Backspace')) {
          const base = termBackspaceMode.get(termId) ?? 'ascii127'; // Xshell/PuTTY 기본
          const mode = ctrlOnly ? flipBs(base) : base;
          const s = seqOf(mode);
          if (s !== null) { send(s); return false; }
        } else if ((plain || ctrlOnly) && (e.code === 'Delete' || e.key === 'Delete')) {
          const base = termDeleteMode.get(termId) ?? 'vt220';
          const mode = ctrlOnly ? flipDel(base) : base;
          const s = seqOf(mode);
          if (s !== null) { send(s); return false; }
        }
      }
      // Alt+1..9: 미니탭 전환 (앱 전역 핸들러로 위임) — 범위이므로 커스터마이즈 대상 아님
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code)) return false;
      // 전체화면 토글 (앱 전역 핸들러)
      if (matchKeybinding(e, 'fullscreen')) return false;
      // 미니탭 전환 (앱 전역 핸들러로 위임)
      if (matchKeybinding(e, 'nextTab') || matchKeybinding(e, 'prevTab')) return false;
      if (!(e.ctrlKey || e.metaKey)) return true;
      // Ctrl+L (Shift 없이): 커서 라인 위 내용을 스크롤 버퍼로 보존하며 밀어냄
      if (!e.shiftKey && e.code === 'KeyL') {
        const buf = term.buffer.active;
        const cursorY = buf.cursorY;
        const cursorX = buf.cursorX;
        if (cursorY > 0) {
          const rows = (term as any).rows || 24;
          // 커서 라인부터 아래의 현재 화면 내용 저장
          const lines: string[] = [];
          for (let r = cursorY; r < rows; r++) {
            const line = buf.getLine(buf.baseY + r);
            lines.push(line ? line.translateToString(true) : '');
          }
          // 화면을 빈 줄로 밀어서 전체 화면을 스크롤 버퍼로
          term.write('\r\n'.repeat(rows));
          // 커서를 맨 위로 이동 + 화면 클리어
          term.write('\x1b[H\x1b[2J');
          // 저장한 내용을 다시 출력
          for (let i = 0; i < lines.length; i++) {
            if (i > 0) term.write('\r\n');
            term.write(lines[i]);
          }
          // 커서를 원래 X 위치로
          term.write(`\x1b[1;${cursorX + 1}H`);
        }
        return false;
      }
      // 찾기/클리어 관련 단축키를 터미널에서 가로채지 않고 앱으로 전달
      if (matchKeybinding(e, 'find') || matchKeybinding(e, 'clearScrollback') || matchKeybinding(e, 'clearScreen') || matchKeybinding(e, 'clearAll')) return false;
      // 세션 복제 분할 단축키도 앱으로 전달
      if (matchKeybinding(e, 'cloneSplitH') || matchKeybinding(e, 'cloneSplitV')) return false;
      // 연결된 세션 분할 단축키도 앱으로 전달
      if (matchKeybinding(e, 'splitSessionH') || matchKeybinding(e, 'splitSessionV')) return false;
      if (!e.shiftKey) return true;
      return true;
    });
    // Ctrl+마우스휠로 폰트 크기 조절
    term.onRender(() => {
      const el = (term as any).element as HTMLElement | undefined;
      if (!el || (el as any).__zoomAttached) return;
      (el as any).__zoomAttached = true;
      el.addEventListener('wheel', (e: WheelEvent) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        // Ctrl+Wheel → 폰트 크기 조절
        const curSize = termFontSizes.get(termId) ?? defaultFontSize;
        const delta = e.deltaY < 0 ? 1 : -1;
        const newSize = Math.max(8, Math.min(40, curSize + delta));
        if (newSize === curSize) return;
        termFontSizes.set(termId, newSize);
        term.options.fontSize = newSize;
        try {
          fit.fit();
          const c = (term as any).cols || 80;
          const r = (term as any).rows || 24;
          if (ptyConnected.has(termId)) {
            (window as any).api?.ptyResize?.(termId, c, r);
          } else {
            (window as any).api?.resizeSSH?.(termId, c, r);
          }
        } catch {}
        showFontSizeOSD(el, newSize);
      }, { passive: false });
      // 빈 셀 더블클릭 시 해당 줄 전체 선택
      el.addEventListener('dblclick', (e: MouseEvent) => {
        const screen = el.querySelector('.xterm-screen') as HTMLElement;
        if (!screen) return;
        const rect = screen.getBoundingClientRect();
        const cols = (term as any).cols || 80;
        const rows = (term as any).rows || 24;
        const cellW = rect.width / cols;
        const cellH = rect.height / rows;
        const col = Math.floor((e.clientX - rect.left) / cellW);
        const row = Math.floor((e.clientY - rect.top) / cellH);
        const buf = term.buffer.active;
        const vp = el.querySelector('.xterm-viewport') as HTMLElement;
        const scrollRow = vp ? Math.round(vp.scrollTop / cellH) : 0;
        const bufRow = scrollRow + row;
        const line = buf.getLine(bufRow);
        if (!line) return;
        const text = line.translateToString(true);
        if (col >= text.length && text.length > 0) {
          // 빈 영역 더블클릭 → 줄 전체 선택
          term.select(0, bufRow, text.length);
        }
      });
      // Ctrl+V / 브라우저 paste 가로채기 — 여러 줄 붙여넣기 다이얼로그
      el.addEventListener('paste', (e: ClipboardEvent) => {
        const text = e.clipboardData?.getData('text');
        if (!text) return;
        // 실제로 "여러 줄"인지 판단 — 끝에 trailing newline 만 있는 1줄짜리는 일반 paste 로 처리
        // (e.g., "ls -l;\n" 또는 "ls -l;\n\n" 은 1줄로 봄)
        const lines = text.split(/\r?\n/).filter(l => l.length > 0);
        const isMultiLine = lines.length >= 2;
        if (isMultiLine) {
          const settings = getTerminalSettings();
          if (settings.multiLinePaste === 'dialog') {
            e.preventDefault();
            e.stopPropagation();
            el.dispatchEvent(new CustomEvent('term-multi-paste', { detail: { termId, text }, bubbles: true }));
          }
        }
      }, true);
      // 우클릭 → 항상 앱 컨텍스트 메뉴 (mouse mode 여부 무관, 복사/붙여넣기 등 사용 가능)
      el.addEventListener('contextmenu', (e: MouseEvent) => {
        e.preventDefault();
        el.dispatchEvent(new CustomEvent('term-contextmenu', { detail: { x: e.clientX, y: e.clientY }, bubbles: true }));
      });
    });
    // 선택 시 자동 클립보드 복사 + selectAll 상태 유지
    term.onSelectionChange(() => {
      // selectAll 활성 상태에서 selection 이 비워지면 즉시 재선택
      if (selectAllActive.has(termId)) {
        try {
          const cur = term.getSelection();
          if (!cur || cur.length === 0) {
            _skipAutoCopyOnSelect = true;
            try { term.selectAll(); } catch {}
            setTimeout(() => { _skipAutoCopyOnSelect = false; }, 30);
            return;
          }
        } catch {}
      }
      if (_skipAutoCopyOnSelect) return;
      const settings = getTerminalSettings();
      if (!settings.autoCopyOnSelect) return;
      let sel = term.getSelection();
      if (!sel) return;
      if (settings.trimTrailingWhitespace) sel = sel.split('\n').map(l => l.trimEnd()).join('\n');
      if (!settings.includeTrailingNewline) sel = sel.replace(/\n$/, '');
      navigator.clipboard.writeText(sel).catch(() => {});
      window.dispatchEvent(new CustomEvent('status-copy', { detail: { charCount: sel.length, lineCount: sel.split('\n').length } }));
    });
    entry = { term, fit, search };
    termStore.set(termId, entry);
    // 동기적으로 즉시 패치 — DA2 query 가 빨리 와도 가로챌 수 있도록
    patchSuppressFocusEvents(term, termId);
    // 추가 안전망 — _coreService 가 늦게 초기화되는 케이스 대응
    [0, 10, 50, 200, 500].forEach(ms => setTimeout(() => patchSuppressFocusEvents(term, termId), ms));
  }
  return entry;
}

// ── 검색 헬퍼 (외부에서 사용) ──

// DOM 기반 하이라이트 오버레이
const highlightOverlays: Map<string, HTMLDivElement> = new Map();

function getHighlightContainer(termId: string): HTMLDivElement | null {
  let container = highlightOverlays.get(termId);
  if (container && container.parentElement) return container;
  const entry = termStore.get(termId);
  if (!entry) return null;
  const xtermEl = (entry.term as any).element as HTMLElement | undefined;
  if (!xtermEl) return null;
  // panel-terminal-area (xterm의 부모)에 오버레이 삽입
  const termArea = xtermEl.closest('.panel-terminal-area') as HTMLElement;
  if (!termArea) return null;
  termArea.style.position = 'relative';
  container = document.createElement('div');
  container.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none;z-index:100;overflow:hidden;';
  termArea.appendChild(container);
  highlightOverlays.set(termId, container);
  return container;
}

function renderHighlightOverlay(termId: string, query: string, regex: boolean, caseSensitive = false) {
  const container = getHighlightContainer(termId);
  if (container) container.innerHTML = '';
  if (!container || !query) return;

  const entry = termStore.get(termId);
  if (!entry) return;
  const term = entry.term;
  const buf = term.buffer.active;

  let re: RegExp;
  try {
    const flags = caseSensitive ? 'g' : 'gi';
    re = regex ? new RegExp(query, flags) : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  } catch { return; }

  // 셀 크기 계산 — xterm 내부 _core._renderService.dimensions 에서 정확한 값 추출,
  // 없으면 screen 크기 기반 fallback
  const xtermEl = (term as any).element as HTMLElement | undefined;
  if (!xtermEl) return;
  const screen = xtermEl.querySelector('.xterm-screen') as HTMLElement;
  if (!screen) return;
  const rows = (term as any).rows || 24;
  const cols = (term as any).cols || 80;

  const dims = (term as any)._core?._renderService?.dimensions;
  const cellW = dims?.css?.cell?.width || (screen.offsetWidth / cols);
  const cellH = dims?.css?.cell?.height || (screen.offsetHeight / rows);
  if (cellW <= 0 || cellH <= 0) return;

  // xterm-screen 의 실제 좌상단 오프셋 (패딩 보정)
  const containerRect = container.parentElement!.getBoundingClientRect();
  const screenRect = screen.getBoundingClientRect();
  const offsetLeft = screenRect.left - containerRect.left;
  const offsetTop = screenRect.top - containerRect.top;

  // 뷰포트 시작: scrollTop 기반
  const viewport = xtermEl.querySelector('.xterm-viewport') as HTMLElement;
  const scrollTop = viewport ? viewport.scrollTop : 0;
  const vStart = Math.max(0, Math.round(scrollTop / cellH));

  for (let row = 0; row < rows; row++) {
    const bufLine = buf.getLine(vStart + row);
    if (!bufLine) continue;
    const text = bufLine.translateToString();

    // charIndex → cellColumn 매핑 (한글 등 wide char 보정)
    const charToCell: number[] = [];
    let cellCol = 0;
    for (let ci = 0; ci < bufLine.length; ci++) {
      const cell = bufLine.getCell(ci);
      if (!cell) break;
      const ch = cell.getChars();
      if (ch === '') continue; // wide char의 두 번째 셀은 건너뜀
      charToCell.push(cellCol);
      const w = cell.getWidth();
      cellCol += w || 1;
    }

    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
      if (match[0].length === 0) { re.lastIndex++; continue; }
      const startCell = charToCell[match.index] ?? match.index;
      const endCharIdx = match.index + match[0].length;
      const endCell = endCharIdx < charToCell.length ? charToCell[endCharIdx] : (charToCell[charToCell.length - 1] ?? endCharIdx) + 1;
      const span = document.createElement('div');
      span.className = 'search-highlight-mark';
      span.style.cssText = `position:absolute;top:${offsetTop + row * cellH}px;left:${offsetLeft + startCell * cellW}px;width:${(endCell - startCell) * cellW}px;height:${cellH}px;`;
      container.appendChild(span);
    }
  }
}


export function applyThemeToAll(themeName: string) {
  currentThemeName = themeName;
  localStorage.setItem('terminalTheme', themeName);
  for (const [tid, entry] of termStore) {
    // 세션별 테마가 없는 터미널만 글로벌 테마 적용
    if (!termThemeCache.has(tid) || termThemeCache.get(tid) === currentThemeName) {
      termThemeCache.set(tid, themeName);
    }
    // 투명도가 적용된 상태면 테마+투명도 함께 반영
    const containerEl = (entry.term as any).element?.closest?.('.xterm-container') || null;
    applyTermOpacity(tid, containerEl);
  }
}

export function getCurrentThemeName(): string {
  return currentThemeName;
}

export function getWordSeparator(): string {
  return currentWordSeparator;
}

export function setWordSeparator(sep: string) {
  currentWordSeparator = sep;
  localStorage.setItem('terminalWordSeparator', sep);
  for (const [, entry] of termStore) {
    entry.term.options.wordSeparator = sep;
  }
}

export function applyScrollbackToAll(scrollback: number) {
  for (const [, entry] of termStore) {
    entry.term.options.scrollback = scrollback;
  }
}

// 특정 터미널에 스크롤백을 실시간으로 반영. 터미널이 아직 생성되지 않았다면
// 맵에 기록해 두고 getOrCreateTerm이 생성 시점에 참조하도록 한다.
const termScrollbackOverride: Map<string, number> = new Map();
export function applyScrollbackToTerm(termId: string, scrollback: number) {
  if (!scrollback) return;
  termScrollbackOverride.set(termId, scrollback);
  const entry = termStore.get(termId);
  if (entry) entry.term.options.scrollback = scrollback;
}
export function getScrollbackForTerm(termId: string): number {
  const entry = termStore.get(termId);
  return (entry?.term.options.scrollback as number) ?? termScrollbackOverride.get(termId) ?? getTerminalSettings().scrollback;
}

// 소스 터미널의 스타일(테마/폰트/불투명도/단어구분)을 대상 termId로 복사.
// 대상 터미널은 호출 이후 getOrCreateTerm/mount 시 이 값들을 적용받는다.
export function cloneTermStyle(srcTermId: string, dstTermId: string) {
  const srcEntry = termStore.get(srcTermId);
  // 테마
  const themeName = termThemeCache.get(srcTermId);
  if (themeName) termThemeCache.set(dstTermId, themeName);
  // 불투명도
  const op = termOpacity.get(srcTermId);
  if (op !== undefined) termOpacity.set(dstTermId, op);
  // 폰트 크기
  const fs = termFontSizes.get(srcTermId) ?? (srcEntry?.term.options.fontSize as number | undefined);
  if (fs !== undefined) termFontSizes.set(dstTermId, fs);
  // 스크롤백
  const sb = termScrollbackOverride.get(srcTermId) ?? (srcEntry?.term.options.scrollback as number | undefined);
  if (sb !== undefined) termScrollbackOverride.set(dstTermId, sb);
  // 커서 스타일/깜박임은 dst 가 아직 생성되기 전에도 캐시에 저장 → 새 term 의 초기 옵션에 반영
  const srcCursorStyle = termCursorStyleCache.get(srcTermId) ?? ((srcEntry?.term.options as any)?.cursorStyle as string | undefined);
  const srcCursorBlinkRaw = (srcEntry?.term.options as any)?.cursorBlink;
  const srcCursorBlink = typeof srcCursorBlinkRaw === 'boolean' ? srcCursorBlinkRaw : true;
  if (srcCursorStyle) termCursorStyleCache.set(dstTermId, srcCursorStyle);
  termCursorBlinkCache.set(dstTermId, srcCursorBlink);
  // 대상 터미널이 이미 생성되어 있으면 즉시 반영
  const dstEntry = termStore.get(dstTermId);
  if (dstEntry && srcEntry) {
    if (themeName) {
      const theme = getThemeByName(themeName) as any;
      dstEntry.term.options.theme = { ...theme };
    }
    const ff = srcEntry.term.options.fontFamily as string | undefined;
    if (ff) dstEntry.term.options.fontFamily = ff;
    if (fs !== undefined) dstEntry.term.options.fontSize = fs;
    if (sb !== undefined) dstEntry.term.options.scrollback = sb;
    // 커서 스타일/깜박임/커스텀 오버레이 복제
    const srcCs = (srcEntry.term.options as any).cursorStyle as string | undefined;
    const srcCb = (srcEntry.term.options as any).cursorBlink as boolean | undefined;
    // 소스가 커스텀 오버레이를 쓰고 있으면 dst 에도 동일 적용 (overlay 별도)
    if (flameOverlayCleanup.has(srcTermId)) {
      // 어떤 커스텀 스타일인지 알아내려면 별도 추적 필요 — termCursorStyleCache 에 저장
      const customStyle = termCursorStyleCache.get(srcTermId);
      if (customStyle) {
        applyCursorStyleToTerm(dstTermId, customStyle as any, srcCb);
      }
    } else if (srcCs) {
      applyCursorStyleToTerm(dstTermId, srcCs as any, srcCb);
    }
    try { dstEntry.fit.fit(); } catch {}
  }
}

// 커스텀 커서 스타일 추적 — cloneTermStyle 등에서 참조
const termCursorStyleCache: Map<string, string> = new Map();
// 커서 깜박임 캐시 — 복제 시 dst 터미널이 아직 마운트되지 않았어도 초기 옵션에 반영하기 위함
const termCursorBlinkCache: Map<string, boolean> = new Map();
// Backspace / Delete 키 시퀀스 — 세션별 설정. undefined = xterm 기본
export type KeySeqMode = 'vt220' | 'ascii127' | 'backspace';
const termBackspaceMode: Map<string, KeySeqMode> = new Map();
const termDeleteMode: Map<string, KeySeqMode> = new Map();
export function setTermBackspaceMode(termId: string, mode: KeySeqMode | undefined) {
  if (mode) termBackspaceMode.set(termId, mode);
  else termBackspaceMode.delete(termId);
}
export function setTermDeleteMode(termId: string, mode: KeySeqMode | undefined) {
  if (mode) termDeleteMode.set(termId, mode);
  else termDeleteMode.delete(termId);
}

export function applyFontToAll(fontFamily?: string, fontSize?: number) {
  if (fontFamily) localStorage.setItem('terminalFontFamily', fontFamily);
  if (fontSize) localStorage.setItem('terminalFontSize', String(fontSize));
  for (const [tid, entry] of termStore) {
    if (fontFamily) entry.term.options.fontFamily = fontFamily;
    if (fontSize) { entry.term.options.fontSize = fontSize; termFontSizes.set(tid, fontSize); }
    try {
      entry.fit.fit();
      const c = (entry.term as any).cols;
      const r = (entry.term as any).rows;
      if (ptyConnected.has(tid)) {
        (window as any).api?.ptyResize?.(tid, c, r);
      } else {
        (window as any).api?.resizeSSH?.(tid, c, r);
      }
    } catch {}
  }
}

// 드래그 중 PTY resize 억제 플래그 (분할 divider 드래그 동안 shell 재그리기 최소화)
let suppressPtyResize = false;
export function setSuppressPtyResize(v: boolean) { suppressPtyResize = v; }
export function isPtyResizeSuppressed() { return suppressPtyResize; }

export function refitAllTerms() {
  for (const [tid, entry] of termStore) {
    try {
      // 컨테이너가 숨겨져 있으면(0×0) refit 하지 않음 — vi 등 풀스크린 앱이 0 크기로 깨지는 문제 방지
      const el = entry.term.element as HTMLElement | undefined;
      if (el) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 4 || rect.height < 4) continue;
      }
      entry.fit.fit();
      const newCols = (entry.term as any).cols;
      const newRows = (entry.term as any).rows;
      if (!newCols || !newRows) continue;
      if (ptyConnected.has(tid)) {
        (window as any).api?.ptyResize?.(tid, newCols, newRows);
      } else {
        (window as any).api?.resizeSSH?.(tid, newCols, newRows);
      }
      // viewport scrollbar 재계산 강제 — fit 만으로는 scrollbar 가 다시 나타나지 않는 케이스 보정
      const viewport = el?.querySelector?.('.xterm-viewport') as HTMLElement | null;
      if (viewport) {
        const orig = viewport.style.overflowY;
        viewport.style.overflowY = 'hidden';
        void viewport.offsetHeight;
        viewport.style.overflowY = orig || 'auto';
        const st = viewport.scrollTop;
        viewport.scrollTop = st + 1;
        viewport.scrollTop = st;
      }
    } catch {}
  }
}

export function getGlobalFontFamily(): string {
  return localStorage.getItem('terminalFontFamily') || '';
}

export function applyFontToTerm(termId: string, fontFamily?: string, fontSize?: number) {
  const entry = termStore.get(termId);
  if (!entry) return;
  if (fontFamily) entry.term.options.fontFamily = fontFamily;
  if (fontSize) { entry.term.options.fontSize = fontSize; termFontSizes.set(termId, fontSize); }
  try { entry.fit.fit(); } catch {}
  // fit 후 변경된 cols/rows 를 원격 셸(PTY/SSH)에 SIGWINCH 로 전파 — 안 보내면
  // vi 같은 풀스크린 앱이 옛 row 수만 채워서 아래쪽이 비어 보임.
  try {
    const term: any = entry.term;
    const c = term.cols || 80;
    const r = term.rows || 24;
    if (ptyConnected.has(termId)) {
      (window as any).api?.ptyResize?.(termId, c, r);
    } else {
      (window as any).api?.resizeSSH?.(termId, c, r);
    }
  } catch {}
}

// term 별 flame 오버레이 상태 — 새 element + onCursorMove 정리용
const flameOverlayCleanup: Map<string, () => void> = new Map();

// 모든 효과 커서 — 공통 hyperpower 파티클 시스템(PARTICLE_THEMES) 으로 라우팅
type CustomCursorStyle = 'flame' | 'star' | 'heart' | 'circle' | 'rainbow' | 'power' | 'prism';

// ─── Hyperpower 스타일 파티클·흔들림 (vercel/hyperpower 참고) ─────────────────
// 매 키입력마다 테마별 파티클을 분사하고, 타이핑 강도(shake)는 누적되어 매 프레임
// 감쇠하면서 터미널 전체에 미세 진동 적용. power/heart/star/flame/rainbow/circle
// 모두 같은 시스템을 공유하고 테마(색/모양/물리)만 다르다.
type ParticleShape = 'circle' | 'emoji';
interface ParticleTheme {
  shape: ParticleShape;
  colors?: string[]; // shape=circle 면 채움색, shape=emoji 면 텍스트 글자색 (🔥처럼 색 고정 이모지엔 영향 없음)
  emojis?: string[]; // shape=emoji 때만
  sequential?: boolean; // true 면 colors 를 순서대로 사용 (rainbow 처럼) — count 가 colors.length 와 같을 때 한 번의 키 입력이 정확히 무지개 한 세트
  gravity: number;
  fade: number;
  shakeDecay: number;
  shakeMax: number;
  shakePerKey: number;
  countMin: number;
  countMax: number;
  sizeMin: number;
  sizeMax: number;
  vxRange: number; // 좌우 초기 속도 ±vxRange
  vyMin: number;   // 위로 솟는 초기 속도 (양수 — 내부에서 -vy 로 적용)
  vyMax: number;
  vxArc?: number;  // 0 이상이면 i 번째 파티클의 vx 를 -vxArc..+vxArc 로 균등 분포 → 부채꼴/아크 패턴
  // 호(arc) 위치 배치 — 정의되면 파티클을 커서 주변 반원 아크에 정렬 (rainbow 처럼).
  // angle 은 라디안. screen 좌표에서 -π=왼쪽, -π/2=위, 0=오른쪽 (위쪽 반원은 -π..0).
  arcRadiusX?: number;
  arcRadiusY?: number;
  arcAngleMin?: number;
  arcAngleMax?: number;
  // 스폰 기준점 오프셋 (cellW/cellH 의 배수). 미지정 시 cell 중앙 하단(0.5, 0.8).
  // 예: spawnYCellOffset=-0.4 → 커서 셀 위쪽 0.4 칸 지점에서 시작 (텍스트 위에 안 겹침)
  spawnXCellOffset?: number;
  spawnYCellOffset?: number;
  composite: GlobalCompositeOperation; // 'lighter' = 색 가산(네온 글로우), 'source-over' = 일반
}
const PARTICLE_THEMES: Record<string, ParticleTheme> = {
  power: {
    // 작고 빠른 스파크 — 무거운 중력으로 빨리 떨어지고 격렬한 흔들림 ("punching")
    shape: 'circle',
    colors: ['#ff00ff', '#ff0099', '#ff3300', '#ff9900', '#ffff00', '#00ff66', '#00ccff', '#ffffff'],
    gravity: 0.2, fade: 0.9, shakeDecay: 0.86, shakeMax: 14, shakePerKey: 2.4,
    countMin: 8, countMax: 18, sizeMin: 1.5, sizeMax: 3.5,
    vxRange: 3, vyMin: 2, vyMax: 7, composite: 'lighter',
  },
  heart: {
    shape: 'emoji', emojis: ['♥', '❤'],
    colors: ['#ff3366', '#ff6699', '#ff0066', '#ff99cc', '#ff80ab', '#ffffff'],
    gravity: 0.04, fade: 0.96, shakeDecay: 1, shakeMax: 0, shakePerKey: 0,
    countMin: 3, countMax: 7, sizeMin: 12, sizeMax: 22,
    vxRange: 1.4, vyMin: 0.7, vyMax: 2.8, composite: 'source-over',
  },
  star: {
    shape: 'emoji', emojis: ['✦', '★', '✧', '⋆'],
    colors: ['#ffd700', '#ffeb3b', '#ffaa00', '#ffffff', '#fff9c4'],
    gravity: 0.06, fade: 0.95, shakeDecay: 1, shakeMax: 0, shakePerKey: 0,
    countMin: 4, countMax: 9, sizeMin: 10, sizeMax: 18,
    vxRange: 1.8, vyMin: 1, vyMax: 3.5, composite: 'source-over',
  },
  flame: {
    shape: 'emoji', emojis: ['🔥'],
    gravity: -0.04, fade: 0.94, shakeDecay: 1, shakeMax: 0, shakePerKey: 0,
    countMin: 4, countMax: 9, sizeMin: 14, sizeMax: 22,
    vxRange: 1.4, vyMin: 1.5, vyMax: 4, composite: 'source-over',
  },
  rainbow: {
    // 🌈 이모지가 커서 중앙에서 시작해 위로 솟아오르며 페이드아웃 (flame 의 무지개 버전).
    shape: 'emoji', emojis: ['🌈'],
    gravity: -0.03, fade: 0.94, shakeDecay: 1, shakeMax: 0, shakePerKey: 0,
    countMin: 3, countMax: 6, sizeMin: 14, sizeMax: 20,
    vxRange: 1.3, vyMin: 1.5, vyMax: 3.8, composite: 'source-over',
  },
  circle: {
    shape: 'circle',
    colors: ['#4fc3f7', '#81d4fa', '#b3e5fc', '#29b6f6', '#0288d1', '#ffffff'],
    gravity: 0.05, fade: 0.96, shakeDecay: 1, shakeMax: 0, shakePerKey: 0,
    countMin: 3, countMax: 7, sizeMin: 4, sizeMax: 10,
    vxRange: 1.3, vyMin: 0.6, vyMax: 2.5, composite: 'lighter',
  },
};
interface Particle { x: number; y: number; vx: number; vy: number; color: string; emoji?: string; alpha: number; size: number; }

function setupParticleMode(term: any, elem: HTMLElement, theme: ParticleTheme): () => void {
  const screen = elem.querySelector('.xterm-screen') as HTMLElement | null;
  const host = (screen && screen.parentElement) || elem;
  // 파티클은 canvas 로 그려 perf 확보 (DOM 노드 폭증 회피)
  const canvas = document.createElement('canvas');
  canvas.className = 'xterm-power-canvas';
  canvas.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:6;';
  host.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) { try { canvas.remove(); } catch {} return () => {}; }
  const resize = () => {
    const rect = host.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    canvas.width = Math.floor(rect.width);
    canvas.height = Math.floor(rect.height);
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
  };
  resize();
  const ro = (typeof ResizeObserver !== 'undefined') ? new ResizeObserver(resize) : null;
  ro?.observe(host);
  // 흔들림 적용 대상 — xterm-screen 의 부모 (커서/뷰포트 함께 흔들림)
  const shakeTarget = host;
  const particles: Particle[] = [];
  let shake = 0;
  let rafId = 0;
  let alive = true;
  const loop = () => {
    if (!alive) return;
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = theme.composite;
    if (theme.shape === 'emoji') {
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
    }
    let writeIdx = 0;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += theme.gravity;
      p.alpha *= theme.fade;
      if (p.alpha < 0.05 || p.y > h + 30 || p.y < -30) continue;
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = p.color;
      if (theme.shape === 'circle') {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.emoji) {
        ctx.font = `${p.size}px sans-serif`;
        ctx.fillText(p.emoji, p.x, p.y);
      }
      particles[writeIdx++] = p;
    }
    particles.length = writeIdx;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    // shake step — 강도 누적/감쇠 (hyperpower 시그니처)
    shake *= theme.shakeDecay;
    if (shake > 0.15) {
      const sx = (Math.random() - 0.5) * shake;
      const sy = (Math.random() - 0.5) * shake;
      shakeTarget.style.transform = `translate(${sx}px, ${sy}px)`;
    } else {
      shake = 0;
      shakeTarget.style.transform = '';
    }
    if (particles.length > 0 || shake > 0) rafId = requestAnimationFrame(loop);
    else rafId = 0;
  };
  const spawn = (x: number, y: number) => {
    const n = theme.countMin + Math.floor(Math.random() * (theme.countMax - theme.countMin + 1));
    const colors = theme.colors && theme.colors.length ? theme.colors : ['#ffffff'];
    const emojis = theme.emojis;
    // arc 위치 배치 활성화 여부 (rainbow 처럼 정확한 호 형태로 배치할 때 사용)
    const useArcPos = typeof theme.arcRadiusX === 'number' && typeof theme.arcAngleMin === 'number' && typeof theme.arcAngleMax === 'number';
    for (let i = 0; i < n; i++) {
      // 색: sequential 이면 인덱스 순환 (무지개 순서 보장), 아니면 랜덤
      const color = theme.sequential ? colors[i % colors.length] : colors[Math.floor(Math.random() * colors.length)];
      let px = x, py = y;
      let vx: number;
      if (useArcPos) {
        // 위치를 호 위에 정렬 — i 가 angle 을 균등 분할
        const t = n > 1 ? i / (n - 1) : 0.5;
        const angle = theme.arcAngleMin! + (theme.arcAngleMax! - theme.arcAngleMin!) * t;
        const rx = theme.arcRadiusX!;
        const ry = theme.arcRadiusY ?? rx;
        px = x + rx * Math.cos(angle);
        py = y + ry * Math.sin(angle);
        vx = 0;
      } else {
        // 좌우 속도: vxArc 가 있으면 i 를 -vxArc..+vxArc 로 균등 분포 (부채꼴 아크), 아니면 ±vxRange 랜덤
        vx = (typeof theme.vxArc === 'number' && n > 1)
          ? (theme.vxArc * (2 * i / (n - 1) - 1))
          : (Math.random() - 0.5) * 2 * theme.vxRange;
      }
      particles.push({
        x: px, y: py,
        vx,
        vy: -(theme.vyMin + Math.random() * (theme.vyMax - theme.vyMin)),
        color,
        emoji: emojis ? emojis[Math.floor(Math.random() * emojis.length)] : undefined,
        alpha: 1,
        size: theme.sizeMin + Math.random() * (theme.sizeMax - theme.sizeMin),
      });
    }
    shake = Math.min(theme.shakeMax, shake + theme.shakePerKey);
    if (!rafId) rafId = requestAnimationFrame(loop);
  };
  const offData = term.onData((data: string) => {
    if (!data) return;
    // 입력 적용 이후의 커서 위치 기준으로 파티클 발생 (다음 microtask)
    setTimeout(() => {
      try {
        const renderService = term._core?._renderService;
        const cellW = renderService?.dimensions?.css?.cell?.width ?? 9;
        const cellH = renderService?.dimensions?.css?.cell?.height ?? 17;
        const buf = term.buffer.active;
        const xOff = theme.spawnXCellOffset ?? 0.5;
        // 커서 셀 정중앙에서 시작 (테마가 spawnYCellOffset 지정 시 그 값 우선)
        const yOff = theme.spawnYCellOffset ?? 0.5;
        const x = buf.cursorX * cellW + cellW * xOff;
        const y = buf.cursorY * cellH + cellH * yOff;
        spawn(x, y);
      } catch {}
    }, 0);
  });
  return () => {
    alive = false;
    if (rafId) cancelAnimationFrame(rafId);
    try { offData.dispose(); } catch {}
    try { ro?.disconnect(); } catch {}
    try { canvas.remove(); } catch {}
    try { shakeTarget.style.transform = ''; } catch {}
  };
}

// (구) DOM 기반 spawnHeart/Star/Rainbow/FlameSpread + buildCursorOverlayCss 는
// 모두 PARTICLE_THEMES + setupParticleMode 로 통합됨 — 이전 구현 제거.

export function applyCursorStyleToTerm(termId: string, style?: 'block' | 'underline' | 'bar' | CustomCursorStyle, blink?: boolean) {
  const entry = termStore.get(termId);
  if (!entry) return;
  if (style) termCursorStyleCache.set(termId, style);
  // 기존 커스텀 오버레이 정리
  const prev = flameOverlayCleanup.get(termId);
  if (prev) { try { prev(); } catch {} flameOverlayCleanup.delete(termId); }
  try {
    if (style && PARTICLE_THEMES[style]) {
      // Hyperpower 스타일 — 네이티브 block 커서 + 테마별 canvas 파티클 + 누적 흔들림
      const term: any = entry.term;
      try { term.options.cursorStyle = 'block'; } catch {}
      try { term.options.cursorBlink = !!blink; } catch {}
      const elem = term.element as HTMLElement | undefined;
      if (!elem) return;
      flameOverlayCleanup.set(termId, setupParticleMode(term, elem, PARTICLE_THEMES[style]));
      return;
    } else if (style === 'prism') {
      // 네이티브 xterm block 커서를 그대로 사용 (글자 자동 반전 표시) + cursor 색만
      // 무지개로 부드럽게 순환 → 시각적으로 "커서가 글자 뒤"에 있는 것처럼 동작.
      const term: any = entry.term;
      try { term.options.cursorStyle = 'block'; } catch {}
      try { term.options.cursorBlink = false; } catch {}
      // 두 색 사이를 선형 보간해 부드러운 그라데이션 순환 (단순 색 점프 대신)
      const lerpHex = (a: string, b: string, t: number): string => {
        const ah = parseInt(a.slice(1), 16), bh = parseInt(b.slice(1), 16);
        const ar = (ah >> 16) & 0xff, ag = (ah >> 8) & 0xff, ab = ah & 0xff;
        const br = (bh >> 16) & 0xff, bg = (bh >> 8) & 0xff, bb = bh & 0xff;
        const r = Math.round(ar + (br - ar) * t);
        const g = Math.round(ag + (bg - ag) * t);
        const bl = Math.round(ab + (bb - ab) * t);
        return '#' + ((r << 16) | (g << 8) | bl).toString(16).padStart(6, '0');
      };
      const colors = ['#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ccff', '#3366ff', '#cc00ff'];
      const origTheme = { ...(term.options.theme || {}) };
      let phase = 0;
      const tick = () => {
        phase = (phase + 0.015) % 1;
        const f = phase * colors.length;
        const idx = Math.floor(f);
        const next = (idx + 1) % colors.length;
        const localT = f - idx;
        const color = lerpHex(colors[idx], colors[next], localT);
        try { term.options.theme = { ...origTheme, cursor: color, cursorAccent: origTheme.background || '#000000' }; } catch {}
      };
      tick();
      const intervalId = window.setInterval(tick, 25);
      flameOverlayCleanup.set(termId, () => {
        try { window.clearInterval(intervalId); } catch {}
        try { term.options.theme = origTheme; } catch {}
      });
      return;
    } else if (style === 'bar' && blink) {
      // 네이티브 bar 렌더는 유지 (셀 텍스트 보존). xterm 자체 blink 가 시각적으로 안 보이는 경우가 있어
      // .xterm-bar-blink-css 클래스를 터미널 root 에 부여 → CSS keyframe 으로 cursor element 만 깜박이게 함.
      const term: any = entry.term;
      try { term.options.cursorStyle = 'bar'; } catch {}
      try { term.options.cursorBlink = false; } catch {} // xterm 자체 blink 비활성 → CSS 가 단독으로 깜박임 제어
      const elem = term.element as HTMLElement | undefined;
      if (elem) elem.classList.add('xterm-bar-blink-css');
      try { term.refresh?.(0, term.rows - 1); } catch {}
      flameOverlayCleanup.set(termId, () => {
        try { elem?.classList.remove('xterm-bar-blink-css'); } catch {}
      });
    } else if (style) {
      const term: any = entry.term;
      // 깜박임 재시작을 위해 false 로 강제 후 다음 tick 에 원하는 값 적용
      try { term.options.cursorBlink = false; } catch {}
      try { term.options.cursorStyle = style; } catch {}
      try { term.refresh?.(0, term.rows - 1); } catch {}
      if (blink) {
        setTimeout(() => {
          try { term.options.cursorBlink = true; } catch {}
          try { term.refresh?.(0, term.rows - 1); } catch {}
          try {
            const ta = term.textarea as HTMLTextAreaElement | undefined;
            if (ta && document.activeElement !== ta) ta.focus({ preventScroll: true });
          } catch {}
        }, 30);
      }
    } else if (typeof blink === 'boolean') {
      const term: any = entry.term;
      try { term.options.cursorBlink = false; } catch {}
      try { term.refresh?.(0, term.rows - 1); } catch {}
      if (blink) {
        setTimeout(() => {
          try { term.options.cursorBlink = true; } catch {}
          try { term.refresh?.(0, term.rows - 1); } catch {}
          try {
            const ta = term.textarea as HTMLTextAreaElement | undefined;
            if (ta && document.activeElement !== ta) ta.focus({ preventScroll: true });
          } catch {}
        }, 30);
      }
    }
  } catch {}
}

export function applyThemeToTerm(termId: string, themeName: string) {
  const entry = termStore.get(termId);
  if (!entry) return;
  termThemeCache.set(termId, themeName);
  // 투명도가 적용된 상태면 테마+투명도 함께 반영
  const containerEl = (entry.term as any).element?.closest?.('.xterm-container') || null;
  applyTermOpacity(termId, containerEl);
}

export function clearHighlights(termId: string) {
  const container = highlightOverlays.get(termId);
  if (container) container.innerHTML = '';
  const cleanup = highlightListeners.get(termId);
  if (cleanup) { cleanup(); highlightListeners.delete(termId); }
}

// 활성 하이라이트 리스너 저장 (termId → cleanup 함수)
const highlightListeners: Map<string, () => void> = new Map();

export function highlightAllMatches(termId: string, query: string, regex: boolean, caseSensitive = false) {
  // 기존 리스너 정리
  const prevCleanup = highlightListeners.get(termId);
  if (prevCleanup) prevCleanup();

  renderHighlightOverlay(termId, query, regex, caseSensitive);

  const entry = termStore.get(termId);
  if (!entry) return;

  const handler = () => renderHighlightOverlay(termId, query, regex, caseSensitive);

  // 스크롤 시 갱신
  const xtermEl = (entry.term as any).element as HTMLElement | undefined;
  const viewport = xtermEl?.querySelector('.xterm-viewport');
  if (viewport) viewport.addEventListener('scroll', handler);

  // 새 데이터 수신 시 갱신 (debounce)
  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  const onRenderDisp = entry.term.onRender(() => {
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(handler, 100);
  });

  // cleanup 함수 저장
  highlightListeners.set(termId, () => {
    if (viewport) viewport.removeEventListener('scroll', handler);
    onRenderDisp.dispose();
    if (renderTimer) clearTimeout(renderTimer);
  });
}

export function searchFromTop(termId: string, query: string, regex = false, caseSensitive = false): boolean {
  try {
    const entry = termStore.get(termId);
    if (!entry || !query) return false;
    entry.search.clearDecorations();
    // 선택 해제 → findNext가 버퍼 맨 위부터 검색
    entry.term.clearSelection();
    entry.term.scrollToTop();
    return entry.search.findNext(query, { regex, caseSensitive });
  } catch { return false; }
}

export function searchInTerm(termId: string, query: string, regex = false, caseSensitive = false): boolean {
  try {
    const entry = termStore.get(termId);
    if (!entry || !query) return false;
    entry.search.clearDecorations();
    return entry.search.findNext(query, { regex, caseSensitive });
  } catch { return false; }
}

export function searchNextInTerm(termId: string, query: string, regex = false, caseSensitive = false): boolean {
  try {
    const entry = termStore.get(termId);
    if (!entry || !query) return false;
    return entry.search.findNext(query, { regex, caseSensitive });
  } catch { return false; }
}

export function searchPrevInTerm(termId: string, query: string, regex = false, caseSensitive = false): boolean {
  try {
    const entry = termStore.get(termId);
    if (!entry || !query) return false;
    return entry.search.findPrevious(query, { regex, caseSensitive });
  } catch { return false; }
}

export function clearSearchInTerm(termId: string) {
  try {
    clearHighlights(termId);
    const entry = termStore.get(termId);
    if (entry) entry.search.clearDecorations();
  } catch {}
}

export function getAllTermIds(): string[] {
  return [...termStore.keys()];
}

// Ctrl+Shift+B: 현재 보이는 화면은 유지, 안 보이는 스크롤 버퍼만 삭제
export function clearScrollbackInTerm(termId: string) {
  try {
    const entry = termStore.get(termId);
    if (!entry) return;
    const term = entry.term;
    const savedScrollback = term.options.scrollback;
    term.options.scrollback = 0;
    term.options.scrollback = savedScrollback;
  } catch {}
}

// Ctrl+Shift+L: 현재 화면만 지우기 (스크롤 버퍼는 유지 — 빈 줄로 밀어냄)
export function clearScreenInTerm(termId: string) {
  try {
    const entry = termStore.get(termId);
    if (!entry) return;
    const term = entry.term;
    const rows = (term as any).rows || 24;
    term.write('\r\n'.repeat(rows));
    term.write('\x1b[H');
  } catch {}
}

// Ctrl+Shift+A: 현재 화면 + 스크롤 버퍼 모두 지우기
export function clearAllInTerm(termId: string) {
  try {
    const entry = termStore.get(termId);
    if (!entry) return;
    entry.term.clear();
  } catch {}
}

// 활성 비밀번호 프롬프트 추적 (중복 방지)
const activePasswordPrompt: Map<string, { dispose: () => void }> = new Map();

/** 비밀번호 미저장 세션: 터미널에서 비밀번호 입력 후 연결 */
// 비밀번호가 처음 입력된 termId → 입력값 매핑. 접속 성공 시 "비밀번호 저장할까요?"
// 묻기 위해 사용. 접속 실패 / 끊김 / disposeTerm 시 정리.
const freshlyEnteredPassword = new Map<string, { sessionId: string; password: string }>();
export function promptPasswordAndConnect(termId: string, sessionId: string, cols?: number, rows?: number) {
  // 이미 프롬프트가 활성화 중이면 스킵
  if (activePasswordPrompt.has(termId)) return;
  const rec = termStore.get(termId);
  if (!rec) return;
  const { term } = rec;
  const c = cols ?? (term as any).cols ?? 80;
  const r = rows ?? (term as any).rows ?? 24;
  // 세션 정보로부터 표시용 호스트/유저 가져옴 (있으면 모달에 표시)
  let hostHint = '';
  let userHint = '';
  try {
    const info = termSessionMap.get(termId);
    if (info?.host) hostHint = info.host;
  } catch {}
  // 모달이 종료되면 disposable 도 해제 — 토큰 객체에 cancel 콜백 저장
  let resolved = false;
  const resolve = (password: string | null) => {
    if (resolved) return;
    resolved = true;
    activePasswordPrompt.delete(termId);
    if (password === null) {
      // 취소 — 그냥 정리만
      try { term.write(`\r\n\x1b[90m${tt('output.connectionCancel')}\x1b[0m\r\n`); } catch {}
      sshConnecting.delete(termId);
      try { window.dispatchEvent(new Event('term-connect-changed')); } catch {}
      return;
    }
    termPasswordCache.set(termId, password);
    if (sessionId) freshlyEnteredPassword.set(termId, { sessionId, password });
    sshConnecting.add(termId);
    window.api?.connectSSHWithPassword?.(termId, sessionId, password, c, r);
  };
  activePasswordPrompt.set(termId, { dispose: () => resolve(null) });
  try {
    window.dispatchEvent(new CustomEvent('ssh-password-prompt', {
      detail: { termId, sessionId, hostHint, userHint, resolve },
    }));
  } catch {
    resolve(null);
  }
}

// ── SSH 이벤트 단일 dispatcher (termId 별 listener 누적으로 인한 MaxListenersExceeded 방지) ──
const sshConnectedHandlers = new Map<string, (p: any) => void>();
const sshDataHandlers = new Map<string, (p: any) => void>();
const sshClosedHandlers = new Map<string, (p: any) => void>();
const sshErrorHandlers = new Map<string, (p: any) => void>();
const sshAuthPromptHandlers = new Map<string, (p: any) => void>();
let sshDispatchersInstalled = false;
function installGlobalSshDispatchers() {
  if (sshDispatchersInstalled) return;
  sshDispatchersInstalled = true;
  window.api?.onSSHConnected?.((p: any) => { try { sshConnectedHandlers.get(p?.panelId)?.(p); } catch {} });
  window.api?.onSSHData?.((p: any) => { try { sshDataHandlers.get(p?.panelId)?.(p); } catch {} });
  window.api?.onSSHClosed?.((p: any) => { try { sshClosedHandlers.get(p?.panelId)?.(p); } catch {} });
  window.api?.onSSHError?.((p: any) => { try { sshErrorHandlers.get(p?.panelId)?.(p); } catch {} });
  window.api?.onSSHAuthPrompt?.((p: any) => { try { sshAuthPromptHandlers.get(p?.panelId)?.(p); } catch {} });
}
/** 외부에서 termId 가 제거될 때 호출 — handler map 에서 제거해 메모리 누수 방지 */
export function disposeSSHHandlers(termId: string) {
  sshConnectedHandlers.delete(termId);
  sshDataHandlers.delete(termId);
  sshClosedHandlers.delete(termId);
  sshErrorHandlers.delete(termId);
  sshAuthPromptHandlers.delete(termId);
  sshInitialized.delete(termId);
  quickConnectPlaceholderShown.delete(termId);
}

/** termId별로 SSH 리스너를 한 번만 설정 (컴포넌트 lifecycle 밖) */
function ensureSSHSetup(termId: string) {
  if (sshInitialized.has(termId)) return;
  sshInitialized.add(termId);
  installGlobalSshDispatchers();

  const { term, fit } = getOrCreateTerm(termId);

  sshConnectedHandlers.set(termId, () => {
    quickConnectPending.delete(termId);
    quickConnectPlaceholderShown.delete(termId);
    // 새로 입력한 비밀번호로 접속 성공 → App 레벨 커스텀 모달에 저장 여부 묻기.
    // (native confirm 은 Electron BrowserWindow 포커스를 망가뜨림. 인앱 모달이면 안전.)
    const fresh = freshlyEnteredPassword.get(termId);
    if (fresh) {
      freshlyEnteredPassword.delete(termId);
      try {
        window.dispatchEvent(new CustomEvent('ssh-fresh-password-success', {
          detail: { termId, sessionId: fresh.sessionId, password: fresh.password },
        }));
      } catch {}
    }
    // 같은 termId에 PTY가 실행 중이면 종료 (Local Shell → SSH 전환).
    // pty:exit 핸들러가 "셸이 종료되었습니다." 메시지를 쓰는 걸 막기 위해 suppress 플래그 설정.
    if (ptyConnected.has(termId)) {
      ptyExitSuppressed.add(termId);
      window.api?.ptyKill?.(termId);
      ptyConnected.delete(termId);
      ptyInitialized.delete(termId);
      try { term.clear(); } catch {}
    }
    if (reconnectState.has(termId)) {
      console.warn('[ssh] connected event during active reconnect countdown', { termId, sshConnecting: sshConnecting.has(termId) });
    }
    // 녹화 중이고 이전에도 연결됐던 termId 면 reconnect 마커 — 로그 가독성 향상
    if (recordingState.has(termId) && termSessionMap.has(termId)) {
      recordMark(termId, `reconnected at ${new Date().toLocaleString()}`);
    }
    globalConnected.add(termId);
    cancelReconnect(termId);
    clearInitialConnectWatchdog(termId);
    reconnectUserCancelled.delete(termId);
    notifyConnectedChange();
    // 연결 직후 fit — 초기 1회는 force=true 로 dedup 우회 (PTY 초기 사이즈가
    // 기본 80x24 로 잡힌 케이스 보정. 이전 [r artifact 는 FitAddon 패치로 별도 차단됨)
    setTimeout(() => {
      try { fit.fit(); } catch {}
      try {
        const c = (term as any).cols, r = (term as any).rows;
        if (c >= 10 && r >= 5) window.api?.resizeSSH?.(termId, c, r, true);
      } catch {}
    }, 300);
  });

  sshDataHandlers.set(termId, (p: any) => {
    try {
      // 사용자가 스크롤 위로 올렸을 때 새 출력으로 scrollback 증가하면서 viewport 가 따라 움직이지
      // 않도록 ydisp 를 안정화. write 전후로 끝에서부터의 라인 offset 을 보존.
      const core = (term as any)._core;
      const buf = core?.buffer;
      const wasScrolledUp = buf && buf.ydisp < buf.ybase;
      const offsetFromEnd = wasScrolledUp ? (buf.lines.length - buf.ydisp) : -1;
      term.write(p.data);
      if (wasScrolledUp && offsetFromEnd > 0) {
        try {
          const buf2 = core?.buffer;
          if (buf2 && buf2.lines) {
            const newYdisp = Math.max(0, Math.min(buf2.ybase, buf2.lines.length - offsetFromEnd));
            if (buf2.ydisp !== newYdisp) {
              buf2.ydisp = newYdisp;
              const vp = (term as any).element?.querySelector?.('.xterm-viewport') as HTMLElement | null;
              if (vp) {
                const cellH = core?._renderService?.dimensions?.css?.cell?.height || 17;
                vp.scrollTop = newYdisp * cellH;
              }
              try { core?._onScroll?.fire?.(newYdisp); } catch {}
              try { core?._renderService?.refreshRows?.(0, (term as any).rows - 1); } catch {}
            }
          }
        } catch {}
      }
    } catch {}
  });

  sshClosedHandlers.set(termId, () => {
    // 이미 종료 처리 완료된 경우 (연결 상태 아닌데 close 중복) 무시
    if (!globalConnected.has(termId) && !sshConnecting.has(termId)) return;
    globalConnected.delete(termId);
    sshConnecting.delete(termId);
    notifyConnectedChange();
    if (recordingState.has(termId)) {
      recordMark(termId, `disconnected at ${new Date().toLocaleString()}`);
    }
    try { term.write(`\r\n\x1b[90m${tt('output.connectionClosed')}\x1b[0m\r\n`); } catch {}
    // 세션이 등록되어 있으면 재연결 카운트다운 시작
    if (termSessionMap.has(termId)) {
      startReconnectCountdown(termId);
    }
  });

  // SSH 에러를 터미널에 표시
  sshErrorHandlers.set(termId, (p: any) => {
    quickConnectPending.delete(termId);
    // 잘못된 비밀번호로 실패 — 저장 권유 안 함
    freshlyEnteredPassword.delete(termId);
    sshConnecting.delete(termId);
    globalConnected.delete(termId);
    notifyConnectedChange();
    const errMsg = String(p.error || '');
    // 인증 실패 (캐시된/방금 입력한 비밀번호가 틀림) — 자동 재시도 대신 비밀번호 다시 묻기
    const isAuthFailure = /authentication\s+methods\s+failed|all\s+configured\s+authentication|permission\s+denied/i.test(errMsg);
    if (isAuthFailure) {
      // 잘못된 비밀번호 캐시 제거 → 재프롬프트
      termPasswordCache.delete(termId);
      // watchdog 도 중단 (자동 재시도 사이클 멈춤)
      try { clearInitialConnectWatchdog(termId); } catch {}
      try { term.write(`\r\n\x1b[91m${tt('output.authFailed')}\x1b[0m\r\n`); } catch {}
      const info = termSessionMap.get(termId);
      if (info?.sessionId) {
        // 저장 세션 — 약간 늦춰서 비밀번호 입력 모달 다시 띄움 (SSH disconnect cleanup 시간 확보)
        setTimeout(() => {
          const entry = termStore.get(termId);
          const cols = entry ? (entry.term as any).cols : 80;
          const rows = entry ? (entry.term as any).rows : 24;
          promptPasswordAndConnect(termId, info.sessionId, cols, rows);
        }, 200);
      } else if (info?.quickSession) {
        // 빠른연결 — 인증 실패 후엔 즉시 모달 재표시 (id/pwd 둘 다, 이전 username 은 hint 로 pre-fill)
        setTimeout(() => {
          const prevUsername = info.quickSession.username || '';
          const tryQuickConnect = (sessInfo: any): void => {
            quickConnectPending.add(termId);
            (window as any).api?.quickConnectSSH?.(termId, sessInfo).then((r: string) => {
              if (r === 'need-credentials' || r === 'need-password') {
                const needUsername = r === 'need-credentials';
                window.dispatchEvent(new CustomEvent('ssh-password-prompt', {
                  detail: {
                    termId,
                    sessionId: '',
                    hostHint: sessInfo.host,
                    userHint: sessInfo.username || prevUsername,
                    needUsername,
                    resolve: (result: any) => {
                      if (result === null) {
                        quickConnectPending.delete(termId);
                        try {
                          term.write(`\r\n\x1b[90m${tt('output.connectionCancelled')}\x1b[0m\r\n`);
                          term.write('\x1b[33m▶ 다시 시도하려면: 터미널 클릭 또는 미니탭 우클릭 → 재연결\x1b[0m\r\n');
                        } catch {}
                        // 터미널 영역 클릭 1회 → 자격증명 모달 재오픈
                        setTimeout(() => {
                          const entry = termStore.get(termId);
                          const el = (entry?.term as any)?.element as HTMLElement | undefined;
                          if (!el) return;
                          const onceClick = (ev: MouseEvent) => {
                            ev.stopPropagation();
                            el.removeEventListener('mousedown', onceClick, true);
                            tryQuickConnect(sessInfo);
                          };
                          el.addEventListener('mousedown', onceClick, true);
                        }, 100);
                        return;
                      }
                      let nextUsername = sessInfo.username || prevUsername;
                      let nextPassword = '';
                      if (typeof result === 'string') nextPassword = result;
                      else if (result && typeof result === 'object') {
                        nextUsername = result.username || sessInfo.username || prevUsername;
                        nextPassword = result.password || '';
                      }
                      const next = {
                        ...sessInfo,
                        username: nextUsername,
                        name: nextUsername ? `${nextUsername}@${sessInfo.host}` : sessInfo.host,
                        auth: { type: 'password', password: nextPassword },
                      };
                      tryQuickConnect(next);
                    },
                  },
                }));
              }
            }).catch(() => {});
          };
          // 인증 실패 후엔 id+pwd 모두 다시 받기 — username 비워서 'need-credentials' 강제 진입.
          // userHint 는 위 dispatch 에서 prevUsername 으로 채움.
          const cleared = { ...info.quickSession, username: '', auth: { type: 'password', password: '' } };
          registerTermSession(termId, '', info.sessionName || info.host || '', info.host || '', cleared);
          tryQuickConnect(cleared);
        }, 200);
      }
      return;
    }
    // 그 외 일시적 오류는 watchdog 재시도
    const ok = tryInitialReconnect(termId);
    if (!ok) {
      try { term.write(`\r\n\x1b[91m${tt('output.sshError', { error: p.error || 'Unknown error' })}\x1b[0m\r\n`); } catch {}
    }
  });

  // 비밀번호 미저장 세션: keyboard-interactive 인증 프롬프트
  sshAuthPromptHandlers.set(termId, (p: any) => {
    const promptText = p.prompts?.[0] || 'Password:';
    // prompt() 대신 터미널에 비밀번호 입력 UI
    try {
      term.write(`\r\n\x1b[93m${promptText}\x1b[0m `);
    } catch {}
    let pwBuf = '';
    const disposable = term.onData((data: string) => {
      if (data === '\r' || data === '\n') {
        disposable.dispose();
        term.write('\r\n');
        window.api?.sshAuthResponse?.(termId, [pwBuf]);
      } else if (data === '\x7f' || data === '\b') {
        if (pwBuf.length > 0) { pwBuf = pwBuf.slice(0, -1); term.write('\b \b'); }
      } else if (data === '\x03') {
        // Ctrl+C → 취소
        disposable.dispose();
        term.write(`\r\n\x1b[90m${tt('output.authCancel')}\x1b[0m\r\n`);
        window.api?.disconnectSSH?.(termId);
      } else {
        pwBuf += data;
        term.write('*');
      }
    });
  });
}

// ── 로컬 셸 (PTY) ──
const ptyInitialized = new Set<string>();
const ptyConnected = new Set<string>();
// ConPTY 는 SIGWINCH 직후 전체화면 repaint 를 보냄 — resize 후 일정 시간 해당 패턴을 drop 해서 커서 깨짐 방지
const ptyDropRepaintUntil = new Map<string, number>();
const ptyResizeTimers = new Map<string, ReturnType<typeof setTimeout>>();
const PTY_RESIZE_DEBOUNCE_MS = 1500;  // resize 이벤트 debounce (ms)
const PTY_DROP_WINDOW_MS = 8000;       // ConPTY repaint drop 유지 시간 (ms) — maximize→restore round-trip 까지 cover
function schedulePtyResize(termId: string, cols: number, rows: number) {
  // drop window 를 호출 즉시 활성화 — debounce 기간 동안 PSReadLine 이 보내는 repaint 도 차단되도록.
  // 이후 ptyResize 가 실제로 전송되고 ConPTY 가 SIGWINCH-기반 repaint 를 보내는 시점까지 모두 cover.
  const totalWindow = PTY_RESIZE_DEBOUNCE_MS + PTY_DROP_WINDOW_MS;
  ptyDropRepaintUntil.set(termId, Date.now() + totalWindow);
  console.log('[SCHED-RESIZE] tid=' + termId + ' set drop window until=' + (Date.now() + totalWindow) + ' (cols=' + cols + ' rows=' + rows + ')');
  const prev = ptyResizeTimers.get(termId);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    ptyResizeTimers.delete(termId);
    (window as any).api?.ptyResize?.(termId, cols, rows);
    // 실제 PTY resize 전송 시점부터 다시 3s 연장 — ConPTY repaint 도 cover
    ptyDropRepaintUntil.set(termId, Date.now() + PTY_DROP_WINDOW_MS);
    console.log('[SCHED-RESIZE] ptyResize sent. drop window extended');
  }, PTY_RESIZE_DEBOUNCE_MS);
  ptyResizeTimers.set(termId, t);
}
// SSH 가 PTY 를 takeover 할 때 pty:exit 의 "셸이 종료되었습니다" 메시지를 1회 억제하기 위한 플래그
const ptyExitSuppressed = new Set<string>();
const ptyDataHandlers = new Map<string, (p: any) => void>();
const ptyExitHandlers = new Map<string, (p: any) => void>();
let ptyDispatchersInstalled = false;
function installGlobalPtyDispatchers() {
  if (ptyDispatchersInstalled) return;
  ptyDispatchersInstalled = true;
  window.api?.onPtyData?.((p: any) => { try { ptyDataHandlers.get(p?.panelId)?.(p); } catch {} });
  window.api?.onPtyExit?.((p: any) => { try { ptyExitHandlers.get(p?.panelId)?.(p); } catch {} });
}
export function disposePtyHandlers(termId: string) {
  ptyDataHandlers.delete(termId);
  ptyExitHandlers.delete(termId);
  ptyInitialized.delete(termId);
  ptyExitSuppressed.delete(termId);
}

function ensurePtySetup(termId: string) {
  if (ptyInitialized.has(termId)) return;
  ptyInitialized.add(termId);
  installGlobalPtyDispatchers();

  const { term } = getOrCreateTerm(termId);

  ptyDataHandlers.set(termId, (p: any) => {
    try {
      const data: string = p.data;
      // 디버그: 데이터 들어올 때마다 head 와 buf 상태 로그
      const head = data.slice(0, 40).replace(/\x1b/g, '<ESC>').replace(/[\r\n]/g, '?');
      const bufP = (term as any)._core?.buffer;
      const dropUntilVal = ptyDropRepaintUntil.get(termId);
      const inWindow = dropUntilVal && Date.now() < dropUntilVal;
      console.log('[PTY-IN] tid=' + termId + ' len=' + data.length + ' head="' + head + '" buf=' + (bufP ? JSON.stringify({ybase:bufP.ybase,y:bufP.y,len:bufP.lines?.length}) : 'null') + ' dropUntil=' + dropUntilVal + ' inWin=' + inWindow);
      // ConPTY drop window: PTY resize 직후 오는 전체화면 repaint 를 억제해 커서 위치 깨짐 방지.
      // ConPTY/PSReadLine 이 보내는 full-screen repaint 시그니처 패턴들:
      //   sigE — \x1b[?25l \x1b[H        (커서숨김 + 커서홈)
      //   sigF — \x1b[?25l \x1b[m \x1b[H (커서숨김 + SGR리셋 + 커서홈)  ← 이전에 누락됐던 패턴
      //   sigA — \x1b[H \x1b[2J           (커서홈 + 화면지우기)
      //   sigB — \x1b[2J \x1b[H           (화면지우기 + 커서홈)
      const dropUntil = ptyDropRepaintUntil.get(termId);
      if (dropUntil && Date.now() < dropUntil) {
        // ConPTY/PSReadLine 전체화면 repaint 시그니처:
        // - 시작: \x1b[?25l (커서 숨김)
        // - 중간: 0개 이상의 SGR 시퀀스 (\x1b[<digits;>m) — 색상/스타일 리셋
        // - 그 후: \x1b[H (커서 홈) — 화면 좌상단으로 이동
        // 예: \x1b[?25l\x1b[H, \x1b[?25l\x1b[m\x1b[H, \x1b[?25l\x1b[38;5;9m\x1b[H 등 모두 매치
        const sigHideHome = /^\x1b\[\?25l(?:\x1b\[[\d;]*m)*\x1b\[H/.test(data);
        // 화면 클리어 (cursor home + ED) 패턴
        const sigClear = /^\x1b\[H\x1b\[2J/.test(data) || /^\x1b\[2J\x1b\[H/.test(data);
        if (sigHideHome || sigClear) { console.log('[PTY-IN] DROPPED (in window) head="' + head + '"'); return; }
        console.log('[PTY-IN] in drop window but no match → passing through');
      }
      // 스크롤 위로 올린 상태에서 빠른 출력 (tail -F 등) 시 viewport drift 방지
      const core = (term as any)._core;
      const bufBefore = core?.buffer;
      const wasScrolledUp = bufBefore && bufBefore.ydisp < bufBefore.ybase;
      const offsetFromEnd = wasScrolledUp ? (bufBefore.lines.length - bufBefore.ydisp) : -1;
      term.write(data);
      if (wasScrolledUp && offsetFromEnd > 0) {
        try {
          const buf2 = core?.buffer;
          if (buf2 && buf2.lines) {
            const newYdisp = Math.max(0, Math.min(buf2.ybase, buf2.lines.length - offsetFromEnd));
            if (buf2.ydisp !== newYdisp) {
              buf2.ydisp = newYdisp;
              const vp = (term as any).element?.querySelector?.('.xterm-viewport') as HTMLElement | null;
              if (vp) {
                const cellH = core?._renderService?.dimensions?.css?.cell?.height || 17;
                vp.scrollTop = newYdisp * cellH;
              }
              try { core?._onScroll?.fire?.(newYdisp); } catch {}
              try { core?._renderService?.refreshRows?.(0, (term as any).rows - 1); } catch {}
            }
          }
        } catch {}
      }
    } catch {}
  });

  ptyExitHandlers.set(termId, () => {
    ptyConnected.delete(termId);
    notifyConnectedChange();
    // SSH takeover 등으로 suppress 표식이 있으면 메시지 생략
    if (ptyExitSuppressed.has(termId)) {
      ptyExitSuppressed.delete(termId);
      return;
    }
    try { term.write(`\r\n\x1b[90m${tt('output.shellExited')}\x1b[0m\r\n`); } catch {}
  });
}

// 프로그램 호출로 selectAll 할 때 autoCopyOnSelect 건너뛰기 위한 플래그
let _skipAutoCopyOnSelect = false;
export function isSelectAllSkippingAutoCopy(): boolean { return _skipAutoCopyOnSelect; }
// 현재 selectAll 상태인 termId 들 — 스크롤/사용자 입력 시 자동 해제
const selectAllActive: Set<string> = new Set();
export function selectAllInTerm(termId: string) {
  try {
    _skipAutoCopyOnSelect = true;
    const entry = termStore.get(termId);
    if (entry) {
      safeTermFocus(entry.term);
      entry.term.selectAll();
      try { (entry.term as any).refresh?.(0, (entry.term as any).rows - 1); } catch {}
      selectAllActive.add(termId);
      const term: any = entry.term;
      // xterm 내부 selectionService 의 clearSelection 을 패치 — selectAll 활성 시 호출 무시
      if (!term.__selectAllPatched) {
        term.__selectAllPatched = true;
        try {
          const svc = term._core?._selectionService;
          if (svc && typeof svc.clearSelection === 'function') {
            const orig = svc.clearSelection.bind(svc);
            svc.clearSelection = function() {
              if (selectAllActive.has(termId)) return; // 무시 — selection 유지
              return orig();
            };
          }
        } catch {}
      }
      // 보조 안전망: requestAnimationFrame 으로 매 프레임 selection 확인 + 재적용
      if (!term.__selectAllRafLoop) {
        const tick = () => {
          if (!selectAllActive.has(termId)) { term.__selectAllRafLoop = null; return; }
          try {
            const sel = term.getSelection?.();
            if (!sel || sel.length === 0) {
              _skipAutoCopyOnSelect = true;
              term.selectAll();
              setTimeout(() => { _skipAutoCopyOnSelect = false; }, 20);
            }
          } catch {}
          term.__selectAllRafLoop = requestAnimationFrame(tick);
        };
        term.__selectAllRafLoop = requestAnimationFrame(tick);
      }
      if (!term.__selectAllScrollHook) {
        term.__selectAllScrollHook = true;
        let reapplyScheduled = false;
        const reapply = () => {
          if (!selectAllActive.has(termId)) { reapplyScheduled = false; return; }
          // 이미 selection 이 살아있으면 재선택 스킵 — 깜박임 방지
          try {
            const sel = term.getSelection?.();
            if (sel && sel.length > 0) { reapplyScheduled = false; return; }
          } catch {}
          _skipAutoCopyOnSelect = true;
          try { term.selectAll(); } catch {}
          setTimeout(() => { _skipAutoCopyOnSelect = false; reapplyScheduled = false; }, 60);
        };
        const scheduleReapply = () => {
          if (reapplyScheduled) return;
          reapplyScheduled = true;
          setTimeout(reapply, 80);
        };
        try {
          term.onScroll(scheduleReapply);
          const vp = (entry.term as any).element?.querySelector?.('.xterm-viewport');
          if (vp) {
            vp.addEventListener('scroll', scheduleReapply);
            // 스크롤 시작 직전(capture) 에 selectAll 미리 다시 — xterm 내부 deselect 발생 전에
            const preReapply = () => {
              if (selectAllActive.has(termId)) {
                _skipAutoCopyOnSelect = true;
                try { term.selectAll(); } catch {}
                setTimeout(() => { _skipAutoCopyOnSelect = false; }, 30);
              }
            };
            vp.addEventListener('wheel', preReapply, { capture: true, passive: true });
            // mousedown 은 selectAll 유지 위해 가로채지 않음 — 정상 드래그-선택과 충돌
          }
          term.onData(() => selectAllActive.delete(termId));
          // 모든 마우스 클릭 시 selectAll 해제 (xterm 의 정상 드래그-선택과 충돌 방지)
          // 단, scrollbar 자체 클릭은 유지 — clientX 가 viewport 우측 가장자리 근처일 때만
          (entry.term as any).element?.addEventListener?.('mousedown', (ev: MouseEvent) => {
            try {
              const vp = (entry.term as any).element?.querySelector?.('.xterm-viewport') as HTMLElement | null;
              if (vp) {
                const r = vp.getBoundingClientRect();
                // 스크롤바는 보통 16px 너비 (브라우저 기본). 그 영역이면 selectAll 유지
                if (ev.clientX >= r.right - 20 && ev.clientX <= r.right + 4) return;
              }
            } catch {}
            selectAllActive.delete(termId);
          });
        } catch {}
      }
    }
    setTimeout(() => { _skipAutoCopyOnSelect = false; }, 100);
  } catch {
    _skipAutoCopyOnSelect = false;
  }
}
export function getSelectionFromTerm(termId: string): string {
  try {
    const entry = termStore.get(termId);
    if (!entry) return '';
    let sel = entry.term.getSelection() || '';
    const settings = getTerminalSettings();
    if (settings.trimTrailingWhitespace) sel = sel.split('\n').map(l => l.trimEnd()).join('\n');
    if (!settings.includeTrailingNewline) sel = sel.replace(/\n$/, '');
    return sel;
  } catch { return ''; }
}

export function pasteToTerm(termId: string, text: string) {
  try {
    const entry = termStore.get(termId);
    if (entry) { entry.term.paste(text); return; }
  } catch {}
  // fallback
  try {
    if (ptyConnected.has(termId)) (window as any).api?.ptyInput?.(termId, text);
    else (window as any).api?.sendSSHInput?.(termId, text);
  } catch {}
}

export function isTermPty(termId: string): boolean {
  return ptyConnected.has(termId);
}

// SSH 연결 시작 추적
const sshConnecting = new Set<string>();
export function isTermConnecting(termId: string): boolean {
  // 비밀번호 프롬프트 대기 중 / 빠른연결 대기 중도 "연결 중" 으로 간주 — 다른 세션이
  // 이 termId 를 재사용해버리면 사용자가 입력 중이던 흐름이 끊김.
  return sshConnecting.has(termId) || activePasswordPrompt.has(termId) || quickConnectPending.has(termId);
}
// 사용자가 재연결을 명시적으로 취소한 termId (자동 재연결 방지)
const reconnectUserCancelled = new Set<string>();

const reconnectState: Map<string, { timer: ReturnType<typeof setInterval> | null; fireTimer?: ReturnType<typeof setTimeout> | null; cancelled: boolean; disp?: any }> = new Map();
// termId → 세션 정보 매핑 (재연결 + 표시용)
const termSessionMap: Map<string, { sessionId: string; sessionName: string; host: string; quickSession?: any }> = new Map();
// termId → 마지막 사용 비밀번호 (메모리 only, 재연결용)
const termPasswordCache: Map<string, string> = new Map();
// termId → autoTrackPwd 런타임 상태 (세션 초기값으로 시작, 토글 가능)
const termAutoTrackState: Map<string, boolean> = new Map();
const autoTrackListeners: Set<(termId: string, v: boolean) => void> = new Set();
export function getTermAutoTrack(termId: string): boolean {
  return termAutoTrackState.get(termId) ?? false;
}
export function setTermAutoTrack(termId: string, v: boolean) {
  termAutoTrackState.set(termId, v);
  autoTrackListeners.forEach(fn => { try { fn(termId, v); } catch {} });
}
export function subscribeAutoTrack(fn: (termId: string, v: boolean) => void): () => void {
  autoTrackListeners.add(fn);
  return () => autoTrackListeners.delete(fn);
}
// main 에서 hook 설치/제거 알림 수신 → 상태 자동 동기화
if (typeof window !== 'undefined') {
  const api: any = (window as any).api;
  if (api?.onSSHAutoTrack) {
    api.onSSHAutoTrack((p: any) => {
      if (p && p.panelId) setTermAutoTrack(p.panelId, !!p.enabled);
    });
  }
}

export function getTermSessionInfo(termId: string) {
  return termSessionMap.get(termId);
}

export function registerTermSession(termId: string, sessionId: string, sessionName?: string, host?: string, quickSession?: any) {
  termSessionMap.set(termId, { sessionId, sessionName: sessionName ?? '', host: host ?? '', quickSession });
}

// 초기 연결 watchdog — N초 내 연결 안되면 최대 3회 자동 재시도.
// onSSHConnected 시 해제, onSSHError 시 즉시 재시도 발동.
// Solaris 처럼 KEX 연산 느린 서버가 동시 다수 접속 시 10초도 부족 → 20초로 증가.
const INITIAL_CONNECT_TIMEOUT_MS = 20000;
const INITIAL_CONNECT_MAX_ATTEMPTS = 3;
const INITIAL_CONNECT_RETRY_GAP_MS = 5000;
const initialConnectWatchdog: Map<string, { timer: ReturnType<typeof setTimeout>; sessionId: string; cols?: number; rows?: number }> = new Map();
const initialConnectAttempts: Map<string, number> = new Map();

export function startInitialConnectWatchdog(termId: string, sessionId: string, cols?: number, rows?: number) {
  // 기존 타이머가 있으면 해제 (중복 장전 방지)
  const existing = initialConnectWatchdog.get(termId);
  if (existing) clearTimeout(existing.timer);
  const attempts = (initialConnectAttempts.get(termId) || 0) + 1;
  initialConnectAttempts.set(termId, attempts);
  const timer = setTimeout(() => {
    if (globalConnected.has(termId)) {
      clearInitialConnectWatchdog(termId);
      return;
    }
    fireInitialReconnect(termId, '10초 응답 없음');
  }, INITIAL_CONNECT_TIMEOUT_MS);
  initialConnectWatchdog.set(termId, { timer, sessionId, cols, rows });
}

export function clearInitialConnectWatchdog(termId: string) {
  const w = initialConnectWatchdog.get(termId);
  if (w) { clearTimeout(w.timer); initialConnectWatchdog.delete(termId); }
  initialConnectAttempts.delete(termId);
}

// 초기 재연결 시도 — watchdog 가 있으면 발동. 반환값은 재시도 가능했는지 여부.
export function tryInitialReconnect(termId: string): boolean {
  if (!initialConnectWatchdog.has(termId)) return false;
  fireInitialReconnect(termId, '에러');
  return true;
}

function fireInitialReconnect(termId: string, reason: string) {
  const w = initialConnectWatchdog.get(termId);
  if (!w) return; // 이미 처리 중이면 skip (재진입 방지)
  clearTimeout(w.timer);
  initialConnectWatchdog.delete(termId); // 재시도 중엔 watchdog 없음 → 재진입 방지
  const entry = termStore.get(termId);
  const attempts = initialConnectAttempts.get(termId) || 1;
  if (attempts >= INITIAL_CONNECT_MAX_ATTEMPTS) {
    initialConnectAttempts.delete(termId);
    try { entry?.term.write(`\r\n\x1b[91m${tt('output.connectFailedFinal', { attempts: INITIAL_CONNECT_MAX_ATTEMPTS, reason })}\x1b[0m\r\n`); } catch {}
    sshConnecting.delete(termId);
    return;
  }
  try { entry?.term.write(`\r\n\x1b[33m${tt('output.connectRetry', { reason, attempt: attempts, max: INITIAL_CONNECT_MAX_ATTEMPTS - 1, sec: INITIAL_CONNECT_RETRY_GAP_MS / 1000 })}\x1b[0m\r\n`); } catch {}
  try { window.api?.disconnectSSH?.(termId); } catch {}
  sshConnecting.delete(termId);
  // 재시도 대기 — bastion sshd MaxStartups 가 drop 한 경우 앞선 세션이 인증 완료할 시간
  setTimeout(() => {
    sshConnecting.add(termId);
    window.api?.connectSSH?.(termId, w.sessionId, w.cols, w.rows)?.then((r: string) => {
      if (r === 'need-password') {
        sshConnecting.delete(termId);
        const cached = termPasswordCache.get(termId);
        if (cached) {
          sshConnecting.add(termId);
          window.api?.connectSSHWithPassword?.(termId, w.sessionId, cached, w.cols || 80, w.rows || 24);
        } else {
          promptPasswordAndConnect(termId, w.sessionId, w.cols, w.rows);
        }
      }
    }).catch(() => {});
    startInitialConnectWatchdog(termId, w.sessionId, w.cols, w.rows);
  }, INITIAL_CONNECT_RETRY_GAP_MS);
}

function startReconnectCountdown(termId: string) {
  const sessInfo = termSessionMap.get(termId);
  if (!sessInfo) return;
  const { sessionId, sessionName, host } = sessInfo;

  const entry = termStore.get(termId);
  if (!entry) return;
  const term = entry.term;

  // 이전 재연결 취소
  cancelReconnect(termId);

  const now = new Date();
  const timeStr = now.toTimeString().split(' ')[0]; // HH:MM:SS

  const TOTAL_MS = 30000;
  const startAt = Date.now();
  const deadline = startAt + TOTAL_MS;
  let lastSecond = 30;
  const state: any = { timer: null, fireTimer: null, cancelled: false, disp: null };
  reconnectState.set(termId, state);

  term.write(`\r\n\x1b[91m${tt('output.remoteDisconnected', { sessionName, host, time: timeStr })}\x1b[0m\r\n`);
  term.write(`\r\n\x1b[33m${tt('output.reconnectIn30s')}\x1b[0m\r\n`);

  // 시각적 카운트다운(점)만 setInterval 로 갱신. 실제 재연결 발사는 단일 setTimeout 으로 처리해
  // 패널 전환/쓰로틀 등에 영향 없이 정확히 30초 후에만 1회 발동.
  state.timer = setInterval(() => {
    if (state.cancelled) { clearInterval(state.timer); return; }
    const remainingMs = deadline - Date.now();
    const remainSec = Math.max(0, Math.ceil(remainingMs / 1000));
    while (lastSecond > remainSec && lastSecond > 0) {
      term.write('.');
      lastSecond--;
    }
    if (remainingMs <= 0) {
      clearInterval(state.timer);
      state.timer = null;
    }
  }, 250);

  state.fireTimer = setTimeout(async () => {
    // 발사 시점에 취소되었거나 이미 다시 연결된 경우 실행하지 않음
    if (state.cancelled) return;
    const cur = reconnectState.get(termId);
    if (cur !== state) return; // 다른 countdown 으로 대체된 경우
    if (globalConnected.has(termId)) { reconnectState.delete(termId); return; }
    if (state.disp) { state.disp.dispose(); state.disp = null; }
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    reconnectState.delete(termId);
    term.write(`\r\n\x1b[33m${tt('output.reconnecting')}\x1b[0m\r\n`);
    sshConnecting.delete(termId);
    globalConnected.delete(termId);
    try {
      if (!sessionId && sessInfo.quickSession) {
        (window as any).api.quickConnectSSH(termId, sessInfo.quickSession);
      } else {
        const r = await (window as any).api.connectSSH(termId, sessionId);
        if (r === 'need-password') {
          sshConnecting.delete(termId);
          const cachedPw = termPasswordCache.get(termId);
          const cols = (term as any).cols || 80;
          const rows = (term as any).rows || 24;
          if (cachedPw) {
            sshConnecting.add(termId);
            (window as any).api.connectSSHWithPassword(termId, sessionId, cachedPw, cols, rows);
          } else {
            promptPasswordAndConnect(termId, sessionId, cols, rows);
          }
          return;
        }
      }
    } catch {}
  }, TOTAL_MS);

  const disp = term.onData(() => {
    if (!state.cancelled) {
      state.cancelled = true;
      if (state.timer) { clearInterval(state.timer); state.timer = null; }
      if (state.fireTimer) { clearTimeout(state.fireTimer); state.fireTimer = null; }
      reconnectState.delete(termId);
      reconnectUserCancelled.add(termId);
      term.write(`\r\n\x1b[90m${tt('output.reconnectCancelled')}\x1b[0m\r\n`);
    }
    disp.dispose();
    state.disp = null;
  });
  state.disp = disp;
}

function cancelReconnect(termId: string) {
  const state = reconnectState.get(termId);
  if (state) {
    state.cancelled = true;
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    if (state.fireTimer) { clearTimeout(state.fireTimer); state.fireTimer = null; }
    if (state.disp) { state.disp.dispose(); state.disp = null; }
    reconnectState.delete(termId);
  }
}

// ─── 여러 줄 붙여넣기 모달 — 드래그 이동 + 우/하/우하 리사이즈 (좌상단 고정) ─────────────
interface MultiPasteModalProps {
  text: string;
  onChange: (t: string) => void;
  onCancel: () => void;
  onPaste: () => void;
}
// @ts-expect-error unused (kept for fallback)
const MultiPasteModal: React.FC<MultiPasteModalProps> = ({ text, onChange, onCancel, onPaste }) => {
  const { t } = useTranslation('terminal');
  const [pos, setPos] = useState(() => {
    const w = 600, h = 480;
    return { x: Math.max(0, (window.innerWidth - w) / 2), y: Math.max(0, window.innerHeight * 0.1), w, h };
  });
  const dragRef = useRef<{ mode: 'move' | 'resize-r' | 'resize-b' | 'resize-br'; startX: number; startY: number; startPos: typeof pos } | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);

  const startDrag = useCallback((mode: 'move' | 'resize-r' | 'resize-b' | 'resize-br') => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { mode, startX: e.clientX, startY: e.clientY, startPos: { ...pos } };
    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current; if (!d) return;
      const dx = ev.clientX - d.startX;
      const dy = ev.clientY - d.startY;
      const sp = d.startPos;
      let next = { ...sp };
      if (d.mode === 'move') {
        // 자유 이동 — 헤더(40px)는 항상 클릭 가능하게 최소한 화면 안에 보이도록만 제한
        next.x = Math.max(-(sp.w - 80), Math.min(window.innerWidth - 80, sp.x + dx));
        next.y = Math.max(0, Math.min(window.innerHeight - 40, sp.y + dy));
      } else {
        if (d.mode === 'resize-r' || d.mode === 'resize-br') {
          next.w = Math.max(360, sp.w + dx);
        }
        if (d.mode === 'resize-b' || d.mode === 'resize-br') {
          next.h = Math.max(240, sp.h + dy);
        }
      }
      // DOM 직접 갱신 — 매 mousemove 마다 React 리렌더 회피로 끊김 없음
      const m = modalRef.current;
      if (m) {
        m.style.left = next.x + 'px';
        m.style.top = next.y + 'px';
        m.style.width = next.w + 'px';
        m.style.height = next.h + 'px';
      }
      (dragRef.current!.startPos as any).__lastNext = next;
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      const last = (dragRef.current?.startPos as any)?.__lastNext;
      if (last) setPos(last);
      dragRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [pos]);

  return (
    <div
      ref={modalRef}
      onClick={e => e.stopPropagation()}
      style={{
        position: 'fixed', left: pos.x, top: pos.y, width: pos.w, height: pos.h,
        background: '#1a1a1a', border: '1px solid #333', borderRadius: 6,
        boxShadow: '0 8px 32px rgba(0,0,0,0.6)', display: 'flex', flexDirection: 'column',
        color: '#eee', zIndex: 2000, overflow: 'hidden',
      }}
    >
      {/* 헤더 — 드래그 핸들 */}
      <div
        onMouseDown={startDrag('move')}
        style={{
          padding: '10px 14px', borderBottom: '1px solid #333',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          cursor: 'move', userSelect: 'none', background: '#222',
        }}
      >
        <strong style={{ fontSize: 13 }}>{t('multiLinePaste.title')}</strong>
        <button onClick={onCancel} style={{ background: 'transparent', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: 16, padding: 0 }}>✕</button>
      </div>
      {/* 본문 */}
      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <p style={{ color: '#888', fontSize: 12, margin: '0 0 8px' }}>{t('multiLinePaste.prompt')}</p>
        <textarea
          autoFocus
          ref={el => { if (el && (el as any).__focused !== true) { (el as any).__focused = true; setTimeout(() => el.focus(), 0); } }}
          value={text}
          onChange={e => onChange(e.target.value)}
          onKeyDown={e => {
            e.stopPropagation();
            if (e.key === 'Escape') onCancel();
            else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onPaste(); }
          }}
          style={{
            flex: 1, minHeight: 0, width: '100%', maxWidth: '100%', minWidth: 0, boxSizing: 'border-box',
            background: '#111', color: '#eee', border: '1px solid #333', borderRadius: 4,
            padding: 8, fontSize: 12, fontFamily: 'monospace', resize: 'none',
          }}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={{ padding: '6px 16px', background: '#333', border: '1px solid #555', color: '#eee', borderRadius: 4, cursor: 'pointer' }}>{t('multiLinePaste.cancelHint')}</button>
          <button onClick={onPaste} style={{ padding: '6px 16px', background: '#2b6b9b', border: '1px solid #3a8bc8', color: '#fff', borderRadius: 4, cursor: 'pointer' }}>{t('multiLinePaste.pasteHint')}</button>
        </div>
      </div>
      {/* 리사이즈 핸들들 — 우, 하, 우하 (좌상단 고정) */}
      <div onMouseDown={startDrag('resize-r')} style={{ position: 'absolute', right: 0, top: 0, width: 6, height: '100%', cursor: 'ew-resize' }} />
      <div onMouseDown={startDrag('resize-b')} style={{ position: 'absolute', bottom: 0, left: 0, height: 6, width: '100%', cursor: 'ns-resize' }} />
      <div onMouseDown={startDrag('resize-br')} style={{ position: 'absolute', bottom: 0, right: 0, width: 14, height: 14, cursor: 'nwse-resize', background: 'linear-gradient(135deg, transparent 50%, #555 50%, #555 60%, transparent 60%, transparent 70%, #555 70%, #555 80%, transparent 80%)' }} />
    </div>
  );
};

// 외부에서 특정 termId 의 xterm 에 문자열을 직접 write — 시스템 안내 메시지 출력용
export function writeToTerm(termId: string, text: string) {
  const entry = termStore.get(termId);
  if (!entry) return;
  try { entry.term.write(text); } catch {}
}

export function focusTerm(termId: string) {
  const entry = termStore.get(termId);
  if (!entry) return;
  try {
    safeTermFocus(entry.term);
    // xterm 내부 textarea를 직접 포커스 (더 확실)
    const el = (entry.term as any).element as HTMLElement | undefined;
    const textarea = el?.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
    if (textarea && !termFocusBlocked) textarea.focus();
    // 포커스 받을 때 fit + resize 한 번 — vi 등 풀스크린 앱이 잘못된 사이즈로 떴던 케이스 보정
    const termEl = (entry.term as any).element as HTMLElement | undefined;
    if (termEl && termEl.offsetWidth > 0) {
      try { entry.fit?.fit?.(); } catch {}
      const c = (entry.term as any).cols;
      const r = (entry.term as any).rows;
      if (c && r) {
        if (ptyConnected.has(termId)) (window as any).api?.ptyResize?.(termId, c, r);
        else (window as any).api?.resizeSSH?.(termId, c, r);
      }
    }
  } catch {}
}

/** 외부에서 termId의 연결 추적 상태를 리셋 (재연결 허용) */
export function resetTermConnectState(termId: string) {
  sshConnecting.delete(termId);
  globalConnected.delete(termId);
}

type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'center';

function getDropZone(e: React.DragEvent, el: HTMLElement): DropZone {
  const rect = el.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top) / rect.height;
  const threshold = 0.25;
  if (x < threshold) return 'left';
  if (x > 1 - threshold) return 'right';
  if (y < threshold) return 'top';
  if (y > 1 - threshold) return 'bottom';
  return 'center';
}

type Props = {
  nodeId: string;
  panel: Panel;
  onSplit: (nodeId: string, dir: 'row' | 'column') => void;
  onClose: (nodeId: string) => void;
  onSelect?: (nodeId: string) => void;
  onSwitchSession?: (nodeId: string, idx: number) => void;
  onCloseSession?: (nodeId: string, termId: string) => void;
  onMoveSession?: (fromNodeId: string, termId: string, toNodeId: string) => void;
  workspaceList?: { id: string; title: string }[];
  currentWorkspaceId?: string;
  onMoveSessionToWorkspace?: (fromNodeId: string, termId: string, targetTabId: string) => void;
  onSplitMoveSession?: (fromNodeId: string, termId: string, toNodeId: string, zone: 'left' | 'right' | 'top' | 'bottom') => void;
  onReorderSession?: (nodeId: string, fromIdx: number, toIdx: number) => void;
  onAddSession?: (nodeId: string, shellName?: string, shellPath?: string) => void;
  availableShells?: { name: string; path: string; icon?: string }[];
  onRenameSession?: (nodeId: string, termId: string, name: string) => void;
  onConnectDrop?: (nodeId: string, sessionId: string) => void;
  onDuplicateSession?: (nodeId: string, termId: string) => void;
  // 파일 트리 관련 (패널 내부 분할 렌더)
  treeWidth?: number;
  onTreeWidthChange?: (w: number) => void;
  onOpenRemoteFile?: (termId: string, remotePath: string, fileName: string) => void;
  onAttachToClaude?: (termId: string, remotePath: string, fileName: string, isDir: boolean) => void;
  isFloating?: boolean;
  onToggleFloat?: (nodeId: string) => void;
  isSelected?: boolean;
  onSplitWithPicker?: (nodeId: string, dir: 'row' | 'column') => void;
};

export const TerminalPanel: React.FC<Props> = ({
  nodeId, panel, onSplit, onClose, onSelect, onSwitchSession, onCloseSession, onMoveSession, onSplitMoveSession, onReorderSession, onAddSession, onRenameSession, onConnectDrop, onDuplicateSession, availableShells,
  treeWidth = 240, onTreeWidthChange, onOpenRemoteFile, onAttachToClaude,
  isFloating, onToggleFloat, isSelected: _isSelected, onSplitWithPicker,
  workspaceList, currentWorkspaceId, onMoveSessionToWorkspace,
}) => {
  const { t } = useTranslation('terminal');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mountedTermRef = useRef<string | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const [, forceUpdate] = useState(0);

  const activeSession: PanelSession | undefined = panel.sessions[panel.activeIdx];
  const activeTermId = activeSession?.termId;

  // 글로벌 연결 상태 변경 구독
  useEffect(() => {
    const listener = () => forceUpdate(n => n + 1);
    connectedListeners.add(listener);
    return () => { connectedListeners.delete(listener); };
  }, []);

  // 녹화 상태 변경 구독 — REC 버튼 색상 갱신
  useEffect(() => {
    const unsub = subscribeRecording(() => forceUpdate(n => n + 1));
    return unsub;
  }, []);

  // 파일 트리 표시 토글 이벤트 구독 (Ctrl+Shift+E 로 외부에서 호출됨)
  useEffect(() => {
    const fn = () => forceUpdate(n => n + 1);
    treeVisibleChangeListeners.add(fn);
    return () => { treeVisibleChangeListeners.delete(fn); };
  }, []);


  // SSH 리스너 설정
  useEffect(() => {
    for (const sess of panel.sessions) {
      ensureSSHSetup(sess.termId);
    }
  }, [panel.sessions.map(s => s.termId).join(',')]);

  // 패널이 비어 있으면 자동으로 새 세션(미니탭) 생성 (중복 호출 방지)
  const autoAddedRef = useRef(false);
  useEffect(() => {
    if (panel.sessions.length === 0) {
      if (autoAddedRef.current) return;
      autoAddedRef.current = true;
      onAddSession?.(nodeId);
    } else {
      autoAddedRef.current = false;
    }
  }, [panel.sessions.length, nodeId]);

  // Active 터미널을 컨테이너에 마운트 + SSH 연결
  useEffect(() => {
    if (!activeTermId || !containerRef.current) return;

    // 이미 같은 터미널이 마운트되어 있으면 다시 그리지 않음
    if (mountedTermRef.current === activeTermId) return;
    mountedTermRef.current = activeTermId;

    const { term, fit } = getOrCreateTerm(activeTermId);

    // 이전에 .xterm DOM 이 만들어진 적이 있으면 (워크스페이스 전환 등으로 stash 됐을 수 있음)
    // term.open() 다시 호출하지 않고 기존 DOM 을 새 컨테이너로 이동 — scrollbar/뷰포트 상태 보존
    const stashedEl = (term as any).element as HTMLElement | undefined;
    if (stashedEl && stashedEl.classList.contains('xterm')) {
      containerRef.current.innerHTML = '';
      containerRef.current.appendChild(stashedEl);
      // stash 복귀 시엔 항상 refit + viewport 재계산 — 활동 없는 터미널의 scrollbar 가 0 으로 멈추는 문제 fix
      // refit 후 stash 직전 저장한 스크롤 위치로 복원 (hidden stash 가 scrollTop=0 으로 만들어 버리는 문제)
      requestAnimationFrame(() => {
        refitTerm(activeTermId);
        restoreSavedScroll(activeTermId);
        setTimeout(() => { refitTerm(activeTermId); restoreSavedScroll(activeTermId); }, 50);
        setTimeout(() => { refitTerm(activeTermId); restoreSavedScroll(activeTermId); }, 200);
        setTimeout(() => { restoreSavedScroll(activeTermId); termSavedScroll.delete(activeTermId); }, 350);
      });
    } else {
      containerRef.current.innerHTML = '';
      term.open(containerRef.current);
    }
    applyTermOpacity(activeTermId, containerRef.current);

    // IME(한글 등) 조합 처리
    try {
      const ta = containerRef.current.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
      if (ta && !(ta as any).__imeBound) {
        (ta as any).__imeBound = true;
        const tid = activeTermId;
        ta.addEventListener('compositionstart', () => {
          if (ptyConnected.has(tid)) return;
          termIMEComposing.set(tid, true);
        });
        ta.addEventListener('compositionend', (e: CompositionEvent) => {
          if (ptyConnected.has(tid)) return;
          termIMEComposing.set(tid, false);
          const finalText = (e.data ?? '') || '';
          if (finalText) {
            try {
              const bytes = new TextEncoder().encode(finalText);
              const b64 = typeof Buffer !== 'undefined'
                ? Buffer.from(bytes).toString('base64')
                : btoa(String.fromCharCode(...bytes));
              window.api?.sendSSHInput?.(tid, finalText, b64);
              termJustComposed.set(tid, { text: finalText, at: Date.now() });
            } catch {}
          }
        });
      }
    } catch {}

    // DOM 마운트 후 fit → 정확한 cols/rows로 연결
    const initConnect = async () => {
      // 컨테이너 크기 확인 (보통 즉시 통과, 초기 탭만 약간 대기)
      if (!(containerRef.current && containerRef.current.offsetWidth > 0 && containerRef.current.offsetHeight > 0)) {
        for (let i = 0; i < 15; i++) {
          await new Promise(res => setTimeout(res, 30));
          if (containerRef.current && containerRef.current.offsetWidth > 0 && containerRef.current.offsetHeight > 0) break;
        }
      }
      await new Promise(requestAnimationFrame);
      try { fit.fit(); } catch {}
      await new Promise(requestAnimationFrame);
      try { fit.fit(); } catch {}

      const cols = (term as any).cols || 80;
      const rows = (term as any).rows || 24;
      safeTermFocus(term);

      if (activeSession && activeSession.sessionId && !sshConnecting.has(activeTermId) && !globalConnected.has(activeTermId) && !reconnectState.has(activeTermId) && !reconnectUserCancelled.has(activeTermId)) {
        // 같은 termId에 PTY가 실행 중이면 종료 (Local Shell → SSH 전환)
        if (ptyConnected.has(activeTermId)) {
          window.api?.ptyKill?.(activeTermId);
          ptyConnected.delete(activeTermId);
          ptyInitialized.delete(activeTermId);
          term.clear();
        }
        sshConnecting.add(activeTermId);
        startInitialConnectWatchdog(activeTermId, activeSession.sessionId, cols, rows);
        try {
          const result = await window.api?.connectSSH?.(activeTermId, activeSession.sessionId, cols, rows);
          if (result === 'need-password') {
            sshConnecting.delete(activeTermId);
            const cachedPw = termPasswordCache.get(activeTermId);
            if (cachedPw) {
              sshConnecting.add(activeTermId);
              window.api?.connectSSHWithPassword?.(activeTermId, activeSession.sessionId, cachedPw, cols, rows);
            } else {
              promptPasswordAndConnect(activeTermId, activeSession.sessionId, cols, rows);
            }
          }
        } catch { /* connect error — already handled by global */ }
        // 연결 확립 후 여러 시점에 fit + force resize — 초기 fit 이 layout 안정화 전
        // (또는 비활성 탭이라 컨테이너 hidden) 이었던 경우를 보정.
        // force=true 로 dedup 우회해서 PTY 사이즈를 확실히 동기화.
        const forceResyncSize = () => {
          try {
            fit.fit();
            const c = (term as any).cols || cols;
            const r = (term as any).rows || rows;
            if (c >= 10 && r >= 5) window.api?.resizeSSH?.(activeTermId, c, r, true);
          } catch {}
        };
        setTimeout(forceResyncSize, 200);
        setTimeout(forceResyncSize, 600);
        setTimeout(forceResyncSize, 1500);
        setTimeout(forceResyncSize, 3000);
      } else if (globalConnected.has(activeTermId)) {
        try { window.api?.resizeSSH?.(activeTermId, cols, rows); } catch {}
      } else if (quickConnectPending.has(activeTermId)) {
        // 빠른연결 SSH 핸드셰이크 대기 중 — PTY 스폰 금지. 사용자에게 placeholder 표시
        // (실제 "▶ host:port (user) 연결 중..." 은 sshBridge 가 곧 보냄).
        // 1회만 표시 — tab 전환 등으로 initConnect 가 재실행돼도 중복 출력 안 함.
        if (!quickConnectPlaceholderShown.has(activeTermId)) {
          quickConnectPlaceholderShown.add(activeTermId);
          try { term.write(`\r\n\x1b[96m${tt('output.tryingSSH')}\x1b[0m\r\n`); } catch {}
        }
      } else if (termSessionMap.get(activeTermId)?.quickSession) {
        // 빠른연결로 등록된 termId 인데 quickConnectPending 플래그가 없는 경우 (재시도 사이 윈도우 등) —
        // 그래도 PTY 는 띄우면 안 됨. quickConnectPending 가 다시 set 될 때까지 placeholder 유지.
      } else if (activeSession && !activeSession.sessionId && !ptyConnected.has(activeTermId)) {
        (term.options as any).windowsPty = { backend: 'conpty', buildNumber: 26200 };
        ensurePtySetup(activeTermId);
        try {
          // shellCwd가 없으면 startupCwd(탐색기 우클릭 경로)를 가져옴
          let cwd = activeSession.shellCwd;
          if (!cwd) {
            try { cwd = await (window as any).api?.getStartupCwd?.() || undefined; } catch {}
          }
          await window.api?.ptySpawn?.(activeTermId, activeSession.shellPath || undefined, cols, rows, cwd || undefined);
          // startupCwd는 최초 1회만 사용
          if (cwd) { try { (window as any).api?.clearStartupCwd?.(); } catch {} }
          ptyConnected.add(activeTermId);
          notifyConnectedChange();
          setTimeout(() => {
            try {
              fit.fit();
              const c = (term as any).cols || 80;
              const r = (term as any).rows || 24;
              window.api?.ptyResize?.(activeTermId, c, r);
            } catch {}
          }, 200);
          // 셸 별 OSC 7 cwd hook 은 main process 의 pty:spawn 에서 셸 인자로 주입 (echo 안 됨).
          // wsl 등 일부 셸은 main 이 postSpawnInject 으로 stdin 주입하므로 여기서 추가 작업 불필요.
        } catch {}
      } else if (ptyConnected.has(activeTermId)) {
        try { window.api?.ptyResize?.(activeTermId, cols, rows); } catch {}
      }
    };
    initConnect();

    return () => {
      // unmount 시 .xterm DOM 을 hidden stash 로 이동 — 워크스페이스/패널 전환 후
      // 다시 mount 될 때 동일 DOM 을 재사용해서 scrollbar/viewport 상태 보존
      const tid = mountedTermRef.current;
      if (tid) { try { stashXtermDom(tid); } catch {} }
      mountedTermRef.current = null;
    };
  }, [activeTermId, nodeId]);

  // 패널 선택 핸들러 (텍스트 드래그로 선택해도 클릭이 발생하지 않을 수 있어
  // mousedown에서 즉시 패널 선택을 반영한다. 포커스는 클릭 시점에 준다.)
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const onMouseDown = () => {
      onSelectRef.current?.(nodeId);
    };
    const onClick = () => {
      if (activeTermId) { safeTermFocus(getOrCreateTerm(activeTermId).term); }
      onSelectRef.current?.(nodeId);
    };
    el.addEventListener('mousedown', onMouseDown);
    el.addEventListener('click', onClick);
    return () => {
      el.removeEventListener('mousedown', onMouseDown);
      el.removeEventListener('click', onClick);
    };
  }, [activeTermId, nodeId]);

  // 키보드 입력 핸들러
  useEffect(() => {
    if (!activeTermId) return;
    const { term } = getOrCreateTerm(activeTermId);
    const disp = term.onData((data: string) => {
      if (data === '\x1b[I' || data === '\x1b[O') return;
      if (data === '\x1b[r') return;
      // PTY(로컬 셸): IME 가로채기 없이 그대로 전달
      if (ptyConnected.has(activeTermId)) {
        recordInput(activeTermId, data);
        window.api?.ptyInput?.(activeTermId, data);
        return;
      }
      // IME 조합 중이면 파편 입력 차단
      if (termIMEComposing.get(activeTermId)) return;
      // 조합 완료 직후 xterm이 동일 문자열을 다시 보내면 1회 차단 (compositionend에서 이미 전송)
      const jc = termJustComposed.get(activeTermId);
      if (jc && jc.text === data && Date.now() - jc.at < 500) {
        termJustComposed.delete(activeTermId);
        return;
      }
      {
        try {
          const normalized = data.replace(/\x7f/g, '\x08');
          recordInput(activeTermId, normalized);
          const bytes = new TextEncoder().encode(normalized);
          const b64 = typeof Buffer !== 'undefined'
            ? Buffer.from(bytes).toString('base64')
            : btoa(String.fromCharCode(...bytes));
          window.api?.sendSSHInput?.(activeTermId, normalized, b64);
        } catch { window.api?.sendSSHInput?.(activeTermId, data); }
      }
    });
    return () => disp.dispose();
  }, [activeTermId]);

  // 빈 패널 처리
  useEffect(() => {
    if (panel.sessions.length === 0 && containerRef.current) {
      containerRef.current.innerHTML = '';
    }
  }, [panel.sessions.length]);

  // 여러 줄 붙여넣기 이벤트 수신 — 별도 BrowserWindow 로 띄움 (다른 모니터로도 이동 가능)
  useEffect(() => {
    if (!containerRef.current) return;
    const handler = (e: Event) => {
      const { termId: tid, text } = (e as CustomEvent).detail;
      // 터미널 포커스 해제 — 모달 띄워지는 동안 키 입력이 터미널로 가지 않게
      try {
        const entry = termStore.get(tid);
        entry?.term?.blur?.();
        const termEl = (entry?.term as any)?.element as HTMLElement | undefined;
        const xtermEl = termEl?.querySelector?.('textarea.xterm-helper-textarea') as HTMLTextAreaElement | null;
        xtermEl?.blur?.();
      } catch {}
      try { (window as any).api?.pasteModalOpen?.(tid, text); } catch {}
    };
    containerRef.current.addEventListener('term-multi-paste', handler);
    return () => {
      containerRef.current?.removeEventListener('term-multi-paste', handler);
    };
  }, [activeTermId]);

  // 터미널 우클릭 컨텍스트 메뉴
  useEffect(() => {
    if (!containerRef.current) return;
    const handler = (e: Event) => {
      const { x, y } = (e as CustomEvent).detail;
      setTermCtx({ x, y });
    };
    containerRef.current.addEventListener('term-contextmenu', handler);
    return () => containerRef.current?.removeEventListener('term-contextmenu', handler);
  }, [activeTermId]);

  // Resize (debounce로 연쇄 리사이즈 방지)
  useEffect(() => {
    if (!activeTermId || !containerRef.current) return;
    const { fit } = getOrCreateTerm(activeTermId);
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;

    const doFit = () => {
      // 드래그 중에는 fit 자체를 건너뜀 (버퍼 reflow 방지)
      if (suppressPtyResize) return;
      const cd = fitCooldownUntil.get(activeTermId);
      if (cd && Date.now() < cd) return;
      try {
        const e = termStore.get(activeTermId);
        if (!e) return;
        const cont = containerRef.current;
        if (!cont || cont.clientWidth < 50 || cont.clientHeight < 30) return;
        const cw = cont.clientWidth, ch = cont.clientHeight;
        const lastSz = lastContainerSizeMap.get(activeTermId);
        if (lastSz && lastSz.w === cw && lastSz.h === ch) return;
        // 먼저 proposeDimensions 로 계산만 하고 검증 (fit.fit() 은 내부적으로 즉시 term.resize 호출하므로 잘못된 size 가 그대로 적용되어 화면이 깨짐).
        // 사용자가 패널을 작게 만든 정상 case 는 통과해야 하므로 cols/rows 임계는 두지 않고 NaN/0 만 차단.
        const proposed = (fit as any).proposeDimensions?.();
        if (!proposed || !proposed.cols || !proposed.rows || !isFinite(proposed.cols) || !isFinite(proposed.rows)) return;
        lastContainerSizeMap.set(activeTermId, { w: cw, h: ch });
        // 안전한 사이즈 확인 후 실제 fit 적용
        const prevRows1 = (e.term as any).rows;
        const bufBefore1 = (e.term as any)._core?.buffer;
        const before1 = bufBefore1 ? { ybase: bufBefore1.ybase, y: bufBefore1.y, len: bufBefore1.lines?.length } : null;
        console.log('[DOFIT-1] before fit prevRows=' + prevRows1 + ' buf=' + JSON.stringify(before1) + ' cw=' + cw + ' ch=' + ch);
        fit.fit();
        const newCols = (e.term as any).cols;
        const newRows = (e.term as any).rows;
        const bufAfter1 = (e.term as any)._core?.buffer;
        const after1 = bufAfter1 ? { ybase: bufAfter1.ybase, y: bufAfter1.y, len: bufAfter1.lines?.length } : null;
        console.log('[DOFIT-1] after fit rows=' + newRows + ' cols=' + newCols + ' buf=' + JSON.stringify(after1));
        // 비정상 사이즈 차단 (proposeDimensions 통과 후에도 체크)
        if (!newCols || !newRows || !isFinite(newCols) || !isFinite(newRows)) return;
        // rows 증가 시 xterm grow bug 보정 (분할창 닫기 등으로 viewport 가 커진 경우)
        if (newRows > prevRows1) applyXtermGrowFix(e.term, prevRows1);
        const last = lastResizeMap.get(activeTermId);
        if (last && last.cols === newCols && last.rows === newRows) return;
        // 안정화 검증 — 직전 fit 결과와 비교, 다르면 pending 으로 두고 SIGWINCH 보류 (layout 안정 대기)
        const pending = pendingResize.get(activeTermId);
        if (!pending || pending.cols !== newCols || pending.rows !== newRows) {
          pendingResize.set(activeTermId, { cols: newCols, rows: newRows });
          // 200ms 후 재확인 — 같은 결과면 그때 SIGWINCH
          setTimeout(() => {
            try {
              const e2 = termStore.get(activeTermId);
              if (!e2) return;
              const cont2 = containerRef.current;
              if (!cont2 || cont2.clientWidth < 50 || cont2.clientHeight < 30) return;
              const proposed2 = (fit as any).proposeDimensions?.();
              if (!proposed2 || !proposed2.cols || !proposed2.rows || !isFinite(proposed2.cols) || !isFinite(proposed2.rows)) return;
              const prevRows2 = (e2.term as any).rows;
              const bufBefore2 = (e2.term as any)._core?.buffer;
              const before2 = bufBefore2 ? { ybase: bufBefore2.ybase, y: bufBefore2.y, len: bufBefore2.lines?.length } : null;
              console.log('[DOFIT-2] before fit prevRows=' + prevRows2 + ' buf=' + JSON.stringify(before2));
              fit.fit();
              const c2 = (e2.term as any).cols, r2 = (e2.term as any).rows;
              const bufAfter2 = (e2.term as any)._core?.buffer;
              const after2 = bufAfter2 ? { ybase: bufAfter2.ybase, y: bufAfter2.y, len: bufAfter2.lines?.length } : null;
              console.log('[DOFIT-2] after fit rows=' + r2 + ' cols=' + c2 + ' buf=' + JSON.stringify(after2));
              if (!c2 || !r2 || !isFinite(c2) || !isFinite(r2)) return;
              if (r2 > prevRows2) applyXtermGrowFix(e2.term, prevRows2);
              const p = pendingResize.get(activeTermId);
              if (!p || p.cols !== c2 || p.rows !== r2) {
                pendingResize.set(activeTermId, { cols: c2, rows: r2 });
                return; // 아직 흔들림 — 다음 호출에 처리
              }
              const lst = lastResizeMap.get(activeTermId);
              if (lst && lst.cols === c2 && lst.rows === r2) return;
              lastResizeMap.set(activeTermId, { cols: c2, rows: r2 });
              (window as any).__lastResizeTime = (window as any).__lastResizeTime || {};
              (window as any).__lastResizeTime[activeTermId] = Date.now();
              if (ptyConnected.has(activeTermId)) schedulePtyResize(activeTermId, c2, r2);
              else window.api?.resizeSSH?.(activeTermId, c2, r2);
            } catch {}
          }, 200);
          return;
        }
        // pending 과 동일 → 안정화 확인됨, SIGWINCH 송신
        lastResizeMap.set(activeTermId, { cols: newCols, rows: newRows });
        if (ptyConnected.has(activeTermId)) {
          schedulePtyResize(activeTermId, newCols, newRows);
        } else {
          window.api?.resizeSSH?.(activeTermId, newCols, newRows);
        }
      } catch {}
    };

    const debouncedFit = () => {
      // 즉시 drop window 활성화 — doFit 의 80ms debounce 대기 동안 도착하는 ConPTY repaint 도 차단되도록.
      // maximize/restore 같이 PSReadLine 이 OS 레벨 이벤트로 먼저 redraw 를 보낼 때 보호.
      if (activeTermId && ptyConnected.has(activeTermId)) {
        ptyDropRepaintUntil.set(activeTermId, Date.now() + PTY_RESIZE_DEBOUNCE_MS + PTY_DROP_WINDOW_MS);
      }
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(doFit, 80);
    };

    const ro = new ResizeObserver(debouncedFit);
    ro.observe(containerRef.current);
    window.addEventListener('resize', debouncedFit);

    // 포커스 / mousedown 이벤트 시 즉시 사이즈 동기화 (debounce 회피)
    // — vi 등 풀스크린 앱이 사용자가 명령 입력 직전에 정확한 PTY 사이즈를 받도록
    const forceSyncNow = () => {
      if (resizeTimer) { clearTimeout(resizeTimer); resizeTimer = null; }
      doFit();
    };
    const el = containerRef.current;
    el?.addEventListener('mousedown', forceSyncNow, true);
    el?.addEventListener('focusin', forceSyncNow);
    // 윈도우 focus / 가시성 변경 시에도 보정 — 다른 창 갔다 돌아왔을 때 vi 작게 떠 있던 거 복구
    window.addEventListener('focus', forceSyncNow);
    document.addEventListener('visibilitychange', forceSyncNow);

    // 초기 fit — 이 termId 가 한 번이라도 resize 송신된 적 있으면 단일 fit (1번), 아니면 다단계
    const hasPrevResize = lastResizeMap.has(activeTermId);
    // 이미 사이즈 알려진 term 의 탭 전환 시 — 500ms cooldown 으로 SIGWINCH cascade 차단
    if (hasPrevResize) fitCooldownUntil.set(activeTermId, Date.now() + 500);
    const timers = hasPrevResize
      ? [setTimeout(doFit, 600)]
      : [100, 300, 700, 1200].map(ms => setTimeout(doFit, ms));
    setTimeout(() => { safeTermFocus(getOrCreateTerm(activeTermId).term); }, 100);

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', debouncedFit);
      window.removeEventListener('focus', forceSyncNow);
      document.removeEventListener('visibilitychange', forceSyncNow);
      el?.removeEventListener('mousedown', forceSyncNow, true);
      el?.removeEventListener('focusin', forceSyncNow);
      timers.forEach(clearTimeout);
      if (resizeTimer) clearTimeout(resizeTimer);
    };
  }, [activeTermId]);

  const [dropZone, setDropZone] = useState<DropZone | null>(null);
  const [miniCtx, setMiniCtx] = useState<{ x: number; y: number; termId: string; name: string } | null>(null);
  const [moveWorkspaceCtx, setMoveWorkspaceCtx] = useState<{ x: number; y: number; termId: string } | null>(null);
  const [termCtx, setTermCtx] = useState<{ x: number; y: number } | null>(null);
  const [encodingCtx, setEncodingCtx] = useState<{ x: number; y: number; current: string } | null>(null);
  const [themePickerCtx, setThemePickerCtx] = useState<{ x: number; y: number; current: string } | null>(null);
  const [scrollbackDialog, setScrollbackDialog] = useState<{ value: string } | null>(null);
  const [multiPaste, setMultiPaste] = useState<{ termId: string; text: string } | null>(null); void multiPaste;
  const [shellMenu, setShellMenu] = useState<{ x: number; y: number } | null>(null);
  const [fontDialog, setFontDialog] = useState<{ termId: string; family: string; size: number; initialFamily: string; initialSize: number } | null>(null);
  const showMultiLinePasteDialog = (tid: string, text: string) => {
    setMultiPaste({ termId: tid, text });
    // BrowserWindow 모달 직접 띄움 (인라인 모달은 더 이상 사용 안 함)
    try {
      const entry = termStore.get(tid);
      entry?.term?.blur?.();
    } catch {}
    try { (window as any).api?.pasteModalOpen?.(tid, text); } catch {}
  };
  const [renamingTermId, setRenamingTermId] = useState<string | null>(null);
  // 수동 더블클릭 감지 — 첫 클릭이 layout 재렌더를 유발해 native dblclick 이 발화 안 하는 케이스 보강
  const lastClickRef = useRef<{ termId: string; at: number } | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // 미니탭바 우측 패널 컨트롤(분할/플로팅/투명도) 표시 토글 — 기본 숨김
  const [showPanelControls, setShowPanelControls] = useState(false);
  const panelControlsWrapRef = useRef<HTMLDivElement>(null);
  // 바깥 클릭 시 패널 컨트롤 팝업 닫기
  useEffect(() => {
    if (!showPanelControls) return;
    const handler = (e: MouseEvent) => {
      if (panelControlsWrapRef.current && !panelControlsWrapRef.current.contains(e.target as Node)) {
        setShowPanelControls(false);
      }
    };
    document.addEventListener('mousedown', handler, true);
    return () => document.removeEventListener('mousedown', handler, true);
  }, [showPanelControls]);
  // 활성 미니탭의 PWD 자동추적 상태 (main 에서 hook 설치/제거 시 자동 갱신)
  const [autoTrackOn, setAutoTrackOn] = useState<boolean>(getTermAutoTrack(activeTermId || ''));
  useEffect(() => {
    setAutoTrackOn(getTermAutoTrack(activeTermId || ''));
    const unsub = subscribeAutoTrack((tid, v) => {
      if (tid === activeTermId) setAutoTrackOn(v);
    });
    return unsub;
  }, [activeTermId]);

  return (
    <div
      style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden', position: 'relative' }}
      onMouseDownCapture={() => onSelect?.(nodeId)}
      onDragOver={e => {
        if (e.dataTransfer.types.includes('text/mini-session') || e.dataTransfer.types.includes('text/session-id')) {
          e.preventDefault();
          e.stopPropagation();
          if (e.dataTransfer.types.includes('text/mini-session')) {
            const zone = getDropZone(e, e.currentTarget as HTMLElement);
            setDropZone(prev => prev === zone ? prev : zone);
          } else {
            setDropZone('center');
          }
        }
      }}
      onDragLeave={e => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropZone(null);
      }}
      onDrop={e => {
        // 세션 목록에서 드래그 → 패널에 연결
        const sessId = e.dataTransfer?.getData('text/session-id');
        if (sessId) {
          e.preventDefault();
          e.stopPropagation();
          setDropZone(null);
          onConnectDrop?.(nodeId, sessId);
          return;
        }
        const raw = e.dataTransfer?.getData('text/mini-session');
        if (raw) {
          e.preventDefault();
          e.stopPropagation();
          const { nodeId: fromNodeId, termId } = JSON.parse(raw);
          if (fromNodeId === nodeId && panel.sessions.length <= 1) { setDropZone(null); return; }
          const zone = getDropZone(e, e.currentTarget as HTMLElement);
          if (zone === 'center') {
            if (fromNodeId !== nodeId) onMoveSession?.(fromNodeId, termId, nodeId);
          } else {
            onSplitMoveSession?.(fromNodeId, termId, nodeId, zone);
          }
        }
        setDropZone(null);
      }}
    >
      {dropZone && <div className={`drop-zone-overlay drop-zone-${dropZone}`} />}
      <div
        className="panel-header"
        onClick={() => onSelect?.(nodeId)}
        onDragOver={e => {
          if (e.dataTransfer.types.includes('text/mini-session')) { e.preventDefault(); e.stopPropagation(); setDropZone('center'); }
        }}
        onDrop={e => {
          const raw = e.dataTransfer?.getData('text/mini-session');
          if (raw) {
            e.preventDefault(); e.stopPropagation();
            const { nodeId: fromNodeId, termId } = JSON.parse(raw);
            if (fromNodeId !== nodeId) onMoveSession?.(fromNodeId, termId, nodeId);
          }
          setDropZone(null);
        }}
      >
        {panel.sessions.length > 0 ? (
          <div className="panel-session-tabs-wrapper">
            <div className="panel-session-tabs" data-panel-tabs={nodeId} onWheel={e => {
              e.currentTarget.scrollLeft += e.deltaY > 0 ? 60 : -60;
            }}>
            {panel.sessions.map((sess, idx) => (
              <span
                key={sess.termId}
                className={`panel-session-tab ${idx === panel.activeIdx ? 'active' : ''}`}
                title={sess.sessionName}
                draggable
                onDragStart={e => {
                  e.stopPropagation();
                  e.dataTransfer.setData('text/mini-session', JSON.stringify({ nodeId, termId: sess.termId, idx }));
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={e => {
                  if (e.dataTransfer.types.includes('text/mini-session')) { e.preventDefault(); e.stopPropagation(); }
                }}
                onDrop={e => {
                  const raw = e.dataTransfer?.getData('text/mini-session');
                  if (!raw) return;
                  e.preventDefault(); e.stopPropagation();
                  const data = JSON.parse(raw);
                  if (data.nodeId === nodeId && data.idx !== undefined && data.idx !== idx) {
                    onReorderSession?.(nodeId, data.idx, idx);
                  } else if (data.nodeId !== nodeId) {
                    onMoveSession?.(data.nodeId, data.termId, nodeId);
                  }
                  setDropZone(null);
                }}
                onClick={e => {
                  e.stopPropagation();
                  // 수동 더블클릭 — 같은 미니탭에서 500ms 내 2번째 클릭이면 복제 실행
                  // (native onDoubleClick 은 layout 재렌더 시 발화 안 하는 케이스가 있어 수동 감지로 통일)
                  const now = Date.now();
                  const prev = lastClickRef.current;
                  if (prev && prev.termId === sess.termId && now - prev.at < 500) {
                    lastClickRef.current = null;
                    onDuplicateSession?.(nodeId, sess.termId);
                    return;
                  }
                  lastClickRef.current = { termId: sess.termId, at: now };
                  onSwitchSession?.(nodeId, idx);
                }}
                onAuxClick={e => { if (e.button === 1) { e.preventDefault(); e.stopPropagation(); window.api?.disconnectSSH?.(sess.termId); onCloseSession?.(nodeId, sess.termId); } }}
                onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setMiniCtx({ x: e.clientX, y: e.clientY, termId: sess.termId, name: sess.sessionName }); }}
              >
                <span className={`panel-status-dot ${globalConnected.has(sess.termId) ? 'connected' : 'disconnected'}`} />
                {renamingTermId === sess.termId ? (
                  <input
                    className="mini-tab-rename-input"
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onBlur={() => { if (renameValue.trim()) onRenameSession?.(nodeId, sess.termId, renameValue.trim()); setRenamingTermId(null); }}
                    onKeyDown={e => {
                      e.stopPropagation();
                      if (e.key === 'Enter') { if (renameValue.trim()) onRenameSession?.(nodeId, sess.termId, renameValue.trim()); setRenamingTermId(null); }
                      if (e.key === 'Escape') setRenamingTermId(null);
                    }}
                    autoFocus
                    onClick={e => e.stopPropagation()}
                  />
                ) : (
                  <>
                    <span className="panel-session-tab-name">{sess.sessionName}</span>
                    <span className="panel-session-tab-tooltip">{sess.sessionName}</span>
                  </>
                )}
                <span className="panel-session-tab-close" onClick={e => {
                  e.stopPropagation();
                  window.api?.disconnectSSH?.(sess.termId);
                  onCloseSession?.(nodeId, sess.termId);
                }}>&times;</span>
              </span>
            ))}
            <span className="panel-session-tab-add" onClick={e => { e.stopPropagation(); onAddSession?.(nodeId); }} title={t('ui.newSession')}>+</span>
            {availableShells && availableShells.length > 0 && (
              <span className="panel-session-tab-add panel-shell-btn" onClick={e => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setShellMenu(prev => prev ? null : { x: r.left, y: r.bottom }); }} title={t('ui.shellSelect')}>∨</span>
            )}
          </div>
            <button className="panel-tabs-scroll-btn" onClick={() => {
              const el = document.querySelector(`[data-panel-tabs="${nodeId}"]`);
              if (el) el.scrollBy({ left: -100, behavior: 'smooth' });
            }}>‹</button>
            <button className="panel-tabs-scroll-btn" onClick={() => {
              const el = document.querySelector(`[data-panel-tabs="${nodeId}"]`);
              if (el) el.scrollBy({ left: 100, behavior: 'smooth' });
            }}>›</button>
          </div>
        ) : (
          <span className="panel-header-label" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            Empty
            <span className="panel-session-tab-add" onClick={e => { e.stopPropagation(); onAddSession?.(nodeId); }} title={t('ui.newSession')}>+</span>
            {availableShells && availableShells.length > 0 && (
              <span className="panel-session-tab-add panel-shell-btn" onClick={e => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setShellMenu(prev => prev ? null : { x: r.left, y: r.bottom }); }} title={t('ui.shellSelect')}>∨</span>
            )}
          </span>
        )}

        <div className="panel-controls-wrap" ref={panelControlsWrapRef}>
        <button
          className={`panel-controls-toggle ${showPanelControls ? 'open' : ''}`}
          onClick={e => { e.stopPropagation(); setShowPanelControls(v => !v); }}
          title={showPanelControls ? t('ui.controlHide') : t('ui.panelControls')}
        >
          <svg className="panel-controls-toggle-icon" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
            <line x1="2" y1="3.5" x2="12" y2="3.5" />
            <circle cx="9" cy="3.5" r="1.5" fill="currentColor" stroke="none" />
            <line x1="2" y1="7" x2="12" y2="7" />
            <circle cx="5" cy="7" r="1.5" fill="currentColor" stroke="none" />
            <line x1="2" y1="10.5" x2="12" y2="10.5" />
            <circle cx="10" cy="10.5" r="1.5" fill="currentColor" stroke="none" />
          </svg>
        </button>
        {showPanelControls && (
          <div className="panel-controls-popup" onClick={e => e.stopPropagation()}>
        {(() => {
          const curPct = Math.round((termOpacity.get(activeTermId || nodeId) ?? 1.0) * 100);
          return (
            <input
              type="range"
              className="panel-opacity-slider"
              min={0}
              max={100}
              step={5}
              value={curPct}
              onClick={e => e.stopPropagation()}
              onMouseDown={e => e.stopPropagation()}
              onChange={e => {
                const val = Number(e.target.value) / 100;
                termOpacity.set(activeTermId || nodeId, val);
                if (activeTermId) applyTermOpacity(activeTermId, containerRef.current);
                else if (containerRef.current) containerRef.current.style.background = `rgba(0,0,0,${val})`;
                forceUpdate(n => n + 1);
              }}
              title={t('ui.transparencyPct', { pct: curPct })}
            />
          );
        })()}
        {(() => {
          const recOn = !!activeTermId && isRecording(activeTermId);
          return (
            <button
              className={`panel-btn panel-btn-rec ${recOn ? 'rec-on' : ''}`}
              onClick={async () => {
                if (!activeTermId) return;
                if (isRecording(activeTermId)) {
                  const r = await stopRecording(activeTermId);
                  if (r.ok && r.path) {
                    try { getOrCreateTerm(activeTermId).term.write(`\r\n\x1b[90m${tt('output.recordEnd', { path: r.path })}\x1b[0m\r\n`); } catch {}
                  }
                } else {
                  const sessName = activeSession?.sessionName || 'terminal';
                  const r = await startRecording(activeTermId, sessName);
                  if (r.ok && r.path) {
                    try { getOrCreateTerm(activeTermId).term.write(`\r\n\x1b[91m${tt('output.recordBegin', { path: r.path })}\x1b[0m\r\n`); } catch {}
                  } else if (r.reason && r.reason !== 'cancelled') {
                    try { getOrCreateTerm(activeTermId).term.write(`\r\n\x1b[91m${tt('output.recordFailed', { reason: r.reason })}\x1b[0m\r\n`); } catch {}
                  }
                }
              }}
              title={recOn ? t('ui.recordStopTitle') : t('ui.recordStartTitle')}
              disabled={!activeTermId}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
                <rect x="1" y="4" width="8" height="6" rx="1" />
                <path d="M9 6.2 L12.5 4.5 L12.5 9.5 L9 7.8 Z" />
                <circle cx="4.5" cy="7" r="1.4" fill={recOn ? 'currentColor' : 'none'} />
              </svg>
            </button>
          );
        })()}
        <button className="panel-btn" onClick={() => onSplit(nodeId, 'row')} title={t('ui.splitHTitle')}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="1" y="1" width="12" height="12" rx="1.5" /><line x1="7" y1="1" x2="7" y2="13" />
          </svg>
        </button>
        <button className="panel-btn" onClick={() => onSplit(nodeId, 'column')} title={t('ui.splitVTitle')}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="1" y="1" width="12" height="12" rx="1.5" /><line x1="1" y1="7" x2="13" y2="7" />
          </svg>
        </button>
        {onSplitWithPicker && (
          <>
            <button className="panel-btn" onClick={() => onSplitWithPicker(nodeId, 'row')} title={t('ui.splitHPickTitle')}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="1" y="1" width="12" height="12" rx="1.5" /><line x1="7" y1="1" x2="7" y2="13" />
                <circle cx="10" cy="10" r="2" fill="currentColor" stroke="none" />
              </svg>
            </button>
            <button className="panel-btn" onClick={() => onSplitWithPicker(nodeId, 'column')} title={t('ui.splitVPickTitle')}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="1" y="1" width="12" height="12" rx="1.5" /><line x1="1" y1="7" x2="13" y2="7" />
                <circle cx="10" cy="10" r="2" fill="currentColor" stroke="none" />
              </svg>
            </button>
          </>
        )}
        <button
          className={`panel-btn ${isFloating ? 'panel-btn-active' : ''}`}
          onClick={() => onToggleFloat?.(nodeId)}
          title={isFloating ? t('ui.floatRestore') : t('ui.floatExpand')}
        >
          {isFloating ? (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="1" y="4" width="9" height="9" rx="1" /><path d="M4 4V1h9v9h-3" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M1 5V1h4 M13 5V1H9 M1 9v4h4 M13 9v4H9" />
            </svg>
          )}
        </button>
        <button
          className={`panel-btn ${autoTrackOn ? 'panel-btn-active' : ''}`}
          onClick={async () => {
            if (!activeTermId) return;
            const newVal = !autoTrackOn;
            setAutoTrackOn(newVal);
            setTermAutoTrack(activeTermId, newVal);
            try { await (window as any).api?.setSSHAutoTrack?.(activeTermId, newVal); } catch {}
            // 파일트리에 알림 — OFF 시 즉시 SFTP 연결 해제하도록
            try { window.dispatchEvent(new CustomEvent('autoTrack-change', { detail: { panelId: activeTermId, enabled: newVal } })); } catch {}
          }}
          title={autoTrackOn ? t('ui.autoTrackOn') : t('ui.autoTrackOff')}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 4 L5 4 L7 2 L12 2 L12 12 L2 12 Z" />
            {autoTrackOn && <circle cx="9" cy="8" r="1.6" fill="currentColor" stroke="none" />}
          </svg>
        </button>
          </div>
        )}
        </div>
        <button
          className="panel-btn panel-btn-close"
          onClick={() => {
            // 미니탭이 2개 이상이면 현재 선택된 미니탭만 닫기, 1개면 패널 자체 닫기.
            if (panel.sessions.length > 1 && activeTermId) {
              window.api?.disconnectSSH?.(activeTermId);
              onCloseSession?.(nodeId, activeTermId);
            } else {
              onClose(nodeId);
            }
          }}
          title="Close"
        >&times;</button>
      </div>
      <div className="panel-terminal-split">
        {(() => {
          // 파일 트리는 워크스페이스 레벨(App.tsx)에서 공통으로 렌더 → 패널 내부에선 표시 안 함
          const canShowTree = false;
          return (
            <>
              {canShowTree && (
                <div className="panel-file-tree" style={{ width: treeWidth }}>
                  <RemoteFileTree
                    termId={activeTermId!}
                    sessionName={activeSession!.sessionName}
                    sessionId={activeSession!.sessionId}
                    initialPath={termCurrentPwd.get(activeTermId!)}
                    onOpenFile={(tid, rp, fn) => onOpenRemoteFile?.(tid, rp, fn)}
                    onAttachToClaude={(tid, rp, fn, isDir) => onAttachToClaude?.(tid, rp, fn, isDir)}
                  />
                  <div
                    className="panel-file-tree-resizer"
                    title={t('ui.resizeHandle')}
                    onMouseDown={e => {
                      e.preventDefault();
                      const startX = e.clientX;
                      const startW = treeWidth;
                      const onMove = (ev: MouseEvent) => {
                        const dx = ev.clientX - startX;
                        const w = Math.max(160, Math.min(800, startW + dx));
                        onTreeWidthChange?.(w);
                      };
                      const onUp = () => {
                        window.removeEventListener('mousemove', onMove);
                        window.removeEventListener('mouseup', onUp);
                        window.dispatchEvent(new Event('resize'));
                      };
                      window.addEventListener('mousemove', onMove);
                      window.addEventListener('mouseup', onUp);
                    }}
                    onDoubleClick={() => onTreeWidthChange?.(240)}
                  />
                </div>
              )}
              <div ref={containerRef} className="panel-terminal-area" onMouseDown={() => onSelect?.(nodeId)} />
            </>
          );
        })()}
      </div>
      {miniCtx && (
        <ContextMenu
          x={miniCtx.x} y={miniCtx.y}
          onClose={() => setMiniCtx(null)}
          items={[
            { label: t('menu.renameTab'), onClick: () => { setRenamingTermId(miniCtx.termId); setRenameValue(miniCtx.name); } },
            { label: t('menu.editSession'), onClick: () => {
              const info = termSessionMap.get(miniCtx.termId);
              if (info?.sessionId || info?.quickSession) {
                // 전역 이벤트로 App.tsx 가 SessionEditor 모달 띄우도록
                window.dispatchEvent(new CustomEvent('open-session-editor', { detail: { sessionId: info.sessionId, quickSession: info.quickSession, sessionName: info.sessionName, termId: miniCtx.termId } }));
              }
            } },
            { label: t('menu.duplicateSession'), onClick: () => { onDuplicateSession?.(nodeId, miniCtx.termId); } },
            { label: t('menu.reconnectSession'), onClick: async () => {
              const tid = miniCtx.termId;
              const info = termSessionMap.get(tid);
              if (!info) return;
              try {
                // 재연결 상태 초기화 + 기존 연결 종료
                reconnectUserCancelled.delete(tid);
                if (globalConnected.has(tid) || sshConnecting.has(tid)) {
                  window.api?.disconnectSSH?.(tid);
                  await new Promise(res => setTimeout(res, 300));
                }
                sshConnecting.delete(tid);
                globalConnected.delete(tid);
                // reset-state IPC로 main.ts 상태도 초기화
                try { await (window as any).api?.resetSSHState?.(tid); } catch {}
                sshConnecting.add(tid);
                const entry = termStore.get(tid);
                const cols = entry ? (entry.term as any).cols : 80;
                const rows = entry ? (entry.term as any).rows : 24;
                if (info.sessionId) {
                  await window.api?.connectSSH?.(tid, info.sessionId, cols, rows);
                } else if (info.quickSession) {
                  quickConnectPending.add(tid);
                  // 빠른연결 재시도 — 자격증명 부족하면 prompt 모달로 입력 받기 (취소 후 재연결 케이스 지원)
                  const tryConnect = async (sessInfo: any): Promise<void> => {
                    const r = await (window as any).api?.quickConnectSSH?.(tid, sessInfo, cols, rows);
                    if (r === 'need-credentials' || r === 'need-password') {
                      const needUsername = r === 'need-credentials';
                      window.dispatchEvent(new CustomEvent('ssh-password-prompt', {
                        detail: {
                          termId: tid,
                          sessionId: '',
                          hostHint: sessInfo.host,
                          userHint: sessInfo.username,
                          needUsername,
                          resolve: (result: any) => {
                            if (result === null) {
                              quickConnectPending.delete(tid);
                              sshConnecting.delete(tid);
                              return;
                            }
                            let nextUsername = sessInfo.username;
                            let nextPassword = '';
                            if (typeof result === 'string') nextPassword = result;
                            else if (result && typeof result === 'object') {
                              nextUsername = result.username || sessInfo.username;
                              nextPassword = result.password || '';
                            }
                            const next: any = {
                              ...sessInfo,
                              username: nextUsername,
                              name: nextUsername ? `${nextUsername}@${sessInfo.host}` : sessInfo.host,
                              auth: { type: 'password', password: nextPassword },
                            };
                            // 새 자격증명을 termSessionMap 에 저장
                            registerTermSession(tid, '', nextUsername ? `${nextUsername}@${sessInfo.host}` : sessInfo.host, sessInfo.host, next);
                            tryConnect(next).catch(() => {});
                          },
                        },
                      }));
                    }
                  };
                  tryConnect(info.quickSession).catch(() => {});
                }
              } catch {}
            }},
            ...(onMoveSessionToWorkspace ? [{
              label: t('menu.moveToWorkspace'),
              onClick: () => {
                setMoveWorkspaceCtx({ x: miniCtx.x, y: miniCtx.y, termId: miniCtx.termId });
              },
            }] : []),
            { label: t('menu.close'), onClick: () => { window.api?.disconnectSSH?.(miniCtx.termId); onCloseSession?.(nodeId, miniCtx.termId); } },
          ]}
        />
      )}
      {moveWorkspaceCtx && onMoveSessionToWorkspace && (
        <ContextMenu
          x={moveWorkspaceCtx.x} y={moveWorkspaceCtx.y}
          onClose={() => setMoveWorkspaceCtx(null)}
          items={[
            ...((workspaceList || []).filter(w => w.id !== currentWorkspaceId).map(w => ({
              label: `→ ${w.title}`,
              onClick: () => onMoveSessionToWorkspace(nodeId, moveWorkspaceCtx.termId, w.id),
            }))),
            { label: t('menu.newWorkspace'), onClick: () => onMoveSessionToWorkspace(nodeId, moveWorkspaceCtx.termId, '__new__') },
          ]}
        />
      )}
      {/* 여러 줄 붙여넣기 — 별도 BrowserWindow 로 띄워짐 (main process 가 관리) */}
      {termCtx && activeTermId && (
        <ContextMenu
          x={termCtx.x} y={termCtx.y}
          onClose={() => setTermCtx(null)}
          items={[
            { label: t('menu.copy'), onClick: () => {
              const entry = termStore.get(activeTermId);
              if (!entry) return;
              const settings = getTerminalSettings();
              let sel = entry.term.getSelection();
              if (!sel) return;
              if (settings.trimTrailingWhitespace) sel = sel.split('\n').map(l => l.trimEnd()).join('\n');
              if (!settings.includeTrailingNewline) sel = sel.replace(/\n$/, '');
              navigator.clipboard.writeText(sel).catch(() => {});
            }},
            { label: t('menu.paste'), onClick: () => {
              const tid = activeTermId;
              navigator.clipboard.readText().then(text => {
                if (!text) return;
                const settings = getTerminalSettings();
                if (text.includes('\n') && settings.multiLinePaste === 'dialog') {
                  showMultiLinePasteDialog(tid, text);
                } else {
                  // vi insert 모드 호환을 위해 ENTER 는 \r 로 송신, bracketed paste 래핑 회피
                  const fixed = text.replace(/\r?\n/g, '\r');
                  try {
                    if (ptyConnected.has(tid)) (window as any).api.ptyInput(tid, fixed);
                    else (window as any).api.sendSSHInput(tid, fixed);
                  } catch {}
                  setTimeout(() => focusTerm(tid), 0);
                }
              }).catch(() => {});
            }},
            { label: t('menu.selectAll'), onClick: () => selectAllInTerm(activeTermId) },
            { label: t('menu.find'), onClick: () => {
              try { window.dispatchEvent(new CustomEvent('open-search')); } catch {}
            }},
            { label: t('menu.clearScreen'), onClick: () => { clearScreenInTerm(activeTermId); setTimeout(() => focusTerm(activeTermId), 0); } },
            { label: t('menu.clearScrollbackBuffer'), onClick: () => { clearScrollbackInTerm(activeTermId); setTimeout(() => focusTerm(activeTermId), 0); } },
            { label: t('menu.changeScrollback'), onClick: () => {
              const cur = getScrollbackForTerm(activeTermId);
              setScrollbackDialog({ value: String(cur) });
            }},
            { label: t('menu.changeEncoding'), onClick: async () => {
              let current = 'utf-8';
              try { current = (await (window as any).api?.getSSHEncoding?.(activeTermId)) || 'utf-8'; } catch {}
              setEncodingCtx({ x: termCtx.x, y: termCtx.y, current: current.toLowerCase() });
            }},
            { label: t('menu.fontDots'), onClick: () => {
              const entry = termStore.get(activeTermId);
              const curFamily = entry ? (entry.term.options.fontFamily || '') : '';
              const curSize = entry ? (entry.term.options.fontSize || 14) : 14;
              setFontDialog({ termId: activeTermId, family: curFamily, size: curSize, initialFamily: curFamily, initialSize: curSize });
            }},
            { label: t('menu.changeTheme'), onClick: () => {
              const cur = termThemeCache.get(activeTermId) || '';
              setThemePickerCtx({ x: termCtx.x, y: termCtx.y, current: cur });
            }},
            { label: t('menu.editSessionDots'), onClick: () => {
              const info = termSessionMap.get(activeTermId);
              if (info?.sessionId || info?.quickSession) {
                window.dispatchEvent(new CustomEvent('open-session-editor', { detail: { sessionId: info.sessionId, quickSession: info.quickSession, sessionName: info.sessionName, termId: activeTermId } }));
              }
            }},
          ]}
        />
      )}
      {encodingCtx && activeTermId && (
        <ContextMenu
          x={encodingCtx.x} y={encodingCtx.y}
          onClose={() => setEncodingCtx(null)}
          items={(['utf-8','euc-kr','cp949','shift_jis','gb2312','gbk','big5','iso-8859-1']).map(enc => ({
            label: (encodingCtx.current === enc ? '● ' : '   ') + enc,
            onClick: async () => {
              try {
                await (window as any).api?.setSSHEncoding?.(activeTermId, enc);
              } catch {}
            },
          }))}
        />
      )}
      {themePickerCtx && activeTermId && (
        <ContextMenu
          x={themePickerCtx.x} y={themePickerCtx.y}
          onClose={() => setThemePickerCtx(null)}
          items={terminalThemes.map(t => ({
            label: (themePickerCtx.current === t.name ? '● ' : '   ') + t.name,
            onClick: () => {
              applyThemeToTerm(activeTermId, t.name);
            },
          }))}
        />
      )}
      {scrollbackDialog && activeTermId && ReactDOM.createPortal(
        (() => {
          const closeAndFocus = () => { setScrollbackDialog(null); setTimeout(() => focusTerm(activeTermId), 0); };
          return (
            <div className="session-editor-backdrop">
              <div className="session-editor" style={{ width: 320 }} onClick={e => e.stopPropagation()}>
                <h3>{t('dialogs.scrollbackTitle')}</h3>
                <div style={{ padding: '8px 0', color: '#aaa', fontSize: 12 }}>{t('dialogs.scrollbackHint')}</div>
                <input
                  type="number"
                  autoFocus
                  min={1000}
                  max={1000000}
                  step={1000}
                  value={scrollbackDialog.value}
                  onChange={e => setScrollbackDialog({ value: e.target.value })}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      const n = Math.max(1000, Math.min(1000000, Number(scrollbackDialog.value) || 0));
                      if (n) applyScrollbackToTerm(activeTermId, n);
                      closeAndFocus();
                    } else if (e.key === 'Escape') {
                      closeAndFocus();
                    }
                  }}
                  style={{ width: '100%', background: '#1a1a1a', color: '#eee', border: '1px solid #333', borderRadius: 4, padding: '8px', fontSize: 14, fontFamily: 'monospace', boxSizing: 'border-box' }}
                />
                <div className="session-editor-actions" style={{ marginTop: 12 }}>
                  <button className="btn-cancel" onClick={closeAndFocus}>{t('dialogs.cancel')}</button>
                  <button className="btn-save" onClick={() => {
                    const n = Math.max(1000, Math.min(1000000, Number(scrollbackDialog.value) || 0));
                    if (n) applyScrollbackToTerm(activeTermId, n);
                    closeAndFocus();
                  }}>{t('dialogs.apply')}</button>
                </div>
              </div>
            </div>
          );
        })(),
        document.body
      )}
      {fontDialog && ReactDOM.createPortal(
        (() => {
          const revertAndClose = () => {
            applyFontToTerm(fontDialog.termId, fontDialog.initialFamily || undefined, fontDialog.initialSize);
            setFontDialog(null);
          };
          return (
        <div className="session-editor-backdrop">
          <div className="session-editor" onClick={e => e.stopPropagation()} style={{ width: 360 }}>
            <h3>{t('dialogs.fontTitle')}</h3>
            <div style={{ marginBottom: 12 }}>
              <div style={{ color: '#ccc', fontSize: 12, marginBottom: 4 }}>{t('dialogs.fontLabel')}</div>
              <select
                style={{ width: '100%', background: '#1a1a1a', color: '#eee', border: '1px solid #333', borderRadius: 4, padding: '6px 8px', fontSize: 13, cursor: 'pointer' }}
                value={fontDialog.family}
                onChange={e => {
                  const f = e.target.value;
                  setFontDialog(prev => prev ? { ...prev, family: f } : null);
                  applyFontToTerm(fontDialog.termId, f || undefined, fontDialog.size);
                }}
              >
                <option value="">{t('dialogs.fontDefault')}</option>
                {(() => {
                  const fonts = ['Cascadia Mono','Cascadia Code','Consolas','Courier New','D2Coding','D2Coding ligature','Fira Code','Fira Mono','JetBrains Mono','Source Code Pro','Ubuntu Mono','IBM Plex Mono','Hack','Inconsolata','Noto Sans Mono','Roboto Mono','NanumGothicCoding','Malgun Gothic','Lucida Console','DejaVu Sans Mono'];
                  return fonts.filter(f => { try { return document.fonts.check(`12px "${f}"`); } catch { return false; } })
                    .map(f => <option key={f} value={f}>{f}</option>);
                })()}
              </select>
            </div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ color: '#ccc', fontSize: 12, marginBottom: 4 }}>{t('dialogs.sizeLabel')}</div>
              <input type="number" min={8} max={40} step={1}
                style={{ width: 80, background: '#1a1a1a', color: '#eee', border: '1px solid #333', borderRadius: 4, padding: '6px 8px', fontSize: 13, fontFamily: 'monospace' }}
                value={fontDialog.size}
                onChange={e => {
                  const s = Math.max(8, Math.min(40, Number(e.target.value) || 14));
                  setFontDialog(prev => prev ? { ...prev, size: s } : null);
                  applyFontToTerm(fontDialog.termId, fontDialog.family || undefined, s);
                }}
              />
            </div>
            <div className="session-editor-actions">
              <button className="btn-cancel" onClick={revertAndClose}>{t('dialogs.cancel')}</button>
              <button className="btn-save" onClick={() => setFontDialog(null)}>{t('dialogs.ok')}</button>
            </div>
          </div>
        </div>
          );
        })(),
        document.body
      )}
      {shellMenu && availableShells && availableShells.length > 0 && (
        <ContextMenu
          x={shellMenu.x} y={shellMenu.y}
          onClose={() => setShellMenu(null)}
          items={availableShells.map(sh => ({
            label: `${sh.icon || ''} ${sh.name}`.trim(),
            onClick: () => onAddSession?.(nodeId, sh.name, sh.path),
          }))}
        />
      )}
    </div>
  );
};
