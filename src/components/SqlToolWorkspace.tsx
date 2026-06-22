// src/components/SqlToolWorkspace.tsx
// SQL Tool — JDBC 사이드카(Java) 를 통한 다중 DBMS 지원. 결과/히스토리/스키마 트리/PK 편집/객체 상세.
import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import Editor, { OnMount } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import { format as sqlFormat } from 'sql-formatter';
import { DriverManagerModal } from './DriverManagerModal';
import { JdbcBackend, resolveDriverFromList, type ColumnInfo } from './jdbcBackend';
import { ObjectDetailPanel } from './ObjectDetailPanel';

// AI 에이전트 브랜드 아이콘 (LogAnalyzer/ClaudeChat 와 동일)
const ClaudeIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" fill="#D97757"/>
  </svg>
);
const GeminiIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="sqlGeminiGrad" x1="12" y1="0" x2="12" y2="24" gradientUnits="userSpaceOnUse"><stop offset="0%" stopColor="#4285F4"/><stop offset="100%" stopColor="#00BFA5"/></linearGradient></defs>
    <path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" fill="url(#sqlGeminiGrad)"/>
  </svg>
);
const CodexIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" fill="#b0b0b0"/>
  </svg>
);
const AGENT_ICON: Record<'claude' | 'gemini' | 'codex', React.FC> = {
  claude: ClaudeIcon, gemini: GeminiIcon, codex: CodexIcon,
};

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
  jumps?: { host: string; user?: string; port?: number; password?: string }[];
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
  types?: string[];  // JDBC ResultSetMetaData.getColumnTypeName 결과 (DATE/TIMESTAMP/VARCHAR 등). 적용하기 SQL 합성 시 사용.
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
export type ObjectKind = 'table' | 'view' | 'index' | 'sequence' | 'procedure' | 'function' | 'synonym' | 'package' | 'trigger' | 'tablespace' | 'replication' | 'info';
export type EditorTab = {
  id: string;
  title: string;
  sql: string;
  kind?: 'sql' | 'object';
  objectKind?: ObjectKind;
  objectName?: string;
  objectSchema?: string;
  objectTable?: string; // index 등 — 소속 테이블명 (인덱스명은 전역 유일하지 않으므로 필수)
  objectInfoSql?: string; // kind='info' — 관리/시스템 정보 항목이 실행할 사전정의 쿼리
  objectInfoTransform?: string; // kind='info' — 결과 후처리 변환 키 (예: 'altibaseProperty')
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
const hasJumpChain = (session?: Session | null) => !!session?.jumps?.some(j => (j.host || '').trim());
const dbmsRemoteHostForSession = (session: Session) => hasJumpChain(session) ? '127.0.0.1' : (session.dbms?.host || '127.0.0.1');

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
  const [tabListOpen, setTabListOpen] = useState<boolean>(false);
  // 오브젝트 상세 탭 열기 (같은 객체 이미 있으면 그 탭으로 전환)
  const openObjectDetail = useCallback((name: string, kind: ObjectKind, schema?: string, table?: string) => {
    setEditorTabs(prev => {
      const existing = prev.find(t => t.kind === 'object' && t.objectName === name && t.objectKind === kind && (t.objectSchema || '') === (schema || '') && (t.objectTable || '') === (table || ''));
      if (existing) { setActiveEditorTabId(existing.id); return prev; }
      const id = newTabId();
      const iconMap: Record<ObjectKind, string> = { table: '📄', view: '👁', index: '🔑', sequence: '🔢', procedure: '⚙', function: 'ƒ', synonym: '🔗', package: '📦', trigger: '🔔', tablespace: '💾', replication: '🔄', info: 'ℹ' };
      const icon = iconMap[kind] || '📄';
      // 기본 서브탭 — DBeaver 스타일
      const defaultSubMap: Record<ObjectKind, string> = {
        table: 'properties', view: 'properties', index: 'columns', sequence: 'declaration',
        procedure: 'parameters', function: 'parameters', synonym: 'declaration',
        package: 'pkgProcs', trigger: 'source', tablespace: 'datafiles', replication: 'properties', info: 'properties',
      };
      const defaultPropSubMap: Record<ObjectKind, string> = {
        table: 'columns', view: 'columns', index: '', sequence: '', procedure: '', function: '', synonym: '',
        package: '', trigger: '', tablespace: '', replication: '', info: '',
      };
      const next = [...prev, { id, title: `${icon} ${name}`, sql: '', kind: 'object' as const, objectKind: kind, objectName: name, objectSchema: schema, objectTable: table, objectSubTab: defaultSubMap[kind], objectPropSubTab: defaultPropSubMap[kind] }];
      setActiveEditorTabId(id);
      return next;
    });
  }, []);
  // 관리/시스템 정보 항목 — info 상세 탭으로 열기 (사전정의 쿼리 결과를 Properties 그리드로 표시)
  const openInfoTab = useCallback((label: string, icon: string, sql: string, transform?: string) => {
    setEditorTabs(prev => {
      const existing = prev.find(t => t.kind === 'object' && t.objectKind === 'info' && t.objectName === label);
      if (existing) { setActiveEditorTabId(existing.id); return prev; }
      const id = newTabId();
      const next = [...prev, { id, title: `${icon} ${label}`, sql: '', kind: 'object' as const, objectKind: 'info' as ObjectKind, objectName: label, objectSchema: '', objectInfoSql: sql, objectInfoTransform: transform, objectSubTab: 'properties', objectPropSubTab: '' }];
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
  // 선택된 행(복사용) — # 컬럼 클릭으로 토글. Ctrl/Shift 다중 선택.
  const [selectedRowIdxs, setSelectedRowIdxs] = useState<Set<number>>(new Set());
  // EXPLAIN PLAN 트리 — 접힘 노드 인덱스(자식 숨김). result 바뀔 때 자동 초기화.
  const [collapsedPlanNodes, setCollapsedPlanNodes] = useState<Set<number>>(new Set());
  // AI 에이전트 선택 — props 의 aiAgent 가 초기값. 세션 캐시에 보존.
  const [selectedAgent, setSelectedAgent] = useState<'claude' | 'gemini' | 'codex'>(
    () => ((sqlStateCache.get(sessionId + ':ai') as any) || aiAgent) as 'claude' | 'gemini' | 'codex'
  );
  useEffect(() => { sqlStateCache.set(sessionId + ':ai' as any, selectedAgent as any); }, [sessionId, selectedAgent]);
  const [agentMenuOpen, setAgentMenuOpen] = useState<boolean>(false);
  const lastSelectedRowRef = useRef<number | null>(null);
  // ── 결과 그리드 사용자 상태 ──
  // 정렬: null=원본 순서. 같은 컬럼 재클릭 시 asc→desc→null 토글.
  const [sortState, setSortState] = useState<{ col: number; dir: 'asc' | 'desc' } | null>(null);
  // 컬럼별 substring 필터 (대소문자 무시). 빈문자열이면 미적용.
  const [colFilters, setColFilters] = useState<Map<number, string>>(new Map());
  // 컬럼별 폭(px). 미설정이면 기본값. 사용자가 헤더 우측을 드래그해 변경.
  const [colWidths, setColWidths] = useState<Map<number, number>>(new Map());
  // 좌측 고정 컬럼 — sticky left 로 가로 스크롤시 화면에 유지.
  const [pinnedCols, setPinnedCols] = useState<Set<number>>(new Set());
  // 컬럼 표시 순서 — 원본 인덱스의 permutation. 헤더 드래그로 변경.
  // 빈 배열 = 기본 순서(0..n-1). 결과 컬럼이 바뀌면 리셋.
  const [colOrder, setColOrder] = useState<number[]>([]);
  // 드래그 중인 원본 컬럼 인덱스 (헤더 드래그 reorder)
  const [dragColIdx, setDragColIdx] = useState<number | null>(null);
  const [dragOverColIdx, setDragOverColIdx] = useState<number | null>(null);
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
  const runningRef = useRef(false);
  useEffect(() => { runningRef.current = running; }, [running]);
  // 실행 표시(버튼 색/문구/취소버튼)는 180ms 이상 걸릴 때만 켠다 — 빠른 쿼리에서 순간 깜빡임 방지.
  const [showRunning, setShowRunning] = useState(false);
  useEffect(() => {
    if (!running) { setShowRunning(false); return; }
    const t = window.setTimeout(() => setShowRunning(true), 180);
    return () => window.clearTimeout(t);
  }, [running]);
  // ── JDBC keep-alive — 유휴 시 주기적 검증으로 DB/SSH터널 idle timeout 끊김 방지.
  //    실행 중(running)에는 같은 connection 동시 사용 방지를 위해 건너뜀.
  useEffect(() => {
    if (!connected || !backend) return;
    let busy = false;
    const id = window.setInterval(async () => {
      if (busy || runningRef.current) return;
      busy = true;
      try {
        const ok = await backend.keepAlive();
        if (!ok) { setConnected(false); setConnectError('연결이 끊어졌습니다 — 다시 연결하세요.'); }
      } catch {} finally { busy = false; }
    }, 60000);
    return () => window.clearInterval(id);
  }, [connected, backend]);
  const [result, setResult] = useState<ParsedResult | null>(null);
  const [resultError, setResultError] = useState<string>('');
  // 새 result 가 도착하면 그리드 사용자 상태 초기화 — 컬럼 구조가 바뀌었을 가능성
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setSortState(null); setColFilters(new Map()); setColWidths(new Map()); setPinnedCols(new Set()); setColOrder([]); }, [result?.columns.join('|'), viewingTabId]);
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
  // 좌측 사이드바 폭 (드래그 리사이즈) — localStorage 비활성, 메모리 보존.
  const [leftSidebarWidth, setLeftSidebarWidth] = useState<number>(() => sqlStateCache.get(sessionId + ':leftW') as any || 260);
  const [rightSidebarWidth, setRightSidebarWidth] = useState<number>(() => sqlStateCache.get(sessionId + ':rightW') as any || 280);
  // 히스토리 패널 핀 상태 (unpin 시 collapsed bar 만 표시)
  const [historyPinned, setHistoryPinned] = useState<boolean>(() => (sqlStateCache.get(sessionId + ':hPin') as any) !== false);
  // 결과 패널 높이 (px) — DBeaver Sash 와 동등. 드래그로 조절, ▲▼ 로 접기/펼치기.
  const [resultPaneHeight, setResultPaneHeight] = useState<number>(() => (sqlStateCache.get(sessionId + ':resH') as any) || 300);
  // ResultSet fetch size — DBeaver 의 "Custom row count" 와 동일. SELECT 시 최대 가져올 행 수.
  const [fetchSize, setFetchSize] = useState<number>(() => (sqlStateCache.get(sessionId + ':fsz') as any) || 200);
  // 데이터 추출 메뉴 — 2단계 (대상 선택 → 포맷 선택). 부모 overflow 로 잘리지 않도록 position: fixed.
  const [exportMenuAnchor, setExportMenuAnchor] = useState<{ left: number; bottom: number } | null>(null);
  const [exportMenuPath, setExportMenuPath] = useState<null | 'clipboard' | 'file'>(null);
  const exportMenuOpen = exportMenuAnchor !== null;
  const setExportMenuOpen = (v: boolean) => { if (!v) { setExportMenuAnchor(null); setExportMenuPath(null); } };
  const [resultPaneCollapsed, setResultPaneCollapsed] = useState<boolean>(() => (sqlStateCache.get(sessionId + ':resC') as any) === true);
  const [resultPaneMaximized, setResultPaneMaximized] = useState<boolean>(false);
  // 사이즈 캐시: 트리 옆 사이즈 표시용 (테이블/테이블스페이스)
  const [sizeRev, setSizeRev] = useState(0);
  const tableSizesRef = useRef<Map<string, Map<string, { bytes: number; display: string }>>>(new Map()); // schema -> name -> {bytes, display}
  const tablespaceSizesRef = useRef<Map<string, { bytes: number; display: string }>>(new Map());
  const tableSizesMaxRef = useRef<Map<string, number>>(new Map()); // schema -> max bytes
  const tablespaceSizeMaxRef = useRef<number>(0);
  const sizeLoadingRef = useRef<Set<string>>(new Set());
  useEffect(() => { sqlStateCache.set(sessionId + ':leftW' as any, leftSidebarWidth as any); }, [sessionId, leftSidebarWidth]);
  useEffect(() => { sqlStateCache.set(sessionId + ':rightW' as any, rightSidebarWidth as any); }, [sessionId, rightSidebarWidth]);
  useEffect(() => { sqlStateCache.set(sessionId + ':hPin' as any, historyPinned as any); }, [sessionId, historyPinned]);
  useEffect(() => { sqlStateCache.set(sessionId + ':resH' as any, resultPaneHeight as any); }, [sessionId, resultPaneHeight]);
  useEffect(() => { sqlStateCache.set(sessionId + ':resC' as any, resultPaneCollapsed as any); }, [sessionId, resultPaneCollapsed]);
  useEffect(() => { sqlStateCache.set(sessionId + ':fsz' as any, fetchSize as any); }, [sessionId, fetchSize]);
  // 즐겨찾기 (저장된 쿼리)
  const [favorites, setFavorites] = useState<FavoriteQuery[]>(() => loadFavorites(sessionId));
  const [favPanelOpen, setFavPanelOpen] = useState<boolean>(false);
  // 이름 입력 모달 (Electron 은 window.prompt 미지원 → 인라인 모달).
  // mode: 'save' = 새 즐겨찾기 저장(sql 보관), 'rename' = 기존 즐겨찾기 이름 변경(id 보관)
  const [nameModal, setNameModal] = useState<{ mode: 'save' | 'rename'; value: string; sql?: string; id?: string } | null>(null);
  // 확인(confirm) 모달 — window.confirm 이 포커스를 빼앗는 문제 회피.
  const [confirmModal, setConfirmModal] = useState<{ title: string; message: string; onOk: () => void } | null>(null);
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
      // SSH 터널 사용 시 — 로컬 포트 포워딩 열고 host/port 교체.
      let effectiveDbms: any = session.dbms;
      let forwardId = '';
      console.log('[SqlTool] connect() session.dbms =', session.dbms);
      const forceSshTunnel = hasJumpChain(session);
      const useSshTunnel = !!session.dbms?.useSshTunnel || forceSshTunnel;
      if (useSshTunnel) {
        if (typeof api.sshOpenLocalForward !== 'function') {
          setConnectError('SSH 터널 IPC 미등록 — Electron 메인 프로세스를 재시작하세요 (코드 변경 적용을 위해).');
          return;
        }
        const remoteHost = dbmsRemoteHostForSession(session);
        const remotePort = session.dbms.port || def.defaultPort || 0;
        let fwd: any;
        try {
          fwd = await api.sshOpenLocalForward({
            sessionId,
            remoteHost,
            remotePort,
            // SSH 호스트 힌트 — quick-connect 시 session.id 가 불일치해도 매칭 가능
            sshHost: (session as any).host,
            sshPort: (session as any).port || 22,
          });
        } catch (ipcErr: any) {
          setConnectError(`SSH 터널 IPC 예외: ${ipcErr?.message || ipcErr}`);
          return;
        }
        console.log('[SqlTool] sshOpenLocalForward result =', fwd);
        if (!fwd || fwd.success !== true) {
          // 메인 프로세스가 이미 상황별 친화 메시지를 줌 (활성 호스트 목록 + 안내).
          // 중복 문구 붙이지 말고 그대로 노출.
          setConnectError(fwd?.error ? `SSH 터널 열기 실패\n${fwd.error}` : 'SSH 터널 열기 실패 — 응답 없음');
          return;
        }
        if (!fwd.localPort) {
          setConnectError(`SSH 터널 응답에 localPort 누락 (panelId=${fwd.panelId || '?'}) — sshBridge.openLocalForward 확인 필요`);
          return;
        }
        forwardId = fwd.forwardId;
        // urlOverride 가 남아있으면 host/port 교체가 무시되므로 함께 비움
        effectiveDbms = { ...session.dbms, host: '127.0.0.1', port: fwd.localPort, urlOverride: undefined };
        console.log('[SqlTool] SSH tunnel opened:', { remoteHost, remotePort, localPort: fwd.localPort, forwardId, panelId: fwd.panelId, forcedByJump: forceSshTunnel });
      }
      const newBackend = new JdbcBackend(sessionId, effectiveDbms, def);
      // forwardId 를 backend 에 저장해 disconnect 시 정리
      (newBackend as any).__forwardId = forwardId;
      // 진단 로그 — 실제 빌드된 URL
      const dbgUrl = newBackend.buildUrl();
      console.log('[SqlTool] connecting JDBC →', dbgUrl, forwardId ? `(via SSH tunnel ${forwardId})` : '(direct)');
      const cr = await newBackend.ensureConnected();
      if (!cr.ok) {
        if (forwardId) { try { await api.sshCloseLocalForward?.({ forwardId }); } catch {} }
        const prefix = forwardId ? `[SSH tunnel: ${dbgUrl}] ` : '';
        setConnectError(prefix + (cr.error || '연결 실패'));
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

  // 자동 연결은 세션당 1회만 — 실패 시 effect 가 즉시 재호출해 무한 재시도(상태 깜빡임)되던 문제 방지.
  const autoConnectedRef = useRef(false);
  useEffect(() => { autoConnectedRef.current = false; }, [sessionId]);
  useEffect(() => {
    if (session && !connected && !connecting && !autoConnectedRef.current) {
      autoConnectedRef.current = true;
      connect();
    }
  }, [session, connected, connecting, connect]);

  // 재연결 — 기존 연결/터널 정리 후 새로 연결.
  const reconnect = useCallback(async () => {
    const b = backend;
    if (b) {
      try { await b.disconnect(); } catch {}
      const fwd = (b as any).__forwardId;
      if (fwd) { try { await (window as any).api?.sshCloseLocalForward?.({ forwardId: fwd }); } catch {} }
    }
    setBackend(null);
    setConnected(false);
    autoConnectedRef.current = true; // 자동 연결 effect 와 충돌 방지 (수동 재연결이 주도)
    await connect();
  }, [backend, connect]);

  // 언마운트 시 JDBC 연결 종료 (사이드카 측) + SSH 터널 정리
  useEffect(() => {
    return () => {
      const b = backend;
      if (b) {
        try { b.disconnect(); } catch {}
        const fwd = (b as any).__forwardId;
        if (fwd) { try { (window as any).api?.sshCloseLocalForward?.({ forwardId: fwd }); } catch {} }
      }
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
      // 이전 결과를 즉시 null 로 비우지 않음 — 새 결과 도착 시 원자적 교체로 그리드 깜빡임 방지.
      // (실행 중에는 running 상태로 표시되고, 새 데이터/에러가 오면 setResult 가 한 번에 갈아끼움)
      // FROM 테이블명 추출 — 라인/블록 주석 안의 FROM 이 잘못 잡히는 문제 회피 (DBeaver 와 동일하게 주석 제거 후 매칭).
      const cleaned = sqlText
        .replace(/--[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      const m = cleaned.match(/\bfrom\s+([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)?)/i);
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
      // fetchSize 가 사용자가 정한 limit (DBeaver "Custom row count"). 상한은 안전을 위해 MAX_DISPLAY_ROWS.
      const effectiveMax = Math.max(1, Math.min(MAX_DISPLAY_ROWS, fetchSize || MAX_DISPLAY_ROWS));
      const res = await backend!.exec(sqlText, effectiveMax);
      if (runIdRef.current !== myRunId) return; // 더 새로운 runSql — 결과 무시
      const ms = Date.now() - t0;
      const note = res.truncated
        ? ` ⚠ 결과 ${effectiveMax.toLocaleString()}행 까지만 표시 (fetch size ↑ 또는 WHERE/LIMIT 사용)`
        : '';
      const affectedText = res.columns.length === 0
        ? (res.rowsAffected > 0 ? `✓ ${res.rowsAffected}행 영향 (${ms}ms)` : `✓ 완료 (${ms}ms)`)
        : `✓ ${res.rows.length.toLocaleString()}${res.truncated ? '+' : ''}행 (${ms}ms)${note}`;
      setResult({ columns: res.columns, rows: res.rows, types: res.types, affectedText, raw: '' });
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
        // table: backend.tableDdl 이 dialect 별 DBMS_METADATA.GET_DDL 등을 시도. 실패 시 fallback.
        if (backend && connected) {
          const native = await backend.tableDdl(objectName);
          if (native) return native;
        }
        // fallback: 컬럼 + PK 로 단순 CREATE TABLE 생성
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
  useEffect(() => { setNewRows([]); setDeletedRowIdxs(new Set()); setCollapsedPlanNodes(new Set()); }, [result]);

  // 트리 객체 그룹 정의 — DBeaver 좌측 사이드 구조. load 는 schema 받아 이름 목록 반환.
  const OBJECT_GROUPS: { id: string; icon: string; label: string; load: (schema: string) => Promise<string[]>; insert: (name: string) => string }[] = useMemo(() => [
    { id: 'TABLE',     icon: '📋', label: '테이블',     load: (s) => backend?.listTables(s) ?? Promise.resolve([]),     insert: (n) => `SELECT * FROM ${n};` },
    { id: 'VIEW',      icon: '👁',  label: '뷰',         load: (s) => backend?.listViews(s) ?? Promise.resolve([]),      insert: (n) => `SELECT * FROM ${n};` },
    { id: 'INDEX',     icon: '🔑', label: '인덱스',     load: (s) => backend?.listSchemaIndexes(s) ?? Promise.resolve([]), insert: (n) => n },
    { id: 'SEQUENCE',  icon: '🔢', label: '시퀀스',     load: (s) => backend?.listSequences(s) ?? Promise.resolve([]),  insert: (n) => `${n}.NEXTVAL` },
    { id: 'PROCEDURE', icon: '⚙',  label: '프로시저',   load: (s) => backend?.listProcedures(s) ?? Promise.resolve([]), insert: (n) => `EXEC ${n}(/* args */);` },
    { id: 'FUNCTION',  icon: 'ƒ',  label: '함수',       load: (s) => backend?.listFunctions(s) ?? Promise.resolve([]),  insert: (n) => `${n}()` },
    { id: 'PACKAGE',   icon: '📦', label: '패키지',     load: (s) => backend?.listPackages(s) ?? Promise.resolve([]),   insert: (n) => n },
    { id: 'TRIGGER',   icon: '🔔', label: '트리거',     load: (s) => backend?.listSchemaTriggers(s) ?? Promise.resolve([]), insert: (n) => n },
    { id: 'SYNONYM',   icon: '🔗', label: '시노님',     load: (s) => backend?.listSynonyms(s) ?? Promise.resolve([]), insert: (n) => n },
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

  // ── 결과 export ── 라이브/스냅샷 직렬화 헬퍼는 데이터 추출 메뉴 내부의 serialize() 가 담당.

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

  // onSaveCsv / onSaveJson / onCopyClipboard 는 결과 영역의 "↥ 데이터 추출" 메뉴에 통합되어 제거됨.

  // 테이블을 canvas 로 렌더해서 PNG 클립보드 복사
  const onCopyImage = async () => {
    const src = displayedResult;
    if (!src || src.columns.length === 0) return;
    try {
      const cols = src.columns;
      // 라이브 뷰면 edits 반영, 스냅샷이면 원본
      const exportCell = (i: number, j: number, c: string) => isPinnedView ? c : (edits.get(`${i},${j}`) ?? c);
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
      if (selectedAgent === 'gemini') {
        r = await (window as any).api?.geminiSend?.(claudeSessionId, prompt, requestId, undefined, true);
      } else if (selectedAgent === 'codex') {
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

    // 빈 문자열/NULL 표기 + dialect 별 컬럼 타입별 리터럴 변환 (DBeaver ValueHandler 패턴).
    const isAltibase = backend?.type === 'altibase';
    const isOracle = backend?.type === 'oracle';
    const isAltibaseOrOracle = isAltibase || isOracle;
    const colTypes = result.types || [];
    const typeOf = (col: string): string => {
      const idx = result.columns.findIndex(c => c.toUpperCase() === col.toUpperCase());
      return (idx >= 0 ? (colTypes[idx] || '') : '').toUpperCase();
    };
    // 타입 분류 — Altibase/Oracle 공통 타입명 우선, 일반적인 JDBC 타입명 보강.
    const isDateType   = (t: string) => t === 'DATE' || /^TIMESTAMP/.test(t) || /^DATETIME/.test(t);
    const isNumberType = (t: string) =>
      /^(NUMBER|NUMERIC|DECIMAL|DEC|INTEGER|INT|BIGINT|SMALLINT|TINYINT|REAL|FLOAT|DOUBLE|BINARY_FLOAT|BINARY_DOUBLE)$/.test(t);
    const isBooleanType = (t: string) => t === 'BOOLEAN' || t === 'BOOL' || t === 'BIT';
    const isBinaryType  = (t: string) => /^(RAW|LONG\s*RAW|BLOB|BYTE|BYTES|VARBINARY|BINARY|GEOMETRY|BIT\s+VARYING)$/.test(t);
    // 날짜 리터럴 → TO_DATE('...', 'fmt') — 분수초 유무 / 시간부 유무에 따라 fmt 결정.
    const formatDateLit = (raw: string): string => {
      const esc = raw.replace(/'/g, `''`);
      const hasFrac = /\.\d+/.test(raw);
      const looksDate = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?)?$/.test(raw.trim());
      if (!looksDate) return `'${esc}'`;
      const fmt = hasFrac ? 'YYYY-MM-DD HH24:MI:SS.FF' : (raw.length > 10 ? 'YYYY-MM-DD HH24:MI:SS' : 'YYYY-MM-DD');
      return `TO_DATE('${esc}', '${fmt}')`;
    };
    // 숫자 리터럴 — 부호 + 정수/소수 + 지수(E) 허용. 그 외는 인용처리 폴백.
    const numericRe = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
    const formatNumberLit = (raw: string): string => numericRe.test(raw.trim()) ? raw.trim() : `'${raw.replace(/'/g, `''`)}'`;
    // 불리언 리터럴 — TRUE/FALSE/1/0/T/F/Y/N 표기 폭넓게 수용.
    const formatBoolLit = (raw: string): string => {
      const v = raw.trim().toUpperCase();
      if (v === 'TRUE' || v === 'T' || v === 'Y' || v === '1') return 'TRUE';
      if (v === 'FALSE' || v === 'F' || v === 'N' || v === '0') return 'FALSE';
      return `'${raw.replace(/'/g, `''`)}'`;
    };
    // 바이너리 리터럴 — Altibase: BYTES_TO_BIN('hex'), Oracle: HEXTORAW('hex'). 16진수만 허용.
    const formatBinaryLit = (raw: string): string => {
      const hex = raw.trim().replace(/^0x/i, '');
      if (!/^[0-9A-Fa-f]+$/.test(hex)) return `'${raw.replace(/'/g, `''`)}'`;
      if (isOracle)   return `HEXTORAW('${hex}')`;
      if (isAltibase) return `BYTE'${hex}'`; // Altibase BYTE literal
      return `'${hex}'`;
    };
    // 메인 변환 함수 — 컬럼 타입 + dialect 에 따라 SQL 리터럴 결정.
    const sqlVal = (v: string, col?: string) => {
      if (v === '') return 'NULL';
      if (!col) return `'${v.replace(/'/g, `''`)}'`;
      const t = typeOf(col);
      if (isAltibaseOrOracle && isDateType(t)) return formatDateLit(v);
      if (isNumberType(t))   return formatNumberLit(v);
      if (isBooleanType(t))  return formatBoolLit(v);
      if (isBinaryType(t))   return formatBinaryLit(v);
      // CHAR/VARCHAR/NCHAR/NVARCHAR/CLOB/NCLOB/JSON/XML 등은 문자열 인용
      return `'${v.replace(/'/g, `''`)}'`;
    };
    const eqOrNull = (col: string, v: string) => {
      if (v === '') return `${col} IS NULL`;
      const t = typeOf(col);
      if (isAltibaseOrOracle && isDateType(t)) return `${col} = ${formatDateLit(v)}`;
      if (isNumberType(t))  return `${col} = ${formatNumberLit(v)}`;
      if (isBooleanType(t)) return `${col} = ${formatBoolLit(v)}`;
      if (isBinaryType(t))  return `${col} = ${formatBinaryLit(v)}`;
      return `${col} = '${v.replace(/'/g, `''`)}'`;
    };

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
        const col = result.columns[colIdx];
        setParts.push(`${col} = ${sqlVal(newV, col)}`);
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
      const valStrs = row.map((v, j) => sqlVal(v, result.columns[j])).join(', ');
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
    // window.confirm 은 Electron 에서 포커스를 빼앗고 일부 환경에서 즉시 false 반환 → 인라인 모달로 대체.
    setConfirmModal({
      title: '✔ 변경 적용 (COMMIT)',
      message: `${opsSummary}\n${pkNote}\n\n${preview.slice(0, 600)}${preview.length > 600 ? '\n...' : ''}`,
      onOk: () => { void runApply(deletes, updates, inserts, opsSummary); },
    });
  };
  // 실제 트랜잭션 실행 — 확인 모달 OK 후 호출.
  const runApply = async (deletes: string[], updates: string[], inserts: string[], opsSummary: string) => {
    if (!backend || !connected || !lastTable) return;
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
        setEdits(new Map());
        setNewRows([]);
        setDeletedRowIdxs(new Set());
        if (lastTable) runSql(backend.selectAllForTable(lastTable));
        setConfirmModal({ title: '✔ 적용 완료', message: `${opsSummary} + COMMIT 완료.`, onOk: () => {} });
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
        setConfirmModal({ title: '✗ 적용 실패 — ROLLBACK', message: `${failedMsg}\n\n실패 SQL(앞 600자):\n${(failedStmt || '').slice(0, 600)}`, onOk: () => {} });
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
      <div style={{ width: leftSidebarWidth, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid #333', minHeight: 0, position: 'relative' }}>
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
            const rowStyle = (depth: number): React.CSSProperties => ({ padding: '2px 4px', paddingLeft: 4 + depth * 12, cursor: 'pointer', userSelect: 'none', display: 'flex', alignItems: 'center', gap: 4, borderRadius: 3, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap' });
            // 이름 span — 남는 공간을 차지 (게이지를 우측 끝에 정렬). 좁아지면 ellipsis.
            const nameSpanStyle: React.CSSProperties = { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
            // 게이지 컨테이너 — 사이즈 표시를 바 안에 오버레이 (DBeaver 스타일).
            const gaugeContainerStyle: React.CSSProperties = { position: 'relative', display: 'inline-block', flex: '0 100 70px', width: 70, height: 14, minWidth: 0, overflow: 'hidden', background: '#333', borderRadius: 2 };
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

            // 테이블 내 하위 폴더 (컬럼/제약조건/외래키/인덱스/참조/트리거) — DBeaver 패턴
            type TblChild = { id: string; icon: string; label: string; loader?: (t: string, s: string) => Promise<string[]>; useColumns?: boolean; objKind?: ObjectKind };
            const TBL_CHILDREN: TblChild[] = [
              { id: 'COLS', icon: '📁', label: '컬럼', useColumns: true },
              { id: 'CONS', icon: '📁', label: '제약조건', loader: (t, s) => backend?.listTableConstraints(t, s) ?? Promise.resolve([]) },
              { id: 'FK',   icon: '📁', label: '외래키',   loader: (t, s) => backend?.listTableForeignKeys(t, s) ?? Promise.resolve([]) },
              { id: 'IDX',  icon: '📁', label: '인덱스',   loader: (t, s) => backend?.listTableIndexes(t, s) ?? Promise.resolve([]), objKind: 'index' },
              { id: 'REF',  icon: '📁', label: '참조',     loader: (t, s) => backend?.listTableReferences(t, s) ?? Promise.resolve([]) },
              { id: 'TRG',  icon: '📁', label: '트리거',   loader: (t, s) => backend?.listTableTriggers(t, s) ?? Promise.resolve([]) },
            ];
            const renderTblChildFolder = (schema: string, tableName: string, c: TblChild, depth: number) => {
              const nid = `tbl:${schema}:${tableName}:${c.id}`;
              const key = `__tbl__ ${schema} ${tableName} ${c.id}`;
              const open = isExpanded(nid);
              if (c.useColumns) {
                // 컬럼 폴더 — 기존 columnsByTableRef 캐시 사용
                return (
                  <div key={nid}>
                    <div onClick={() => { toggleExpanded(nid); if (!open && !columnsByTableRef.current.get(tableName.toUpperCase())) loadColumns(tableName); }} style={{ ...rowStyle(depth), color: '#9cdcfe' }} {...hover}>
                      {caret(open)}
                      <span>{c.icon} {c.label}</span>
                    </div>
                    {open && <div>{renderColumns(tableName, depth + 1)}</div>}
                  </div>
                );
              }
              const items = treeItemsRef.current.get(key);
              const loading = treeLoadingRef.current.has(key);
              const filtered = Array.from(new Set((items || []).filter(filt)));
              return (
                <div key={nid}>
                  <div onClick={() => { toggleExpanded(nid); if (!open && !items && c.loader) loadTreeNode(key, () => c.loader!(tableName, schema)); }} style={{ ...rowStyle(depth), color: '#9cdcfe' }} {...hover}>
                    {caret(open)}
                    <span>{c.icon} {c.label}</span>
                    <span style={{ marginLeft: 'auto', color: '#666', fontSize: 11 }}>{loading ? '…' : (items ? items.length : '')}</span>
                  </div>
                  {open && (
                    <div>
                      {loading && <div style={{ paddingLeft: 4 + (depth + 1) * 12, color: '#888' }}>로딩...</div>}
                      {!loading && items && filtered.length === 0 && <div style={{ paddingLeft: 4 + (depth + 1) * 12, color: '#666' }}>없음</div>}
                      {filtered.map(n => (
                        <div key={n} draggable
                          title={c.objKind ? '더블클릭: 상세' : '더블클릭: 삽입 / 드래그: 이름 삽입'}
                          onDragStart={e => { e.dataTransfer.setData('text/plain', n); e.dataTransfer.effectAllowed = 'copy'; }}
                          onDoubleClick={() => { if (c.objKind) openObjectDetail(n, c.objKind, schema, c.objKind === 'index' ? tableName : undefined); else insertAtCursor(n); }}
                          style={{ ...rowStyle(depth + 1), cursor: c.objKind ? 'pointer' : 'grab' }} {...hover}
                        >
                          <span style={{ width: 10, display: 'inline-block' }} />
                          <span>🔹 {n}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            };

            // 패키지 펼침 시 하위 프로시저/함수 — DBeaver 패키지 노드 동작
            const renderPackageChildren = (schema: string, pkgName: string, depth: number) => {
              const key = `__pkg__ ${schema} ${pkgName}`;
              const items = treeItemsRef.current.get(key) as any[] | undefined;
              const loading = treeLoadingRef.current.has(key);
              if (loading) return <div style={{ paddingLeft: 4 + depth * 12, color: '#888' }}>로딩...</div>;
              if (!items) {
                // lazy load — 비동기 호출 한 번
                loadTreeNode(key, async () => {
                  const list = await (backend?.listPackageRoutines(pkgName, schema) ?? Promise.resolve([]));
                  return list.map((r: any) => `${r.type === 'FUNCTION' ? 'ƒ' : '⚙'}|${r.name}`) as any;
                });
                return <div style={{ paddingLeft: 4 + depth * 12, color: '#888' }}>로딩...</div>;
              }
              if (items.length === 0) return <div style={{ paddingLeft: 4 + depth * 12, color: '#666' }}>없음</div>;
              return items.map(it => {
                const [ico, nm] = String(it).split('|');
                return (
                  <div key={nm} draggable
                    onDragStart={e => { e.dataTransfer.setData('text/plain', `${pkgName}.${nm}`); e.dataTransfer.effectAllowed = 'copy'; }}
                    onDoubleClick={() => insertAtCursor(`${pkgName}.${nm}`)}
                    style={{ ...rowStyle(depth), cursor: 'grab' }} {...hover}
                  >
                    <span style={{ width: 10, display: 'inline-block' }} />
                    <span>{ico} {nm}</span>
                  </div>
                );
              });
            };

            // 객체 노드 (테이블/뷰는 6개 하위 폴더 펼침 + 더블클릭 상세, 나머지는 단순 삽입)
            const renderObject = (schema: string, groupId: string, name: string, icon: string, insert: (n: string) => string, depth: number) => {
              const isTableLike = groupId === 'TABLE' || groupId === 'VIEW' || groupId === 'SYSTABLE';
              const isPackage = groupId === 'PACKAGE';
              const expandable = isTableLike || isPackage;
              const nodeId = `obj:${schema}:${groupId}:${name}`;
              const open = isExpanded(nodeId);
              return (
                <div key={nodeId}>
                  <div draggable
                    title={expandable ? '클릭: 펼침 / 더블클릭: 상세 / 드래그: 이름 삽입' : '더블클릭: 삽입 / 드래그: 이름 삽입'}
                    onDragStart={e => { e.dataTransfer.setData('text/plain', name); e.dataTransfer.setData('application/x-pepe-sql-table', name); e.dataTransfer.effectAllowed = 'copy'; }}
                    onClick={() => { if (expandable) toggleExpanded(nodeId); }}
                    onDoubleClick={() => {
                      const kindMap: Record<string, ObjectKind | null> = { TABLE: 'table', VIEW: 'view', SYSTABLE: 'table', INDEX: 'index', SEQUENCE: 'sequence', PROCEDURE: 'procedure', FUNCTION: 'function', PACKAGE: 'package', TRIGGER: 'trigger', SYNONYM: 'synonym' };
                      const k = kindMap[groupId];
                      // INDEX 노드는 "TABLE.INDEX" 형식 — indexDetail 에는 인덱스명만 전달
                      // TRIGGER 노드는 "NAME (TABLE)" 형식 — 앞부분만 전달
                      const detailName = (k === 'index' && name.includes('.')) ? name.split('.').slice(-1)[0]
                                       : (k === 'trigger' && name.includes(' (')) ? name.split(' (')[0]
                                       : name;
                      // INDEX 노드 "TABLE.INDEX" — 앞부분이 소속 테이블
                      const detailTable = (k === 'index' && name.includes('.')) ? name.split('.').slice(0, -1).join('.') : undefined;
                      if (k) openObjectDetail(detailName, k, schema, detailTable);
                      else insertAtCursor(insert(name));
                    }}
                    style={{ ...rowStyle(depth), cursor: expandable ? 'pointer' : 'grab' }} {...hover}
                  >
                    {expandable ? caret(open) : <span style={{ width: 10, display: 'inline-block', flexShrink: 0 }} />}
                    <span style={nameSpanStyle}>{icon} {name}</span>
                    {groupId === 'TABLE' && (() => {
                      const sz = tableSizesRef.current.get(schema)?.get(name.toUpperCase());
                      if (!sz) return null;
                      const max = tableSizesMaxRef.current.get(schema) || 1;
                      const ratio = Math.max(0.02, Math.min(1, sz.bytes / max));
                      return (
                        <span style={gaugeContainerStyle} title={sz.display}>
                          <span style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${ratio * 100}%`, background: '#3a6691' }} />
                          <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ddd', fontSize: 10, fontVariantNumeric: 'tabular-nums', textShadow: '0 0 2px #000' }}>{sz.display}</span>
                        </span>
                      );
                    })()}
                  </div>
                  {expandable && open && (
                    <div>
                      {isPackage
                        ? renderPackageChildren(schema, name, depth + 1)
                        : (groupId === 'VIEW' ? TBL_CHILDREN.filter(c => c.id === 'COLS' || c.id === 'TRG') : TBL_CHILDREN)
                            .map(c => renderTblChildFolder(schema, name, c, depth + 1))}
                    </div>
                  )}
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
              // 중복 제거 — MySQL/MariaDB 등 일부 드라이버가 INFORMATION_SCHEMA + catalog 양쪽에서 같은 이름을 반환하는 경우 방어.
              const filtered = Array.from(new Set((items || []).filter(filt)));
              // TABLE 그룹 펼침 시 사이즈 한 번에 fetch
              const onTblOpen = () => {
                if (g.id !== 'TABLE') return;
                const sizeKey = `__tblSize__ ${schema}`;
                if (tableSizesRef.current.has(schema) || sizeLoadingRef.current.has(sizeKey)) return;
                sizeLoadingRef.current.add(sizeKey);
                (backend?.tableSizes(schema) ?? Promise.resolve(new Map())).then((m: Map<string, { bytes: number; display: string }>) => {
                  tableSizesRef.current.set(schema, m);
                  let max = 0;
                  m.forEach(v => { if (v.bytes > max) max = v.bytes; });
                  tableSizesMaxRef.current.set(schema, max);
                  sizeLoadingRef.current.delete(sizeKey);
                  setSizeRev(v => v + 1);
                });
              };
              return (
                <div key={gid}>
                  <div
                    onClick={() => { toggleExpanded(gid); if (!open) { if (!items) loadTreeNode(key, () => g.load(schema)); onTblOpen(); } }}
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
            void sizeRev; // re-render trigger

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
              const filtered = Array.from(new Set((items || []).filter(filt)));
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
                          title={gid === 'PUBSYN' || gid === 'REPL' ? '더블클릭: 상세 / 드래그: 이름 삽입' : '더블클릭: 삽입 / 드래그: 이름 삽입'}
                          onDragStart={e => { e.dataTransfer.setData('text/plain', n); e.dataTransfer.setData('application/x-pepe-sql-table', n); e.dataTransfer.effectAllowed = 'copy'; }}
                          onDoubleClick={() => {
                            if (gid === 'PUBSYN') openObjectDetail(n, 'synonym', '');
                            else if (gid === 'REPL') openObjectDetail(n, 'replication', '');
                            else insertAtCursor(insert(n));
                          }}
                          style={{ ...rowStyle(depth + 1), cursor: gid === 'PUBSYN' || gid === 'REPL' ? 'pointer' : 'grab' }} {...hover}
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
              const filtered = Array.from(new Set((items || []).filter(filt)));
              // 테이블스페이스 사이즈 한 번 fetch
              const tbsSizeKey = '__tbsSize__';
              if (tbsOpen && tablespaceSizesRef.current.size === 0 && !sizeLoadingRef.current.has(tbsSizeKey)) {
                sizeLoadingRef.current.add(tbsSizeKey);
                (backend?.tablespaceSizes() ?? Promise.resolve(new Map())).then((m: Map<string, { bytes: number; display: string }>) => {
                  tablespaceSizesRef.current = m;
                  let max = 0;
                  m.forEach(v => { if (v.bytes > max) max = v.bytes; });
                  tablespaceSizeMaxRef.current = max;
                  sizeLoadingRef.current.delete(tbsSizeKey);
                  setSizeRev(v => v + 1);
                });
              }
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
                          {filtered.map(n => {
                            const sz = tablespaceSizesRef.current.get(n.toUpperCase());
                            const max = tablespaceSizeMaxRef.current || 1;
                            const ratio = sz ? Math.max(0.02, Math.min(1, sz.bytes / max)) : 0;
                            return (
                              <div key={n} draggable
                                title="더블클릭: 상세 / 드래그: 이름 삽입"
                                onDragStart={e => { e.dataTransfer.setData('text/plain', n); e.dataTransfer.effectAllowed = 'copy'; }}
                                onDoubleClick={() => openObjectDetail(n, 'tablespace', '')}
                                style={{ ...rowStyle(2), cursor: 'pointer' }} {...hover}
                              >
                                <span style={{ width: 10, display: 'inline-block', flexShrink: 0 }} />
                                <span style={nameSpanStyle}>💾 {n}</span>
                                {sz && (
                                  <span style={gaugeContainerStyle} title={sz.display}>
                                    <span style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${ratio * 100}%`, background: '#3a6691' }} />
                                    <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ddd', fontSize: 10, fontVariantNumeric: 'tabular-nums', textShadow: '0 0 2px #000' }}>{sz.display}</span>
                                  </span>
                                )}
                              </div>
                            );
                          })}
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

            // 관리(Administer) / 시스템 정보(System Info) — DBeaver 패턴. 각 항목 더블클릭 시 사전정의 쿼리 실행.
            type InfoItem = { label: string; icon: string; sql: string; transform?: string };
            const adminInfoConfig = (): { admin: InfoItem[]; sysinfo: InfoItem[] } => {
              switch (backend?.type) {
                case 'mysql': return {
                  admin: [
                    { label: 'Session Manager', icon: '🧑‍💻', sql: 'SHOW FULL PROCESSLIST' },
                    { label: 'Users', icon: '👤', sql: 'SELECT * FROM mysql.user' },
                  ],
                  sysinfo: [
                    { label: 'Session Status', icon: '📊', sql: 'SHOW SESSION STATUS' },
                    { label: 'Global Status', icon: '📊', sql: 'SHOW GLOBAL STATUS' },
                    { label: 'Session Variables', icon: '🔧', sql: 'SHOW SESSION VARIABLES' },
                    { label: 'Global Variables', icon: '🔧', sql: 'SHOW GLOBAL VARIABLES' },
                    { label: 'Engines', icon: '⚙', sql: 'SHOW ENGINES' },
                    { label: 'Charsets', icon: '🔤', sql: 'SHOW CHARACTER SET' },
                    { label: 'User Privileges', icon: '🔐', sql: 'SHOW PRIVILEGES' },
                    { label: 'Plugin', icon: '🔌', sql: 'SHOW PLUGINS' },
                  ],
                };
                case 'altibase': return {
                  admin: [
                    // DBeaver AltibaseServerSessionManager.generateSessionReadQuery() 기반 — 컬럼 순서/이름을 DBeaver 화면과 동일하게.
                    { label: '세션 관리자', icon: '🧑‍💻', sql:
                      `SELECT s.id "Session ID", db_username "User", s.trans_id "Transaction ID", CURRENT_STMT_ID "Statement ID", `
                    + `nvl2(s.query, s.query, ' ') AS "SQL", comm_name "Connection Information", client_type "Client Application Type", `
                    + `CASE2(autocommit_flag = 1, 'T', 'F') "Autocommit", decode(sysdba_flag, 0, 'F', 1, 'T') "SYSDBA", `
                    + `TO_CHAR(conv_timezone(UNIX_TO_DATE( login_time ), '+00:00', db_timezone()), 'YYYY-MM-DD HH24:MI:SS') "Login Time", `
                    + `CASE2(IDLE_START_TIME < 1, '', TO_CHAR(conv_timezone(UNIX_TO_DATE( idle_start_time ), '+00:00', db_timezone()), 'YYYY-MM-DD HH24:MI:SS')) "Idle Since", `
                    + `obj_name "Lock Target", DECODE(is_grant, 1, 'HOLDER', 0, 'WAITER', '') "Lock Status", lock_desc "Lock Type", `
                    + `query_time_limit "Query Time Limit", ddl_time_limit "DDL Time Limit", fetch_time_limit "Fetch Time Limit", `
                    + `utrans_time_limit "UTrans Time Limit", idle_time_limit "Idle Time Limit", nls_territory "NLS Territory", `
                    + `time_zone "Time Zone", client_app_info "Client App Info", client_protocol_version "Client Protocol Version", client_pid "Client PID" `
                    + `FROM (SELECT ss.*, st.query FROM v$session ss LEFT OUTER JOIN v$statement st ON st.session_id = ss.id AND st.tx_id = ss.trans_id AND st.id = ss.current_stmt_id) s `
                    + `LEFT OUTER JOIN (SELECT u.user_name || '.' || a.table_name obj_name, b.trans_id, b.lock_desc, b.is_grant FROM system_.sys_tables_ a, v$lock b, system_.sys_users_ u WHERE u.user_id = a.user_id AND a.table_oid = b.table_oid) l ON s.trans_id = l.trans_id `
                    + `ORDER BY s.id` },
                    { label: '락 관리자', icon: '🔒', sql: 'SELECT * FROM V$LOCK' },
                  ],
                  sysinfo: [
                    // 원시 컬럼만 조회 후 JS 에서 DBeaver AltibaseProperty 와 동일하게 가공(Name/Dynamic/값) — Altibase 타입변환 오류 회피.
                    { label: 'Properties', icon: '📄', sql: `SELECT NAME, ATTR, "MIN", "MAX", VALUE1, VALUE2, VALUE3 FROM V$PROPERTY ORDER BY NAME`, transform: 'altibaseProperty' },
                    // DBeaver AltibaseMemoryModule: 이름/Allocated Size(byte→1.3G)/Allocation Count, max_total_size DESC 정렬.
                    { label: 'Module Memory Usage', icon: '📊', sql: 'SELECT NAME, ALLOC_SIZE, ALLOC_COUNT FROM V$MEMSTAT ORDER BY MAX_TOTAL_SIZE DESC', transform: 'altibaseMemoryModule' },
                  ],
                };
                case 'oracle': return {
                  admin: [
                    { label: 'Session Manager', icon: '🧑‍💻', sql: 'SELECT * FROM V$SESSION' },
                    { label: 'Lock Manager', icon: '🔒', sql: 'SELECT * FROM V$LOCK' },
                  ],
                  sysinfo: [
                    { label: 'Parameters', icon: '🔧', sql: 'SELECT NAME, VALUE FROM V$PARAMETER ORDER BY NAME' },
                    { label: 'Version', icon: '📄', sql: 'SELECT * FROM V$VERSION' },
                    { label: 'SGA', icon: '📊', sql: 'SELECT * FROM V$SGA' },
                  ],
                };
                case 'postgres': return {
                  admin: [
                    { label: 'Session Manager', icon: '🧑‍💻', sql: 'SELECT * FROM pg_stat_activity' },
                    { label: 'Locks', icon: '🔒', sql: 'SELECT * FROM pg_locks' },
                  ],
                  sysinfo: [
                    { label: 'Settings', icon: '🔧', sql: 'SELECT name, setting, unit, category FROM pg_settings ORDER BY name' },
                    { label: 'Roles', icon: '🔐', sql: 'SELECT * FROM pg_roles' },
                    { label: 'Extensions', icon: '🔌', sql: 'SELECT * FROM pg_extension' },
                  ],
                };
                case 'mssql': return {
                  admin: [
                    { label: 'Session Manager', icon: '🧑‍💻', sql: 'SELECT * FROM sys.dm_exec_sessions' },
                    { label: 'Locks', icon: '🔒', sql: 'SELECT * FROM sys.dm_tran_locks' },
                  ],
                  sysinfo: [
                    { label: 'Configurations', icon: '🔧', sql: 'SELECT * FROM sys.configurations ORDER BY name' },
                    { label: 'Databases', icon: '🗄', sql: 'SELECT * FROM sys.databases' },
                  ],
                };
                default: return { admin: [], sysinfo: [] };
              }
            };
            const renderInfoRoot = (rid: string, icon: string, label: string, items: InfoItem[]) => {
              if (!items.length) return null;
              const open = isExpanded(`schema:${rid}`);
              return (
                <div key={rid}>
                  <div onClick={() => toggleExpanded(`schema:${rid}`)} style={{ ...rowStyle(0), color: '#dcdcaa', fontWeight: 600 }} {...hover}>
                    {caret(open)}
                    <span>{icon} {label}</span>
                  </div>
                  {open && (
                    <div>
                      {items.map(it => (
                        <div key={it.label}
                          title={`더블클릭: 상세 — ${it.sql}`}
                          onDoubleClick={() => openInfoTab(it.label, it.icon, it.sql, it.transform)}
                          style={{ ...rowStyle(1), cursor: 'pointer' }} {...hover}
                        >
                          <span style={{ width: 10, display: 'inline-block', flexShrink: 0 }} />
                          <span style={nameSpanStyle}>{it.icon} {it.label}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            };
            const renderAdminInfo = () => {
              const cfg = adminInfoConfig();
              if (!cfg.admin.length && !cfg.sysinfo.length) return null;
              return (
                <>
                  {renderInfoRoot('admin-root', '🛠', '관리', cfg.admin)}
                  {renderInfoRoot('sysinfo-root', 'ℹ', '시스템 정보', cfg.sysinfo)}
                </>
              );
            };

            if (schemasLoading) return <div style={{ color: '#888', padding: 6 }}>스키마 로딩...</div>;
            // 스키마가 없는 DBMS(SQLite 등) — 그룹을 최상위로 평탄 표시 (schema='' 전달)
            if (schemas.length === 0) {
              return <div>{OBJECT_GROUPS.map(g => renderGroupNode('', g, 0))}</div>;
            }
            // 루트: "스키마" 폴더로 user 들을 감쌈 (DBeaver 패턴)
            const schemasRootOpen = isExpanded('schemas-root');
            return (
              <div>
                <div onClick={() => toggleExpanded('schemas-root')} style={{ ...rowStyle(0), color: '#dcdcaa', fontWeight: 600 }} {...hover}>
                  {caret(schemasRootOpen)}
                  <span>📁 스키마</span>
                  <span style={{ marginLeft: 'auto', color: '#666', fontSize: 11 }}>{schemas.length}</span>
                </div>
                {schemasRootOpen && <div>{schemas.map(s => renderSchema(s, 1))}</div>}
                {renderStorageRoot()}
                {renderGlobalMetadata()}
                {renderAdminInfo()}
              </div>
            );
          })()}
        </div>
      </div>
      {/* 좌측 사이드바 리사이저 — 드래그 시 폭 변경 */}
      <div
        onMouseDown={(e) => {
          e.preventDefault();
          const startX = e.clientX;
          const startW = leftSidebarWidth;
          const onMove = (ev: MouseEvent) => {
            const w = Math.max(140, Math.min(700, startW + (ev.clientX - startX)));
            setLeftSidebarWidth(w);
          };
          const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        }}
        style={{ width: 5, cursor: 'col-resize', background: 'transparent', flexShrink: 0, borderRight: '1px solid #333' }}
        title="드래그: 사이드바 크기 조절"
      />

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
            {(() => {
              const st = connecting ? 'connecting' : connected ? 'connected' : 'disconnected';
              const cfg = {
                connecting:   { bg: 'rgba(255,152,0,0.18)',  border: '#ff9800', dot: '#ff9800', text: '#ffb74d', label: '연결 중…' },
                connected:    { bg: 'rgba(76,175,80,0.18)',  border: '#4caf50', dot: '#4caf50', text: '#81c784', label: '연결됨' },
                disconnected: { bg: 'rgba(244,67,54,0.18)',  border: '#f44336', dot: '#f44336', text: '#e57373', label: '연결 안됨' },
              }[st];
              return (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 10px', borderRadius: 12, background: cfg.bg, border: `1px solid ${cfg.border}`, fontSize: 11, fontWeight: 700, color: cfg.text }}>
                  <span style={{ width: 9, height: 9, borderRadius: '50%', background: cfg.dot, boxShadow: st === 'connected' ? `0 0 6px ${cfg.dot}` : 'none' }} />
                  {cfg.label}
                </span>
              );
            })()}
            {!connected && !connecting && <button onClick={connect} style={{ marginLeft: 6, background: '#0e639c', color: '#fff', border: 0, padding: '3px 8px', borderRadius: 3, cursor: 'pointer' }}>연결</button>}
            {connected && !connecting && <button onClick={reconnect} title="연결을 끊고 다시 연결" style={{ marginLeft: 6, background: '#37373d', color: '#ddd', border: '1px solid #555', padding: '3px 8px', borderRadius: 3, cursor: 'pointer' }}>↻ 재연결</button>}
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
                    setConfirmModal({
                      title: '✅ JDBC 사이드카 OK',
                      message:
                        `버전: ${v.version}\nJava: ${v.javaVersion} (${v.javaVendor})\nOS: ${v.os}\n\n` +
                        `JAR: ${r.jar || '(미발견)'}\nJava bin: ${r.java || '(기본)'}\n\n` +
                        `등록된 드라이버 (${drivers.length}):\n${driverLines.join('\n')}\n\n` +
                        `loadDriver 검증:\n${loadResults.join('\n')}\n\n` +
                        `bundled: ${roots.bundled || '(?)'}\nuser:    ${roots.user || '(?)'}`,
                      onOk: () => {},
                    });
                  } else {
                    setConfirmModal({
                      title: '❌ JDBC 사이드카 실패',
                      message: `${r?.error || '?'}\n\nJAR: ${r?.jar || '(미발견)'}\nJava bin: ${r?.java || '(기본)'}`,
                      onOk: () => {},
                    });
                  }
                } catch (e: any) {
                  setConfirmModal({
                    title: '❌ JDBC 사이드카 예외',
                    message: String(e?.message || e),
                    onOk: () => {},
                  });
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
        {connectError && (
          <div style={{ background: '#5a1d1d', color: '#fcc', padding: '6px 8px', fontSize: 12, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <div style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 96, overflow: 'auto', lineHeight: 1.5 }}>{connectError}</div>
            <button onClick={() => setConnectError('')} title="닫기" style={{ background: 'transparent', border: 0, color: '#fcc', cursor: 'pointer', padding: '0 4px', fontSize: 14, lineHeight: 1, flexShrink: 0 }}>✕</button>
          </div>
        )}
        <div style={{ padding: 6, borderBottom: '1px solid #333', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={runCurrent} disabled={!connected || running} style={{ background: showRunning ? '#555' : '#0e639c', color: '#fff', border: 0, padding: '4px 12px', borderRadius: 3, cursor: running ? 'wait' : 'pointer' }} title="Ctrl+Enter — 선택 영역(있으면)/없으면 커서 위치 문장 실행">
            {showRunning ? '실행 중...' : '▶ 실행 (Ctrl+Enter)'}
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
                      <button onClick={() => setConfirmModal({ title: '⭐ 즐겨찾기 삭제', message: `"${f.name}" 을(를) 삭제할까요?`, onOk: () => setFavorites(prev => prev.filter(x => x.id !== f.id)) })} title="삭제" style={{ background: '#5a1d1d', color: '#fff', border: 0, padding: '1px 6px', borderRadius: 2, cursor: 'pointer', fontSize: 11 }}>×</button>
                    </div>
                    <code style={{ color: '#aaa', fontSize: 10, fontFamily: 'monospace', whiteSpace: 'pre-wrap', overflow: 'hidden', maxHeight: 40 }}>{f.sql.slice(0, 200)}{f.sql.length > 200 ? '...' : ''}</code>
                  </div>
                ))}
              </div>
            )}
          </div>
          {showRunning && (
            <button
              onClick={() => { runIdRef.current++; setRunning(false); setResult(prev => prev ? { ...prev, affectedText: '✕ 사용자 취소' } : null); }}
              style={{ background: '#a33', color: '#fff', border: 0, padding: '4px 10px', borderRadius: 3, cursor: 'pointer' }}
              title="실행 중인 쿼리 결과 무시 — 서버에서는 계속 돌지만 UI 는 즉시 반환"
            >
              ⏹ 취소
            </button>
          )}
          {/* CSV/JSON/클립보드/이미지 버튼 제거 — 모두 결과 영역의 "↥ 데이터 추출" 메뉴로 통합됨 */}
          {/* AI 자동 생성 — LogAnalyzer 와 동일 스타일 (teal/blue + 에이전트 dropdown) */}
          <div style={{ display: 'inline-flex', alignItems: 'stretch', borderRadius: 3, position: 'relative' }}>
            <button
              onClick={onAutoGenerate}
              disabled={generating || !sql.trim()}
              title={`편집창의 요청/메모를 ${selectedAgent} 에이전트에 보내 SQL 을 생성하고 편집창 하단에 추가`}
              style={{
                padding: '4px 12px', fontSize: 12, color: '#fff',
                background: generating ? '#555' : '#2b4e74',
                border: '1px solid #3a6593', borderRight: 'none',
                borderRadius: '3px 0 0 3px', cursor: generating ? 'wait' : 'pointer',
              }}
            >🤖 {generating ? '생성 중...' : 'AI 자동 생성'}</button>
            <button
              onClick={() => setAgentMenuOpen(v => !v)}
              disabled={generating}
              title="에이전트 선택"
              style={{
                padding: '4px 6px', fontSize: 12, color: '#fff',
                background: generating ? '#555' : '#2b4e74',
                border: '1px solid #3a6593',
                borderRadius: '0 3px 3px 0', cursor: generating ? 'wait' : 'pointer',
              }}
            >▾</button>
            {agentMenuOpen && (
              <>
                <div onClick={() => setAgentMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 99998 }} />
                <div style={{
                  position: 'absolute', top: '100%', right: 0, marginTop: 4,
                  background: '#1a1a2e', border: '1px solid #3a3a5a', borderRadius: 6,
                  boxShadow: '0 6px 20px rgba(0,0,0,0.5)', zIndex: 99999,
                  minWidth: 160, padding: 4, display: 'flex', flexDirection: 'column', gap: 2,
                }} onClick={e => e.stopPropagation()}>
                  {([
                    { id: 'claude' as const, label: 'Claude', color: '#a070ff' },
                    { id: 'gemini' as const, label: 'Gemini', color: '#4a9eff' },
                    { id: 'codex'  as const, label: 'Codex',  color: '#5cd97a' },
                  ]).map(opt => {
                    const Ico = AGENT_ICON[opt.id];
                    return (
                      <button key={opt.id}
                        onClick={() => { setSelectedAgent(opt.id); setAgentMenuOpen(false); onAutoGenerate(); }}
                        onMouseEnter={e => (e.currentTarget.style.background = opt.color + '22')}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                        style={{
                          background: 'transparent', color: '#ddd', border: 0,
                          padding: '6px 10px', textAlign: 'left', cursor: 'pointer',
                          borderRadius: 4, fontSize: 12, display: 'flex', alignItems: 'center', gap: 8,
                        }}
                      >
                        <Ico />
                        <span>{opt.label} 로 생성</span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
          {copyHint && <span style={{ color: '#9cdcfe', fontSize: 11, marginLeft: 6 }}>{copyHint}</span>}
        </div>
        {/* SQL 에디터 탭 바 */}
        <style>{`.pepe-tab-strip::-webkit-scrollbar{display:none}`}</style>
        <div style={{ display: 'flex', alignItems: 'stretch', background: '#252526', borderBottom: '1px solid #333', minHeight: 28 }}>
          <div
            className="pepe-tab-strip"
            onWheel={e => {
              // 세로 휠을 가로 스크롤로 변환 (가로 휠도 그대로 적용)
              const el = e.currentTarget as HTMLDivElement;
              const delta = e.deltaX !== 0 ? e.deltaX : e.deltaY;
              if (delta !== 0) { el.scrollLeft += delta; }
            }}
            style={{ display: 'flex', flex: 1, overflowX: 'auto', scrollbarWidth: 'none' as any, msOverflowStyle: 'none' as any }}
          >
            {editorTabs.map(t => {
              const active = t.id === activeEditorTabId;
              const isRenaming = renamingTabId === t.id;
              // 객체 탭(테이블/뷰/인덱스 등)은 이름 변경 불가 — DBeaver 동작과 동일.
              const isRenamable = t.kind !== 'object';
              const commitRename = () => {
                const v = renameDraft.trim() || t.title;
                setEditorTabs(prev => prev.map(x => x.id === t.id ? { ...x, title: v } : x));
                setRenamingTabId('');
              };
              const closeThisTab = () => {
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
              };
              return (
                <div
                  key={t.id}
                  onClick={() => setActiveEditorTabId(t.id)}
                  onMouseDown={e => { if (e.button === 1 && editorTabs.length > 1 && !isRenaming) { e.preventDefault(); e.stopPropagation(); closeThisTab(); } }}
                  onAuxClick={e => { if (e.button === 1) e.preventDefault(); }}
                  onDoubleClick={() => { if (isRenamable) { setRenamingTabId(t.id); setRenameDraft(t.title); } }}
                  title={isRenamable ? '더블클릭: 이름 변경 / 휠클릭: 닫기' : t.title + ' (휠클릭: 닫기)'}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '2px 10px', cursor: 'pointer', fontSize: 12,
                    background: active ? '#1e1e1e' : 'transparent',
                    color: active ? '#fff' : '#bbb',
                    borderRight: '1px solid #333',
                    borderTop: active ? '2px solid #0e639c' : '2px solid transparent',
                    flexShrink: 0,
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
                    <span style={{ whiteSpace: 'nowrap' }}>{t.title}</span>
                  )}
                  {editorTabs.length > 1 && !isRenaming && (
                    <span
                      onClick={e => { e.stopPropagation(); closeThisTab(); }}
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
          {/* 탭 목록 드롭다운 (DBeaver 와 동일) */}
          <div style={{ position: 'relative', borderLeft: '1px solid #333' }}>
            <button
              onClick={() => setTabListOpen(v => !v)}
              title="모든 탭 보기"
              style={{ background: 'transparent', color: '#9cdcfe', border: 0, padding: '0 10px', cursor: 'pointer', fontSize: 11, height: '100%' }}
            >▾</button>
            {tabListOpen && (
              <>
                <div onClick={() => setTabListOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 4999 }} />
                <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 2, minWidth: 240, maxHeight: 480, overflowY: 'auto', background: '#252526', border: '1px solid #444', borderRadius: 3, zIndex: 5000, boxShadow: '0 4px 12px rgba(0,0,0,0.6)' }}>
                  {editorTabs.length === 0 ? (
                    <div style={{ padding: 8, color: '#666' }}>탭 없음</div>
                  ) : (
                    editorTabs.map(t => {
                      const isActive = t.id === activeEditorTabId;
                      return (
                        <div
                          key={t.id}
                          onClick={() => { setActiveEditorTabId(t.id); setTabListOpen(false); }}
                          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', cursor: 'pointer', background: isActive ? '#094771' : 'transparent', color: '#ddd', fontSize: 12, borderBottom: '1px solid #2a2a2a', whiteSpace: 'nowrap' }}
                          onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLDivElement).style.background = '#2a2d2e'; }}
                          onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
                        >
                          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title}</span>
                          {editorTabs.length > 1 && (
                            <span
                              onClick={e => {
                                e.stopPropagation();
                                setEditorTabs(prev => {
                                  const next = prev.filter(x => x.id !== t.id);
                                  if (next.length === 0) return [{ id: newTabId(), title: 'Query 1', sql: '' }];
                                  return next;
                                });
                                if (activeEditorTabId === t.id) {
                                  const idx = editorTabs.findIndex(x => x.id === t.id);
                                  const neighbour = editorTabs[idx + 1] || editorTabs[idx - 1];
                                  if (neighbour) setActiveEditorTabId(neighbour.id);
                                }
                              }}
                              title="닫기"
                              style={{ color: '#888', cursor: 'pointer', padding: '0 4px' }}
                            >×</span>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </>
            )}
          </div>
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
          style={{ flex: '1 1 0', minHeight: 80, position: 'relative' }}
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
        {/* 결과/상단 패널 사이 Sash — DBeaver 스타일 (드래그 리사이즈 + ▲▼ 접기/펼치기) */}
        {!(activeTab?.kind === 'object' && !result) && (
          <div style={{ flexShrink: 0, height: 6, background: '#252526', borderTop: '1px solid #333', borderBottom: '1px solid #333', cursor: 'row-resize', position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'visible', zIndex: 4 }}
            onMouseDown={(e) => {
              if ((e.target as HTMLElement).dataset?.role === 'sash-btn') return;
              e.preventDefault();
              const startY = e.clientY;
              const startH = resultPaneCollapsed ? 0 : resultPaneHeight;
              const onMove = (ev: MouseEvent) => {
                const h = Math.max(0, Math.min(window.innerHeight - 200, startH - (ev.clientY - startY)));
                setResultPaneCollapsed(h < 30);
                if (h >= 30) setResultPaneHeight(h);
                setResultPaneMaximized(false);
              };
              const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
              window.addEventListener('mousemove', onMove);
              window.addEventListener('mouseup', onUp);
            }}
            title="드래그: 결과 패널 크기 조절"
          >
            <div style={{ position: 'absolute', top: -7, left: '50%', transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: 0, background: '#1e1e1e', border: '1px solid #3f3f46', borderRadius: 3, height: 16, padding: '0 1px', zIndex: 5 }}>
              <span data-role="sash-btn" title={resultPaneMaximized ? '결과 패널 복원' : '결과 패널 최대화'} onMouseDown={e => e.stopPropagation()} onClick={() => { setResultPaneMaximized(v => !v); setResultPaneCollapsed(false); }}
                style={{ cursor: 'pointer', color: '#9cdcfe', fontSize: 10, lineHeight: '14px', padding: '0 6px', userSelect: 'none', display: 'inline-flex', alignItems: 'center' }}>▲</span>
              <span style={{ width: 1, height: 10, background: '#444' }} />
              <span data-role="sash-btn" title={resultPaneCollapsed ? '결과 패널 펼치기' : '결과 패널 접기'} onMouseDown={e => e.stopPropagation()} onClick={() => { setResultPaneCollapsed(v => !v); setResultPaneMaximized(false); }}
                style={{ cursor: 'pointer', color: '#9cdcfe', fontSize: 10, lineHeight: '14px', padding: '0 6px', userSelect: 'none', display: 'inline-flex', alignItems: 'center' }}>▼</span>
            </div>
          </div>
        )}
        {/* 결과 영역 — 객체 탭일 때는 결과가 있을 때만 표시 (객체 패널에 공간 양보). 높이는 Sash 로 조절. */}
        <div style={{
          flex: resultPaneMaximized ? '1 1 0' : '0 0 auto',
          height: (activeTab?.kind === 'object' && !result) ? 0 : (resultPaneMaximized ? undefined : (resultPaneCollapsed ? 0 : resultPaneHeight)),
          overflow: 'hidden', minHeight: 0, minWidth: 0,
          display: (activeTab?.kind === 'object' && !result) || resultPaneCollapsed ? 'none' : 'flex',
          flexDirection: 'column'
        }}>
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
          {/* 편집 컨트롤 툴바 — 결과 그리드 위 별도 영역 (그리드와 겹치지 않도록 분리). 복사는 스냅샷에서도 가능. */}
          {displayedResult && displayedResult.columns.length > 0 && (() => {
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
              <div style={{ display: 'flex', gap: 4, alignItems: 'center', padding: '4px 8px', background: '#252526', borderBottom: '1px solid #333', flexShrink: 0, flexWrap: 'wrap' }}>
                {!isPinnedView && displayedLastTable && (
                  <span title={pkCols.length > 0 ? `PK: ${pkCols.join(', ')} (UPDATE/DELETE WHERE 에 사용)` : 'PK 미감지 — 모든 컬럼 매칭 폴백'} style={{ fontSize: 10, color: pkCols.length > 0 ? '#9cdcfe' : '#e0a060', background: '#2a2a2a', border: '1px solid #444', padding: '2px 6px', borderRadius: 3 }}>
                    {pkCols.length > 0 ? `🔑 ${pkCols.join(',')}` : '⚠ no PK'}
                  </span>
                )}
                {!isPinnedView && (
                  <button
                    onClick={() => { if (lastTable) runSql(backend!.selectAllForTable(lastTable)); }}
                    disabled={!connected || running || !lastTable}
                    title="새로 고침 — SELECT 재실행 (현재 편집 중인 변경분 유지)"
                    style={{ background: '#3a3a3a', color: '#fff', border: '1px solid #555', padding: '4px 8px', borderRadius: 3, cursor: connected && lastTable ? 'pointer' : 'not-allowed', fontSize: 11 }}
                  >🔄 새로 고침</button>
                )}
                {/* Fetch size — DBeaver "Custom row count" */}
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 4 }} title="Result Set Fetch Size — SELECT 한 번에 가져올 최대 행 수">
                  <span style={{ color: '#9cdcfe', fontSize: 11 }}>⚙</span>
                  <input
                    type="number"
                    min={1}
                    max={MAX_DISPLAY_ROWS}
                    value={fetchSize}
                    onChange={e => setFetchSize(Math.max(1, Math.min(MAX_DISPLAY_ROWS, parseInt(e.target.value || '0', 10) || 1)))}
                    style={{ width: 60, background: '#1e1e1e', color: '#d4d4d4', border: '1px solid #555', borderRadius: 3, padding: '2px 6px', fontSize: 11, textAlign: 'right' }}
                  />
                </span>
                {/* 데이터 추출 dropdown — fixed positioning 으로 부모 overflow 무시 */}
                <div style={{ position: 'relative' }}>
                  <button
                    onClick={(e) => {
                      if (exportMenuOpen) { setExportMenuOpen(false); return; }
                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      // bottom = 뷰포트 하단부터 버튼 위쪽까지 거리. 메뉴는 버튼 위로 펼침.
                      setExportMenuAnchor({ left: rect.right, bottom: window.innerHeight - rect.top + 4 });
                    }}
                    disabled={!displayedResult}
                    title="선택/표시 행 내보내기 — CSV / JSON / SQL INSERT"
                    style={{ background: '#3a3a3a', color: '#fff', border: '1px solid #555', padding: '4px 8px', borderRadius: 3, cursor: displayedResult ? 'pointer' : 'not-allowed', fontSize: 11 }}
                  >↥ 데이터 추출 ▾</button>
                  {exportMenuOpen && exportMenuAnchor && (
                    <>
                      <div onClick={() => setExportMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 9990 }} />
                      <div style={{ position: 'fixed', left: exportMenuAnchor.left, bottom: exportMenuAnchor.bottom, transform: 'translateX(-100%)', background: '#252526', border: '1px solid #555', borderRadius: 3, padding: 4, minWidth: 240, maxHeight: '70vh', overflowY: 'auto', zIndex: 9999, boxShadow: '0 -4px 12px rgba(0,0,0,0.5)' }}>
                        {(() => {
                          const FORMATS: { id: 'csv' | 'tsv' | 'json' | 'sql' | 'md'; label: string; hint: string; ext: string }[] = [
                            { id: 'csv',  label: 'CSV',        hint: '쉼표 구분 (헤더 포함)', ext: 'csv' },
                            { id: 'tsv',  label: 'TSV',        hint: '탭 구분 (헤더 포함)',  ext: 'tsv' },
                            { id: 'json', label: 'JSON',       hint: '배열 형식',           ext: 'json' },
                            { id: 'sql',  label: 'SQL INSERT', hint: 'INSERT INTO …',      ext: 'sql' },
                            { id: 'md',   label: 'Markdown',   hint: '표 형식',             ext: 'md' },
                          ];
                          // 포맷별 직렬화 — 클립보드/파일 양쪽에서 재사용.
                          const serialize = (fmtId: string): string => {
                            if (!displayedResult) return '';
                            const cols = displayedResult.columns;
                            const sel = Array.from(selectedRowIdxs).sort((a, b) => a - b);
                            const idxs = sel.length > 0 ? sel : viewRowIndices;
                            const rows = idxs.map(i => displayedResult.rows[i]);
                            if (fmtId === 'csv' || fmtId === 'tsv') {
                              const sep = fmtId === 'csv' ? ',' : '\t';
                              const esc = (v: string) => {
                                const s = (v ?? '').toString();
                                if (fmtId === 'csv' && /[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
                                return s.replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
                              };
                              return [cols.map(esc).join(sep), ...rows.map(r => r.map(esc).join(sep))].join('\n');
                            }
                            if (fmtId === 'json') {
                              return JSON.stringify(rows.map(r => {
                                const o: Record<string, string> = {};
                                cols.forEach((c, i) => { o[c] = r[i] ?? ''; });
                                return o;
                              }), null, 2);
                            }
                            if (fmtId === 'sql') {
                              const tbl = displayedLastTable || lastTable || 'TABLE';
                              const esc = (v: string) => v === '' ? 'NULL' : `'${v.replace(/'/g, "''")}'`;
                              return rows.map(r => `INSERT INTO ${tbl} (${cols.join(', ')}) VALUES (${r.map(esc).join(', ')});`).join('\n');
                            }
                            if (fmtId === 'md') {
                              const esc = (v: string) => (v ?? '').toString().replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
                              return [
                                '| ' + cols.map(esc).join(' | ') + ' |',
                                '| ' + cols.map(() => '---').join(' | ') + ' |',
                                ...rows.map(r => '| ' + r.map(esc).join(' | ') + ' |'),
                              ].join('\n');
                            }
                            return '';
                          };
                          const itemStyle: React.CSSProperties = { padding: '6px 10px', cursor: 'pointer', fontSize: 11, color: '#d4d4d4', display: 'flex', justifyContent: 'space-between', gap: 12, borderRadius: 2, userSelect: 'none' };
                          const onHover = (e: React.MouseEvent<HTMLDivElement>) => { e.currentTarget.style.background = '#0e639c'; };
                          const onLeave = (e: React.MouseEvent<HTMLDivElement>) => { e.currentTarget.style.background = 'transparent'; };
                          // 1단계 — 대상 선택 (클립보드 / 파일 / 이미지)
                          if (exportMenuPath === null) {
                            return (<>
                              <div onClick={() => setExportMenuPath('clipboard')} onMouseEnter={onHover} onMouseLeave={onLeave} style={itemStyle}>
                                <span>📋 클립보드로 복사</span><span style={{ color: '#888' }}>▸</span>
                              </div>
                              <div onClick={() => setExportMenuPath('file')} onMouseEnter={onHover} onMouseLeave={onLeave} style={itemStyle}>
                                <span>💾 파일로 저장</span><span style={{ color: '#888' }}>▸</span>
                              </div>
                              <div onClick={async () => { setExportMenuOpen(false); await onCopyImage(); }} onMouseEnter={onHover} onMouseLeave={onLeave} style={itemStyle}>
                                <span>🖼 이미지로 복사</span><span style={{ color: '#888', fontSize: 10 }}>PNG → 클립보드</span>
                              </div>
                            </>);
                          }
                          // 2단계 — 포맷 선택 (뒤로가기 헤더 포함)
                          const isClip = exportMenuPath === 'clipboard';
                          return (<>
                            <div onClick={() => setExportMenuPath(null)} onMouseEnter={onHover} onMouseLeave={onLeave} style={{ ...itemStyle, color: '#9cdcfe', borderBottom: '1px solid #333' }}>
                              <span>◂ 뒤로 — {isClip ? '📋 클립보드로 복사' : '💾 파일로 저장'}</span>
                            </div>
                            {FORMATS.map(opt => (
                              <div key={`${exportMenuPath}-${opt.id}`}
                                onClick={async () => {
                                  setExportMenuOpen(false);
                                  let out = serialize(opt.id);
                                  if (!out) return;
                                  if (isClip) {
                                    const rowCount = (selectedRowIdxs.size > 0 ? selectedRowIdxs.size : viewRowIndices.length);
                                    try { await navigator.clipboard.writeText(out); flashHint(`${opt.label} ${rowCount}행 — 클립보드 복사 완료`); }
                                    catch { flashHint('클립보드 복사 실패'); }
                                  } else {
                                    // 파일 저장 — CSV 는 Excel 한글 호환 위해 UTF-8 BOM 부착
                                    if (opt.id === 'csv') out = '﻿' + out;
                                    const baseName = (displayedLastTable || lastTable || 'export').replace(/[\\/:*?"<>|]/g, '_');
                                    const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
                                    const defaultName = `${baseName}_${ts}.${opt.ext}`;
                                    const filters = [
                                      { name: opt.label, extensions: [opt.ext] },
                                      { name: 'All Files', extensions: ['*'] },
                                    ];
                                    const api: any = (window as any).api || {};
                                    const r = await api.saveTextFile?.({ defaultName, content: out, filters });
                                    if (r?.success) flashHint(`💾 저장 완료 — ${r.filePath}`);
                                    else if (!r?.canceled) flashHint(`저장 실패 — ${r?.error || 'unknown'}`);
                                  }
                                }}
                                onMouseEnter={onHover} onMouseLeave={onLeave}
                                style={itemStyle}
                              >
                                <span>{opt.label}</span>
                                <span style={{ color: '#888', fontSize: 10 }}>{isClip ? opt.hint : `.${opt.ext}`}</span>
                              </div>
                            ))}
                          </>);
                        })()}
                        <div style={{ borderTop: '1px solid #444', padding: '6px 10px', fontSize: 10, color: '#888' }}>
                          {selectedRowIdxs.size > 0 ? `선택된 ${selectedRowIdxs.size}행 대상` : `표시된 전체 ${viewRowIndices.length}행 대상`}
                        </div>
                      </div>
                    </>
                  )}
                </div>
                {/* 우측 정렬용 spacer */}
                <span style={{ flex: 1 }} />
                {!isPinnedView && pendingTotal > 0 && (
                  <span title={summaryPieces.join(' / ')} style={{ fontSize: 10, color: '#e0a060', background: '#2a2a2a', border: '1px solid #555', padding: '2px 6px', borderRadius: 3 }}>
                    ● {pendingTotal} 대기
                  </span>
                )}
                {!isPinnedView && (
                  <button
                    onClick={() => setNewRows(prev => [...prev, displayedResult ? displayedResult.columns.map(() => '') : []])}
                    disabled={!displayedLastTable || !displayedResult}
                    title="비어 있는 새 행 추가 (적용 시 INSERT)"
                    style={{ background: '#3a7d3a', color: '#fff', border: 0, padding: '4px 10px', borderRadius: 3, cursor: displayedLastTable ? 'pointer' : 'not-allowed', fontSize: 11, fontWeight: 600 }}
                  >+ 새 행</button>
                )}
                {!isPinnedView && (
                  <button
                    onClick={() => {
                      // 선택된 기존 행을 복제 — 새 INSERT 후보로 추가 (값 그대로). 선택 없으면 비활성.
                      if (!displayedResult || selectedRowIdxs.size === 0) return;
                      const sorted = Array.from(selectedRowIdxs).sort((a, b) => a - b);
                      const cloned = sorted.map(i => displayedResult.rows[i].slice());
                      setNewRows(prev => [...prev, ...cloned]);
                    }}
                    disabled={!displayedLastTable || selectedRowIdxs.size === 0}
                    title={selectedRowIdxs.size > 0 ? `선택된 ${selectedRowIdxs.size}행 복제 (적용 시 INSERT)` : '복제할 행 선택 필요'}
                    style={{ background: selectedRowIdxs.size > 0 ? '#5a7d3a' : '#444', color: '#fff', border: 0, padding: '4px 10px', borderRadius: 3, cursor: selectedRowIdxs.size > 0 ? 'pointer' : 'not-allowed', fontSize: 11, fontWeight: 600 }}
                  >⎘ 복제{selectedRowIdxs.size > 0 ? ` (${selectedRowIdxs.size})` : ''}</button>
                )}
                {!isPinnedView && (
                  <button
                    onClick={() => {
                      // 선택된 행을 삭제 표시 (실제 DELETE 는 적용하기 시점).
                      if (selectedRowIdxs.size === 0) return;
                      setDeletedRowIdxs(prev => {
                        const next = new Set(prev);
                        selectedRowIdxs.forEach(i => next.add(i));
                        return next;
                      });
                    }}
                    disabled={!displayedLastTable || selectedRowIdxs.size === 0}
                    title={selectedRowIdxs.size > 0 ? `선택된 ${selectedRowIdxs.size}행 삭제 표시 (적용 시 DELETE)` : '삭제할 행 선택 필요'}
                    style={{ background: selectedRowIdxs.size > 0 ? '#a04040' : '#444', color: '#fff', border: 0, padding: '4px 10px', borderRadius: 3, cursor: selectedRowIdxs.size > 0 ? 'pointer' : 'not-allowed', fontSize: 11, fontWeight: 600 }}
                  >🗑 삭제{selectedRowIdxs.size > 0 ? ` (${selectedRowIdxs.size})` : ''}</button>
                )}
                {/* 복사/붙여넣기 버튼 제거 — 복제(⎘) 가 동일 워크플로우 커버. 외부 복사는 ↥ 데이터 추출 메뉴 사용. */}
                {!isPinnedView && (
                  <button
                    onClick={() => { setEdits(new Map()); setNewRows([]); setDeletedRowIdxs(new Set()); }}
                    disabled={pendingTotal === 0}
                    title={pendingTotal === 0 ? '취소할 변경 사항 없음' : `${summaryPieces.join(' / ')} 모두 폐기 (DB 영향 없음)`}
                    style={{ background: pendingTotal > 0 ? '#7a3a3a' : '#444', color: '#fff', border: 0, padding: '4px 10px', borderRadius: 3, cursor: pendingTotal > 0 ? 'pointer' : 'not-allowed', fontSize: 11, fontWeight: 600 }}
                  >↶ 취소</button>
                )}
                {!isPinnedView && (
                  <button
                    onClick={onApplyChanges}
                    disabled={!enabled || applying}
                    title={!displayedLastTable ? '단일 테이블 SELECT 결과에서만 사용 가능' : pendingTotal === 0 ? '변경 사항 없음' : `${summaryPieces.join(' / ')} → 단일 트랜잭션 적용`}
                    style={{ background: enabled ? '#c97a2a' : '#888', color: '#fff', border: 0, padding: '4px 12px', borderRadius: 3, cursor: enabled ? 'pointer' : 'not-allowed', fontSize: 11, fontWeight: 600, boxShadow: '0 2px 6px rgba(0,0,0,0.25)' }}
                  >
                    {applying ? '적용 중...' : `✔ 적용하기${pendingTotal > 0 ? ` (${pendingTotal})` : ''}`}
                  </button>
                )}
              </div>
            );
          })()}
          <div
            tabIndex={0}
            onPaste={(e) => {
              // 스냅샷 뷰는 읽기전용 — 붙여넣기 차단
              if (isPinnedView || !displayedResult) return;
              // 셀 인라인 편집 중이면 input 의 paste 가 우선
              if (editingCell) return;
              const text = e.clipboardData.getData('text/plain');
              if (!text) return;
              e.preventDefault();
              const ncols = displayedResult.columns.length;
              // TSV 파싱 — 줄 끝 \r 제거. 빈 줄 제외.
              const lines = text.replace(/\r\n?/g, '\n').split('\n').filter(l => l.length > 0);
              if (!lines.length) return;
              // 헤더 자동 감지 — 첫 줄이 컬럼명과 모두 일치하면 헤더로 스킵
              let startIdx = 0;
              const firstCells = lines[0].split('\t');
              if (firstCells.length === ncols && firstCells.every((c, i) => c === displayedResult.columns[i])) startIdx = 1;
              const pasted: string[][] = [];
              for (let li = startIdx; li < lines.length; li++) {
                const cells = lines[li].split('\t');
                const row: string[] = [];
                for (let j = 0; j < ncols; j++) row.push((cells[j] ?? '').toString());
                pasted.push(row);
              }
              if (!pasted.length) return;
              setNewRows(prev => [...prev, ...pasted]);
            }}
            style={{ flex: 1, overflow: 'auto', minHeight: 0, minWidth: 0, position: 'relative', outline: 'none' }}>
          {displayedResultError && (
            <div style={{ background: '#5a1d1d', color: '#fcc', padding: 8, fontSize: 12, fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>{displayedResultError}</div>
          )}
          {/* 실행 계획(EXPLAIN) 결과 — DBeaver 스타일 트리 렌더 (들여쓰기 + 분기선) */}
          {displayedResult && displayedResult.columns.length === 1 && (displayedResult.columns[0] === 'Plan' || displayedResult.columns[0] === 'plan') && (() => {
            // 1) 구분선 / 빈 줄 제거 + 들여쓰기 길이 측정
            const rawLines = displayedResult.rows.map(r => (r[0] ?? '').toString());
            type Node = { leading: number; text: string };
            const flat: Node[] = [];
            rawLines.forEach(line => {
              const noTrail = line.replace(/\s+$/, '');
              if (!noTrail.trim()) return;
              if (/^-{3,}\s*$/.test(noTrail.trim())) return;
              const leading = noTrail.match(/^(\s*)/)?.[1].length || 0;
              flat.push({ leading, text: noTrail.trim() });
            });
            // 2) 들여쓰기 단위 추정 — 0 이상의 leading 중 최소값(0 제외) 으로 정규화. 안 잡히면 2 가정.
            const leadings = flat.map(n => n.leading).filter(l => l > 0);
            const unit = leadings.length ? Math.min(...leadings) : 2;
            const nodes = flat.map(n => ({ depth: Math.floor(n.leading / unit), text: n.text }));
            // 3) 부모 체인 계산 — 각 노드의 ancestor 깊이별로 "마지막 형제 여부" 트래킹 → 트리 분기 라인 그림.
            const isLastAtDepth: boolean[][] = [];
            for (let i = 0; i < nodes.length; i++) {
              const lastFlags: boolean[] = [];
              // 같은 depth 또는 더 깊은 노드를 더 이상 만나지 않는지 → 마지막 형제 여부
              for (let d = 0; d <= nodes[i].depth; d++) {
                let isLast = true;
                for (let j = i + 1; j < nodes.length; j++) {
                  if (nodes[j].depth < d) break; // ancestor 변경
                  if (nodes[j].depth === d) { isLast = false; break; }
                }
                lastFlags.push(isLast);
              }
              isLastAtDepth.push(lastFlags);
            }
            const sel = Array.from(selectedRowIdxs).sort((a, b) => a - b)[0];
            return (
              <div style={{ padding: 0, background: '#1e1e1e', fontFamily: 'monospace', fontSize: 12 }}>
                <div style={{ padding: '4px 12px', color: '#9cdcfe', fontWeight: 600, borderBottom: '1px solid #333', fontSize: 11, position: 'sticky', top: 0, background: '#252526' }}>Plan String</div>
                {(() => {
                  // 각 노드의 자식 존재 여부 — 다음 노드 depth 가 더 크면 자식 있음
                  const hasChild: boolean[] = nodes.map((n, i) => (i + 1 < nodes.length && nodes[i + 1].depth > n.depth));
                  // 접힌 ancestor 가 있는 노드는 숨김 — visibility 계산
                  const visible: boolean[] = nodes.map(() => true);
                  for (let i = 0; i < nodes.length; i++) {
                    if (!collapsedPlanNodes.has(i) || !hasChild[i]) continue;
                    // i 의 모든 descendant(다음에 등장하는 depth > nodes[i].depth 까지) 숨김
                    for (let j = i + 1; j < nodes.length; j++) {
                      if (nodes[j].depth <= nodes[i].depth) break;
                      visible[j] = false;
                    }
                  }
                  return nodes.map((n, ni) => {
                    if (!visible[ni]) return null;
                    const isSelected = sel === ni;
                    const flags = isLastAtDepth[ni];
                    const collapsed = collapsedPlanNodes.has(ni);
                    const expandable = hasChild[ni];
                    // 분기 라인
                    const prefix: React.ReactNode[] = [];
                    for (let d = 0; d < n.depth; d++) {
                      prefix.push(
                        <span key={`v${d}`} style={{ display: 'inline-block', width: 18, color: '#666', textAlign: 'center' }}>
                          {flags[d] ? ' ' : '│'}
                        </span>
                      );
                    }
                    if (n.depth > 0) {
                      prefix.push(
                        <span key="branch" style={{ display: 'inline-block', width: 18, color: '#888', textAlign: 'center' }}>
                          {flags[n.depth] ? '└' : '├'}─
                        </span>
                      );
                    }
                    // 펼침/접힘 토글 캐럿 — 자식 있는 노드에만 표시
                    const toggle = expandable ? (
                      <span
                        onClick={e => {
                          e.stopPropagation();
                          setCollapsedPlanNodes(prev => {
                            const next = new Set(prev);
                            if (next.has(ni)) next.delete(ni); else next.add(ni);
                            return next;
                          });
                        }}
                        title={collapsed ? '펼치기' : '접기'}
                        style={{ display: 'inline-block', width: 14, color: '#9cdcfe', textAlign: 'center', cursor: 'pointer', userSelect: 'none' }}
                      >{collapsed ? '▸' : '▾'}</span>
                    ) : (
                      <span style={{ display: 'inline-block', width: 14, color: '#555', textAlign: 'center' }}>·</span>
                    );
                    const m = n.text.match(/^(\S+)(\s*\(.*)?$/);
                    const op = m ? m[1] : n.text;
                    const rest = m && m[2] ? m[2] : '';
                    return (
                      <div key={ni}
                        onClick={() => setSelectedRowIdxs(new Set([ni]))}
                        onDoubleClick={() => {
                          if (!expandable) return;
                          setCollapsedPlanNodes(prev => {
                            const next = new Set(prev);
                            if (next.has(ni)) next.delete(ni); else next.add(ni);
                            return next;
                          });
                        }}
                        style={{
                          padding: '3px 12px',
                          cursor: 'pointer',
                          background: isSelected ? '#7a3a3a' : 'transparent',
                          color: isSelected ? '#fff' : '#d4d4d4',
                          whiteSpace: 'pre',
                          userSelect: 'text',
                          display: 'flex', alignItems: 'center',
                        }}
                        title={expandable ? '더블클릭: 자식 펼치기/접기' : undefined}
                      >
                        {prefix}
                        {toggle}
                        <span style={{ marginLeft: 4, color: isSelected ? '#fff' : '#dcdcaa', fontWeight: 600 }}>{op}</span>
                        <span style={{ color: isSelected ? '#fff' : '#9cdcfe' }}>{rest}</span>
                      </div>
                    );
                  });
                })()}
                {nodes.length === 0 && (
                  <div style={{ padding: 12, color: '#666' }}>(빈 PLAN)</div>
                )}
              </div>
            );
          })()}
          {displayedResult && displayedResult.columns.length > 0 && !(displayedResult.columns.length === 1 && (displayedResult.columns[0] === 'Plan' || displayedResult.columns[0] === 'plan')) && (
            <>
              <table style={{ borderCollapse: 'separate', borderSpacing: 0, width: 'max-content', minWidth: '100%', fontFamily: 'monospace', fontSize: 12, color: '#d4d4d4' }}>
                <thead>
                  <tr>
                    {/* # 컬럼: 항상 좌상단 sticky */}
                    <th style={{ position: 'sticky', top: 0, left: 0, background: '#2d2d2d', color: '#9cdcfe', padding: '5px 10px', textAlign: 'center', border: '1px solid #3f3f46', fontWeight: 600, zIndex: 5, width: INDEX_COL_W, minWidth: INDEX_COL_W }}>#</th>
                    {(colOrder.length === displayedResult.columns.length ? colOrder : displayedResult.columns.map((_, k) => k)).map((i) => {
                      const c = displayedResult.columns[i];
                      const sortDir = sortState?.col === i ? sortState.dir : null;
                      const sortIcon = sortDir === 'asc' ? '▲' : sortDir === 'desc' ? '▼' : '';
                      const pinned = pinnedCols.has(i);
                      const w = getColWidth(i);
                      const isDragging = dragColIdx === i;
                      const isDropTarget = dragOverColIdx === i && dragColIdx !== null && dragColIdx !== i;
                      return (
                        <th
                          key={i}
                          draggable
                          onDragStart={e => { setDragColIdx(i); try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); } catch {} }}
                          onDragOver={e => { if (dragColIdx !== null && dragColIdx !== i) { e.preventDefault(); try { e.dataTransfer.dropEffect = 'move'; } catch {} if (dragOverColIdx !== i) setDragOverColIdx(i); } }}
                          onDragLeave={() => { if (dragOverColIdx === i) setDragOverColIdx(null); }}
                          onDrop={e => {
                            e.preventDefault();
                            const from = dragColIdx;
                            setDragColIdx(null); setDragOverColIdx(null);
                            if (from === null || from === i) return;
                            // 현재 순서(없으면 기본) 에서 from 을 i 의 표시 위치로 이동
                            const cur = colOrder.length === displayedResult.columns.length ? [...colOrder] : displayedResult.columns.map((_, k) => k);
                            const fromPos = cur.indexOf(from);
                            const toPos = cur.indexOf(i);
                            if (fromPos < 0 || toPos < 0) return;
                            cur.splice(fromPos, 1);
                            cur.splice(toPos, 0, from);
                            setColOrder(cur);
                          }}
                          onDragEnd={() => { setDragColIdx(null); setDragOverColIdx(null); }}
                          onClick={() => setSortState(prev => {
                            if (!prev || prev.col !== i) return { col: i, dir: 'asc' };
                            if (prev.dir === 'asc') return { col: i, dir: 'desc' };
                            return null; // asc → desc → 없음
                          })}
                          title="클릭: 정렬 (오름→내림→해제) · 헤더 드래그: 컬럼 순서 이동"
                          style={{
                            position: 'sticky', top: 0,
                            ...(pinned ? { left: pinnedLeftFor(i), zIndex: 4 } : { zIndex: 2 }),
                            background: isDropTarget ? '#3d3d8a' : '#2d2d2d',
                            color: '#9cdcfe', padding: '5px 12px', textAlign: 'left',
                            border: '1px solid #3f3f46', borderLeft: 0,
                            borderLeftColor: isDropTarget ? '#5a8eff' : undefined,
                            borderLeftWidth: isDropTarget ? 2 : undefined,
                            fontWeight: 600, whiteSpace: 'nowrap', cursor: 'pointer', userSelect: 'none',
                            width: w, minWidth: w, maxWidth: w, overflow: 'hidden',
                            opacity: isDragging ? 0.4 : 1,
                          }}
                        >
                          <span
                            onClick={e => { e.stopPropagation(); togglePin(i); }}
                            title={pinned ? '고정 해제' : '좌측 고정'}
                            style={{ marginRight: 4, opacity: pinned ? 1 : 0.4, cursor: 'pointer' }}
                          >📌</span>
                          {c}{sortIcon ? ` ${sortIcon}` : ''}
                          {/* 우측 리사이즈 핸들 — draggable=false 로 컬럼 드래그와 분리 */}
                          <span
                            draggable={false}
                            onDragStart={e => { e.preventDefault(); e.stopPropagation(); }}
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
                    {(colOrder.length === displayedResult.columns.length ? colOrder : displayedResult.columns.map((_, k) => k)).map((i) => {
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
                      <td title={`원본 행 #${i + 1}${isDeleted ? ' (삭제 표시)' : ''}${selectedRowIdxs.has(i) ? ' · 선택됨' : ''}`} style={{ position: 'sticky', left: 0, zIndex: 1, padding: 0, color: '#888', background: selectedRowIdxs.has(i) ? '#264f78' : (isDeleted ? '#3a1d1d' : '#252525'), border: '1px solid #3f3f46', borderTop: 0, textAlign: 'center', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', width: INDEX_COL_W, minWidth: INDEX_COL_W }}>
                        {isPinnedView ? (
                          <span
                            onClick={(e) => {
                              setSelectedRowIdxs(prev => {
                                const n = new Set(prev);
                                if (e.shiftKey && lastSelectedRowRef.current !== null) {
                                  const idxs = viewRowIndices;
                                  const a = idxs.indexOf(lastSelectedRowRef.current);
                                  const b = idxs.indexOf(i);
                                  if (a >= 0 && b >= 0) { const [lo, hi] = a < b ? [a, b] : [b, a]; for (let k = lo; k <= hi; k++) n.add(idxs[k]); }
                                } else if (e.ctrlKey || e.metaKey) {
                                  if (n.has(i)) n.delete(i); else n.add(i);
                                } else {
                                  // 단일 선택 — 이미 그 행만 선택돼 있으면 해제, 아니면 새로 단일 선택
                                  if (n.size === 1 && n.has(i)) { n.clear(); }
                                  else { n.clear(); n.add(i); }
                                }
                                return n;
                              });
                              lastSelectedRowRef.current = i;
                            }}
                            title="클릭: 선택 / Ctrl+클릭: 토글 / Shift+클릭: 범위"
                            style={{ padding: '4px 8px', display: 'inline-block', cursor: 'pointer', userSelect: 'none' }}
                          >{displayIdx + 1}</span>
                        ) : (
                          <span
                            onClick={(e) => {
                              if (e.altKey) {
                                setDeletedRowIdxs(prev => { const n = new Set(prev); if (n.has(i)) n.delete(i); else n.add(i); return n; });
                                return;
                              }
                              setSelectedRowIdxs(prev => {
                                const n = new Set(prev);
                                if (e.shiftKey && lastSelectedRowRef.current !== null) {
                                  const idxs = viewRowIndices;
                                  const a = idxs.indexOf(lastSelectedRowRef.current);
                                  const b = idxs.indexOf(i);
                                  if (a >= 0 && b >= 0) { const [lo, hi] = a < b ? [a, b] : [b, a]; for (let k = lo; k <= hi; k++) n.add(idxs[k]); }
                                } else if (e.ctrlKey || e.metaKey) {
                                  if (n.has(i)) n.delete(i); else n.add(i);
                                } else {
                                  // 단일 선택 — 이미 그 행만 선택돼 있으면 해제, 아니면 새로 단일 선택
                                  if (n.size === 1 && n.has(i)) { n.clear(); }
                                  else { n.clear(); n.add(i); }
                                }
                                return n;
                              });
                              lastSelectedRowRef.current = i;
                            }}
                            title={'클릭: 선택 / Ctrl+클릭: 토글 / Shift+클릭: 범위 / Alt+클릭: ' + (isDeleted ? '삭제 표시 해제' : '삭제 표시')}
                            style={{ padding: '4px 4px', display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer', justifyContent: 'center', userSelect: 'none' }}
                          >
                            <span style={{ color: isDeleted ? '#ff8080' : (selectedRowIdxs.has(i) ? '#fff' : '#888'), fontSize: 11 }}>{isDeleted ? '🗑' : displayIdx + 1}</span>
                          </span>
                        )}
                      </td>
                      {(colOrder.length === displayedResult.columns.length ? colOrder : row.map((_, k) => k)).map((j) => {
                        const c = row[j];
                        const key = `${i},${j}`;
                        const edited = !isPinnedView && edits.has(key);
                        const value = edited ? edits.get(key)! : c;
                        const isEditing = !isPinnedView && editingCell === key;
                        const pinned = pinnedCols.has(j);
                        const w = getColWidth(j);
                        return (
                          <td key={j} style={{
                            padding: 0, border: '1px solid #3f3f46', borderTop: 0, borderLeft: 0,
                            background: selectedRowIdxs.has(i) ? '#264f78' : (isDeleted ? '#3a1d1d' : (edited ? '#3d2a14' : (i % 2 ? '#222' : '#1e1e1e'))),
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
                                onFocus={e => { try { e.currentTarget.select(); } catch {} }}
                                onMouseDown={e => e.stopPropagation()}
                                onClick={e => e.stopPropagation()}
                                spellCheck={false}
                                style={{ width: '100%', boxSizing: 'border-box', background: '#1a1a1a', color: edited ? '#ffd680' : '#d4d4d4', border: '1px solid #569cd6', padding: '3px 11px', fontFamily: 'monospace', fontSize: 12, outline: 'none', display: 'block' }}
                              />
                            ) : (
                              <div
                                onDoubleClick={() => { if (!isPinnedView) setEditingCell(key); }}
                                title={(value.length > 40 ? value + '\n\n' : '') + (isPinnedView ? '' : '더블클릭: 편집')}
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
                            {(() => {
                              const newKey = `new-${ni},${j}`;
                              const isEditingNew = editingCell === newKey;
                              return isEditingNew ? (
                                <input
                                  autoFocus
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
                                  onBlur={() => setEditingCell(null)}
                                  onKeyDown={e => {
                                    if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); setEditingCell(null); }
                                  }}
                                  onFocus={e => { try { e.currentTarget.select(); } catch {} }}
                                  onMouseDown={e => e.stopPropagation()}
                                  onClick={e => e.stopPropagation()}
                                  spellCheck={false}
                                  placeholder="NULL"
                                  style={{ width: '100%', boxSizing: 'border-box', background: '#1a2a1a', color: '#bef5be', border: '1px solid #569cd6', padding: '3px 10px', fontFamily: 'monospace', fontSize: 12, outline: 'none', display: 'block' }}
                                />
                              ) : (
                                <div
                                  onDoubleClick={() => setEditingCell(newKey)}
                                  title="더블클릭: 편집 — 적용하기 전까지 수정 가능"
                                  style={{ padding: '4px 11px', color: v ? '#bef5be' : '#5a8a5a', fontStyle: v ? 'normal' : 'italic', fontFamily: 'monospace', fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', cursor: 'cell', minHeight: 14 }}
                                >{v || 'NULL'}</div>
                              );
                            })()}
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

      {/* 우측 히스토리 리사이저 (핀 상태일 때만) */}
      {historyPinned && (
        <div
          onMouseDown={(e) => {
            e.preventDefault();
            const startX = e.clientX;
            const startW = rightSidebarWidth;
            const onMove = (ev: MouseEvent) => {
              const w = Math.max(180, Math.min(700, startW - (ev.clientX - startX)));
              setRightSidebarWidth(w);
            };
            const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
          }}
          style={{ width: 5, cursor: 'col-resize', background: 'transparent', flexShrink: 0, borderLeft: '1px solid #333' }}
          title="드래그: 히스토리 크기 조절"
        />
      )}
      {/* 우측: 히스토리 */}
      {historyPinned ? (
      <div style={{ width: rightSidebarWidth, flexShrink: 0, display: 'flex', flexDirection: 'column', borderLeft: '1px solid #333', minHeight: 0 }}>
        <div style={{ padding: 8, borderBottom: '1px solid #333', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontWeight: 600 }}>📜 히스토리</span>
          <button onClick={() => setHistoryPinned(false)} title="고정 해제 (Unpin)" style={{ marginLeft: 'auto', background: 'transparent', color: '#888', border: '1px solid #444', cursor: 'pointer', padding: '2px 6px', borderRadius: 3, fontSize: 11 }}>📍</button>
          <button onClick={() => setConfirmModal({ title: '📜 히스토리 비우기', message: '히스토리 전부를 삭제할까요?', onOk: () => { setHistory([]); saveHistory(sessionId, []); } })} style={{ background: 'transparent', color: '#888', border: '1px solid #444', cursor: 'pointer', padding: '2px 6px', borderRadius: 3, fontSize: 11 }}>비우기</button>
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
      ) : (
        // Unpinned: 좁은 세로 바만 표시. 클릭 시 다시 펼침.
        <div
          onClick={() => setHistoryPinned(true)}
          title="히스토리 펼치기 (Pin)"
          style={{ width: 24, flexShrink: 0, borderLeft: '1px solid #333', cursor: 'pointer', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '8px 0', background: '#1e1e1e', color: '#888', writingMode: 'vertical-rl', fontSize: 11 }}
        >📜 히스토리</div>
      )}
      <DriverManagerModal open={driverManagerOpen} onClose={() => setDriverManagerOpen(false)} />
      {confirmModal && (
        <div
          onClick={() => setConfirmModal(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 6100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ background: '#252526', color: '#d4d4d4', borderRadius: 6, padding: 16, width: 380, boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }}
          >
            <div style={{ fontWeight: 600, marginBottom: 10, fontSize: 13 }}>{confirmModal.title}</div>
            <div style={{ fontSize: 12, marginBottom: 14, color: '#bbb', whiteSpace: 'pre-wrap', fontFamily: 'monospace', maxHeight: 320, overflowY: 'auto' }}>{confirmModal.message}</div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button autoFocus
                onKeyDown={e => { if (e.key === 'Escape') setConfirmModal(null); }}
                onClick={() => setConfirmModal(null)}
                style={{ background: '#444', color: '#fff', border: 0, padding: '5px 14px', borderRadius: 3, cursor: 'pointer', fontSize: 12 }}
              >취소</button>
              <button
                onClick={() => { const ok = confirmModal.onOk; setConfirmModal(null); ok(); }}
                style={{ background: '#c0392b', color: '#fff', border: 0, padding: '5px 14px', borderRadius: 3, cursor: 'pointer', fontSize: 12 }}
              >확인</button>
            </div>
          </div>
        </div>
      )}
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
