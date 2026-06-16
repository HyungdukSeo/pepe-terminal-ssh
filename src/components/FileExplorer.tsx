// src/components/FileExplorer.tsx
import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { FilePanel, PanelSource } from './FilePanel';
import { TransferLog } from './TransferLog';
import { setTermFocusBlocked } from './TerminalPanel';
import { notifyError } from './Notify';
import type { PanelSession } from '../utils/layoutUtils';

const api = (window as any).api || {};

type Props = {
  sessions: PanelSession[];
  initialTermId?: string | null;
  // 파일 전송 탭을 열 때 활성 SSH 세션의 현재 pwd — 있으면 홈 대신 이 경로로 우측 패널을 연다.
  initialRemotePath?: string | null;
  // 이 FileExplorer 가 속한 워크스페이스 탭 id — 세션→파일전송 연결 이벤트를 이 탭으로만 라우팅.
  tabId?: string;
};

export const FileExplorer: React.FC<Props> = ({ sessions, initialTermId, initialRemotePath, tabId }) => {
  // 이 FileExplorer 인스턴스의 고유 ID — 전송 이벤트 필터링에 사용
  const workspaceIdRef = React.useRef(`fe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const { t } = useTranslation('fileExplorer');
  const localLabel = t('local');
  const [sources, setSources] = useState<PanelSource[]>([{ mode: 'local', label: localLabel }]);
  // 좌·우 패널 각각 여러 폴더 탭 유지 — 각 탭은 자기 source/path/selected 상태
  type PanelTab = { id: string; source: PanelSource; path: string; selected: Set<string> };
  const makeTab = (source: PanelSource, path = ''): PanelTab => ({
    id: `pt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    source, path, selected: new Set(),
  });
  const [leftTabs, setLeftTabs] = useState<PanelTab[]>(() => [makeTab({ mode: 'local', label: localLabel })]);
  const [rightTabs, setRightTabs] = useState<PanelTab[]>(() => [makeTab({ mode: 'local', label: localLabel })]);
  const [leftActive, setLeftActive] = useState(0);
  const [rightActive, setRightActive] = useState(0);
  const leftActiveRef = useRef(0);
  const rightActiveRef = useRef(0);
  useEffect(() => { leftActiveRef.current = leftActive; }, [leftActive]);
  useEffect(() => { rightActiveRef.current = rightActive; }, [rightActive]);
  const rightTabsRef = useRef<PanelTab[]>([]);
  useEffect(() => { rightTabsRef.current = rightTabs; });
  // 활성 탭의 source/path/selected 를 derived 로 노출 — 기존 코드 호환
  const leftTab = leftTabs[leftActive] || leftTabs[0];
  const rightTab = rightTabs[rightActive] || rightTabs[0];
  const leftSource = leftTab.source;
  const rightSource = rightTab.source;
  const leftPath = leftTab.path;
  const rightPath = rightTab.path;
  const leftSelected = leftTab.selected;
  const rightSelected = rightTab.selected;
  // 활성 탭에 대한 setter — useCallback 으로 ref 안정화 (FilePanel 자식의 loadDir useEffect 재실행 깜빡임 방지)
  const setLeftSource = useCallback((s: PanelSource) =>
    setLeftTabs(prev => prev.map((t, i) => i === leftActiveRef.current ? { ...t, source: s } : t)), []);
  const setRightSource = useCallback((s: PanelSource) =>
    setRightTabs(prev => prev.map((t, i) => i === rightActiveRef.current ? { ...t, source: s } : t)), []);
  const setLeftPath = useCallback((p: string) =>
    setLeftTabs(prev => prev.map((t, i) => i === leftActiveRef.current ? { ...t, path: p } : t)), []);
  const setRightPath = useCallback((p: string) =>
    setRightTabs(prev => prev.map((t, i) => i === rightActiveRef.current ? { ...t, path: p } : t)), []);
  const setLeftSelected: React.Dispatch<React.SetStateAction<Set<string>>> = useCallback((v: any) =>
    setLeftTabs(prev => prev.map((t, i) => i === leftActiveRef.current
      ? { ...t, selected: typeof v === 'function' ? v(t.selected) : v } : t)), []);
  const setRightSelected: React.Dispatch<React.SetStateAction<Set<string>>> = useCallback((v: any) =>
    setRightTabs(prev => prev.map((t, i) => i === rightActiveRef.current
      ? { ...t, selected: typeof v === 'function' ? v(t.selected) : v } : t)), []);
  const [transferring, setTransferring] = useState(false);
  const [initDone, setInitDone] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const rightSourceSetRef = React.useRef(false);
  const [showSftpConnect, setShowSftpConnect] = useState<'left' | 'right' | null>(null);
  const [selectedSide, setSelectedSide] = useState<'left' | 'right'>('left');
  const [sftpHost, setSftpHost] = useState('');
  const [sftpPort, setSftpPort] = useState(22);
  const [sftpUser, setSftpUser] = useState('');
  const [sftpPass, setSftpPass] = useState('');
  const [sftpConnecting, setSftpConnecting] = useState(false);
  const [transfersHeight, setTransfersHeight] = useState(() => {
    const saved = localStorage.getItem('feTransfersHeight');
    return saved ? Number(saved) : 200;
  });
  const resizing = React.useRef<{ startY: number; startH: number } | null>(null);
  // 세션 ID → 폴더 이름 매핑 (드롭다운 label 에 폴더 접두사 붙이기용)
  const [sessionFolderMap, setSessionFolderMap] = useState<Record<string, string>>({});
  // 전체 세션 리스트 (드롭다운 확장용 — 미연결 포함)
  const [allSessionsList, setAllSessionsList] = useState<any[]>([]);
  // lazy 연결로 생성된 SFTP 임시 connId — FileExplorer unmount 시 정리
  const [lazyConns, setLazyConns] = useState<string[]>([]);
  // 자격증명 입력 프롬프트 — 비밀번호 미저장 세션 연결 실패 시 표시
  const [credPrompt, setCredPrompt] = useState<{ sess: any; side: 'left' | 'right'; jumpOpts: any } | null>(null);
  const [credUser, setCredUser] = useState('');
  const [credPass, setCredPass] = useState('');
  const [credShowPass, setCredShowPass] = useState(false);
  const [credConnecting, setCredConnecting] = useState(false);
  const credUserInputRef = useRef<HTMLInputElement>(null);
  const credModalRef = useRef<HTMLDivElement>(null);
  // useLayoutEffect — DOM 커밋 직후(브라우저 페인트 이전)에 실행되어
  // 어떤 포스트-렌더 포커스 이벤트보다 먼저 input 을 확보
  useLayoutEffect(() => {
    if (!credPrompt) {
      setTermFocusBlocked(false);
      return;
    }
    // DOM 커밋 직후 즉시 포커스
    credUserInputRef.current?.focus();

    // 추가 보강: focusin capture 로 모달 외부 포커스를 input 으로 리다이렉트
    const trap = (e: FocusEvent) => {
      const modal = credModalRef.current;
      const input = credUserInputRef.current;
      if (!modal || !input) return;
      if (!modal.contains(e.target as Node)) {
        e.stopImmediatePropagation();
        input.focus();
      }
    };
    document.addEventListener('focusin', trap, true);
    return () => {
      document.removeEventListener('focusin', trap, true);
    };
  }, [credPrompt]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data: any = await api.listSessions?.();
        if (cancelled) return;
        const allSessions: any[] = data?.sessions ?? [];
        const folders: any[] = data?.folders ?? [];
        setAllSessionsList(allSessions);
        const folderById: Record<string, any> = {};
        for (const f of folders) folderById[f.id] = f;
        const folderPath = (fid?: string): string => {
          if (!fid) return '';
          const f = folderById[fid];
          if (!f) return '';
          const parent = folderPath(f.parentId);
          return parent ? `${parent}/${f.name}` : f.name;
        };
        const map: Record<string, string> = {};
        for (const s of allSessions) map[s.id] = folderPath(s.folderId);
        setSessionFolderMap(map);
      } catch {}
    };
    load();
    return () => { cancelled = true; };
  }, [sessions.length]);

  // 언마운트 시 lazy 연결 정리
  useEffect(() => {
    return () => {
      for (const cid of lazyConns) {
        try { api?.feSftpDisconnect?.(cid); } catch {}
      }
    };
  }, [lazyConns]);

  // 초기 경로
  useEffect(() => {
    (async () => {
      try {
        const home = await api?.feGetHome?.();
        if (home) {
          setLeftPath(home);
          // initialRemotePath(활성 SSH pwd) 가 있으면 우측은 원격 경로로 열 것이므로 로컬 home 으로 덮어쓰지 않음.
          const hasRemoteInit = !!(initialRemotePath && initialRemotePath.trim() && initialRemotePath !== '/');
          if (!hasRemoteInit) setRightPath(home);
        }
      } catch {}
      setInitDone(true);
    })();

    // 전송 진행률은 이제 TransferLog 컴포넌트에서 직접 처리
    // 단, 전송 종료 시점에 버튼 disable 해제 처리만 남김
    let unsub2: any;
    try {
      unsub2 = api?.onSFTPComplete?.((p: any) => {
        try {
          const d = JSON.parse(p.data);
          // 루트 전송 완료시(또는 dir-done 일 때) transferring 해제
          if (d.rel === '' || d.direction === 'dir-done') setTransferring(false);
        } catch {}
      });
    } catch {}
    return () => { try { unsub2?.(); } catch {} };
  }, []);

  // 파일 전송 탭에서 세션 더블클릭으로 SFTP 연결된 이벤트 수신
  useEffect(() => {
    const handler = async (e: Event) => {
      const { connId, sessionName, host, feTabId } = (e as CustomEvent).detail;
      // 특정 파일 전송 탭을 대상으로 한 이벤트면 그 탭의 인스턴스만 처리 (중복 추가 방지)
      if (feTabId && tabId && feTabId !== tabId) return;
      // 이미 추가된 연결이면 무시
      if (rightTabsRef.current.some(t => t.source.termId === connId)) return;
      const sameNameCount = sources.filter(s => s.label?.includes(sessionName)).length;
      const num = sameNameCount + 1;
      const label = `🌐 ${sessionName} #${num} (${host})`;
      const newSrc: PanelSource = { mode: 'remote', termId: connId, label };
      // 소스 드롭다운 목록에도 추가
      setSources(prev => {
        if (prev.find(s => s.termId === connId)) return prev;
        const idx = prev.findIndex(s => (s.mode as any) === 'sftp-connect');
        const arr = [...prev];
        if (idx >= 0) arr.splice(idx, 0, newSrc); else arr.push(newSrc);
        return arr;
      });
      // 오른쪽 패널에 '신규 탭'으로 연다 — 홈 경로 확보 후 탭 생성/활성화
      const home = await getHomeWithRetry('remote', connId);
      const newIndex = rightTabsRef.current.length;
      setRightTabs(prev => [...prev, makeTab(newSrc, home)]);
      setRightActive(newIndex);
      setSelectedSide('right');
    };
    window.addEventListener('fe-sftp-connected', handler);
    return () => window.removeEventListener('fe-sftp-connected', handler);
  }, [rightSource.mode]);

  // 빠른 연결 바에서 들어오는 SFTP 직접 연결 요청 처리
  useEffect(() => {
    const handler = async (ev: any) => {
      const info = ev.detail || {};
      if (!info.host || !info.username) return;
      // 특정 파일 전송 탭 대상이면 그 인스턴스만 처리
      if (info.feTabId && tabId && info.feTabId !== tabId) return;
      const connId = `sftp-${Date.now()}`;
      try {
        const result = await api.feSftpConnect?.(connId, info.host, Number(info.port) || 22, info.username, { type: 'password', password: info.auth?.password ?? '' });
        if (!result?.success) { notifyError(t('connectFail', { err: result?.error || t('unknownError') })); return; }
        if (rightTabsRef.current.some(t => t.source.termId === connId)) return;
        const newSrc: PanelSource = { mode: 'remote', termId: connId, label: `🔌 ${info.username}@${info.host}` };
        setSources(prev => {
          if (prev.find(s => s.termId === connId)) return prev;
          const idx = prev.findIndex(s => (s.mode as any) === 'sftp-connect');
          const arr = [...prev];
          if (idx >= 0) arr.splice(idx, 0, newSrc); else arr.push(newSrc);
          return arr;
        });
        // 오른쪽 패널에 '신규 탭'으로 연다
        let home = '/';
        try { home = (await api.feHomeDir('remote', connId)) || '/'; } catch {}
        const newIndex = rightTabsRef.current.length;
        setRightTabs(prev => [...prev, makeTab(newSrc, home)]);
        setRightActive(newIndex);
        setSelectedSide('right');
      } catch (err: any) { notifyError(t('connectFail', { err })); }
    };
    window.addEventListener('fe-quick-sftp-connect', handler);
    return () => window.removeEventListener('fe-quick-sftp-connect', handler);
  }, [selectedSide]);

  // sessions prop 변경 시 소스 목록 갱신
  const sessKey = sessions.map(s => s.termId).join(',');
  useEffect(() => {
    const newSources: PanelSource[] = [{ mode: 'local', label: localLabel }];
    // 이미 터미널로 연결된 세션의 sessionId
    const connectedSessionIds = new Set(sessions.map(s => s.sessionId).filter(Boolean));
    // 1) 이미 연결된 세션을 먼저 🟢 로 추가
    for (const sess of sessions) {
      const folder = sessionFolderMap[sess.sessionId];
      const label = folder ? `🟢 ${sess.sessionName}  [${folder}]` : `🟢 ${sess.sessionName}`;
      newSources.push({ mode: 'remote', termId: sess.termId, sessionId: sess.sessionId, label });
    }
    // 2) 미연결 세션을 ⚪ (lazy-remote) 로 추가 — 선택 시 자동 백그라운드 SFTP 연결
    for (const s of allSessionsList) {
      if (connectedSessionIds.has(s.id)) continue;
      const folder = sessionFolderMap[s.id];
      const label = folder ? `⚪ ${s.name}  [${folder}] (${s.host})` : `⚪ ${s.name} (${s.host})`;
      newSources.push({ mode: 'lazy-remote', sessionId: s.id, label });
    }
    // 3) 기존 SFTP 직접 연결 유지 — 수동(🔌) + 세션 우클릭 파일전송(🌐, termId=sftp-fe-…)
    //    (이들은 sessions/allSessionsList 로 재현되지 않으므로 재구성 시 명시적으로 보존해야 함)
    for (const s of sources) {
      if (s.mode === 'remote' && typeof s.termId === 'string' && s.termId.startsWith('sftp')
          && !newSources.find(n => n.termId === s.termId)) {
        newSources.push(s);
      }
    }
    newSources.push({ mode: 'sftp-connect' as any, label: t('sftpDirectOption') });
    setSources(newSources);
    // 최초 1회만: 원격 소스가 있고 rightSource가 로컬이면 오른쪽 기본으로 설정
    // activeTermId 가 있으면 해당 세션 우선, 없으면 첫 번째 세션
    if (initDone && sessions.length > 0 && rightSource.mode === 'local' && !rightSourceSetRef.current) {
      rightSourceSetRef.current = true;
      const first = (initialTermId ? sessions.find(s => s.termId === initialTermId) : null) || sessions[0];
      const newSrc: PanelSource = { mode: 'remote', termId: first.termId, label: `🌐 ${first.sessionName}` };
      setRightSource(newSrc);
      // initialRemotePath(활성 SSH 세션의 현재 pwd) 가 있으면 그 경로로, 없으면 홈 디렉토리로 연다.
      const initPath = (initialRemotePath && initialRemotePath.trim() && initialRemotePath !== '/') ? initialRemotePath.trim() : '';
      if (initPath) {
        // SFTP 준비 보장 후 경로 적용 — feHomeDir 로 연결을 establish/대기한 뒤 initPath 로 이동.
        // (연결 직후 곧장 listDir 하면 SFTP 서브시스템 미준비로 에러나는 케이스 회피)
        (async () => {
          for (let i = 0; i < 10; i++) {
            try { const h = await api?.feHomeDir?.('remote', first.termId); if (h) break; } catch {}
            await new Promise(r => setTimeout(r, 500));
          }
          setRightPath(initPath);
        })();
      } else {
        // SSH 연결 완료 대기 후 홈 디렉토리 가져오기 (최대 10초)
        const tryGetHome = async (retries: number) => {
          for (let i = 0; i < retries; i++) {
            try {
              const home = await api?.feHomeDir?.('remote', first.termId);
              if (home && home !== '/') { setRightPath(home); return; }
            } catch {}
            await new Promise(r => setTimeout(r, 1000));
          }
          setRightPath('/');
        };
        tryGetHome(10);
      }
    }
  }, [sessKey, initDone, sessionFolderMap, allSessionsList]);

  // getHomeWithRetry 를 effect 에서 참조하기 위한 ref (초기 자동선택에서 사용)
  const getHomeWithRetryRef = React.useRef<((mode: string, termId?: string) => Promise<string>) | null>(null);

  const sep = (source: PanelSource) => source.mode === 'local' && navigator.platform.startsWith('Win') ? '\\' : '/';

  const getHomeWithRetry = async (mode: string, termId?: string): Promise<string> => {
    for (let i = 0; i < 5; i++) {
      try {
        const home = await api?.feHomeDir?.(mode, termId);
        if (home && home !== '/') return home;
      } catch {}
      if (mode === 'local') break;
      await new Promise(r => setTimeout(r, 1000));
    }
    return mode === 'local' ? 'C:\\' : '/';
  };
  getHomeWithRetryRef.current = getHomeWithRetry;

  // lazy-remote 소스를 실제 연결된 remote 소스로 변환. 실패 시 null 반환.
  // 연결 실패(인증 오류 등) → 자격증명 입력 다이얼로그 표시.
  const realizeLazyRemote = async (src: PanelSource, side: 'left' | 'right'): Promise<PanelSource | null> => {
    if (src.mode !== 'lazy-remote' || !src.sessionId) return null;
    const sess = allSessionsList.find(s => s.id === src.sessionId);
    if (!sess) { notifyError(t('remoteSessionMissing')); return null; }
    const connId = `fe-lazy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const jumpOpts = sess.jumpTargetHost?.trim()
      ? { host: sess.jumpTargetHost.trim(), user: sess.jumpTargetUser || 'root', port: Number(sess.jumpTargetPort) || 22, password: sess.jumpTargetPassword || undefined }
      : undefined;
    // 비밀번호가 없는 세션은 바로 자격증명 다이얼로그 표시
    const hasCredential = sess.auth?.type === 'key' || (sess.auth?.type === 'password' && sess.auth?.password);
    const openCred = () => {
      setTermFocusBlocked(true); // 렌더 전에 동기 차단 — useEffect 보다 먼저 실행됨
      setCredPrompt({ sess, side, jumpOpts });
      setCredUser(sess.username || '');
      setCredPass('');
      setCredShowPass(false);
    };
    if (!hasCredential) {
      openCred();
      return null;
    }
    try {
      const r: any = await api?.feSftpConnect?.(connId, sess.host, sess.port || 22, sess.username, sess.auth, jumpOpts);
      if (!r?.success) {
        openCred();
        return null;
      }
    } catch {
      openCred();
      return null;
    }
    setLazyConns(prev => [...prev, connId]);
    const folder = sessionFolderMap[sess.id];
    const label = folder ? `🟢 ${sess.name}  [${folder}]` : `🟢 ${sess.name}`;
    const newSrc: PanelSource = { mode: 'remote', termId: connId, sessionId: sess.id, label };
    // 소스 리스트 업데이트 — lazy 항목 제거하고 연결된 항목 추가
    setSources(prev => {
      const filtered = prev.filter(s => !(s.mode === 'lazy-remote' && s.sessionId === sess.id));
      // '직접 연결' 항목 앞에 삽입
      const idx = filtered.findIndex(s => (s.mode as any) === 'sftp-connect');
      const arr = [...filtered];
      if (idx >= 0) arr.splice(idx, 0, newSrc); else arr.push(newSrc);
      return arr;
    });
    return newSrc;
  };

  // 자격증명 다이얼로그 확인 — 입력된 id/비밀번호로 연결 재시도
  const handleCredSubmit = async () => {
    if (!credPrompt) return;
    const { sess, side, jumpOpts } = credPrompt;
    setCredConnecting(true);
    const newConnId = `fe-lazy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const r: any = await api?.feSftpConnect?.(newConnId, sess.host, sess.port || 22, credUser, { type: 'password', password: credPass }, jumpOpts);
      if (!r?.success) {
        notifyError(t('connectFailNamed', { name: sess.name, err: r?.error || t('unknownError') }));
        setCredConnecting(false);
        return;
      }
      setLazyConns(prev => [...prev, newConnId]);
      const folder = sessionFolderMap[sess.id];
      const label = folder ? `🟢 ${sess.name}  [${folder}]` : `🟢 ${sess.name}`;
      const newSrc: PanelSource = { mode: 'remote', termId: newConnId, sessionId: sess.id, label };
      setSources(prev => {
        const filtered = prev.filter(s => !(s.mode === 'lazy-remote' && s.sessionId === sess.id));
        const idx = filtered.findIndex(s => (s.mode as any) === 'sftp-connect');
        const arr = [...filtered];
        if (idx >= 0) arr.splice(idx, 0, newSrc); else arr.push(newSrc);
        return arr;
      });
      if (side === 'left') {
        setLeftSource(newSrc);
        setLeftPath(await getHomeWithRetry('remote', newSrc.termId));
      } else {
        setRightSource(newSrc);
        setRightPath(await getHomeWithRetry('remote', newSrc.termId));
      }
      setCredPrompt(null);
    } catch (err: any) {
      notifyError(t('connectFailNamed', { name: sess.name, err: err?.message || err }));
    }
    setCredConnecting(false);
  };

  const handleLeftSourceChange = async (src: PanelSource) => {
    if (src.mode === 'sftp-connect' as any) { setShowSftpConnect('left'); return; }
    if (src.mode === 'lazy-remote') {
      const real = await realizeLazyRemote(src, 'left');
      if (!real) return;
      setLeftSource(real);
      setLeftPath(await getHomeWithRetry('remote', real.termId));
      return;
    }
    setLeftSource(src);
    setLeftPath(await getHomeWithRetry(src.mode, src.termId));
  };

  const handleRightSourceChange = async (src: PanelSource) => {
    if (src.mode === 'sftp-connect' as any) { setShowSftpConnect('right'); return; }
    if (src.mode === 'lazy-remote') {
      const real = await realizeLazyRemote(src, 'right');
      if (!real) return;
      setRightSource(real);
      setRightPath(await getHomeWithRetry('remote', real.termId));
      return;
    }
    setRightSource(src);
    setRightPath(await getHomeWithRetry(src.mode, src.termId));
  };

  const handleDisconnect = async (src: PanelSource) => {
    if (src.mode !== 'remote' || !src.termId) return;
    try { await api?.feSftpDisconnect?.(src.termId); } catch {}
    setSources(prev => prev.filter(s => s.termId !== src.termId));
    // 모든 좌·우 탭 중 해당 termId 를 가진 탭은 local 로 fallback
    const localHome = await getHomeWithRetry('local');
    const localSrc: PanelSource = { mode: 'local', label: localLabel };
    setLeftTabs(prev => prev.map(t => t.source.termId === src.termId
      ? { ...t, source: localSrc, path: localHome, selected: new Set() } : t));
    setRightTabs(prev => prev.map(t => t.source.termId === src.termId
      ? { ...t, source: localSrc, path: localHome, selected: new Set() } : t));
  };

  const handleSftpConnect = async () => {
    if (!sftpHost || !sftpUser) return;
    setSftpConnecting(true);
    const connId = `sftp-${Date.now()}`;
    try {
      const result = await api.feSftpConnect?.(connId, sftpHost, sftpPort, sftpUser, { type: 'password', password: sftpPass });
      if (!result?.success) { notifyError(t('connectFail', { error: result?.error || t('unknownError') })); setSftpConnecting(false); return; }
      const newSrc: PanelSource = { mode: 'remote', termId: connId, label: `🔌 ${sftpUser}@${sftpHost}` };
      setSources(prev => [...prev, newSrc]);
      if (showSftpConnect === 'left') {
        setLeftSource(newSrc);
        try { const home = await api.feHomeDir('remote', connId); setLeftPath(home || '/'); } catch { setLeftPath('/'); }
      } else {
        setRightSource(newSrc);
        try { const home = await api.feHomeDir('remote', connId); setRightPath(home || '/'); } catch { setRightPath('/'); }
      }
    } catch (err: any) { notifyError(t('connectFail', { err })); }
    setSftpConnecting(false);
    setShowSftpConnect(null);
    setSftpHost(''); setSftpPort(22); setSftpUser(''); setSftpPass('');
  };

  // feTransfer는 즉시 반환 + fe:transfer-done 이벤트로 완료 통보 → IPC 채널 해제로 progress 이벤트 실시간 수신
  const doTransfer = (src: any, dst: any, name: string): Promise<{ success: boolean; error?: string }> =>
    new Promise(resolve => {
      api.feTransfer?.(src, dst, name, workspaceIdRef.current).then((result: any) => {
        const seq: number = result?.seq;
        if (seq == null) { resolve({ success: result?.success ?? true }); return; }
        const unsub = api.onFeTransferDone?.((p: any) => {
          if (p.seq === seq) { unsub?.(); resolve(p); }
        });
        if (!unsub) resolve({ success: true });
      }).catch((err: any) => resolve({ success: false, error: String(err) }));
    });

  const transferFiles = async (direction: 'left-to-right' | 'right-to-left') => {
    const srcSource = direction === 'left-to-right' ? leftSource : rightSource;
    const dstSource = direction === 'left-to-right' ? rightSource : leftSource;
    const srcPath = direction === 'left-to-right' ? leftPath : rightPath;
    const dstPath = direction === 'left-to-right' ? rightPath : leftPath;
    const selected = direction === 'left-to-right' ? leftSelected : rightSelected;
    const dstSep = sep(dstSource);
    const srcSep = sep(srcSource);

    if (selected.size === 0) return;
    setTransferring(true);

    for (const name of selected) {
      const srcFull = srcPath.endsWith(srcSep) ? srcPath + name : srcPath + srcSep + name;
      const dstFull = dstPath.endsWith(dstSep) ? dstPath + name : dstPath + dstSep + name;
      const result = await doTransfer(
        { mode: srcSource.mode, termId: srcSource.termId, path: srcFull },
        { mode: dstSource.mode, termId: dstSource.termId, path: dstFull },
        name,
      );
      if (!result.success) notifyError(t('transferFail', { name, err: result.error }));
    }

    setTransferring(false);
    setRefreshKey(k => k + 1);
  };

  const handleFileDrop = async (targetSide: 'left' | 'right', fileNames: string[], srcMode: string, srcTermId?: string, srcPath?: string) => {
    const dstSource = targetSide === 'left' ? leftSource : rightSource;
    const dstPath = targetSide === 'left' ? leftPath : rightPath;
    const dstSep = sep(dstSource);
    const srcSep = srcMode === 'local' && navigator.platform.startsWith('Win') ? '\\' : '/';

    setTransferring(true);
    for (const name of fileNames) {
      const srcFull = (srcPath || '').endsWith(srcSep) ? (srcPath || '') + name : (srcPath || '') + srcSep + name;
      const dstFull = dstPath.endsWith(dstSep) ? dstPath + name : dstPath + dstSep + name;
      const result = await doTransfer(
        { mode: srcMode, termId: srcTermId, path: srcFull },
        { mode: dstSource.mode, termId: dstSource.termId, path: dstFull },
        name,
      );
      if (!result.success) notifyError(t('transferFail', { name, err: result.error }));
    }
    setTransferring(false);
    setRefreshKey(k => k + 1);
  };

  // 폴더 탭 추가 — 현재 활성 탭의 source/path 복제 (사용자가 현재 위치에서 가지 치기 의도)
  const addPanelTab = (side: 'left' | 'right') => {
    if (side === 'left') {
      const cur = leftTabs[leftActive] || leftTabs[0];
      const newTab = makeTab(cur.source, cur.path);
      setLeftTabs(prev => [...prev, newTab]);
      setLeftActive(leftTabs.length);
    } else {
      const cur = rightTabs[rightActive] || rightTabs[0];
      const newTab = makeTab(cur.source, cur.path);
      setRightTabs(prev => [...prev, newTab]);
      setRightActive(rightTabs.length);
    }
  };
  const closePanelTab = (side: 'left' | 'right', idx: number) => {
    const tabs = side === 'left' ? leftTabs : rightTabs;
    if (tabs.length <= 1) return; // 최소 한 탭은 유지
    const active = side === 'left' ? leftActive : rightActive;
    const next = tabs.filter((_, i) => i !== idx);
    let newActive = active;
    if (idx < active) newActive = active - 1;
    else if (idx === active) newActive = Math.min(active, next.length - 1);
    if (side === 'left') { setLeftTabs(next); setLeftActive(newActive); }
    else { setRightTabs(next); setRightActive(newActive); }
  };
  // 탭 라벨 — path 의 basename, 빈 경로면 source label 약식
  const tabLabel = (tab: PanelTab): string => {
    const p = tab.path || '';
    if (p) {
      const m = p.match(/[^\\/]+$/);
      if (m) return m[0];
    }
    const lbl = tab.source.label || '';
    return lbl.replace(/^[🟢⚪🌐🔌🔒]\s*/, '').split(/\s+\[/)[0].slice(0, 24) || '~';
  };

  // 드래그 상태 — fromSide 와 overSide 분리: 한 패널 내 reorder + 좌↔우 이동 모두 지원
  const [tabDrag, setTabDrag] = useState<{ fromSide: 'left' | 'right'; from: number; overSide: 'left' | 'right'; over: number } | null>(null);
  // 같은 패널 내 reorder
  const reorderTabs = (side: 'left' | 'right', from: number, to: number) => {
    if (from === to) return;
    const tabs = side === 'left' ? leftTabs : rightTabs;
    if (from < 0 || from >= tabs.length || to < 0 || to >= tabs.length) return;
    const next = [...tabs];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    const active = side === 'left' ? leftActive : rightActive;
    let newActive = active;
    if (active === from) newActive = to;
    else if (from < active && to >= active) newActive = active - 1;
    else if (from > active && to <= active) newActive = active + 1;
    if (side === 'left') { setLeftTabs(next); setLeftActive(newActive); }
    else { setRightTabs(next); setRightActive(newActive); }
  };
  // 좌↔우 패널 이동
  const moveTabBetweenSides = (fromSide: 'left' | 'right', from: number, toSide: 'left' | 'right', to: number) => {
    if (fromSide === toSide) { reorderTabs(fromSide, from, to); return; }
    const srcTabs = fromSide === 'left' ? leftTabs : rightTabs;
    const dstTabs = toSide === 'left' ? leftTabs : rightTabs;
    if (from < 0 || from >= srcTabs.length) return;
    if (srcTabs.length <= 1) return; // 마지막 탭은 이동 금지 (패널이 빈 상태가 됨)
    const moved = srcTabs[from];
    const nextSrc = srcTabs.filter((_, i) => i !== from);
    const insertAt = Math.max(0, Math.min(to, dstTabs.length));
    const nextDst = [...dstTabs];
    nextDst.splice(insertAt, 0, moved);
    // 활성 인덱스 보정
    const srcActive = fromSide === 'left' ? leftActive : rightActive;
    const dstActive = toSide === 'left' ? leftActive : rightActive;
    let newSrcActive = srcActive;
    if (srcActive === from) newSrcActive = Math.min(srcActive, nextSrc.length - 1);
    else if (from < srcActive) newSrcActive = srcActive - 1;
    let newDstActive = dstActive;
    if (insertAt <= dstActive) newDstActive = dstActive + 1;
    // 이동한 탭을 목적지에서 활성화 (사용자 의도)
    newDstActive = insertAt;
    if (fromSide === 'left') { setLeftTabs(nextSrc); setLeftActive(newSrcActive); }
    else { setRightTabs(nextSrc); setRightActive(newSrcActive); }
    if (toSide === 'left') { setLeftTabs(nextDst); setLeftActive(newDstActive); }
    else { setRightTabs(nextDst); setRightActive(newDstActive); }
  };

  const renderPanelTabs = (side: 'left' | 'right') => {
    const tabs = side === 'left' ? leftTabs : rightTabs;
    const active = side === 'left' ? leftActive : rightActive;
    return (
      <div className="fe-panel-tabs">
        {tabs.map((tab, idx) => {
          const isDragging = tabDrag?.fromSide === side && tabDrag.from === idx;
          const isDropTarget = tabDrag && tabDrag.overSide === side && tabDrag.over === idx
            && !(tabDrag.fromSide === side && tabDrag.from === idx);
          return (
          <div
            key={tab.id}
            draggable
            className={`fe-panel-tab ${idx === active ? 'active' : ''} ${isDragging ? 'dragging' : ''} ${isDropTarget ? 'drop-target' : ''}`}
            onMouseDown={() => {
              setSelectedSide(side);
              if (side === 'left') setLeftActive(idx); else setRightActive(idx);
            }}
            onAuxClick={e => { if (e.button === 1) { e.preventDefault(); closePanelTab(side, idx); } }}
            onDragStart={e => {
              setTabDrag({ fromSide: side, from: idx, overSide: side, over: idx });
              try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(idx)); } catch {}
            }}
            onDragOver={e => {
              if (!tabDrag) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              if (tabDrag.overSide !== side || tabDrag.over !== idx) {
                setTabDrag({ ...tabDrag, overSide: side, over: idx });
              }
            }}
            onDrop={e => {
              if (tabDrag) {
                e.preventDefault();
                moveTabBetweenSides(tabDrag.fromSide, tabDrag.from, side, idx);
              }
              setTabDrag(null);
            }}
            onDragEnd={() => setTabDrag(null)}
            title={tab.path || tab.source.label}
          >
            <span className="fe-panel-tab-label">{tabLabel(tab)}</span>
            {tabs.length > 1 && (
              <button
                className="fe-panel-tab-close"
                onClick={e => { e.stopPropagation(); closePanelTab(side, idx); }}
                title="탭 닫기"
              >×</button>
            )}
          </div>
          );
        })}
        {/* 탭바 끝 빈 영역으로 drop → 맨 끝에 추가 */}
        <div
          className="fe-panel-tabs-end-drop"
          onDragOver={e => {
            if (!tabDrag) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (tabDrag.overSide !== side || tabDrag.over !== tabs.length) {
              setTabDrag({ ...tabDrag, overSide: side, over: tabs.length });
            }
          }}
          onDrop={e => {
            if (tabDrag) {
              e.preventDefault();
              moveTabBetweenSides(tabDrag.fromSide, tabDrag.from, side, tabs.length);
            }
            setTabDrag(null);
          }}
        />
        <button
          className="fe-panel-tab-add"
          onClick={() => addPanelTab(side)}
          title="새 탭 (현재 위치 복제)"
        >+</button>
      </div>
    );
  };

  const onResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    resizing.current = { startY: e.clientY, startH: transfersHeight };
    const onMove = (ev: MouseEvent) => {
      if (!resizing.current) return;
      const delta = resizing.current.startY - ev.clientY;
      const newH = Math.max(80, Math.min(600, resizing.current.startH + delta));
      setTransfersHeight(newH);
    };
    const onUp = () => {
      resizing.current = null;
      localStorage.setItem('feTransfersHeight', String(transfersHeight));
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  try { return (
    <div className="fe-container">
      <div className="fe-dual">
        <div className={`fe-panel-wrap ${selectedSide === 'left' ? 'selected' : ''}`} onMouseDownCapture={() => setSelectedSide('left')}>
          {renderPanelTabs('left')}
          <FilePanel panelId="left" refreshKey={refreshKey}
            source={leftSource} sources={sources} onSourceChange={handleLeftSourceChange}
            selectedFiles={leftSelected} onSelectionChange={setLeftSelected}
            currentPath={leftPath} onPathChange={setLeftPath}
            onFileDrop={(files, srcMode, srcTermId, srcPath) => handleFileDrop('left', files, srcMode, srcTermId, srcPath)}
            onDisconnect={() => handleDisconnect(leftSource)}
            workspaceId={workspaceIdRef.current}
          />
        </div>
        <div className="fe-transfer-btns">
          <button className="fe-transfer-btn" onClick={() => transferFiles('left-to-right')} disabled={transferring || leftSelected.size === 0} title={t('transferToRight')}>→</button>
          <button className="fe-transfer-btn" onClick={() => transferFiles('right-to-left')} disabled={transferring || rightSelected.size === 0} title={t('transferToLeft')}>←</button>
        </div>
        <div className={`fe-panel-wrap ${selectedSide === 'right' ? 'selected' : ''}`} onMouseDownCapture={() => setSelectedSide('right')}>
          {renderPanelTabs('right')}
          <FilePanel panelId="right" refreshKey={refreshKey}
            source={rightSource} sources={sources} onSourceChange={handleRightSourceChange}
            selectedFiles={rightSelected} onSelectionChange={setRightSelected}
            currentPath={rightPath} onPathChange={setRightPath}
            onFileDrop={(files, srcMode, srcTermId, srcPath) => handleFileDrop('right', files, srcMode, srcTermId, srcPath)}
            onDisconnect={() => handleDisconnect(rightSource)}
            workspaceId={workspaceIdRef.current}
          />
        </div>
      </div>
      <div className="fe-transfers-resize" onMouseDown={onResizeStart} />
      <div className="fe-transfers" style={{ height: transfersHeight }}>
        <TransferLog workspaceId={workspaceIdRef.current} />
      </div>
      {credPrompt && (
        <div className="session-editor-backdrop" onClick={() => setCredPrompt(null)}>
          <div className="cred-modal" ref={credModalRef} tabIndex={-1} onClick={e => e.stopPropagation()} style={{ outline: 'none' }}>
            <div className="cred-modal-header">
              <span className="cred-modal-title">🔒 {t('credModalTitle')}</span>
              <button className="cred-modal-close" onClick={() => setCredPrompt(null)}>✕</button>
            </div>
            <div className="cred-modal-host">{credPrompt.sess.host} {t('credModalConnectTo')}</div>
            <div className="cred-modal-fields">
              <input
                ref={credUserInputRef}
                className="cred-modal-input"
                placeholder="username"
                value={credUser}
                onChange={e => setCredUser(e.target.value)}
              />
              <div className="cred-modal-pass-wrap">
                <input
                  className="cred-modal-input"
                  type={credShowPass ? 'text' : 'password'}
                  placeholder="password"
                  value={credPass}
                  onChange={e => setCredPass(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleCredSubmit(); }}
                />
                <button
                  type="button"
                  className="cred-modal-eye-btn"
                  tabIndex={-1}
                  onClick={() => setCredShowPass(v => !v)}
                  title={credShowPass ? '숨기기' : '보이기'}
                >
                  {credShowPass ? '🙈' : '👁'}
                </button>
              </div>
            </div>
            <div className="cred-modal-actions">
              <button className="btn-cancel" onClick={() => setCredPrompt(null)}>{t('cancel')}</button>
              <button className="btn-save" onClick={handleCredSubmit} disabled={credConnecting}>
                {credConnecting ? t('connecting') : t('connect')}
              </button>
            </div>
          </div>
        </div>
      )}
      {showSftpConnect && (
        <div className="session-editor-backdrop" onClick={() => setShowSftpConnect(null)}>
          <div className="session-editor" onClick={e => e.stopPropagation()} style={{ width: 400 }}>
            <h3>{t('sftpDirectTitle')}</h3>
            <div className="session-editor-grid">
              <label>{t('host')}</label>
              <input value={sftpHost} onChange={e => setSftpHost(e.target.value)} placeholder="192.168.0.1" autoFocus />
              <label>{t('port')}</label>
              <input type="number" value={sftpPort} onChange={e => setSftpPort(Number(e.target.value) || 22)} />
              <label>{t('user')}</label>
              <input value={sftpUser} onChange={e => setSftpUser(e.target.value)} placeholder="root" />
              <label>{t('password')}</label>
              <input type="password" value={sftpPass} onChange={e => setSftpPass(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleSftpConnect(); }}
              />
            </div>
            <div className="session-editor-actions">
              <button className="btn-cancel" onClick={() => setShowSftpConnect(null)}>{t('cancel')}</button>
              <button className="btn-save" onClick={handleSftpConnect} disabled={sftpConnecting}>
                {sftpConnecting ? t('connecting') : t('connect')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  ); } catch (err: any) {
    return <div style={{ padding: 20, color: '#e74c3c' }}>{t('loadFail', { err: String(err) })}</div>;
  }
};
