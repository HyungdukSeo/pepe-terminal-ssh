// src/components/FilePanel.tsx
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { FixedSizeList as VList, ListChildComponentProps } from 'react-window';
import { createPortal } from 'react-dom';
import { ContextMenu } from './ContextMenu';
import { ChmodDialog } from './ChmodDialog';
import { RenameDialog } from './RenameDialog';

// 파일 패널 간 공유 클립보드 (양쪽 패널에서 복사/붙여넣기 공유)
type FileClipboard = {
  mode: string;
  termId?: string;
  basePath: string;
  files: string[];
  operation: 'copy' | 'cut';
};
let _fileClipboard: FileClipboard | null = null;
const getFileClipboard = () => _fileClipboard;
const setFileClipboard = (c: FileClipboard | null) => { _fileClipboard = c; };

const ROW_HEIGHT = 22; // App.css 의 .fe-file-row height 와 동기

export type FileInfo = {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
  // 가상 shell 항목 (내 PC, 네트워크, .lnk 단축 등) — 클릭 시 이 경로로 navigate
  shellPath?: string;
  // 원격 SFTP 전용
  mode?: string;       // drwxr-xr-x
  owner?: string;
  group?: string;
  isLink?: boolean;
};

export type PanelSource = {
  // 'lazy-remote' 는 아직 연결되지 않은 원격 세션 (FileExplorer 가 선택 시 자동 SFTP 연결)
  mode: 'local' | 'remote' | 'lazy-remote';
  termId?: string;
  sessionId?: string; // lazy-remote 용 식별자
  label: string;
};

type SortKey = 'name' | 'size' | 'mtime';
type SortDir = 'asc' | 'desc';

type Props = {
  source: PanelSource;
  sources: PanelSource[];
  onSourceChange: (src: PanelSource) => void;
  selectedFiles: Set<string>;
  onSelectionChange: (sel: Set<string>) => void;
  currentPath: string;
  onPathChange: (path: string) => void;
  onFileDrop?: (files: string[], srcMode: string, srcTermId?: string, srcPath?: string) => void;
  onDisconnect?: () => void;
  panelId: string;
  refreshKey?: number;
};

const api = (window as any).api || {};

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

function formatDate(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// 확장자 → 유형 라벨 추론 (탐색기의 "유형" 컬럼)
function getFileTypeLabel(name: string, isDir: boolean): string {
  if (isDir) return '파일 폴더';
  const idx = name.lastIndexOf('.');
  if (idx <= 0) return '파일';
  const ext = name.slice(idx + 1).toLowerCase();
  const labels: Record<string, string> = {
    txt: '텍스트 문서', md: '마크다운', log: '로그 파일', rtf: 'RTF 문서',
    doc: 'Word 문서', docx: 'Word 문서', pdf: 'PDF 문서',
    xls: 'Excel 통합 문서', xlsx: 'Excel 통합 문서', csv: 'CSV 파일',
    ppt: 'PowerPoint', pptx: 'PowerPoint',
    png: 'PNG 이미지', jpg: 'JPEG 이미지', jpeg: 'JPEG 이미지', gif: 'GIF 이미지', bmp: 'BMP 이미지', svg: 'SVG 이미지', webp: 'WebP 이미지', ico: '아이콘',
    mp4: 'MP4 동영상', avi: 'AVI 동영상', mkv: 'MKV 동영상', mov: 'MOV 동영상', webm: 'WebM 동영상',
    mp3: 'MP3 오디오', wav: 'WAV 오디오', flac: 'FLAC 오디오', aac: 'AAC 오디오', ogg: 'OGG 오디오',
    zip: 'ZIP 압축', '7z': '7-Zip 압축', rar: 'RAR 압축', tar: 'TAR 압축', gz: 'gzip 압축', tgz: 'gzip TAR', xz: 'xz 압축', bz2: 'bzip2 압축',
    exe: '응용 프로그램', msi: '설치 패키지', bat: '배치 파일', cmd: '명령 스크립트', ps1: 'PowerShell', sh: 'Shell 스크립트',
    lnk: '바로 가기',
    json: 'JSON 파일', xml: 'XML 파일', yaml: 'YAML 파일', yml: 'YAML 파일', toml: 'TOML 파일', ini: '구성 설정', cfg: '구성', conf: '구성',
    js: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript', jsx: 'JavaScript', py: 'Python', java: 'Java', c: 'C 소스', cpp: 'C++ 소스', h: '헤더', go: 'Go 소스', rs: 'Rust 소스', rb: 'Ruby', php: 'PHP',
    rpm: 'RPM 파일', deb: 'Debian 패키지',
    bashrc: 'Bash RC', cshrc: 'CSHRC',
    history: 'HISTORY 파일', viminfo: 'VIMINFO',
    tmp: 'TMP 파일',
  };
  // 특수 이름 처리 — .bashrc, .cshrc 등 (확장자 없는 dotfile)
  if (idx === 0) {
    const lower = name.toLowerCase();
    if (lower === '.bashrc') return 'Bash RC';
    if (lower === '.bash_history') return 'BASH_HISTORY';
    if (lower === '.bash_logout') return 'Bash Logout';
    if (lower === '.bash_profile') return 'Bash Profile';
    if (lower === '.cshrc') return 'CSHRC';
    if (lower === '.history') return 'HISTORY 파일';
    if (lower === '.lesshst') return 'LESSHST';
    if (lower === '.viminfo') return 'VIMINFO';
    if (lower === '.viminfz.tmp' || lower === '.viminfo.tmp') return 'TMP 파일';
  }
  return labels[ext] || `${ext.toUpperCase()} 파일`;
}

// 항목 이름 / shellPath 로 적절한 emoji 아이콘 결정 — Windows 탐색기 아이콘 모사
function getFileIcon(name: string, isDir: boolean, shellPath?: string): string {
  if (!isDir) {
    // 파일 확장자 기반
    const ext = name.lastIndexOf('.') > 0 ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
    if (ext === 'lnk') return '🔗';
    if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'svg'].includes(ext)) return '🖼';
    if (['mp4', 'avi', 'mkv', 'mov', 'webm'].includes(ext)) return '🎬';
    if (['mp3', 'wav', 'flac', 'aac', 'ogg'].includes(ext)) return '🎵';
    if (['zip', '7z', 'rar', 'tar', 'gz', 'xz', 'bz2'].includes(ext)) return '📦';
    if (['exe', 'msi', 'bat', 'cmd', 'ps1', 'sh'].includes(ext)) return '⚙';
    if (['txt', 'md', 'log', 'rtf', 'doc', 'docx'].includes(ext)) return '📝';
    if (['pdf'].includes(ext)) return '📕';
    if (['xlsx', 'xls', 'csv'].includes(ext)) return '📊';
    if (['pptx', 'ppt'].includes(ext)) return '📽';
    if (['json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf'].includes(ext)) return '🔖';
    if (['js', 'ts', 'tsx', 'jsx', 'py', 'java', 'c', 'cpp', 'h', 'go', 'rs', 'rb', 'php'].includes(ext)) return '📜';
    return '📄';
  }
  // 디렉토리 — 이름/shell path 기반
  const lower = name.toLowerCase();
  if (lower === '내 pc' || lower.includes('mycomputer')) return '🖥';
  if (lower === '네트워크' || lower.includes('network')) return '🌐';
  if (lower === '라이브러리' || lower.includes('libraries') || lower.includes('libraryfolder')) return '📚';
  if (lower === '제어판' || lower.includes('controlpanel')) return '⚙';
  if (lower === '홈' || lower === '사용자' || lower === 'users') return '🏠';
  if (lower === '갤러리' || lower === 'gallery') return '🖼';
  if (lower === '다운로드' || lower === 'downloads' || lower.includes('download')) return '⬇';
  if (lower === '문서' || lower === 'documents' || lower === 'mydocuments') return '📄';
  if (lower === '사진' || lower === 'pictures' || lower === 'mypictures') return '🖼';
  if (lower === '동영상' || lower === 'videos' || lower === 'myvideos') return '🎬';
  if (lower === '음악' || lower === 'music' || lower === 'mymusic') return '🎵';
  if (lower === '바탕 화면' || lower === 'desktop') return '🖼';
  if (lower === '휴지통' || lower.includes('recycle')) return '🗑';
  if (lower.includes('onedrive')) return '☁';
  // shellPath 가 드라이브 letter 면 drive 아이콘
  if (shellPath && /^[A-Z]:[\\/]?$/.test(shellPath)) return '💾';
  // shellPath 가 UNC 면 네트워크 공유
  if (shellPath && shellPath.startsWith('\\\\')) return '🌐';
  return '📁';
}

