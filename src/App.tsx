// src/App.tsx
import { useState, useCallback, useEffect, useRef, useMemo, Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { FixedSizeList as VList, ListChildComponentProps } from 'react-window';
import './App.css';
import { TabBar } from './components/TabBar';
import { MenuBar } from './components/MenuBar';
import type { MenuDef } from './components/MenuBar';
import { Layout } from './components/Layout';
import { SearchBar } from './components/SearchBar';
import { FileExplorer } from './components/FileExplorer';
import { FileEditor } from './components/FileEditor';
import { SqlToolWorkspace } from './components/SqlToolWorkspace';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ClaudeChat } from './components/ClaudeChat';
import { RemoteFileTree } from './components/RemoteFileTree';
import { BrowserPane } from './components/BrowserPane';
import { CompareWorkspace } from './components/CompareWorkspace';
import { LogAnalyzer } from './components/LogAnalyzer';
import { VpnWorkspace } from './components/VpnWorkspace';
import { TranslationEditor } from './components/TranslationEditor';
import { QuickConnectBar, QuickConnectResult } from './components/QuickConnectDialog';
import { StatusBar } from './components/StatusBar';
import { resetTermConnectState, clearScrollbackInTerm, clearScreenInTerm, clearAllInTerm, applyThemeToAll, applyThemeToTerm, applyFontToTerm, applyFontToAll, getCurrentThemeName, registerTermSession, getTermSessionInfo, getWordSeparator, setWordSeparator, refitAllTerms, applyScrollbackToAll, applyScrollbackToTerm, cloneTermStyle, isTermConnected, isTermConnecting, isTermPty, subscribeConnectedChange, focusTerm, pasteToTerm, getSelectionFromTerm, selectAllInTerm, promptPasswordAndConnect, startInitialConnectWatchdog, getCurrentPwdForTerm, refitTerm, searchInTerm, searchNextInTerm, searchPrevInTerm, clearSearchInTerm, highlightAllMatches, clearHighlights, searchFromTop, getAllTermIds, applyCursorStyleToTerm, markQuickConnectPending, clearQuickConnectPending, writeToTerm, isRecording, stopRecording, recordingState } from './components/TerminalPanel';
import { marked } from 'marked';
// @ts-ignore — vite ?raw 로 docs/MANUAL.md 를 번들 문자열로 임베드
import manualMd from '../docs/MANUAL.md?raw';
import { getClaudeFontFamily, getClaudeFontSize, setClaudeFontFamily, setClaudeFontSize, applyClaudeFontVars } from './utils/claudeFont';
import { getTerminalSettings, saveTerminalSettings, TerminalSettings } from './utils/terminalSettings';
import { loadKeybindings, matchKeybinding, getKeybindings, getKeybinding, DEFAULT_KEYBINDINGS, KEYBINDING_LABELS, keyEventToCombo, setKeybindingListening, formatKeyComboForOS, formatKeyTextForOS, IS_MAC } from './utils/keybindings';
import { getThemeList } from './utils/terminalThemes';
import { SessionList } from './components/SessionList';
import { SessionEditor } from './components/SessionEditor';
import {
  LayoutNode,
  PanelSession,
  splitNode,
  splitNodeWithSessions,
  addSessionsAsTile,
  removeLeafNode,
  addSessionToPanel,
  appendSessionsToPanel,
  removeSessionFromPanel,
  switchPanelSession,
  reorderPanelSession,
  countLeaves,
  collectAllSessions,
  findFirstLeafId,
  findEmptyLeafId,
  countSessionInTree,
  createInitialLayout,
} from './utils/layoutUtils';

export type { LayoutNode, ContainerNode, LeafNode, Panel, PanelSession } from './utils/layoutUtils';

export type TabId = string;
export type TabType = 'terminal' | 'fileExplorer' | 'fileEditor' | 'sqlTool' | 'browser' | 'compare' | 'logAnalyzer' | 'vpn' | 'i18nEditor';
export type Tab = { id: TabId; title: string; customTitle?: boolean; layout: LayoutNode; type?: TabType; editor?: { termId: string; remotePath: string; fileName: string }; sqlTool?: { sessionId: string; sessionName: string }; browser?: { url: string }; compare?: {}; logAnalyzer?: {}; vpn?: {}; i18nEditor?: {} };

// 일괄전송 히스토리 (앱 실행 중 유지, 최대 50개)
const broadcastHistory: string[] = [];
const MAX_BROADCAST_HISTORY = 50;
function addBroadcastHistory(text: string) {
  if (!text.trim()) return;
  const idx = broadcastHistory.indexOf(text);
  if (idx !== -1) broadcastHistory.splice(idx, 1);
  broadcastHistory.unshift(text);
  if (broadcastHistory.length > MAX_BROADCAST_HISTORY) broadcastHistory.pop();
}

