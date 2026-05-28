// src/components/RemoteFileTree.tsx
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { FixedSizeList as VList, ListChildComponentProps } from 'react-window';
import { subscribePwdChange, isTermPty, subscribeConnectedChange } from './TerminalPanel';

const ROW_HEIGHT = 22; // App.css 의 .remote-file-item height 와 동기

// 확장자 → 카테고리. CSS 에서 data-cat 으로 색상 매칭.
const EXT_CAT: Record<string, string> = {
  // C/C++
  c: 'c', h: 'c', cpp: 'c', hpp: 'c', cc: 'c', cxx: 'c', hxx: 'c',
  // Python / Go / Rust / Java / Ruby / PHP
  py: 'py', pyw: 'py', pyx: 'py',
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js',
  ts: 'ts', tsx: 'ts',
  go: 'go', rs: 'rs', java: 'java', rb: 'rb', php: 'php',
  // Script
  sh: 'script', bash: 'script', zsh: 'script', ksh: 'script', csh: 'script',
  tcsh: 'script', ps1: 'script', bat: 'script', cmd: 'script', pl: 'script',
  // Log
  log: 'log', err: 'log', trace: 'log',
  // Doc
  md: 'doc', txt: 'doc', rst: 'doc', pdf: 'doc', rtf: 'doc',
  // Config / Data
  json: 'json',
  yaml: 'config', yml: 'config', toml: 'config', ini: 'config',
  conf: 'config', cfg: 'config', xml: 'config', properties: 'config', env: 'config',
  // Archive
  zip: 'archive', tar: 'archive', gz: 'archive', tgz: 'archive',
  bz2: 'archive', xz: 'archive', '7z': 'archive', rar: 'archive', jar: 'archive',
  // Image
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', bmp: 'image',
  svg: 'image', ico: 'image', webp: 'image',
  // Executable / Binary
  exe: 'exec', bin: 'exec', out: 'exec', dll: 'exec', so: 'exec', o: 'exec', a: 'exec',
  // Tabular data
  csv: 'data', tsv: 'data', sql: 'data', db: 'data', sqlite: 'data',
};

function fileCategory(name: string): string {
  const idx = name.lastIndexOf('.');
  if (idx <= 0) return 'other'; // 숨김파일(.xxx) 혹은 확장자 없음
  const ext = name.slice(idx + 1).toLowerCase();
  return EXT_CAT[ext] || 'other';
}

const CAT_ICON: Record<string, string> = {
  c: '📘', py: '🐍', js: '📜', ts: '📜',
  go: '🐹', rs: '🦀', java: '☕', rb: '💎', php: '🐘',
  script: '⚙️', log: '📋', doc: '📝', json: '🔖', config: '⚙️',
  archive: '📦', image: '🖼️', exec: '⚡', data: '📊',
};

type FileEntry = {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
  mtime?: number;
};

type TreeNode = {
  name: string;
  path: string;
  isDir: boolean;
  children?: TreeNode[];
  loaded?: boolean;
  loading?: boolean;
};

// termId별 트리 상태 캐시 (컴포넌트 unmount/remount에도 유지)
const treeStateCache: Map<string, { root: TreeNode; collapsed: string[]; pathInput: string }> = new Map();

type Props = {
  termId: string;
  sessionName: string;
  sessionId?: string; // 세션 ID (initialPath 조회용)
  initialPath?: string; // 세션 연결 시 사용할 초기 경로 (없으면 홈)
  onOpenFile: (termId: string, remotePath: string, fileName: string) => void;
  onAttachToClaude?: (termId: string, remotePath: string, fileName: string, isDir: boolean) => void;
};