export const FilePanel: React.FC<Props> = ({ source, sources, onSourceChange, selectedFiles, onSelectionChange, currentPath, onPathChange, onFileDrop, onDisconnect, panelId, refreshKey }) => {
  const { t } = useTranslation('fileExplorer');
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [editPath, setEditPath] = useState(currentPath);
  const [editingPath, setEditingPath] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; file?: FileInfo } | null>(null);
  const [renamingFile, setRenamingFile] = useState<string | null>(null);
  const [chmodDialog, setChmodDialog] = useState<{ paths: string[]; initialMode?: number; hasDir: boolean } | null>(null);
  // 컬럼 폭 (px) — localStorage 영속화
  const [colWidths, setColWidths] = useState<{ name: number; size: number; type: number; date: number; mode: number; owner: number }>(() => {
    try {
      const saved = localStorage.getItem('feColWidths');
      if (saved) return JSON.parse(saved);
    } catch {}
    return { name: 220, size: 80, type: 110, date: 140, mode: 110, owner: 80 };
  });
  const resizingCol = useRef<{ key: keyof typeof colWidths; startX: number; startW: number } | null>(null);

  const startColResize = (key: keyof typeof colWidths) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizingCol.current = { key, startX: e.clientX, startW: colWidths[key] };
    const target = e.currentTarget as HTMLElement;
    target.classList.add('fe-col-resize-active');
    const onMove = (ev: MouseEvent) => {
      if (!resizingCol.current) return;
      const { key, startX, startW } = resizingCol.current;
      const newW = Math.max(40, Math.min(800, startW + ev.clientX - startX));
      setColWidths(w => ({ ...w, [key]: newW }));
    };
    const onUp = () => {
      target.classList.remove('fe-col-resize-active');
      resizingCol.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      // 종료 시점에만 저장
      setColWidths(w => {
        try { localStorage.setItem('feColWidths', JSON.stringify(w)); } catch {}
        return w;
      });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  // 로컬 드라이브 목록 — 볼륨 라벨 + 드라이브 letter 포함 ({path, label}[])
  const [drives, setDrives] = useState<{ path: string; label: string }[]>([]);
  // 로컬 파일 아이콘 캐시 (path → dataUrl) — Electron 의 app.getFileIcon 으로 lazy 로딩
  const [iconCache, setIconCache] = useState<Map<string, string>>(new Map());
  const iconRequestedRef = useRef<Set<string>>(new Set());
  // 확장자 → 아이콘 캐시 (원격 SFTP 파일용 — 로컬에 파일 없어도 확장자만으로 Windows 아이콘 추출)
  const [extIconCache, setExtIconCache] = useState<Map<string, string>>(new Map());
  const extRequestedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (source.mode !== 'local') return;
    (async () => {
      try {
        const list: any = await api.feGetDrives?.();
        if (Array.isArray(list)) {
          const norm = list.map((x: any) => typeof x === 'string' ? { path: x, label: x } : x).filter((x: any) => x && x.path);
          setDrives(norm);
        }
      } catch {}
    })();
  }, [source.mode]);
  const [renameValue, setRenameValue] = useState('');
  const [lastClickIdx, setLastClickIdx] = useState(-1);
  const listRef = useRef<HTMLDivElement | null>(null);
  const vlistRef = useRef<VList | null>(null);
  const vlistOuterRef = useRef<HTMLDivElement | null>(null);
  const [listHeight, setListHeight] = useState(400);
  const dragJustEnded = useRef(false);
  const listRoRef = useRef<ResizeObserver | null>(null);

  // callback ref — 부모 layout 이 지연 마운트되거나 conditional 렌더로 listRef.current 가
  // 초기엔 null 인 케이스 안전망. element attach 시점마다 observer 재등록.
  const setListRef = useCallback((el: HTMLDivElement | null) => {
    listRef.current = el;
    if (listRoRef.current) { listRoRef.current.disconnect(); listRoRef.current = null; }
    if (!el) return;
    const update = () => setListHeight(el.clientHeight || 400);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    listRoRef.current = ro;
    update();
  }, []);
  useEffect(() => () => { listRoRef.current?.disconnect(); }, []);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  // 안정된 callback ref — 매 렌더마다 새 함수가 안 만들어지도록 useCallback. 마운트 즉시 포커스 + 텍스트 선택.
  const renameInputRefCallback = useCallback((el: HTMLInputElement | null) => {
    renameInputRef.current = el;
    if (el && document.activeElement !== el) {
      try {
        el.focus();
        const v = el.value;
        const isDotfile = v.startsWith('.');
        const dot = isDotfile ? -1 : v.lastIndexOf('.');
        el.setSelectionRange(0, dot > 0 ? dot : v.length);
      } catch {}
    }
  }, []);

  // rename 모드 진입 시 명시적으로 input 에 포커스 + 텍스트 선택
  // (autoFocus 가 일부 환경에서 동작 안 하는 경우 대비. 여러 번 재시도로 race 회피.)
  useEffect(() => {
    if (!renamingFile) return;
    let cancelled = false;
    const tryFocus = (attempt: number) => {
      if (cancelled) return;
      const el = renameInputRef.current;
      if (el) {
        try {
          el.focus();
          const v = el.value;
          const isDotfile = v.startsWith('.');
          const dot = isDotfile ? -1 : v.lastIndexOf('.');
          el.setSelectionRange(0, dot > 0 ? dot : v.length);
        } catch {}
        if (document.activeElement === el) return;
      }
      if (attempt < 5) setTimeout(() => tryFocus(attempt + 1), 20);
    };
    tryFocus(0);
    return () => { cancelled = true; };
  }, [renamingFile]);

  // 원격 SFTP 모드: 파일 확장자 기반 Windows shell 아이콘 lazy 로딩
  // ★ 500ms debounce — PowerShell spawn 과 modal 타이밍 충돌 방지
  useEffect(() => {
    if (source.mode !== 'remote') return;
    if (!files || files.length === 0) return;
    if (renamingFile) {
      console.log(`[ps-dbg] remote ext-icon load SKIPPED (renamingFile=${renamingFile})`);
      return;
    }
    console.log(`[ps-dbg] remote ext-icon load scheduled in 500ms`);
    const t = setTimeout(() => {
      console.log(`[ps-dbg] remote ext-icon load DEBOUNCE FIRED`);
      const fileExts = new Set<string>();
      let needsDirIcon = false;
      for (const f of files) {
        if (f.isDir) { needsDirIcon = true; continue; }
        const idx = f.name.lastIndexOf('.');
        const ext = idx > 0 ? f.name.slice(idx + 1).toLowerCase() : '';
        if (ext && !extRequestedRef.current.has('file:' + ext)) {
          fileExts.add(ext);
        }
      }
      (async () => {
        if (fileExts.size > 0) {
          const exts = Array.from(fileExts);
          exts.forEach(e => extRequestedRef.current.add('file:' + e));
          console.log(`[ps-dbg] remote ext-icon CALLING feGetIconsByExt (${exts.length} exts) hasFocus=${document.hasFocus()}`);
          const t0 = Date.now();
          try {
            const r: any = await api.feGetIconsByExt?.(exts, false);
            console.log(`[ps-dbg] remote ext-icon RESOLVED ${Date.now() - t0}ms hasFocus=${document.hasFocus()}`);
            if (r?.icons) {
              setExtIconCache(prev => {
                const next = new Map(prev);
                for (const [ext, url] of Object.entries(r.icons)) {
                  if (url && typeof url === 'string') next.set('file:' + ext, url);
                }
                return next;
              });
            }
          } catch {}
        }
        if (needsDirIcon && !extRequestedRef.current.has('dir:')) {
          extRequestedRef.current.add('dir:');
          console.log(`[ps-dbg] remote dir-icon CALLING feGetIconsByExt hasFocus=${document.hasFocus()}`);
          try {
            const r: any = await api.feGetIconsByExt?.([''], true);
            console.log(`[ps-dbg] remote dir-icon RESOLVED hasFocus=${document.hasFocus()}`);
            if (r?.icons && r.icons['']) {
              setExtIconCache(prev => { const next = new Map(prev); next.set('dir:', r.icons['']); return next; });
            }
          } catch {}
        }
      })();
    }, 500);
    return () => { console.log('[ps-dbg] remote ext-icon CLEANUP (timer cancelled)'); clearTimeout(t); };
  }, [files, source.mode, renamingFile]);

  // 로컬 모드에서 파일 목록 변경 시 shell icon 을 BATCH 로 요청.
  // ★ 500ms debounce — 빠른 연속 파일 작업(create/rename 등) 으로 PowerShell spawn 이
  //   modal 열림 타이밍과 겹쳐 OS 포커스를 빼앗는 문제 방지
  useEffect(() => {
    if (source.mode !== 'local') return;
    if (!files || files.length === 0) return;
    if (renamingFile) {
      console.log(`[ps-dbg] local icon load SKIPPED (renamingFile=${renamingFile})`);
      return;
    }
    console.log(`[ps-dbg] local icon load scheduled in 500ms (files=${files.length} renamingFile=${renamingFile})`);
    const t = setTimeout(() => {
      console.log(`[ps-dbg] local icon load DEBOUNCE FIRED (renamingFile=${renamingFile})`);
      const fetchIcons = async () => {
        const paths: string[] = [];
        for (const f of files) {
          if (f.shellPath && (f.shellPath.startsWith('shell-pidl:') || f.shellPath.startsWith('shell:'))) continue;
          const fullPath = f.shellPath && /^([A-Z]:|\\\\)/i.test(f.shellPath)
            ? f.shellPath
            : (currentPath.endsWith(sep) ? currentPath + f.name : currentPath + sep + f.name);
          if (iconRequestedRef.current.has(fullPath)) continue;
          iconRequestedRef.current.add(fullPath);
          paths.push(fullPath);
        }
        if (paths.length === 0) { console.log('[ps-dbg] local icon load: no new paths, skip'); return; }
        console.log(`[ps-dbg] local icon load CALLING feGetFileIconsBatch (${paths.length} paths) hasFocus=${document.hasFocus()}`);
        const t0 = Date.now();
        try {
          const r: any = await api.feGetFileIconsBatch?.(paths);
          console.log(`[ps-dbg] local icon load RESOLVED ${Date.now() - t0}ms hasFocus=${document.hasFocus()}`);
          if (r?.icons) {
            setIconCache(prev => {
              const next = new Map(prev);
              for (const [p, url] of Object.entries(r.icons)) {
                if (url && typeof url === 'string') next.set(p, url);
              }
              return next;
            });
          }
        } catch (err) { console.log('[ps-dbg] local icon load ERR', err); }
      };
      fetchIcons();
    }, 500);
    return () => { console.log('[ps-dbg] local icon load CLEANUP (timer cancelled)'); clearTimeout(t); };
  }, [files, source.mode, currentPath, renamingFile]);

  const loadDir = useCallback(async (dir: string) => {
    if (!dir) return;
    setLoading(true);
    setError('');
    try {
      if (typeof api.feListDir !== 'function') { setError(t('apiUnavailable')); setFiles([]); setLoading(false); return; }
      const result = await api.feListDir(source.mode, dir, source.termId);
      if (result?.error) { setError(result.error); setFiles([]); }
      else { setFiles(result?.files || []); }
    } catch (e: any) { setError(String(e)); setFiles([]); }
    setLoading(false);
  }, [source.mode, source.termId]);

  useEffect(() => { loadDir(currentPath); }, [currentPath, loadDir, refreshKey]);
  useEffect(() => { setEditPath(currentPath); }, [currentPath]);

  const sep = source.mode === 'local' && navigator.platform.startsWith('Win') ? '\\' : '/';

  const navigate = (dir: string) => {
    onPathChange(dir);
  };

  const goUp = () => {
    let parent: string;
    if (source.mode === 'local' && navigator.platform.startsWith('Win')) {
      parent = currentPath.replace(/\\[^\\]*\\?$/, '') || currentPath.slice(0, 3);
    } else {
      parent = currentPath.replace(/\/[^/]*\/?$/, '') || '/';
    }
    navigate(parent);
  };

  const enterDir = (name: string) => {
    const newPath = currentPath.endsWith(sep) ? currentPath + name : currentPath + sep + name;
    navigate(newPath);
  };

  const handleDoubleClick = (file: FileInfo) => {
    if (!file.isDir) return;
    // 가상 shell 항목 (내 PC / 네트워크 등) — shellPath 직접 navigate
    if (file.shellPath) {
      navigate(file.shellPath);
      return;
    }
    enterDir(file.name);
  };

  const handleClick = (file: FileInfo, idx: number, e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selectedFiles);
      next.has(file.name) ? next.delete(file.name) : next.add(file.name);
      onSelectionChange(next);
    } else if (e.shiftKey && lastClickIdx >= 0) {
      const sorted = getSortedFiles();
      const start = Math.min(lastClickIdx, idx);
      const end = Math.max(lastClickIdx, idx);
      const next = new Set(selectedFiles);
      for (let i = start; i <= end; i++) { if (sorted[i]) next.add(sorted[i].name); }
      onSelectionChange(next);
    } else {
      onSelectionChange(new Set([file.name]));
    }
    setLastClickIdx(idx);
  };

  const getSortedFiles = useCallback(() => {
    const valid = files.filter(f => f && f.name);
    const sorted = valid.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      let cmp = 0;
      if (sortKey === 'name') cmp = (a.name || '').localeCompare(b.name || '');
      else if (sortKey === 'size') cmp = (a.size || 0) - (b.size || 0);
      else cmp = (a.mtime || 0) - (b.mtime || 0);
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [files, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
  };

  const handleContextMenu = (e: React.MouseEvent, file?: FileInfo) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, file });
  };

  // 삭제 확인 — 네이티브 confirm() 은 OS 포커스를 잃게 만들기 때문에 React 모달로 처리
  const [deleteConfirm, setDeleteConfirm] = useState<{ targets: string[] } | null>(null);
  const handleDelete = (name: string) => {
    const targets = selectedFiles.size > 1 && selectedFiles.has(name) ? [...selectedFiles] : [name];
    setDeleteConfirm({ targets });
  };
  const doDelete = async (targets: string[]) => {
    setDeleteConfirm(null);
    try {
      for (const f of targets) {
        const filePath = currentPath.endsWith(sep) ? currentPath + f : currentPath + sep + f;
        await api.feDelete?.(source.mode, filePath, source.termId);
      }
      onSelectionChange(new Set());
      loadDir(currentPath);
    } catch {}
  };

  const handleCopyToClipboard = (name: string) => {
    const targets = selectedFiles.size > 0 && selectedFiles.has(name) ? [...selectedFiles] : [name];
    setFileClipboard({
      mode: source.mode,
      termId: source.termId,
      basePath: currentPath,
      files: targets,
      operation: 'copy',
    });
  };

  const handlePaste = async () => {
    const clip = getFileClipboard();
    if (!clip || clip.files.length === 0) return;
    const srcSep = clip.mode === 'local' && navigator.platform.startsWith('Win') ? '\\' : '/';
    const dstSep = sep;
    for (const name of clip.files) {
      const srcFull = clip.basePath.endsWith(srcSep) ? clip.basePath + name : clip.basePath + srcSep + name;
      // 같은 패널+경로에 붙여넣기면 이름 변경 (X_copy)
      let dstName = name;
      if (clip.mode === source.mode && clip.termId === source.termId && clip.basePath === currentPath) {
        const dot = name.lastIndexOf('.');
        if (dot > 0) dstName = name.slice(0, dot) + '_copy' + name.slice(dot);
        else dstName = name + '_copy';
      }
      const dstFull = currentPath.endsWith(dstSep) ? currentPath + dstName : currentPath + dstSep + dstName;
      try {
        await api.feTransfer?.(
          { mode: clip.mode, termId: clip.termId, path: srcFull },
          { mode: source.mode, termId: source.termId, path: dstFull },
          dstName,
        );
      } catch {}
    }
    loadDir(currentPath);
  };

  const handleCopyPath = (name: string) => {
    const targets = selectedFiles.size > 0 && selectedFiles.has(name) ? [...selectedFiles] : [name];
    const paths = targets.map(n => currentPath.endsWith(sep) ? currentPath + n : currentPath + sep + n);
    try { navigator.clipboard.writeText(paths.join('\n')); } catch {}
  };

  const handleChmod = (name: string) => {
    const targets = selectedFiles.size > 0 && selectedFiles.has(name) ? [...selectedFiles] : [name];
    const fileMap = new Map(files.map(f => [f.name, f]));
    const paths = targets.map(n => currentPath.endsWith(sep) ? currentPath + n : currentPath + sep + n);
    const hasDir = targets.some(n => fileMap.get(n)?.isDir);
    // 첫 선택 파일의 mode 문자열(drwxr-xr-x) 을 octal 로 변환
    const first = fileMap.get(targets[0]);
    let initialMode: number | undefined;
    if (first?.mode) {
      const perm = first.mode.slice(1); // 첫 글자(d/-/l) 제외
      if (perm.length >= 9) {
        const triplet = (s: string) => (s[0] === 'r' ? 4 : 0) + (s[1] === 'w' ? 2 : 0) + (s[2] === 'x' ? 1 : 0);
        initialMode = (triplet(perm.slice(0, 3)) << 6) | (triplet(perm.slice(3, 6)) << 3) | triplet(perm.slice(6, 9));
      }
    }
    setChmodDialog({ paths, initialMode, hasDir });
  };

  // 자동 이름 생성 — base 가 없으면 base, 있으면 base (1), (2)... 의 첫 빈 자리
  const findFreshName = (base: string): { name: string; hadConflict: boolean } => {
    const existing = new Set(files.map(f => f.name));
    const hadConflict = existing.has(base);
    let name = base;
    let n = 1;
    while (existing.has(name)) {
      name = `${base} (${n})`;
      n++;
    }
    return { name, hadConflict };
  };

  // 새 파일 — 빈 파일 생성
  const handleMkfile = async () => {
    const { name, hadConflict } = findFreshName('New File');
    try {
      const filePath = currentPath.endsWith(sep) ? currentPath + name : currentPath + sep + name;
      const r = await api.feCreateFile?.(source.mode, filePath, source.termId);
      if (r && r.success === false) {
        alert(`파일 생성 실패: ${r.error}`);
        return;
      }
      // ★ 중복 케이스에서는 rename 모드를 loadDir(아이콘 PowerShell spawn 트리거) 보다 먼저 켜서
      //    아이콘 로딩 effect 의 가드가 즉시 작동하도록 — OS 포커스 강탈 차단
      if (hadConflict) {
        setRenamingFile(name);
        setRenameValue(name);
      }
      await loadDir(currentPath);
      onSelectionChange(new Set([name]));
      setTimeout(() => {
        const el = document.querySelector(`.fe-file-row[data-name="${CSS.escape(name)}"]`) as HTMLElement | null;
        el?.scrollIntoView({ block: 'nearest' });
      }, 30);
    } catch (err: any) {
      alert(`파일 생성 실패: ${err?.message || err}`);
    }
  };

  // 새 폴더 — 중복 안 되는 자동 이름으로 생성. 중복 있었으면 rename 모드 진입해서 사용자가 바꿀 수 있게.
  const handleMkdir = async () => {
    const { name, hadConflict } = findFreshName('New Folder');
    console.log(`[ps-dbg] handleMkdir START name="${name}" hadConflict=${hadConflict} hasFocus=${document.hasFocus()}`);
    try {
      const dirPath = currentPath.endsWith(sep) ? currentPath + name : currentPath + sep + name;
      const r = await api.feMkdir?.(source.mode, dirPath, source.termId);
      if (r && r.success === false) {
        alert(`폴더 생성 실패: ${r.error}`);
        return;
      }
      console.log(`[ps-dbg] handleMkdir feMkdir DONE hasFocus=${document.hasFocus()}`);
      // ★ 모달 먼저 띄움 (loadDir → 아이콘 PowerShell spawn 보다 먼저)
      if (hadConflict) {
        console.log(`[ps-dbg] handleMkdir setRenamingFile (BEFORE loadDir) hasFocus=${document.hasFocus()}`);
        setRenamingFile(name);
        setRenameValue(name);
      }
      await loadDir(currentPath);
      console.log(`[ps-dbg] handleMkdir loadDir DONE hasFocus=${document.hasFocus()}`);
      onSelectionChange(new Set([name]));
      setTimeout(() => {
        const el = document.querySelector(`.fe-file-row[data-name="${CSS.escape(name)}"]`) as HTMLElement | null;
        el?.scrollIntoView({ block: 'nearest' });
      }, 30);
    } catch (err: any) {
      alert(`폴더 생성 실패: ${err?.message || err}`);
    }
  };

  const renameInFlight = useRef(false);
  // Modal 에서 호출되는 rename 실행. oldName / newName 모두 명시적으로 받음.
  const doRename = async (oldName: string, newName: string) => {
    if (renameInFlight.current) return;
    if (!newName || newName === oldName) { setRenamingFile(null); return; }
    renameInFlight.current = true;
    try {
      const oldPath = currentPath.endsWith(sep) ? currentPath + oldName : currentPath + sep + oldName;
      const newPath = currentPath.endsWith(sep) ? currentPath + newName : currentPath + sep + newName;
      const r = await api.feRename?.(source.mode, oldPath, newPath, source.termId);
      setRenamingFile(null);
      if (r && r.success === false) {
        alert(`이름 변경 실패: ${r.error}`);
      } else {
        onSelectionChange(new Set([newName]));
      }
      loadDir(currentPath);
    } catch (err: any) {
      setRenamingFile(null);
      alert(`이름 변경 실패: ${err?.message || err}`);
    } finally {
      renameInFlight.current = false;
    }
  };

  const sortedFiles = getSortedFiles();
  const sortIcon = (key: SortKey) => sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  return (
    <div className="fe-panel">
      <div className="fe-panel-header">
        {source.mode === 'remote' && onDisconnect && (
          <button className="fe-disconnect-btn" onClick={onDisconnect} title={t('disconnect')}>✕</button>
        )}
        <select className="fe-source-select" value={`${source.mode}:${source.termId || source.sessionId || ''}`}
          onChange={e => {
            const [m, t] = [e.target.value.split(':')[0], e.target.value.split(':').slice(1).join(':')];
            const s = sources.find(s => s.mode === m && ((s.termId || s.sessionId || '') === t));
            if (s) onSourceChange(s);
          }}
        >
          {(() => {
            const localSources = sources.filter(s => s.mode === 'local');
            const connected = sources.filter(s => s.mode === 'remote');
            const lazy = sources.filter(s => s.mode === 'lazy-remote');
            const renderOpt = (s: PanelSource) => (
              <option key={`${s.mode}:${s.termId || s.sessionId || ''}`} value={`${s.mode}:${s.termId || s.sessionId || ''}`}>{s.label}</option>
            );
            return (
              <>
                {localSources.map(renderOpt)}
                {connected.length > 0 && (
                  <optgroup label={t('groupConnected')}>
                    {connected.map(renderOpt)}
                  </optgroup>
                )}
                {lazy.length > 0 && (
                  <optgroup label={t('groupNotConnected')}>
                    {lazy.map(renderOpt)}
                  </optgroup>
                )}
              </>
            );
          })()}
        </select>
      </div>
      <div className="fe-path-bar">
        <button className="fe-path-btn" onClick={goUp} title={t('parentFolder')}>⬆</button>
        <button className="fe-path-btn" onClick={() => loadDir(currentPath)} title={t('refresh')}>🔄</button>
        {source.mode === 'local' && drives.length > 0 && (
          <select
            className="fe-drive-select"
            value=""
            onChange={e => { if (e.target.value) { navigate(e.target.value); e.currentTarget.value = ''; } }}
            title="드라이브 / 네트워크 드라이브로 바로 이동"
          >
            <option value="">💾 드라이브</option>
            {drives.map(d => <option key={d.path} value={d.path}>{d.label}</option>)}
          </select>
        )}
        {editingPath ? (
          <input className="fe-path-input" value={editPath} onChange={e => setEditPath(e.target.value)}
            onBlur={() => { setEditingPath(false); navigate(editPath); }}
            onKeyDown={e => { if (e.key === 'Enter') { setEditingPath(false); navigate(editPath); } if (e.key === 'Escape') setEditingPath(false); }}
            autoFocus
          />
        ) : (
          <div className="fe-path-display" onClick={() => setEditingPath(true)}>{currentPath}</div>
        )}
      </div>
      <div className="fe-file-header">
        <span className="fe-col-name" style={{ width: colWidths.name }} onClick={() => toggleSort('name')}>{t('colName')}{sortIcon('name')}</span>
        <div className="fe-col-resize" onMouseDown={startColResize('name')} />
        <span className="fe-col-size" style={{ width: colWidths.size }} onClick={() => toggleSort('size')}>{t('colSize')}{sortIcon('size')}</span>
        <div className="fe-col-resize" onMouseDown={startColResize('size')} />
        <span className="fe-col-type" style={{ width: colWidths.type }}>유형</span>
        <div className="fe-col-resize" onMouseDown={startColResize('type')} />
        <span className="fe-col-date" style={{ width: colWidths.date }} onClick={() => toggleSort('mtime')}>{t('colDate')}{sortIcon('mtime')}</span>
        <div className="fe-col-resize" onMouseDown={startColResize('date')} />
        {source.mode === 'remote' && (<>
          <span className="fe-col-mode" style={{ width: colWidths.mode }}>특성</span>
          <div className="fe-col-resize" onMouseDown={startColResize('mode')} />
          <span className="fe-col-owner" style={{ width: colWidths.owner }}>소유자</span>
          <div className="fe-col-resize" onMouseDown={startColResize('owner')} />
        </>)}
      </div>
      <div className="fe-file-list" tabIndex={renamingFile ? -1 : 0} ref={listRef}
        onClick={e => { if (e.target === e.currentTarget && !dragJustEnded.current) onSelectionChange(new Set()); }}
        onMouseDown={e => {
          if (e.button !== 0) return;
          const target = e.target as HTMLElement;
          if (target.closest('.fe-file-row') || target.closest('.fe-rename-input')) return;
          // rename 모드 중일 땐 빈 영역 클릭이 input blur 를 일으켜 submit 되도록 — preventDefault/드래그 선택 동작 건너뜀
          if (renamingFile) return;
          if (!listRef.current) return;
          // 네이티브 텍스트 선택 방지 — 드래그가 리스트 밖(경로바/헤더 등)을 지날 때
          // 브라우저가 텍스트 셀렉션을 시작하지 않도록 차단
          e.preventDefault();
          const prevUserSelect = document.body.style.userSelect;
          document.body.style.userSelect = 'none';
          try { window.getSelection()?.removeAllRanges(); } catch {}
          const startY = e.clientY;
          let currentY = startY;
          const addToExisting = e.ctrlKey || e.metaKey;
          const baseSel = addToExisting ? new Set(selectedFiles) : new Set<string>();

          // DOM 직접 조작으로 사각형 표시 (state 업데이트 없이)
          const overlay = document.createElement('div');
          overlay.className = 'fe-drag-select';
          overlay.style.position = 'absolute';
          overlay.style.left = '0';
          overlay.style.right = '0';
          overlay.style.pointerEvents = 'none';
          overlay.style.zIndex = '5';
          listRef.current.appendChild(overlay);

          if (!addToExisting) onSelectionChange(new Set());

          // 드래그가 가시영역 위/아래 가장자리 근처에 가면 자동 스크롤 (감춰진 행도 선택 가능)
          let autoScrollTimer: ReturnType<typeof setInterval> | null = null;
          let scrollVelocity = 0; // px per tick
          // 드래그 시작 좌표를 리스트 콘텐츠 기준 절대좌표로 기록 (스크롤 변해도 anchor 유지)
          const initialScrollTop = listRef.current.scrollTop;
          const anchorY = startY - listRef.current.getBoundingClientRect().top + initialScrollTop;

          const recomputeSelection = () => {
            if (!listRef.current) return;
            const rect = listRef.current.getBoundingClientRect();
            const curContentY = currentY - rect.top + listRef.current.scrollTop;
            const top = Math.min(anchorY, curContentY);
            const height = Math.abs(curContentY - anchorY);
            overlay.style.top = top + 'px';
            overlay.style.height = height + 'px';
            const rows = listRef.current.querySelectorAll('.fe-file-row');
            const sel = new Set(baseSel);
            const minContent = Math.min(anchorY, curContentY);
            const maxContent = Math.max(anchorY, curContentY);
            // 컨테이너 기준 좌표 → 컨텐츠 좌표는 row.offsetTop / offsetHeight 사용
            rows.forEach(row => {
              const el = row as HTMLElement;
              const rTop = el.offsetTop;
              const rBot = rTop + el.offsetHeight;
              if (rBot >= minContent && rTop <= maxContent) {
                const name = el.getAttribute('data-name');
                if (name) sel.add(name);
              }
            });
            onSelectionChange(sel);
          };

          const onMove = (ev: MouseEvent) => {
            // 드래그 도중 발생할 수 있는 네이티브 텍스트 셀렉션 제거
            try {
              const sel = window.getSelection();
              if (sel && sel.rangeCount > 0) sel.removeAllRanges();
            } catch {}
            currentY = ev.clientY;
            const rect = listRef.current!.getBoundingClientRect();
            // 가시영역 가장자리 근처(40px 이내) 면 그 거리에 비례해 스크롤 속도 설정
            const edgeZone = 40;
            const distTop = currentY - rect.top;
            const distBottom = rect.bottom - currentY;
            if (distTop < edgeZone && distTop < distBottom) {
              // 위쪽 — 음수 속도 (스크롤 업)
              scrollVelocity = -Math.max(2, Math.round((edgeZone - distTop) / 3));
            } else if (distBottom < edgeZone) {
              scrollVelocity = Math.max(2, Math.round((edgeZone - distBottom) / 3));
            } else {
              scrollVelocity = 0;
            }
            if (scrollVelocity !== 0 && !autoScrollTimer) {
              autoScrollTimer = setInterval(() => {
                if (!listRef.current) return;
                const before = listRef.current.scrollTop;
                listRef.current.scrollTop += scrollVelocity;
                if (listRef.current.scrollTop !== before) recomputeSelection();
              }, 20);
            } else if (scrollVelocity === 0 && autoScrollTimer) {
              clearInterval(autoScrollTimer);
              autoScrollTimer = null;
            }
            // 매 move 마다 throttle 후 selection 재계산
            if (!(overlay as any).__raf) {
              (overlay as any).__raf = requestAnimationFrame(() => {
                recomputeSelection();
                (overlay as any).__raf = null;
              });
            }
          };
          const onUp = () => {
            if (autoScrollTimer) { clearInterval(autoScrollTimer); autoScrollTimer = null; }
            overlay.remove();
            document.body.style.userSelect = prevUserSelect;
            try { window.getSelection()?.removeAllRanges(); } catch {}
            dragJustEnded.current = true;
            setTimeout(() => { dragJustEnded.current = false; }, 100);
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
          };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        }}
        onKeyDown={e => {
          // rename 모드 중이면 파일 리스트의 키 핸들러(Delete / F2 / prefix 점프 등)가
          // input 타이핑을 가로채지 않도록 무조건 bail-out
          if (renamingFile) return;
          // input/textarea/contenteditable 안에서 발생한 키도 무시
          const t = e.target as HTMLElement;
          if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
          if (e.key === 'Delete' && selectedFiles.size > 0) {
            e.preventDefault();
            handleDelete([...selectedFiles][0]);
          }
          if (e.key === 'F2' && selectedFiles.size > 0) {
            e.preventDefault();
            const sorted = getSortedFiles();
            const first = sorted.find(f => selectedFiles.has(f.name));
            if (first) { setRenamingFile(first.name); setRenameValue(first.name); }
          }
          // prefix 키 점프 — 단일 키 누르면 해당 문자로 시작하는 첫 파일 선택, 같은 키 반복 시 순환
          if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
            const sorted = getSortedFiles();
            const ch = e.key.toLowerCase();
            // 현재 선택된 파일 다음부터 찾기 (같은 키 반복 시 순환)
            const curIdx = sorted.findIndex(f => selectedFiles.has(f.name));
            let target = -1;
            for (let i = 1; i <= sorted.length; i++) {
              const idx = (curIdx + i) % sorted.length;
              if (sorted[idx].name.toLowerCase().startsWith(ch)) { target = idx; break; }
            }
            if (target >= 0) {
              e.preventDefault();
              onSelectionChange(new Set([sorted[target].name]));
              try { vlistRef.current?.scrollToItem(target, 'smart'); } catch {}
            }
          }
        }}
        onContextMenu={e => handleContextMenu(e)}
        onDragOver={e => { if (e.dataTransfer.types.includes('text/fe-files')) { e.preventDefault(); e.currentTarget.classList.add('fe-drop-target'); } }}
        onDragLeave={e => { e.currentTarget.classList.remove('fe-drop-target'); }}
        onDrop={e => {
          e.currentTarget.classList.remove('fe-drop-target');
          const raw = e.dataTransfer.getData('text/fe-files');
          if (!raw) return;
          e.preventDefault();
          try {
            const data = JSON.parse(raw);
            if (data.panelId !== panelId) onFileDrop?.(data.files, data.srcMode, data.srcTermId, data.srcPath);
          } catch {}
        }}
      >
        {loading && <div className="fe-loading">{t('loading')}</div>}
        {error && <div className="fe-error">{error}</div>}
        {!loading && !error && sortedFiles.map((file, idx) => (
          <div key={file.name} data-name={file.name}
            className={`fe-file-row ${selectedFiles.has(file.name) ? 'selected' : ''}`}
            onClick={e => handleClick(file, idx, e)}
            onDoubleClick={() => handleDoubleClick(file)}
            onContextMenu={e => { e.stopPropagation(); handleContextMenu(e, file); }}
            draggable={renamingFile !== file.name}
            onDragStart={e => {
              if (renamingFile === file.name) { e.preventDefault(); return; }
              const filesToDrag = selectedFiles.has(file.name) ? [...selectedFiles] : [file.name];
              e.dataTransfer.setData('text/fe-files', JSON.stringify({
                panelId, files: filesToDrag, srcMode: source.mode, srcTermId: source.termId, srcPath: currentPath,
              }));
              e.dataTransfer.effectAllowed = 'copy';
            }}
          >
            <span className="fe-col-name" style={{ width: colWidths.name }}>
              <span className="fe-file-icon">{(() => {
                if (source.mode === 'local') {
                  const fullPath = file.shellPath && /^([A-Z]:|\\\\)/i.test(file.shellPath)
                    ? file.shellPath
                    : (currentPath.endsWith(sep) ? currentPath + file.name : currentPath + sep + file.name);
                  const url = iconCache.get(fullPath);
                  if (url) return <img src={url} className="fe-file-icon-img" alt="" draggable={false} />;
                } else if (source.mode === 'remote') {
                  // 확장자 기반 아이콘 (원격 SFTP)
                  if (file.isDir) {
                    const dirUrl = extIconCache.get('dir:');
                    if (dirUrl) return <img src={dirUrl} className="fe-file-icon-img" alt="" draggable={false} />;
                  } else {
                    const idx = file.name.lastIndexOf('.');
                    const ext = idx > 0 ? file.name.slice(idx + 1).toLowerCase() : '';
                    const url = ext ? extIconCache.get('file:' + ext) : '';
                    if (url) return <img src={url} className="fe-file-icon-img" alt="" draggable={false} />;
                  }
                }
                return getFileIcon(file.name, file.isDir, file.shellPath);
              })()}</span>
              <span className="fe-file-name">{file.name}</span>
            </span>
            <div className="fe-col-resize" />
            <span className="fe-col-size" style={{ width: colWidths.size }}>{file.isDir ? '' : formatSize(file.size)}</span>
            <div className="fe-col-resize" />
            <span className="fe-col-type" style={{ width: colWidths.type }}>{getFileTypeLabel(file.name, file.isDir)}</span>
            <div className="fe-col-resize" />
            <span className="fe-col-date" style={{ width: colWidths.date }}>{formatDate(file.mtime)}</span>
            <div className="fe-col-resize" />
            {source.mode === 'remote' && (<>
              <span className="fe-col-mode" style={{ width: colWidths.mode }}>{file.mode || ''}</span>
              <div className="fe-col-resize" />
              <span className="fe-col-owner" style={{ width: colWidths.owner }}>{file.owner || ''}</span>
              <div className="fe-col-resize" />
            </>)}
          </div>
        ))}
        <div className="fe-file-padding"
          draggable={selectedFiles.size > 0}
          onDragStart={e => {
            if (selectedFiles.size === 0) return;
            e.dataTransfer.setData('text/fe-files', JSON.stringify({
              panelId, files: [...selectedFiles], srcMode: source.mode, srcTermId: source.termId, srcPath: currentPath,
            }));
            e.dataTransfer.effectAllowed = 'copy';
          }}
        />
      </div>
      <div className="fe-status-bar">
        {t('statusSummary', { total: files.length, selected: selectedFiles.size })}
      </div>

      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={() => setContextMenu(null)} items={[
          ...(contextMenu.file ? [
            { label: '복사', onClick: () => handleCopyToClipboard(contextMenu.file!.name) },
            { label: '붙여넣기', onClick: handlePaste, disabled: !getFileClipboard() },
            { label: '경로 복사', onClick: () => handleCopyPath(contextMenu.file!.name) },
            { separator: true } as const,
            { label: t('rename'), onClick: () => { setRenamingFile(contextMenu.file!.name); setRenameValue(contextMenu.file!.name); } },
            { label: t('deleteFile'), onClick: () => handleDelete(contextMenu.file!.name) },
            ...(source.mode === 'remote' ? [
              { separator: true } as const,
              { label: '권한 변경...', onClick: () => handleChmod(contextMenu.file!.name) },
            ] : []),
            { separator: true } as const,
          ] : [
            { label: '붙여넣기', onClick: handlePaste, disabled: !getFileClipboard() },
            { separator: true } as const,
          ]),
          { label: '새로 만들기', submenu: [
            { label: t('newFolder'), onClick: handleMkdir },
            { label: '새 파일', onClick: handleMkfile },
          ]},
          { label: t('refresh'), onClick: () => loadDir(currentPath) },
        ]} />
      )}
      {chmodDialog && (
        <ChmodDialog
          mode={source.mode}
          termId={source.termId}
          paths={chmodDialog.paths}
          initialMode={chmodDialog.initialMode}
          hasDir={chmodDialog.hasDir}
          onClose={() => setChmodDialog(null)}
          onApplied={() => loadDir(currentPath)}
        />
      )}
      {renamingFile && (() => {
        const target = files.find(f => f.name === renamingFile);
        return (
          <RenameDialog
            initialName={renamingFile}
            isDir={!!target?.isDir}
            onConfirm={(newName) => doRename(renamingFile, newName)}
            onCancel={() => setRenamingFile(null)}
          />
        );
      })()}
      {deleteConfirm && createPortal(
        <div className="rn-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setDeleteConfirm(null); }}>
          <div className="rn-dialog" onMouseDown={e => e.stopPropagation()}>
            <div className="rn-title">삭제 확인</div>
            <div className="rn-body" style={{ maxWidth: 480 }}>
              <div style={{ fontSize: 12, lineHeight: '1.5em' }}>
                <b>{deleteConfirm.targets.length}개</b> 항목을 삭제하시겠습니까?
              </div>
              <div style={{ fontSize: 11, color: '#aaa', maxHeight: 120, overflowY: 'auto', wordBreak: 'break-all' }}>
                {deleteConfirm.targets.join(', ')}
              </div>
            </div>
            <div className="rn-actions">
              <button className="rn-btn rn-btn-primary"
                ref={el => { if (el) setTimeout(() => el.focus(), 0); }}
                onClick={() => doDelete(deleteConfirm.targets)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); doDelete(deleteConfirm.targets); } else if (e.key === 'Escape') { e.preventDefault(); setDeleteConfirm(null); } }}
              >삭제</button>
              <button className="rn-btn" onClick={() => setDeleteConfirm(null)}>취소</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
};