function App() {
  const { t: tm } = useTranslation('menu');
  const { t: ttab } = useTranslation('tabBar');
  const { t: ta } = useTranslation('about');
  const { t: to } = useTranslation('options');
  const { t: tk } = useTranslation('keybindings');
  const { t: tfe } = useTranslation('fileExplorer');
  const { t: tterm } = useTranslation('terminal');
  const { t: tb } = useTranslation('broadcast');
  const [tabs, setTabs] = useState<Tab[]>(() => {
    return [{ id: 'tab-1', title: 'Workspace 1', layout: createInitialLayout('tab-1') }];
  });
  const [activeTabId, setActiveTabId] = useState<TabId>('tab-1');
  // 탭별로 선택된 패널 ID 기억
  const [selectedPanelByTab, setSelectedPanelByTab] = useState<Record<string, string | null>>({});
  const selectedPanelId = selectedPanelByTab[activeTabId] ?? null;
  const setSelectedPanelId = useCallback((id: string | null) => {
    setSelectedPanelByTab(prev => ({ ...prev, [activeTabId]: id }));
  }, [activeTabId]);

  // 앱 구동 시 + 탭 전환 시 해당 탭의 패널 자동 선택 (선택된 패널이 현재 탭에 없을 때)
  useEffect(() => {
    const curTab = tabs.find(t => t.id === activeTabId);
    if (!curTab) return;
    // 현재 selectedPanelId가 이 탭의 레이아웃 안에 있는지 확인
    const findLeaf = (node: any, id: string | null): any => {
      if (!id) return null;
      if (node.type === 'leaf') return node.id === id ? node : null;
      for (const c of node.children) { const r = findLeaf(c, id); if (r) return r; }
      return null;
    };
    const inCurTab = selectedPanelId && findLeaf(curTab.layout, selectedPanelId);
    if (inCurTab) return;
    // 현재 탭의 첫 번째 leaf 찾기
    const findFirstLeaf = (node: any): any => {
      if (node.type === 'leaf') return node;
      for (const c of node.children) { const r = findFirstLeaf(c); if (r) return r; }
      return null;
    };
    const leaf = findFirstLeaf(curTab.layout);
    if (leaf) setSelectedPanelId(leaf.id);
  }, [activeTabId, tabs]);

  // 선택된 패널 변경 시 또는 탭 전환 시 해당 패널의 활성 터미널에 포커스
  useEffect(() => {
    if (!selectedPanelId) return;
    const curTab = tabs.find(t => t.id === activeTabId);
    if (!curTab) return;
    // 비-터미널 탭(파일비교/브라우저/로그분석/SQL/파일전송/파일에디터)은 phantom 더미 세션이 있어도
    // 사용자가 그 탭의 입력창에 입력 중일 수 있으므로 자동 포커스 스틸 금지 — 입력 차단 버그 회피
    if (curTab.type && curTab.type !== 'terminal') return;
    const findLeaf = (node: any, id: string): any => {
      if (node.type === 'leaf') return node.id === id ? node : null;
      for (const c of node.children) { const r = findLeaf(c, id); if (r) return r; }
      return null;
    };
    const leaf = findLeaf(curTab.layout, selectedPanelId);
    if (leaf && leaf.panel.sessions.length > 0) {
      const tid = leaf.panel.sessions[leaf.panel.activeIdx]?.termId;
      if (tid) {
        // 여러 번 시도 (DOM 렌더링 타이밍 대응)
        [50, 150, 300, 500].forEach(ms => setTimeout(() => focusTerm(tid), ms));
      }
    }
  }, [selectedPanelId, activeTabId]);
  const [showSearch, setShowSearch] = useState(false);
  // 비밀번호 저장 권유 모달 — 'ssh-fresh-password-success' 이벤트로 트리거됨
  const [savePwdPrompt, setSavePwdPrompt] = useState<{ termId: string; sessionId: string; password: string; hostHint?: string } | null>(null);
  // 비밀번호 입력 모달들 — 동시에 여러 세션 비밀번호 입력 가능 (단일 모달이 다른 세션
  // 더블클릭을 막지 않도록). 배경은 pointer-events:none 으로 통과시킴.
  type AskPwdItem = { termId: string; sessionId: string; hostHint?: string; userHint?: string; needUsername?: boolean; resolve: (result: any) => void; input: string; userInput: string };
  const [askPwdPrompts, setAskPwdPrompts] = useState<AskPwdItem[]>([]);
  // portal 마운트 타깃(.layout-leaf) 이 활성 세션 변경 후 한 tick 늦게 등장할 수 있어
  // 첫 렌더에서 targetEl=null 이면 다음 frame 에 재시도하기 위한 강제 리렌더 tick.
  const [, setLayoutTick] = useState(0);
  // activeTab.layout 의 active idx 변경 감지를 위한 키 — 모달 표시 위치 갱신용
  // (실제 activeTab 객체는 아래에서 선언됨. 여기선 tabs/activeTabId 만 사용해서 시리얼라이즈)
  const layoutSignature = (() => {
    const t = tabs.find(x => x.id === activeTabId);
    if (!t) return '';
    const walk = (n: any): string => {
      if (n.type === 'leaf') return `${n.id}@${n.panel.activeIdx}:${n.panel.sessions.map((s: any) => s.termId).join(',')}`;
      return n.children.map(walk).join('|');
    };
    return walk(t.layout);
  })();
  useEffect(() => {
    if (askPwdPrompts.length === 0) return;
    let rafId = 0;
    const tick = () => { setLayoutTick(n => n + 1); rafId = requestAnimationFrame(tick); };
    rafId = requestAnimationFrame(tick);
    setTimeout(() => cancelAnimationFrame(rafId), 200);
    return () => cancelAnimationFrame(rafId);
  }, [askPwdPrompts.length, selectedPanelId, activeTabId, layoutSignature]);
  useEffect(() => {
    const onFresh = (e: any) => {
      const d = e?.detail || {};
      if (!d.sessionId || typeof d.password !== 'string') return;
      setSavePwdPrompt({ termId: d.termId, sessionId: d.sessionId, password: d.password });
    };
    const onAsk = (e: any) => {
      const d = e?.detail || {};
      if (typeof d.resolve !== 'function') return;
      setAskPwdPrompts(prev => {
        // 같은 termId 가 이미 있으면 교체 (중복 방지)
        const filtered = prev.filter(x => x.termId !== d.termId);
        return [...filtered, { termId: d.termId, sessionId: d.sessionId, hostHint: d.hostHint, userHint: d.userHint, needUsername: !!d.needUsername, resolve: d.resolve, input: '', userInput: d.userHint || '' }];
      });
    };
    window.addEventListener('ssh-fresh-password-success', onFresh as any);
    window.addEventListener('ssh-password-prompt', onAsk as any);
    return () => {
      window.removeEventListener('ssh-fresh-password-success', onFresh as any);
      window.removeEventListener('ssh-password-prompt', onAsk as any);
    };
  }, []);
  const closeAskPwd = (termId: string, password: string | null) => {
    setAskPwdPrompts(prev => {
      const target = prev.find(x => x.termId === termId);
      if (target) {
        // needUsername 모드면 객체로 결과 전달
        const result = password === null ? null
          : (target.needUsername ? { username: target.userInput, password } : password);
        try { target.resolve(result); } catch {}
        setTimeout(() => focusTerm(termId), 0);
      }
      return prev.filter(x => x.termId !== termId);
    });
  };
  const updateAskPwdInput = (termId: string, value: string) => {
    setAskPwdPrompts(prev => prev.map(x => x.termId === termId ? { ...x, input: value } : x));
  };
  const updateAskPwdUserInput = (termId: string, value: string) => {
    setAskPwdPrompts(prev => prev.map(x => x.termId === termId ? { ...x, userInput: value } : x));
  };
  const [themeName, setThemeName] = useState(getCurrentThemeName);
  const [wordSepValue, setWordSepValue] = useState('');
  const [termSettings, setTermSettings] = useState<TerminalSettings>(getTerminalSettings);
  const isOptionsPopout = false; // popout 비활성 — localStorage 격리로 데이터 유실 위험
  const [showOptions, setShowOptions] = useState(false);
  const [editSessionCtx, setEditSessionCtx] = useState<{ session: any; termId: string } | null>(null);
  const [editSessionFolders, setEditSessionFolders] = useState<any[]>([]);
  const [optFontFamily, setOptFontFamily] = useState(() => localStorage.getItem('terminalFontFamily') || '');
  const [optFontSize, setOptFontSize] = useState(() => Number(localStorage.getItem('terminalFontSize')) || 14);
  const [availableFonts, setAvailableFonts] = useState<string[]>([]);
  const [optionsTab, setOptionsTab] = useState<'terminal' | 'session' | 'keybindings' | 'ai'>('terminal');
  const [keybindingsState, setKeybindingsState] = useState<Record<string, string>>({});
  const [keybindingsDraft, setKeybindingsDraft] = useState<Record<string, string>>({});

  // popout=options 모드에선 keybindingsState 로드 후 자동으로 draft 동기화
  useEffect(() => {
    if (isOptionsPopout && Object.keys(keybindingsState).length > 0) {
      setKeybindingsDraft({ ...keybindingsState });
    }
  }, [isOptionsPopout, keybindingsState]);
  const [listeningAction, setListeningAction] = useState<string | null>(null);
  const [keybindingWarning, setKeybindingWarning] = useState<string | null>(null);
  const [sessionsPathDisplay, setSessionsPathDisplay] = useState('');
  const [contextMenuRegistered, setContextMenuRegistered] = useState(false);
  const [sftpProgress, setSftpProgress] = useState<{ filename: string; transferred: number; total: number; direction: string } | null>(null);
  const [availableShells, setAvailableShells] = useState<{ name: string; path: string; icon?: string }[]>([]);
  const [defaultShell, setDefaultShell] = useState<{ name: string; path: string }>({ name: 'Windows PowerShell', path: 'powershell.exe' });
  const [optDefaultShellPath, setOptDefaultShellPath] = useState('');
  const [showBroadcast, setShowBroadcast] = useState<boolean>(true);
  const showBroadcastLoadedRef = useRef(false);
  // 사용 가능한 로컬 쉘 목록 로드 + 기본 쉘 설정 로드 + startupCwd
  useEffect(() => {
    Promise.all([
      (window as any).api?.ptyListShells?.().catch(() => []),
      (window as any).api?.getUIPrefs?.().catch(() => ({})),
      (window as any).api?.getStartupCwd?.().catch(() => null),
    ]).then(([shells, prefs, cwd]: [any[], any, string | null]) => {
      if (shells?.length) setAvailableShells(shells);
      // 레거시 이름 마이그레이션 (예전 "명령 프롬프트 (CMD)" → "CMD")
      const renameLegacy = (n?: string) => n === '명령 프롬프트 (CMD)' ? 'CMD' : n;
      let name = renameLegacy(prefs?.defaultShellName) || shells?.[0]?.name || 'Windows PowerShell';
      const spath = prefs?.defaultShellPath || shells?.[0]?.path || 'powershell.exe';
      if (prefs?.defaultShellName && prefs.defaultShellName !== name) {
        try { (window as any).api?.setUIPrefs?.({ defaultShellName: name }); } catch {}
      }
      setDefaultShell({ name, path: spath });
      // 초기 탭의 세션명/경로/cwd를 업데이트 + 모든 탭의 레거시 sessionName 마이그레이션
      setTabs(prev => prev.map((t, i) => {
        const update = (node: LayoutNode): LayoutNode => {
          if (node.type === 'leaf') {
            return { ...node, panel: { ...node.panel, sessions: node.panel.sessions.map(s => {
              // 레거시 이름 정리는 모든 탭에 적용
              const migrated = s.sessionName === '명령 프롬프트 (CMD)' ? { ...s, sessionName: 'CMD' } : s;
              return (i === 0 && !migrated.sessionId) ? { ...migrated, sessionName: name, shellPath: spath, shellCwd: cwd || undefined } : migrated;
            })}};
          }
          return { ...node, children: node.children.map(update) } as LayoutNode;
        };
        return { ...t, layout: update(t.layout) };
      }));
    });
  }, []);
  // 앱 시작 시 ui-prefs(config.json) 에서 로드 — sessionData 가 매 실행 분리되어
  // localStorage 가 영속되지 않으므로 IPC 로 영구 저장한다.
  useEffect(() => {
    (async () => {
      try {
        const prefs = await (window as any).api?.getUIPrefs?.();
        if (prefs && typeof prefs.showBroadcast === 'boolean') {
          setShowBroadcast(prefs.showBroadcast);
        }
        if (prefs?.keybindings) {
          loadKeybindings(prefs.keybindings);
          setKeybindingsState(prefs.keybindings);
        }
        if (typeof prefs?.claudeChatWidth === 'number' && prefs.claudeChatWidth >= 280 && prefs.claudeChatWidth <= 1200) {
          setClaudeChatWidth(prefs.claudeChatWidth);
        }
        if (typeof prefs?.claudeChatPinned === 'boolean') {
          setClaudeChatPinned(prefs.claudeChatPinned);
          if (!prefs.claudeChatPinned) setClaudeChatVisible(false);
        }
        if (typeof prefs?.showClaudeChat === 'boolean') {
          setShowClaudeChat(prefs.showClaudeChat);
        }
        if (typeof prefs?.remoteTreeWidth === 'number' && prefs.remoteTreeWidth >= 160 && prefs.remoteTreeWidth <= 800) {
          setRemoteTreeWidth(prefs.remoteTreeWidth);
        }
        if (typeof prefs?.remoteTreePinned === 'boolean') {
          setRemoteTreePinned(prefs.remoteTreePinned);
          if (!prefs.remoteTreePinned) setRemoteTreeVisible(false);
        }
        remoteTreeWidthLoadedRef.current = true;
        remoteTreePinnedLoadedRef.current = true;
        claudeChatPinnedLoadedRef.current = true;
        showClaudeChatLoadedRef.current = true;
      } catch {}
      showBroadcastLoadedRef.current = true;
    })();
  }, []);
  // 옵션 다이얼로그 열림 시 글로벌 플래그 동기화 (TerminalPanel에서 참조)
  useEffect(() => { setKeybindingListening(showOptions); }, [showOptions]);

  // 단축키 변경 listening 중: window capture phase에서 키 캡처
  useEffect(() => {
    if (!listeningAction) return;
    const captureHandler = (ev: KeyboardEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      const combo = keyEventToCombo(ev);
      console.log('[keybind-capture] combo:', combo);
      if (!combo || /^(Ctrl|Alt|Shift|Meta)(\+(Ctrl|Alt|Shift|Meta))*$/.test(combo)) return; // modifier만이면 무시
      // 중복 체크
      const allBindings = { ...DEFAULT_KEYBINDINGS, ...keybindingsDraft };
      const duplicate = Object.entries(allBindings).find(
        ([id, key]) => id !== listeningAction && key === combo
      );
      if (duplicate) {
        const dupLabel = tk(`labels.${duplicate[0]}`, { defaultValue: KEYBINDING_LABELS[duplicate[0]] || duplicate[0] });
        setKeybindingWarning(tk('duplicateWarn', { combo, dupLabel }));
        setTimeout(() => setKeybindingWarning(null), 5000);
      } else {
        setKeybindingWarning(null);
      }
      setKeybindingsDraft(prev => ({ ...prev, [listeningAction!]: combo }));
      setListeningAction(null);
    };
    window.addEventListener('keydown', captureHandler, true);
    return () => window.removeEventListener('keydown', captureHandler, true);
  }, [listeningAction, keybindingsDraft]);

  useEffect(() => {
    if (!showBroadcastLoadedRef.current) return;
    try { (window as any).api?.setUIPrefs?.({ showBroadcast }); } catch {}
  }, [showBroadcast]);
  const [broadcastText, setBroadcastText] = useState('');
  const [broadcastAppendNewline, setBroadcastAppendNewline] = useState(true);
  const [broadcastScope, setBroadcastScope] = useState<'current' | 'visible' | 'connected'>('visible');
  const [broadcastShowHistory, setBroadcastShowHistory] = useState(false);
  // 일괄 파일 전송 모달
  const [showBcastFileXfer, setShowBcastFileXfer] = useState(false);
  const [bcastXferPath, setBcastXferPath] = useState(''); // 비우면 세션별 현재 경로 사용
  // source 가 있으면 그 termId(원격 서버) 에서 읽어오는 파일, 없으면 로컬 path
  const [bcastXferFiles, setBcastXferFiles] = useState<{ path: string; isFolder: boolean; sourceTermId?: string; sourceLabel?: string }[]>([]);
  const [bcastXferInProgress, setBcastXferInProgress] = useState(false);
  const [bcastXferLog, setBcastXferLog] = useState<string[]>([]);
  // 원격 소스 picker (일괄 파일 전송 서브 모달)
  const [remotePickerOpen, setRemotePickerOpen] = useState(false);
  // 선택된 세션의 ID (sessionsStore 기준). 실제 SFTP 연결의 termId/connId 는 remotePickerConnId.
  const [remotePickerSessionId, setRemotePickerSessionId] = useState<string>('');
  const [remotePickerConnId, setRemotePickerConnId] = useState<string>('');
  const [remotePickerPath, setRemotePickerPath] = useState<string>('');
  const [remotePickerFiles, setRemotePickerFiles] = useState<{ name: string; isDir: boolean }[]>([]);
  const [remotePickerSelected, setRemotePickerSelected] = useState<Set<string>>(new Set());
  const [remotePickerLoading, setRemotePickerLoading] = useState(false);
  const [remotePickerConnecting, setRemotePickerConnecting] = useState(false);
  const [showManual, setShowManual] = useState(false);
  // 도움말/정보 등 단순 텍스트 모달 (alert 대체 — 스크롤 가능 + 닫을 때 터미널 포커스 복원)
  const [infoModal, setInfoModal] = useState<{ title: string; text: string } | null>(null);
  // 단축키 목록 모달 — 검색 + 컬럼 정렬을 위해 infoModal 과 분리
  const [showKeybindingList, setShowKeybindingList] = useState(false);
  const [keybindingListQuery, setKeybindingListQuery] = useState('');
  // 활성 터미널로 포커스 복원 (모달 닫기 / 빠른연결 닫기 / 외부 영역 클릭 후 등)
  // activeTab/selectedPanelId 는 ref 로 읽음 (선언 순서 의존 회피)
  const restoreTermFocusRef = useRef<() => void>(() => {});
  const restoreTerminalFocus = useCallback(() => {
    restoreTermFocusRef.current();
  }, []);
  const manualHtml = useMemo(() => {
    try {
      const html = marked.parse(manualMd) as string;
      // macOS 사용자에게는 본문 내 Ctrl+/Alt+ 등 콤보 표기를 ⌘/⌥ 등으로 치환
      return IS_MAC ? formatKeyTextForOS(html) : html;
    } catch { return '<pre>매뉴얼 로드 실패</pre>'; }
  }, []);
  const [remotePickerSessions, setRemotePickerSessions] = useState<any[]>([]); // 전체 세션 리스트
  const [remotePickerFolders, setRemotePickerFolders] = useState<any[]>([]); // 폴더 맵
  // picker 가 새로 만든 임시 SFTP 연결 connId 들 — 모달 닫힐 때 일괄 해제
  const [remotePickerTempConns, setRemotePickerTempConns] = useState<string[]>([]);

  // picker 가 열릴 때 전체 세션/폴더 로드
  useEffect(() => {
    if (!remotePickerOpen) return;
    (async () => {
      try {
        const data: any = await (window as any).api?.listSessions?.();
        setRemotePickerSessions(data?.sessions || []);
        setRemotePickerFolders(data?.folders || []);
      } catch {}
    })();
  }, [remotePickerOpen]);

  // 세션 선택 변경 시 자동으로 연결 보장 + 파일 리스트 로드
  useEffect(() => {
    if (!remotePickerOpen || !remotePickerSessionId) return;
    let cancelled = false;
    (async () => {
      // 1) 이미 터미널로 열린 세션이면 그 termId 재사용
      if (activeTab) {
        const open = collectAllSessions(activeTab.layout).find(s => s.sessionId === remotePickerSessionId && isTermConnected(s.termId));
        if (open) {
          if (!cancelled) {
            setRemotePickerConnId(open.termId);
            const pwd = getCurrentPwdForTerm(open.termId) || '/';
            setRemotePickerPath(pwd);
          }
          return;
        }
      }
      // 2) 아니면 백그라운드 SFTP 연결 시도
      const sess = remotePickerSessions.find(s => s.id === remotePickerSessionId);
      if (!sess) return;
      setRemotePickerConnecting(true);
      try {
        const connId = `bcast-pick-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const jumpOpts = sess.jumpTargetHost?.trim()
          ? { host: sess.jumpTargetHost.trim(), user: sess.jumpTargetUser || 'root', port: Number(sess.jumpTargetPort) || 22, password: sess.jumpTargetPassword || undefined }
          : undefined;
        const r: any = await (window as any).api?.feSftpConnect?.(connId, sess.host, sess.port || 22, sess.username, sess.auth, jumpOpts);
        if (cancelled) return;
        if (!r?.success) {
          alert(tfe('connectFailNamed', { name: sess.name, err: r?.error || tfe('unknownError') }));
          setRemotePickerConnecting(false);
          return;
        }
        setRemotePickerTempConns(prev => [...prev, connId]);
        setRemotePickerConnId(connId);
        try {
          const home: any = await (window as any).api?.feHomeDir?.('remote', connId);
          const homePath = typeof home === 'string' ? home : (home?.path || '/');
          if (!cancelled) setRemotePickerPath(homePath || '/');
        } catch { if (!cancelled) setRemotePickerPath('/'); }
      } catch (err: any) {
        if (!cancelled) alert(tfe('connectFail', { err: err?.message || err }));
      }
      if (!cancelled) setRemotePickerConnecting(false);
    })();
    return () => { cancelled = true; };
  }, [remotePickerOpen, remotePickerSessionId, remotePickerSessions]);

  // 경로/connId 기반 파일 리스트 로드
  useEffect(() => {
    if (!remotePickerOpen || !remotePickerConnId || !remotePickerPath) return;
    let cancelled = false;
    (async () => {
      setRemotePickerLoading(true);
      try {
        const r: any = await (window as any).api?.feListDir?.('remote', remotePickerPath, remotePickerConnId);
        if (!cancelled) setRemotePickerFiles(r?.files || []);
      } catch {
        if (!cancelled) setRemotePickerFiles([]);
      }
      if (!cancelled) setRemotePickerLoading(false);
    })();
    return () => { cancelled = true; };
  }, [remotePickerOpen, remotePickerConnId, remotePickerPath]);

  // 모달 닫힐 때 임시 연결 정리
  useEffect(() => {
    if (remotePickerOpen) return;
    if (remotePickerTempConns.length === 0) return;
    for (const cid of remotePickerTempConns) {
      try { (window as any).api?.feSftpDisconnect?.(cid); } catch {}
    }
    setRemotePickerTempConns([]);
  }, [remotePickerOpen]);
  const [broadcastHistoryIdx, setBroadcastHistoryIdx] = useState(-1);
  // 히스토리 드롭다운에서 방향키로 이동한 항목이 보이게 스크롤 따라오기
  useEffect(() => {
    if (!broadcastShowHistory || broadcastHistoryIdx < 0) return;
    const active = document.querySelector('.broadcast-history-dropdown .broadcast-history-item.active');
    if (active instanceof HTMLElement) {
      active.scrollIntoView({ block: 'nearest' });
    }
  }, [broadcastHistoryIdx, broadcastShowHistory]);
  const [splitSessionPicker, setSplitSessionPicker] = useState<{
    dir: 'row' | 'column';
    sessions: { sessionId: string; sessionName: string; host: string; termId: string; folderId?: string; icon?: string }[];
    folders: { id: string; name: string; parentId?: string }[];
    srcTermId?: string;
    targetNodeId: string;
  } | null>(null);
  const [splitPickerCollapsed, setSplitPickerCollapsed] = useState<Set<string>>(new Set());

  // 세션 선택 picker prefix 키 핸들러 — 파일 트리와 동일한 동작 (folder + session 가시 항목 순회, startsWith, 같은 키 반복 시 순환)
  const splitPickerLastSelectedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!splitSessionPicker) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setSplitSessionPicker(null); e.preventDefault(); e.stopPropagation(); return; }
      if (e.key.length !== 1 || e.ctrlKey || e.altKey || e.metaKey) return;
      const { sessions, folders } = splitSessionPicker;
      // 폴더 + 세션 모두 가시 순서대로 flatten (트리에 보이는 그대로)
      const items: { id: string; name: string; type: 'folder' | 'session'; data?: any }[] = [];
      const walk = (parentId?: string) => {
        const subF = folders.filter(f => (f.parentId ?? undefined) === (parentId ?? undefined));
        for (const f of subF) {
          items.push({ id: f.id, name: f.name, type: 'folder' });
          if (!splitPickerCollapsed.has(f.id)) walk(f.id);
        }
        const subS = sessions.filter(s => (s.folderId ?? undefined) === (parentId ?? undefined));
        for (const s of subS) {
          items.push({ id: s.sessionId, name: s.sessionName, type: 'session', data: s });
        }
      };
      walk(undefined);
      const ch = e.key.toLowerCase();
      const lastId = splitPickerLastSelectedRef.current;
      const curIdx = lastId ? items.findIndex(it => it.id === lastId) : -1;
      let target = -1;
      for (let i = 1; i <= items.length; i++) {
        const idx = (curIdx + i) % items.length;
        if (items[idx].name.toLowerCase().startsWith(ch)) { target = idx; break; }
      }
      if (target < 0) return;
      e.preventDefault();
      e.stopPropagation();
      const it = items[target];
      splitPickerLastSelectedRef.current = it.id;
      setTimeout(() => {
        const sel = it.type === 'session'
          ? `.folder-picker .folder-picker-item[data-sid="${CSS.escape(it.id)}"]`
          : `.folder-picker .folder-picker-item.folder-row[data-fid="${CSS.escape(it.id)}"]`;
        const el = document.querySelector(sel) as HTMLElement | null;
        el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        el?.classList.add('picker-highlight');
        setTimeout(() => el?.classList.remove('picker-highlight'), 800);
      }, 0);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [splitSessionPicker, splitPickerCollapsed]);
  const [floatingPanelId, setFloatingPanelId] = useState<string | null>(null);
  const [remoteTreeWidth, setRemoteTreeWidth] = useState<number>(240);
  const remoteTreeWidthLoadedRef = useRef(false);
  const [remoteTreePinned, setRemoteTreePinned] = useState<boolean>(true);
  const [remoteTreeVisible, setRemoteTreeVisible] = useState<boolean>(true);
  // 어느 오버레이가 최상위인지 — hover 중인 쪽이 다른 쪽 위에 오도록
  const [topPanel, setTopPanel] = useState<'session' | 'filetree' | null>(null);
  const remoteTreePinnedLoadedRef = useRef(false);
  const remoteTreeHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remoteTreeHoverShowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 세션 트리거 top 버튼 하단 y 좌표 (파일 트리 트리거의 top 위치 맞추기용)
  const [fileTreeTriggerTop, setFileTreeTriggerTop] = useState<number>(135);
  useEffect(() => {
    // 무한 루프 방지: setState 가 DOM 을 바꾸면 MutationObserver 가 다시 측정을 호출 → 매번 같은 값으로
    // setState 가 호출돼도 React 가 같은 값이면 리렌더를 건너뛰도록 functional update 로 equality 체크.
    // 또한 attributes:true 는 자식 트리의 사소한 속성 변경에도 끝없이 fire 되므로 제거.
    const measure = () => {
      const el = document.querySelector('.session-sidebar-trigger-top') as HTMLElement | null;
      if (!el) return;
      const next = el.getBoundingClientRect().bottom;
      setFileTreeTriggerTop(prev => (Math.abs(prev - next) < 0.5 ? prev : next));
    };
    measure();
    const t1 = setTimeout(measure, 100);
    const t2 = setTimeout(measure, 500);
    window.addEventListener('resize', measure);
    const mo = new MutationObserver(() => {
      // observer 콜백은 마이크로태스크에서 다시 측정. throttle 로 한 프레임에 한 번만.
      requestAnimationFrame(measure);
    });
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      clearTimeout(t1); clearTimeout(t2);
      window.removeEventListener('resize', measure);
      mo.disconnect();
    };
  }, []);
  useEffect(() => {
    if (!remoteTreePinnedLoadedRef.current) return;
    try { (window as any).api?.setUIPrefs?.({ remoteTreePinned }); } catch {}
    if (remoteTreePinned) setRemoteTreeVisible(true);
  }, [remoteTreePinned]);
  const [showClaudeChat, setShowClaudeChat] = useState(true);
  const [claudeChatWidth, setClaudeChatWidth] = useState<number>(360);
  const [claudeChatPinned, setClaudeChatPinned] = useState<boolean>(false);
  const [claudeChatVisible, setClaudeChatVisible] = useState<boolean>(false);
  const showClaudeChatLoadedRef = useRef(false);
  const claudeChatPinnedLoadedRef = useRef(false);
  const claudeChatHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const claudeChatHoverShowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!showClaudeChatLoadedRef.current) return;
    try { (window as any).api?.setUIPrefs?.({ showClaudeChat }); } catch {}
  }, [showClaudeChat]);
  useEffect(() => {
    if (!claudeChatPinnedLoadedRef.current) return;
    try { (window as any).api?.setUIPrefs?.({ claudeChatPinned }); } catch {}
    if (claudeChatPinned) setClaudeChatVisible(true);
    // 레이아웃 변경 → 터미널 재측정
    [50, 200, 500].forEach(ms => setTimeout(() => {
      window.dispatchEvent(new Event('resize'));
      refitAllTerms();
    }, ms));
  }, [claudeChatPinned]);
  // 너비/표시 변경 시에도 터미널 리핏
  useEffect(() => {
    [50, 200].forEach(ms => setTimeout(() => {
      window.dispatchEvent(new Event('resize'));
      refitAllTerms();
    }, ms));
  }, [claudeChatWidth, showClaudeChat]);
  const [claudeFileContext, setClaudeFileContext] = useState<{ fileName: string; remotePath: string; content: string }[] | null>(null);
  // WebDAV 마운트 첨부 엔트리
  const [claudeMountEntries, setClaudeMountEntries] = useState<{ termId: string; remotePath: string; uncPath: string; isDir: boolean }[]>([]);
  const [claudeAttaching, setClaudeAttaching] = useState<{ message: string; progress: number; total: number } | null>(null);
  const [, setConnectedTick] = useState(0);
  // 글로벌 연결 상태 변경시 일괄전송 카운트 등 재계산을 위해 강제 리렌더
  useEffect(() => subscribeConnectedChange(() => setConnectedTick(n => n + 1)), []);
  const [isMaximized, setIsMaximized] = useState(false);
  useEffect(() => {
    (window as any).api?.windowIsMaximized?.().then((m: boolean) => setIsMaximized(!!m)).catch(() => {});
    const off = (window as any).api?.onWindowMaximized?.((m: boolean) => setIsMaximized(!!m));
    return () => { try { off?.(); } catch {} };
  }, []);
  // Claude 채팅 전용 폰트/크기 — 터미널과 독립 설정 (src/utils/claudeFont)
  const [claudeFontFamily, setClaudeFontFamilyState] = useState(() => getClaudeFontFamily());
  const [claudeFontSize, setClaudeFontSizeState] = useState(() => getClaudeFontSize());
  useEffect(() => { applyClaudeFontVars(); }, []);
  // ClaudeChat 의 Ctrl+Wheel 이 외부에서 변경 시 옵션 창 값 동기화용
  useEffect(() => {
    const onChange = () => {
      setClaudeFontFamilyState(getClaudeFontFamily());
      setClaudeFontSizeState(getClaudeFontSize());
    };
    window.addEventListener('claude-font-changed', onChange);
    return () => window.removeEventListener('claude-font-changed', onChange);
  }, []);
  // main 프로세스 디버그 로그를 DevTools Console 로 포워딩
  useEffect(() => {
    const off = (window as any).api?.onDebugLog?.((msg: string) => {
      // eslint-disable-next-line no-console
      console.log('%c[main]', 'color:#8ab4f8', msg);
    });
    return () => { try { off?.(); } catch {} };
  }, []);
  const [fullscreenTermId, setFullscreenTermId] = useState<string | null>(null);
  const fsWasMaxRef = useRef(false);
  const [showQuickConnect, setShowQuickConnect] = useState(() => {
    const v = localStorage.getItem('showQuickConnect');
    return v === null ? true : v === '1';
  });
  useEffect(() => { localStorage.setItem('showQuickConnect', showQuickConnect ? '1' : '0'); }, [showQuickConnect]);

  // 도구 모음 바 위치 슬롯
  type ToolbarSlot = 'top' | 'qc-left' | 'qc-right';
  const [toolbarSlot, setToolbarSlot] = useState<ToolbarSlot>(() => {
    try { const s = localStorage.getItem('toolbarSlot') as ToolbarSlot | null; if (s === 'top' || s === 'qc-left' || s === 'qc-right') return s; } catch {}
    return 'qc-right';
  });
  useEffect(() => { try { localStorage.setItem('toolbarSlot', toolbarSlot); } catch {} }, [toolbarSlot]);
  const [toolbarDragHint, setToolbarDragHint] = useState<ToolbarSlot | null>(null);
  // (qcWidth 제거됨 — QC 바는 항상 자연 너비)
  useEffect(() => { try { localStorage.removeItem('qcWidth'); } catch {} }, []);
  // 도구모음 바 표시/숨기기
  const [showToolbar, setShowToolbar] = useState<boolean>(() => {
    try { const v = localStorage.getItem('showToolbar'); if (v === '0') return false; } catch {}
    return true;
  });
  useEffect(() => { try { localStorage.setItem('showToolbar', showToolbar ? '1' : '0'); } catch {} }, [showToolbar]);

  // 인라인 토스트 알림 (alert 대체)
  const showToast = useCallback((msg: string, duration = 3000) => {
    const el = document.createElement('div');
    el.textContent = msg;
    Object.assign(el.style, {
      position: 'fixed', bottom: '60px', left: '50%', transform: 'translateX(-50%)',
      background: '#1a1a2e', color: '#eee', padding: '8px 18px', borderRadius: '6px',
      fontSize: '13px', zIndex: '9999', border: '1px solid #444', whiteSpace: 'nowrap',
    });
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; setTimeout(() => el.remove(), 300); }, duration);
  }, []);

  // fs-visible class 는 Layout 컴포넌트가 fullscreenTermId prop 으로 직접 className 에 포함시킴
  // (이전엔 querySelector + classList 조작 → React 의 rerender 가 className 을 통째로 교체할 때 fs-visible 이 사라지는 버그 있었음)

  // 윈도우 포커스 복귀 시 터미널 자동 포커스 (alt-tab 등으로 돌아올 때)
  useEffect(() => {
    const onWinFocus = () => {
      // 활성 요소가 input/textarea/contenteditable 이면 그쪽 포커스 유지
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
      restoreTerminalFocus();
    };
    window.addEventListener('focus', onWinFocus);
    return () => window.removeEventListener('focus', onWinFocus);
  }, [restoreTerminalFocus]);

  // 모달/오버레이 상태가 모두 닫힐 때 자동으로 터미널 포커스 복원.
  // 닫힘 트랜지션 검출용으로 이전 상태를 ref 에 저장.
  const overlayOpenRef = useRef(false);
  useEffect(() => {
    const anyOpen = !!(showOptions || showManual || infoModal || showQuickConnect || showBroadcast);
    if (overlayOpenRef.current && !anyOpen) {
      // 직전엔 오버레이가 열려있었고, 지금은 다 닫힘 → 터미널 포커스 복원
      restoreTerminalFocus();
    }
    overlayOpenRef.current = anyOpen;
  }, [showOptions, showManual, infoModal, showQuickConnect, showBroadcast, restoreTerminalFocus]);

  // 미니탭 우클릭 → '세션 편집' 이벤트 수신
  useEffect(() => {
    const handler = async (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.sessionId) return;
      try {
        const data = await (window as any).api?.listSessions?.();
        const all = data?.sessions ?? data ?? [];
        const flds = data?.folders ?? [];
        const sess = all.find((x: any) => x.id === detail.sessionId);
        if (sess) {
          setEditSessionCtx({ session: sess, termId: detail.termId });
          setEditSessionFolders(flds);
        }
      } catch {}
    };
    window.addEventListener('open-session-editor', handler);
    return () => window.removeEventListener('open-session-editor', handler);
  }, []);

  // 세션 변경 사항을 활성 터미널에 실시간 반영
  const applySessionToTerm = (s: any, termId: string) => {
    try {
      if (s.theme) applyThemeToTerm(termId, s.theme);
      if (s.fontFamily || s.fontSize) applyFontToTerm(termId, s.fontFamily, s.fontSize);
      if (typeof s.scrollback === 'number') applyScrollbackToTerm(termId, s.scrollback);
      applyCursorStyleToTerm(termId, s.cursorStyle || 'block', !!s.cursorBlink);
    } catch (e) { console.error('[applySessionToTerm]', e); }
  };

  // 외부 검색 창 IPC — listener 는 한 번만 등록, 최신 tabs/activeTab 은 ref 로 참조
  // (활성 useState/useEffect 들이 모두 선언된 후 — activeTab 은 아래에서 계산되므로 lazy init)
  const searchStateRef = useRef<any>({ tabs: [], activeTab: null, lastQuery: '', lastCs: false, lastRe: false, lastMode: 'current' as 'current' | 'all' });
  useEffect(() => {
    const api = (window as any).api;
    if (!api) return;
    const getActiveTermIdLocal = (): string | null => {
      try {
        const selInner = document.querySelector('.layout-leaf-inner.selected') as HTMLElement | null;
        const tid = selInner?.parentElement?.getAttribute('data-active-term');
        if (tid) return tid;
      } catch {}
      const ct = searchStateRef.current.activeTab;
      if (!ct) return null;
      return collectAllSessions(ct.layout)[0]?.termId || null;
    };
    const getAllVisibleTermIds = (): string[] => {
      const ids: string[] = [];
      for (const tab of searchStateRef.current.tabs) {
        if (tab.type === 'fileExplorer' || tab.type === 'fileEditor') continue;
        for (const s of collectAllSessions(tab.layout)) ids.push(s.termId);
      }
      return ids;
    };
    const st = searchStateRef.current;
    const runSearch = (q: string, ureg: boolean, cs: boolean, mode: 'current' | 'all') => {
      st.lastQuery = q; st.lastCs = cs; st.lastRe = ureg; st.lastMode = mode;
      // 모든 터미널의 기존 하이라이트 정리
      for (const t of getAllTermIds()) { try { clearHighlights(t); } catch {} }
      if (!q) {
        for (const t of getAllVisibleTermIds()) { try { clearSearchInTerm(t); } catch {} }
        api.sendSearchResult?.({ current: 0, total: 0 });
        return;
      }
      if (mode === 'current') {
        const tid = getActiveTermIdLocal();
        if (!tid) { api.sendSearchResult?.({ current: 0, total: 0 }); return; }
        try {
          highlightAllMatches(tid, q, ureg, cs);
          const found = searchFromTop(tid, q, ureg, cs);
          api.sendSearchResult?.({ current: found ? 1 : 0, total: found ? 1 : 0 });
        } catch {}
      } else {
        let totalTerms = 0;
        for (const tid of getAllVisibleTermIds()) {
          try {
            highlightAllMatches(tid, q, ureg, cs);
            if (searchInTerm(tid, q, ureg, cs)) totalTerms++;
          } catch {}
        }
        api.sendSearchResult?.({ current: totalTerms > 0 ? 1 : 0, total: totalTerms });
      }
    };
    const offQ = api.onSearchQuery?.((p: { q: string; caseSensitive: boolean; useRegex: boolean; mode?: 'current' | 'all' }) => {
      console.log('[search-debug] query received:', p, 'activeTermId=', getActiveTermIdLocal(), 'allIds=', getAllVisibleTermIds());
      runSearch(p.q, p.useRegex, p.caseSensitive, p.mode || 'current');
    });
    const offN = api.onSearchNext?.((p?: { mode?: 'current' | 'all' }) => {
      if (!st.lastQuery) return;
      const mode = p?.mode || st.lastMode;
      if (mode === 'current') {
        const tid = getActiveTermIdLocal();
        if (tid) { try { searchNextInTerm(tid, st.lastQuery, st.lastRe, st.lastCs); } catch {} }
      } else {
        for (const tid of getAllVisibleTermIds()) { try { searchNextInTerm(tid, st.lastQuery, st.lastRe, st.lastCs); } catch {} }
      }
    });
    const offP = api.onSearchPrev?.((p?: { mode?: 'current' | 'all' }) => {
      if (!st.lastQuery) return;
      const mode = p?.mode || st.lastMode;
      if (mode === 'current') {
        const tid = getActiveTermIdLocal();
        if (tid) { try { searchPrevInTerm(tid, st.lastQuery, st.lastRe, st.lastCs); } catch {} }
      } else {
        for (const tid of getAllVisibleTermIds()) { try { searchPrevInTerm(tid, st.lastQuery, st.lastRe, st.lastCs); } catch {} }
      }
    });
    const offC = api.onSearchClosed?.(() => {
      for (const tid of getAllTermIds()) {
        try { clearSearchInTerm(tid); clearHighlights(tid); } catch {}
      }
    });
    // 외부 검색창에서 📌 클릭 → 인라인 모드로 복귀
    const offD = api.onSearchDock?.(() => { setShowSearch(true); });
    // 터미널 우클릭 → '찾기...' 메뉴에서 발행하는 커스텀 이벤트로 검색바 열기
    const onOpenSearch = () => setShowSearch(true);
    window.addEventListener('open-search', onOpenSearch);
    return () => { offQ?.(); offN?.(); offP?.(); offC?.(); offD?.(); window.removeEventListener('open-search', onOpenSearch); };
  }, []); // listener 한 번만 — tabs/activeTab 은 ref 로 항상 최신 참조

  // 워크스페이스 전환 시 전체화면이면 새 워크스페이스의 선택된/첫번째 연결 패널로 fs-visible 전환
  useEffect(() => {
    if (!fullscreenTermId) return;
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab || tab.type === 'fileExplorer' || tab.type === 'fileEditor' || tab.type === 'sqlTool') {
      setFullscreenTermId(null);
      return;
    }
    // 현재 fullscreenTermId 가 새 워크스페이스에 있는지 확인
    const walk = (n: any): string[] => {
      if (n.type === 'leaf') {
        return (n.panel?.sessions || []).map((s: any) => s.termId);
      }
      return (n.children || []).flatMap(walk);
    };
    const termIds = walk(tab.layout);
    let targetTermId = fullscreenTermId;
    if (!termIds.includes(fullscreenTermId)) {
      const findFirst = (n: any): string | null => {
        if (n.type === 'leaf') {
          const s = n.panel?.sessions?.[n.panel?.activeIdx ?? 0];
          return s?.termId || null;
        }
        for (const c of (n.children || [])) { const r = findFirst(c); if (r) return r; }
        return null;
      };
      const candidate = findFirst(tab.layout);
      setFullscreenTermId(candidate);
      targetTermId = candidate || fullscreenTermId;
    }
    // fs-visible 전환 후 fit + refresh — 워크스페이스 전환 시 xterm 사이즈 재계산 + scrollbar 재렌더
    if (targetTermId) {
      const tid = targetTermId;
      [50, 200, 500].forEach(delay => setTimeout(() => refitTerm(tid), delay));
    }
  }, [activeTabId, tabs, fullscreenTermId]);

  // 텍스트 일괄 전송 대상 termId 수집
  const collectBroadcastTargets = (scope: 'current' | 'visible' | 'connected'): string[] => {
    const ids: string[] = [];
    if (scope === 'current') {
      const tid = getActiveTermId();
      if (tid && isTermConnected(tid)) ids.push(tid);
      return ids;
    }
    if (scope === 'visible') {
      if (!activeTab) return ids;
      const walk = (node: LayoutNode) => {
        if (node.type === 'leaf') {
          const sess = node.panel.sessions[node.panel.activeIdx];
          if (sess && isTermConnected(sess.termId)) ids.push(sess.termId);
        } else for (const c of node.children) walk(c);
      };
      walk(activeTab.layout);
      return ids;
    }
    // connected: 모든 워크스페이스의 모든 미니탭 중 연결된 것
    for (const t of tabs) {
      if (t.type === 'fileExplorer') continue;
      const sessions = collectAllSessions(t.layout);
      for (const s of sessions) if (isTermConnected(s.termId)) ids.push(s.termId);
    }
    return ids;
  };

  const [broadcastNotice, setBroadcastNotice] = useState<{ text: string; kind: 'ok' | 'warn' } | null>(null);
  const broadcastNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashBroadcastNotice = (text: string, kind: 'ok' | 'warn' = 'ok') => {
    setBroadcastNotice({ text, kind });
    if (broadcastNoticeTimer.current) clearTimeout(broadcastNoticeTimer.current);
    broadcastNoticeTimer.current = setTimeout(() => setBroadcastNotice(null), 2500);
  };
  const sendBroadcast = (scope: 'current' | 'visible' | 'connected', override?: { raw: string; label?: string }, opts?: { keepFocusOnInput?: boolean }) => {
    let text: string;
    let label: string;
    if (override) {
      text = override.raw;
      label = override.label ?? '(raw)';
    } else {
      text = broadcastAppendNewline ? (broadcastText.endsWith('\n') ? broadcastText : broadcastText + '\n') : broadcastText;
      label = '텍스트';
      if (!text) { flashBroadcastNotice(tb('emptyText'), 'warn'); return; }
      addBroadcastHistory(broadcastText);
    }
    const targets = collectBroadcastTargets(scope);
    if (targets.length === 0) {
      flashBroadcastNotice(tb('noTargets'), 'warn');
      return;
    }
    for (const tid of targets) {
      try {
        if (isTermPty(tid)) {
          (window as any).api?.ptyInput?.(tid, text);
        } else {
          (window as any).api?.sendSSHInput?.(tid, text);
        }
      } catch {}
    }
    flashBroadcastNotice(`${label} → ${targets.length}개 세션 전송`, 'ok');
    // 전송 후 입력창 비우기 (override는 제어 문자라 제외)
    if (!override) setBroadcastText('');
    // 포커스 복귀: 기본은 활성 터미널로, 일괄작업창에서 전송한 경우엔 입력창 유지
    setTimeout(() => {
      if (opts?.keepFocusOnInput) {
        const inp = document.querySelector('.broadcast-input') as HTMLInputElement | null;
        inp?.focus();
      } else {
        const atid = getActiveTermId();
        if (atid) focusTerm(atid);
      }
    }, 0);
  };

  const handleThemeChange = (name: string) => {
    setThemeName(name);
    const tid = getActiveTermId();
    if (tid) applyThemeToTerm(tid, name);
    else applyThemeToAll(name);
  };

  const activeTab = tabs.find(t => t.id === activeTabId) ?? tabs[0];

  // 검색 상태 ref 동기화 — tabs/activeTab 변경 시 갱신 + 활성 터미널에서 자동 재하이라이트
  useEffect(() => {
    searchStateRef.current.tabs = tabs;
    searchStateRef.current.activeTab = activeTab;
    const st = searchStateRef.current;
    if (!st.lastQuery) return;
    setTimeout(() => {
      try {
        const selInner = document.querySelector('.layout-leaf-inner.selected') as HTMLElement | null;
        const tid = selInner?.parentElement?.getAttribute('data-active-term');
        const targetTid = tid || (st.activeTab ? collectAllSessions(st.activeTab.layout)[0]?.termId : null);
        if (targetTid) {
          highlightAllMatches(targetTid, st.lastQuery, st.lastRe, st.lastCs);
          searchInTerm(targetTid, st.lastQuery, st.lastRe, st.lastCs);
        }
      } catch {}
    }, 100);
  }, [tabs, activeTab, selectedPanelId]);

  // 실제 포커스 복원 구현 — activeTab/selectedPanelId 가 선언된 후 ref 에 주입
  restoreTermFocusRef.current = () => {
    setTimeout(() => {
      try {
        if (!activeTab) return;
        const sessions = collectAllSessions(activeTab.layout);
        if (sessions.length === 0) return;
        let targetTermId: string | null = null;
        // 1) 선택된 (.selected) 패널의 active term
        const selInner = document.querySelector('.layout-leaf-inner.selected') as HTMLElement | null;
        const selLeaf = selInner?.parentElement as HTMLElement | null;
        const selTerm = selLeaf?.getAttribute('data-active-term');
        if (selTerm) targetTermId = selTerm;
        // 2) fullscreen 모드의 fs-visible
        if (!targetTermId) {
          const fsLeaf = document.querySelector('.layout-leaf.fs-visible') as HTMLElement | null;
          const t = fsLeaf?.getAttribute('data-active-term');
          if (t) targetTermId = t;
        }
        // 3) 첫 활성 term
        if (!targetTermId) targetTermId = sessions[0].termId;
        if (targetTermId) focusTerm(targetTermId);
      } catch {}
    }, 50);
  };

  // 활성 터미널 termId를 가져오는 헬퍼
  const getActiveTermId = useCallback((): string | null => {
    if (!activeTab || !selectedPanelId) return null;
    const find = (node: LayoutNode): string | null => {
      if (node.type === 'leaf' && node.id === selectedPanelId) {
        const sess = node.panel.sessions[node.panel.activeIdx];
        return sess?.termId ?? null;
      }
      if (node.type !== 'leaf') for (const c of node.children) { const r = find(c); if (r) return r; }
      return null;
    };
    return find(activeTab.layout);
  }, [activeTab, selectedPanelId]);

  // 글로벌 단축키
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // 옵션 다이얼로그 열려있으면 글로벌 핸들러 무시
      if (showOptions) return;
      // 전체화면 토글 (창도 최대화, 해제 시 원래 상태로)
      if (matchKeybinding(e, 'fullscreen')) {
        e.preventDefault();
        const tid = getActiveTermId();
        if (tid) {
          setFullscreenTermId(prev => {
            const toFullscreen = prev !== tid;
            (async () => {
              try {
                const isMax = await (window as any).api?.windowIsMaximized?.();
                if (toFullscreen) {
                  // 진입: 현재 최대화 상태 저장 + 최대화
                  fsWasMaxRef.current = !!isMax;
                  if (!isMax) await (window as any).api?.windowToggleMaximize?.();
                } else {
                  // 해제: 진입 전 최대화가 아니었으면 원래대로 복원
                  if (!fsWasMaxRef.current && isMax) await (window as any).api?.windowToggleMaximize?.();
                }
              } catch {}
            })();
            return toFullscreen ? tid : null;
          });
          setTimeout(() => { refitAllTerms(); focusTerm(tid); }, 150);
        }
        return;
      }
      // 연결된 세션 선택 + 가로/세로 분할
      if ((matchKeybinding(e, 'splitSessionH') || matchKeybinding(e, 'splitSessionV')) && activeTab && selectedPanelId) {
        e.preventDefault();
        const dir: 'row' | 'column' = matchKeybinding(e, 'splitSessionV') ? 'row' : 'column';
        openSplitSessionPicker(dir, selectedPanelId);
        return;
      }
      // Alt+1..9: 워크스페이스 내 모든 미니탭(모든 패널) 기준 N번째 탭으로 이동 (Alt+9는 마지막 탭)
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        const m = /^Digit([1-9])$/.exec(e.code);
        if (m) {
          if (!activeTab) return;
          const leaves: { nodeId: string; sessions: PanelSession[]; activeIdx: number }[] = [];
          const collect = (node: LayoutNode) => {
            if (node.type === 'leaf') {
              if (node.panel.sessions.length > 0) {
                leaves.push({ nodeId: node.id, sessions: node.panel.sessions, activeIdx: node.panel.activeIdx });
              }
            } else {
              for (const c of node.children) collect(c);
            }
          };
          collect(activeTab.layout);
          const total = leaves.reduce((n, l) => n + l.sessions.length, 0);
          if (total === 0) return;
          e.preventDefault();
          const n = Number(m[1]);
          const targetGlobal = n === 9 ? total - 1 : Math.min(n - 1, total - 1);
          let acc = 0;
          for (const l of leaves) {
            if (targetGlobal < acc + l.sessions.length) {
              const localIdx = targetGlobal - acc;
              if (l.nodeId !== selectedPanelId) setSelectedPanelId(l.nodeId);
              if (localIdx !== l.activeIdx) handleSwitchSession(l.nodeId, localIdx);
              const tid = l.sessions[localIdx]?.termId;
              if (tid) setTimeout(() => focusTerm(tid), 50);
              break;
            }
            acc += l.sessions.length;
          }
          return;
        }
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      // 미니탭 순환
      if (matchKeybinding(e, 'nextTab') || matchKeybinding(e, 'prevTab')) {
        if (!activeTab) return;
        const leaves: { nodeId: string; sessions: PanelSession[]; activeIdx: number }[] = [];
        const collect = (node: LayoutNode) => {
          if (node.type === 'leaf') {
            if (node.panel.sessions.length > 0) {
              leaves.push({ nodeId: node.id, sessions: node.panel.sessions, activeIdx: node.panel.activeIdx });
            }
          } else {
            for (const c of node.children) collect(c);
          }
        };
        collect(activeTab.layout);
        const total = leaves.reduce((n, l) => n + l.sessions.length, 0);
        if (total < 2) return;
        e.preventDefault();
        // 현재 활성 위치(global index) 계산
        let curGlobal = 0;
        let found = false;
        for (const l of leaves) {
          if (l.nodeId === selectedPanelId) { curGlobal += l.activeIdx; found = true; break; }
          curGlobal += l.sessions.length;
        }
        if (!found) curGlobal = 0;
        const dir = matchKeybinding(e, 'prevTab') ? -1 : 1;
        const nextGlobal = (curGlobal + dir + total) % total;
        // global index → 해당 leaf + 로컬 index
        let acc = 0;
        for (const l of leaves) {
          if (nextGlobal < acc + l.sessions.length) {
            const localIdx = nextGlobal - acc;
            if (l.nodeId !== selectedPanelId) setSelectedPanelId(l.nodeId);
            if (localIdx !== l.activeIdx) handleSwitchSession(l.nodeId, localIdx);
            const tid = l.sessions[localIdx]?.termId;
            if (tid) setTimeout(() => focusTerm(tid), 50);
            break;
          }
          acc += l.sessions.length;
        }
        return;
      }
      // 현재 세션 복제 + 가로/세로 분할
      if ((matchKeybinding(e, 'cloneSplitH') || matchKeybinding(e, 'cloneSplitV')) && activeTab && selectedPanelId) {
        e.preventDefault();
        const dir: 'row' | 'column' = matchKeybinding(e, 'cloneSplitV') ? 'row' : 'column';
        const tid = getActiveTermId();
        const sessInfo = tid ? getTermSessionInfo(tid) : null;
        if (sessInfo && sessInfo.sessionId) {
          const newTermId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const newSess: PanelSession = { termId: newTermId, sessionId: sessInfo.sessionId, sessionName: sessInfo.sessionName || 'Session' };
          updateLayout(activeTab.id, layout => splitNodeWithSessions(layout, selectedPanelId, dir, [newSess], false));
          setTimeout(async () => {
            if (tid) cloneTermStyle(tid, newTermId);
            try {
              const r = await (window as any).api.connectSSH(newTermId, sessInfo.sessionId);
              if (r === 'need-password') promptPasswordAndConnect(newTermId, sessInfo.sessionId);
            } catch {}
            registerTermSession(newTermId, sessInfo.sessionId, sessInfo.sessionName, sessInfo.host);
            setTimeout(() => { refitAllTerms(); focusTerm(newTermId); }, 100);
          }, 100);
        } else {
          splitPanel(activeTab.id, selectedPanelId, dir);
        }
        return;
      }
      if (matchKeybinding(e, 'find')) { e.preventDefault(); setShowSearch(prev => !prev); return; }
      if (matchKeybinding(e, 'toggleFileTree')) {
        e.preventDefault();
        // 워크스페이스 공유 파일 트리 핀/언핀 토글
        setRemoteTreePinned(p => {
          const newVal = !p;
          try { (window as any).api?.setUIPrefs?.({ remoteTreePinned: newVal }); } catch {}
          // 언핀 시 즉시 숨김 (마우스 hover 안 해도 retract). 핀 시엔 visible 자동 true.
          if (!newVal) setRemoteTreeVisible(false);
          return newVal;
        });
        [50, 200].forEach(ms => setTimeout(() => {
          window.dispatchEvent(new Event('resize'));
          refitAllTerms();
        }, ms));
        return;
      }
      const termId = getActiveTermId();
      if (!termId) return;
      if (matchKeybinding(e, 'clearScrollback')) { e.preventDefault(); clearScrollbackInTerm(termId); }
      else if (matchKeybinding(e, 'clearScreen')) { e.preventDefault(); clearScreenInTerm(termId); }
      else if (matchKeybinding(e, 'clearAll')) { e.preventDefault(); clearAllInTerm(termId); }
      else if (matchKeybinding(e, 'copy')) {
        const sel = getSelectionFromTerm(termId);
        if (sel) { e.preventDefault(); navigator.clipboard.writeText(sel).catch(() => {}); }
      }
      else if (matchKeybinding(e, 'paste')) {
        e.preventDefault();
        navigator.clipboard.readText().then(text => {
          if (text) pasteToTerm(termId, text);
        }).catch(() => {});
      }
      else if (matchKeybinding(e, 'selectAll')) {
        e.preventDefault();
        selectAllInTerm(termId);
      }
    };
    window.addEventListener('keydown', handler, true); // capture phase
    return () => window.removeEventListener('keydown', handler, true);
  }, [getActiveTermId, showOptions]);

  // 앱 종료 시 녹화 중 세션이 있으면 사용자에게 확인 — beforeunload 로 Electron close 인터셉트
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (recordingState.size === 0) return;
      const msg = `${recordingState.size}개 세션이 녹화 중입니다. 종료하시겠습니까?`;
      e.preventDefault();
      e.returnValue = msg;
      return msg;
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // SFTP 진행률/완료 이벤트
  useEffect(() => {
    const onProgress = (window as any).api?.onSFTPProgress?.((p: any) => {
      try { setSftpProgress(JSON.parse(p.data)); } catch {}
    });
    const onComplete = (window as any).api?.onSFTPComplete?.((p: any) => {
      setSftpProgress(null);
      try {
        JSON.parse(p.data);
        // 전송 완료 — 전송 목록에서 확인 가능
      } catch {}
    });
    return () => { onProgress?.(); onComplete?.(); };
  }, []);

  const addTab = (shellName?: string, shellPath?: string) => {
    const id = `tab-${Date.now()}`;
    const sn = shellName || defaultShell.name;
    const sp = shellPath || defaultShell.path;
    const layout = createInitialLayout(id, sn, sp);
    setTabs(prev => [...prev, { id, title: `Workspace ${prev.length + 1}`, layout }]);
    setActiveTabId(id);
    // 새 워크스페이스의 루트 패널 자동 선택
    if (layout.type === 'leaf') setSelectedPanelId(layout.id);
  };

  // 파일 비교 워크스페이스 추가 — CompareWorkspace 컴포넌트가 내부 상태로 양쪽 소스/경로 선택 처리
  const addCompareTab = () => {
    const id = `compare-${Date.now()}`;
    const layout = createInitialLayout(id);
    setTabs(prev => [...prev, { id, title: ttab('compareWorkspace'), layout, type: 'compare', compare: {} }]);
    setActiveTabId(id);
  };

  // 로그 분석 워크스페이스 추가
  const addLogAnalyzerTab = () => {
    const id = `log-${Date.now()}`;
    const layout = createInitialLayout(id);
    setTabs(prev => [...prev, { id, title: ttab('logAnalyzerWorkspace'), layout, type: 'logAnalyzer', logAnalyzer: {} }]);
    setActiveTabId(id);
  };

  // 번역 편집 워크스페이스 추가 (단일 인스턴스)
  const addI18nEditorTab = () => {
    const existing = tabs.find(t => t.type === 'i18nEditor');
    if (existing) { setActiveTabId(existing.id); return; }
    const id = `i18n-${Date.now()}`;
    const layout = createInitialLayout(id);
    setTabs(prev => [...prev, { id, title: ttab('translationEditor'), layout, type: 'i18nEditor', i18nEditor: {} }]);
    setActiveTabId(id);
  };

  // VPN 워크스페이스 추가
  const addVpnTab = () => {
    const existing = tabs.find(t => t.type === 'vpn');
    if (existing) { setActiveTabId(existing.id); return; }
    const id = `vpn-${Date.now()}`;
    const layout = createInitialLayout(id);
    setTabs(prev => [...prev, { id, title: ttab('vpnWorkspace'), layout, type: 'vpn', vpn: {} }]);
    setActiveTabId(id);
  };

  // 브라우저 워크스페이스 추가 — URL 입력 모달 (Electron 에선 window.prompt 비활성)
  const [newBrowserUrlPrompt, setNewBrowserUrlPrompt] = useState<{ value: string } | null>(null);
  const createBrowserTabWithUrl = (url: string) => {
    let u = url.trim();
    if (!u) return;
    if (!/^[a-z]+:\/\//i.test(u)) u = 'https://' + u;
    const id = `browser-${Date.now()}`;
    const layout = createInitialLayout(id);
    let host = u;
    try { host = new URL(u).hostname; } catch {}
    setTabs(prev => [...prev, { id, title: `🌐 ${host}`, layout, type: 'browser', browser: { url: u } }]);
    setActiveTabId(id);
  };
  const addBrowserTab = (initialUrl?: string) => {
    if (initialUrl && initialUrl.trim()) {
      createBrowserTabWithUrl(initialUrl);
    } else {
      setNewBrowserUrlPrompt({ value: 'https://www.google.com' });
    }
  };

  // 원격 파일을 에디터 탭에서 열기
  const handleOpenRemoteFile = (termId: string, remotePath: string, fileName: string) => {
    // 이미 같은 파일 열린 탭 있으면 전환
    const existing = tabs.find(t => t.type === 'fileEditor' && t.editor?.termId === termId && t.editor?.remotePath === remotePath);
    if (existing) { setActiveTabId(existing.id); return; }
    const id = `editor-${Date.now()}`;
    const layout = createInitialLayout(id);
    setTabs(prev => [...prev, { id, title: `📝 ${fileName}`, layout, type: 'fileEditor', editor: { termId, remotePath, fileName } }]);
    setActiveTabId(id);
  };

  // Claude 에 파일/폴더 첨부 (WebDAV 마운트 방식 - 실시간 SSH 접근)
  const handleAttachToClaude = async (termId: string, remotePath: string, _fileName: string, isDir: boolean) => {
    setShowClaudeChat(true);
    setClaudeAttaching({ message: 'WebDAV 마운트 준비 중...', progress: 0, total: 1 });
    try {
      // 세션 라벨(표시용)
      let sessionLabel = termId;
      try {
        const sess = findTermSession(termId);
        if (sess) sessionLabel = sess.sessionName || sess.host || termId;
      } catch {}

      // 세션 등록 (한 번만 실제 등록됨 - 내부에서 중복 체크)
      const reg: any = await (window as any).api?.claudeRegisterMount?.(termId, sessionLabel);
      if (!reg?.success) {
        setClaudeAttaching({ message: `마운트 실패: ${reg?.error || '알 수 없음'}`, progress: 0, total: 0 });
        setTimeout(() => setClaudeAttaching(null), 3500);
        return;
      }

      // UNC 경로 생성
      const pathRes: any = await (window as any).api?.claudeGetMountPath?.(termId, remotePath);
      if (!pathRes?.success) {
        setClaudeAttaching({ message: `경로 변환 실패: ${pathRes?.error || '알 수 없음'}`, progress: 0, total: 0 });
        setTimeout(() => setClaudeAttaching(null), 3500);
        return;
      }

      setClaudeMountEntries(prev => {
        const map = new Map(prev.map(e => [`${e.termId}:${e.remotePath}`, e]));
        map.set(`${termId}:${remotePath}`, { termId, remotePath, uncPath: pathRes.uncPath, isDir });
        return Array.from(map.values());
      });
      setClaudeAttaching({ message: `첨부 완료 (WebDAV 실시간 접근)`, progress: 1, total: 1 });
      setTimeout(() => setClaudeAttaching(null), 2000);
    } catch (err: any) {
      setClaudeAttaching({ message: `첨부 실패: ${err}`, progress: 0, total: 0 });
      setTimeout(() => setClaudeAttaching(null), 3500);
    }
  };

  // termId → session meta 찾기 헬퍼 (sessionName/host 참조용)
  const findTermSession = (termId: string): { sessionName?: string; host?: string } | null => {
    for (const tab of tabs) {
      const walk = (n: any): any => {
        if (n.type === 'leaf' && n.termId === termId) return n;
        if (n.children) for (const c of n.children) { const r = walk(c); if (r) return r; }
        return null;
      };
      const leaf = walk(tab.layout);
      if (leaf) return { sessionName: leaf.sessionName, host: leaf.host };
    }
    return null;
  };

  const renameTab = (id: TabId, name: string) => {
    setTabs(prev => prev.map(t => t.id === id ? { ...t, title: name, customTitle: true } : t));
  };

  const closeTab = (id: TabId) => {
    setTabs(prev => { const f = prev.filter(t => t.id !== id); return f.length === 0 ? prev : f; });
    setActiveTabId(prev => {
      if (prev !== id) return prev;
      const r = tabs.filter(t => t.id !== id);
      return r.length > 0 ? r[0].id : prev;
    });
  };

  const updateLayout = (tabId: TabId, fn: (layout: LayoutNode) => LayoutNode) => {
    setTabs(prev => prev.map(t => t.id === tabId ? { ...t, layout: fn(t.layout) } : t));
  };

  // 현재 활성 세션의 folderId 기준으로 같은 폴더 세션들을 picker 로 띄운다.
  // 픽커에서 선택된 세션을 새 termId 로 연결해서 targetNodeId 패널을 분할해 배치.
  // 활성 세션이 없거나 folder 내 다른 세션이 없으면 그냥 빈 분할.
  const openSplitSessionPicker = async (dir: 'row' | 'column', targetNodeId: string) => {
    // 세션 픽커 없이 바로 빈 분할 (로컬 쉘 패널 자동 생성)
    if (!activeTab) return;
    splitPanel(activeTab.id, targetNodeId, dir);
  };

  // 세션 선택 팝업 — 파일트리 형식 (폴더 + 세션 계층 구조)
  const openSplitSessionPickerWithPrompt = async (dir: 'row' | 'column', targetNodeId: string) => {
    if (!activeTab) return;
    const curTid = getActiveTermId();
    try {
      const data: any = await (window as any).api?.listSessions?.();
      const sessions: any[] = data?.sessions ?? data ?? [];
      const folders: any[] = data?.folders ?? [];
      const sessionItems = sessions.map(s => ({
        sessionId: s.id, sessionName: s.name, host: s.host || '', termId: '',
        folderId: s.folderId, icon: s.icon,
      }));
      const folderItems = folders.map((f: any) => ({ id: f.id, name: f.name, parentId: f.parentId }));
      if (sessionItems.length === 0) {
        splitPanel(activeTab.id, targetNodeId, dir);
        return;
      }
      setSplitPickerCollapsed(new Set());
      setSplitSessionPicker({
        dir, sessions: sessionItems, folders: folderItems,
        srcTermId: curTid || undefined, targetNodeId,
      });
    } catch {
      splitPanel(activeTab.id, targetNodeId, dir);
    }
  };

  const splitPanel = (tabId: TabId, targetNodeId: string, direction: 'row' | 'column') => {
    updateLayout(tabId, layout => splitNode(layout, targetNodeId, direction));
    setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
  };

  const handleSplitSessionSelect = async (target: { sessionId: string; sessionName: string; host: string; termId: string }) => {
    if (!activeTab || !splitSessionPicker) return;
    const { dir, targetNodeId } = splitSessionPicker;
    const newTermId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const newSess: PanelSession = { termId: newTermId, sessionId: target.sessionId, sessionName: target.sessionName };
    // 세션 데이터에서 theme/font 가져오기
    let fullSess: any = null;
    try {
      const data: any = await (window as any).api?.listSessions?.();
      const all: any[] = data?.sessions ?? data ?? [];
      fullSess = all.find((s: any) => s.id === target.sessionId);
    } catch {}
    updateLayout(activeTab.id, layout => splitNodeWithSessions(layout, targetNodeId, dir, [newSess], false));
    setTimeout(async () => {
      // 세션 설정 적용 (theme / fontFamily / fontSize / scrollback)
      if (fullSess?.scrollback) applyScrollbackToTerm(newTermId, fullSess.scrollback);
      setTimeout(() => {
        if (fullSess?.theme) applyThemeToTerm(newTermId, fullSess.theme);
        if (fullSess?.fontFamily || fullSess?.fontSize) applyFontToTerm(newTermId, fullSess?.fontFamily, fullSess?.fontSize);
      }, 200);
      try {
        const r = await (window as any).api.connectSSH(newTermId, target.sessionId);
        if (r === 'need-password') promptPasswordAndConnect(newTermId, target.sessionId);
      } catch {}
      registerTermSession(newTermId, target.sessionId, target.sessionName, target.host);
      setTimeout(() => { refitAllTerms(); focusTerm(newTermId); }, 100);
    }, 100);
    setSplitSessionPicker(null);
  };

  const closePanel = (tabId: TabId, targetNodeId: string) => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;
    if (countLeaves(tab.layout) === 1) {
      if (tab.layout.type === 'leaf') tab.layout.panel.sessions.forEach(s => window.api?.disconnectSSH?.(s.termId));
      return;
    }
    updateLayout(tabId, layout => removeLeafNode(layout, targetNodeId));
  };

  const handleSwitchSession = (nodeId: string, idx: number) => {
    if (!activeTab) return;
    // 동일 idx 면 layout 변경 안함 — 더블클릭 시 onClick × 2 가 동일 idx 로 호출되어 React 재렌더 cascade 발생하던 문제 회피
    let alreadySame = false;
    const findActive = (node: any): void => {
      if (alreadySame) return;
      if (node.type === 'leaf' && node.id === nodeId) {
        if (node.panel.activeIdx === idx) alreadySame = true;
        return;
      }
      if (node.type !== 'leaf') node.children.forEach(findActive);
    };
    findActive(activeTab.layout);
    if (alreadySame) return;
    updateLayout(activeTab.id, layout => switchPanelSession(layout, nodeId, idx));
  };

  const handleReorderSession = (nodeId: string, fromIdx: number, toIdx: number) => {
    if (!activeTab || fromIdx === toIdx) return;
    updateLayout(activeTab.id, layout => reorderPanelSession(layout, nodeId, fromIdx, toIdx));
  };

  // 세션 제거 후 빈 패널 정리 (leaf가 1개뿐이면 유지)
  const cleanEmptyLeaf = (layout: LayoutNode, nodeId: string): LayoutNode => {
    if (countLeaves(layout) <= 1) return layout;
    const isEmpty = (node: LayoutNode): boolean => {
      if (node.type === 'leaf') return node.id === nodeId && node.panel.sessions.length === 0;
      return node.children.some(isEmpty);
    };
    return isEmpty(layout) ? removeLeafNode(layout, nodeId) : layout;
  };

  // 세션(터미널)을 다른 워크스페이스로 통째로 이동 — 단일 상태 업데이트로 termId 유지하며 옮김
  const handleMoveSessionToWorkspace = (fromNodeId: string, termId: string, targetTabId: string) => {
    if (!activeTab) return;
    // 새 워크스페이스 생성 옵션
    if (targetTabId === '__new__') {
      const newId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const newTab = { id: newId, title: `Workspace ${tabs.length + 1}`, layout: createInitialLayout(newId) } as any;
      setTabs(prev => [...prev, newTab]);
      // 다음 tick 에 이동 진행
      setTimeout(() => handleMoveSessionToWorkspace(fromNodeId, termId, newId), 30);
      return;
    }
    if (activeTab.id === targetTabId) return;
    setTabs(prev => {
      const fromTab = prev.find(t => t.id === activeTab.id);
      const toTab = prev.find(t => t.id === targetTabId);
      if (!fromTab || !toTab) return prev;
      // 세션 객체 추출
      const findSess = (node: LayoutNode): PanelSession | null => {
        if (node.type === 'leaf' && node.id === fromNodeId) return node.panel.sessions.find(s => s.termId === termId) ?? null;
        if (node.type !== 'leaf') for (const c of node.children) { const r = findSess(c); if (r) return r; }
        return null;
      };
      const sess = findSess(fromTab.layout);
      if (!sess) return prev;
      // from 에서 제거
      let fromLayout = removeSessionFromPanel(fromTab.layout, fromNodeId, termId);
      fromLayout = cleanEmptyLeaf(fromLayout, fromNodeId);
      // to 에 추가 (첫 leaf, 추가된 세션을 active 로)
      const targetLeafId = findFirstLeafId(toTab.layout);
      if (!targetLeafId) return prev;
      const toLayout = appendSessionsToPanel(toTab.layout, targetLeafId, [sess], true);
      return prev.map(t => {
        if (t.id === fromTab.id) return { ...t, layout: fromLayout };
        if (t.id === toTab.id) return { ...t, layout: toLayout };
        return t;
      });
    });
    // 타겟 워크스페이스로 전환
    setActiveTabId(targetTabId);
  };

  const handleMoveSession = (fromNodeId: string, termId: string, toNodeId: string) => {
    if (!activeTab) return;
    updateLayout(activeTab.id, layout => {
      const findSess = (node: LayoutNode): PanelSession | null => {
        if (node.type === 'leaf' && node.id === fromNodeId) return node.panel.sessions.find(s => s.termId === termId) ?? null;
        if (node.type !== 'leaf') for (const c of node.children) { const r = findSess(c); if (r) return r; }
        return null;
      };
      const sess = findSess(layout);
      if (!sess) return layout;
      let updated = removeSessionFromPanel(layout, fromNodeId, termId);
      updated = appendSessionsToPanel(updated, toNodeId, [sess], false);
      updated = cleanEmptyLeaf(updated, fromNodeId);
      return updated;
    });
  };

  // 미니탭을 다른 패널 가장자리에 드롭 → 분할 + 세션 이동
  const handleSplitMoveSession = (fromNodeId: string, termId: string, toNodeId: string, zone: 'left' | 'right' | 'top' | 'bottom') => {
    if (!activeTab) return;
    updateLayout(activeTab.id, layout => {
      const findSess = (node: LayoutNode): PanelSession | null => {
        if (node.type === 'leaf' && node.id === fromNodeId) return node.panel.sessions.find(s => s.termId === termId) ?? null;
        if (node.type !== 'leaf') for (const c of node.children) { const r = findSess(c); if (r) return r; }
        return null;
      };
      const sess = findSess(layout);
      if (!sess) return layout;
      const direction: 'row' | 'column' = (zone === 'left' || zone === 'right') ? 'row' : 'column';
      const insertBefore = zone === 'left' || zone === 'top';
      let updated = removeSessionFromPanel(layout, fromNodeId, termId);
      updated = cleanEmptyLeaf(updated, fromNodeId);
      updated = splitNodeWithSessions(updated, toNodeId, direction, [sess], insertBefore);
      return updated;
    });
    setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
  };

  const handleAddSession = (nodeId: string, shellName?: string, shellPath?: string) => {
    if (!activeTab) return;
    const termId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sess: PanelSession = { termId, sessionId: '', sessionName: shellName || defaultShell.name, shellPath: shellPath || defaultShell.path };
    updateLayout(activeTab.id, layout => appendSessionsToPanel(layout, nodeId, [sess], true));
    setSelectedPanelId(nodeId);
  };

  const handleDuplicateSession = (nodeId: string, termId: string) => {
    if (!activeTab) return;
    const info = getTermSessionInfo(termId);
    if (!info) return;
    const newTermId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sess: PanelSession = { termId: newTermId, sessionId: info.sessionId || '', sessionName: info.sessionName || 'New Tab' };
    // 생성 전에 스타일(테마/폰트/불투명도)을 복제 → 새 터미널 생성 시 바로 반영됨
    cloneTermStyle(termId, newTermId);
    updateLayout(activeTab.id, layout => appendSessionsToPanel(layout, nodeId, [sess], true));
    registerTermSession(newTermId, info.sessionId || '', info.sessionName, info.host, info.quickSession);
    // 복제 대상이 quick connect 세션이면 PTY 스폰 차단 표식
    if (!info.sessionId && info.quickSession) markQuickConnectPending(newTermId);
    setTimeout(async () => {
      try {
        if (info.sessionId) {
          await (window as any).api?.connectSSH?.(newTermId, info.sessionId);
        } else if (info.quickSession) {
          await (window as any).api?.quickConnectSSH?.(newTermId, info.quickSession);
        }
        // 런타임에 변경된 인코딩까지 복제
        try {
          const srcEnc = await (window as any).api?.getSSHEncoding?.(termId);
          if (srcEnc) await (window as any).api?.setSSHEncoding?.(newTermId, srcEnc);
        } catch {}
        // 복제 직후 스타일 재적용 (새 xterm 마운트 이후에도 확실히 반영)
        cloneTermStyle(termId, newTermId);
      } catch {}
    }, 50);
  };

  const handleRenameSession = (nodeId: string, termId: string, name: string) => {
    if (!activeTab) return;
    updateLayout(activeTab.id, layout => {
      function walk(node: LayoutNode): LayoutNode {
        if (node.type === 'leaf' && node.id === nodeId) {
          const sessions = node.panel.sessions.map(s => s.termId === termId ? { ...s, sessionName: name } : s);
          return { ...node, panel: { ...node.panel, sessions } };
        }
        if (node.type !== 'leaf') return { ...node, children: node.children.map(walk) };
        return node;
      }
      return walk(layout);
    });
  };

  const handleConnectDrop = (nodeId: string, sessionId: string) => {
    if (!activeTab) return;
    const doConnect = async () => {
      try {
        const data = await (window as any).api.listSessions();
        const allSessions = data?.sessions ?? data ?? [];
        const session = allSessions.find((s: any) => s.id === sessionId);
        if (!session) return;

        let existingCount = 0;
        for (const t of tabs) existingCount += countSessionInTree(t.layout, sessionId);
        const displayName = `${session.name} #${existingCount + 1}`;

        // 해당 패널의 활성 미니탭이 빈(sessionId='') 세션이면 교체
        const findEmpty = (node: LayoutNode): PanelSession | null => {
          if (node.type === 'leaf' && node.id === nodeId) {
            const sess = node.panel.sessions[node.panel.activeIdx];
            return (sess && !sess.sessionId) ? sess : null;
          }
          if (node.type !== 'leaf') for (const c of node.children) { const r = findEmpty(c); if (r) return r; }
          return null;
        };
        const emptySess = findEmpty(activeTab.layout);

        if (emptySess) {
          // 빈 미니탭 → 세션 정보 교체 후 연결
          resetTermConnectState(emptySess.termId);
          updateLayout(activeTab.id, layout => {
            function walk(node: LayoutNode): LayoutNode {
              if (node.type === 'leaf' && node.id === nodeId) {
                const sessions = node.panel.sessions.map((s, i) =>
                  i === node.panel.activeIdx ? { ...s, sessionId, sessionName: displayName } : s
                );
                return { ...node, panel: { ...node.panel, sessions } };
              }
              if (node.type !== 'leaf') return { ...node, children: node.children.map(walk) };
              return node;
            }
            return walk(layout);
          });
          setTimeout(() => (window as any).api.connectSSH(emptySess.termId, sessionId), 100);
          if (session.theme) setTimeout(() => applyThemeToTerm(emptySess.termId, session.theme), 200);
          if (session.fontFamily || session.fontSize) setTimeout(() => applyFontToTerm(emptySess.termId, session.fontFamily, session.fontSize), 200);
          if (session.scrollback) applyScrollbackToTerm(emptySess.termId, session.scrollback);
          registerTermSession(emptySess.termId, sessionId, displayName, session.host ?? '');
        } else {
          // 빈 미니탭 없으면 기존 흐름
          setSelectedPanelId(nodeId);
          handleConnectSession(session.id, session.name, null, session.theme, session.fontFamily, session.fontSize, session.scrollback);
        }
      } catch {}
    };
    doConnect();
  };

  const handleCloseSession = (nodeId: string, termId: string) => {
    if (!activeTab) return;
    // 녹화 중인 세션을 닫으면 자동 stop + 사용자 확인 (파일 데이터 유실 방지)
    if (isRecording(termId)) {
      const ok = window.confirm(tterm('recordCloseConfirm'));
      if (!ok) return;
      stopRecording(termId).catch(() => {});
    }
    updateLayout(activeTab.id, layout => {
      let updated = removeSessionFromPanel(layout, nodeId, termId);
      updated = cleanEmptyLeaf(updated, nodeId);
      return updated;
    });
  };

  const movePanel = useCallback((fromPanelId: string, toPanelId: string | null, position: 'before' | 'after' | 'inside' = 'after') => {
    if (!activeTab) return;
    updateLayout(activeTab.id, layout => {
      const rr = removeLeafFromTree(layout, fromPanelId);
      if (!rr.removed) return layout;
      if (!toPanelId || position === 'inside') return replaceLeaf(rr.root, toPanelId ?? fromPanelId, rr.removed);
      return insertNear(rr.root, toPanelId, rr.removed, position);
    });
  }, [activeTab]);

  // ── SSH 연결 ──

  // 선택된 패널의 활성 미니탭이 끊겨있는지 확인
  const findDisconnectedActiveSession = (layout: LayoutNode, panelId: string): PanelSession | null => {
    if (layout.type === 'leaf') {
      if (layout.id !== panelId) return null;
      const sess = layout.panel.sessions[layout.panel.activeIdx];
      if (!sess) return null;
      // 로컬 쉘(PTY)이 실행 중이면 재사용하지 않음 → 새 미니탭 생성
      if (isTermPty(sess.termId)) return null;
      return sess;
    }
    for (const c of layout.children) { const r = findDisconnectedActiveSession(c, panelId); if (r) return r; }
    return null;
  };

  const handleConnectSession = (sessionId: string, sessionName: string, _targetPanelId?: string | null, sessionTheme?: string, sessionFontFamily?: string, sessionFontSize?: number, sessionScrollback?: number) => {
    if (!activeTab) return;
    // 파일 전송 탭이면 SFTP 직접 연결하여 파일 탐색기에 추가 (점프 호스트 설정도 반영)
    if (activeTab.type === 'fileExplorer') {
      (async () => {
        try {
          const data = await (window as any).api.listSessions();
          const allSessions = data?.sessions ?? data ?? [];
          const sess = allSessions.find((s: any) => s.id === sessionId);
          if (!sess) return;
          console.log('[fe-transfer dblclick] session:', { name: sess.name, host: sess.host, jumpTargetHost: sess.jumpTargetHost });
          const connId = `sftp-fe-${Date.now()}`;
          const jumpOpts = sess.jumpTargetHost?.trim()
            ? { host: sess.jumpTargetHost.trim(), user: sess.jumpTargetUser || 'root', port: Number(sess.jumpTargetPort) || 22, password: sess.jumpTargetPassword || undefined }
            : undefined;
          const displayHost = jumpOpts ? jumpOpts.host : sess.host;
          const result = await (window as any).api.feSftpConnect?.(connId, sess.host, sess.port || 22, sess.username, sess.auth, jumpOpts);
          if (result?.success) {
            window.dispatchEvent(new CustomEvent('fe-sftp-connected', { detail: { connId, sessionName, host: displayHost } }));
          } else {
            const msg = result?.error || '알 수 없는 오류';
            console.error('[fe-sftp-connect dblclick] failed:', msg);
            alert(tfe('fileTransferConnectFail', { name: sessionName, msg }));
          }
        } catch (err: any) {
          console.error('[fe-sftp-connect dblclick] exception:', err);
        }
      })();
      return;
    }
    const applySessionTheme = (termId: string) => {
      if (sessionScrollback) applyScrollbackToTerm(termId, sessionScrollback);
      setTimeout(() => {
        if (sessionTheme) applyThemeToTerm(termId, sessionTheme);
        if (sessionFontFamily || sessionFontSize) applyFontToTerm(termId, sessionFontFamily, sessionFontSize);
        // cursorStyle / cursorBlink 도 적용 (세션 데이터에서 fetch)
        (async () => {
          try {
            const data = await (window as any).api?.listSessions?.();
            const all = data?.sessions ?? data ?? [];
            const s = all.find((x: any) => x.id === sessionId);
            // cursorStyle 미지정 시 'block' 으로 기본화. cursorBlink 는 항상 적용 (사용자 의도 반영)
            applyCursorStyleToTerm(termId, s?.cursorStyle || 'block', !!s?.cursorBlink);
          } catch {}
        })();
      }, 200);
    };
    const registerTerm = async (termId: string) => {
      // 세션 이름/호스트 정보도 전달
      try {
        const data = await (window as any).api.listSessions();
        const sessions = data?.sessions ?? data ?? [];
        const sess = sessions.find((s: any) => s.id === sessionId);
        registerTermSession(termId, sessionId, displayName, sess?.host ?? '');
      } catch {
        registerTermSession(termId, sessionId, displayName, '');
      }
    };
    let existingCount = 0;
    for (const t of tabs) existingCount += countSessionInTree(t.layout, sessionId);
    const displayName = `${sessionName} #${existingCount + 1}`;

    // 선택된 패널의 활성 미니탭 확인
    if (selectedPanelId) {
      const activeSess = findDisconnectedActiveSession(activeTab.layout, selectedPanelId);
      if (!activeSess) {
        // 활성 세션 없거나 PTY 실행 중 → 선택된 패널에 새 미니탭으로 추가
        const { layout, termId } = addSessionToPanel(activeTab.layout, selectedPanelId, sessionId, displayName);
        setTabs(prev => prev.map(t => t.id === activeTab.id ? { ...t, layout } : t));
        setTimeout(async () => {
          const r = await (window as any).api.connectSSH(termId, sessionId);
          if (r === 'need-password') {
            promptPasswordAndConnect(termId, sessionId);
          }
        }, 0);
        applySessionTheme(termId); registerTerm(termId);
        return;
      }
      if (activeSess) {
        // 연결 상태 확인 후 분기 — 연결 중(connecting)도 "사용 중"으로 간주해서 새 미니탭으로 추가
        const checkAndConnect = async () => {
          let connected = false;
          try { connected = await (window as any).api.isSSHConnected(activeSess.termId); } catch {}
          const connecting = isTermConnecting(activeSess.termId);
          if (connected || connecting) {
            // 연결 중이면 → 같은 패널에 새 미니탭으로 추가
            const { layout, termId } = addSessionToPanel(activeTab.layout, selectedPanelId!, sessionId, displayName);
            setTabs(prev => prev.map(t => t.id === activeTab.id ? { ...t, layout } : t));
            setTimeout(async () => {
              const r = await (window as any).api.connectSSH(termId, sessionId);
              if (r === 'need-password') {
                promptPasswordAndConnect(termId, sessionId);
              }
            }, 0);
            applySessionTheme(termId); registerTerm(termId);
          } else {
            // 끊겨있으면 → 기존 termId 유지, 세션 정보만 교체 후 재연결
            resetTermConnectState(activeSess.termId);
            updateLayout(activeTab.id, layout => {
              function walk(node: LayoutNode): LayoutNode {
                if (node.type === 'leaf' && node.id === selectedPanelId) {
                  const sessions = node.panel.sessions.map((s, i) =>
                    i === node.panel.activeIdx ? { ...s, sessionId, sessionName: displayName } : s
                  );
                  return { ...node, panel: { ...node.panel, sessions } };
                }
                if (node.type !== 'leaf') return { ...node, children: node.children.map(walk) };
                return node;
              }
              return walk(layout);
            });
            setTimeout(async () => {
              const r = await (window as any).api.connectSSH(activeSess.termId, sessionId);
              if (r === 'need-password') {
                promptPasswordAndConnect(activeSess.termId, sessionId);
              }
            }, 100);
            applySessionTheme(activeSess.termId); registerTerm(activeSess.termId);
          }
        };
        checkAndConnect();
        return;
      }
    }

    const emptyLeafId = findEmptyLeafId(activeTab.layout);

    if (emptyLeafId) {
      const { layout, termId } = addSessionToPanel(activeTab.layout, emptyLeafId, sessionId, displayName);
      setSelectedPanelId(emptyLeafId);
      setTabs(prev => prev.map(t => t.id === activeTab.id ? { ...t, layout } : t));
      setTimeout(() => window.api?.connectSSH?.(termId, sessionId), 0);
      applySessionTheme(termId); registerTerm(termId);
      return;
    }

    // 빈 패널 없으면 첫 번째 패널에 미니탭으로 추가
    const firstLeafId = findFirstLeafId(activeTab.layout);
    if (firstLeafId) {
      const { layout, termId } = addSessionToPanel(activeTab.layout, firstLeafId, sessionId, displayName);
      setTabs(prev => prev.map(t => t.id === activeTab.id ? { ...t, layout } : t));
      setTimeout(() => window.api?.connectSSH?.(termId, sessionId), 0);
      applySessionTheme(termId); registerTerm(termId);
    }
  };

  const handleQuickConnect = (info: QuickConnectResult) => {
    if (!activeTab) return;
    // SFTP 프로토콜이거나 파일 전송 워크스페이스가 활성이면 SFTP 직접 연결로 처리
    if (info.protocol === 'sftp' || activeTab.type === 'fileExplorer') {
      // 파일 전송 워크스페이스가 없으면 생성하고 전환
      let feTab = tabs.find(t => t.type === 'fileExplorer');
      if (!feTab) {
        const id = `tab-fe-${Date.now()}`;
        feTab = { id, title: tm('tools.fileTransfer'), layout: createInitialLayout(id), type: 'fileExplorer' };
        setTabs(prev => [...prev, feTab!]);
      }
      setActiveTabId(feTab.id);
      // FileExplorer 마운트 후 이벤트가 처리되도록 약간 지연
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('fe-quick-sftp-connect', { detail: info }));
      }, 100);
      return;
    }
    const termId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const displayName = info.name;
    const sess: PanelSession = { termId, sessionId: '', sessionName: displayName };

    // 선택된 패널의 빈 미니탭을 우선 사용, 없으면 첫 빈 패널, 없으면 첫 패널에 미니탭 추가.
    // 재사용 조건: sessionId 비어있고, PTY 미실행, SSH 미연결/미연결중, 빠른연결 대기 중도 아님.
    // (로컬 셸 / 이미 SSH 접속된 빠른연결 세션 / 입력 대기 중 세션을 SSH 가 덮어쓰면 혼란스러움)
    const findEmptyActiveInPanel = (layout: LayoutNode, panelId: string): PanelSession | null => {
      if (layout.type === 'leaf') {
        if (layout.id !== panelId) return null;
        const s = layout.panel.sessions[layout.panel.activeIdx];
        if (!s || s.sessionId) return null;
        if (isTermPty(s.termId)) return null;
        if (isTermConnected(s.termId) || isTermConnecting(s.termId)) return null;
        return s;
      }
      for (const c of layout.children) { const r = findEmptyActiveInPanel(c, panelId); if (r) return r; }
      return null;
    };

    const connect = (tid: string) => {
      // 빠른연결은 sessionId='' 이지만 SSH 핸드셰이크 진행 중 — PTY 스폰 차단 표식
      markQuickConnectPending(tid);
      registerTermSession(tid, '', displayName, info.host, info);
      setTimeout(async () => {
        const tryConnect = async (sessInfo: QuickConnectResult): Promise<void> => {
          const r = await (window as any).api?.quickConnectSSH?.(tid, sessInfo);
          if (r === 'need-credentials' || r === 'need-password') {
            const needUsername = r === 'need-credentials';
            // 자격증명 입력 모달 띄우기
            window.dispatchEvent(new CustomEvent('ssh-password-prompt', {
              detail: {
                termId: tid,
                sessionId: '',
                hostHint: sessInfo.host,
                userHint: sessInfo.username,
                needUsername,
                resolve: (result: any) => {
                  if (result === null) {
                    // 취소 — pending 해제 + 터미널에 취소 메시지 표시
                    clearQuickConnectPending(tid);
                    writeToTerm(tid, '\r\n\x1b[90m✕ 연결 취소됨.\x1b[0m\r\n');
                    return;
                  }
                  let nextUsername = sessInfo.username;
                  let nextPassword = '';
                  if (typeof result === 'string') {
                    nextPassword = result;
                  } else if (result && typeof result === 'object') {
                    nextUsername = result.username || sessInfo.username;
                    nextPassword = result.password || '';
                  }
                  const next: QuickConnectResult = {
                    ...sessInfo,
                    username: nextUsername,
                    name: nextUsername ? `${nextUsername}@${sessInfo.host}` : sessInfo.host,
                    auth: { type: 'password', password: nextPassword },
                  };
                  tryConnect(next).catch(() => {});
                },
              },
            }));
          }
        };
        tryConnect(info).catch(() => {});
      }, 100);
    };

    if (selectedPanelId) {
      const empty = findEmptyActiveInPanel(activeTab.layout, selectedPanelId);
      if (empty) {
        resetTermConnectState(empty.termId);
        updateLayout(activeTab.id, layout => {
          function walk(node: LayoutNode): LayoutNode {
            if (node.type === 'leaf' && node.id === selectedPanelId) {
              const sessions = node.panel.sessions.map((s, i) =>
                i === node.panel.activeIdx ? { ...s, sessionName: displayName } : s
              );
              return { ...node, panel: { ...node.panel, sessions } };
            }
            if (node.type !== 'leaf') return { ...node, children: node.children.map(walk) };
            return node;
          }
          return walk(layout);
        });
        connect(empty.termId);
        return;
      }
    }

    const emptyLeafId = findEmptyLeafId(activeTab.layout);
    const targetLeafId = emptyLeafId || findFirstLeafId(activeTab.layout);
    if (!targetLeafId) return;
    updateLayout(activeTab.id, layout => appendSessionsToPanel(layout, targetLeafId, [sess], true));
    setSelectedPanelId(targetLeafId);
    connect(termId);
  };

  const handleDisconnectSession = (targetPanelId?: string | null) => {
    if (!activeTab) return;
    const findTerm = (node: LayoutNode): string | null => {
      if (node.type === 'leaf') {
        if (targetPanelId && node.id !== targetPanelId) return null;
        const sess = node.panel.sessions[node.panel.activeIdx];
        return sess?.termId ?? null;
      }
      for (const c of node.children) { const r = findTerm(c); if (r) return r; }
      return null;
    };
    const tid = findTerm(activeTab.layout);
    if (tid) window.api?.disconnectSSH?.(tid);
  };

  const menuDefs: MenuDef[] = [
    {
      label: tm('file.title'),
      items: [
        { label: tm('file.newWorkspace'), action: () => addTab() },
        { label: tm('file.closeWorkspace'), action: () => activeTab && closeTab(activeTab.id), disabled: tabs.length <= 1 },
        { separator: true, label: '' },
        { label: tm('file.exportSessions'), action: () => (window as any).api.exportSessions() },
        { label: tm('file.importSessions'), action: async () => { const r = await (window as any).api.importSessions(); if (r) { window.dispatchEvent(new Event('sessions-reload')); showToast(r.addedCount != null ? tm('file.importedToast', { added: r.addedCount, total: r.totalParsed }) : tm('file.importedToastSimple')); } } },
        { separator: true, label: '' },
        { label: tm('file.quit'), action: () => window.close() },
      ],
    },
    {
      label: tm('edit.title'),
      items: [
        { label: tm('edit.copy'), shortcut: getKeybinding('copy') || 'Ctrl+Shift+C', action: () => document.execCommand('copy') },
        { label: tm('edit.paste'), shortcut: getKeybinding('paste') || 'Ctrl+Shift+V', action: () => { navigator.clipboard.readText().then(text => { const tid = getActiveTermId(); if (!tid) return; pasteToTerm(tid, text); }); } },
        { label: tm('edit.selectAll'), shortcut: getKeybinding('selectAll'), action: () => { const tid = getActiveTermId(); if (tid) selectAllInTerm(tid); } },
        { separator: true, label: '' },
        { label: tm('edit.find'), shortcut: getKeybinding('find') || 'Ctrl+Shift+F', action: () => setShowSearch(true) },
      ],
    },
    {
      label: tm('view.title'),
      items: [
        {
          label: tm('view.theme'),
          submenu: getThemeList().map(t => ({
            label: t,
            action: () => handleThemeChange(t),
          })),
        },
        { separator: true, label: '' },
        { label: (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <svg width="20" height="14" viewBox="0 0 20 14" fill="currentColor">
                <text x="0" y="11" fontFamily="Arial,sans-serif" fontWeight="700" fontSize="6">A</text>
                <text x="5" y="11" fontFamily="Arial,sans-serif" fontWeight="700" fontSize="9">A</text>
                <text x="11" y="11" fontFamily="Arial,sans-serif" fontWeight="700" fontSize="12">A</text>
              </svg>
              {tm('view.fontSizeUp')}
            </span>
          ), shortcut: tm('view.wheelUp'), action: () => applyFontToAll(undefined, (Number(localStorage.getItem('terminalFontSize')) || 14) + 1) },
        { label: (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <svg width="20" height="14" viewBox="0 0 20 14" fill="currentColor">
                <text x="0" y="11" fontFamily="Arial,sans-serif" fontWeight="700" fontSize="12">A</text>
                <text x="9" y="11" fontFamily="Arial,sans-serif" fontWeight="700" fontSize="9">A</text>
                <text x="15" y="11" fontFamily="Arial,sans-serif" fontWeight="700" fontSize="6">A</text>
              </svg>
              {tm('view.fontSizeDown')}
            </span>
          ), shortcut: tm('view.wheelDown'), action: () => applyFontToAll(undefined, Math.max(8, (Number(localStorage.getItem('terminalFontSize')) || 14) - 1)) },
      ],
    },
    {
      label: tm('window.title'),
      items: [
        { label: (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="1" y="1" width="12" height="12" rx="1.5" /><line x1="7" y1="1" x2="7" y2="13" />
              </svg>
              {tm('window.splitH')}
            </span>
          ), shortcut: getKeybinding('splitSessionV'), action: () => { if (activeTab && selectedPanelId) openSplitSessionPicker('row', selectedPanelId); }, disabled: !selectedPanelId },
        { label: (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="1" y="1" width="12" height="12" rx="1.5" /><line x1="1" y1="7" x2="13" y2="7" />
              </svg>
              {tm('window.splitV')}
            </span>
          ), shortcut: getKeybinding('splitSessionH'), action: () => { if (activeTab && selectedPanelId) openSplitSessionPicker('column', selectedPanelId); }, disabled: !selectedPanelId },
        { separator: true, label: '' },
        { label: (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                {/* 손잡이 */}
                <line x1="11" y1="2" x2="6.5" y2="6.5" />
                {/* 빗자루 몸통 (두꺼운 사다리꼴) */}
                <path d="M3 8 L8 8 L10 13 L1 13 Z" fill="currentColor" stroke="currentColor" />
                {/* 빗자루 결 */}
                <line x1="3.5" y1="9" x2="2.5" y2="12.5" stroke="#000" strokeWidth="0.6" />
                <line x1="5" y1="9" x2="5" y2="12.5" stroke="#000" strokeWidth="0.6" />
                <line x1="6.5" y1="9" x2="7.5" y2="12.5" stroke="#000" strokeWidth="0.6" />
              </svg>
              {tm('window.clearScreen')}
            </span>
          ), shortcut: getKeybinding('clearScreen') || 'Ctrl+Shift+L', action: () => { const tid = getActiveTermId(); if (tid) clearScreenInTerm(tid); } },
        { label: tm('window.clearScrollback'), shortcut: getKeybinding('clearScrollback') || 'Ctrl+Shift+B', action: () => { const tid = getActiveTermId(); if (tid) clearScrollbackInTerm(tid); } },
        { label: tm('window.clearAll'), shortcut: getKeybinding('clearAll') || 'Ctrl+Shift+A', action: () => { const tid = getActiveTermId(); if (tid) clearAllInTerm(tid); } },
      ],
    },
    {
      label: tm('tools.title'),
      items: [
        { label: tm('tools.fileTransfer'), action: () => {
          const id = `tab-fe-${Date.now()}`;
          setTabs(prev => [...prev, { id, title: tm('tools.fileTransfer'), layout: createInitialLayout(id), type: 'fileExplorer' }]);
          setActiveTabId(id);
        }},
        { separator: true, label: '' },
        { label: showToolbar ? tm('tools.toolbarHide') : tm('tools.toolbarShow'), action: () => setShowToolbar(v => !v) },
        { label: showQuickConnect ? tm('tools.quickConnectHide') : tm('tools.quickConnectShow'), action: () => setShowQuickConnect(v => !v) },
        { label: showClaudeChat
            ? (termSettings.aiAgent === 'gemini' ? tm('tools.claudeHide').replace('Claude', 'Gemini').replace('🤖', '✨') : termSettings.aiAgent === 'codex' ? tm('tools.claudeHide').replace('Claude', 'Codex').replace('🤖', '🧠') : tm('tools.claudeHide'))
            : (termSettings.aiAgent === 'gemini' ? tm('tools.claudeShow').replace('Claude', 'Gemini').replace('🤖', '✨') : termSettings.aiAgent === 'codex' ? tm('tools.claudeShow').replace('Claude', 'Codex').replace('🤖', '🧠') : tm('tools.claudeShow')),
          action: () => setShowClaudeChat(v => !v) },
        { label: showBroadcast ? tm('tools.broadcastHide') : tm('tools.broadcastShow'), action: () => { setShowBroadcast(v => !v); } },
        { separator: true, label: '' },
        { label: tm('tools.xStart'), action: async () => {
          try {
            const r = await (window as any).api?.x11Start?.(0);
            if (r?.usedBundled) {
              setInfoModal({ title: tm('tools.xStartTitle'), text: tm('tools.xStartOk', { pid: r.pid }) });
              setTimeout(() => { setInfoModal(null); restoreTerminalFocus(); }, 1200);
            } else {
              setInfoModal({ title: tm('tools.xStartTitle'), text: `${tm('tools.xStartNoBundle')}\n\n${(r?.logs || []).slice(-5).join('\n')}` });
            }
          } catch (e: any) {
            setInfoModal({ title: tm('tools.xStartFail'), text: String(e?.message || e) });
          }
        }},
        { label: tm('tools.xStop'), action: async () => {
          try {
            await (window as any).api?.x11Stop?.(0);
            setInfoModal({ title: tm('tools.xStopTitle'), text: tm('tools.xStopOk') });
            setTimeout(() => { setInfoModal(null); restoreTerminalFocus(); }, 1200);
          } catch (e: any) {
            setInfoModal({ title: tm('tools.xStopFail'), text: String(e?.message || e) });
          }
        }},
        { label: tm('tools.xStatus'), action: async () => {
          try {
            const r = await (window as any).api?.x11Status?.();
            const text = r?.anyRunning
              ? `${tm('tools.xStatusRunning')}\n\n` + r.running.map((x: { displayNum: number; pid: number }) => `  • DISPLAY=:${x.displayNum}  PID=${x.pid}`).join('\n')
              : tm('tools.xStatusNone');
            setInfoModal({ title: tm('tools.xStatusTitle'), text });
          } catch (e: any) {
            setInfoModal({ title: tm('tools.xStatusFail'), text: String(e?.message || e) });
          }
        }},
        { separator: true, label: '' },
        { label: tm('tools.options'), action: async () => {
          setWordSepValue(getWordSeparator());
          setTermSettings(getTerminalSettings());
          setOptFontFamily(localStorage.getItem('terminalFontFamily') || '');
          setOptFontSize(Number(localStorage.getItem('terminalFontSize')) || 14);
          setOptDefaultShellPath(defaultShell.path);
          (window as any).api?.checkContextMenu?.().then((v: boolean) => setContextMenuRegistered(v)).catch(() => {});
          // 시스템 고정폭 폰트 감지
          const monoFonts = [
            'Cascadia Mono', 'Cascadia Code', 'Consolas', 'Courier New',
            'D2Coding', 'D2Coding ligature', 'D2CodingLigature',
            'Fira Code', 'Fira Mono', 'JetBrains Mono',
            'Source Code Pro', 'Ubuntu Mono', 'IBM Plex Mono',
            'Hack', 'Inconsolata', 'Monaco', 'Menlo',
            'Noto Sans Mono', 'Roboto Mono', 'SF Mono',
            'NanumGothicCoding', 'Malgun Gothic',
            'Lucida Console', 'DejaVu Sans Mono',
          ];
          const detected: string[] = [];
          for (const f of monoFonts) {
            try { if (document.fonts.check(`12px "${f}"`)) detected.push(f); } catch {}
          }
          setAvailableFonts(detected);
          setOptionsTab('terminal');
          setKeybindingsDraft({ ...keybindingsState });
          try { const p = await (window as any).api.getSessionsPath(); setSessionsPathDisplay(p || ''); } catch {}
          setShowOptions(true);
        } },
      ],
    },
    {
      label: tm('help.title'),
      items: [
        { label: tm('help.manual'), action: () => setShowManual(true) },
        { separator: true, label: '' },
        { label: tm('help.keybindings'), action: () => { setKeybindingListQuery(''); setShowKeybindingList(true); } },
        { separator: true, label: '' },
        { label: tm('help.about'), action: async () => {
          let sessPath = '';
          try { sessPath = await (window as any).api.getSessionsPath(); } catch {}
          // 버전은 Electron 에서 동적으로 가져옴 (package.json 기반 — 빌드시마다 자동 반영)
          let version = '';
          try { version = await (window as any).api?.getAppVersion?.() || ''; } catch {}
          // 최신 릴리즈 노트도 동적으로 — docs/RELEASE_v{version}.md 가 있으면 사용
          let releaseNotes = '';
          try { releaseNotes = await (window as any).api?.getReleaseNotes?.() || ''; } catch {}
          const sections = [
            'terminalBasics','workspacePanel','sessionMgmt','remoteExplorer','claudeIntegration',
            'vNewly','inputBroadcast','search','settings','windowsIntegration','techStack'
          ];
          const body = sections.map(s => `${ta(`${s}.heading`)}\n${ta(`${s}.body`)}`).join('\n\n');
          setInfoModal({ title: tm('help.about'), text: (
          `${ta('title', { version: version || '?' })}\n\n` +
          `${ta('credits')}\n\n` +
          body + '\n\n' +
          `${ta('sessionsPath')}\n` +
          (sessPath || ta('unknown')) +
          (releaseNotes ? `\n\n${ta('releaseNotesHeader', { version })}\n${releaseNotes}` : '')
        ) }); } },
      ],
    },
  ];

  return (
    <div
      className={`app-root${showBroadcast ? ' has-broadcast' : ''}${showQuickConnect ? ' has-quickconnect' : ''}${fullscreenTermId ? ' term-fullscreen' : ''}${showClaudeChat && claudeChatPinned ? ' has-claude-pinned' : ''}${showClaudeChat && !claudeChatPinned ? ' has-claude-autohide' : ''}${showClaudeChat && !claudeChatPinned && claudeChatVisible ? ' has-claude-visible' : ''}${topPanel ? ' top-panel-' + topPanel : ''}`}
      onMouseMove={e => {
        // 세션/파일트리 모두 unpinned 상태에서 마우스 위치에 따라 topPanel 전환
        const t = e.target as HTMLElement | null;
        if (!t || !t.closest) return;
        if (t.closest('.session-sidebar-inner, .session-sidebar-trigger')) {
          if (topPanel !== 'session') setTopPanel('session');
        } else if (t.closest('.workspace-file-tree, .workspace-file-tree-trigger')) {
          if (topPanel !== 'filetree') setTopPanel('filetree');
        }
      }}
      data-fs-term={fullscreenTermId || ''}
      style={{ ['--claude-chat-width' as any]: `${claudeChatWidth}px` }}
    >
      <SessionList
        onConnect={(sid, name, panelId, sessTheme, ff, fs, sb) => handleConnectSession(sid, name, panelId, sessTheme, ff, fs, sb)}
        workspaceTabs={tabs.map(t => ({ id: t.id, title: t.title }))}
        activeTabId={activeTabId}
        onMultiConnect={(sessList, mode, opts) => {
          if (sessList.length === 0) return;
          let targetTabId: string;
          let targetPanelId: string | null = null;
          if (opts?.newWorkspace) {
            const newTabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            const newTab = { id: newTabId, title: `Workspace ${tabs.length + 1}`, layout: createInitialLayout(newTabId) } as any;
            setTabs(prev => [...prev, newTab]);
            setActiveTabId(newTabId);
            targetTabId = newTabId;
            targetPanelId = findFirstLeafId(newTab.layout);
          } else if (opts?.targetTabId) {
            const wsTab = tabs.find(t => t.id === opts.targetTabId);
            if (!wsTab) return;
            targetTabId = wsTab.id;
            setActiveTabId(wsTab.id);
            targetPanelId = findFirstLeafId(wsTab.layout);
          } else {
            if (!activeTab) return;
            targetTabId = activeTab.id;
            targetPanelId = selectedPanelId || findFirstLeafId(activeTab.layout);
          }
          if (!targetPanelId) return;
          const panelId = targetPanelId;
          if (mode === 'minitab') {
            // 한 번의 layout 업데이트로 모든 세션을 미니탭에 추가
            const newTermIds: string[] = [];
            updateLayout(targetTabId, layout => {
              let current = layout;
              for (const s of sessList) {
                const result = addSessionToPanel(current, panelId, s.id, s.name);
                newTermIds.push(result.termId);
                current = result.layout;
              }
              return current;
            });
            // 모든 세션 동시 연결 + 테마/폰트 적용
            setTimeout(() => {
              for (let i = 0; i < sessList.length; i++) {
                const s = sessList[i] as any;
                const tid = newTermIds[i];
                if (s.scrollback) applyScrollbackToTerm(tid, s.scrollback);
                setTimeout(() => {
                  if (s.theme) applyThemeToTerm(tid, s.theme);
                  if (s.fontFamily || s.fontSize) applyFontToTerm(tid, s.fontFamily, s.fontSize);
                }, 200);
                registerTermSession(tid, s.id, s.name, s.host ?? '');
                // sshd MaxStartups(기본 10:30:60) 초과 drop 방지 — 500ms 엇갈림으로 connect
                setTimeout(() => {
                  startInitialConnectWatchdog(tid, s.id);
                  window.api?.connectSSH?.(tid, s.id)?.then((r: string) => {
                    if (r === 'need-password') promptPasswordAndConnect(tid, s.id);
                  }).catch(() => {});
                }, i * 500);
              }
              // refit + 첫 세션으로 포커스 고정 (동시 연결 시 마지막 연결 세션이 포커스 훔치는 현상 방지)
              setTimeout(() => { refitAllTerms(); if (newTermIds[0]) focusTerm(newTermIds[0]); }, 200);
            }, 50);
          } else if (mode === 'split-tile') {
            // 타일 분할: N 개 세션을 ceil(sqrt(N)) 열 × ceil(N/cols) 행 그리드로 배치
            const newTermIds = sessList.map(() => `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
            const panelSessions: PanelSession[] = sessList.map((s, i) => ({
              termId: newTermIds[i],
              sessionId: s.id,
              sessionName: s.name,
            }));
            updateLayout(targetTabId, layout =>
              addSessionsAsTile(layout, panelId, panelSessions[0], panelSessions.slice(1))
            );
            setTimeout(() => {
              for (let i = 0; i < sessList.length; i++) {
                const s = sessList[i] as any;
                const tid = newTermIds[i];
                if (s.scrollback) applyScrollbackToTerm(tid, s.scrollback);
                setTimeout(() => {
                  if (s.theme) applyThemeToTerm(tid, s.theme);
                  if (s.fontFamily || s.fontSize) applyFontToTerm(tid, s.fontFamily, s.fontSize);
                }, 200);
                registerTermSession(tid, s.id, s.name, s.host ?? '');
                // sshd MaxStartups(기본 10:30:60) 초과 drop 방지 — 500ms 엇갈림으로 connect
                setTimeout(() => {
                  startInitialConnectWatchdog(tid, s.id);
                  window.api?.connectSSH?.(tid, s.id)?.then((r: string) => {
                    if (r === 'need-password') promptPasswordAndConnect(tid, s.id);
                  }).catch(() => {});
                }, i * 500);
              }
              // refit + 첫 세션 포커스 — stagger 전체가 끝난 뒤 포커스 확정 (뒤늦게 마운트되는 터미널이 훔쳐가는 것 방지)
              const focusDelay = 200 + sessList.length * 500 + 300;
              setTimeout(() => { refitAllTerms(); if (newTermIds[0]) focusTerm(newTermIds[0]); }, focusDelay);
            }, 50);
          } else {
            const dir: 'row' | 'column' = mode === 'split-v' ? 'row' : 'column';
            // 모든 세션의 termId를 미리 생성
            const newTermIds = sessList.map(() => `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
            // 첫 번째는 현재 패널에 세션 추가, 나머지는 분할 패널 생성 — 한 번의 layout 업데이트로 처리
            updateLayout(targetTabId, layout => {
              // 첫 번째 세션을 현재 패널에 추가
              const result = addSessionToPanel(layout, panelId, sessList[0].id, sessList[0].name);
              // 첫 번째 세션의 termId를 교체
              const replaceTermId = (node: LayoutNode): LayoutNode => {
                if (node.type === 'leaf') {
                  const sessions = node.panel.sessions.map(s => s.termId === result.termId ? { ...s, termId: newTermIds[0] } : s);
                  return { ...node, panel: { ...node.panel, sessions } };
                }
                return { ...node, children: node.children.map(replaceTermId) };
              };
              let currentLayout = replaceTermId(result.layout);
              // 나머지 세션은 분할로 추가
              let lastPanelId = panelId;
              for (let i = 1; i < sessList.length; i++) {
                const newSess: PanelSession = { termId: newTermIds[i], sessionId: sessList[i].id, sessionName: sessList[i].name };
                currentLayout = splitNodeWithSessions(currentLayout, lastPanelId, dir, [newSess], false);
              }
              return currentLayout;
            });
            // 모든 세션 동시 연결 + 테마/폰트 적용
            setTimeout(() => {
              for (let i = 0; i < sessList.length; i++) {
                const s = sessList[i] as any;
                const tid = newTermIds[i];
                if (s.scrollback) applyScrollbackToTerm(tid, s.scrollback);
                setTimeout(() => {
                  if (s.theme) applyThemeToTerm(tid, s.theme);
                  if (s.fontFamily || s.fontSize) applyFontToTerm(tid, s.fontFamily, s.fontSize);
                }, 200);
                registerTermSession(tid, s.id, s.name, s.host ?? '');
                // sshd MaxStartups(기본 10:30:60) 초과 drop 방지 — 500ms 엇갈림으로 connect
                setTimeout(() => {
                  startInitialConnectWatchdog(tid, s.id);
                  window.api?.connectSSH?.(tid, s.id)?.then((r: string) => {
                    if (r === 'need-password') promptPasswordAndConnect(tid, s.id);
                  }).catch(() => {});
                }, i * 500);
              }
              // refit + 첫 세션 포커스 — stagger 전체가 끝난 뒤 포커스 확정 (뒤늦게 마운트되는 터미널이 훔쳐가는 것 방지)
              const focusDelay = 200 + sessList.length * 500 + 300;
              setTimeout(() => { refitAllTerms(); if (newTermIds[0]) focusTerm(newTermIds[0]); }, focusDelay);
            }, 50);
          }
        }}
        onDisconnect={panelId => handleDisconnectSession(panelId)}
        targetPanelId={selectedPanelId}
        onFileTransfer={async (sessionId, sessionName) => {
          // 파일 전송 탭이 없으면 생성
          let feTab = tabs.find(t => t.type === 'fileExplorer');
          if (!feTab) {
            const id = `tab-fe-${Date.now()}`;
            feTab = { id, title: tm('tools.fileTransfer'), layout: createInitialLayout(id), type: 'fileExplorer' };
            setTabs(prev => [...prev, feTab!]);
          }
          setActiveTabId(feTab.id);
          // SFTP 연결 — 점프 타겟 설정돼 있으면 ProxyJump 로 내부 서버까지 직결
          try {
            const data = await (window as any).api.listSessions();
            const allSessions = data?.sessions ?? data ?? [];
            const sess = allSessions.find((s: any) => s.id === sessionId);
            if (!sess) return;
            console.log('[fe-transfer] selected session:', { name: sess.name, host: sess.host, jumpTargetHost: sess.jumpTargetHost, jumpTargetUser: sess.jumpTargetUser });
            const connId = `sftp-fe-${Date.now()}`;
            const jumpOpts = sess.jumpTargetHost?.trim()
              ? { host: sess.jumpTargetHost.trim(), user: sess.jumpTargetUser || 'root', port: Number(sess.jumpTargetPort) || 22, password: sess.jumpTargetPassword || undefined }
              : undefined;
            const displayHost = jumpOpts ? jumpOpts.host : sess.host;
            const result = await (window as any).api.feSftpConnect?.(connId, sess.host, sess.port || 22, sess.username, sess.auth, jumpOpts);
            if (result?.success) {
              window.dispatchEvent(new CustomEvent('fe-sftp-connected', { detail: { connId, sessionName, host: displayHost } }));
            } else {
              const msg = result?.error || '알 수 없는 오류';
              console.error('[fe-sftp-connect] failed:', msg);
              alert(tfe('fileTransferConnectFailWithDevtools', { name: sessionName, msg }));
            }
          } catch (err: any) {
            console.error('[fe-sftp-connect] exception:', err);
            alert(tfe('fileTransferConnectException', { err: err?.message || err }));
          }
        }}
        onOpenSqlTool={(sessionId, sessionName) => {
          const existing = tabs.find(t => t.type === 'sqlTool' && t.sqlTool?.sessionId === sessionId);
          if (existing) { setActiveTabId(existing.id); return; }
          const id = `tab-sql-${Date.now()}`;
          const newTab: Tab = { id, title: `🗄 SQL: ${sessionName}`, layout: createInitialLayout(id), type: 'sqlTool', sqlTool: { sessionId, sessionName } };
          setTabs(prev => [...prev, newTab]);
          setActiveTabId(id);
        }}
      />
      {/* 파일 트리는 이제 각 TerminalPanel 내부에서 mini-tab 별로 렌더링됨 (Ctrl+Shift+E 로 토글). */}
      <div className="app-main">
        <div className="tab-bar-row">
          <MenuBar menus={menuDefs} />
          <TabBar tabs={tabs} activeTabId={activeTabId} onChange={setActiveTabId} onAddTab={addTab} onAddBrowserTab={addBrowserTab} onAddCompareTab={addCompareTab} onAddLogAnalyzerTab={addLogAnalyzerTab} onAddVpnTab={addVpnTab} onAddI18nEditorTab={addI18nEditorTab} onCloseTab={closeTab} onRenameTab={renameTab}
          onReorderTabs={(fromId, toId) => {
            setTabs(prev => {
              const from = prev.findIndex(t => t.id === fromId);
              const to = prev.findIndex(t => t.id === toId);
              if (from < 0 || to < 0 || from === to) return prev;
              const next = prev.slice();
              const [moved] = next.splice(from, 1);
              next.splice(to, 0, moved);
              return next;
            });
          }}
          hasSession={tabs.reduce((acc, t) => { acc[t.id] = collectAllSessions(t.layout).length > 0; return acc; }, {} as Record<string, boolean>)}
          availableShells={availableShells}
        />
          <div className="titlebar-drag-area"
            onDoubleClick={() => {
              (window as any).api?.windowEndDrag?.();
              (window as any).api?.windowToggleMaximize?.();
              [50, 200, 500].forEach(ms => setTimeout(() => { window.dispatchEvent(new Event('resize')); refitAllTerms(); }, ms));
            }}
            onMouseDown={e => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.stopPropagation();
              const api = (window as any).api;
              const startX = e.screenX, startY = e.screenY;
              let dragStarted = false;
              const THRESHOLD = 5; // 픽셀 — 이 이상 움직여야 실제 드래그로 처리 (단순 클릭은 창 복원 안되도록)
              const onMove = (ev: MouseEvent) => {
                if (!dragStarted) {
                  if (Math.abs(ev.screenX - startX) < THRESHOLD && Math.abs(ev.screenY - startY) < THRESHOLD) return;
                  dragStarted = true;
                  api?.windowStartDrag?.(startX, startY);
                }
                ev.preventDefault();
                api?.windowDragMove?.(ev.screenX, ev.screenY);
              };
              const onUp = () => {
                if (dragStarted) api?.windowEndDrag?.();
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
              };
              window.addEventListener('mousemove', onMove);
              window.addEventListener('mouseup', onUp);
            }}
          />
          <div className="window-controls-right">
            <select className="theme-select" value={themeName} onChange={e => handleThemeChange(e.target.value)}>
              {getThemeList().map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <button className="window-ctrl-btn" onClick={() => (window as any).api?.windowMinimize?.()}>─</button>
            <button
              className="window-ctrl-btn"
              onClick={() => { (window as any).api?.windowToggleMaximize?.(); [50, 200, 500].forEach(ms => setTimeout(() => { window.dispatchEvent(new Event('resize')); refitAllTerms(); }, ms)); }}
              title={isMaximized ? '복원' : '최대화'}
            >{isMaximized ? '❐' : '☐'}</button>
            <button className="window-ctrl-btn close" onClick={() => (window as any).api?.windowClose?.()}>✕</button>
          </div>
        </div>

        {/* 도구 모음 바 — 드래그하여 빠른연결 좌/우 또는 상단으로 이동 */}
        {(() => {
          const onDragStart = (e: React.MouseEvent) => {
            e.preventDefault();
            const onMove = (ev: MouseEvent) => {
              const qc = document.querySelector('.quick-connect-bar') as HTMLElement | null;
              if (qc) {
                const r = qc.getBoundingClientRect();
                if (ev.clientY >= r.top - 8 && ev.clientY <= r.bottom + 8) {
                  const mid = r.left + r.width / 2;
                  setToolbarDragHint(ev.clientX < mid ? 'qc-left' : 'qc-right');
                  return;
                }
              }
              setToolbarDragHint('top');
            };
            const onUp = () => {
              document.removeEventListener('mousemove', onMove);
              document.removeEventListener('mouseup', onUp);
              setToolbarDragHint(curr => {
                if (curr) setToolbarSlot(curr);
                return null;
              });
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
          };
          const toolbar = (
            <div className="tool-toolbar" role="toolbar">
              <span
                className="tool-drag"
                title="드래그하여 빠른연결 좌/우 또는 상단으로"
                onMouseDown={onDragStart}
              >⋮⋮</span>
              <button className="tool-btn" title={tm('tools.fileTransfer')} onClick={() => {
            const id = `tab-fe-${Date.now()}`;
            setTabs(prev => [...prev, { id, title: tm('tools.fileTransfer'), layout: createInitialLayout(id), type: 'fileExplorer' }]);
            setActiveTabId(id);
          }}>📁</button>
          <span className="tool-sep" />
          <button className={`tool-btn ${showQuickConnect ? 'active' : ''}`} title={showQuickConnect ? tm('tools.quickConnectHide') : tm('tools.quickConnectShow')} onClick={() => setShowQuickConnect(v => !v)}>⚡</button>
          <button className={`tool-btn ${showClaudeChat ? 'active' : ''}`} title={showClaudeChat ? (termSettings.aiAgent === 'gemini' ? tm('tools.claudeHide').replace('Claude', 'Gemini').replace('🤖', '✨') : termSettings.aiAgent === 'codex' ? tm('tools.claudeHide').replace('Claude', 'Codex').replace('🤖', '🧠') : tm('tools.claudeHide')) : (termSettings.aiAgent === 'gemini' ? tm('tools.claudeShow').replace('Claude', 'Gemini').replace('🤖', '✨') : termSettings.aiAgent === 'codex' ? tm('tools.claudeShow').replace('Claude', 'Codex').replace('🤖', '🧠') : tm('tools.claudeShow'))} onClick={() => setShowClaudeChat(v => !v)}>{termSettings.aiAgent === 'gemini' ? '✨' : termSettings.aiAgent === 'codex' ? '🧠' : '🤖'}</button>
          <button className={`tool-btn ${showBroadcast ? 'active' : ''}`} title={showBroadcast ? tm('tools.broadcastHide') : tm('tools.broadcastShow')} onClick={() => setShowBroadcast(v => !v)}>📢</button>
          <span className="tool-sep" />
          <button className="tool-btn" title={tm('tools.xStart')} onClick={async () => {
            try {
              const r = await (window as any).api?.x11Start?.(0);
              if (r?.usedBundled) {
                setInfoModal({ title: tm('tools.xStartTitle'), text: tm('tools.xStartOk', { pid: r.pid }) });
                setTimeout(() => { setInfoModal(null); restoreTerminalFocus(); }, 1200);
              } else {
                setInfoModal({ title: tm('tools.xStartTitle'), text: `${tm('tools.xStartNoBundle')}\n\n${(r?.logs || []).slice(-5).join('\n')}` });
              }
            } catch (e: any) { setInfoModal({ title: tm('tools.xStartFail'), text: String(e?.message || e) }); }
          }}>🖥️</button>
          <button className="tool-btn" title={tm('tools.xStop')} onClick={async () => {
            try {
              await (window as any).api?.x11Stop?.(0);
              setInfoModal({ title: tm('tools.xStopTitle'), text: tm('tools.xStopOk') });
              setTimeout(() => { setInfoModal(null); restoreTerminalFocus(); }, 1200);
            } catch (e: any) { setInfoModal({ title: tm('tools.xStopFail'), text: String(e?.message || e) }); }
          }}>🛑</button>
          <button className="tool-btn" title={tm('tools.xStatus')} onClick={async () => {
            try {
              const r = await (window as any).api?.x11Status?.();
              const text = r?.anyRunning
                ? `${tm('tools.xStatusRunning')}\n\n` + r.running.map((x: { displayNum: number; pid: number }) => `  • DISPLAY=:${x.displayNum}  PID=${x.pid}`).join('\n')
                : tm('tools.xStatusNone');
              setInfoModal({ title: tm('tools.xStatusTitle'), text });
            } catch (e: any) { setInfoModal({ title: tm('tools.xStatusFail'), text: String(e?.message || e) }); }
          }}>ℹ️</button>
          <span className="tool-sep" />
          <button className="tool-btn" title={tm('tools.options')} onClick={async () => {
            setWordSepValue(getWordSeparator());
            setTermSettings(getTerminalSettings());
            setOptFontFamily(localStorage.getItem('terminalFontFamily') || '');
            setOptFontSize(Number(localStorage.getItem('terminalFontSize')) || 14);
            setOptDefaultShellPath(defaultShell.path);
            (window as any).api?.checkContextMenu?.().then((v: boolean) => setContextMenuRegistered(v)).catch(() => {});
            const monoFonts = ['Cascadia Mono','Cascadia Code','Consolas','Courier New','D2Coding','D2Coding ligature','D2CodingLigature','Fira Code','Fira Mono','JetBrains Mono','Source Code Pro','Ubuntu Mono','IBM Plex Mono','Hack','Inconsolata','Monaco','Menlo','Noto Sans Mono','Roboto Mono','SF Mono','NanumGothicCoding','Malgun Gothic','Lucida Console','DejaVu Sans Mono'];
            const detected: string[] = [];
            for (const f of monoFonts) { try { if (document.fonts.check(`12px "${f}"`)) detected.push(f); } catch {} }
            setAvailableFonts(detected);
            setOptionsTab('terminal');
            setKeybindingsDraft({ ...keybindingsState });
            try { const p = await (window as any).api.getSessionsPath(); setSessionsPathDisplay(p || ''); } catch {}
            setShowOptions(true);
          }}>⚙️</button>
            </div>
          );
          return (
            <>
              {showToolbar && toolbarSlot === 'top' && toolbar}
              {showToolbar && toolbarDragHint && toolbarDragHint !== toolbarSlot && (
                <div className="tool-drag-hint">→ {toolbarDragHint === 'top' ? '상단' : toolbarDragHint === 'qc-left' ? '빠른연결 왼쪽' : '빠른연결 오른쪽'}</div>
              )}
              {(showQuickConnect || (showToolbar && toolbarSlot !== 'top')) && (() => {
                const divider = <div className="qc-divider-static" />;
                const qcStyle: React.CSSProperties = (toolbarSlot === 'top' || !showToolbar)
                  ? { flex: 1 }
                  : { flex: '0 0 auto' };
                const qc = showQuickConnect ? (
                  <div className="qc-wrap" style={qcStyle}>
                    <QuickConnectBar
                      onConnect={handleQuickConnect}
                      onCancel={() => setShowQuickConnect(false)}
                      forceProtocol={activeTab?.type === 'fileExplorer' ? 'sftp' : undefined}
                    />
                  </div>
                ) : null;
                const tb = showToolbar ? toolbar : null;
                return (
                  <div className="quickconnect-row">
                    {(toolbarSlot === 'top' || !showToolbar) && qc}
                    {showToolbar && toolbarSlot === 'qc-left' && (
                      <>
                        {tb}
                        {qc && divider}
                        {qc}
                      </>
                    )}
                    {showToolbar && toolbarSlot === 'qc-right' && (
                      <>
                        {qc}
                        {qc && divider}
                        {tb}
                      </>
                    )}
                  </div>
                );
              })()}
            </>
          );
        })()}

        {showSearch && activeTab && (
          <SearchBar
            tabs={tabs}
            activeTab={activeTab}
            selectedPanelId={selectedPanelId}
            onClose={() => setShowSearch(false)}
          />
        )}

        {/* FileExplorer는 탭이 존재하면 항상 마운트 유지 (경로 상태 보존). 비활성 시 CSS로 숨김 */}
        {tabs.some(t => t.type === 'fileExplorer') && (
          <div style={{ display: activeTab?.type === 'fileExplorer' ? 'flex' : 'none', flex: 1, minHeight: 0 }}>
            <FileExplorer sessions={
              tabs.filter(t => t.type !== 'fileExplorer').flatMap(t => collectAllSessions(t.layout)).filter(s => s.sessionId)
            } />
          </div>
        )}

        {/* SQL Tool 탭들 - 마운트 유지 */}
        {tabs.filter(t => t.type === 'sqlTool' && t.sqlTool).map(t => (
          <div key={t.id} style={{ display: activeTab?.id === t.id ? 'flex' : 'none', flex: 1, minHeight: 0 }}>
            <ErrorBoundary label={`SQL Tool — ${t.sqlTool!.sessionName}`}>
              <SqlToolWorkspace sessionId={t.sqlTool!.sessionId} sessionName={t.sqlTool!.sessionName} />
            </ErrorBoundary>
          </div>
        ))}

        {/* FileEditor 탭들 - 마운트 유지 */}
        {tabs.filter(t => t.type === 'fileEditor' && t.editor).map(t => (
          <div key={t.id} style={{ display: activeTab?.id === t.id ? 'flex' : 'none', flex: 1, minHeight: 0 }}>
            <FileEditor
              termId={t.editor!.termId}
              remotePath={t.editor!.remotePath}
              fileName={t.editor!.fileName}
              onAnalyzeWithClaude={(ctx) => {
                setClaudeFileContext([ctx]);
                setShowClaudeChat(true);
              }}
            />
          </div>
        ))}

        {/* 파일 비교 탭들 - 마운트 유지 (스캔 결과 보존) */}
        {tabs.filter(t => t.type === 'compare').map(t => {
          const liveSess = tabs.filter(x => x.type !== 'fileExplorer' && x.type !== 'browser' && x.type !== 'compare' && x.type !== 'logAnalyzer').flatMap(x => collectAllSessions(x.layout));
          return (
            <div key={t.id} style={{ display: activeTab?.id === t.id ? 'flex' : 'none', flex: 1, minHeight: 0 }}>
              <ErrorBoundary label="파일 비교">
                <CompareWorkspace sessions={liveSess} />
              </ErrorBoundary>
            </div>
          );
        })}

        {/* 번역 편집 탭 - 마운트 유지 */}
        {tabs.filter(t => t.type === 'i18nEditor').map(t => (
          <div key={t.id} style={{ display: activeTab?.id === t.id ? 'flex' : 'none', flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
            <ErrorBoundary label="번역 편집">
              <TranslationEditor />
            </ErrorBoundary>
          </div>
        ))}

        {/* VPN 탭 - 마운트 유지 (연결 상태 보존) */}
        {tabs.filter(t => t.type === 'vpn').map(t => (
          <div key={t.id} style={{ display: activeTab?.id === t.id ? 'flex' : 'none', flex: 1, minHeight: 0 }}>
            <ErrorBoundary label="VPN">
              <VpnWorkspace />
            </ErrorBoundary>
          </div>
        ))}

        {/* 로그 분석 탭들 - 마운트 유지 (파싱 결과 보존) */}
        {tabs.filter(t => t.type === 'logAnalyzer').map(t => {
          const liveSess = tabs.filter(x => x.type !== 'fileExplorer' && x.type !== 'browser' && x.type !== 'compare' && x.type !== 'logAnalyzer').flatMap(x => collectAllSessions(x.layout));
          return (
            <div key={t.id} style={{ display: activeTab?.id === t.id ? 'flex' : 'none', flex: 1, minHeight: 0 }}>
              <ErrorBoundary label="로그 분석">
                <LogAnalyzer sessions={liveSess} />
              </ErrorBoundary>
            </div>
          );
        })}

        {/* 브라우저 탭들 - 마운트 유지 (워크스페이스 전환해도 페이지 상태 보존) */}
        {tabs.filter(t => t.type === 'browser' && t.browser).map(t => (
          <div key={t.id} style={{ display: activeTab?.id === t.id ? 'flex' : 'none', flex: 1, minHeight: 0 }}>
            <BrowserPane
              initialUrl={t.browser!.url}
              onTitleChange={(title) => {
                if (!title) return;
                setTabs(prev => prev.map(x => x.id === t.id ? { ...x, title: `🌐 ${title.slice(0, 30)}` } : x));
              }}
            />
          </div>
        ))}

        {activeTab && activeTab.type !== 'fileExplorer' && activeTab.type !== 'fileEditor' && activeTab.type !== 'sqlTool' && activeTab.type !== 'browser' && activeTab.type !== 'compare' && activeTab.type !== 'logAnalyzer' && activeTab.type !== 'vpn' && activeTab.type !== 'i18nEditor' && (() => {
          // 워크스페이스 레벨 파일 트리 — 선택된 패널의 활성 세션이 SSH 연결이면 표시
          let fileTreeNode: React.ReactNode = null;
          if (selectedPanelId) {
            const findLeaf = (n: any, id: string): any => {
              if (n.type === 'leaf') return n.id === id ? n : null;
              for (const c of n.children) { const r = findLeaf(c, id); if (r) return r; }
              return null;
            };
            const leaf = findLeaf(activeTab.layout, selectedPanelId);
            const sess = leaf?.panel?.sessions[leaf.panel.activeIdx];
            // SSH 연결된 세션 또는 로컬 PTY 활성 세션이면 파일트리 표시
            if (sess && ((sess.sessionId && isTermConnected(sess.termId)) || isTermPty(sess.termId))) {
              const onClickTrigger = () => {
                if (remoteTreePinned) return;
                if (remoteTreeHideTimer.current) { clearTimeout(remoteTreeHideTimer.current); remoteTreeHideTimer.current = null; }
                if (remoteTreeHoverShowTimer.current) { clearTimeout(remoteTreeHoverShowTimer.current); remoteTreeHoverShowTimer.current = null; }
                setRemoteTreeVisible(v => !v);
                setTopPanel('filetree');
              };
              const onEnterTrigger = () => {
                if (remoteTreePinned) return;
                if (remoteTreeHideTimer.current) { clearTimeout(remoteTreeHideTimer.current); remoteTreeHideTimer.current = null; }
                if (remoteTreeHoverShowTimer.current) clearTimeout(remoteTreeHoverShowTimer.current);
                // 2.5 초 hover 시 자동 열림 (Claude 트리거 패턴)
                remoteTreeHoverShowTimer.current = setTimeout(() => { setRemoteTreeVisible(true); setTopPanel('filetree'); }, 2500);
              };
              const onEnterTree = () => {
                if (remoteTreePinned) return;
                if (remoteTreeHideTimer.current) { clearTimeout(remoteTreeHideTimer.current); remoteTreeHideTimer.current = null; }
                setTopPanel('filetree');
              };
              const onLeaveTree = () => {
                if (remoteTreePinned) return;
                if (remoteTreeHideTimer.current) clearTimeout(remoteTreeHideTimer.current);
                remoteTreeHideTimer.current = setTimeout(() => setRemoteTreeVisible(false), 500);
              };
              const onLeaveTrigger = () => {
                if (remoteTreePinned) return;
                if (remoteTreeHoverShowTimer.current) { clearTimeout(remoteTreeHoverShowTimer.current); remoteTreeHoverShowTimer.current = null; }
              };
              fileTreeNode = (
                <>
                  {!remoteTreePinned && (
                    <div
                      className="workspace-file-tree-trigger"
                      style={{ ['--file-tree-trigger-top' as any]: `${fileTreeTriggerTop}px` }}
                    >
                      <div className="workspace-file-tree-trigger-top" onClick={onClickTrigger} onMouseEnter={onEnterTrigger} onMouseLeave={onLeaveTrigger} style={{ cursor: 'pointer' }} title="클릭=토글 / 2.5초 오버=자동 열림">
                        <span className="workspace-file-tree-trigger-text">📁 파일 트리</span>
                      </div>
                      <div className="workspace-file-tree-trigger-bottom" />
                    </div>
                  )}
                  <div
                    className={`workspace-file-tree ${!remoteTreePinned ? 'auto-hide' : ''} ${!remoteTreePinned && !remoteTreeVisible ? 'hidden' : ''} ${topPanel === 'filetree' ? 'top' : ''}`}
                    style={{ width: `${remoteTreeWidth}px`, flexShrink: 0 }}
                    onMouseEnter={onEnterTree}
                    onMouseLeave={onLeaveTree}
                  >
                    <div className="workspace-file-tree-toolbar">
                      <button
                        className={`workspace-file-tree-pin ${remoteTreePinned ? 'pinned' : ''}`}
                        onClick={() => setRemoteTreePinned(p => !p)}
                        title={remoteTreePinned ? tfe('unpinTooltip') : tfe('pinTooltip')}
                      >📌</button>
                    </div>
                    <RemoteFileTree
                      key={sess.termId}
                      termId={sess.termId}
                      sessionName={sess.sessionName}
                      sessionId={sess.sessionId}
                      initialPath={getCurrentPwdForTerm(sess.termId)}
                      onOpenFile={handleOpenRemoteFile}
                      onAttachToClaude={handleAttachToClaude}
                    />
                    <div
                      className="workspace-file-tree-resizer"
                      title={tfe('resizeWidth')}
                      onMouseDown={e => {
                        e.preventDefault();
                        const startX = e.clientX;
                        const startWidth = remoteTreeWidth;
                        const onMove = (ev: MouseEvent) => {
                          const w = Math.max(160, Math.min(800, startWidth + (ev.clientX - startX)));
                          setRemoteTreeWidth(w);
                        };
                        const onUp = () => {
                          window.removeEventListener('mousemove', onMove);
                          window.removeEventListener('mouseup', onUp);
                          setRemoteTreeWidth(curW => {
                            if (remoteTreeWidthLoadedRef.current) { try { (window as any).api?.setUIPrefs?.({ remoteTreeWidth: curW }); } catch {} }
                            return curW;
                          });
                          window.dispatchEvent(new Event('resize'));
                        };
                        window.addEventListener('mousemove', onMove);
                        window.addEventListener('mouseup', onUp);
                      }}
                      onDoubleClick={() => {
                        setRemoteTreeWidth(240);
                        try { (window as any).api?.setUIPrefs?.({ remoteTreeWidth: 240 }); } catch {}
                      }}
                    />
                  </div>
                </>
              );
            }
          }
          return (
            <div className="workspace-content-row" style={{ display: 'flex', flex: 1, minHeight: 0, position: 'relative' }}>
              {fileTreeNode}
              <div className="workspace-content-col" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <Layout root={activeTab.layout}
            selectedPanelId={selectedPanelId}
            onSplit={(nodeId, dir) => openSplitSessionPicker(dir, nodeId)}
            onSplitWithPicker={(nodeId, dir) => openSplitSessionPickerWithPrompt(dir, nodeId)}
            onClose={nodeId => closePanel(activeTab.id, nodeId)}
            floatingPanelId={floatingPanelId}
            fullscreenTermId={fullscreenTermId}
            workspaceList={tabs.map(t => ({ id: t.id, title: t.title }))}
            currentWorkspaceId={activeTab?.id}
            onMoveSessionToWorkspace={handleMoveSessionToWorkspace}
            onToggleFloat={nodeId => {
              setFloatingPanelId(prev => prev === nodeId ? null : nodeId);
              setTimeout(() => { window.dispatchEvent(new Event('resize')); refitAllTerms(); }, 120);
            }}
            onSelectPanel={id => setSelectedPanelId(id)}
            onMovePanel={movePanel}
            onSwitchSession={handleSwitchSession}
            onCloseSession={handleCloseSession}
            onMoveSession={handleMoveSession}
            onSplitMoveSession={handleSplitMoveSession}
            onReorderSession={handleReorderSession}
            onAddSession={handleAddSession}
            onRenameSession={handleRenameSession}
            onConnectDrop={handleConnectDrop}
            onDuplicateSession={handleDuplicateSession}
            availableShells={availableShells}
            treeWidth={remoteTreeWidth}
            onTreeWidthChange={w => {
              setRemoteTreeWidth(w);
              if (remoteTreeWidthLoadedRef.current) { try { (window as any).api?.setUIPrefs?.({ remoteTreeWidth: w }); } catch {} }
            }}
            onOpenRemoteFile={handleOpenRemoteFile}
            onAttachToClaude={handleAttachToClaude}
          />
              </div>
            </div>
          );
        })()}
      </div>

      {newBrowserUrlPrompt && (
        <div className="session-editor-backdrop" onClick={() => setNewBrowserUrlPrompt(null)}>
          <div className="session-editor" onClick={e => e.stopPropagation()} style={{ width: 480 }}>
            <h3>🌐 새 브라우저 워크스페이스</h3>
            <label style={{ fontSize: 12, color: '#bbb', marginTop: 8 }}>URL 또는 검색어</label>
            <input
              autoFocus
              type="text"
              value={newBrowserUrlPrompt.value}
              onChange={e => setNewBrowserUrlPrompt({ value: e.target.value })}
              onKeyDown={e => {
                e.stopPropagation();
                if (e.key === 'Enter') { createBrowserTabWithUrl(newBrowserUrlPrompt.value); setNewBrowserUrlPrompt(null); }
                if (e.key === 'Escape') setNewBrowserUrlPrompt(null);
              }}
              placeholder="https://www.google.com"
              style={{ fontSize: 13, padding: '6px 8px' }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
              <button onClick={() => setNewBrowserUrlPrompt(null)}>취소</button>
              <button className="primary" onClick={() => { createBrowserTabWithUrl(newBrowserUrlPrompt.value); setNewBrowserUrlPrompt(null); }}>열기</button>
            </div>
          </div>
        </div>
      )}

      {showBroadcast && (
        <div className="broadcast-bar">
          <button className="broadcast-close" onClick={() => setShowBroadcast(false)} title={tb('close')}>✕</button>
          <span className="broadcast-label" title={tb('label')}>📢</span>
          <select
            className="broadcast-scope"
            value={broadcastScope}
            onChange={e => setBroadcastScope(e.target.value as any)}
            title={tb('scope')}
          >
            <option value="visible">{tb('scopeVisible', { count: collectBroadcastTargets('visible').length })}</option>
            <option value="current">{tb('scopeCurrent', { count: collectBroadcastTargets('current').length })}</option>
            <option value="connected">{tb('scopeConnected', { count: collectBroadcastTargets('connected').length })}</option>
          </select>
          <div style={{ position: 'relative', flex: 1, display: 'flex' }}>
            <input
              className="broadcast-input"
              autoFocus
              value={broadcastText}
              onChange={e => { setBroadcastText(e.target.value); setBroadcastShowHistory(false); }}
              onBlur={() => setTimeout(() => setBroadcastShowHistory(false), 150)}
              onKeyDown={e => {
                if (e.key === 'Escape') {
                  // Esc 는 히스토리 드롭다운만 닫고 바 자체는 유지 — 닫기는 ✕ 버튼으로만
                  if (broadcastShowHistory) { e.preventDefault(); setBroadcastShowHistory(false); }
                  return;
                }
                if (e.key === 'ArrowDown' && !broadcastShowHistory) {
                  if (broadcastHistory.length > 0) { e.preventDefault(); setBroadcastShowHistory(true); setBroadcastHistoryIdx(0); setBroadcastText(broadcastHistory[0]); }
                  return;
                }
                if (e.key === 'ArrowDown' && broadcastShowHistory) {
                  e.preventDefault();
                  const next = Math.min(broadcastHistoryIdx + 1, broadcastHistory.length - 1);
                  setBroadcastHistoryIdx(next); setBroadcastText(broadcastHistory[next]);
                  return;
                }
                if (e.key === 'ArrowUp' && broadcastShowHistory) {
                  e.preventDefault();
                  const prev = Math.max(broadcastHistoryIdx - 1, 0);
                  setBroadcastHistoryIdx(prev); setBroadcastText(broadcastHistory[prev]);
                  return;
                }
                if (e.key === 'Enter') { e.preventDefault(); setBroadcastShowHistory(false); sendBroadcast(broadcastScope, undefined, { keepFocusOnInput: true }); return; }
                if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
                  if (e.key === 'c' || e.key === 'C') {
                    const inp = e.currentTarget as HTMLInputElement;
                    if (inp.selectionStart !== inp.selectionEnd) return;
                    e.preventDefault();
                    sendBroadcast(broadcastScope, { raw: '\x03', label: '^C' }, { keepFocusOnInput: true });
                  } else if (e.key === 'd' || e.key === 'D') {
                    e.preventDefault();
                    sendBroadcast(broadcastScope, { raw: '\x04', label: '^D' }, { keepFocusOnInput: true });
                  }
                }
              }}
              placeholder={tb('inputPlaceholder')}
              style={{ flex: 1, borderRadius: '4px 0 0 4px' }}
            />
            <button
              className="broadcast-history-toggle"
              onMouseDown={e => e.preventDefault()}
              onClick={() => { setBroadcastShowHistory(v => !v); setBroadcastHistoryIdx(-1); }}
              title={tb('historyToggle')}
            >▾</button>
            {broadcastShowHistory && broadcastHistory.length > 0 && (
              <div className="broadcast-history-dropdown">
                {broadcastHistory.map((h, i) => (
                  <div key={`${h}-${i}`}
                    className={`broadcast-history-item ${i === broadcastHistoryIdx ? 'active' : ''}`}
                    onMouseDown={e => { e.preventDefault(); setBroadcastText(h); setBroadcastShowHistory(false); }}
                  >{h}</div>
                ))}
              </div>
            )}
          </div>
          <label className="broadcast-chk" title={tb('appendNewline')}>
            <input type="checkbox" checked={broadcastAppendNewline} onChange={e => setBroadcastAppendNewline(e.target.checked)} />
            <span>↵</span>
          </label>
          <button className="broadcast-btn" onClick={() => sendBroadcast(broadcastScope)} title={tb('sendTitle')}>{tb('send')}</button>
          <button className="broadcast-btn" onClick={() => { setBcastXferFiles([]); setBcastXferPath(''); setBcastXferLog([]); setShowBcastFileXfer(true); }} title={tb('fileXferTitle')}>{tb('fileXfer')}</button>
          <button className="broadcast-btn ctrl" onClick={() => sendBroadcast(broadcastScope, { raw: '\x1b[A', label: '↑' })} title={tb('arrowUp')}>↑</button>
          <button className="broadcast-btn ctrl" onClick={() => sendBroadcast(broadcastScope, { raw: '\x1b[B', label: '↓' })} title={tb('arrowDown')}>↓</button>
          <button className="broadcast-btn ctrl" onClick={() => sendBroadcast(broadcastScope, { raw: '\x03', label: '^C' })} title={tb('ctrlC')}>^C</button>
          <button className="broadcast-btn ctrl" onClick={() => sendBroadcast(broadcastScope, { raw: '\x04', label: '^D' })} title={tb('ctrlD')}>^D</button>
          {broadcastNotice && (
            <span className={`broadcast-notice ${broadcastNotice.kind}`}>{broadcastNotice.text}</span>
          )}
        </div>
      )}

      <StatusBar activeTab={activeTab} selectedPanelId={selectedPanelId} tabs={tabs} onClickVpn={addVpnTab} />

      {editSessionCtx && (
        <SessionEditor
          session={editSessionCtx.session}
          folders={editSessionFolders}
          onSave={async (s: any) => {
            try { await (window as any).api?.saveSession?.(s); } catch {}
            // 활성 터미널에 실시간 반영
            applySessionToTerm(s, editSessionCtx.termId);
            // 편집 컨텍스트 갱신 (창 유지)
            setEditSessionCtx({ session: s, termId: editSessionCtx.termId });
          }}
          onSaveAndConnect={async (s: any) => {
            try { await (window as any).api?.saveSession?.(s); } catch {}
            setEditSessionCtx(null);
            // 새 탭으로 연결 (panelId=null → 새 패널/탭 생성)
            setTimeout(() => {
              try { handleConnectSession(s.id, s.name, null, s.theme, s.fontFamily, s.fontSize, s.scrollback); } catch (e) { console.error('[editor saveAndConnect]', e); }
            }, 50);
          }}
          onCancel={() => setEditSessionCtx(null)}
        />
      )}
      {showOptions && (() => {
        const onDragStart = (e: React.MouseEvent) => {
          if ((e.target as HTMLElement).closest('button, input, select, textarea, label, .options-tab')) return;
          e.preventDefault();
          const modal = e.currentTarget.parentElement as HTMLElement;
          const rect = modal.getBoundingClientRect();
          const offX = e.clientX - rect.left;
          const offY = e.clientY - rect.top;
          modal.style.position = 'fixed';
          modal.style.left = rect.left + 'px';
          modal.style.top = rect.top + 'px';
          modal.style.transform = 'none';
          modal.style.margin = '0';
          const onMove = (ev: MouseEvent) => {
            modal.style.left = Math.max(0, Math.min(window.innerWidth - rect.width, ev.clientX - offX)) + 'px';
            modal.style.top = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - offY)) + 'px';
          };
          const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        };
        return (
        <div className="session-editor-backdrop" onClick={() => {
          if (isOptionsPopout) return; // popout 모드에선 backdrop 클릭으로 닫지 않음 (창은 OS 가 관리)
          setShowOptions(false);
        }}>
          <div className="session-editor" onClick={e => e.stopPropagation()} style={{ width: 640 }}>
            <h3 style={isOptionsPopout ? { userSelect: 'none' } : { cursor: 'move', userSelect: 'none' }} onMouseDown={isOptionsPopout ? undefined : onDragStart} title={isOptionsPopout ? '' : to('dragToMove')}>{to('title')}</h3>

            <div className="options-body">
              <div className="options-tabs options-tabs-side">
                <button className={`options-tab ${optionsTab === 'terminal' ? 'active' : ''}`} onClick={() => setOptionsTab('terminal')}>{to('tabs.terminal')}</button>
                <button className={`options-tab ${optionsTab === 'ai' ? 'active' : ''}`} onClick={() => setOptionsTab('ai')}>AI</button>
                <button className={`options-tab ${optionsTab === 'session' ? 'active' : ''}`} onClick={() => setOptionsTab('session')}>{to('tabs.session')}</button>
                <button className={`options-tab ${optionsTab === 'keybindings' ? 'active' : ''}`} onClick={() => setOptionsTab('keybindings')}>{to('tabs.keybindings')}</button>
              </div>
              <div className="options-pane">

            {optionsTab === 'terminal' && (
              <div className="options-content">
                <div style={{ marginBottom: 16 }}>
                  <div style={{ color: '#ccc', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{to('clipboard.heading')}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <label className="settings-checkbox">
                      <input type="checkbox" checked={termSettings.autoCopyOnSelect}
                        onChange={e => setTermSettings(s => ({ ...s, autoCopyOnSelect: e.target.checked }))} />
                      <span>{to('clipboard.autoCopyOnSelect')}</span>
                    </label>
                    <label className="settings-checkbox">
                      <input type="checkbox" checked={termSettings.includeTrailingNewline}
                        onChange={e => setTermSettings(s => ({ ...s, includeTrailingNewline: e.target.checked }))} />
                      <span>{to('clipboard.includeTrailingNewline')}</span>
                    </label>
                    <label className="settings-checkbox">
                      <input type="checkbox" checked={termSettings.trimTrailingWhitespace}
                        onChange={e => setTermSettings(s => ({ ...s, trimTrailingWhitespace: e.target.checked }))} />
                      <span>{to('clipboard.trimTrailingWhitespace')}</span>
                    </label>
                  </div>
                </div>
                <div style={{ marginBottom: 16 }}>
                  <div style={{ color: '#ccc', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{to('paste.heading')}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ color: '#aaa', fontSize: 12, marginBottom: 2 }}>{to('paste.multiLineNote')}</div>
                    <label className="settings-radio">
                      <input type="radio" name="multiLinePaste" checked={termSettings.multiLinePaste === 'dialog'}
                        onChange={() => setTermSettings(s => ({ ...s, multiLinePaste: 'dialog' }))} />
                      <span>{to('paste.dialog')}</span>
                    </label>
                    <label className="settings-radio">
                      <input type="radio" name="multiLinePaste" checked={termSettings.multiLinePaste === 'direct'}
                        onChange={() => setTermSettings(s => ({ ...s, multiLinePaste: 'direct' }))} />
                      <span>{to('paste.direct')}</span>
                    </label>
                  </div>
                </div>
                <div style={{ marginBottom: 16 }}>
                  <div style={{ color: '#ccc', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{to('font.heading')}</div>
                  <select
                    style={{ width: '100%', background: '#1a1a1a', color: '#eee', border: '1px solid #333', borderRadius: 4, padding: '8px', fontSize: 14, boxSizing: 'border-box', cursor: 'pointer' }}
                    value={optFontFamily}
                    onChange={e => setOptFontFamily(e.target.value)}
                  >
                    <option value="">{to('font.defaultLabel')}</option>
                    {availableFonts.map(f => <option key={f} value={f} style={{ fontFamily: `"${f}", monospace` }}>{f}</option>)}
                  </select>
                </div>
                <div style={{ marginBottom: 16 }}>
                  <div style={{ color: '#ccc', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{to('font.size')}</div>
                  <input
                    type="number"
                    min={8}
                    max={40}
                    step={1}
                    style={{ width: 100, background: '#1a1a1a', color: '#eee', border: '1px solid #333', borderRadius: 4, padding: '8px', fontSize: 14, fontFamily: 'monospace', boxSizing: 'border-box' }}
                    value={optFontSize}
                    onChange={e => setOptFontSize(Math.max(8, Math.min(40, Number(e.target.value) || 14)))}
                  />
                </div>
                <div style={{ marginBottom: 16 }}>
                  <div style={{ color: '#ccc', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{to('scrollback.heading')}</div>
                  <p style={{ color: '#888', fontSize: 12, margin: '0 0 6px' }}>{to('scrollback.hint')}</p>
                  <input
                    type="number"
                    min={1000}
                    max={1000000}
                    step={1000}
                    style={{ width: 160, background: '#1a1a1a', color: '#eee', border: '1px solid #333', borderRadius: 4, padding: '8px', fontSize: 14, fontFamily: 'monospace', boxSizing: 'border-box' }}
                    value={termSettings.scrollback}
                    onChange={e => {
                      const v = Math.max(1000, Math.min(1000000, Number(e.target.value) || 0));
                      setTermSettings(s => ({ ...s, scrollback: v }));
                    }}
                  />
                </div>
                <div style={{ marginBottom: 16 }}>
                  <div style={{ color: '#ccc', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{to('defaultShell.heading')}</div>
                  <select
                    style={{ width: '100%', background: '#1a1a1a', color: '#eee', border: '1px solid #333', borderRadius: 4, padding: '8px', fontSize: 14, boxSizing: 'border-box', cursor: 'pointer' }}
                    value={optDefaultShellPath}
                    onChange={e => setOptDefaultShellPath(e.target.value)}
                  >
                    {availableShells.map(sh => <option key={sh.path} value={sh.path}>{sh.icon ? sh.icon + ' ' : ''}{sh.name}</option>)}
                  </select>
                </div>
                <div style={{ marginBottom: 16 }}>
                  <div style={{ color: '#ccc', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{to('wordSeparator.heading')}</div>
                  <p style={{ color: '#888', fontSize: 12, margin: '0 0 6px' }}>{to('wordSeparator.hint')}</p>
                  <input
                    style={{ width: '100%', background: '#1a1a1a', color: '#eee', border: '1px solid #333', borderRadius: 4, padding: '8px', fontSize: 14, fontFamily: 'monospace', boxSizing: 'border-box' }}
                    value={wordSepValue}
                    onChange={e => setWordSepValue(e.target.value)}
                  />
                </div>
              </div>
            )}

            {optionsTab === 'ai' && (
              <div className="options-content">
                <div style={{ marginBottom: 16 }}>
                  <div style={{ color: '#ccc', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{to('aiAgent.heading')}</div>
                  <div style={{ display: 'flex', gap: '16px' }}>
                    <label className="settings-radio">
                      <input type="radio" name="aiAgent" checked={termSettings.aiAgent === 'claude'}
                        onChange={() => setTermSettings(s => ({ ...s, aiAgent: 'claude' }))} />
                      🤖 {to('aiAgent.claude')}
                    </label>
                    <label className="settings-radio">
                      <input type="radio" name="aiAgent" checked={termSettings.aiAgent === 'gemini'}
                        onChange={() => setTermSettings(s => ({ ...s, aiAgent: 'gemini' }))} />
                      ✨ {to('aiAgent.gemini')}
                    </label>
                    <label className="settings-radio">
                      <input type="radio" name="aiAgent" checked={termSettings.aiAgent === 'codex'}
                        onChange={() => setTermSettings(s => ({ ...s, aiAgent: 'codex' }))} />
                      🧠 {to('aiAgent.codex')}
                    </label>
                  </div>
                </div>
                <div style={{ marginBottom: 16, borderTop: '1px solid #333', paddingTop: 12 }}>
                  <div style={{ color: '#ccc', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{to('font.claudeHeading')}</div>
                  <p style={{ color: '#888', fontSize: 12, margin: '0 0 6px' }}>{to('font.claudeHint')}</p>
                  <select
                    style={{ width: '100%', background: '#1a1a1a', color: '#eee', border: '1px solid #333', borderRadius: 4, padding: '8px', fontSize: 14, boxSizing: 'border-box', cursor: 'pointer' }}
                    value={claudeFontFamily}
                    onChange={e => { setClaudeFontFamily(e.target.value); setClaudeFontFamilyState(e.target.value); }}
                  >
                    <option value="">{to('font.claudeDefaultLabel')}</option>
                    {availableFonts.map(f => <option key={f} value={f} style={{ fontFamily: `"${f}", sans-serif` }}>{f}</option>)}
                  </select>
                </div>
                <div style={{ marginBottom: 16 }}>
                  <div style={{ color: '#ccc', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{to('font.claudeSize')}</div>
                  <input
                    type="number"
                    min={9}
                    max={32}
                    step={1}
                    style={{ width: 100, background: '#1a1a1a', color: '#eee', border: '1px solid #333', borderRadius: 4, padding: '8px', fontSize: 14, fontFamily: 'monospace', boxSizing: 'border-box' }}
                    value={claudeFontSize}
                    onChange={e => {
                      const v = Math.max(9, Math.min(32, Number(e.target.value) || 13));
                      setClaudeFontSize(v);
                      setClaudeFontSizeState(v);
                    }}
                  />
                </div>
              </div>
            )}

            {optionsTab === 'session' && (
              <div className="options-content">
                <div style={{ marginBottom: 16 }}>
                  <div style={{ color: '#ccc', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{to('sessionsPath.heading')}</div>
                  <div style={{ background: '#111', border: '1px solid #333', borderRadius: 4, padding: '8px 10px', fontSize: 12, fontFamily: 'monospace', color: '#aaa', wordBreak: 'break-all', marginBottom: 8 }}>
                    {sessionsPathDisplay || to('sessionsPath.unknown')}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button className="btn-add" onClick={() => (window as any).api.openSessionsFolder()}>{to('sessionsPath.open')}</button>
                    <button className="btn-add" onClick={async () => {
                      const r = await (window as any).api.setSessionsPath();
                      if (r) { setSessionsPathDisplay(r.path); window.dispatchEvent(new Event('sessions-reload')); }
                    }}>{to('sessionsPath.change')}</button>
                    <button className="btn-add" onClick={async () => {
                      const r = await (window as any).api.resetSessionsPath();
                      if (r) { setSessionsPathDisplay(r.path); window.dispatchEvent(new Event('sessions-reload')); }
                    }}>{to('sessionsPath.reset')}</button>
                    <button className="btn-add" onClick={() => (window as any).api.openSessionsEditor()}>{to('sessionsPath.editFile')}</button>
                  </div>
                </div>
                <div style={{ marginBottom: 16 }}>
                  <div style={{ color: '#ccc', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{to('contextMenu.heading')}</div>
                  <p style={{ color: '#888', fontSize: 12, margin: '0 0 6px' }}>{to('contextMenu.hint')}</p>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn-add" onClick={async () => {
                      const r = await (window as any).api?.registerContextMenu?.();
                      if (r?.success) { setContextMenuRegistered(true); }
                    }}>{to('contextMenu.register')}</button>
                    <button className="btn-add" onClick={async () => {
                      const r = await (window as any).api?.unregisterContextMenu?.();
                      if (r?.success) { setContextMenuRegistered(false); }
                    }}>{to('contextMenu.unregister')}</button>
                    <span style={{ color: contextMenuRegistered ? '#4caf50' : '#888', fontSize: 12, alignSelf: 'center' }}>
                      {contextMenuRegistered ? to('contextMenu.registered') : to('contextMenu.notRegistered')}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {optionsTab === 'keybindings' && (
              <div className="options-content">
                <div className="keybinding-list">
                  {Object.keys(DEFAULT_KEYBINDINGS).map(actionId => {
                    const draftCombo = keybindingsDraft[actionId] || DEFAULT_KEYBINDINGS[actionId];
                    const isListening = listeningAction === actionId;
                    return (
                      <div className="keybinding-row" key={actionId}>
                        <span className="keybinding-label">{tk(`labels.${actionId}`, { defaultValue: KEYBINDING_LABELS[actionId] || actionId })}</span>
                        <input
                          className={`keybinding-combo ${isListening ? 'listening' : ''}`}
                          readOnly
                          value={isListening ? to('keybindings.pressKey') : formatKeyComboForOS(draftCombo)}
                        />
                        <button className="keybinding-btn" onClick={() => setListeningAction(isListening ? null : actionId)}>
                          {isListening ? to('keybindings.cancel') : to('keybindings.change')}
                        </button>
                      </div>
                    );
                  })}
                </div>
                {keybindingWarning && (
                  <div className="keybinding-warning">⚠ {keybindingWarning}</div>
                )}
                <div className="keybinding-reset">
                  <button className="keybinding-btn" onClick={() => {
                    setKeybindingsDraft({});
                    setListeningAction(null);
                    setKeybindingWarning(null);
                  }}>{to('keybindings.reset')}</button>
                </div>
              </div>
            )}
              </div>
            </div>

            <div className="session-editor-actions">
              <button className="btn-cancel" onClick={() => {
                if (isOptionsPopout) { try { (window as any).api?.optionsClose?.(); } catch {} return; }
                setShowOptions(false); setListeningAction(null);
              }}>{to('actions.cancel')}</button>
              <button className="btn-save" onClick={() => {
                saveTerminalSettings(termSettings);
                setWordSeparator(wordSepValue);
                applyScrollbackToAll(termSettings.scrollback);
                applyFontToAll(optFontFamily || undefined, optFontSize);
                // 기본 쉘 저장
                const selShell = availableShells.find(s => s.path === optDefaultShellPath);
                if (selShell) {
                  setDefaultShell({ name: selShell.name, path: selShell.path });
                  (window as any).api?.setUIPrefs?.({ defaultShellName: selShell.name, defaultShellPath: selShell.path });
                }
                // 단축키 저장 — draft를 실제로 반영
                setKeybindingsState(keybindingsDraft);
                loadKeybindings(keybindingsDraft);
                (window as any).api?.setUIPrefs?.({ keybindings: keybindingsDraft });
                setListeningAction(null);
                setShowOptions(false);
                if (isOptionsPopout) {
                  // localStorage 의 디스크 flush 시간 확보 후 창 닫기 (즉시 닫으면 변경사항 유실 가능)
                  setTimeout(() => { try { (window as any).api?.optionsSaved?.(); } catch {} }, 250);
                }
              }}>{to('actions.save')}</button>
            </div>
          </div>
        </div>
        );
      })()}

      {sftpProgress && (
        <div className="sftp-progress-bar">
          <span className="sftp-progress-text">
            {sftpProgress.direction === 'download' ? '⬇' : '⬆'} {sftpProgress.filename}
          </span>
          <div className="sftp-progress-track">
            <div className="sftp-progress-fill" style={{ width: `${sftpProgress.total > 0 ? (sftpProgress.transferred / sftpProgress.total * 100) : 0}%` }} />
          </div>
          <span className="sftp-progress-pct">
            {sftpProgress.total > 0 ? Math.round(sftpProgress.transferred / sftpProgress.total * 100) : 0}%
          </span>
        </div>
      )}
      {showClaudeChat && (() => {
        // 모든 연결된 SSH 세션 수집 (panel.sessions 내의 termId 들)
        const connectedSessions: { termId: string; label: string }[] = [];
        const seen = new Set<string>();
        const walk = (n: any) => {
          if (n.type === 'leaf') {
            const sessions = n.panel?.sessions || [];
            for (const s of sessions) {
              if (s.termId && !seen.has(s.termId) && isTermConnected(s.termId)) {
                const info = getTermSessionInfo(s.termId);
                const label = info?.sessionName || s.sessionName || info?.host || s.termId;
                connectedSessions.push({ termId: s.termId, label });
                seen.add(s.termId);
              }
            }
          } else if (n.children) {
            for (const c of n.children) walk(c);
          }
        };
        for (const t of tabs) walk(t.layout);

        // 현재 선택된 패널의 activeTermId 가 연결된 SSH 세션이면 기본 우선
        let defaultSsh: { termId: string; label: string } | null = connectedSessions[0] || null;
        if (selectedPanelId && activeTab) {
          const findLeaf = (n: any, id: string): any => {
            if (n.type === 'leaf') return n.id === id ? n : null;
            for (const c of n.children) { const r = findLeaf(c, id); if (r) return r; }
            return null;
          };
          const leaf = findLeaf(activeTab.layout, selectedPanelId);
          if (leaf && leaf.panel) {
            const activeTerm = leaf.panel.activeTermId || leaf.panel.sessions?.[0]?.termId;
            if (activeTerm && isTermConnected(activeTerm)) {
              const info = getTermSessionInfo(activeTerm);
              const s = leaf.panel.sessions.find((x: any) => x.termId === activeTerm);
              defaultSsh = { termId: activeTerm, label: info?.sessionName || s?.sessionName || info?.host || activeTerm };
            }
          }
        }

        const onClickTrigger = () => {
          if (claudeChatPinned) return;
          if (claudeChatHideTimer.current) { clearTimeout(claudeChatHideTimer.current); claudeChatHideTimer.current = null; }
          if (claudeChatHoverShowTimer.current) { clearTimeout(claudeChatHoverShowTimer.current); claudeChatHoverShowTimer.current = null; }
          setClaudeChatVisible(v => !v);
        };
        const onEnterTriggerHover = () => {
          if (claudeChatPinned) return;
          if (claudeChatHideTimer.current) { clearTimeout(claudeChatHideTimer.current); claudeChatHideTimer.current = null; }
          if (claudeChatHoverShowTimer.current) clearTimeout(claudeChatHoverShowTimer.current);
          claudeChatHoverShowTimer.current = setTimeout(() => setClaudeChatVisible(true), 2500);
        };
        const onLeaveTriggerHover = () => {
          if (claudeChatHoverShowTimer.current) { clearTimeout(claudeChatHoverShowTimer.current); claudeChatHoverShowTimer.current = null; }
        };
        const onEnterSidebar = () => {
          if (claudeChatPinned) return;
          if (claudeChatHideTimer.current) { clearTimeout(claudeChatHideTimer.current); claudeChatHideTimer.current = null; }
        };
        const onLeaveSidebar = () => {
          if (claudeChatPinned) return;
          if (claudeChatHideTimer.current) clearTimeout(claudeChatHideTimer.current);
          claudeChatHideTimer.current = setTimeout(() => setClaudeChatVisible(false), 500);
        };
        const onLeaveTrigger = () => {
          if (claudeChatPinned) return;
          if (claudeChatHideTimer.current) clearTimeout(claudeChatHideTimer.current);
          claudeChatHideTimer.current = setTimeout(() => setClaudeChatVisible(false), 500);
        };
        void onLeaveTrigger;
        return (
          <>
            {!claudeChatPinned && (
              <div className="claude-chat-sidebar-trigger">
                <div className="claude-chat-sidebar-trigger-top" onClick={onClickTrigger} onMouseEnter={onEnterTriggerHover} onMouseLeave={onLeaveTriggerHover} style={{ cursor: 'pointer' }} title="클릭=토글 / 2.5초 오버=자동 열림">
                  <span className="claude-chat-sidebar-trigger-text">🤖 Claude</span>
                </div>
                <div className="claude-chat-sidebar-trigger-bottom" />
              </div>
            )}
            <div
              className={`claude-chat-sidebar ${!claudeChatPinned ? 'auto-hide' : ''} ${!claudeChatPinned && !claudeChatVisible ? 'hidden' : ''}`}
              style={{ width: `${claudeChatWidth}px`, right: claudeChatPinned ? '0px' : '20px' }}
              onMouseEnter={onEnterSidebar}
              onMouseLeave={onLeaveSidebar}
            >
            <div
              className="claude-chat-sidebar-resizer"
              title="드래그하여 너비 조절 (더블클릭: 기본값)"
              onMouseDown={e => {
                e.preventDefault();
                const startX = e.clientX;
                const startWidth = claudeChatWidth;
                const onMove = (ev: MouseEvent) => {
                  const dx = startX - ev.clientX;
                  const w = Math.max(280, Math.min(1200, startWidth + dx));
                  setClaudeChatWidth(w);
                };
                const onUp = () => {
                  window.removeEventListener('mousemove', onMove);
                  window.removeEventListener('mouseup', onUp);
                  // 드래그 종료 시 prefs 저장
                  setClaudeChatWidth(curW => {
                    try { (window as any).api?.setUIPrefs?.({ claudeChatWidth: curW }); } catch {}
                    return curW;
                  });
                  window.dispatchEvent(new Event('resize'));
                };
                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', onUp);
              }}
              onDoubleClick={() => {
                setClaudeChatWidth(360);
                try { (window as any).api?.setUIPrefs?.({ claudeChatWidth: 360 }); } catch {}
              }}
            />
            <ClaudeChat
              aiAgent={termSettings.aiAgent}
              onClose={() => setShowClaudeChat(false)}
              pendingContext={claudeFileContext}
              onContextConsumed={() => setClaudeFileContext(null)}
              mountEntries={claudeMountEntries}
              onClearMounted={() => setClaudeMountEntries([])}
              onRemoveMountedEntry={(rp, termId) => setClaudeMountEntries(prev => prev.filter(e => !(e.remotePath === rp && e.termId === termId)))}
              connectedSessions={connectedSessions}
              defaultSshSession={defaultSsh}
              pinned={claudeChatPinned}
              onTogglePin={() => setClaudeChatPinned(p => !p)}
            />
            </div>
          </>
        );
      })()}
      {claudeAttaching && (
        <div className="claude-attach-toast">
          <div className="claude-attach-toast-msg">🤖 {claudeAttaching.message}</div>
          {claudeAttaching.total > 0 && (
            <div className="claude-attach-toast-bar">
              <div className="claude-attach-toast-bar-fill" style={{ width: `${Math.min(100, (claudeAttaching.progress / claudeAttaching.total) * 100)}%` }} />
            </div>
          )}
        </div>
      )}
      {splitSessionPicker && (() => {
        const { folders, sessions } = splitSessionPicker;
        const toggleFolder = (fid: string) => {
          setSplitPickerCollapsed(prev => {
            const next = new Set(prev);
            if (next.has(fid)) next.delete(fid); else next.add(fid);
            return next;
          });
        };
        const renderTree = (parentId: string | undefined, depth: number): React.ReactNode[] => {
          const rows: React.ReactNode[] = [];
          const subFolders = folders.filter(f => (f.parentId ?? undefined) === (parentId ?? undefined));
          for (const f of subFolders) {
            const isCollapsed = splitPickerCollapsed.has(f.id);
            rows.push(
              <div
                key={`f-${f.id}`}
                data-fid={f.id}
                className="folder-picker-item folder-row"
                style={{ paddingLeft: 8 + depth * 16, cursor: 'pointer' }}
                onClick={() => toggleFolder(f.id)}
              >
                <span style={{ width: 14, display: 'inline-block', fontSize: 10, color: '#888' }}>{isCollapsed ? '▶' : '▼'}</span>
                📁 {f.name}
              </div>
            );
            if (!isCollapsed) rows.push(...renderTree(f.id, depth + 1));
          }
          const sessionsInFolder = sessions.filter(s => (s.folderId ?? undefined) === (parentId ?? undefined));
          for (const s of sessionsInFolder) {
            rows.push(
              <div
                key={`s-${s.sessionId}`}
                data-sid={s.sessionId}
                className="folder-picker-item picker-session-row"
                style={{ paddingLeft: 8 + depth * 16, position: 'relative' }}
                onClick={() => handleSplitSessionSelect(s)}
                title={s.host}
              >
                <span style={{ width: 14, display: 'inline-block' }} />
                {s.icon || '📡'} {s.sessionName}
                <span className="picker-session-host-tooltip">{s.host}</span>
              </div>
            );
          }
          return rows;
        };
        return (
          <div className="folder-picker-backdrop" onClick={() => setSplitSessionPicker(null)}>
            <div
              className="folder-picker"
              onClick={e => e.stopPropagation()}
            >
              <div className="folder-picker-title">세션 선택 ({splitSessionPicker.dir === 'row' ? '가로 분할 (좌/우)' : '세로 분할 (상/하)'})</div>
              <div className="folder-picker-list">
                {renderTree(undefined, 0)}
              </div>
              <div className="folder-picker-actions">
                <button onClick={() => setSplitSessionPicker(null)}>취소</button>
              </div>
            </div>
          </div>
        );
      })()}

      {showKeybindingList && (() => {
        const closeAndFocus = () => {
          setShowKeybindingList(false);
          restoreTerminalFocus();
        };
        const kb = getKeybindings();
        type Row = { key: string; label: string };
        const fmt = (k: string) => {
          // 콤보 표기에는 formatKeyComboForOS 적용, "Ctrl+마우스 휠" 처럼 단어가 섞이면
          // formatKeyTextForOS 가 콤보 부분만 변환하도록 fallback
          if (/^[\w+\-↑↓←→/]+$/.test(k)) return formatKeyComboForOS(k);
          return formatKeyTextForOS(k);
        };
        const groups: { name: string; rows: Row[] }[] = [
          {
            name: tk('groups.custom'),
            rows: Object.keys(KEYBINDING_LABELS).map(id => ({ key: kb[id] ? fmt(kb[id]) : tk('none'), label: tk(`labels.${id}`, { defaultValue: KEYBINDING_LABELS[id] }) })),
          },
          {
            name: tk('groups.fixed'),
            rows: [
              { key: fmt('Alt+1~9'), label: tk('fixed.minitabSwitch') },
              { key: fmt('Alt+Enter'), label: tk('fixed.fullscreen') },
              { key: fmt('Ctrl+L'), label: tk('fixed.scrollBottom') },
              { key: fmt('Ctrl') + tk('fixed.wheelSuffix'), label: tk('fixed.fontSize') },
              { key: 'F2', label: tk('fixed.rename') },
              { key: tk('fixed.middleClick'), label: tk('fixed.closeTab') },
              { key: fmt('Ctrl') + '+↑/↓', label: tk('fixed.moveOrder') },
            ],
          },
          {
            name: tk('groups.minitab'),
            rows: [
              { key: tk('minitab.shellBtn'), label: tk('minitab.shellSelector') },
              { key: tk('minitab.rightClickKey'), label: tk('minitab.rightClick') },
              { key: tk('minitab.wheelKey'), label: tk('minitab.wheel') },
            ],
          },
          {
            name: tk('groups.terminal'),
            rows: [
              { key: tk('terminal.rightClickKey'), label: tk('terminal.rightClick') },
              { key: tk('terminal.dblClickKey'), label: tk('terminal.dblClickSession') },
            ],
          },
          {
            name: tk('groups.fileTree'),
            rows: [
              { key: tk('fileTree.dblClickKey'), label: tk('fileTree.dblClickFile') },
              { key: fmt('Ctrl') + '+클릭 / ' + fmt('Shift') + '+클릭', label: tk('fileTree.multiSelect') },
              { key: tk('fileTree.rightClickKey'), label: tk('fileTree.rightClick') },
              { key: '🔄', label: tk('fileTree.refresh') },
              { key: '📌', label: tk('fileTree.pin') },
              { key: tk('fileTree.resizeKey'), label: tk('fileTree.resize') },
              { key: fmt('Ctrl+S') + tk('fileTree.saveKeySuffix'), label: tk('fileTree.save') },
            ],
          },
          {
            name: tk('groups.claude'),
            rows: [
              { key: tk('claude.triggerHoverKey'), label: tk('claude.triggerHover') },
              { key: '📌', label: tk('claude.pin') },
              { key: tk('claude.resizeKey'), label: tk('claude.resize') },
              { key: tk('claude.slashKey'), label: tk('claude.slashPalette') },
              { key: tk('claude.attachKey'), label: tk('claude.attach') },
              { key: fmt('Ctrl') + tk('claude.fontKey'), label: tk('claude.fontSize') },
              { key: tk('claude.sendKey'), label: tk('claude.send', { newline: fmt('Shift+Enter') }) },
              { key: tk('claude.clearKey'), label: tk('claude.clear') },
            ],
          },
          {
            name: tk('groups.broadcast'),
            rows: [
              { key: 'Enter', label: tk('broadcast.send') },
              { key: fmt('Ctrl+C') + ' / ' + fmt('Ctrl+D'), label: tk('broadcast.signal') },
              { key: '↑/↓', label: tk('broadcast.history') },
              { key: 'Esc', label: tk('broadcast.escClose') },
            ],
          },
          {
            name: tk('groups.quickConnect'),
            rows: [
              { key: 'Enter', label: tk('quickConnect.connect') },
              { key: 'Esc', label: tk('quickConnect.esc') },
            ],
          },
        ];
        const q = keybindingListQuery.trim().toLowerCase();
        const isMatch = (r: Row) => !!q && (r.key.toLowerCase().includes(q) || r.label.toLowerCase().includes(q));
        const renderHL = (text: string) => {
          if (!q) return text;
          const lo = text.toLowerCase();
          const out: any[] = [];
          let i = 0;
          let key = 0;
          while (i < text.length) {
            const idx = lo.indexOf(q, i);
            if (idx < 0) { out.push(text.slice(i)); break; }
            if (idx > i) out.push(text.slice(i, idx));
            out.push(<mark key={key++} style={{ background: '#ffd666', color: '#000', padding: 0, borderRadius: 2 }}>{text.slice(idx, idx + q.length)}</mark>);
            i = idx + q.length;
          }
          return <>{out}</>;
        };
        return (
          <div className="session-editor-backdrop" onClick={closeAndFocus}>
            <div className="session-editor" onClick={e => e.stopPropagation()}
              style={{ minWidth: 480, width: 640, maxWidth: '90vw', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}
              onKeyDown={e => { if (e.key === 'Escape') closeAndFocus(); }}
              tabIndex={-1}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '2px 4px 8px', borderBottom: '1px solid #333' }}>
                <h3 style={{ margin: 0 }}>{tk('title')}</h3>
                <button onClick={closeAndFocus} title={tk('close')}>✕</button>
              </div>
              <div style={{ padding: '8px 12px 4px' }}>
                <input
                  type="text"
                  autoFocus
                  placeholder={tk('searchPlaceholder')}
                  value={keybindingListQuery}
                  onChange={e => setKeybindingListQuery(e.target.value)}
                  style={{ width: '100%', padding: '6px 10px', background: '#1e1e1e', color: '#ddd', border: '1px solid #444', borderRadius: 4, fontSize: 13, outline: 'none', boxSizing: 'border-box' }}
                />
              </div>
              <div style={{ overflow: 'auto', padding: '4px 12px 12px', fontSize: 12, color: '#ddd' }}>
                {q && groups.every(g => g.rows.every(r => !isMatch(r))) && (
                  <div style={{ padding: '8px 0', textAlign: 'center', color: '#888' }}>{tk('noMatch')}</div>
                )}
                {groups.map(g => (
                  <div key={g.name} style={{ marginBottom: 12 }}>
                    <div style={{ color: '#7fb3ff', fontWeight: 600, padding: '4px 0 4px', borderBottom: '1px solid #2a2a2a', marginBottom: 4 }}>── {g.name} ──</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '200px 8px 1fr', rowGap: 2, columnGap: 6, alignItems: 'baseline' }}>
                      {g.rows.map((r, i) => {
                        const matched = isMatch(r);
                        const border = matched ? '1px solid #fff' : '1px solid transparent';
                        const cellStyle = (extra: any) => ({ padding: '1px 4px', borderTop: border, borderBottom: border, ...extra });
                        return (
                          <Fragment key={i}>
                            <div style={cellStyle({ fontFamily: 'Consolas, monospace', color: '#e6c07b', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', borderLeft: border, borderRight: '1px solid transparent', borderTopLeftRadius: matched ? 3 : 0, borderBottomLeftRadius: matched ? 3 : 0 })} title={r.key}>{renderHL(r.key)}</div>
                            <div style={cellStyle({ color: '#666', textAlign: 'center' })}>—</div>
                            <div style={cellStyle({ color: '#ddd', borderRight: border, borderLeft: '1px solid transparent', borderTopRightRadius: matched ? 3 : 0, borderBottomRightRadius: matched ? 3 : 0 })}>{renderHL(r.label)}</div>
                          </Fragment>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })()}

      {infoModal && (() => {
        const closeAndFocus = () => {
          setInfoModal(null);
          restoreTerminalFocus();
        };
        return (
          <div className="session-editor-backdrop" onClick={closeAndFocus}>
            <div className="session-editor" onClick={e => e.stopPropagation()}
              style={{ minWidth: 320, maxWidth: 700, maxHeight: '70vh', display: 'flex', flexDirection: 'column' }}
              onKeyDown={e => { if (e.key === 'Escape') closeAndFocus(); }}
              tabIndex={-1}
              ref={el => { if (el) setTimeout(() => el.focus(), 0); }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '2px 4px 8px', borderBottom: '1px solid #333' }}>
                <h3 style={{ margin: 0 }}>{infoModal.title}</h3>
                <button onClick={closeAndFocus} title="닫기 (Esc)">✕</button>
              </div>
              <pre style={{ overflow: 'auto', margin: 0, padding: '12px 16px', fontFamily: 'inherit', fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#ddd' }}>
                {infoModal.text}
              </pre>
            </div>
          </div>
        );
      })()}

      {showManual && (
        <div className="session-editor-backdrop" onClick={() => setShowManual(false)}>
          <div className="session-editor manual-modal" onClick={e => e.stopPropagation()}
            style={{ width: '80vw', maxWidth: 1000, height: '85vh', display: 'flex', flexDirection: 'column' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '2px 4px 8px', borderBottom: '1px solid #333' }}>
              <h3 style={{ margin: 0 }}>📖 PePe Terminal(SSH) 매뉴얼</h3>
              <button onClick={() => setShowManual(false)} title="닫기">✕</button>
            </div>
            <div className="manual-content" style={{ flex: 1, overflow: 'auto', padding: '12px 16px' }}
              onClick={e => {
                // 목차 앵커 링크 클릭 시 외부 브라우저로 가지 않고 컨테이너 내부 스크롤로 이동
                const a = (e.target as HTMLElement).closest('a') as HTMLAnchorElement | null;
                if (!a) return;
                const href = a.getAttribute('href') || '';
                if (!href.startsWith('#')) return;
                e.preventDefault();
                const id = decodeURIComponent(href.slice(1));
                const container = e.currentTarget as HTMLDivElement;
                // marked 가 생성한 id 와 정확히 일치 우선, 안 되면 텍스트로 fallback
                let target = container.querySelector(`#${CSS.escape(id)}`) as HTMLElement | null;
                if (!target) {
                  // h1~h6 의 텍스트가 id 와 일치하는 경우(슬러그 다를 때) fallback
                  const headers = Array.from(container.querySelectorAll('h1,h2,h3,h4,h5,h6')) as HTMLElement[];
                  target = headers.find(h => (h.textContent || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\w\-가-힣]/g, '') === id.toLowerCase()) || null;
                }
                if (target) {
                  // 단순 scrollIntoView({block:'center'}) 는 일부 환경에서 정확히 가운데로 가지 않으므로
                  // 컨테이너 기준 offset 직접 계산 → 헤더가 뷰포트 정중앙에 오도록 스크롤
                  const cRect = container.getBoundingClientRect();
                  const tRect = target.getBoundingClientRect();
                  const offset = (tRect.top - cRect.top) + container.scrollTop - (container.clientHeight / 2) + (tRect.height / 2);
                  container.scrollTo({ top: offset, behavior: 'smooth' });
                }
              }}
              dangerouslySetInnerHTML={{ __html: manualHtml }}
            />
          </div>
        </div>
      )}

      {remotePickerOpen && (
        <div className="session-editor-backdrop" style={{ zIndex: 10000 }} onClick={() => setRemotePickerOpen(false)}>
          <div className="session-editor" onClick={e => e.stopPropagation()} style={{ width: 580, maxHeight: '80vh', display: 'flex', flexDirection: 'column', zIndex: 10001 }}>
            <h3>{tfe('remotePickerTitle')}</h3>

            <label style={{ fontSize: 12, color: '#bbb' }}>{tfe('remotePickerSourceLabel')}</label>
            {(() => {
              // 연결된 sessionId 맵 — 모든 워크스페이스의 모든 세션 검사
              const connectedSet = new Set<string>();
              for (const t of tabs) {
                for (const s of collectAllSessions(t.layout)) {
                  if (s.sessionId && isTermConnected(s.termId)) connectedSet.add(s.sessionId);
                }
              }
              // 폴더 트리 (간단 평면화) — 각 세션을 "폴더경로/세션명" 으로 정렬
              const folderPath = (fid?: string): string => {
                if (!fid) return '';
                const f = remotePickerFolders.find(x => x.id === fid);
                if (!f) return '';
                const parent = folderPath(f.parentId);
                return parent ? `${parent}/${f.name}` : f.name;
              };
              // 연결된 세션이 위로 — 같은 그룹 내에서는 폴더 경로 + 이름으로 정렬
              const sortFn = (a: typeof remotePickerSessions[number], b: typeof remotePickerSessions[number]) => {
                const fa = folderPath(a.folderId);
                const fb = folderPath(b.folderId);
                return fa.localeCompare(fb) || a.name.localeCompare(b.name);
              };
              const connected = remotePickerSessions.filter(s => connectedSet.has(s.id)).sort(sortFn);
              const disconnected = remotePickerSessions.filter(s => !connectedSet.has(s.id)).sort(sortFn);
              const renderOption = (s: typeof remotePickerSessions[number]) => {
                const fp = folderPath(s.folderId);
                const mark = connectedSet.has(s.id) ? '🟢' : '⚪';
                return (
                  <option key={s.id} value={s.id}>
                    {mark} {s.name}{fp ? ` [${fp}]` : ''} ({s.host})
                  </option>
                );
              };
              return (
                <select value={remotePickerSessionId} onChange={e => {
                  setRemotePickerSessionId(e.target.value);
                  setRemotePickerFiles([]);
                  setRemotePickerSelected(new Set());
                }}>
                  <option value="">{tfe('remotePickerSelectSession')}</option>
                  {connected.length > 0 && (
                    <optgroup label={tfe('groupConnected')}>
                      {connected.map(renderOption)}
                    </optgroup>
                  )}
                  {disconnected.length > 0 && (
                    <optgroup label={tfe('groupNotConnected')}>
                      {disconnected.map(renderOption)}
                    </optgroup>
                  )}
                </select>
              );
            })()}
            {remotePickerConnecting && (
              <div style={{ fontSize: 11, color: '#f0c64c', marginTop: 4 }}>
                {tfe('remotePickerConnecting')}
              </div>
            )}

            <label style={{ fontSize: 12, color: '#bbb', marginTop: 10 }}>{tfe('remotePickerPathLabel')}</label>
            <div style={{ display: 'flex', gap: 4 }}>
              <input type="text" value={remotePickerPath} onChange={e => setRemotePickerPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    setRemotePickerSelected(new Set());
                    // path 변경은 useEffect 가 자동 재로드
                  }
                }}
                style={{ flex: 1 }}
                disabled={!remotePickerConnId} />
              <button onClick={() => {
                const parent = remotePickerPath.replace(/\/[^/]+\/?$/, '') || '/';
                setRemotePickerPath(parent);
                setRemotePickerSelected(new Set());
              }} title={tfe('remotePickerParent')} disabled={!remotePickerConnId}>▲</button>
              <button onClick={async () => {
                if (!remotePickerConnId) return;
                setRemotePickerLoading(true);
                try { const r: any = await (window as any).api?.feListDir?.('remote', remotePickerPath, remotePickerConnId); setRemotePickerFiles(r?.files || []); } catch { setRemotePickerFiles([]); }
                setRemotePickerLoading(false);
              }} title={tfe('remotePickerRefresh')} disabled={!remotePickerConnId}>⟳</button>
            </div>

            <div style={{ flex: 1, minHeight: 200, height: 320, border: '1px solid #333', borderRadius: 4, marginTop: 8, background: '#161616' }}>
              {!remotePickerConnId ? (
                <div style={{ color: '#666', fontSize: 12, padding: 16, textAlign: 'center' }}>{tfe('remotePickerPickHint')}</div>
              ) : remotePickerLoading || remotePickerConnecting ? (
                <div style={{ color: '#888', fontSize: 12, padding: 16, textAlign: 'center' }}>{tfe('remotePickerLoading')}</div>
              ) : remotePickerFiles.length === 0 ? (
                <div style={{ color: '#666', fontSize: 12, padding: 16, textAlign: 'center' }}>{tfe('remotePickerEmpty')}</div>
              ) : (() => {
                const sorted = remotePickerFiles
                  .filter(f => f.name !== '.' && f.name !== '..')
                  .sort((a, b) => (a.isDir !== b.isDir) ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name));
                return (
                  <VList height={320} width="100%" itemCount={sorted.length} itemSize={22} overscanCount={10}>
                    {({ index, style }: ListChildComponentProps) => {
                      const f = sorted[index];
                      if (!f) return null;
                      return (
                        <div key={f.name} style={{ ...style, display: 'flex', alignItems: 'center', gap: 6, padding: '0 6px', cursor: 'pointer', background: remotePickerSelected.has(f.name) ? '#2b4e74' : 'transparent', boxSizing: 'border-box' }}
                          onClick={() => {
                            setRemotePickerSelected(prev => {
                              const next = new Set(prev);
                              if (next.has(f.name)) next.delete(f.name); else next.add(f.name);
                              return next;
                            });
                          }}
                          onDoubleClick={() => {
                            if (!f.isDir) return;
                            const sep = remotePickerPath.endsWith('/') ? '' : '/';
                            setRemotePickerPath(remotePickerPath + sep + f.name);
                            setRemotePickerSelected(new Set());
                          }}
                        >
                          <input type="checkbox" readOnly checked={remotePickerSelected.has(f.name)} />
                          <span style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.isDir ? '📁' : '📄'} {f.name}</span>
                        </div>
                      );
                    }}
                  </VList>
                );
              })()}
            </div>
            <div style={{ fontSize: 11, color: '#777', marginTop: 4 }}>
              {tfe('remotePickerLegend', { count: remotePickerSelected.size })}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
              <button onClick={() => setRemotePickerOpen(false)}>{tfe('close')}</button>
              <button className="primary" disabled={remotePickerSelected.size === 0 || !remotePickerConnId}
                onClick={() => {
                  const sess = remotePickerSessions.find(s => s.id === remotePickerSessionId);
                  const sessLabel = sess?.name || remotePickerConnId.slice(-6);
                  const toAdd = [...remotePickerSelected].map(name => {
                    const sep = remotePickerPath.endsWith('/') ? '' : '/';
                    const fullPath = remotePickerPath + sep + name;
                    const isFolder = remotePickerFiles.find(f => f.name === name)?.isDir || false;
                    return { path: fullPath, isFolder, sourceTermId: remotePickerConnId, sourceLabel: sessLabel };
                  });
                  setBcastXferFiles(prev => [...prev, ...toAdd]);
                  // 닫진 않음 — 여러 세션에서 연속 선택 가능하도록 유지. 세션만 초기화.
                  setRemotePickerSelected(new Set());
                }}
              >{tfe('remotePickerAddSelected', { count: remotePickerSelected.size })}</button>
            </div>
          </div>
        </div>
      )}

      {showBcastFileXfer && (
        <div className="session-editor-backdrop" onClick={() => !bcastXferInProgress && setShowBcastFileXfer(false)}>
          <div className="session-editor" onClick={e => e.stopPropagation()} style={{ width: 620, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
            <h3>{tb('xferTitle')}</h3>

            <label style={{ fontSize: 12, color: '#bbb', marginTop: 8 }}>{tb('xferTargets')}</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <select value={broadcastScope} onChange={e => setBroadcastScope(e.target.value as any)} style={{ flex: 1 }}>
                <option value="visible">{tb('xferScopeVisibleAll')}</option>
                <option value="current">{tb('xferScopeCurrent')}</option>
                <option value="connected">{tb('xferScopeConnectedAll')}</option>
              </select>
              <span style={{ color: '#8ab', fontSize: 12 }}>{tb('xferTargetsCount', { count: collectBroadcastTargets(broadcastScope).length })}</span>
            </div>

            <label style={{ fontSize: 12, color: '#bbb', marginTop: 12 }}>{tb('xferRemotePath')}</label>
            <input type="text" value={bcastXferPath} onChange={e => setBcastXferPath(e.target.value)}
              placeholder={tb('xferRemotePathPlaceholder')} />

            <label style={{ fontSize: 12, color: '#bbb', marginTop: 12 }}>{tb('xferFiles')}</label>
            <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
              <button onClick={async () => {
                const r: any = await (window as any).api?.pickFiles?.(true);
                if (r?.paths?.length) {
                  setBcastXferFiles(prev => [...prev, ...r.paths.map((p: string) => ({ path: p, isFolder: false }))]);
                }
              }}>{tb('xferAddLocalFile')}</button>
              <button onClick={async () => {
                const r: any = await (window as any).api?.pickFolder?.();
                if (r?.path) setBcastXferFiles(prev => [...prev, { path: r.path, isFolder: true }]);
              }}>{tb('xferAddLocalFolder')}</button>
              <button onClick={() => {
                // 전체 세션 리스트에서 선택 — 미연결이면 백그라운드 연결
                setRemotePickerSessionId('');
                setRemotePickerConnId('');
                setRemotePickerPath('');
                setRemotePickerFiles([]);
                setRemotePickerSelected(new Set());
                setRemotePickerOpen(true);
              }}>{tb('xferAddRemote')}</button>
              <button onClick={() => setBcastXferFiles([])} disabled={bcastXferFiles.length === 0}>{tb('xferRemoveAll')}</button>
            </div>
            <div style={{ flex: 1, minHeight: 100, maxHeight: 220, overflowY: 'auto', border: '1px solid #333', borderRadius: 4, padding: 6, background: '#161616' }}>
              {bcastXferFiles.length === 0 ? (
                <div style={{ color: '#666', fontSize: 12, textAlign: 'center', padding: 16 }}>{tb('xferEmpty')}</div>
              ) : (
                bcastXferFiles.map((f, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 6px', gap: 6 }}>
                    <span style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }} title={`${f.sourceTermId ? `${tb('xferRemote')}(${f.sourceLabel}):` : `${tb('xferLocal')}:`} ${f.path}`}>
                      {f.sourceTermId ? '🌐' : '💻'} {f.isFolder ? '📁' : '📄'} {f.path}
                      {f.sourceTermId && <span style={{ color: '#8ab', fontSize: 10, marginLeft: 6 }}>[{f.sourceLabel}]</span>}
                    </span>
                    <button onClick={() => setBcastXferFiles(prev => prev.filter((_, idx) => idx !== i))} style={{ padding: '0 8px' }}>✕</button>
                  </div>
                ))
              )}
            </div>
            {bcastXferLog.length > 0 && (
              <div style={{ maxHeight: 120, overflowY: 'auto', fontSize: 11, fontFamily: 'monospace', color: '#aaa', background: '#0c0c0c', padding: 6, borderRadius: 4, marginTop: 8 }}>
                {bcastXferLog.map((l, i) => (
                  <div key={i} style={{ color: l.startsWith('✓') ? '#7fcf6e' : (l.startsWith('✗') ? '#e36b6b' : '#aaa') }}>{l}</div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
              <button onClick={() => setShowBcastFileXfer(false)} disabled={bcastXferInProgress}>{tb('xferClose')}</button>
              <button className="primary" disabled={bcastXferInProgress || bcastXferFiles.length === 0 || collectBroadcastTargets(broadcastScope).length === 0}
                onClick={async () => {
                  const targets = collectBroadcastTargets(broadcastScope);
                  if (targets.length === 0) { flashBroadcastNotice(tb('noTargets'), 'warn'); return; }
                  setBcastXferInProgress(true);
                  setBcastXferLog([tb('xferLogStart', { sessions: targets.length, items: bcastXferFiles.length })]);
                  const override = bcastXferPath.trim();
                  let okCount = 0;
                  let errCount = 0;
                  for (const tid of targets) {
                    const basePath = override || getCurrentPwdForTerm(tid) || '/';
                    const info = getTermSessionInfo(tid);
                    const label = info?.sessionName || tid.slice(-6);
                    for (const f of bcastXferFiles) {
                      const filename = f.path.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
                      const remotePath = basePath.endsWith('/') ? basePath + filename : basePath + '/' + filename;
                      // 동일 세션은 source == target 이므로 skip
                      if (f.sourceTermId && f.sourceTermId === tid) {
                        setBcastXferLog(prev => [...prev, tb('xferLogSkipSame', { label, file: filename })]);
                        continue;
                      }
                      const src: any = f.sourceTermId
                        ? { mode: 'remote', termId: f.sourceTermId, path: f.path }
                        : { mode: 'local', path: f.path };
                      try {
                        const r: any = await (window as any).api?.feTransfer?.(
                          src,
                          { mode: 'remote', termId: tid, path: remotePath },
                          filename,
                        );
                        if (r?.success) {
                          okCount++;
                          setBcastXferLog(prev => [...prev, tb('xferLogOk', { label, file: filename, path: basePath })]);
                        } else {
                          errCount++;
                          setBcastXferLog(prev => [...prev, tb('xferLogErr', { label, file: filename, err: r?.error || 'unknown' })]);
                        }
                      } catch (err: any) {
                        errCount++;
                        setBcastXferLog(prev => [...prev, tb('xferLogErr', { label, file: filename, err: err?.message || err })]);
                      }
                    }
                  }
                  setBcastXferLog(prev => [...prev, tb('xferLogDone', { ok: okCount, err: errCount })]);
                  setBcastXferInProgress(false);
                  flashBroadcastNotice(tb('xferDoneNotice', { ok: okCount, total: okCount + errCount }), errCount === 0 ? 'ok' : 'warn');
                }}>
                {bcastXferInProgress ? tb('xferInProgress') : tb('xferStart')}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 비밀번호 입력 모달 — 현재 활성 세션(termId) 의 모달만 표시.
          여러 세션 동시 진행 가능, 각 세션 탭으로 전환하면 해당 비밀번호 카드가 보임.
          위치는 활성 세션 패널(.layout-leaf) 의 중앙. */}
      {askPwdPrompts.length > 0 && (() => {
        // 모든 탭에서 살아있는 termId 집합 — 닫힌 미니탭의 유령 모달 항목 정리용
        const liveTermIds = new Set<string>();
        const walkCollect = (n: any) => {
          if (n.type === 'leaf') {
            for (const s of n.panel.sessions) liveTermIds.add(s.termId);
          } else {
            for (const c of n.children) walkCollect(c);
          }
        };
        for (const t of tabs) {
          if (t.type === 'fileExplorer' || t.type === 'fileEditor') continue;
          walkCollect(t.layout);
        }
        const validPrompts = askPwdPrompts.filter(p => liveTermIds.has(p.termId));
        // 정리 — 다음 렌더 사이클에 state 도 동기화
        if (validPrompts.length !== askPwdPrompts.length) {
          setTimeout(() => {
            setAskPwdPrompts(prev => prev.filter(p => liveTermIds.has(p.termId)));
          }, 0);
        }
        if (validPrompts.length === 0) return null;
        // 현재 활성 termId 찾기 — activeTab + selectedPanelId + activeIdx 우선,
        // 매칭되는 모달이 없으면 현재 탭에서 askPwdPrompts 의 termId 를 가진 leaf 의 활성 세션을 찾음.
        let activeTid: string | null = null;
        const findLeaf = (n: any, id: string | null): any => {
          if (n.type === 'leaf') return (!id || n.id === id) ? n : null;
          for (const c of n.children) { const r = findLeaf(c, id); if (r) return r; }
          return null;
        };
        const findLeafContainingTermId = (n: any, tid: string): any => {
          if (n.type === 'leaf') {
            return n.panel.sessions.some((s: any) => s.termId === tid) ? n : null;
          }
          for (const c of n.children) { const r = findLeafContainingTermId(c, tid); if (r) return r; }
          return null;
        };
        try {
          if (activeTab) {
            const leaf = findLeaf(activeTab.layout, selectedPanelId || null);
            if (leaf) activeTid = leaf.panel.sessions[leaf.panel.activeIdx]?.termId || null;
            // selectedPanelId 가 다른 탭 패널이거나 모달 termId 와 안 맞으면, 현재 탭에서
            // 모달 termId 를 가진 leaf 의 활성 세션을 활성으로 간주.
            const matchedItem = activeTid && validPrompts.find(x => x.termId === activeTid);
            if (!matchedItem) {
              for (const it of validPrompts) {
                const lf = findLeafContainingTermId(activeTab.layout, it.termId);
                if (lf) {
                  const activeOfLeaf = lf.panel.sessions[lf.panel.activeIdx]?.termId;
                  if (activeOfLeaf === it.termId) { activeTid = it.termId; break; }
                }
              }
            }
          }
        } catch {}
        const item = activeTid ? validPrompts.find(x => x.termId === activeTid) : null;
        if (!item) return null;
        // React portal 로 활성 세션 패널(.layout-leaf) 내부에 모달 렌더 — CSS 가 패널 내 중앙 자동 정렬.
        // 분할창 변경/세션 전환 후에도 항상 해당 패널의 정중앙에 위치 보장.
        const targetEl = (() => {
          try { return document.querySelector(`.layout-leaf[data-active-term="${activeTid}"]`) as HTMLElement | null; } catch { return null; }
        })();
        if (!targetEl) return null;
        return createPortal(
          <div className="ask-pwd-stack">
            <div key={item.termId} className="ask-pwd-card">
              <div className="ask-pwd-header">
                <span className="ask-pwd-icon">🔐</span>
                <span className="ask-pwd-title">{item.needUsername ? '자격증명 입력' : '비밀번호 입력'}</span>
                <button className="ask-pwd-close" title="취소" onClick={() => closeAskPwd(item.termId, null)}>✕</button>
              </div>
              <div className="ask-pwd-desc">
                {item.hostHint ? <><b>{item.hostHint}</b> 에 연결</> : '연결을 위해 자격증명이 필요합니다.'}
              </div>
              {item.needUsername && (
                <input
                  type="text"
                  className="save-pwd-input ask-pwd-input"
                  autoFocus
                  value={item.userInput}
                  onChange={e => updateAskPwdUserInput(item.termId, e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      // 다음 입력란(비밀번호)로 포커스 이동
                      const next = (e.currentTarget.parentElement?.querySelector('input[type="password"]') as HTMLInputElement | null);
                      next?.focus();
                    } else if (e.key === 'Escape') { e.preventDefault(); closeAskPwd(item.termId, null); }
                  }}
                  placeholder="username"
                  style={{ letterSpacing: 'normal' }}
                />
              )}
              <input
                type="password"
                className="save-pwd-input ask-pwd-input"
                autoFocus={!item.needUsername}
                value={item.input}
                onChange={e => updateAskPwdInput(item.termId, e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); closeAskPwd(item.termId, item.input); }
                  else if (e.key === 'Escape') { e.preventDefault(); closeAskPwd(item.termId, null); }
                }}
                placeholder="••••••••"
              />
              <div className="ask-pwd-actions">
                <button onClick={() => closeAskPwd(item.termId, null)}>취소</button>
                <button className="primary" onClick={() => closeAskPwd(item.termId, item.input)}>연결</button>
              </div>
              {validPrompts.length > 1 && (
                <div className="ask-pwd-hint">
                  대기 중 {validPrompts.length - 1}개 — 다른 세션 탭에서 입력 가능
                </div>
              )}
            </div>
          </div>,
          targetEl,
        );
      })()}
      {/* 비밀번호 저장 권유 모달 */}
      {savePwdPrompt && (
        <div className="save-pwd-backdrop" onClick={() => { setSavePwdPrompt(null); setTimeout(() => focusTerm(savePwdPrompt.termId), 0); }}>
          <div className="save-pwd-modal" onClick={e => e.stopPropagation()}>
            <div className="save-pwd-icon">🔑</div>
            <div className="save-pwd-title">비밀번호를 세션에 저장할까요?</div>
            <div className="save-pwd-desc">다음 접속부터는 비밀번호 입력 없이 바로 연결됩니다.</div>
            <div className="save-pwd-actions">
              <button
                onClick={() => {
                  const tid = savePwdPrompt.termId;
                  setSavePwdPrompt(null);
                  setTimeout(() => focusTerm(tid), 0);
                }}
              >저장 안 함</button>
              <button
                className="primary"
                onClick={async () => {
                  const { sessionId, password, termId } = savePwdPrompt;
                  setSavePwdPrompt(null);
                  try {
                    const data: any = await (window as any).api?.listSessions?.();
                    const list: any[] = Array.isArray(data) ? data : (data?.sessions || []);
                    const sess = list.find((s: any) => s.id === sessionId);
                    if (sess) {
                      const updated = { ...sess, auth: { ...(sess.auth || {}), type: 'password', password } };
                      await (window as any).api?.saveSession?.(updated);
                      try { window.dispatchEvent(new Event('sessions-reload')); } catch {}
                      showToast(tb('passwordSaved'));
                    }
                  } catch {}
                  setTimeout(() => focusTerm(termId), 0);
                }}
              >저장</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;

// ── 패널 이동 헬퍼 ──

function removeLeafFromTree(root: LayoutNode, targetId: string): { root: LayoutNode; removed?: LayoutNode } {
  if (root.type === 'leaf') {
    if (root.id === targetId) return { root: { ...root }, removed: root };
    return { root };
  }
  const children: LayoutNode[] = []; let removed: LayoutNode | undefined;
  for (const child of root.children) {
    const r = removeLeafFromTree(child, targetId);
    if (r.removed && !removed) removed = r.removed;
    if (!r.removed || r.root.type !== 'leaf' || r.root.id !== targetId) children.push(r.root);
  }
  if (children.length === 0) return { root, removed };
  if (children.length === 1) return { root: children[0], removed };
  return { root: { ...root, children }, removed };
}

function replaceLeaf(root: LayoutNode, targetId: string, leaf: LayoutNode): LayoutNode {
  if (root.type === 'leaf') return root.id === targetId ? leaf : root;
  return { ...root, children: root.children.map(c => replaceLeaf(c, targetId, leaf)) };
}

function insertNear(root: LayoutNode, targetId: string, leaf: LayoutNode, pos: 'before' | 'after'): LayoutNode {
  if (root.type === 'leaf') return root;
  const nc: LayoutNode[] = [];
  for (const c of root.children) {
    if (c.type === 'leaf' && c.id === targetId) { if (pos === 'before') nc.push(leaf); nc.push(c); if (pos === 'after') nc.push(leaf); }
    else nc.push(insertNear(c, targetId, leaf, pos));
  }
  return { ...root, children: nc };
}
