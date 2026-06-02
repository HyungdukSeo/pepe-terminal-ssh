// src/components/SqlToolWorkspace.tsx
// SQL Tool — JDBC 사이드카(Java) 를 통한 다중 DBMS 지원. 결과/히스토리/스키마 트리/PK 편집/객체 상세.
import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import Editor, { OnMount } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import { format as sqlFormat } from 'sql-formatter';
import { DriverManagerModal } from './DriverManagerModal';
import { JdbcBackend, resolveDriverFromList, type ColumnInfo } from './jdbcBackend';
import { ObjectDetailPanel } from './ObjectDetailPanel';

export type DbmsType = 'altibase' | 'mysql' | 'postgres' | 'oracle' | 'mssql' | 'sqlite';
export type DbmsCfg = {
  type: DbmsType;
  port: number;
  user: string;
  password: string;
  host?: string;
  driverId?: string;
  database?: string;
  useSshTunnel?: boolean;
  urlOverride?: string;
  props?: Record<string, string>;
};

type Session = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth?: any;
  jumpTargetHost?: string;
  jumpTargetUser?: string;
  jumpTargetPort?: number;
  jumpTargetPassword?: string;
  dbms?: DbmsCfg;
};

type HistoryEntry = {
  ts: number;
  sql: string;
  rows: number;
  ms: number;
  error?: string;
};

type ParsedResult = {
  columns: string[];
  rows: string[][];
  affectedText?: string;
  raw?: string;
};

type Props = {
  sessionId: string;
  sessionName: string;
  aiAgent?: 'claude' | 'gemini' | 'codex';
};

// 히스토리 보관 한도 — 너무 많아지면 IPC 직렬화 비용이 커짐.
const HISTORY_MAX = 200;

export type FavoriteQuery = { id: string; name: string; sql: string; ts: number };

// 모듈 레벨 캐시 — 컴포넌트가 (display:none 토글이나 부모 re-render 로) remount 되어도
// history/favorites/editorTabs 가 살아남도록 sessionId 키로 보관. useState 초기값을 여기서 읽음.
type SqlSessionCache = { history: HistoryEntry[]; favorites: FavoriteQuery[]; editorTabs: EditorTab[] };
const sqlStateCache = new Map<string, SqlSessionCache>();

function loadFavorites(sessionId: string): FavoriteQuery[] {
  return sqlStateCache.get(sessionId)?.favorites ?? [];
}

// SQL 작성 탭 또는 객체 상세 탭. 같은 탭 스트립에 공존.
export type ObjectKind = 'table' | 'view' | 'index' | 'sequence' | 'procedure' | 'function' | 'synonym';
export type EditorTab = {
  id: string;
  title: string;
  sql: string;
  kind?: 'sql' | 'object';
  objectKind?: ObjectKind;
  objectName?: string;
  objectSchema?: string;
  objectSubTab?: string; // kind 별 자유 — 'columns' | 'definition' | 'data' | 'properties' | 'parameters' | 'source' | 'declaration' | 'constraints' | 'fks' | 'refs' | 'triggers' | 'ddl' | 'er'
  objectPropSubTab?: string; // Properties 안의 nested 탭 (table/view)
};
export type ObjectSubTab = string;
function newTabId() { return `t-${Date.now()}-${Math.random().toString(36).slice(2,7)}`; }
function loadEditorTabs(sessionId: string): EditorTab[] {
  // remount 캐시 우선. 없으면 빈 1탭. 디스크 데이터는 IPC 로 마운트 후 머지.
  const cached = sqlStateCache.get(sessionId)?.editorTabs;
  if (cached && cached.length > 0) return cached;
  return [{ id: newTabId(), title: 'Query 1', sql: '' }];
}
// saveEditorTabs / saveHistory 의 동기 저장은 더 이상 사용하지 않음 — 디바운스 effect 가 IPC 로 영속.

function loadHistory(sessionId: string): HistoryEntry[] {
  return sqlStateCache.get(sessionId)?.history ?? [];
}
function saveHistory(_sessionId: string, _entries: HistoryEntry[]) { /* moved to IPC effect */ }

// SQL 다중 statement 파서 — '...', "...", /*...*/, --line 안의 ; 는 무시.
// 빈 statement 자동 제거. cursor offset 으로 현재 statement 찾기 지원.
export type SqlStatement = { start: number; end: number; sql: string };
export function splitSqlStatements(text: string): SqlStatement[] {
  const stmts: SqlStatement[] = [];
  const n = text.length;
  let i = 0;
  let stmtStart = 0;
  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];
    // 라인 주석
    if (c === '-' && c2 === '-') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    // 블록 주석
    if (c === '/' && c2 === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    // 문자열
    if (c === "'" || c === '"') {
      const quote = c;
      i++;
      while (i < n) {
        if (text[i] === quote) {
          if (text[i + 1] === quote) { i += 2; continue; } // 이스케이프 ''
          i++; break;
        }
        if (text[i] === '\\') { i += 2; continue; }
        i++;
      }
      continue;
    }
    // 통계 분할
    if (c === ';') {
      const sub = text.slice(stmtStart, i);
      const trimmed = sub.trim();
      if (trimmed) stmts.push({ start: stmtStart, end: i, sql: trimmed });
      i++;
      stmtStart = i;
      continue;
    }
    i++;
  }
  // 마지막 ; 없는 잔여
  const tail = text.slice(stmtStart).trim();
  if (tail) stmts.push({ start: stmtStart, end: n, sql: tail });
  return stmts;
}
export function findStatementAt(stmts: SqlStatement[], offset: number): SqlStatement | undefined {
  // 커서가 어떤 statement 의 범위 안에 들어가면 그걸. 사이/끝 공백이면 가장 가까운 직전 statement.
  for (const s of stmts) {
    if (offset >= s.start && offset <= s.end + 1) return s;
  }
  return stmts[stmts.length - 1];
}


// 기본 SQL 키워드 (Altibase 우선) — Monaco 자동완성용
const SQL_KEYWORDS = [
  'SELECT','FROM','WHERE','GROUP BY','ORDER BY','HAVING','LIMIT','OFFSET','JOIN','INNER JOIN','LEFT JOIN','RIGHT JOIN','OUTER JOIN','ON','AS','AND','OR','NOT','IN','EXISTS','BETWEEN','LIKE','IS NULL','IS NOT NULL','UNION','UNION ALL','DISTINCT','COUNT','SUM','AVG','MIN','MAX','CASE','WHEN','THEN','ELSE','END',
  'INSERT INTO','VALUES','UPDATE','SET','DELETE FROM','MERGE','RETURNING',
  'CREATE TABLE','CREATE INDEX','CREATE VIEW','CREATE OR REPLACE','DROP TABLE','DROP INDEX','DROP VIEW','ALTER TABLE','ADD COLUMN','MODIFY','RENAME','TRUNCATE TABLE',
  'COMMIT','ROLLBACK','BEGIN','SAVEPOINT','DESCRIBE','EXPLAIN',
  'WITH','RECURSIVE','OVER','PARTITION BY','ROWS BETWEEN','UNBOUNDED PRECEDING','CURRENT ROW',
];

// 그리드에 렌더할 최대 행 수 — div 로 셀 렌더하므로 1만행도 부담스럽지 않지만,
// SELECT 결과 확인+간단 편집 용도이므로 2000 정도가 실용적 상한. 사이드카의 maxRows 도 이 값을 씀.
const MAX_DISPLAY_ROWS = 2000;