export const RemoteFileTree: React.FC<Props> = ({ termId, sessionName, sessionId, initialPath: initialPathProp, onOpenFile, onAttachToClaude }) => {
  const { t } = useTranslation('fileExplorer');
  // mode: 'local' (PTY 로컬 셸) or 'remote' (SSH/SFTP)
  // sessionId 가 있으면 SSH, 없거나 PTY 가 활성이면 local
  const [mode, setMode] = useState<'local' | 'remote'>(() => (sessionId ? 'remote' : (isTermPty(termId) ? 'local' : 'remote')));
  useEffect(() => {
    const recompute = () => setMode(sessionId ? 'remote' : (isTermPty(termId) ? 'local' : 'remote'));
    recompute();
    const dispose = subscribeConnectedChange(recompute);
    return () => { dispose(); };
  }, [termId, sessionId]);
  // 세션 initialPath 조회 상태 (null=조회중, string=경로, ''=없음/홈사용)
  const [resolvedInitialPath, setResolvedInitialPath] = useState<string | null>(initialPathProp ?? null);
  // 세션의 fileTreeEnabled / initialPath 조회 — 자동 로드 결정용. autoTrackPwd 는 여기서 게이트로 안 씀 (cwd 동기화 전용)
  const [sessionFileTreeEnabled, setSessionFileTreeEnabled] = useState<boolean>(false);
  useEffect(() => {
    if (initialPathProp) { setResolvedInitialPath(initialPathProp); return; }
    if (!sessionId) { setResolvedInitialPath(''); return; }
    let cancelled = false;
    (async () => {
      try {
        const data: any = await (window as any).api?.listSessions?.();
        if (cancelled) return;
        const list = Array.isArray(data) ? data : (data?.sessions || []);
        const sess = list.find((s: any) => s.id === sessionId);
        setResolvedInitialPath(sess?.initialPath || '');
        setSessionFileTreeEnabled(!!sess?.fileTreeEnabled);
      } catch { if (!cancelled) setResolvedInitialPath(''); }
    })();
    return () => { cancelled = true; };
  }, [sessionId, initialPathProp, mode]);
  const initialPath = resolvedInitialPath;
  // 사용자가 명시적으로 "파일트리 연결" 클릭한 경우 표식 — 자동 게이트 우회
  const [userLoaded, setUserLoaded] = useState<boolean>(false);
  // 자동 로드 허용 조건: initialPath 있음 OR fileTreeEnabled 켜짐 OR 사용자가 명시 로드 OR 로컬 모드
  const allowAutoLoad = mode === 'local' || userLoaded || !!initialPathProp || (typeof resolvedInitialPath === 'string' && resolvedInitialPath.length > 0) || sessionFileTreeEnabled;
  // 언마운트 / 비활성 전환 시 dedicated SFTP 해제
  useEffect(() => {
    return () => {
      if (mode === 'remote') {
        try { (window as any).api?.feReleaseSftp?.(termId); } catch {}
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termId]);
  // PWD 자동추적 토글은 트리의 연결 상태와 무관 (cwd 동기화 ON/OFF 만 담당). 별도 핸들러 불필요.
  const cached = treeStateCache.get(termId);
  const [root, setRoot] = useState<TreeNode | null>(cached?.root || null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(cached?.collapsed || []));
  const [pathInput, setPathInput] = useState<string>(cached?.pathInput || '');
  const [promptModal, setPromptModal] = useState<{ title: string; value: string; onSubmit: (v: string) => void } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; node: TreeNode } | null>(null);
  // 다중 선택 (ctrl/cmd+click, shift+click). 파일만 선택 대상.
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  // 범위 선택용 anchor
  const anchorPathRef = useRef<string | null>(null);

  // 컨텍스트 메뉴 외부 클릭/ESC 닫기
  useEffect(() => {
    if (!ctxMenu) return;
    const onClick = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCtxMenu(null); };
    window.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [ctxMenu]);

  // state 변경 시 캐시에 저장
  useEffect(() => {
    if (root) {
      treeStateCache.set(termId, { root, collapsed: [...collapsed], pathInput });
    }
  }, [termId, root, collapsed, pathInput]);

  const loadChildren = useCallback(async (path: string, retries = 3): Promise<TreeNode[]> => {
    try {
      let result: any = null;
      // local 모드는 retry 불필요 (즉시 응답). remote 모드만 SFTP 준비 대기 retry.
      const r = mode === 'local' ? 1 : retries;
      for (let i = 0; i < r; i++) {
        result = await (window as any).api?.feListDir?.(mode, path, termId);
        if (result?.files) break;
        // 명시적 에러면 retry 안 함 (SFTP 채널 누적 방지)
        if (result?.error) break;
        if (i < r - 1) await new Promise(rs => setTimeout(rs, 500));
      }
      if (!result || !result.files) {
        return [];
      }
      const files: FileEntry[] = result.files;
      const nodes: TreeNode[] = files
        .filter((f: any) => f.name !== '.' && f.name !== '..')
        .sort((a: any, b: any) => {
          // mtime 내림차순 (최근 파일이 위). 같으면 폴더 우선, 마지막으로 이름 오름차순.
          const dm = (b.mtime || 0) - (a.mtime || 0);
          if (dm !== 0) return dm;
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        })
        .map((f: any) => {
          // Windows 로컬: 경로 구분자 \ 처리. path 가 드라이브 루트(C:\)면 그대로 결합.
          let childPath: string;
          if (mode === 'local' && /^[a-zA-Z]:[\\/]?$/.test(path)) {
            const base = path.endsWith('\\') || path.endsWith('/') ? path : path + '\\';
            childPath = base + f.name;
          } else if (mode === 'local' && path.includes('\\')) {
            childPath = path.endsWith('\\') ? path + f.name : path + '\\' + f.name;
          } else {
            childPath = path.endsWith('/') ? path + f.name : path + '/' + f.name;
          }
          return {
            name: f.name,
            path: childPath,
            isDir: f.isDir,
          };
        });
      return nodes;
    } catch (err) {
      console.error('[RemoteFileTree] loadChildren error', err);
      return [];
    }
  }, [termId, mode]);

  const navigateTo = useCallback(async (targetPath: string) => {
    const cleanPath = targetPath.trim() || '/';
    const children = await loadChildren(cleanPath);
    setRoot({
      name: cleanPath,
      path: cleanPath,
      isDir: true,
      children,
      loaded: true,
    });
    setPathInput(cleanPath);
    setCollapsed(new Set());
  }, [loadChildren]);

  // 터미널에서 cd 발생 시 (OSC 7 hook) 자동으로 해당 경로로 네비게이트
  useEffect(() => {
    const dispose = subscribePwdChange(termId, (pwd) => {
      if (!pwd) return;
      // 현재 표시된 root.path 와 다를 때만 navigate
      setRoot(r => {
        if (r?.path === pwd) return r;
        // 비동기 navigate 실행
        navigateTo(pwd).catch(() => {});
        return r;
      });
    });
    return () => { dispose(); };
  }, [termId, navigateTo]);

  // 초기 경로 로드 — initialPath 조회 완료 후에만 실행
  useEffect(() => {
    // null 이면 아직 조회 중 — 대기
    if (initialPath === null) return;
    // 자동 로드 게이트: autoTrackPwd 도 꺼져있고 initialPath 도 없으면 사용자가 명시적으로 로드할 때까지 SFTP 안 열기
    if (!allowAutoLoad) return;
    const startTargetPath = (initialPath || '').trim();
    // 이미 캐시 있고 원하는 경로와 일치하면 스킵
    const cached = treeStateCache.get(termId);
    if (cached?.root && startTargetPath && cached.root.path === startTargetPath) return;
    // 캐시 있고 initialPath 가 빈 값(홈 사용)이고 이미 홈으로 로드됐으면 스킵
    if (cached?.root && !startTargetPath) return;
    // 그 외엔 지정된 경로(또는 홈)로 재이동
    (async () => {
      try {
        let startPath = startTargetPath;
        const retries = mode === 'local' ? 1 : 5;
        if (!startPath) {
          let home: any = null;
          for (let i = 0; i < retries; i++) {
            home = await (window as any).api?.feHomeDir?.(mode, termId);
            if (home && typeof home === 'string' && home !== '/') break;
            if (i < retries - 1) await new Promise(r => setTimeout(r, 500));
          }
          startPath = typeof home === 'string' ? home : (home?.path || '/');
        } else if (mode === 'remote') {
          // SFTP 준비 대기 — local 은 즉시 가능
          for (let i = 0; i < 5; i++) {
            try {
              const probe: any = await (window as any).api?.feListDir?.('remote', startPath, termId);
              if (probe?.files) break;
            } catch {}
            await new Promise(r => setTimeout(r, 500));
          }
        }
        setPathInput(startPath);
        const children = await loadChildren(startPath, 5);
        setRoot({
          name: startPath,
          path: startPath,
          isDir: true,
          children,
          loaded: true,
        });
        setCollapsed(new Set());
      } catch (err) {
        console.error('[RemoteFileTree] init error', err);
      }
    })();
  }, [termId, initialPath, loadChildren, mode, allowAutoLoad]);

  const toggleFolder = async (node: TreeNode) => {
    if (!node.isDir) return;
    const isExpanded = !collapsed.has(node.path);
    if (node.loaded) {
      // 이미 로드됨 → 단순 토글
      setCollapsed(prev => {
        const next = new Set(prev);
        if (isExpanded) next.add(node.path);
        else next.delete(node.path);
        return next;
      });
    } else {
      // 처음 여는 중 → 로드 + 펼침 (collapsed에서 제거)
      if (node.loading) return;
      node.loading = true;
      const children = await loadChildren(node.path);
      setRoot(r => {
        if (!r) return r;
        const updateNode = (n: TreeNode): TreeNode => {
          if (n.path === node.path) {
            return { ...n, children, loaded: true, loading: false };
          }
          if (n.children) return { ...n, children: n.children.map(updateNode) };
          return n;
        };
        return updateNode(r);
      });
      setCollapsed(prev => {
        const next = new Set(prev);
        next.delete(node.path); // 확실히 펼침 상태로
        return next;
      });
    }
  };

  // 현재 렌더되는 파일 경로 flat 리스트 (shift+click 범위 선택용, 폴더 제외)
  const visibleFilePaths = useMemo<string[]>(() => {
    const result: string[] = [];
    const walk = (node: TreeNode | null | undefined) => {
      if (!node) return;
      if (!node.isDir) result.push(node.path);
      if (node.isDir && !collapsed.has(node.path) && node.children) {
        for (const c of node.children) walk(c);
      }
    };
    if (root?.children) for (const c of root.children) walk(c);
    return result;
  }, [root, collapsed]);

  // 펼쳐진 노드를 평탄화 (가상화 렌더용)
  const flatNodes = useMemo<{ node: TreeNode; depth: number }[]>(() => {
    const out: { node: TreeNode; depth: number }[] = [];
    const walk = (n: TreeNode, d: number) => {
      out.push({ node: n, depth: d });
      if (n.isDir && !collapsed.has(n.path) && n.children) {
        for (const c of n.children) walk(c, d + 1);
      }
    };
    if (root?.children) for (const c of root.children) walk(c, 0);
    return out;
  }, [root, collapsed]);

  const treeListRef = useRef<HTMLDivElement | null>(null);
  const vlistRef = useRef<VList | null>(null);
  const treeRoRef = useRef<ResizeObserver | null>(null);
  const [listHeight, setListHeight] = useState(400);
  // callback ref — 컴포넌트가 초기엔 loading 분기로 다른 DOM 을 렌더하므로 useEffect([]) 로는
  // listRef.current 가 null 인 채로 한 번만 실행되고 끝남. element attach 시점에 observer 등록.
  const setTreeListRef = useCallback((el: HTMLDivElement | null) => {
    treeListRef.current = el;
    if (treeRoRef.current) { treeRoRef.current.disconnect(); treeRoRef.current = null; }
    if (!el) return;
    const update = () => setListHeight(el.clientHeight || 400);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    treeRoRef.current = ro;
    update();
  }, []);
  useEffect(() => () => { treeRoRef.current?.disconnect(); }, []);

  const renderNode = (node: TreeNode, depth: number, style?: React.CSSProperties): React.ReactNode => {
    const isCollapsed = collapsed.has(node.path);
    const cat = node.isDir ? 'dir' : fileCategory(node.name);
    const isSelected = !node.isDir && selectedPaths.has(node.path);
    return (
      <React.Fragment key={node.path}>
        <div
          className={`remote-file-item ${node.isDir ? 'folder' : 'file'} ${isSelected ? 'selected' : ''}`}
          data-cat={cat}
          data-path={node.path}
          style={{ ...(style || {}), paddingLeft: 8 + depth * 14 }}
          onClick={(e) => {
            if (node.isDir) {
              // 폴더는 기존처럼 단일 클릭으로 확장/축소
              toggleFolder(node);
              return;
            }
            // 파일: 선택만 (열기는 더블클릭). Ctrl/Cmd=토글, Shift=범위, 일반=단일.
            if (e.shiftKey && anchorPathRef.current) {
              const startIdx = visibleFilePaths.indexOf(anchorPathRef.current);
              const endIdx = visibleFilePaths.indexOf(node.path);
              if (startIdx >= 0 && endIdx >= 0) {
                const [lo, hi] = startIdx <= endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
                setSelectedPaths(new Set(visibleFilePaths.slice(lo, hi + 1)));
              }
              return;
            }
            if (e.ctrlKey || e.metaKey) {
              setSelectedPaths(prev => {
                const next = new Set(prev);
                if (next.has(node.path)) next.delete(node.path); else next.add(node.path);
                return next;
              });
              anchorPathRef.current = node.path;
              return;
            }
            // 단일 선택
            setSelectedPaths(new Set([node.path]));
            anchorPathRef.current = node.path;
          }}
          onDoubleClick={(e) => {
            if (node.isDir) return; // 폴더는 더블클릭 무시 (단일클릭으로 이미 처리)
            e.stopPropagation();
            onOpenFile(termId, node.path, node.name);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            // 오른쪽 클릭 시 현재 노드가 선택에 없으면 단일 선택으로 리셋 (일반적 UX)
            if (!node.isDir && !selectedPaths.has(node.path)) {
              setSelectedPaths(new Set([node.path]));
              anchorPathRef.current = node.path;
            }
            setCtxMenu({ x: e.clientX, y: e.clientY, node });
          }}
        >
          {node.isDir ? (
            <span className="remote-file-toggle">{isCollapsed ? '▶' : '▼'}</span>
          ) : (
            <span className="remote-file-toggle-space" />
          )}
          <span className="remote-file-icon">{node.isDir ? '📁' : CAT_ICON[cat] || '📄'}</span>
          <span className="remote-file-name">{node.name}</span>
        </div>
      </React.Fragment>
    );
  };

  if (!root) {
    // 자동 로드가 막혔으면 (autoTrackPwd 꺼지고 initialPath 없음) 사용자에게 명시적 로드 버튼 제공 — 불필요한 SFTP 연결 방지
    if (!allowAutoLoad) {
      return (
        <div className="remote-file-loading" style={{ padding: 14, fontSize: 12, color: '#aac', lineHeight: 1.6 }}>
          <div style={{ marginBottom: 8 }}>📁 파일트리는 자동으로 열리지 않습니다.</div>
          <div style={{ marginBottom: 12, color: '#888', fontSize: 11 }}>
            세션의 <b>PWD 자동추적</b> 또는 <b>초기 경로</b> 가 설정되어 있으면 자동 연결됩니다.
            <br/>그렇지 않으면 아래 버튼으로 SFTP 연결을 시작하세요.
          </div>
          <button
            onClick={() => setUserLoaded(true)}
            style={{ padding: '6px 12px', fontSize: 12, background: '#2b4e74', color: '#fff', border: '1px solid #3a6593', borderRadius: 3, cursor: 'pointer' }}
          >🔌 파일트리 연결</button>
        </div>
      );
    }
    return <div className="remote-file-loading">{t('loading')}</div>;
  }

  const openFilePrompt = () => {
    setPromptModal({
      title: t('remoteFileOpen'),
      value: root?.path ? (root.path.endsWith('/') ? root.path : root.path + '/') : '/',
      onSubmit: (filePath) => {
        if (!filePath.trim()) return;
        const fileName = filePath.split('/').filter(Boolean).pop() || filePath;
        onOpenFile(termId, filePath, fileName);
      },
    });
  };

  const openFolderPrompt = () => {
    setPromptModal({
      title: t('remoteFolderOpen'),
      value: root?.path || '/',
      onSubmit: (folderPath) => {
        if (!folderPath.trim()) return;
        navigateTo(folderPath);
      },
    });
  };

  return (
    <div className="remote-file-tree">
      <div className="remote-file-header">
        <span>🔌 {sessionName}</span>
        <div className="remote-file-header-actions">
          <button className="remote-file-action-btn" onClick={openFilePrompt} title={t('remoteFileOpen')}>📄</button>
          <button className="remote-file-action-btn" onClick={openFolderPrompt} title={t('remoteFolderOpen')}>📁</button>
        </div>
      </div>
      <div className="remote-file-path-bar">
        <input
          className="remote-file-path-input"
          value={pathInput}
          onChange={e => setPathInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); navigateTo(pathInput); }
          }}
          placeholder="/path/to/folder"
          title={t('remoteFilePromptHint')}
        />
        <button className="remote-file-path-go" onClick={() => navigateTo(pathInput)} title={t('remoteFileGo')}>↵</button>
        <button className="remote-file-path-up" onClick={async () => {
          if (!root) return;
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const r = await (window as any).api?.sftpUpload?.(termId, root.path, 'multi-file');
            if (r?.success) navigateTo(root.path);
          } catch {}
        }} title={t('uploadHere')}>⬆</button>
        <button className="remote-file-path-home" onClick={() => {
          if (!root) return;
          navigateTo(root.path);
        }} title={t('refreshLoadAgain')}>⟳</button>
      </div>
      <div
        className="remote-file-list"
        tabIndex={0}
        ref={setTreeListRef}
        onKeyDown={e => {
          if (e.key.length !== 1 || e.ctrlKey || e.altKey || e.metaKey) return;
          const ch = e.key.toLowerCase();
          const curIdx = flatNodes.findIndex(({ node: n }) => selectedPaths.has(n.path));
          for (let i = 1; i <= flatNodes.length; i++) {
            const idx = (curIdx + i) % flatNodes.length;
            if (flatNodes[idx].node.name.toLowerCase().startsWith(ch)) {
              e.preventDefault();
              setSelectedPaths(new Set([flatNodes[idx].node.path]));
              anchorPathRef.current = flatNodes[idx].node.path;
              try { vlistRef.current?.scrollToItem(idx, 'smart'); } catch {}
              break;
            }
          }
        }}
      >
        <VList
          ref={vlistRef}
          height={listHeight}
          width="100%"
          itemCount={flatNodes.length}
          itemSize={ROW_HEIGHT}
          overscanCount={10}
        >
          {({ index, style }: ListChildComponentProps) => {
            const entry = flatNodes[index];
            if (!entry) return null;
            return renderNode(entry.node, entry.depth, style) as React.ReactElement;
          }}
        </VList>
      </div>
      {ctxMenu && (() => {
        // 다중 선택 상태 감지 — 현재 우클릭 대상이 선택 집합에 포함돼 있고, 크기 > 1 일 때
        const isMultiContext = !ctxMenu.node.isDir && selectedPaths.size > 1 && selectedPaths.has(ctxMenu.node.path);
        return (
        <div
          className="remote-file-ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={e => e.stopPropagation()}
          onContextMenu={e => e.preventDefault()}
        >
          {isMultiContext ? (
            <>
              <div className="context-menu-label">{t('selectedFilesCount', { count: selectedPaths.size })}</div>
              <div className="remote-file-ctx-item" onClick={async () => {
                const items = [...selectedPaths].map(p => ({ path: p, isDir: false }));
                setCtxMenu(null);
                try {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  await (window as any).api?.sftpDownloadMulti?.(termId, items);
                } catch {}
              }}>{t('downloadMultiple', { count: selectedPaths.size })}</div>
              <div className="remote-file-ctx-item danger" onClick={async () => {
                const paths = [...selectedPaths];
                setCtxMenu(null);
                if (!confirm(t('deleteMultiConfirm', { count: paths.length, names: paths.slice(0, 10).join('\n') + (paths.length > 10 ? `\n... (+${paths.length - 10})` : '') }))) return;
                let ok = 0, fail = 0;
                for (const p of paths) {
                  try {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const r = await (window as any).api?.feDelete?.(mode, p, termId);
                    if (r?.success) ok++; else fail++;
                  } catch { fail++; }
                }
                if (fail > 0) alert(t('deleteResult', { ok, fail }));
                setSelectedPaths(new Set());
                if (root) navigateTo(root.path);
              }}>{t('deleteMultiple', { count: selectedPaths.size })}</div>
              <div className="remote-file-ctx-item" onClick={() => {
                setSelectedPaths(new Set());
                setCtxMenu(null);
              }}>{t('deselect')}</div>
            </>
          ) : (
            <>
          {!ctxMenu.node.isDir && (
            <div className="remote-file-ctx-item" onClick={() => {
              onOpenFile(termId, ctxMenu.node.path, ctxMenu.node.name);
              setCtxMenu(null);
            }}>{t('openFileMenu')}</div>
          )}
          {ctxMenu.node.isDir && (
            <div className="remote-file-ctx-item" onClick={() => {
              navigateTo(ctxMenu.node.path);
              setCtxMenu(null);
            }}>{t('openFolderMenu')}</div>
          )}
          <div className="remote-file-ctx-item" onClick={async () => {
            const node = ctxMenu.node;
            setCtxMenu(null);
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              await (window as any).api?.sftpDownload?.(termId, node.path, node.isDir);
            } catch {}
          }}>{t('downloadMenu')}{ctxMenu.node.isDir ? t('downloadRecursive') : ''}</div>
          {ctxMenu.node.isDir && (
            <>
              <div className="remote-file-ctx-item" onClick={async () => {
                const node = ctxMenu.node;
                setCtxMenu(null);
                try {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const r = await (window as any).api?.sftpUpload?.(termId, node.path, 'file');
                  if (r?.success) navigateTo(node.path);
                } catch {}
              }}>{t('uploadFileMenu')}</div>
              <div className="remote-file-ctx-item" onClick={async () => {
                const node = ctxMenu.node;
                setCtxMenu(null);
                try {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const r = await (window as any).api?.sftpUpload?.(termId, node.path, 'multi-file');
                  if (r?.success) navigateTo(node.path);
                } catch {}
              }}>{t('uploadFileMulti')}</div>
              <div className="remote-file-ctx-item" onClick={async () => {
                const node = ctxMenu.node;
                setCtxMenu(null);
                try {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const r = await (window as any).api?.sftpUpload?.(termId, node.path, 'folder');
                  if (r?.success) navigateTo(node.path);
                } catch {}
              }}>{t('uploadFolder')}</div>
            </>
          )}
          {onAttachToClaude && (
            <div className="remote-file-ctx-item claude" onClick={() => {
              onAttachToClaude(termId, ctxMenu.node.path, ctxMenu.node.name, ctxMenu.node.isDir);
              setCtxMenu(null);
            }}>{t('attachClaudeMenu')}{ctxMenu.node.isDir ? t('downloadRecursive') : ''}</div>
          )}
          <div className="remote-file-ctx-item" onClick={async () => {
            try {
              await navigator.clipboard.writeText(ctxMenu.node.path);
            } catch {}
            setCtxMenu(null);
          }}>{t('copyPathMenu')}</div>
          <div className="remote-file-ctx-item danger" onClick={async () => {
            const node = ctxMenu.node;
            setCtxMenu(null);
            const kind = node.isDir ? t('kindFolder') : t('kindFile');
            if (!confirm(t('deleteConfirmRecursive', { kind, path: node.path }))) return;
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const r = await (window as any).api?.feDelete?.(mode, node.path, termId);
              if (!r?.success) {
                alert(t('deleteFailUnknown', { err: r?.error || t('unknownError') }));
                return;
              }
              // 삭제된 노드의 부모 경로를 다시 로드
              if (root) navigateTo(root.path);
            } catch (err: any) {
              alert(t('deleteFailUnknown', { err: err?.message || err }));
            }
          }}>{t('deleteMenu')}{ctxMenu.node.isDir ? t('downloadRecursive') : ''}</div>
            </>
          )}
        </div>
        );
      })()}
      {promptModal && (
        <div className="path-prompt-backdrop" onClick={() => setPromptModal(null)}>
          <div className="path-prompt-modal" onClick={e => e.stopPropagation()}>
            <div className="path-prompt-title">{promptModal.title}</div>
            <input
              className="path-prompt-input"
              value={promptModal.value}
              autoFocus
              onChange={e => setPromptModal(p => p ? { ...p, value: e.target.value } : null)}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); promptModal.onSubmit(promptModal.value); setPromptModal(null); }
                if (e.key === 'Escape') setPromptModal(null);
              }}
              placeholder="/path/to/..."
            />
            <div className="path-prompt-actions">
              <button onClick={() => setPromptModal(null)}>{t('cancel')}</button>
              <button className="primary" onClick={() => { promptModal.onSubmit(promptModal.value); setPromptModal(null); }}>{t('confirm')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
