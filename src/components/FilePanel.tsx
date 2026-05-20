// src/components/FilePanel.tsx
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { ContextMenu } from './ContextMenu';
import { ChmodDialog } from './ChmodDialog';

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

export type FileInfo = {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
  // 가상 shell 항목 (내 PC, 네트워크, .lnk 단축 등) — 클릭 시 이 경로로 navigate
  shellPath?: string;
  // shell-pidl 가상 폴더 안의 실제 파일시스템 경로 — 삭제/이름변경/복사 등 fs 연산에 사용
  realPath?: string;
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
  if (lower === '제어판' || lower.includes('controlpanel') || lower.includes('control panel')) return '⚙';
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
  // 내장 저장공간 / SD 카드 — MTP device 내부의 storage
  if (lower === '내장 저장공간' || lower === 'internal storage' || lower === '내부 저장공간') return '💾';
  if (lower === 'sd 카드' || lower === 'sd card' || lower.includes('sdcard') || lower.includes('external sd')) return '💾';
  // MTP / 휴대 디바이스 — device 루트만 (chain 자식은 일반 폴더로)
  const isShellChain = !!shellPath && shellPath.includes('||');
  if (!isShellChain) {
    if (shellPath && /usb#|mtp|samsung_android|portable|wpdbusenum/i.test(shellPath)) return '📱';
    if (/^(galaxy|iphone|ipad|pixel|note\s*\d+|s\d{1,2}\+|s\d{1,2}\s)/i.test(lower)) return '📱';
  }
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
  // shell: 경로의 친화적 라벨 ↔ 실제 경로 매핑 — path bar 표시/편집에 공통 사용
  const shellLabelMap: Record<string, string> = {
    'shell:MyComputerFolder': '내 PC',
    'shell:Desktop': '바탕 화면',
    'shell:NetworkPlacesFolder': '네트워크',
    'shell:Downloads': '다운로드',
    'shell:Personal': '문서',
    'shell:My Documents': '문서',
    'shell:My Pictures': '사진',
    'shell:My Music': '음악',
    'shell:My Video': '동영상',
    'shell:RecycleBinFolder': '휴지통',
    '::{20D04FE0-3AEA-1069-A2D8-08002B30309D}': '내 PC',
    '::{F02C1A0D-BE21-4350-88B0-7367FC96EF3C}': '네트워크',
    '::{645FF040-5081-101B-9F08-00AA002F954E}': '휴지통',
  };
  const friendlyShellLabel = (p: string): string | null => shellLabelMap[p] || null;
  // 라벨 → 실제 path. 친화적 라벨을 입력했을 때 shell: 경로로 변환.
  // 우선순위: shell: 경로 (위 매핑) 가 우선, 그다음 일반 경로 입력은 그대로 navigate.
  const resolveShellLabel = (label: string): string | null => {
    const trimmed = label.trim();
    for (const [shellPath, name] of Object.entries(shellLabelMap)) {
      if (name === trimmed) return shellPath;
    }
    return null;
  };
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
  const [drives, setDrives] = useState<{ path: string; label: string; depth?: number }[]>([]);
  // 로컬 파일 아이콘 캐시 (path → dataUrl) — Electron 의 app.getFileIcon 으로 lazy 로딩
  const [iconCache, setIconCache] = useState<Map<string, string>>(new Map());
  const iconRequestedRef = useRef<Set<string>>(new Set());
  // 확장자 → 아이콘 캐시 (원격 SFTP 파일용 — 로컬에 파일 없어도 확장자만으로 Windows 아이콘 추출)
  const [extIconCache, setExtIconCache] = useState<Map<string, string>>(new Map());
  const extRequestedRef = useRef<Set<string>>(new Set());
  // 드라이브 / 특수 폴더 목록 — source 모드와 무관하게 항상 로드해서 source 드롭다운에 항상 노출
  useEffect(() => {
    (async () => {
      try {
        const list: any = await api.feGetDrives?.();
        if (Array.isArray(list)) {
          const norm = list.map((x: any) => typeof x === 'string' ? { path: x, label: x } : x).filter((x: any) => x && x.path);
          setDrives(norm);
        }
      } catch {}
    })();
  }, []);
  const [renameValue, setRenameValue] = useState('');
  const [lastClickIdx, setLastClickIdx] = useState(-1);
  const listRef = useRef<HTMLDivElement | null>(null);
  const dragJustEnded = useRef(false);

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

  // 확장자 기반 Windows shell 아이콘 lazy 로딩
  // - 원격 SFTP: 모든 파일에 대해 사용 (path-specific 아이콘 없음)
  // - 로컬: path-specific 로딩 전 깜빡임 방지용 fallback (dir 아이콘 + ext 아이콘)
  // ★ 500ms debounce — PowerShell spawn 과 modal 타이밍 충돌 방지
  useEffect(() => {
    if (source.mode !== 'remote' && source.mode !== 'local') return;
    if (!files || files.length === 0) return;
    if (renamingFile) return;
    // ext-icon 은 path-specific 보다 우선 로드 (fallback 용도) — 짧은 debounce
    const t = setTimeout(() => {
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
    }, 100);
    return () => clearTimeout(t);
  }, [files, source.mode, renamingFile]);

  // 로컬 모드에서 파일 목록 변경 시 shell icon 을 BATCH 로 요청.
  // ★ 500ms debounce — 빠른 연속 파일 작업(create/rename 등) 으로 PowerShell spawn 이
  //   modal 열림 타이밍과 겹쳐 OS 포커스를 빼앗는 문제 방지
  useEffect(() => {
    if (source.mode !== 'local') return;
    if (!files || files.length === 0) return;
    if (renamingFile) return;
    const t = setTimeout(() => {
      const fetchIcons = async () => {
        const paths: string[] = [];
        const shellPaths: string[] = []; // 가상 shell: 경로 — 개별 요청 (Win32 SHGetFileInfo+PIDL)
        for (const f of files) {
          if (f.shellPath && (f.shellPath.startsWith('shell-pidl:') || f.shellPath.startsWith('shell:') || f.shellPath.startsWith('::{'))) {
            const key = f.shellPath;
            if (iconRequestedRef.current.has(key)) continue;
            iconRequestedRef.current.add(key);
            shellPaths.push(key);
            continue;
          }
          const fullPath = f.shellPath && /^([A-Z]:|\\\\)/i.test(f.shellPath)
            ? f.shellPath
            : (currentPath.endsWith(sep) ? currentPath + f.name : currentPath + sep + f.name);
          if (iconRequestedRef.current.has(fullPath)) continue;
          iconRequestedRef.current.add(fullPath);
          paths.push(fullPath);
        }
        // 일반 파일 — batch
        if (paths.length > 0) {
          try {
            const r: any = await api.feGetFileIconsBatch?.(paths);
            if (r?.icons) {
              setIconCache(prev => {
                const next = new Map(prev);
                for (const [p, url] of Object.entries(r.icons)) {
                  if (url && typeof url === 'string') next.set(p, url);
                }
                return next;
              });
            }
          } catch {}
        }
        // shell: 가상 폴더 — 개별 호출
        if (shellPaths.length > 0) {
          const results: Array<[string, string]> = [];
          for (const sp of shellPaths) {
            try {
              const r: any = await api.feGetFileIcon?.(sp);
              if (r?.dataUrl) results.push([sp, r.dataUrl]);
            } catch {}
          }
          if (results.length > 0) {
            setIconCache(prev => {
              const next = new Map(prev);
              for (const [p, url] of results) next.set(p, url);
              return next;
            });
          }
        }
      };
      fetchIcons();
    }, 500);
    return () => clearTimeout(t);
  }, [files, source.mode, currentPath, renamingFile]);

  // 파일명 인코딩 — SSH/SFTP 원격 파일명 디코딩에 사용. localStorage 영속화.
  // (loadDir 보다 먼저 선언되어야 함 — useCallback 이 dep 로 사용)
  const [encoding, setEncoding] = useState<string>(() => {
    try { return localStorage.getItem(`feEncoding:${panelId}`) || 'utf-8'; } catch { return 'utf-8'; }
  });
  useEffect(() => {
    try { localStorage.setItem(`feEncoding:${panelId}`, encoding); } catch {}
  }, [encoding, panelId]);
  const [encodingMenu, setEncodingMenu] = useState<{ x: number; y: number } | null>(null);

  const loadDir = useCallback(async (dir: string) => {
    if (!dir) return;
    setLoading(true);
    setError('');
    try {
      if (typeof api.feListDir !== 'function') { setError(t('apiUnavailable')); setFiles([]); setLoading(false); return; }
      const result = await api.feListDir(source.mode, dir, source.termId, encoding);
      if (result?.error) { setError(result.error); setFiles([]); }
      else { setFiles(result?.files || []); }
    } catch (e: any) { setError(String(e)); setFiles([]); }
    setLoading(false);
  }, [source.mode, source.termId, encoding]);

  useEffect(() => { loadDir(currentPath); }, [currentPath, loadDir, refreshKey]);
  useEffect(() => { setEditPath(friendlyShellLabel(currentPath) || currentPath); }, [currentPath]);

  const sep = source.mode === 'local' && navigator.platform.startsWith('Win') ? '\\' : '/';

  // 경로 history (이전/다음 폴더) — source 별로 독립
  const historyRef = useRef<string[]>([currentPath]);
  const historyIdxRef = useRef<number>(0);
  const skipHistoryRef = useRef<boolean>(false);
  const [, forceHistoryTick] = useState(0);
  // source 변경 시 history 리셋
  useEffect(() => {
    historyRef.current = [currentPath];
    historyIdxRef.current = 0;
    forceHistoryTick(t => t + 1);
    // source.mode / termId / sessionId 가 바뀐 경우만 (currentPath 는 navigate 별 추적)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.mode, source.termId, source.sessionId]);
  // currentPath 가 외부에서 바뀐 경우 (handleClick / enterDir 등) history 에 push
  useEffect(() => {
    if (skipHistoryRef.current) { skipHistoryRef.current = false; return; }
    const hist = historyRef.current;
    const idx = historyIdxRef.current;
    if (hist[idx] === currentPath) return; // 같은 경로면 skip
    // 현재 idx 이후 항목 잘라내고 새 경로 push
    hist.splice(idx + 1);
    hist.push(currentPath);
    // 너무 길어지면 최대 50 까지 유지
    if (hist.length > 50) hist.splice(0, hist.length - 50);
    historyIdxRef.current = hist.length - 1;
    forceHistoryTick(t => t + 1);
  }, [currentPath]);

  const navigate = (dir: string) => {
    onPathChange(dir);
  };

  const canGoBack = historyIdxRef.current > 0;
  const canGoForward = historyIdxRef.current < historyRef.current.length - 1;
  const goBack = () => {
    if (!canGoBack) return;
    historyIdxRef.current--;
    skipHistoryRef.current = true;
    onPathChange(historyRef.current[historyIdxRef.current]);
    forceHistoryTick(t => t + 1);
  };
  const goForward = () => {
    if (!canGoForward) return;
    historyIdxRef.current++;
    skipHistoryRef.current = true;
    onPathChange(historyRef.current[historyIdxRef.current]);
    forceHistoryTick(t => t + 1);
  };
  const jumpToHistory = (idx: number) => {
    if (idx < 0 || idx >= historyRef.current.length) return;
    historyIdxRef.current = idx;
    skipHistoryRef.current = true;
    onPathChange(historyRef.current[idx]);
    forceHistoryTick(t => t + 1);
  };
  const [historyMenu, setHistoryMenu] = useState<{ x: number; y: number; direction: 'back' | 'forward' } | null>(null);

  const goUp = () => {
    let parent: string;
    // shell-pidl: 체인 경로는 '||' 기준으로 한 단계 위로
    if (currentPath.startsWith('shell-pidl:')) {
      const idx = currentPath.lastIndexOf('||');
      if (idx >= 0) {
        // 체인 단계 하나 제거
        parent = currentPath.slice(0, idx);
      } else {
        // 디바이스 루트 → 내 PC 로
        parent = 'shell:MyComputerFolder';
      }
    } else if (currentPath === 'shell:MyComputerFolder') {
      // 내 PC 위 → 바탕 화면
      parent = 'shell:Desktop';
    } else if (currentPath.startsWith('shell:')) {
      // 다른 특수 폴더는 바탕 화면 으로
      parent = 'shell:Desktop';
    } else if (source.mode === 'local' && navigator.platform.startsWith('Win')) {
      // 드라이브 루트 (C:\ 등) 에서 더 위로 → 내 PC
      const isDriveRoot = /^[A-Za-z]:[\\/]?$/.test(currentPath);
      // UNC 공유 루트 (\\server\share 또는 \\server\share\) 도 내 PC 로
      const isUncShareRoot = /^\\\\[^\\]+\\[^\\]+[\\/]?$/.test(currentPath);
      // UNC 서버 (\\server\ 또는 \\server) 도 내 PC 로
      const isUncServer = /^\\\\[^\\]+[\\/]?$/.test(currentPath);
      // 바탕 화면 산하 특수 폴더 (홈, 다운로드, 문서, 사진, 음악, 동영상) 에서는 바탕 화면 으로
      const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();
      const isDesktopChild = drives.some(d =>
        (d.depth ?? 0) === 1 &&
        d.path && !d.path.startsWith('shell:') && !d.path.startsWith('shell-pidl:') &&
        norm(d.path) === norm(currentPath)
      );
      if (isDesktopChild) {
        parent = 'shell:Desktop';
      } else if (isDriveRoot || isUncShareRoot || isUncServer) {
        parent = 'shell:MyComputerFolder';
      } else {
        parent = currentPath.replace(/\\[^\\]*\\?$/, '') || currentPath.slice(0, 3);
      }
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

  // 선택 키 — 동명 객체 (shell library aggregator 등) 구분 위해 realPath/shellPath 우선
  const fileKey = (f: FileInfo): string => f.realPath || f.shellPath || f.name;

  const handleClick = (file: FileInfo, idx: number, e: React.MouseEvent) => {
    // 행 클릭 시 file list 에 포커스 부여 — Delete/F2 등 키보드 단축키 동작 보장
    if (listRef.current && document.activeElement !== listRef.current) {
      try { listRef.current.focus({ preventScroll: true }); } catch {}
    }
    const key = fileKey(file);
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selectedFiles);
      next.has(key) ? next.delete(key) : next.add(key);
      onSelectionChange(next);
    } else if (e.shiftKey && lastClickIdx >= 0) {
      const sorted = getSortedFiles();
      const start = Math.min(lastClickIdx, idx);
      const end = Math.max(lastClickIdx, idx);
      const next = new Set(selectedFiles);
      for (let i = start; i <= end; i++) { if (sorted[i]) next.add(fileKey(sorted[i])); }
      onSelectionChange(next);
    } else {
      onSelectionChange(new Set([key]));
    }
    setLastClickIdx(idx);
  };

  const getSortedFiles = useCallback(() => {
    const valid = files.filter(f => f && f.name);
    // dedupe — shell:Desktop 등 aggregator 폴더에서 같은 realPath/.lnk 가 OneDrive Desktop / Public Desktop 등 여러 소스에서 중복 열거됨.
    // fileKey 기준 첫 항목만 유지 (React duplicate key warning 방지).
    const seen = new Set<string>();
    const deduped: typeof valid = [];
    for (const f of valid) {
      const k = f.realPath || f.shellPath || f.name;
      if (seen.has(k)) continue;
      seen.add(k);
      deduped.push(f);
    }
    const sorted = deduped.sort((a, b) => {
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

  // 에러 알림 — 네이티브 alert() 은 OS 포커스를 잃게 만들기 때문에 React 모달로 처리
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // 삭제 확인 — 네이티브 confirm() 은 OS 포커스를 잃게 만들기 때문에 React 모달로 처리
  const [deleteConfirm, setDeleteConfirm] = useState<{ targets: string[] } | null>(null);
  // targets 는 fileKey 들의 배열
  const handleDelete = (key: string) => {
    const targets = selectedFiles.size > 1 && selectedFiles.has(key) ? [...selectedFiles] : [key];
    setDeleteConfirm({ targets });
  };
  const doDelete = async (targets: string[]) => {
    setDeleteConfirm(null);
    try {
      const keyMap = new Map(files.map(f => [fileKey(f), f]));
      for (const k of targets) {
        const info = keyMap.get(k);
        const name = info?.name || k;
        const filePath = info?.realPath
          ? info.realPath
          : (currentPath.endsWith(sep) ? currentPath + name : currentPath + sep + name);
        await api.feDelete?.(source.mode, filePath, source.termId);
      }
      onSelectionChange(new Set());
      loadDir(currentPath);
    } catch {}
  };

  const handleCopyToClipboard = (key: string) => {
    const targetKeys = selectedFiles.size > 0 && selectedFiles.has(key) ? [...selectedFiles] : [key];
    const keyMap = new Map(files.map(f => [fileKey(f), f]));
    const targetNames = targetKeys.map(k => keyMap.get(k)?.name).filter(Boolean) as string[];
    setFileClipboard({
      mode: source.mode,
      termId: source.termId,
      basePath: currentPath,
      files: targetNames,
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

  const handleCopyPath = (key: string) => {
    const targetKeys = selectedFiles.size > 0 && selectedFiles.has(key) ? [...selectedFiles] : [key];
    const keyMap = new Map(files.map(f => [fileKey(f), f]));
    const paths = targetKeys.map(k => {
      const info = keyMap.get(k);
      if (info?.realPath) return info.realPath;
      const name = info?.name || k;
      return currentPath.endsWith(sep) ? currentPath + name : currentPath + sep + name;
    });
    try { navigator.clipboard.writeText(paths.join('\n')); } catch {}
  };

  const handleChmod = (key: string) => {
    const targetKeys = selectedFiles.size > 0 && selectedFiles.has(key) ? [...selectedFiles] : [key];
    const keyMap = new Map(files.map(f => [fileKey(f), f]));
    const targets = targetKeys.map(k => keyMap.get(k)?.name).filter(Boolean) as string[];
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
        setErrorMessage(`파일 생성 실패: ${r.error}`);
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
      setErrorMessage(`파일 생성 실패: ${err?.message || err}`);
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
        setErrorMessage(`폴더 생성 실패: ${r.error}`);
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
      setErrorMessage(`폴더 생성 실패: ${err?.message || err}`);
    }
  };

  const renameInFlight = useRef(false);
  // Modal 에서 호출되는 rename 실행. oldName / newName 모두 명시적으로 받음.
  const doRename = async (oldName: string, newName: string) => {
    if (renameInFlight.current) return;
    if (!newName || newName === oldName) { setRenamingFile(null); return; }
    renameInFlight.current = true;
    try {
      // shell-pidl 가상 폴더 안의 실제 파일은 realPath 사용
      const fileInfo = files.find(f => f.name === oldName);
      const oldPath = fileInfo?.realPath
        ? fileInfo.realPath
        : (currentPath.endsWith(sep) ? currentPath + oldName : currentPath + sep + oldName);
      // newPath: oldPath 의 디렉토리 + newName
      const baseSep = oldPath.includes('\\') ? '\\' : '/';
      const lastSepIdx = oldPath.lastIndexOf(baseSep);
      const newPath = lastSepIdx >= 0
        ? oldPath.slice(0, lastSepIdx + 1) + newName
        : newName;
      const r = await api.feRename?.(source.mode, oldPath, newPath, source.termId);
      setRenamingFile(null);
      if (r && r.success === false) {
        setErrorMessage(`이름 변경 실패: ${r.error}`);
      } else {
        onSelectionChange(new Set([newName]));
      }
      loadDir(currentPath);
    } catch (err: any) {
      setRenamingFile(null);
      setErrorMessage(`이름 변경 실패: ${err?.message || err}`);
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
        <select className="fe-source-select"
          value={(() => {
            // 로컬 모드이고 현재 경로가 드라이브 중 하나와 일치하면 그 드라이브 선택 상태로 표시
            if (source.mode === 'local') {
              const match = drives.find(d => d.path === currentPath || d.path.replace(/[\\/]$/, '') === currentPath.replace(/[\\/]$/, ''));
              if (match) return `local-drive:${match.path}`;
            }
            return `${source.mode}:${source.termId || source.sessionId || ''}`;
          })()}
          onChange={e => {
            const v = e.target.value;
            // 로컬 드라이브/특수 폴더 선택 — 'local-drive:<path>' 형식
            if (v.startsWith('local-drive:')) {
              const drivePath = v.slice('local-drive:'.length);
              const localSrc = sources.find(s => s.mode === 'local');
              if (localSrc && source.mode !== 'local') {
                onSourceChange(localSrc);
                setTimeout(() => navigate(drivePath), 0);
              } else {
                navigate(drivePath);
              }
              return;
            }
            const [m, t] = [v.split(':')[0], v.split(':').slice(1).join(':')];
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
                {/* 로컬 드라이브/특수 폴더 — depth 기반 트리 들여쓰기 */}
                {drives.map(d => {
                  const depth = (d.depth ?? 0) + 1; // 로컬 아래로 한 단계 더 들여씀
                  const indent = '    '.repeat(depth);
                  return (
                    <option key={`local-drive:${d.path}`} value={`local-drive:${d.path}`}>
                      {indent + d.label}
                    </option>
                  );
                })}
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
        {/* 이전 폴더 (history back) + 드롭다운 */}
        <div className="fe-nav-group">
          <button className="fe-path-btn fe-nav-btn" onClick={goBack} disabled={!canGoBack} title="이전 폴더">←</button>
          <button className="fe-path-btn fe-nav-dropdown" disabled={!canGoBack} title="이전 폴더 기록"
            onClick={e => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setHistoryMenu({ x: r.left, y: r.bottom, direction: 'back' }); }}
          >▾</button>
        </div>
        {/* 다음 폴더 (history forward) + 드롭다운 */}
        <div className="fe-nav-group">
          <button className="fe-path-btn fe-nav-btn" onClick={goForward} disabled={!canGoForward} title="다음 폴더">→</button>
          <button className="fe-path-btn fe-nav-dropdown" disabled={!canGoForward} title="다음 폴더 기록"
            onClick={e => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setHistoryMenu({ x: r.left, y: r.bottom, direction: 'forward' }); }}
          >▾</button>
        </div>
        <button className="fe-path-btn" onClick={goUp} title={t('parentFolder')}>⬆</button>
        <button className="fe-path-btn" onClick={() => loadDir(currentPath)} title={t('refresh')}>🔄</button>
        {editingPath ? (
          <input className="fe-path-input" value={editPath} onChange={e => setEditPath(e.target.value)}
            onBlur={() => { setEditingPath(false); const resolved = resolveShellLabel(editPath); navigate(resolved || editPath); }}
            onKeyDown={e => { if (e.key === 'Enter') { setEditingPath(false); const resolved = resolveShellLabel(editPath); navigate(resolved || editPath); } if (e.key === 'Escape') setEditingPath(false); }}
            autoFocus
          />
        ) : (
          <div className="fe-path-display" onClick={() => { const friendly = friendlyShellLabel(currentPath); setEditPath(friendly || currentPath); setEditingPath(true); }} title={currentPath}>
            {(() => {
              // shell: / shell-pidl: 경로는 친화적으로 표시 — 디바이스/특수 폴더 라벨 + 체인 이름들
              const specialLabel = (p: string): string | null => {
                if (p === 'shell:MyComputerFolder') return '내 PC';
                if (p === 'shell:Desktop') return '바탕 화면';
                if (p === 'shell:NetworkPlacesFolder') return '네트워크';
                if (p === 'shell:Downloads') return '다운로드';
                if (p === 'shell:Personal' || p === 'shell:My Documents') return '문서';
                if (p === 'shell:My Pictures') return '사진';
                if (p === 'shell:My Music') return '음악';
                if (p === 'shell:My Video') return '동영상';
                if (p === 'shell:RecycleBinFolder') return '휴지통';
                // 알려진 shell CLSID 직접 매칭 (Desktop 가상 항목이 raw CLSID 경로로 들어오는 경우)
                if (p === '::{20D04FE0-3AEA-1069-A2D8-08002B30309D}') return '내 PC';
                if (p === '::{F02C1A0D-BE21-4350-88B0-7367FC96EF3C}') return '네트워크';
                if (p === '::{645FF040-5081-101B-9F08-00AA002F954E}') return '휴지통';
                return null;
              };
              if (currentPath.startsWith('shell-pidl:')) {
                const body = currentPath.slice('shell-pidl:'.length);
                const segs = body.split('||');
                const rootPath = segs[0];
                const chain = segs.slice(1);
                const fullRoot = `shell-pidl:${rootPath}`;
                const matchedDrive = drives.find(d => d.path === fullRoot);
                let rootLabel = matchedDrive
                  ? matchedDrive.label.replace(/^[^A-Za-z0-9가-힣]+\s*/, '')
                  : (specialLabel(rootPath) || (rootPath.startsWith('shell:') ? rootPath.slice(6) : rootPath));
                return [rootLabel, ...chain].join(' › ');
              }
              if (currentPath.startsWith('shell:')) {
                return specialLabel(currentPath) || currentPath.slice(6);
              }
              return currentPath;
            })()}
          </div>
        )}
        {/* 우측 — 인코딩 / 상위 폴더 / 새로고침 */}
        <button className="fe-path-btn fe-path-btn-right" title={`파일명 인코딩: ${encoding}`}
          onClick={e => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setEncodingMenu({ x: r.left, y: r.bottom }); }}
        >🌐</button>
        <button className="fe-path-btn fe-path-btn-right" onClick={goUp} title="상위 폴더">↑</button>
        <button className="fe-path-btn fe-path-btn-right" onClick={() => loadDir(currentPath)} title="새로고침">⟳</button>
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
          // 드래그 선택 시작 시 리스트에 포커스 — Delete 등 단축키 동작 보장
          try { listRef.current.focus({ preventScroll: true }); } catch {}
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
                const key = el.getAttribute('data-key');
                if (key) sel.add(key);
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
          // Ctrl+A / Cmd+A — 전체 선택
          if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
            e.preventDefault();
            const sorted = getSortedFiles();
            onSelectionChange(new Set(sorted.filter(f => f.name !== '..').map(f => fileKey(f))));
            return;
          }
          if (e.key === 'Delete' && selectedFiles.size > 0) {
            e.preventDefault();
            handleDelete([...selectedFiles][0]);
          }
          if (e.key === 'F2' && selectedFiles.size > 0) {
            e.preventDefault();
            const sorted = getSortedFiles();
            const first = sorted.find(f => selectedFiles.has(fileKey(f)));
            if (first) { setRenamingFile(first.name); setRenameValue(first.name); }
          }
          // prefix 키 점프 — 단일 키 누르면 해당 문자로 시작하는 첫 파일 선택, 같은 키 반복 시 순환
          if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
            const sorted = getSortedFiles();
            const ch = e.key.toLowerCase();
            // 현재 선택된 파일 다음부터 찾기 (같은 키 반복 시 순환)
            const curIdx = sorted.findIndex(f => selectedFiles.has(fileKey(f)));
            let target = -1;
            for (let i = 1; i <= sorted.length; i++) {
              const idx = (curIdx + i) % sorted.length;
              if (sorted[idx].name.toLowerCase().startsWith(ch)) { target = idx; break; }
            }
            if (target >= 0) {
              e.preventDefault();
              onSelectionChange(new Set([fileKey(sorted[target])]));
              // 스크롤 위치 조정
              setTimeout(() => {
                const el = document.querySelector(`.fe-file-row[data-key="${CSS.escape(fileKey(sorted[target]))}"]`) as HTMLElement | null;
                el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
              }, 0);
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
          <div key={fileKey(file)} data-name={file.name} data-key={fileKey(file)}
            className={`fe-file-row ${selectedFiles.has(fileKey(file)) ? 'selected' : ''}`}
            onClick={e => handleClick(file, idx, e)}
            onDoubleClick={() => handleDoubleClick(file)}
            onContextMenu={e => { e.stopPropagation(); handleContextMenu(e, file); }}
            draggable={renamingFile !== file.name}
            onDragStart={e => {
              if (renamingFile === file.name) { e.preventDefault(); return; }
              // 드래그 — name 기반 (소비측 백워드 호환)
              const selectedNames = sortedFiles.filter(f => selectedFiles.has(fileKey(f))).map(f => f.name);
              const filesToDrag = selectedNames.includes(file.name) ? selectedNames : [file.name];
              e.dataTransfer.setData('text/fe-files', JSON.stringify({
                panelId, files: filesToDrag, srcMode: source.mode, srcTermId: source.termId, srcPath: currentPath,
              }));
              e.dataTransfer.effectAllowed = 'copy';
            }}
          >
            <span className="fe-col-name" style={{ width: colWidths.name }}>
              <span className="fe-file-icon">{(() => {
                if (source.mode === 'local') {
                  // 가상 shell:* / shell-pidl:* / ::CLSID 항목은 shellPath 자체를 캐시 키로 사용 (SHGetFileInfo+PIDL)
                  const isVirtualShell = !!file.shellPath && (
                    /^shell:/.test(file.shellPath) ||
                    /^shell-pidl:/.test(file.shellPath) ||
                    /^::\{/.test(file.shellPath)
                  );
                  if (isVirtualShell) {
                    const shellUrl = iconCache.get(file.shellPath!);
                    if (shellUrl) return <img src={shellUrl} className="fe-file-icon-img" alt="" draggable={false} />;
                    return getFileIcon(file.name, file.isDir, file.shellPath);
                  }
                  const fullPath = file.shellPath && /^([A-Z]:|\\\\)/i.test(file.shellPath)
                    ? file.shellPath
                    : (currentPath.endsWith(sep) ? currentPath + file.name : currentPath + sep + file.name);
                  const url = iconCache.get(fullPath);
                  if (url) return <img src={url} className="fe-file-icon-img" alt="" draggable={false} />;
                  // Fallback: 디폴트 폴더/확장자 아이콘 (path-specific 로딩 전 깜빡임 방지)
                  if (file.isDir) {
                    const dirUrl = extIconCache.get('dir:');
                    if (dirUrl) return <img src={dirUrl} className="fe-file-icon-img" alt="" draggable={false} />;
                  } else {
                    const idx = file.name.lastIndexOf('.');
                    const ext = idx > 0 ? file.name.slice(idx + 1).toLowerCase() : '';
                    const extUrl = ext ? extIconCache.get('file:' + ext) : '';
                    if (extUrl) return <img src={extUrl} className="fe-file-icon-img" alt="" draggable={false} />;
                  }
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
              {renamingFile === file.name ? (
                <input
                  key={`rename-${file.name}`}
                  className="fe-rename-input"
                  ref={renameInputRefCallback}
                  defaultValue={renameValue}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); const v = (e.currentTarget.value || '').trim(); doRename(file.name, v); }
                    else if (e.key === 'Escape') { e.preventDefault(); setRenamingFile(null); }
                  }}
                  onBlur={e => {
                    const v = (e.currentTarget.value || '').trim();
                    doRename(file.name, v);
                  }}
                  onClick={e => e.stopPropagation()}
                  onMouseDown={e => e.stopPropagation()}
                />
              ) : (
                <span className="fe-file-name">{file.name}</span>
              )}
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
            // 선택된 keys 를 name 으로 변환 (수신측 호환)
            const selectedNames = files.filter(f => selectedFiles.has(fileKey(f))).map(f => f.name);
            e.dataTransfer.setData('text/fe-files', JSON.stringify({
              panelId, files: selectedNames, srcMode: source.mode, srcTermId: source.termId, srcPath: currentPath,
            }));
            e.dataTransfer.effectAllowed = 'copy';
          }}
        />
      </div>
      <div className="fe-status-bar">
        {t('statusSummary', { total: files.length, selected: selectedFiles.size })}
      </div>

      {encodingMenu && (() => {
        const encodings = [
          { code: 'utf-8', label: 'UTF-8 (Unicode)' },
          { code: 'cp949', label: 'CP949 (한국어 Windows)' },
          { code: 'euc-kr', label: 'EUC-KR (한국어 Unix)' },
          { code: 'shift_jis', label: 'Shift-JIS (일본어)' },
          { code: 'euc-jp', label: 'EUC-JP (일본어 Unix)' },
          { code: 'gbk', label: 'GBK (중국어 간체)' },
          { code: 'big5', label: 'Big5 (중국어 번체)' },
          { code: 'latin1', label: 'Latin-1 (서유럽)' },
        ];
        const items: any[] = encodings.map(e => ({
          label: (encoding === e.code ? '✓ ' : '   ') + e.label,
          onClick: () => setEncoding(e.code),
        }));
        return <ContextMenu x={encodingMenu.x} y={encodingMenu.y} items={items} onClose={() => setEncodingMenu(null)} />;
      })()}
      {historyMenu && (() => {
        const curIdx = historyIdxRef.current;
        const hist = historyRef.current;
        // back: curIdx-1 ... 0 (역순), forward: curIdx+1 ... end
        const indices = historyMenu.direction === 'back'
          ? Array.from({ length: curIdx }, (_, i) => curIdx - 1 - i)
          : Array.from({ length: hist.length - curIdx - 1 }, (_, i) => curIdx + 1 + i);
        const items: any[] = indices.map(i => ({
          label: hist[i] || '/',
          onClick: () => jumpToHistory(i),
        }));
        if (items.length === 0) return null;
        return <ContextMenu x={historyMenu.x} y={historyMenu.y} items={items} onClose={() => setHistoryMenu(null)} />;
      })()}
      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={() => setContextMenu(null)} items={[
          ...(contextMenu.file ? [
            { label: '복사', onClick: () => handleCopyToClipboard(fileKey(contextMenu.file!)) },
            { label: '붙여넣기', onClick: handlePaste, disabled: !getFileClipboard() },
            { label: '경로 복사', onClick: () => handleCopyPath(fileKey(contextMenu.file!)) },
            { separator: true } as const,
            { label: t('rename'), onClick: () => { setRenamingFile(contextMenu.file!.name); setRenameValue(contextMenu.file!.name); } },
            { label: t('deleteFile'), onClick: () => handleDelete(fileKey(contextMenu.file!)) },
            ...(source.mode === 'remote' ? [
              { separator: true } as const,
              { label: '권한 변경...', onClick: () => handleChmod(fileKey(contextMenu.file!)) },
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
      {/* rename 은 인라인 input 으로 처리 — 행 안에서 직접 편집 */}
      {errorMessage && createPortal(
        <div className="rn-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setErrorMessage(null); }}>
          <div className="rn-dialog" onMouseDown={e => e.stopPropagation()}>
            <div className="rn-title">오류</div>
            <div className="rn-body" style={{ maxWidth: 480 }}>
              <div style={{ fontSize: 12, lineHeight: '1.5em', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {errorMessage}
              </div>
            </div>
            <div className="rn-actions">
              <button className="rn-btn rn-btn-primary"
                ref={el => { if (el) setTimeout(() => el.focus(), 0); }}
                onClick={() => setErrorMessage(null)}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); setErrorMessage(null); } }}
              >확인</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
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