// (E-7/E-8: 레거시 isql 파서/드라이버 코드 제거됨 — JdbcBackend 가 사이드카 RPC 로 대체)
export const SqlToolWorkspace: React.FC<Props> = ({ sessionId, sessionName, aiAgent = 'claude' }) => {
  const [session, setSession] = useState<Session | null>(null);
  // JDBC 백엔드 — 사이드카 RPC 를 통해 모든 DBMS 동작 위임. connect 시 인스턴스 생성.
  const [backend, setBackend] = useState<JdbcBackend | null>(null);
  const [driverManagerOpen, setDriverManagerOpen] = useState<boolean>(false);
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [connectError, setConnectError] = useState<string>('');
  // 에디터 탭 상태 — 다중 SQL 탭 관리. 활성 탭의 sql 이 현재 편집 대상.
  const [editorTabs, setEditorTabs] = useState<EditorTab[]>(() => loadEditorTabs(sessionId));
  const [activeEditorTabId, setActiveEditorTabId] = useState<string>(() => loadEditorTabs(sessionId)[0]?.id || '');
  const activeTab = editorTabs.find(t => t.id === activeEditorTabId) || editorTabs[0];
  const sql = activeTab?.sql ?? '';
  const activeTabIdRef = useRef<string>('');
  useEffect(() => { activeTabIdRef.current = activeTab?.id || ''; }, [activeTab?.id]);
  const setSql = useCallback((v: string | ((s: string) => string)) => {
    setEditorTabs(prev => {
      const aid = activeTabIdRef.current || prev[0]?.id || '';
      return prev.map(t => t.id === aid
        ? { ...t, sql: typeof v === 'function' ? (v as (s: string) => string)(t.sql) : v }
        : t);
    });
  }, []);
  // 탭 이름 인라인 편집 상태
  const [renamingTabId, setRenamingTabId] = useState<string>('');
  const [renameDraft, setRenameDraft] = useState<string>('');
  // 오브젝트 상세 탭 열기 (같은 객체 이미 있으면 그 탭으로 전환)
  const openObjectDetail = useCallback((name: string, kind: ObjectKind, schema?: string) => {
    setEditorTabs(prev => {
      const existing = prev.find(t => t.kind === 'object' && t.objectName === name && t.objectKind === kind && (t.objectSchema || '') === (schema || ''));
      if (existing) { setActiveEditorTabId(existing.id); return prev; }
      const id = newTabId();
      const iconMap: Record<ObjectKind, string> = { table: '📄', view: '👁', index: '🔑', sequence: '🔢', procedure: '⚙', function: 'ƒ', synonym: '🔗' };
      const icon = iconMap[kind] || '📄';
      // 기본 서브탭 — DBeaver 스타일
      const defaultSubMap: Record<ObjectKind, string> = {
        table: 'properties', view: 'properties', index: 'columns', sequence: 'declaration',
        procedure: 'parameters', function: 'parameters', synonym: 'declaration',
      };
      const defaultPropSubMap: Record<ObjectKind, string> = {
        table: 'columns', view: 'columns', index: '', sequence: '', procedure: '', function: '', synonym: '',
      };
      const next = [...prev, { id, title: `${icon} ${name}`, sql: '', kind: 'object' as const, objectKind: kind, objectName: name, objectSchema: schema, objectSubTab: defaultSubMap[kind], objectPropSubTab: defaultPropSubMap[kind] }];
      setActiveEditorTabId(id);
      return next;
    });
  }, []);
  const setObjectSubTab = useCallback((tabId: string, sub: ObjectSubTab) => {
    setEditorTabs(prev => prev.map(t => t.id === tabId ? { ...t, objectSubTab: sub } : t));
  }, []);
  const setObjectPropSubTab = useCallback((tabId: string, sub: string) => {
    setEditorTabs(prev => prev.map(t => t.id === tabId ? { ...t, objectPropSubTab: sub } : t));
  }, []);
  // 컬럼 메타 캐시 (table 이름 대문자 key) — `table.` 자동완성 + 스키마 트리에서 공통 사용. lazy fetch.
  const columnsByTableRef = useRef<Map<string, ColumnInfo[]>>(new Map());
  const inflightColumnsRef = useRef<Map<string, Promise<ColumnInfo[]>>>(new Map());
  // 컬럼 트리 표시용 — 캐시 변경을 React 에 알리기 위한 트리거(같은 ref 데이터를 강제 재렌더)
  const [columnsRev, setColumnsRev] = useState<number>(0);
  // 테이블 PK 컬럼 캐시 (대문자 key) — 없으면 [] (한 번 시도했음 표시). undefined = 미시도.
  const pksByTableRef = useRef<Map<string, string[]>>(new Map());
  const inflightPksRef = useRef<Map<string, Promise<string[]>>>(new Map());
  const [pkRev, setPkRev] = useState<number>(0);
  // 데이터 편집 — 새 행(append) 및 삭제 표시
  // 새 행 각 칸은 빈 문자열로 시작. INSERT 시 빈 문자열은 NULL 로 보냄.
  const [newRows, setNewRows] = useState<string[][]>([]);
  const [deletedRowIdxs, setDeletedRowIdxs] = useState<Set<number>>(new Set());
  // ── 결과 그리드 사용자 상태 ──
  // 정렬: null=원본 순서. 같은 컬럼 재클릭 시 asc→desc→null 토글.
  const [sortState, setSortState] = useState<{ col: number; dir: 'asc' | 'desc' } | null>(null);
  // 컬럼별 substring 필터 (대소문자 무시). 빈문자열이면 미적용.
  const [colFilters, setColFilters] = useState<Map<number, string>>(new Map());
  // 컬럼별 폭(px). 미설정이면 기본값. 사용자가 헤더 우측을 드래그해 변경.
  const [colWidths, setColWidths] = useState<Map<number, number>>(new Map());
  // 좌측 고정 컬럼 — sticky left 로 가로 스크롤시 화면에 유지.
  const [pinnedCols, setPinnedCols] = useState<Set<number>>(new Set());
  // 핀된 결과 스냅샷 — 현재 결과를 보관해두고 다른 쿼리 결과와 병행 비교.
  type ResultSnapshot = {
    id: string; title: string; ts: number; sql: string;
    columns: string[]; rows: string[][];
    affectedText?: string; raw?: string; error?: string;
    lastTable: string;
  };
  const [pinnedSnapshots, setPinnedSnapshots] = useState<ResultSnapshot[]>([]);
  // 'current' = 라이브 결과. 그 외는 핀된 스냅샷 id.
  const [viewingTabId, setViewingTabId] = useState<string>('current');
  const DEFAULT_COL_W = 160;
  const INDEX_COL_W = 44;
  const MIN_COL_W = 40;
  const MAX_COL_W = 1000;
  const getColWidth = useCallback((j: number) => colWidths.get(j) ?? DEFAULT_COL_W, [colWidths]);
  // 고정 컬럼들의 누적 left offset: # 폭 + 인덱스가 j 보다 작은 고정 컬럼들의 폭 합.
  const pinnedLeftFor = useCallback((j: number): number => {
    let off = INDEX_COL_W;
    pinnedCols.forEach(p => { if (p < j) off += getColWidth(p); });
    return off;
  }, [pinnedCols, getColWidth]);
  // 컬럼 리사이즈 — mousedown 시 startX/startW 저장 후 window mousemove/mouseup 으로 처리
  const beginColResize = (j: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = getColWidth(j);
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(MIN_COL_W, Math.min(MAX_COL_W, startW + (ev.clientX - startX)));
      setColWidths(prev => { const n = new Map(prev); n.set(j, w); return n; });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  const togglePin = (j: number) => setPinnedCols(prev => {
    const n = new Set(prev);
    if (n.has(j)) n.delete(j); else n.add(j);
    return n;
  });
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ParsedResult | null>(null);
  const [resultError, setResultError] = useState<string>('');
  // 새 result 가 도착하면 그리드 사용자 상태 초기화 — 컬럼 구조가 바뀌었을 가능성
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setSortState(null); setColFilters(new Map()); setColWidths(new Map()); setPinnedCols(new Set()); }, [result?.columns.join('|'), viewingTabId]);
  // 자동완성용 테이블 목록 (현재 활성 스키마의 테이블)
  const [tables, setTables] = useState<string[]>([]);
  const [tableFilter, setTableFilter] = useState('');
  // ── DBeaver 스타일 스키마 트리 ──
  // 스키마(user) 목록
  const [schemas, setSchemas] = useState<string[]>([]);
  const [schemasLoading, setSchemasLoading] = useState(false);
  // 트리 노드별 항목 캐시 — key 규칙: `${schema} ${groupId}` (그룹 항목), `idx ${schema} ${table}` (인덱스)
  const treeItemsRef = useRef<Map<string, string[]>>(new Map());
  const treeLoadingRef = useRef<Set<string>>(new Set());
  const [treeRev, setTreeRev] = useState(0);
  // 트리 노드 펼침 상태 — id 형식: "schema:X", "group:X:TABLE", "table:X:NAME"
  const [treeExpanded, setTreeExpanded] = useState<Set<string>>(() => new Set());
  const isExpanded = (id: string) => treeExpanded.has(id);
  const toggleExpanded = (id: string) => setTreeExpanded(prev => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory(sessionId));
  const [historyFilter, setHistoryFilter] = useState('');
  // 즐겨찾기 (저장된 쿼리)
  const [favorites, setFavorites] = useState<FavoriteQuery[]>(() => loadFavorites(sessionId));
  const [favPanelOpen, setFavPanelOpen] = useState<boolean>(false);
  // 이름 입력 모달 (Electron 은 window.prompt 미지원 → 인라인 모달).
  // mode: 'save' = 새 즐겨찾기 저장(sql 보관), 'rename' = 기존 즐겨찾기 이름 변경(id 보관)
  const [nameModal, setNameModal] = useState<{ mode: 'save' | 'rename'; value: string; sql?: string; id?: string } | null>(null);
  // (favorites 영속화는 아래의 통합 IPC 디바운스 effect 가 담당)
  // 결과 그리드 셀 편집 상태 — Map<"row,col", newValue>
  const [edits, setEdits] = useState<Map<string, string>>(new Map());
  // 마지막 실행한 SELECT 의 테이블명 (UPDATE 생성용)
  const [lastTable, setLastTable] = useState<string>('');
  const [applying, setApplying] = useState(false);
  const [copyHint, setCopyHint] = useState<string>('');
  // 현재 편집 중인 셀 — "row,col" 또는 null
  const [editingCell, setEditingCell] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  // Monaco editor + monaco namespace 참조 — 텍스트영역 대체
  const monacoEditorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  // 자동완성 provider 의 최신 tables 참조 — closure stale 방지
  const tablesRefForCompletion = useRef<string[]>([]);
  const generateDisposeRef = useRef<(() => void) | null>(null);

  // 진행 중인 쿼리 식별 — 새 runSql 호출 시 이전 작업 무효화
  const runIdRef = useRef<number>(0);

  // JDBC 백엔드는 자체 connectionId 를 가지므로 SSH 재연결 로직은 더 이상 필요 없음.
  // (사이드카 프로세스가 죽으면 main 의 jdbcBridge 가 다음 호출 때 재spawn.)

  // 세션 정보 로드
  useEffect(() => {
    (async () => {
      try {
        const data = await (window as any).api?.listSessions?.();
        const list: Session[] = data?.sessions || [];
        const s = list.find(x => x.id === sessionId);
        if (s) setSession(s);
        else setConnectError('세션을 찾을 수 없음');
      } catch (e: any) {
        setConnectError(String(e?.message || e));
      }
    })();
  }, [sessionId]);

  // 모듈 캐시 동기화 — history/favorites/editorTabs 가 바뀔 때마다 즉시 캐시에 반영.
  // remount 되면 useState 초기값이 이 캐시에서 복원되므로 "쿼리 실행 → remount → 히스토리 사라짐" 방지.
  useEffect(() => {
    sqlStateCache.set(sessionId, { history, favorites, editorTabs });
  }, [sessionId, history, favorites, editorTabs]);

  // ── 영속화 IPC: 마운트 시 1회 로드, 변경 시 디바운스 저장 ──
  // 첫 로드 완료 표시. true 가 된 후에만 save 가 발사 — 초기 빈 값으로 disk 덮어쓰기 방지.
  const [ipcLoaded, setIpcLoaded] = useState<boolean>(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const api: any = (window as any).api || {};
        const state = await api.sqlToolGetState?.(sessionId);
        if (cancelled) return;
        // IPC fetch 가 비동기라, 도착하기 전에 사용자가 이미 쿼리를 실행해 history 에 추가했을 수 있다.
        // 따라서 절대 setHistory(loaded) 로 덮어쓰지 않고 — 머지(현재 로컬 우선, 디스크는 뒤에 누락분만 추가).
        const mergeHistoryFromDisk = (loaded: any[]) => {
          if (!Array.isArray(loaded)) return;
          setHistory(prev => {
            if (prev.length === 0) return loaded;
            const seen = new Set(prev.map((p: any) => p?.ts));
            const diskOnly = loaded.filter((h: any) => !seen.has(h?.ts));
            return [...prev, ...diskOnly];
          });
        };
        const mergeFavoritesFromDisk = (loaded: any[]) => {
          if (!Array.isArray(loaded)) return;
          setFavorites(prev => {
            if (prev.length === 0) return loaded;
            const seen = new Set(prev.map((p: any) => p?.id));
            const diskOnly = loaded.filter((f: any) => !seen.has(f?.id));
            return [...prev, ...diskOnly];
          });
        };
        // 에디터 탭: 로컬이 "기본 빈 탭 1개" 그대로면 디스크 탭으로 교체. 사용자가 이미 편집했으면 유지.
        const replaceTabsIfPristine = (loaded: any[]) => {
          if (!Array.isArray(loaded) || loaded.length === 0) return;
          setEditorTabs(prev => {
            const pristine = prev.length === 1 && (prev[0]?.sql || '') === '' && prev[0]?.kind !== 'object';
            if (!pristine) return prev; // 사용자가 이미 SQL 입력 — 디스크 탭 무시
            return loaded;
          });
          setActiveEditorTabId(prevId => {
            // pristine 일 때만 교체. 이미 다른 id 면 유지.
            return loaded[0]?.id || prevId;
          });
        };
        if (state && typeof state === 'object' && Object.keys(state).length > 0) {
          mergeHistoryFromDisk(state.history);
          mergeFavoritesFromDisk(state.favorites);
          replaceTabsIfPristine(state.editorTabs);
        } else {
          // disk 에 데이터 없음 — 레거시 localStorage 에서 마이그레이션 시도
          try {
            const lsHistory = localStorage.getItem(`sqltool-history-${sessionId}`);
            const lsFavorites = localStorage.getItem(`sqltool-favorites-${sessionId}`);
            const lsTabs = localStorage.getItem(`sqltool-tabs-${sessionId}`);
            if (lsHistory) { const arr = JSON.parse(lsHistory); mergeHistoryFromDisk(arr); }
            if (lsFavorites) { const arr = JSON.parse(lsFavorites); mergeFavoritesFromDisk(arr); }
            if (lsTabs) { const arr = JSON.parse(lsTabs); replaceTabsIfPristine(arr); }
          } catch {}
        }
      } finally {
        if (!cancelled) setIpcLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId]);
  // 단일 디바운스 저장 effect — 세 state 변화를 합쳐 한 번의 IPC 로 처리.
  // 분리 effect 였을 때 발생하던 "stale partial 끼리 덮어쓰기" race 차단.
  useEffect(() => {
    if (!ipcLoaded) return;
    const t = setTimeout(() => {
      (window as any).api?.sqlToolSetState?.(sessionId, {
        history: history.slice(0, HISTORY_MAX),
        favorites,
        editorTabs,
      });
    }, 500);
    return () => clearTimeout(t);
  }, [history, favorites, editorTabs, sessionId, ipcLoaded]);

  // 연결 수립 — drivers.json 에서 driverId/dialect 로 정의를 찾아 JdbcBackend 생성
  const connect = useCallback(async () => {
    if (!session?.dbms) return;
    if (!session.dbms.user && !session.dbms.urlOverride) {
      setConnectError('DB 사용자(user)가 설정되지 않았습니다. 세션 편집 > DBMS 에서 사용자/비밀번호 또는 URL 을 입력하세요.');
      return;
    }
    setConnecting(true);
    setConnectError('');
    try {
      const api: any = (window as any).api || {};
      const drivers: any[] = (await api.jdbcListDrivers?.()) || [];
      const def = resolveDriverFromList(drivers, session.dbms);
      if (!def) {
        setConnectError('JDBC 드라이버 정의를 찾을 수 없습니다. 드라이버 관리자 확인 필요.');
        return;
      }
      if (!def.diag?.usable) {
        setConnectError(`드라이버 JAR 누락: ${def.name}. 드라이버 관리자에서 JAR 을 추가하세요.`);
        return;
      }
      const newBackend = new JdbcBackend(sessionId, session.dbms, def);
      const cr = await newBackend.ensureConnected();
      if (!cr.ok) {
        setConnectError(cr.error || '연결 실패');
        return;
      }
      setBackend(newBackend);
      setConnected(true);
    } catch (e: any) {
      setConnectError(String(e?.message || e));
      setConnected(false);
    } finally {
      setConnecting(false);
    }
  }, [session, sessionId]);

  useEffect(() => {
    if (session && !connected && !connecting) {
      connect();
    }
  }, [session, connected, connecting, connect]);

  // 언마운트 시 JDBC 연결 종료 (사이드카 측)
  useEffect(() => {
    return () => {
      const b = backend;
      if (b) { try { b.disconnect(); } catch {} }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runSql = useCallback(async (sqlText: string, isAuto = false) => {
    if (!backend || !connected) return;
    if (!sqlText.trim()) return;
    const myRunId = ++runIdRef.current;
    setRunning(true);
    setResultError('');
    setEdits(new Map());
    if (!isAuto) {
      setResult(null);
      const m = sqlText.match(/from\s+([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)?)/i);
      setLastTable(m ? m[1] : '');
    }
    const t0 = Date.now();
    // 절대 timeout — 어떤 시나리오라도 5분 이상 진행되면 강제로 runId 무효화하여 중단
    // completed 플래그로 정상 종료 후 race fire 방지
    const ABS_TIMEOUT_MS = 5 * 60 * 1000;
    let completed = false;
    const absTimer = setTimeout(() => {
      if (completed) return;
      if (runIdRef.current === myRunId) {
        runIdRef.current++;
        setResultError('⚠ 5분 절대 timeout — 쿼리 중단됨. WHERE/LIMIT 으로 좁혀 다시 시도.');
        setRunning(false);
      }
    }, ABS_TIMEOUT_MS);

    try {
      // 사이드카가 maxRows+1 로 페이지를 가져오고 truncated 플래그를 함께 반환하므로
      // 클라이언트는 COUNT/페이지 루프가 불필요. 단순 한 번 exec.
      const res = await backend!.exec(sqlText, MAX_DISPLAY_ROWS);
      if (runIdRef.current !== myRunId) return; // 더 새로운 runSql — 결과 무시
      const ms = Date.now() - t0;
      const note = res.truncated
        ? ` ⚠ 결과 ${MAX_DISPLAY_ROWS.toLocaleString()}행 까지만 표시 (WHERE/ORDER BY+LIMIT 권장)`
        : '';
      const affectedText = res.columns.length === 0
        ? (res.rowsAffected > 0 ? `✓ ${res.rowsAffected}행 영향 (${ms}ms)` : `✓ 완료 (${ms}ms)`)
        : `✓ ${res.rows.length.toLocaleString()}${res.truncated ? '+' : ''}행 (${ms}ms)${note}`;
      setResult({ columns: res.columns, rows: res.rows, affectedText, raw: '' });
      if (!isAuto) {
        setHistory(h => {
          const next = [{ ts: Date.now(), sql: sqlText, rows: res.rows.length, ms, error: undefined }, ...h];
          saveHistory(sessionId, next); return next;
        });
      }
    } catch (e: any) {
      if (runIdRef.current !== myRunId) return;
      const ms = Date.now() - t0;
      const message = String(e?.message || e);
      setResultError(message);
      setResult({ columns: [], rows: [], affectedText: '✗ 실패', raw: '' });
      if (!isAuto) {
        setHistory(h => {
          const next = [{ ts: Date.now(), sql: sqlText, rows: 0, ms, error: message }, ...h];
          saveHistory(sessionId, next); return next;
        });
      }
    } finally {
      completed = true;
      clearTimeout(absTimer);
      if (runIdRef.current === myRunId) setRunning(false);
    }
  }, [session, connected, sessionId, backend]);

  // 특정 테이블의 컬럼 메타 lazy fetch — 사이드카의 DatabaseMetaData.getColumns 사용.
  const loadColumns = useCallback(async (table: string): Promise<ColumnInfo[]> => {
    if (!backend || !connected) return [];
    const key = table.toUpperCase();
    const cached = columnsByTableRef.current.get(key);
    if (cached) return cached;
    const inflight = inflightColumnsRef.current.get(key);
    if (inflight) return inflight;
    const promise = (async () => {
      try {
        const cols = await backend.columns(table);
        columnsByTableRef.current.set(key, cols);
        setColumnsRev(v => v + 1);
        return cols;
      } catch { return []; }
      finally { inflightColumnsRef.current.delete(key); }
    })();
    inflightColumnsRef.current.set(key, promise);
    return promise;
  }, [backend, connected]);
  const loadColumnsRef = useRef(loadColumns);
  useEffect(() => { loadColumnsRef.current = loadColumns; }, [loadColumns]);

  // ── 오브젝트 상세 — Definition(DDL) 캐시/로더 ──
  const definitionsRef = useRef<Map<string, string>>(new Map());
  const inflightDefRef = useRef<Map<string, Promise<string>>>(new Map());
  const [defRev, setDefRev] = useState<number>(0);
  // 인덱스/시퀀스 등 객체-종류별 부가 상세 캐시 (key: `${kind}:${schema}:${NAME}`)
  const objectDetailCacheRef = useRef<Map<string, any>>(new Map());
  const [objDetailRev, setObjDetailRev] = useState<number>(0);
  // 뷰: SYS_VIEW_PARSE_ 의 PARSE 컬럼 결합. 테이블: 컬럼 메타 + PK 로부터 CREATE TABLE 생성.
  const loadDefinition = useCallback(async (objectName: string, kind: 'table' | 'view'): Promise<string> => {
    const key = `${kind}:${objectName.toUpperCase()}`;
    const cached = definitionsRef.current.get(key);
    if (cached) return cached;
    const inflight = inflightDefRef.current.get(key);
    if (inflight) return inflight;
    const promise = (async () => {
      try {
        if (kind === 'view') {
          if (!backend || !connected) return '-- (연결되지 않음)';
          const body = await backend.viewDefinition(objectName);
          if (!body) return '-- (지원되지 않음)';
          const startsWithCreate = /^\s*CREATE/i.test(body);
          return startsWithCreate ? body : `CREATE OR REPLACE VIEW ${objectName} AS\n${body}${body.endsWith(';') ? '' : ';'}`;
        }
        // table: 컬럼 + PK 로 CREATE TABLE 생성 (대략)
        const cols = await loadColumnsRef.current(objectName);
        const pkCols = pksByTableRef.current.get(objectName.toUpperCase()) || await loadPrimaryKey(objectName);
        const colLines = cols.map(c => {
          const t = c.typeText || '';
          const nn = c.nullable ? '' : ' NOT NULL';
          return `  ${c.name}${t ? ' ' + t : ''}${nn}`;
        });
        const pkLine = pkCols.length > 0
          ? `,\n  CONSTRAINT PK_${objectName} PRIMARY KEY (${pkCols.join(', ')})`
          : '';
        return `CREATE TABLE ${objectName} (\n${colLines.join(',\n')}${pkLine}\n);`;
      } catch (e: any) {
        return `-- 예외: ${e?.message || e}`;
      } finally {
        inflightDefRef.current.delete(key);
        setDefRev(v => v + 1);
      }
    })().then(text => { definitionsRef.current.set(key, text); return text; });
    inflightDefRef.current.set(key, promise);
    return promise;
  }, [backend, connected]);

  // 테이블 PK 컬럼 lazy fetch — DatabaseMetaData.getPrimaryKeys 위임.
  const loadPrimaryKey = useCallback(async (table: string): Promise<string[]> => {
    if (!backend || !connected) return [];
    const key = table.toUpperCase();
    const cached = pksByTableRef.current.get(key);
    if (cached) return cached;
    const inflight = inflightPksRef.current.get(key);
    if (inflight) return inflight;
    const promise = (async () => {
      try {
        const cols = await backend.primaryKey(table);
        pksByTableRef.current.set(key, cols);
        setPkRev(v => v + 1);
        return cols;
      } catch { pksByTableRef.current.set(key, []); return []; }
      finally { inflightPksRef.current.delete(key); }
    })();
    inflightPksRef.current.set(key, promise);
    return promise;
  }, [backend, connected]);

  // lastTable 가 결정되면 PK 미리 fetch — Apply 시 곧장 사용
  useEffect(() => {
    if (lastTable && connected) loadPrimaryKey(lastTable);
  }, [lastTable, connected, loadPrimaryKey]);

  // 결과가 새로 들어오면 INSERT/DELETE 표시 초기화 (스냅샷에는 영향 없음)
  useEffect(() => { setNewRows([]); setDeletedRowIdxs(new Set()); }, [result]);

  // 트리 객체 그룹 정의 — DBeaver 좌측 사이드 구조. load 는 schema 받아 이름 목록 반환.
  const OBJECT_GROUPS: { id: string; icon: string; label: string; load: (schema: string) => Promise<string[]>; insert: (name: string) => string }[] = useMemo(() => [
    { id: 'TABLE',     icon: '📋', label: '테이블',     load: (s) => backend?.listTables(s) ?? Promise.resolve([]),     insert: (n) => `SELECT * FROM ${n};` },
    { id: 'VIEW',      icon: '👁',  label: '뷰',         load: (s) => backend?.listViews(s) ?? Promise.resolve([]),      insert: (n) => `SELECT * FROM ${n};` },
    { id: 'INDEX',     icon: '🔑', label: '인덱스',     load: (s) => backend?.listSchemaIndexes(s) ?? Promise.resolve([]), insert: (n) => n },
    { id: 'SEQUENCE',  icon: '🔢', label: '시퀀스',     load: (s) => backend?.listSequences(s) ?? Promise.resolve([]),  insert: (n) => `${n}.NEXTVAL` },
    { id: 'PROCEDURE', icon: '⚙',  label: '프로시저',   load: (s) => backend?.listProcedures(s) ?? Promise.resolve([]), insert: (n) => `EXEC ${n}(/* args */);` },
    { id: 'FUNCTION',  icon: 'ƒ',  label: '함수',       load: (s) => backend?.listFunctions(s) ?? Promise.resolve([]),  insert: (n) => `${n}()` },
    { id: 'SYSTABLE',  icon: '🗄', label: '시스템 테이블', load: (s) => backend?.listSystemTables(s) ?? Promise.resolve([]), insert: (n) => `SELECT * FROM ${n};` },
  ], [backend]);

  // 트리 노드 lazy 로드 — key(schema+groupId) 에 대해 items 캐시. 중복 호출 방지.
  const loadTreeNode = useCallback(async (key: string, loader: () => Promise<string[]>) => {
    if (treeItemsRef.current.has(key) || treeLoadingRef.current.has(key)) return;
    treeLoadingRef.current.add(key);
    setTreeRev(v => v + 1);
    try {
      const items = await loader();
      treeItemsRef.current.set(key, items);
    } catch { treeItemsRef.current.set(key, []); }
    finally { treeLoadingRef.current.delete(key); setTreeRev(v => v + 1); }
  }, []);

  // 스키마 목록 로드 + 자동완성용 기본 스키마 테이블 채우기
  const loadSchemas = useCallback(async () => {
    if (!backend) return;
    setSchemasLoading(true);
    try {
      const list = await backend.listSchemas();
      setSchemas(list);
      // 자동완성: 연결 사용자(대문자) 와 일치하는 스키마, 없으면 첫 스키마의 테이블
      const userSchema = (session?.dbms?.user || '').toUpperCase();
      const target = list.find(s => s.toUpperCase() === userSchema) || list[0];
      if (target) {
        const tbls = await backend.listTables(target);
        setTables(tbls);
        // 기본 스키마는 트리에서 펼쳐두기
        setTreeExpanded(prev => new Set(prev).add(`schema:${target}`));
        treeItemsRef.current.set(`${target} TABLE`, tbls);
        setTreeRev(v => v + 1);
      } else {
        // 스키마 개념이 없는 DBMS(SQLite 등) — 스키마 없이 평탄하게
        const tbls = await backend.listTables();
        setTables(tbls);
      }
    } finally { setSchemasLoading(false); }
  }, [backend, session]);

  useEffect(() => {
    if (connected) loadSchemas();
  }, [connected, loadSchemas]);

  // ── Monaco 헬퍼들 ──
  // 커서 offset 또는 선택 영역. 선택 있으면 그 부분, 없으면 null.
  const getSelectionText = (): string => {
    const ed = monacoEditorRef.current;
    const m = ed?.getModel();
    const sel = ed?.getSelection();
    if (!ed || !m || !sel) return '';
    return m.getValueInRange(sel);
  };
  const getCursorOffset = (): number => {
    const ed = monacoEditorRef.current;
    const m = ed?.getModel();
    const pos = ed?.getPosition();
    if (!ed || !m || !pos) return 0;
    return m.getOffsetAt(pos);
  };

  // 현재 커서 위치의 statement (선택 영역이 있으면 선택부) 실행
  const runCurrent = () => {
    const sel = getSelectionText();
    if (sel.trim()) { runSql(sel); return; }
    if (!monacoEditorRef.current) { runSql(sql); return; }
    const stmts = splitSqlStatements(sql);
    if (stmts.length === 0) return;
    const cur = findStatementAt(stmts, getCursorOffset());
    if (cur) runSql(cur.sql);
  };
  // 전체 statement 를 순차 실행 — 마지막 결과만 그리드에 표시 (간이 구현)
  const runAll = () => {
    const stmts = splitSqlStatements(sql);
    if (stmts.length === 0) return;
    if (stmts.length === 1) { runSql(stmts[0].sql); return; }
    // 여러 개면 세미콜론 join 으로 묶어서 전달 — JDBC backend.exec 는 단일 statement 만 처리하므로
    // 실제 다중 실행은 백엔드에서 statement 분리 후 순차 호출 필요. 임시: 첫 statement 만.
    runSql(stmts[0].sql);
  };
  // 현재 SQL 을 즐겨찾기에 저장 (선택 영역이 있으면 그 부분) — Electron 은 prompt 미지원이라 인라인 모달.
  const saveCurrentSqlAsFavorite = () => {
    const sel = getSelectionText().trim();
    const target = sel || sql.trim();
    if (!target) { flashHint('저장할 SQL 이 없습니다'); return; }
    const defaultName = target.replace(/\s+/g, ' ').slice(0, 40);
    setNameModal({ mode: 'save', value: defaultName, sql: target });
  };
  // 이름 입력 모달 확정 — save 면 새 즐겨찾기 추가, rename 이면 기존 항목 이름 변경
  const confirmNameModal = () => {
    if (!nameModal) return;
    const name = nameModal.value.trim();
    if (!name) { setNameModal(null); return; }
    if (nameModal.mode === 'save' && nameModal.sql) {
      const fav: FavoriteQuery = {
        id: `fav-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name,
        sql: nameModal.sql,
        ts: Date.now(),
      };
      setFavorites(prev => [fav, ...prev]);
      flashHint(`⭐ "${name}" 즐겨찾기 저장`);
    } else if (nameModal.mode === 'rename' && nameModal.id) {
      setFavorites(prev => prev.map(x => x.id === nameModal.id ? { ...x, name } : x));
    }
    setNameModal(null);
  };
  // 실행 계획 — dialect 별 EXPLAIN. 결과는 즉시 핀 스냅샷으로 보관해 다음 쿼리와 비교 가능.
  const runExplain = async () => {
    if (!backend || !connected) return;
    const sel = getSelectionText().trim();
    const target = sel || (() => {
      const stmts = splitSqlStatements(sql);
      if (stmts.length === 0) return '';
      const cur = findStatementAt(stmts, getCursorOffset());
      return cur?.sql || stmts[0].sql;
    })();
    if (!target) { flashHint('EXPLAIN 대상 SQL 이 없습니다'); return; }
    setRunning(true);
    const t0 = Date.now();
    try {
      const res = await backend.explain(target);
      const ms = Date.now() - t0;
      const sqlExcerpt = target.replace(/\s+/g, ' ').trim().slice(0, 60);
      const snap: ResultSnapshot = {
        id: `plan-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
        title: `📊 Plan: ${sqlExcerpt}`,
        ts: Date.now(),
        sql: `[EXPLAIN] ${target}`,
        columns: res.columns,
        rows: res.rows,
        affectedText: `✓ EXPLAIN (${ms}ms)${res.truncated ? ' ⚠ 잘림' : ''}`,
        raw: '',
        error: undefined,
        lastTable: '',
      };
      setPinnedSnapshots(prev => [...prev, snap]);
      setViewingTabId(snap.id);
      setHistory(h => {
        const next = [{ ts: Date.now(), sql: `[EXPLAIN] ${target}`, rows: res.rows.length, ms, error: undefined }, ...h];
        saveHistory(sessionId, next); return next;
      });
    } catch (e: any) {
      flashHint(`EXPLAIN 실패: ${e?.message || e}`);
    } finally { setRunning(false); }
  };
  // SQL 포맷
  const formatSql = () => {
    try {
      const target = getSelectionText().trim();
      const source = target || sql;
      const formatted = sqlFormat(source, { language: 'sql', keywordCase: 'upper', tabWidth: 2 });
      const ed = monacoEditorRef.current;
      const m = ed?.getModel();
      if (ed && m) {
        if (target) {
          const sel = ed.getSelection()!;
          ed.executeEdits('format', [{ range: sel, text: formatted }]);
        } else {
          const fullRange = m.getFullModelRange();
          ed.executeEdits('format', [{ range: fullRange, text: formatted }]);
        }
      } else {
        setSql(formatted);
      }
    } catch (e: any) { flashHint(`포맷 실패: ${e?.message || e}`); }
  };

  // Monaco mount — 자동완성 provider + 단축키 액션 등록 (provider 는 1회만 등록)
  const completionDisposeRef = useRef<Monaco.IDisposable | null>(null);
  const handleEditorMount: OnMount = (editor, monaco) => {
    monacoEditorRef.current = editor;
    monacoRef.current = monaco;
    // 단축키: Ctrl+Enter / Ctrl+Shift+Enter / Shift+Ctrl+F
    editor.addAction({
      id: 'pepe-sql-run-current',
      label: 'Run current statement',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => { runCurrent(); },
    });
    editor.addAction({
      id: 'pepe-sql-run-all',
      label: 'Run all statements',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter],
      run: () => { runAll(); },
    });
    editor.addAction({
      id: 'pepe-sql-format',
      label: 'Format SQL',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF],
      run: () => { formatSql(); },
    });
    editor.addAction({
      id: 'pepe-sql-save-favorite',
      label: 'Save as favorite',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => { saveCurrentSqlAsFavorite(); },
    });
    editor.addAction({
      id: 'pepe-sql-explain',
      label: 'Explain (plan)',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP],
      run: () => { runExplain(); },
    });
    // 자동완성: 키워드 + 테이블명 (대소문자 무관, 부분 일치는 monaco 가 처리)
    if (!completionDisposeRef.current) {
      completionDisposeRef.current = monaco.languages.registerCompletionItemProvider('sql', {
        triggerCharacters: [' ', '.', ','],
        provideCompletionItems: async (model: Monaco.editor.ITextModel, position: Monaco.Position) => {
          const word = model.getWordUntilPosition(position);
          const range: Monaco.IRange = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn,
          };
          // `tableName.` 또는 `tableName.partial` 컨텍스트 검출 — 컬럼 자동완성
          const lineUpToCursor = model.getValueInRange({
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: 1,
            endColumn: position.column,
          });
          const dotMatch = lineUpToCursor.match(/([A-Za-z_][A-Za-z0-9_]*)\.[A-Za-z0-9_]*$/);
          if (dotMatch) {
            const tableTok = dotMatch[1];
            const found = tablesRefForCompletion.current.find(t => t.toUpperCase() === tableTok.toUpperCase());
            if (found) {
              const cols = await loadColumnsRef.current(found);
              return {
                suggestions: cols.map(c => ({
                  label: c.name,
                  kind: monaco.languages.CompletionItemKind.Field,
                  insertText: c.name,
                  detail: c.typeText ? `${found} · ${c.typeText}` : `${found} column`,
                  range,
                })),
              };
            }
          }
          const kw = SQL_KEYWORDS.map(k => ({
            label: k,
            kind: monaco.languages.CompletionItemKind.Keyword,
            insertText: k,
            range,
          }));
          const tbls = tablesRefForCompletion.current.map(t => ({
            label: t,
            kind: monaco.languages.CompletionItemKind.Class,
            insertText: t,
            detail: 'table',
            range,
          }));
          return { suggestions: [...tbls, ...kw] };
        },
      });
    }
  };
  useEffect(() => () => { try { completionDisposeRef.current?.dispose(); } catch {} completionDisposeRef.current = null; }, []);
  // tables 변경 시 ref 동기화
  useEffect(() => { tablesRefForCompletion.current = tables; }, [tables]);

  // ── 결과 export 헬퍼 ── (현재 보고 있는 탭 기준 — 라이브면 edits 반영, 스냅샷이면 원본)
  const escCsv = (v: string) => /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  const exportCell = (i: number, j: number, c: string) => isPinnedView ? c : (edits.get(`${i},${j}`) ?? c);
  const buildCsv = () => {
    const src = displayedResult;
    if (!src || src.columns.length === 0) return '';
    const head = src.columns.map(escCsv).join(',');
    const body = src.rows.map((row, i) =>
      row.map((c, j) => escCsv(exportCell(i, j, c))).join(',')
    ).join('\n');
    return head + '\n' + body;
  };
  const buildTsv = () => {
    const src = displayedResult;
    if (!src || src.columns.length === 0) return '';
    const head = src.columns.join('\t');
    const body = src.rows.map((row, i) =>
      row.map((c, j) => exportCell(i, j, c).replace(/\t/g, ' ').replace(/\n/g, ' ')).join('\t')
    ).join('\n');
    return head + '\n' + body;
  };
  // JSON 내보내기 — 컬럼명을 키로 한 객체 배열. 라이브에서는 편집 셀 반영.
  const buildJson = (): string => {
    const src = displayedResult;
    if (!src || src.columns.length === 0) return '[]';
    const arr = src.rows.map((row, i) => {
      const obj: Record<string, string> = {};
      src.columns.forEach((col, j) => { obj[col] = exportCell(i, j, row[j] ?? ''); });
      return obj;
    });
    return JSON.stringify(arr, null, 2);
  };

  // ── 결과 탭(현재 + 핀된 스냅샷) ─ derived 표시 변수 ──
  const viewingSnapshot = pinnedSnapshots.find(s => s.id === viewingTabId);
  const isPinnedView = !!viewingSnapshot;
  const displayedResult: ParsedResult | null = viewingSnapshot
    ? { columns: viewingSnapshot.columns, rows: viewingSnapshot.rows, affectedText: viewingSnapshot.affectedText, raw: viewingSnapshot.raw }
    : result;
  const displayedResultError = viewingSnapshot ? (viewingSnapshot.error || '') : resultError;
  const displayedLastTable = viewingSnapshot ? viewingSnapshot.lastTable : lastTable;
  // 현재 활성 라이브 결과를 스냅샷으로 핀
  const pinCurrentResult = () => {
    if (!result || result.columns.length === 0) return;
    const matRows = result.rows.map((row, i) => row.map((c, j) => edits.get(`${i},${j}`) ?? c));
    const sqlNow = activeTab?.sql || '';
    const titleSrc = lastTable || sqlNow.replace(/\s+/g, ' ').trim().slice(0, 40) || '결과';
    const snap: ResultSnapshot = {
      id: `snap-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
      title: titleSrc,
      ts: Date.now(),
      sql: sqlNow,
      columns: result.columns.slice(),
      rows: matRows,
      affectedText: result.affectedText,
      raw: result.raw,
      error: resultError || undefined,
      lastTable,
    };
    setPinnedSnapshots(prev => [...prev, snap]);
    setViewingTabId(snap.id);
  };
  const closeSnapshot = (id: string) => {
    setPinnedSnapshots(prev => prev.filter(s => s.id !== id));
    if (viewingTabId === id) setViewingTabId('current');
  };

  // 셀 표시값 (편집 반영) — 정렬/필터 derivation 에서 공통 사용. 스냅샷은 read-only.
  const cellValue = useCallback((rowIdx: number, colIdx: number): string => {
    if (viewingSnapshot) return viewingSnapshot.rows[rowIdx]?.[colIdx] ?? '';
    return edits.get(`${rowIdx},${colIdx}`) ?? (result?.rows[rowIdx]?.[colIdx] ?? '');
  }, [edits, result, viewingSnapshot]);

  // 정렬/필터 적용 후의 row 인덱스 배열 — 셀 편집은 원본 인덱스로 유지
  const viewRowIndices = useMemo<number[]>(() => {
    if (!displayedResult || displayedResult.rows.length === 0) return [];
    let idxs = displayedResult.rows.map((_, i) => i);
    if (colFilters.size > 0) {
      const filters = Array.from(colFilters.entries()).filter(([, v]) => v.length > 0);
      if (filters.length > 0) {
        idxs = idxs.filter(rowIdx =>
          filters.every(([col, q]) => cellValue(rowIdx, col).toLowerCase().includes(q.toLowerCase())));
      }
    }
    if (sortState) {
      const { col, dir } = sortState;
      const mul = dir === 'asc' ? 1 : -1;
      // 모든 값이 숫자 형태면 숫자 정렬, 아니면 문자열 정렬 (한국어 locale)
      const allNumeric = idxs.every(i => {
        const v = cellValue(i, col).trim();
        return v === '' || /^-?\d+(?:\.\d+)?$/.test(v);
      });
      idxs = [...idxs].sort((a, b) => {
        const va = cellValue(a, col);
        const vb = cellValue(b, col);
        if (va === '' && vb !== '') return mul;
        if (va !== '' && vb === '') return -mul;
        if (allNumeric) return mul * (parseFloat(va || '0') - parseFloat(vb || '0'));
        return mul * va.localeCompare(vb, 'ko');
      });
    }
    return idxs;
  }, [displayedResult, colFilters, sortState, cellValue]);

  const flashHint = (msg: string) => { setCopyHint(msg); setTimeout(() => setCopyHint(''), 1800); };

  const onSaveCsv = async () => {
    if (!displayedResult || displayedResult.columns.length === 0) return;
    const name = (displayedLastTable || 'query-result') + '-' + new Date().toISOString().slice(0,19).replace(/[:T]/g,'-') + '.csv';
    try {
      const r = await (window as any).api?.sqlSaveCsv(name, buildCsv());
      if (r?.success) flashHint(`저장됨: ${r.path}`);
      else if (!r?.canceled) flashHint(`저장 실패: ${r?.error || '?'}`);
    } catch (e: any) { flashHint(`저장 예외: ${e?.message || e}`); }
  };
  const onSaveJson = async () => {
    if (!displayedResult || displayedResult.columns.length === 0) return;
    const name = (displayedLastTable || 'query-result') + '-' + new Date().toISOString().slice(0,19).replace(/[:T]/g,'-') + '.json';
    try {
      // sqlSaveCsv 는 임의 텍스트 저장 IPC 로도 동작 (단순 텍스트 write). 확장자만 .json 으로.
      const r = await (window as any).api?.sqlSaveCsv(name, buildJson());
      if (r?.success) flashHint(`저장됨: ${r.path}`);
      else if (!r?.canceled) flashHint(`저장 실패: ${r?.error || '?'}`);
    } catch (e: any) { flashHint(`저장 예외: ${e?.message || e}`); }
  };

  const onCopyClipboard = async () => {
    if (!displayedResult || displayedResult.columns.length === 0) return;
    try {
      await navigator.clipboard.writeText(buildTsv());
      flashHint('클립보드에 복사됨');
    } catch (e: any) { flashHint(`복사 실패: ${e?.message || e}`); }
  };

  // 테이블을 canvas 로 렌더해서 PNG 클립보드 복사
  const onCopyImage = async () => {
    const src = displayedResult;
    if (!src || src.columns.length === 0) return;
    try {
      const cols = src.columns;
      const rows = src.rows.map((row, i) => row.map((c, j) => exportCell(i, j, c)));
      const fontSize = 13;
      const padX = 10, padY = 6;
      const headBg = '#2d2d2d', headFg = '#9cdcfe', evenBg = '#1e1e1e', oddBg = '#252525', fg = '#d4d4d4', borderC = '#444';
      // 측정용 임시 canvas
      const meas = document.createElement('canvas').getContext('2d')!;
      meas.font = `${fontSize}px monospace`;
      const colWidths = cols.map((c, j) => {
        const headW = meas.measureText(c).width;
        const dataW = rows.reduce((m, r) => Math.max(m, meas.measureText(r[j] || '').width), 0);
        return Math.ceil(Math.max(headW, dataW) + padX * 2);
      });
      const idxColW = Math.ceil(meas.measureText(String(rows.length)).width + padX * 2);
      const rowH = fontSize + padY * 2;
      const totalW = idxColW + colWidths.reduce((a, b) => a + b, 0);
      const totalH = rowH * (rows.length + 1);
      const dpr = window.devicePixelRatio || 1;
      const canvas = document.createElement('canvas');
      canvas.width = totalW * dpr;
      canvas.height = totalH * dpr;
      const ctx = canvas.getContext('2d')!;
      ctx.scale(dpr, dpr);
      ctx.font = `${fontSize}px monospace`;
      ctx.textBaseline = 'middle';
      // header
      ctx.fillStyle = headBg;
      ctx.fillRect(0, 0, totalW, rowH);
      ctx.fillStyle = headFg;
      let x = padX;
      ctx.fillText('#', x, rowH / 2);
      x = idxColW + padX;
      cols.forEach((c, j) => {
        ctx.fillText(c, x, rowH / 2);
        x += colWidths[j];
      });
      // body
      rows.forEach((row, i) => {
        const y = rowH * (i + 1);
        ctx.fillStyle = i % 2 ? oddBg : evenBg;
        ctx.fillRect(0, y, totalW, rowH);
        ctx.fillStyle = '#888';
        ctx.fillText(String(i + 1), padX, y + rowH / 2);
        ctx.fillStyle = fg;
        let cx = idxColW + padX;
        row.forEach((c, j) => {
          ctx.fillText(c, cx, y + rowH / 2);
          cx += colWidths[j];
        });
      });
      // grid lines
      ctx.strokeStyle = borderC;
      ctx.lineWidth = 1;
      for (let i = 0; i <= rows.length + 1; i++) {
        ctx.beginPath(); ctx.moveTo(0, i * rowH); ctx.lineTo(totalW, i * rowH); ctx.stroke();
      }
      const blob: Blob | null = await new Promise(r => canvas.toBlob(b => r(b), 'image/png'));
      if (!blob) { flashHint('이미지 생성 실패'); return; }
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      flashHint('이미지가 클립보드에 복사됨');
    } catch (e: any) { flashHint(`이미지 복사 실패: ${e?.message || e}`); }
  };

  // 편집창 내용을 Claude agent 에 전달해 SQL 생성 → 편집창 하단부에 추가
  const onAutoGenerate = useCallback(async () => {
    const userText = sql.trim();
    if (!userText) { flashHint('편집창에 요청 내용을 작성한 뒤 누르세요'); return; }
    if (generating) return;
    // 이전 리스너 잔여 정리
    try { generateDisposeRef.current?.(); } catch {}
    generateDisposeRef.current = null;

    setGenerating(true);
    flashHint('🤖 AI 쿼리 생성 중...');
    const requestId = `sqlgen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const claudeSessionId = `sqltool-${sessionId}`;
    let collected = '';
    let finalized = false;

    const tableHint = tables.length > 0
      ? `\n\n사용 가능한 테이블 목록 (총 ${tables.length}개, 일부):\n${tables.slice(0, 80).join(', ')}`
      : '';
    const prompt =
      `당신은 Altibase DB SQL 작성을 돕는 어시스턴트입니다. ` +
      `아래 사용자의 요청/메모/미완성 SQL 을 보고, 의도에 맞는 Altibase SQL 쿼리를 작성해 주세요. ` +
      `결과는 반드시 \`\`\`sql 코드 블록 1개 안에 작성하세요. ` +
      `설명이나 가정은 코드 블록 밖에 쓰지 말고, 코드 블록 안에 -- 주석으로 포함하세요. ` +
      `테이블/컬럼이 불명확한 경우 합리적인 가정을 -- 주석으로 SQL 위에 명시하세요.${tableHint}\n\n` +
      `--- 사용자 요청 ---\n${userText}`;

    const dispose = (window as any).api?.onClaudeStream?.((p: any) => {
      if (p.requestId !== requestId) return;
      const msg = p.message;
      if (!msg) return;
      if (msg.type === 'assistant' && msg.message?.content) {
        const texts = (msg.message.content as any[])
          .filter(c => c?.type === 'text')
          .map(c => c.text || '')
          .join('');
        if (texts) collected += texts;
      } else if (msg.type === 'text' && typeof msg.text === 'string') {
        // 비-JSON 라인 fallback (드물게)
        collected += msg.text;
      } else if (msg.type === 'error' && !finalized) {
        finalized = true;
        flashHint(`AI 생성 에러: ${(msg.text || '').slice(0, 80)}`);
        setGenerating(false);
        try { dispose?.(); } catch {}
        generateDisposeRef.current = null;
      } else if ((msg.type === 'result' || msg.type === 'done') && !finalized) {
        finalized = true;
        // ```sql ... ``` 블록 추출 — 없으면 응답 전체 사용
        let extracted = collected.trim();
        const blockMatch = collected.match(/```(?:sql|SQL)?\s*\n?([\s\S]*?)```/);
        if (blockMatch) {
          extracted = blockMatch[1].trim();
          // 코드 블록 밖 설명이 있으면 -- 주석으로 변환해 SQL 앞에 추가
          const before = collected.slice(0, collected.indexOf(blockMatch[0])).trim();
          const after = collected.slice(collected.indexOf(blockMatch[0]) + blockMatch[0].length).trim();
          const outside = [before, after].filter(Boolean).join(' ').trim();
          if (outside) {
            const commentLines = outside.split('\n').map(l => `-- ${l.trim()}`).filter(l => l !== '-- ').join('\n');
            extracted = commentLines + '\n' + extracted;
          }
        }
        if (!extracted) {
          flashHint('AI 응답이 비어있음');
        } else {
          setSql(s => {
            const sep = s.length === 0 ? '' : (s.endsWith('\n\n') ? '' : s.endsWith('\n') ? '\n' : '\n\n');
            return s + sep + extracted + (extracted.endsWith(';') ? '\n' : '');
          });
          flashHint('AI 쿼리가 편집창 하단에 추가됨');
        }
        setGenerating(false);
        try { dispose?.(); } catch {}
        generateDisposeRef.current = null;
      }
    });
    generateDisposeRef.current = dispose || null;

    try {
      let r: any;
      if (aiAgent === 'gemini') {
        r = await (window as any).api?.geminiSend?.(claudeSessionId, prompt, requestId, undefined, true);
      } else if (aiAgent === 'codex') {
        r = await (window as any).api?.codexSend?.(claudeSessionId, prompt, requestId, undefined, 'full-auto');
      } else {
        r = await (window as any).api?.claudeSend?.(
          claudeSessionId, prompt, undefined, true, undefined, null, 'bypassPermissions', undefined, false, requestId,
        );
      }
      if (!r?.success && !finalized) {
        finalized = true;
        flashHint(`AI 호출 실패: ${r?.error || '?'}`);
        setGenerating(false);
        try { dispose?.(); } catch {}
        generateDisposeRef.current = null;
      }
    } catch (e: any) {
      if (!finalized) {
        finalized = true;
        flashHint(`AI 호출 예외: ${e?.message || e}`);
        setGenerating(false);
        try { dispose?.(); } catch {}
        generateDisposeRef.current = null;
      }
    }
  }, [sql, sessionId, tables, generating]);

  useEffect(() => () => { try { generateDisposeRef.current?.(); } catch {} }, []);

  // 변경된 셀/새 행/삭제 표시 → UPDATE+INSERT+DELETE 묶음 트랜잭션 (JDBC)
  const onApplyChanges = async () => {
    if (!result || !lastTable) return;
    if (!backend || !connected) return;
    if (edits.size === 0 && newRows.length === 0 && deletedRowIdxs.size === 0) return;

    // 빈 문자열/NULL 표기 처리.
    const sqlVal = (v: string) => v === '' ? 'NULL' : `'${v.replace(/'/g, `''`)}'`;
    const eqOrNull = (col: string, v: string) => v === '' ? `${col} IS NULL` : `${col} = '${v.replace(/'/g, `''`)}'`;

    // PK 우선 사용. 없으면 모든 컬럼 매칭으로 폴백.
    const pkCols = pksByTableRef.current.get(lastTable.toUpperCase()) || [];
    const buildWhere = (rowIdx: number): string => {
      const origRow = result.rows[rowIdx];
      const cols = pkCols.length > 0
        ? pkCols
        : result.columns;
      const parts = cols.map(col => {
        const colIdx = result.columns.findIndex(c => c.toUpperCase() === col.toUpperCase());
        const orig = colIdx >= 0 ? (origRow[colIdx] ?? '') : '';
        return eqOrNull(col, orig);
      });
      return parts.join(' AND ');
    };

    // edits 를 row 단위로 묶기. 삭제 표시된 행은 UPDATE 에서 제외 (DELETE 만).
    const editsByRow = new Map<number, Map<number, string>>();
    edits.forEach((v, k) => {
      const [rs, cs] = k.split(',').map(Number);
      if (deletedRowIdxs.has(rs)) return;
      if (!editsByRow.has(rs)) editsByRow.set(rs, new Map());
      editsByRow.get(rs)!.set(cs, v);
    });

    const updates: string[] = [];
    editsByRow.forEach((cellMap, rowIdx) => {
      const setParts: string[] = [];
      cellMap.forEach((newV, colIdx) => {
        setParts.push(`${result.columns[colIdx]} = ${sqlVal(newV)}`);
      });
      updates.push(`UPDATE ${lastTable} SET ${setParts.join(', ')} WHERE ${buildWhere(rowIdx)};`);
    });
    const deletes: string[] = [];
    deletedRowIdxs.forEach(rowIdx => {
      deletes.push(`DELETE FROM ${lastTable} WHERE ${buildWhere(rowIdx)};`);
    });
    const inserts: string[] = [];
    newRows.forEach(row => {
      // 모든 칸이 빈 행은 스킵
      if (row.every(v => v === '')) return;
      const valStrs = row.map(sqlVal).join(', ');
      inserts.push(`INSERT INTO ${lastTable} (${result.columns.join(', ')}) VALUES (${valStrs});`);
    });

    if (updates.length === 0 && deletes.length === 0 && inserts.length === 0) return;

    const opsSummary = [
      updates.length ? `${updates.length}건 UPDATE` : '',
      inserts.length ? `${inserts.length}건 INSERT` : '',
      deletes.length ? `${deletes.length}건 DELETE` : '',
    ].filter(Boolean).join(' / ');
    const pkNote = pkCols.length > 0
      ? `PK 사용: ${pkCols.join(', ')}`
      : '⚠ PK 미감지 — 모든 컬럼 매칭(보수적). 잘못된 매칭 가능성 있음.';
    const preview = [...deletes, ...updates, ...inserts].join('\n');
    const refocus = () => { try { (window as any).api?.refocusWindow?.(); } catch {} };
    const ok = confirm(
      `${opsSummary}\n${pkNote}\n\n${preview.slice(0, 600)}${preview.length > 600 ? '\n...' : ''}\n\n적용 (COMMIT) 진행?`
    );
    refocus();
    if (!ok) return;
    setApplying(true);
    const t0 = Date.now();
    const allStmts = [...deletes, ...updates, ...inserts];
    let failedStmt = '';
    let failedMsg = '';
    try {
      await backend.beginTx();
      try {
        for (const stmt of allStmts) {
          try { await backend.exec(stmt, 1); }
          catch (e: any) { failedStmt = stmt; failedMsg = String(e?.message || e); throw e; }
        }
        await backend.commit();
        const ms = Date.now() - t0;
        setHistory(h => {
          const next = [
            { ts: Date.now(), sql: allStmts.join('\n') + '\nCOMMIT;', rows: allStmts.length, ms, error: undefined },
            ...h,
          ];
          saveHistory(sessionId, next);
          return next;
        });
        alert(`적용 완료 — ${opsSummary} + COMMIT.`);
        refocus();
        setEdits(new Map());
        setNewRows([]);
        setDeletedRowIdxs(new Set());
        if (lastTable) runSql(backend.selectAllForTable(lastTable));
      } catch (innerErr: any) {
        try { await backend.rollback(); } catch {}
        const ms = Date.now() - t0;
        setHistory(h => {
          const next = [
            { ts: Date.now(), sql: failedStmt || allStmts.join('\n'), rows: 0, ms, error: failedMsg || String(innerErr?.message || innerErr) },
            ...h,
          ];
          saveHistory(sessionId, next);
          return next;
        });
        console.error('[SQL apply error]', { stmt: failedStmt, message: failedMsg });
        alert(`적용 중 에러 — ROLLBACK 시도됨:\n${failedMsg}\n\n실패 SQL(앞 600자):\n${(failedStmt || '').slice(0, 600)}`);
        refocus();
      }
    } finally { setApplying(false); }
  };

  const filteredHistory = useMemo(() =>
    history.filter(h => !historyFilter || h.sql.toLowerCase().includes(historyFilter.toLowerCase())),
    [history, historyFilter]);

  const insertAtCursor = (text: string) => {
    const ed = monacoEditorRef.current;
    if (!ed) { setSql(s => s + text); return; }
    const sel = ed.getSelection();
    if (!sel) { setSql(s => s + text); return; }
    ed.executeEdits('insert', [{ range: sel, text, forceMoveMarkers: true }]);
    ed.focus();
  };
  // 드래그-드롭 위치에 텍스트 삽입 — Monaco 의 좌표 → position 사용
  const insertAtClientPoint = (text: string, clientX: number, clientY: number) => {
    const ed = monacoEditorRef.current;
    if (!ed) { setSql(s => s + text); return; }
    const target = ed.getTargetAtClientPoint(clientX, clientY);
    const pos = target?.position;
    if (!pos) { insertAtCursor(text); return; }
    const range: Monaco.IRange = { startLineNumber: pos.lineNumber, endLineNumber: pos.lineNumber, startColumn: pos.column, endColumn: pos.column };
    ed.executeEdits('drop', [{ range, text, forceMoveMarkers: true }]);
    ed.focus();
  };

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0, minWidth: 0, width: '100%', overflow: 'hidden', background: '#1e1e1e', color: '#d4d4d4', fontFamily: 'system-ui, sans-serif', fontSize: 13 }}>
      {/* 좌측: DBeaver 스타일 스키마 트리 (스키마 > 객체 그룹 > 객체 > 컬럼) */}
      <div style={{ width: 260, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid #333', minHeight: 0 }}>
        <div style={{ padding: 8, borderBottom: '1px solid #333', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontWeight: 600 }}>🗂 스키마</span>
          <button
            onClick={() => { treeItemsRef.current.clear(); setTreeRev(v => v + 1); loadSchemas(); }}
            disabled={!connected}
            title="전체 새로고침"
            style={{ marginLeft: 'auto', background: 'transparent', color: '#aaa', border: '1px solid #444', cursor: 'pointer', padding: '2px 6px', borderRadius: 3 }}
          >↻</button>
        </div>
        <input value={tableFilter} onChange={e => setTableFilter(e.target.value)} placeholder="이름 검색..." style={{ margin: 6, padding: 4, background: '#2a2a2a', color: '#ddd', border: '1px solid #444', borderRadius: 3 }} />
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 4px 4px', fontSize: 12, fontFamily: 'monospace' }}>
          {(() => {
            void treeRev; void columnsRev; // 캐시 갱신 시 재렌더 트리거
            const filt = (s: string) => !tableFilter || s.toLowerCase().includes(tableFilter.toLowerCase());
            const rowStyle = (depth: number): React.CSSProperties => ({ padding: '2px 4px', paddingLeft: 4 + depth * 12, cursor: 'pointer', userSelect: 'none', display: 'flex', alignItems: 'center', gap: 4, borderRadius: 3 });
            const caret = (open: boolean) => <span style={{ width: 10, display: 'inline-block', color: '#888' }}>{open ? '▼' : '▶'}</span>;
            const hover = {
              onMouseEnter: (e: React.MouseEvent<HTMLDivElement>) => (e.currentTarget.style.background = '#2d2d2d'),
              onMouseLeave: (e: React.MouseEvent<HTMLDivElement>) => (e.currentTarget.style.background = 'transparent'),
            };

            // 컬럼 노드 렌더 (테이블/뷰 펼침 시)
            const renderColumns = (objName: string, depth: number) => {
              const cols = columnsByTableRef.current.get(objName.toUpperCase());
              if (!cols) return <div style={{ paddingLeft: 4 + depth * 12, color: '#888' }}>로딩...</div>;
              if (cols.length === 0) return <div style={{ paddingLeft: 4 + depth * 12, color: '#666' }}>컬럼 없음</div>;
              return cols.map(c => (
                <div key={c.name} draggable
                  title={`드래그: '${objName}.${c.name}' 삽입${c.typeText ? `\n타입: ${c.typeText}` : ''}${c.nullable ? '' : '\nNOT NULL'}`}
                  onDragStart={e => { const text = `${objName}.${c.name}`; e.dataTransfer.setData('text/plain', text); e.dataTransfer.setData('application/x-pepe-sql-table', text); e.dataTransfer.effectAllowed = 'copy'; }}
                  onDoubleClick={() => insertAtCursor(`${objName}.${c.name}`)}
                  style={{ ...rowStyle(depth), cursor: 'grab' }} {...hover}
                >
                  <span style={{ width: 10, display: 'inline-block' }} />
                  <span style={{ color: c.nullable ? '#d4d4d4' : '#ffd680' }}>{c.name}</span>
                  {c.typeText && <span style={{ marginLeft: 'auto', color: '#888', fontSize: 11 }}>{c.typeText}</span>}
                </div>
              ));
            };

            // 객체 노드 (테이블/뷰는 컬럼 펼침 + 더블클릭 상세, 나머지는 단순 삽입)
            const renderObject = (schema: string, groupId: string, name: string, icon: string, insert: (n: string) => string, depth: number) => {
              const expandable = groupId === 'TABLE' || groupId === 'VIEW' || groupId === 'SYSTABLE';
              const nodeId = `obj:${schema}:${groupId}:${name}`;
              const open = isExpanded(nodeId);
              return (
                <div key={nodeId}>
                  <div draggable
                    title={expandable ? '클릭: 컬럼 펼침 / 더블클릭: 상세 / 드래그: 이름 삽입' : '더블클릭: 삽입 / 드래그: 이름 삽입'}
                    onDragStart={e => { e.dataTransfer.setData('text/plain', name); e.dataTransfer.setData('application/x-pepe-sql-table', name); e.dataTransfer.effectAllowed = 'copy'; }}
                    onClick={() => { if (expandable) { toggleExpanded(nodeId); if (!open && !columnsByTableRef.current.get(name.toUpperCase())) loadColumns(name); } }}
                    onDoubleClick={() => {
                      const kindMap: Record<string, ObjectKind | null> = { TABLE: 'table', VIEW: 'view', SYSTABLE: 'table', INDEX: 'index', SEQUENCE: 'sequence', PROCEDURE: 'procedure', FUNCTION: 'function' };
                      const k = kindMap[groupId];
                      // INDEX 노드는 "TABLE.INDEX" 형식 — indexDetail 에는 인덱스명만 전달
                      const detailName = (k === 'index' && name.includes('.')) ? name.split('.').slice(-1)[0] : name;
                      if (k) openObjectDetail(detailName, k, schema);
                      else insertAtCursor(insert(name));
                    }}
                    style={{ ...rowStyle(depth), cursor: expandable ? 'pointer' : 'grab' }} {...hover}
                  >
                    {expandable ? caret(open) : <span style={{ width: 10, display: 'inline-block' }} />}
                    <span>{icon} {name}</span>
                  </div>
                  {expandable && open && <div>{renderColumns(name, depth + 1)}</div>}
                </div>
              );
            };

            // 그룹 노드 (테이블/뷰/시퀀스/...) — 스키마 밑
            const renderGroupNode = (schema: string, g: typeof OBJECT_GROUPS[number], depth: number) => {
              const gid = `group:${schema}:${g.id}`;
              const key = `${schema} ${g.id}`;
              const open = isExpanded(gid);
              const items = treeItemsRef.current.get(key);
              const loading = treeLoadingRef.current.has(key);
              const filtered = (items || []).filter(filt);
              return (
                <div key={gid}>
                  <div
                    onClick={() => { toggleExpanded(gid); if (!open && !items) loadTreeNode(key, () => g.load(schema)); }}
                    style={{ ...rowStyle(depth), color: '#9cdcfe' }} {...hover}
                  >
                    {caret(open)}
                    <span>{g.icon} {g.label}</span>
                    <span style={{ marginLeft: 'auto', color: '#666', fontSize: 11 }}>{loading ? '…' : (items ? items.length : '')}</span>
                  </div>
                  {open && (
                    <div>
                      {loading && <div style={{ paddingLeft: 4 + (depth + 1) * 12, color: '#888' }}>로딩...</div>}
                      {!loading && items && filtered.length === 0 && <div style={{ paddingLeft: 4 + (depth + 1) * 12, color: '#666' }}>없음</div>}
                      {filtered.map(n => renderObject(schema, g.id, n, g.icon, g.insert, depth + 1))}
                    </div>
                  )}
                </div>
              );
            };

            // 스키마 노드
            const renderSchema = (schema: string, depth: number) => {
              const sid = `schema:${schema}`;
              const open = isExpanded(sid);
              return (
                <div key={sid}>
                  <div onClick={() => toggleExpanded(sid)} style={{ ...rowStyle(depth), color: '#dcdcaa', fontWeight: 600 }} {...hover}>
                    {caret(open)}
                    <span>👤 {schema}</span>
                  </div>
                  {open && <div>{OBJECT_GROUPS.map(g => renderGroupNode(schema, g, depth + 1))}</div>}
                </div>
              );
            };

            // Global metadata — user 소유가 아닌 공용 객체 (Public Synonyms 등)
            const renderGlobalGroup = (gid: string, icon: string, label: string, loader: () => Promise<string[]>, insert: (n: string) => string, depth: number) => {
              const nid = `global:${gid}`;
              const key = `__global__ ${gid}`;
              const open = isExpanded(nid);
              const items = treeItemsRef.current.get(key);
              const loading = treeLoadingRef.current.has(key);
              const filtered = (items || []).filter(filt);
              return (
                <div key={nid}>
                  <div
                    onClick={() => { toggleExpanded(nid); if (!open && !items) loadTreeNode(key, loader); }}
                    style={{ ...rowStyle(depth), color: '#9cdcfe' }} {...hover}
                  >
                    {caret(open)}
                    <span>{icon} {label}</span>
                    <span style={{ marginLeft: 'auto', color: '#666', fontSize: 11 }}>{loading ? '…' : (items ? items.length : '')}</span>
                  </div>
                  {open && (
                    <div>
                      {loading && <div style={{ paddingLeft: 4 + (depth + 1) * 12, color: '#888' }}>로딩...</div>}
                      {!loading && items && filtered.length === 0 && <div style={{ paddingLeft: 4 + (depth + 1) * 12, color: '#666' }}>없음</div>}
                      {filtered.map(n => (
                        <div key={n} draggable
                          title={gid === 'PUBSYN' ? '더블클릭: Public Synonym 상세' : '더블클릭: 삽입 / 드래그: 이름 삽입'}
                          onDragStart={e => { e.dataTransfer.setData('text/plain', n); e.dataTransfer.setData('application/x-pepe-sql-table', n); e.dataTransfer.effectAllowed = 'copy'; }}
                          onDoubleClick={() => {
                            if (gid === 'PUBSYN') openObjectDetail(n, 'synonym', '');
                            else insertAtCursor(insert(n));
                          }}
                          style={{ ...rowStyle(depth + 1), cursor: gid === 'PUBSYN' ? 'pointer' : 'grab' }} {...hover}
                        >
                          <span style={{ width: 10, display: 'inline-block' }} />
                          <span>{icon} {n}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            };
            // 저장소(테이블스페이스) — 루트 레벨 노드 (스키마와 동일 depth). DBeaver "Storage" 와 동일 위치.
            const renderStorageRoot = () => {
              const dialectIs = backend?.type;
              const supports = dialectIs === 'altibase' || dialectIs === 'oracle' || dialectIs === 'postgres' || dialectIs === 'mssql';
              if (!supports) return null;
              const sid = 'storage-root';
              const open = isExpanded(`schema:${sid}`);
              const tbsKey = '__storage__ TABLESPACE';
              const items = treeItemsRef.current.get(tbsKey);
              const tbsOpen = isExpanded(`storage:TABLESPACE`);
              const loading = treeLoadingRef.current.has(tbsKey);
              const filtered = (items || []).filter(filt);
              return (
                <div key="storage-root">
                  <div onClick={() => toggleExpanded(`schema:${sid}`)} style={{ ...rowStyle(0), color: '#dcdcaa', fontWeight: 600 }} {...hover}>
                    {caret(open)}
                    <span>💾 저장소</span>
                  </div>
                  {open && (
                    <div>
                      <div
                        onClick={() => { toggleExpanded(`storage:TABLESPACE`); if (!tbsOpen && !items) loadTreeNode(tbsKey, () => backend?.listTablespaces() ?? Promise.resolve([])); }}
                        style={{ ...rowStyle(1), color: '#9cdcfe' }} {...hover}
                      >
                        {caret(tbsOpen)}
                        <span>📂 테이블스페이스</span>
                        <span style={{ marginLeft: 'auto', color: '#666', fontSize: 11 }}>{loading ? '…' : (items ? items.length : '')}</span>
                      </div>
                      {tbsOpen && (
                        <div>
                          {loading && <div style={{ paddingLeft: 4 + 2 * 12, color: '#888' }}>로딩...</div>}
                          {!loading && items && filtered.length === 0 && <div style={{ paddingLeft: 4 + 2 * 12, color: '#666' }}>없음</div>}
                          {filtered.map(n => (
                            <div key={n} draggable
                              title="드래그: 이름 삽입"
                              onDragStart={e => { e.dataTransfer.setData('text/plain', n); e.dataTransfer.effectAllowed = 'copy'; }}
                              onDoubleClick={() => insertAtCursor(n)}
                              style={{ ...rowStyle(2), cursor: 'grab' }} {...hover}
                            >
                              <span style={{ width: 10, display: 'inline-block' }} />
                              <span>💾 {n}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            };
            const renderGlobalMetadata = () => {
              const dialectIs = backend?.type;
              const hasPubSyn = dialectIs === 'altibase' || dialectIs === 'oracle';
              const hasReplications = dialectIs === 'altibase';
              if (!hasPubSyn && !hasReplications) return null;
              const gid = 'global-meta';
              const open = isExpanded(`schema:${gid}`);
              return (
                <div key="global-meta">
                  <div onClick={() => toggleExpanded(`schema:${gid}`)} style={{ ...rowStyle(0), color: '#dcdcaa', fontWeight: 600 }} {...hover}>
                    {caret(open)}
                    <span>🌐 Global metadata</span>
                  </div>
                  {open && (
                    <div>
                      {hasPubSyn && renderGlobalGroup('PUBSYN', '🔗', 'Public Synonyms', () => backend?.listPublicSynonyms() ?? Promise.resolve([]), (n) => n, 1)}
                      {hasReplications && renderGlobalGroup('REPL', '🔄', '이중화 객체', () => backend?.listReplications() ?? Promise.resolve([]), (n) => n, 1)}
                    </div>
                  )}
                </div>
              );
            };

            if (schemasLoading) return <div style={{ color: '#888', padding: 6 }}>스키마 로딩...</div>;
            // 스키마가 없는 DBMS(SQLite 등) — 그룹을 최상위로 평탄 표시 (schema='' 전달)
            if (schemas.length === 0) {
              return <div>{OBJECT_GROUPS.map(g => renderGroupNode('', g, 0))}</div>;
            }
            return <div>{schemas.map(s => renderSchema(s, 0))}{renderStorageRoot()}{renderGlobalMetadata()}</div>;
          })()}
        </div>
      </div>

      {/* 중앙: 에디터 + 결과 */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
        <div style={{ padding: 8, borderBottom: '1px solid #333', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600 }}>🗄️ {sessionName}</span>
          {session?.dbms && (
            <span style={{ color: '#888', fontSize: 11 }}>
              {session.dbms.user}@{session.dbms.host || '127.0.0.1'}:{session.dbms.port}
            </span>
          )}
          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: connected ? '#4caf50' : connecting ? '#ff9800' : '#888' }} />
            <span style={{ fontSize: 11, color: '#888' }}>{connected ? '연결됨' : connecting ? '연결 중' : '연결 안됨'}</span>
            {!connected && !connecting && <button onClick={connect} style={{ marginLeft: 6, background: '#0e639c', color: '#fff', border: 0, padding: '3px 8px', borderRadius: 3, cursor: 'pointer' }}>연결</button>}
            <button
              onClick={async () => {
                try {
                  const api: any = (window as any).api || {};
                  const r: any = await api.jdbcPing?.();
                  const drivers: any[] = await api.jdbcListDrivers?.() || [];
                  const roots: any = await api.jdbcDriverRoots?.() || {};
                  const driverLines = drivers.map(d => {
                    const usable = d.diag?.usable;
                    const status = usable ? '✓' : '✗';
                    const missingPart = d.diag?.missing?.length
                      ? ` (누락: ${(d.diag.missing as string[]).map(p => p.replace(roots.bundled || '', '${bundled}').replace(roots.user || '', '${userJdbc}')).join(', ')})`
                      : '';
                    return `  ${status} ${d.name} [${d.dialect}]${missingPart}`;
                  });
                  if (r?.success) {
                    const v = r.result || {};
                    // 추가로: usable 드라이버 각각에 loadDriver 시도 (실제 DB 없이도 Driver 클래스 로드 검증)
                    const loadResults: string[] = [];
                    for (const d of drivers) {
                      if (!d.diag?.usable) { loadResults.push(`  ✗ ${d.name}: JAR 누락`); continue; }
                      try {
                        const lr: any = await api.jdbcLoadDriver?.(d);
                        if (lr?.success) loadResults.push(`  ✓ ${d.name}: ${d.className} 로드 OK`);
                        else loadResults.push(`  ✗ ${d.name}: ${lr?.error || '?'}`);
                      } catch (le: any) {
                        loadResults.push(`  ✗ ${d.name}: ${le?.message || le}`);
                      }
                    }
                    alert(
                      `✅ JDBC 사이드카 OK\n` +
                      `버전: ${v.version}\nJava: ${v.javaVersion} (${v.javaVendor})\nOS: ${v.os}\n\n` +
                      `JAR: ${r.jar || '(미발견)'}\nJava bin: ${r.java || '(기본)'}\n\n` +
                      `등록된 드라이버 (${drivers.length}):\n${driverLines.join('\n')}\n\n` +
                      `loadDriver 검증:\n${loadResults.join('\n')}\n\n` +
                      `bundled: ${roots.bundled || '(?)'}\nuser:    ${roots.user || '(?)'}`
                    );
                  } else {
                    alert(`❌ JDBC 사이드카 실패\n${r?.error || '?'}\n\nJAR: ${r?.jar || '(미발견)'}\nJava bin: ${r?.java || '(기본)'}`);
                  }
                } catch (e: any) {
                  alert(`❌ JDBC 사이드카 예외: ${e?.message || e}`);
                }
              }}
              title="Java 사이드카 ping + 등록된 드라이버 진단 (Driver Manager 도착 전 임시 진단)"
              style={{ marginLeft: 6, background: 'transparent', color: '#bbb', border: '1px solid #444', padding: '2px 6px', borderRadius: 3, cursor: 'pointer', fontSize: 11 }}
            >🧪 JDBC ping</button>
            <button
              onClick={() => setDriverManagerOpen(true)}
              title="JDBC 드라이버 관리자 — 등록된 드라이버 편집/JAR 가져오기/테스트 로드"
              style={{ marginLeft: 4, background: 'transparent', color: '#bbb', border: '1px solid #444', padding: '2px 6px', borderRadius: 3, cursor: 'pointer', fontSize: 11 }}
            >🗂 드라이버 관리자</button>
          </span>
        </div>
        {connectError && <div style={{ background: '#5a1d1d', color: '#fcc', padding: 6, fontSize: 12 }}>{connectError}</div>}
        <div style={{ padding: 6, borderBottom: '1px solid #333', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={runCurrent} disabled={!connected || running} style={{ background: running ? '#555' : '#0e639c', color: '#fff', border: 0, padding: '4px 12px', borderRadius: 3, cursor: running ? 'wait' : 'pointer' }} title="Ctrl+Enter — 선택 영역(있으면)/없으면 커서 위치 문장 실행">
            {running ? '실행 중...' : '▶ 실행 (Ctrl+Enter)'}
          </button>
          <button onClick={runAll} disabled={!connected || running} style={{ background: '#3a7d3a', color: '#fff', border: 0, padding: '4px 12px', borderRadius: 3, cursor: running ? 'wait' : 'pointer' }} title="Ctrl+Shift+Enter — 모든 문장 순차 실행">
            ▶▶ 전체 실행
          </button>
          <button onClick={formatSql} disabled={!sql.trim()} style={{ background: '#444', color: '#fff', border: 0, padding: '4px 10px', borderRadius: 3, cursor: 'pointer' }} title="Ctrl+Shift+F — SQL 포맷">
            🪄 포맷
          </button>
          <button onClick={runExplain} disabled={!connected || running} style={{ background: '#444', color: '#fff', border: 0, padding: '4px 10px', borderRadius: 3, cursor: 'pointer' }} title="실행 계획(EXPLAIN) — 결과는 새 'Plan' 탭으로 보관">
            🔍 Plan
          </button>
          <button onClick={saveCurrentSqlAsFavorite} disabled={!sql.trim()} style={{ background: '#444', color: '#fff', border: 0, padding: '4px 10px', borderRadius: 3, cursor: 'pointer' }} title="Ctrl+S — 현재 SQL 을 즐겨찾기에 저장">
            ⭐ 저장
          </button>
          <div style={{ position: 'relative' }}>
            <button onClick={() => setFavPanelOpen(v => !v)} style={{ background: '#444', color: '#fff', border: 0, padding: '4px 10px', borderRadius: 3, cursor: 'pointer' }} title="즐겨찾기 목록 열기">
              📚 즐겨찾기 ({favorites.length})
            </button>
            {favPanelOpen && (
              <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, width: 340, maxHeight: 400, overflow: 'auto', background: '#252526', border: '1px solid #444', borderRadius: 4, zIndex: 50, boxShadow: '0 4px 12px rgba(0,0,0,0.4)' }}>
                {favorites.length === 0 && <div style={{ padding: 12, color: '#888', fontSize: 12 }}>저장된 즐겨찾기가 없습니다.</div>}
                {favorites.map(f => (
                  <div key={f.id} style={{ padding: 8, borderBottom: '1px solid #333', display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontWeight: 600, fontSize: 12, color: '#9cdcfe', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                      <button onClick={() => { setSql(() => f.sql); setFavPanelOpen(false); }} title="에디터에 로드" style={{ background: '#0e639c', color: '#fff', border: 0, padding: '1px 6px', borderRadius: 2, cursor: 'pointer', fontSize: 11 }}>로드</button>
                      <button onClick={() => setNameModal({ mode: 'rename', value: f.name, id: f.id })} title="이름 변경" style={{ background: '#444', color: '#ddd', border: 0, padding: '1px 6px', borderRadius: 2, cursor: 'pointer', fontSize: 11 }}>✎</button>
                      <button onClick={() => { if (confirm(`삭제: ${f.name}?`)) setFavorites(prev => prev.filter(x => x.id !== f.id)); }} title="삭제" style={{ background: '#5a1d1d', color: '#fff', border: 0, padding: '1px 6px', borderRadius: 2, cursor: 'pointer', fontSize: 11 }}>×</button>
                    </div>
                    <code style={{ color: '#aaa', fontSize: 10, fontFamily: 'monospace', whiteSpace: 'pre-wrap', overflow: 'hidden', maxHeight: 40 }}>{f.sql.slice(0, 200)}{f.sql.length > 200 ? '...' : ''}</code>
                  </div>
                ))}
              </div>
            )}
          </div>
          {running && (
            <button
              onClick={() => { runIdRef.current++; setRunning(false); setResult(prev => prev ? { ...prev, affectedText: '✕ 사용자 취소' } : null); }}
              style={{ background: '#a33', color: '#fff', border: 0, padding: '4px 10px', borderRadius: 3, cursor: 'pointer' }}
              title="실행 중인 쿼리 결과 무시 — 서버에서는 계속 돌지만 UI 는 즉시 반환"
            >
              ⏹ 취소
            </button>
          )}
          <button onClick={onSaveCsv} disabled={!displayedResult || displayedResult.columns.length === 0} style={{ background: '#444', color: '#fff', border: 0, padding: '4px 10px', borderRadius: 3, cursor: 'pointer' }} title="결과를 CSV 파일로 저장">
            💾 CSV
          </button>
          <button onClick={onSaveJson} disabled={!displayedResult || displayedResult.columns.length === 0} style={{ background: '#444', color: '#fff', border: 0, padding: '4px 10px', borderRadius: 3, cursor: 'pointer' }} title="결과를 JSON 파일로 저장">
            💾 JSON
          </button>
          <button onClick={onCopyClipboard} disabled={!displayedResult || displayedResult.columns.length === 0} style={{ background: '#444', color: '#fff', border: 0, padding: '4px 10px', borderRadius: 3, cursor: 'pointer' }} title="결과를 TSV 로 클립보드 복사 (Excel 붙여넣기 호환)">
            📋 클립보드로 복사
          </button>
          <button onClick={onCopyImage} disabled={!displayedResult || displayedResult.columns.length === 0} style={{ background: '#444', color: '#fff', border: 0, padding: '4px 10px', borderRadius: 3, cursor: 'pointer' }} title="결과를 PNG 이미지로 클립보드 복사">
            🖼 이미지로 복사
          </button>
          <button
            onClick={onAutoGenerate}
            disabled={generating || !sql.trim()}
            title="편집창의 요청/메모를 Claude agent 에 보내 SQL 을 생성하고 편집창 하단에 추가"
            style={{ background: generating ? '#555' : '#6f4ab3', color: '#fff', border: 0, padding: '4px 10px', borderRadius: 3, cursor: generating ? 'wait' : 'pointer' }}
          >
            {generating ? '🤖 생성 중...' : '🤖 AI 자동생성'}
          </button>
          {copyHint && <span style={{ color: '#9cdcfe', fontSize: 11, marginLeft: 6 }}>{copyHint}</span>}
        </div>
        {/* SQL 에디터 탭 바 */}
        <div style={{ display: 'flex', alignItems: 'stretch', background: '#252526', borderBottom: '1px solid #333', minHeight: 28 }}>
          <div style={{ display: 'flex', flex: 1, overflowX: 'auto' }}>
            {editorTabs.map(t => {
              const active = t.id === activeEditorTabId;
              const isRenaming = renamingTabId === t.id;
              const commitRename = () => {
                const v = renameDraft.trim() || t.title;
                setEditorTabs(prev => prev.map(x => x.id === t.id ? { ...x, title: v } : x));
                setRenamingTabId('');
              };
              return (
                <div
                  key={t.id}
                  onClick={() => setActiveEditorTabId(t.id)}
                  onDoubleClick={() => { setRenamingTabId(t.id); setRenameDraft(t.title); }}
                  title="더블클릭: 이름 변경"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '2px 10px', cursor: 'pointer', fontSize: 12,
                    background: active ? '#1e1e1e' : 'transparent',
                    color: active ? '#fff' : '#bbb',
                    borderRight: '1px solid #333',
                    borderTop: active ? '2px solid #0e639c' : '2px solid transparent',
                    minWidth: 80, maxWidth: 200,
                  }}
                >
                  {isRenaming ? (
                    <input
                      autoFocus
                      value={renameDraft}
                      onChange={e => setRenameDraft(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={e => {
                        if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                        else if (e.key === 'Escape') { e.preventDefault(); setRenamingTabId(''); }
                      }}
                      onClick={e => e.stopPropagation()}
                      style={{ flex: 1, minWidth: 60, background: '#1e1e1e', color: '#fff', border: '1px solid #555', borderRadius: 2, padding: '0 4px', fontSize: 12 }}
                    />
                  ) : (
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{t.title}</span>
                  )}
                  {editorTabs.length > 1 && !isRenaming && (
                    <span
                      onClick={e => {
                        e.stopPropagation();
                        setEditorTabs(prev => {
                          const next = prev.filter(x => x.id !== t.id);
                          if (next.length === 0) return [{ id: newTabId(), title: 'Query 1', sql: '' }];
                          return next;
                        });
                        // 활성 탭이 닫혔으면 인접 탭으로
                        if (activeEditorTabId === t.id) {
                          const idx = editorTabs.findIndex(x => x.id === t.id);
                          const neighbour = editorTabs[idx + 1] || editorTabs[idx - 1];
                          if (neighbour) setActiveEditorTabId(neighbour.id);
                        }
                      }}
                      title="탭 닫기"
                      style={{ color: '#888', fontSize: 14, lineHeight: 1, padding: '0 2px', borderRadius: 2 }}
                      onMouseEnter={e => (e.currentTarget.style.background = '#444')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >×</span>
                  )}
                </div>
              );
            })}
          </div>
          <button
            onClick={() => {
              const id = newTabId();
              setEditorTabs(prev => [...prev, { id, title: `Query ${prev.length + 1}`, sql: '' }]);
              setActiveEditorTabId(id);
            }}
            title="새 SQL 탭"
            style={{ background: 'transparent', color: '#9cdcfe', border: 0, borderLeft: '1px solid #333', padding: '0 12px', cursor: 'pointer', fontSize: 14 }}
          >＋</button>
        </div>
        {activeTab?.kind === 'object' && activeTab.objectName && activeTab.objectKind ? (
          <ObjectDetailPanel
            tab={activeTab}
            backend={backend}
            connected={connected}
            running={running}
            colsCacheRef={columnsByTableRef}
            pksCacheRef={pksByTableRef}
            defsCacheRef={definitionsRef}
            inflightDefRef={inflightDefRef}
            detailCacheRef={objectDetailCacheRef}
            columnsRev={columnsRev}
            pkRev={pkRev}
            defRev={defRev}
            objDetailRev={objDetailRev}
            setDefRev={setDefRev}
            setObjDetailRev={setObjDetailRev}
            loadColumns={loadColumns}
            loadPrimaryKey={loadPrimaryKey}
            loadDefinition={loadDefinition}
            runSql={runSql}
            setActiveEditorTabId={setActiveEditorTabId}
            onSubTab={(sub) => setObjectSubTab(activeTab.id, sub)}
            onPropSubTab={(sub) => setObjectPropSubTab(activeTab.id, sub)}
          />
        ) : (
        <div
          style={{ flex: '0 0 35%', minHeight: 80, borderBottom: '1px solid #333', position: 'relative' }}
          onDragOver={e => {
            if (!(e.dataTransfer.types.includes('application/x-pepe-sql-table') || e.dataTransfer.types.includes('text/plain'))) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
          }}
          onDrop={e => {
            const text = e.dataTransfer.getData('application/x-pepe-sql-table') || e.dataTransfer.getData('text/plain');
            if (!text) return;
            e.preventDefault();
            insertAtClientPoint(text, e.clientX, e.clientY);
          }}
        >
          <Editor
            height="100%"
            language="sql"
            theme="vs-dark"
            value={sql}
            onChange={v => setSql(v ?? '')}
            onMount={handleEditorMount}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              fontFamily: 'monospace',
              lineNumbers: 'on',
              renderLineHighlight: 'line',
              scrollBeyondLastLine: false,
              automaticLayout: true,
              wordWrap: 'on',
              tabSize: 2,
              quickSuggestions: { other: true, comments: false, strings: false },
              suggestOnTriggerCharacters: true,
              acceptSuggestionOnEnter: 'on',
            }}
          />
        </div>)}
        <div style={{ flex: 1, overflow: 'hidden', minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {/* 결과 탭 스트립 — 현재 + 핀된 스냅샷 */}
          {(pinnedSnapshots.length > 0 || result) && (
            <div style={{ display: 'flex', alignItems: 'stretch', background: '#252526', borderBottom: '1px solid #333', minHeight: 26, overflowX: 'auto' }}>
              <div
                onClick={() => setViewingTabId('current')}
                title="라이브 결과 (실행 시 갱신)"
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '2px 10px', cursor: 'pointer', fontSize: 11,
                  background: viewingTabId === 'current' ? '#1e1e1e' : 'transparent',
                  color: viewingTabId === 'current' ? '#fff' : '#aaa',
                  borderRight: '1px solid #333',
                  borderTop: viewingTabId === 'current' ? '2px solid #4caf50' : '2px solid transparent',
                  whiteSpace: 'nowrap',
                }}
              >
                ▶ 현재
                <span
                  onClick={e => { e.stopPropagation(); pinCurrentResult(); }}
                  title="현재 결과 스냅샷으로 핀 (이후 새 쿼리 실행해도 보존)"
                  style={{ marginLeft: 2, opacity: result ? 1 : 0.3, cursor: result ? 'pointer' : 'not-allowed' }}
                >📌</span>
              </div>
              {pinnedSnapshots.map(s => {
                const active = viewingTabId === s.id;
                return (
                  <div
                    key={s.id}
                    onClick={() => setViewingTabId(s.id)}
                    title={`${s.sql.slice(0, 120)}\n${new Date(s.ts).toLocaleString()}`}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      padding: '2px 10px', cursor: 'pointer', fontSize: 11,
                      background: active ? '#1e1e1e' : 'transparent',
                      color: active ? '#fff' : '#aaa',
                      borderRight: '1px solid #333',
                      borderTop: active ? '2px solid #c97a2a' : '2px solid transparent',
                      minWidth: 80, maxWidth: 220, whiteSpace: 'nowrap', overflow: 'hidden',
                    }}
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>📌 {s.title}</span>
                    <span
                      onClick={e => { e.stopPropagation(); closeSnapshot(s.id); }}
                      title="탭 닫기"
                      style={{ color: '#888', fontSize: 13, lineHeight: 1, padding: '0 2px' }}
                      onMouseEnter={e => (e.currentTarget.style.background = '#444')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >×</span>
                  </div>
                );
              })}
            </div>
          )}
          <div style={{ flex: 1, overflow: 'auto', minHeight: 0, minWidth: 0, position: 'relative' }}>
          {displayedResultError && (
            <div style={{ background: '#5a1d1d', color: '#fcc', padding: 8, fontSize: 12, fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>{displayedResultError}</div>
          )}
          {displayedResult && displayedResult.columns.length > 0 && (
            <>
              {/* 헤더 우상단 floating 컨트롤 — 스냅샷 뷰에서는 숨김(읽기전용) */}
              {!isPinnedView && (() => {
                const pkCols = pksByTableRef.current.get(lastTable.toUpperCase()) || [];
                void pkRev;
                const pendingTotal = edits.size + newRows.length + deletedRowIdxs.size;
                const enabled = pendingTotal > 0 && !!displayedLastTable;
                const summaryPieces = [
                  edits.size ? `${edits.size}셀 수정` : '',
                  newRows.length ? `${newRows.length}건 삽입` : '',
                  deletedRowIdxs.size ? `${deletedRowIdxs.size}건 삭제` : '',
                ].filter(Boolean);
                return (
                  <div style={{ position: 'sticky', top: 6, float: 'right', marginRight: 8, marginTop: 6, zIndex: 5, display: 'flex', gap: 6, alignItems: 'center' }}>
                    {displayedLastTable && (
                      <span title={pkCols.length > 0 ? `PK: ${pkCols.join(', ')} (UPDATE/DELETE WHERE 에 사용)` : 'PK 미감지 — 모든 컬럼 매칭 폴백'} style={{ fontSize: 10, color: pkCols.length > 0 ? '#9cdcfe' : '#e0a060', background: '#2a2a2a', border: '1px solid #444', padding: '2px 6px', borderRadius: 3 }}>
                        {pkCols.length > 0 ? `🔑 ${pkCols.join(',')}` : '⚠ no PK'}
                      </span>
                    )}
                    <button
                      onClick={() => setNewRows(prev => [...prev, displayedResult ? displayedResult.columns.map(() => '') : []])}
                      disabled={!displayedLastTable || !displayedResult}
                      title="비어 있는 새 행 추가 (적용 시 INSERT)"
                      style={{ background: '#3a7d3a', color: '#fff', border: 0, padding: '4px 10px', borderRadius: 3, cursor: displayedLastTable ? 'pointer' : 'not-allowed', fontSize: 11, fontWeight: 600 }}
                    >+ 새 행</button>
                    <button
                      onClick={onApplyChanges}
                      disabled={!enabled || applying}
                      title={!displayedLastTable ? '단일 테이블 SELECT 결과에서만 사용 가능' : pendingTotal === 0 ? '변경 사항 없음' : `${summaryPieces.join(' / ')} → 단일 트랜잭션 적용`}
                      style={{ background: enabled ? '#c97a2a' : '#888', color: '#fff', border: 0, padding: '4px 12px', borderRadius: 3, cursor: enabled ? 'pointer' : 'not-allowed', fontSize: 11, fontWeight: 600, boxShadow: '0 2px 6px rgba(0,0,0,0.25)' }}
                    >
                      {applying ? '적용 중...' : `✔ 적용하기${pendingTotal > 0 ? ` (${pendingTotal})` : ''}`}
                    </button>
                  </div>
                );
              })()}
              <table style={{ borderCollapse: 'separate', borderSpacing: 0, width: 'max-content', minWidth: '100%', fontFamily: 'monospace', fontSize: 12, color: '#d4d4d4' }}>
                <thead>
                  <tr>
                    {/* # 컬럼: 항상 좌상단 sticky */}
                    <th style={{ position: 'sticky', top: 0, left: 0, background: '#2d2d2d', color: '#9cdcfe', padding: '5px 10px', textAlign: 'center', border: '1px solid #3f3f46', fontWeight: 600, zIndex: 5, width: INDEX_COL_W, minWidth: INDEX_COL_W }}>#</th>
                    {displayedResult.columns.map((c, i) => {
                      const sortDir = sortState?.col === i ? sortState.dir : null;
                      const sortIcon = sortDir === 'asc' ? '▲' : sortDir === 'desc' ? '▼' : '';
                      const pinned = pinnedCols.has(i);
                      const w = getColWidth(i);
                      return (
                        <th
                          key={i}
                          onClick={() => setSortState(prev => {
                            if (!prev || prev.col !== i) return { col: i, dir: 'asc' };
                            if (prev.dir === 'asc') return { col: i, dir: 'desc' };
                            return null; // asc → desc → 없음
                          })}
                          title="클릭: 정렬 (오름→내림→해제)"
                          style={{
                            position: 'sticky', top: 0,
                            ...(pinned ? { left: pinnedLeftFor(i), zIndex: 4 } : { zIndex: 2 }),
                            background: '#2d2d2d', color: '#9cdcfe', padding: '5px 12px', textAlign: 'left', border: '1px solid #3f3f46', borderLeft: 0, fontWeight: 600, whiteSpace: 'nowrap', cursor: 'pointer', userSelect: 'none',
                            width: w, minWidth: w, maxWidth: w, overflow: 'hidden',
                          }}
                        >
                          <span
                            onClick={e => { e.stopPropagation(); togglePin(i); }}
                            title={pinned ? '고정 해제' : '좌측 고정'}
                            style={{ marginRight: 4, opacity: pinned ? 1 : 0.4, cursor: 'pointer' }}
                          >📌</span>
                          {c}{sortIcon ? ` ${sortIcon}` : ''}
                          {/* 우측 리사이즈 핸들 */}
                          <span
                            onMouseDown={(e) => beginColResize(i, e)}
                            onClick={e => e.stopPropagation()}
                            title="드래그: 컬럼 폭 조절 (더블클릭: 기본)"
                            onDoubleClick={e => { e.stopPropagation(); setColWidths(prev => { const n = new Map(prev); n.delete(i); return n; }); }}
                            style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 6, cursor: 'col-resize', userSelect: 'none' }}
                          />
                        </th>
                      );
                    })}
                  </tr>
                  {/* 컬럼별 필터 행 */}
                  <tr>
                    <th style={{ position: 'sticky', top: 28, left: 0, background: '#252526', border: '1px solid #3f3f46', borderTop: 0, padding: 0, zIndex: 5 }} title="필터 행" />
                    {displayedResult.columns.map((_c, i) => {
                      const pinned = pinnedCols.has(i);
                      const w = getColWidth(i);
                      return (
                      <th key={i} style={{
                        position: 'sticky', top: 28,
                        ...(pinned ? { left: pinnedLeftFor(i), zIndex: 4 } : { zIndex: 2 }),
                        background: '#252526', border: '1px solid #3f3f46', borderTop: 0, borderLeft: 0, padding: 2,
                        width: w, minWidth: w, maxWidth: w,
                      }}>
                        <input
                          value={colFilters.get(i) || ''}
                          onChange={e => {
                            const v = e.target.value;
                            setColFilters(prev => {
                              const n = new Map(prev);
                              if (v) n.set(i, v); else n.delete(i);
                              return n;
                            });
                          }}
                          placeholder="🔍"
                          spellCheck={false}
                          style={{ width: '100%', boxSizing: 'border-box', background: '#1e1e1e', color: '#d4d4d4', border: '1px solid #3f3f46', borderRadius: 2, padding: '2px 4px', fontSize: 11, fontFamily: 'monospace', outline: 'none' }}
                        />
                      </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {viewRowIndices.map((i, displayIdx) => {
                    const row = displayedResult.rows[i];
                    const isDeleted = !isPinnedView && deletedRowIdxs.has(i);
                    return (
                    <tr key={i}>
                      <td title={`원본 행 #${i + 1}${isDeleted ? ' (삭제 표시)' : ''}`} style={{ position: 'sticky', left: 0, zIndex: 1, padding: 0, color: '#888', background: isDeleted ? '#3a1d1d' : '#252525', border: '1px solid #3f3f46', borderTop: 0, textAlign: 'center', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', width: INDEX_COL_W, minWidth: INDEX_COL_W }}>
                        {isPinnedView ? (
                          <span style={{ padding: '4px 8px', display: 'inline-block' }}>{displayIdx + 1}</span>
                        ) : (
                          <span
                            onClick={() => setDeletedRowIdxs(prev => {
                              const n = new Set(prev);
                              if (n.has(i)) n.delete(i); else n.add(i);
                              return n;
                            })}
                            title={isDeleted ? '삭제 표시 해제' : '이 행을 삭제 표시 (적용 시 DELETE)'}
                            style={{ padding: '4px 4px', display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer', justifyContent: 'center' }}
                          >
                            <span style={{ color: isDeleted ? '#ff8080' : '#888', fontSize: 11 }}>{isDeleted ? '🗑' : displayIdx + 1}</span>
                          </span>
                        )}
                      </td>
                      {row.map((c, j) => {
                        const key = `${i},${j}`;
                        const edited = !isPinnedView && edits.has(key);
                        const value = edited ? edits.get(key)! : c;
                        const isEditing = !isPinnedView && editingCell === key;
                        const pinned = pinnedCols.has(j);
                        const w = getColWidth(j);
                        return (
                          <td key={j} style={{
                            padding: 0, border: '1px solid #3f3f46', borderTop: 0, borderLeft: 0,
                            background: isDeleted ? '#3a1d1d' : (edited ? '#3d2a14' : (i % 2 ? '#222' : '#1e1e1e')),
                            width: w, minWidth: w, maxWidth: w,
                            textDecoration: isDeleted ? 'line-through' : 'none',
                            opacity: isDeleted ? 0.65 : 1,
                            ...(pinned ? { position: 'sticky', left: pinnedLeftFor(j), zIndex: 1 } : { position: 'relative' }),
                          }}>
                            {isEditing ? (
                              <input
                                autoFocus
                                value={value}
                                onChange={e => {
                                  const v = e.target.value;
                                  setEdits(prev => {
                                    const next = new Map(prev);
                                    if (v === c) next.delete(key);
                                    else next.set(key, v);
                                    return next;
                                  });
                                }}
                                onBlur={() => setEditingCell(null)}
                                onKeyDown={e => {
                                  if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); setEditingCell(null); }
                                }}
                                ref={el => {
                                  if (el && document.activeElement !== el) {
                                    // Chromium caret stuck 우회 — IPC 로 window blur/focus 강제 → 한 박자 뒤 focus+select
                                    (window as any).api?.refocusWindow?.();
                                    setTimeout(() => { try { el.focus(); el.select(); } catch {} }, 30);
                                  }
                                }}
                                spellCheck={false}
                                style={{ width: '100%', boxSizing: 'border-box', background: '#1a1a1a', color: edited ? '#ffd680' : '#d4d4d4', border: '1px solid #569cd6', padding: '3px 11px', fontFamily: 'monospace', fontSize: 12, outline: 'none', display: 'block' }}
                              />
                            ) : (
                              <div
                                onClick={() => { if (!isPinnedView) setEditingCell(key); }}
                                title={value.length > 40 ? value : undefined}
                                style={{ padding: '4px 12px', color: edited ? '#ffd680' : '#d4d4d4', fontFamily: 'monospace', fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', cursor: isPinnedView ? 'default' : 'text' }}
                              >{value || ' '}</div>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                    );
                  })}
                  {/* 새 행 (INSERT 후보) — 라이브 뷰에서만 표시 */}
                  {!isPinnedView && newRows.map((nrow, ni) => (
                    <tr key={`new-${ni}`}>
                      <td style={{ position: 'sticky', left: 0, zIndex: 1, padding: 0, color: '#5fb55f', background: '#1a2a1a', border: '1px solid #3a6a3a', borderTop: 0, textAlign: 'center', whiteSpace: 'nowrap', width: INDEX_COL_W, minWidth: INDEX_COL_W }}>
                        <span
                          onClick={() => setNewRows(prev => prev.filter((_, k) => k !== ni))}
                          title="이 새 행 제거"
                          style={{ padding: '4px 4px', display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer', justifyContent: 'center', color: '#9cdcfe', fontSize: 11 }}
                        >＋<span style={{ color: '#888' }}>×</span></span>
                      </td>
                      {displayedResult.columns.map((_c, j) => {
                        const pinned = pinnedCols.has(j);
                        const w = getColWidth(j);
                        const v = nrow[j] ?? '';
                        return (
                          <td key={j} style={{
                            padding: 0, border: '1px solid #3a6a3a', borderTop: 0, borderLeft: 0,
                            background: '#1a2a1a',
                            width: w, minWidth: w, maxWidth: w,
                            ...(pinned ? { position: 'sticky', left: pinnedLeftFor(j), zIndex: 1 } : { position: 'relative' }),
                          }}>
                            <input
                              value={v}
                              onChange={e => {
                                const v2 = e.target.value;
                                setNewRows(prev => prev.map((r, k) => {
                                  if (k !== ni) return r;
                                  const nr = r.slice();
                                  nr[j] = v2;
                                  return nr;
                                }));
                              }}
                              spellCheck={false}
                              placeholder={'NULL'}
                              style={{ width: '100%', boxSizing: 'border-box', background: 'transparent', color: '#bef5be', border: 0, padding: '4px 11px', fontFamily: 'monospace', fontSize: 12, outline: 'none', display: 'block' }}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {displayedResult && displayedResult.affectedText && (
            <div style={{ padding: 6, color: '#888', fontSize: 11, fontFamily: 'monospace', borderTop: '1px solid #333' }}>{displayedResult.affectedText}</div>
          )}
          {displayedResult && displayedResult.columns.length === 0 && !displayedResultError && (
            <pre style={{ padding: 8, fontSize: 12, color: '#aaa', whiteSpace: 'pre-wrap' }}>{displayedResult.raw}</pre>
          )}
          </div>{/* /inner scroll wrapper */}
        </div>
      </div>

      {/* 우측: 히스토리 */}
      <div style={{ width: 280, flexShrink: 0, display: 'flex', flexDirection: 'column', borderLeft: '1px solid #333', minHeight: 0 }}>
        <div style={{ padding: 8, borderBottom: '1px solid #333', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontWeight: 600 }}>📜 히스토리</span>
          <button onClick={() => { if (confirm('히스토리 전부 삭제?')) { setHistory([]); saveHistory(sessionId, []); } }} style={{ marginLeft: 'auto', background: 'transparent', color: '#888', border: '1px solid #444', cursor: 'pointer', padding: '2px 6px', borderRadius: 3, fontSize: 11 }}>비우기</button>
        </div>
        <input value={historyFilter} onChange={e => setHistoryFilter(e.target.value)} placeholder="검색..." style={{ margin: 6, padding: 4, background: '#2a2a2a', color: '#ddd', border: '1px solid #444', borderRadius: 3 }} />
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 4px 4px' }}>
          {filteredHistory.length === 0 && <div style={{ color: '#666', padding: 4 }}>없음</div>}
          {filteredHistory.map((h, i) => (
            <div key={i}
              onClick={() => setSql(h.sql)}
              title="클릭: 에디터에 로드"
              style={{ padding: 6, marginBottom: 4, background: h.error ? '#3a1d1d' : '#252525', borderRadius: 3, cursor: 'pointer', border: '1px solid #333' }}
            >
              <div style={{ fontFamily: 'monospace', fontSize: 11, color: h.error ? '#fcc' : '#9cdcfe', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{h.sql}</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#888', marginTop: 2 }}>
                <span>{new Date(h.ts).toLocaleTimeString()}</span>
                <span>{h.error ? '에러' : `${h.rows}행 / ${h.ms}ms`}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
      <DriverManagerModal open={driverManagerOpen} onClose={() => setDriverManagerOpen(false)} />
      {nameModal && (
        <div
          onClick={() => setNameModal(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 6000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ background: '#252526', color: '#d4d4d4', borderRadius: 6, padding: 16, width: 380, boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }}
          >
            <div style={{ fontWeight: 600, marginBottom: 10, fontSize: 13 }}>
              {nameModal.mode === 'save' ? '⭐ 즐겨찾기 저장' : '✎ 이름 변경'}
            </div>
            <input
              autoFocus
              value={nameModal.value}
              onChange={e => setNameModal(m => m ? { ...m, value: e.target.value } : m)}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); confirmNameModal(); }
                else if (e.key === 'Escape') { e.preventDefault(); setNameModal(null); }
              }}
              placeholder="이름 입력"
              style={{ width: '100%', boxSizing: 'border-box', background: '#1e1e1e', color: '#d4d4d4', border: '1px solid #444', borderRadius: 3, padding: '6px 8px', fontSize: 13, outline: 'none' }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
              <button onClick={() => setNameModal(null)} style={{ background: '#444', color: '#fff', border: 0, padding: '5px 14px', borderRadius: 3, cursor: 'pointer', fontSize: 12 }}>취소</button>
              <button onClick={confirmNameModal} disabled={!nameModal.value.trim()} style={{ background: nameModal.value.trim() ? '#0e639c' : '#555', color: '#fff', border: 0, padding: '5px 14px', borderRadius: 3, cursor: nameModal.value.trim() ? 'pointer' : 'not-allowed', fontSize: 12 }}>확인</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
