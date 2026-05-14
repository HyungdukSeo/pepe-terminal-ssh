// src/components/SqlToolWorkspace.tsx
// Altibase SQL Tool — SSH exec 채널로 isql 을 실행해 쿼리/결과/히스토리 제공.
import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';

type DbmsCfg = { type: 'altibase'; port: number; user: string; password: string; host?: string };

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

const HISTORY_KEY_PREFIX = 'sqltool-history-';
const HISTORY_MAX = 200;

function loadHistory(sessionId: string): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY_PREFIX + sessionId);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function saveHistory(sessionId: string, entries: HistoryEntry[]) {
  try {
    const trimmed = entries.slice(0, HISTORY_MAX);
    localStorage.setItem(HISTORY_KEY_PREFIX + sessionId, JSON.stringify(trimmed));
  } catch {}
}

// isql 실행 후 stdout 을 받아 헤더+구분선 기반으로 컬럼/로우 파싱.
// Altibase isql 출력 예시:
//   COL1        COL2
//   ----------- -----------
//   1           foo
//   2           bar
//   2 rows selected.
// 거대 출력 안전 캡 — 이 이상이면 잘라 렌더러 sync 락 방지
const MAX_PARSE_BYTES = 10 * 1024 * 1024;
// 그리드에 렌더할 최대 행 수 — div 로 셀 렌더하므로 1만행도 부담스럽지 않지만,
// SELECT 결과 확인+간단 편집 용도이므로 2000 정도가 실용적 상한
const MAX_DISPLAY_ROWS = 2000;

function parseIsqlOutput(stdoutRaw: string): ParsedResult {
  try {
    return parseIsqlOutputUnsafe(stdoutRaw);
  } catch (e: any) {
    console.error('[SqlTool] parse 실패 — raw 텍스트로 fallback:', e);
    const tail = (stdoutRaw || '').slice(-2000);
    return { columns: [], rows: [], affectedText: `⚠ 결과 파싱 실패: ${e?.message || e}`, raw: tail };
  }
}

function parseIsqlOutputUnsafe(stdoutRaw: string): ParsedResult {
  const truncated = (stdoutRaw?.length || 0) > MAX_PARSE_BYTES;
  const stdout = truncated ? stdoutRaw.slice(0, MAX_PARSE_BYTES) : (stdoutRaw || '');
  const lines = stdout.split(/\r?\n/);
  // 안전상 라인 수 한도
  const MAX_LINES = 1_000_000;
  if (lines.length > MAX_LINES) lines.length = MAX_LINES;
  // 개별 라인이 비정상적으로 길면 (헤더가 한 줄에 다 들어온 비정상 출력) regex 백트래킹 폭주 방지로 잘라냄
  const MAX_LINE_LEN = 100_000;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length > MAX_LINE_LEN) lines[i] = lines[i].slice(0, MAX_LINE_LEN);
  }
  // "---" 구분선 찾기
  let sepIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^[\s\-]+$/.test(l) && l.includes('-')) { sepIdx = i; break; }
  }
  if (sepIdx < 1) {
    const tail = lines.filter(l => l.trim()).slice(-3).join('\n');
    return { columns: [], rows: [], affectedText: tail, raw: stdout };
  }
  const sepLine = lines[sepIdx];
  const headerLine = lines[sepIdx - 1];

  // 1) 구분선의 dash 그룹 위치 추출
  const dashSpans: { start: number; end: number }[] = [];
  {
    let i = 0;
    while (i < sepLine.length) {
      if (sepLine[i] === '-') {
        const start = i;
        while (i < sepLine.length && sepLine[i] === '-') i++;
        dashSpans.push({ start, end: i });
      } else {
        i++;
      }
    }
  }

  // 2) 헤더 라인에서 단어 경계 추출 (2+ 공백 또는 dash 경계 기준)
  // 헤더와 dash 그룹 수가 같으면 dash spans 사용. 다르면 헤더 자체 단어 분리로 spans 재계산.
  let colSpans: { start: number; end: number }[];
  // 헤더의 비공백 단어들을 찾아서 그 시작 위치를 기준으로 spans 생성
  const headerWords: { start: number; end: number; text: string }[] = [];
  {
    // 단어 = 비공백 + (단일공백+비공백)* — 2+ 공백에서 끊김
    const re2 = /\S(?:[^\s]|\s(?!\s))*/g;
    let m: RegExpExecArray | null;
    while ((m = re2.exec(headerLine)) !== null) {
      headerWords.push({ start: m.index, end: m.index + m[0].length, text: m[0].trim() });
    }
  }

  if (dashSpans.length === headerWords.length && dashSpans.length > 0) {
    colSpans = dashSpans;
  } else if (headerWords.length > 0) {
    // 헤더 단어 시작점을 기준으로 — 다음 단어 시작 직전까지가 해당 컬럼 영역
    colSpans = headerWords.map((w, i) => ({
      start: w.start,
      end: i + 1 < headerWords.length ? headerWords[i + 1].start : Math.max(sepLine.length, headerLine.length, 9999),
    }));
  } else {
    // 둘 다 실패 시 단일 컬럼 fallback
    colSpans = [{ start: 0, end: 9999 }];
  }

  const sliceCol = (line: string, span: { start: number; end: number }) =>
    (line.substring(span.start, span.end) || '').replace(/\s+$/, '').replace(/^\s+/, '');
  const columns = colSpans.map((s, i) => headerWords[i]?.text || sliceCol(headerLine, s));

  const rows: string[][] = [];
  let affected = '';
  for (let li = sepIdx + 1; li < lines.length; li++) {
    const line = lines[li];
    if (!line.trim()) continue;
    if (/^\s*\d+\s+rows?\s+selected/i.test(line) || (/selected/i.test(line) && /row/i.test(line))) {
      affected = line.trim();
      break;
    }
    if (/^[\s\-]+$/.test(line)) continue;
    const cells = colSpans.map(s => sliceCol(line, s));
    // 긴 값 줄바꿈 처리 — 첫 N-1 컬럼이 모두 비어 있으면 이전 행의 해당 컬럼들에 이어붙임
    const nonEmptyCols = cells.map((c, i) => c !== '' ? i : -1).filter(i => i >= 0);
    const isContinuation = rows.length > 0 && nonEmptyCols.length > 0 && nonEmptyCols.every(i => i > 0 && cells[i] !== '' && (cells.slice(0, i).every(v => v === '')));
    if (isContinuation) {
      const last = rows[rows.length - 1];
      cells.forEach((c, i) => { if (c) last[i] = (last[i] || '') + c; });
    } else {
      rows.push(cells);
    }
    if (rows.length >= MAX_DISPLAY_ROWS) {
      affected = `⚠ 출력 ${rows.length}행에서 잘림 (그리드 렌더 보호). LIMIT/WHERE 직접 사용 권장.`;
      break;
    }
  }
  if (truncated && !affected) {
    affected = `⚠ 출력 ${Math.floor(MAX_PARSE_BYTES / (1024*1024))}MB 이상이라 잘림. LIMIT/WHERE 직접 사용 권장.`;
  }
  return { columns, rows, affectedText: affected, raw: stdout };
}

// monospace textarea 가정 — clientX/Y → 행/열 → 문자 오프셋.
function getTextareaCaretFromPoint(ta: HTMLTextAreaElement, clientX: number, clientY: number): number {
  const rect = ta.getBoundingClientRect();
  const cs = getComputedStyle(ta);
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padT = parseFloat(cs.paddingTop) || 0;
  const bordL = parseFloat(cs.borderLeftWidth) || 0;
  const bordT = parseFloat(cs.borderTopWidth) || 0;
  let lineH = parseFloat(cs.lineHeight);
  if (!lineH || isNaN(lineH)) lineH = (parseFloat(cs.fontSize) || 13) * 1.2;
  // 글자 폭 측정 — 'M' 1글자 폭으로 monospace 가정
  const probe = document.createElement('span');
  probe.textContent = 'M';
  probe.style.cssText = `position:absolute;visibility:hidden;font-family:${cs.fontFamily};font-size:${cs.fontSize};font-weight:${cs.fontWeight};letter-spacing:${cs.letterSpacing};white-space:pre`;
  document.body.appendChild(probe);
  const charW = probe.getBoundingClientRect().width || 8;
  document.body.removeChild(probe);

  const xInText = clientX - rect.left - bordL - padL + ta.scrollLeft;
  const yInText = clientY - rect.top - bordT - padT + ta.scrollTop;
  const row = Math.max(0, Math.floor(yInText / lineH));
  const col = Math.max(0, Math.round(xInText / charW));

  // 행/열 → 문자 오프셋
  const lines = ta.value.split('\n');
  const targetRow = Math.min(row, lines.length - 1);
  let offset = 0;
  for (let i = 0; i < targetRow; i++) offset += lines[i].length + 1;
  const lineLen = lines[targetRow]?.length ?? 0;
  offset += Math.min(col, lineLen);
  return Math.min(offset, ta.value.length);
}

function shellQuote(s: string): string {
  // single-quote escape for posix shell
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function buildIsqlCommand(dbms: DbmsCfg, sql: string): string {
  // isql 의 -f 옵션으로 임시 파일 실행이 가장 안전하나, 여기선 stdin pipe 로 처리.
  // 동작: cat << 'PEPE_SQL_EOF' | isql -s host -u U -p P -port N -silent
  // 종결자 PEPE_SQL_EOF 와 SQL 이 충돌하지 않도록 랜덤하지 않은 고정값 사용 (사용자 SQL 에 동일 토큰 있을 가능성 매우 낮음)
  const host = dbms.host || '127.0.0.1';
  const port = dbms.port || 20300;
  // SQL 끝에 ; 가 없으면 붙이고, 마지막에 quit 추가
  let normalized = sql.trim();
  if (!normalized.endsWith(';')) normalized += ';';
  normalized += '\nquit;\n';
  // here-doc 으로 stdin 주입
  return `isql -s ${shellQuote(host)} -u ${shellQuote(dbms.user)} -p ${shellQuote(dbms.password)} -port ${port} -silent <<'PEPE_SQL_EOF'\n${normalized}PEPE_SQL_EOF`;
}

export const SqlToolWorkspace: React.FC<Props> = ({ sessionId, sessionName, aiAgent = 'claude' }) => {
  const [session, setSession] = useState<Session | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [connectError, setConnectError] = useState<string>('');
  const [sql, setSql] = useState<string>(() => localStorage.getItem(`sqltool-sql-${sessionId}`) || '');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ParsedResult | null>(null);
  const [resultError, setResultError] = useState<string>('');
  const [tables, setTables] = useState<string[]>([]);
  const [tablesLoading, setTablesLoading] = useState(false);
  const [tableFilter, setTableFilter] = useState('');
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory(sessionId));
  const [historyFilter, setHistoryFilter] = useState('');
  // 결과 그리드 셀 편집 상태 — Map<"row,col", newValue>
  const [edits, setEdits] = useState<Map<string, string>>(new Map());
  // 마지막 실행한 SELECT 의 테이블명 (UPDATE 생성용)
  const [lastTable, setLastTable] = useState<string>('');
  const [applying, setApplying] = useState(false);
  const [copyHint, setCopyHint] = useState<string>('');
  // 현재 편집 중인 셀 — "row,col" 또는 null
  const [editingCell, setEditingCell] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const connIdRef = useRef<string>(`sql-${sessionId}-${Date.now()}`);
  const generateDisposeRef = useRef<(() => void) | null>(null);

  // 자동 페이지네이션 임계치/페이지 크기. SELECT 대용량 결과를 한 번에 로드하지 않고
  // COUNT 로 전체 행수 확인 후 페이지 단위로 점진 로딩.
  const PAGE_SIZE = 1000;
  const SINGLE_SHOT_THRESHOLD = 2000;
  // SELECT 이면서 LIMIT 없고 단일행 집계도 아닐 때만 페이지네이션 대상.
  const isPaginableSelect = (sqlText: string): boolean => {
    const t = sqlText.trim().replace(/;+\s*$/, '');
    if (!/^\s*select\b/i.test(t)) return false;
    if (/\blimit\s+\d/i.test(t)) return false;
    // 단일행 집계 (단일 컬럼만) — SELECT COUNT(*) FROM ...
    if (/^\s*select\s+(count|sum|avg|min|max)\s*\(/i.test(t)
        && !/,/.test((t.split(/\bfrom\b/i)[0] || ''))) return false;
    return true;
  };
  const wrapForCount = (sqlText: string): string => {
    const t = sqlText.trim().replace(/;+\s*$/, '');
    // Altibase 서브쿼리는 alias 필수
    return `SELECT COUNT(*) FROM (${t}) _pepe_cnt`;
  };
  const wrapWithLimit = (sqlText: string, offset: number, count: number): string => {
    const t = sqlText.trim().replace(/;+\s*$/, '');
    return `${t} LIMIT ${offset}, ${count}`;
  };
  // 진행 중인 페이지네이션 식별 — 새 runSql 호출 시 이전 작업 무효화
  const runIdRef = useRef<number>(0);

  // SSH 연결이 끊겼는지 판단하는 에러 패턴 — 죽은 connId 는 영구히 죽어서 재연결 필요
  const isDeadConnError = (msg: string): boolean => {
    if (!msg) return false;
    return /not connected|channel.*open failed|channel.*closed|connection.*(reset|lost|closed|refused)|ECONNRESET|EPIPE|ENOTCONN|not authenticated|client.*not connected/i.test(msg);
  };
  // sqlExec 실행 + 연결 끊김 자동 감지/재연결.
  // 끊김으로 판단되면 새 connId 로 재연결하고 한 번 더 같은 명령을 재시도. 성공/실패 결과 그대로 반환.
  const sqlExecWithRetry = useCallback(async (command: string, timeoutMs?: number): Promise<{ success: boolean; stdout?: string; stderr?: string; error?: string }> => {
    const api = (window as any).api;
    const tryOnce = () => api?.sqlExec(connIdRef.current, command, timeoutMs);
    let r = await tryOnce();
    if (r?.success) return r;
    if (!isDeadConnError(r?.error || '')) return r;
    // 연결 끊김 → 새 connId 로 재연결 후 1회 재시도
    if (!session?.dbms) return r;
    setConnected(false);
    try { api?.feSftpDisconnect?.(connIdRef.current); } catch {}
    connIdRef.current = `sql-${sessionId}-${Date.now()}`;
    setConnecting(true);
    try {
      const jumpOpts = session.jumpTargetHost
        ? { host: session.jumpTargetHost, user: session.jumpTargetUser, port: session.jumpTargetPort, password: session.jumpTargetPassword }
        : undefined;
      const cr = await api?.feSftpConnect(connIdRef.current, session.host, session.port || 22, session.username, session.auth, jumpOpts);
      if (!cr?.success) {
        setConnectError(cr?.error || '재연결 실패');
        return r; // 원래 에러 그대로 반환
      }
      setConnected(true);
      setConnectError('');
    } finally {
      setConnecting(false);
    }
    return await tryOnce();
  }, [session, sessionId]);

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

  // SQL 입력 자동 저장
  useEffect(() => {
    const t = setTimeout(() => {
      try { localStorage.setItem(`sqltool-sql-${sessionId}`, sql); } catch {}
    }, 500);
    return () => clearTimeout(t);
  }, [sql, sessionId]);

  // 연결 수립
  const connect = useCallback(async () => {
    if (!session?.dbms) return;
    setConnecting(true);
    setConnectError('');
    try {
      const jumpOpts = session.jumpTargetHost
        ? { host: session.jumpTargetHost, user: session.jumpTargetUser, port: session.jumpTargetPort, password: session.jumpTargetPassword }
        : undefined;
      const r = await (window as any).api?.feSftpConnect(
        connIdRef.current,
        session.host,
        session.port || 22,
        session.username,
        session.auth,
        jumpOpts,
      );
      if (!r?.success) throw new Error(r?.error || '연결 실패');
      setConnected(true);
    } catch (e: any) {
      setConnectError(String(e?.message || e));
      setConnected(false);
    } finally {
      setConnecting(false);
    }
  }, [session]);

  useEffect(() => {
    if (session && !connected && !connecting) {
      connect();
    }
  }, [session, connected, connecting, connect]);

  // 언마운트 시 연결 종료
  useEffect(() => {
    const cid = connIdRef.current;
    return () => {
      try { (window as any).api?.feSftpDisconnect?.(cid); } catch {}
    };
  }, []);

  const runSql = useCallback(async (sqlText: string, isAuto = false) => {
    if (!session?.dbms || !connected) return;
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

    // 직접 한 번 실행 (페이지네이션 미적용 경로) — 기존 로직 그대로
    const runSingleShot = async (effectiveSql: string, note: string = '') => {
      const cmd = buildIsqlCommand(session.dbms!, effectiveSql);
      const r = await sqlExecWithRetry(cmd, 60000);
      if (runIdRef.current !== myRunId) return; // 더 새로운 runSql 이 시작됨 — 결과 무시
      const ms = Date.now() - t0;
      if (!r?.success) {
        setResultError(r?.error || 'exec 실패');
        setHistory(h => {
          const next = [{ ts: Date.now(), sql: sqlText, rows: 0, ms, error: r?.error || 'exec 실패' }, ...h];
          saveHistory(sessionId, next); return next;
        });
        return;
      }
      const stdout: string = r.stdout || '';
      const stderr: string = r.stderr || '';
      const errMatch = stdout.match(/\[(ERR-[A-Z0-9]+|ERR \d+)[^\]]*\][^\n]*/i) || stdout.match(/^\s*ERROR.*$/im);
      const parsed = parseIsqlOutput(stdout);
      if (errMatch && parsed.rows.length === 0) {
        setResultError(errMatch[0] + (stderr ? `\n${stderr}` : ''));
        setResult({ columns: [], rows: [], affectedText: stdout.trim().split('\n').slice(-5).join('\n'), raw: stdout });
      } else {
        setResult({ ...parsed, affectedText: [note, parsed.affectedText].filter(Boolean).join('\n') });
      }
      if (!isAuto) {
        setHistory(h => {
          const next = [{ ts: Date.now(), sql: sqlText, rows: parsed.rows.length, ms, error: errMatch ? errMatch[0] : undefined }, ...h];
          saveHistory(sessionId, next); return next;
        });
      }
    };

    try {
      // 페이지네이션 대상 아닌 SQL (DDL/DML/이미 LIMIT 있음/집계) — 한 번에 실행
      if (!isPaginableSelect(sqlText)) {
        await runSingleShot(sqlText);
        return;
      }
      // 1) COUNT 먼저 — 전체 행 수 파악. 큰 테이블에선 COUNT 자체가 느릴 수 있어 진행 표시.
      setResult({ columns: [], rows: [], affectedText: '📊 전체 행 수 확인 중...', raw: '' });
      console.log('[SqlTool] COUNT 시작:', wrapForCount(sqlText));
      const countCmd = buildIsqlCommand(session.dbms!, wrapForCount(sqlText));
      const cr = await sqlExecWithRetry(countCmd, 60000);
      console.log('[SqlTool] COUNT 응답:', { success: cr?.success, stdoutBytes: cr?.stdout?.length || 0, stdoutHead: (cr?.stdout || '').slice(0, 300), error: cr?.error });
      if (runIdRef.current !== myRunId) return;
      if (!cr?.success) {
        console.warn('[SqlTool] COUNT failed, falling back to LIMIT 2000:', cr?.error);
        // 원본 그대로 실행하면 IPC 가 거대 payload 로 락 — LIMIT 으로 안전 cap
        await runSingleShot(wrapWithLimit(sqlText, 0, SINGLE_SHOT_THRESHOLD), `⚠ COUNT 단계 실패 (${cr?.error || '?'}) — 안전상 ${SINGLE_SHOT_THRESHOLD}행 까지만 표시`);
        return;
      }
      const countStdout = cr.stdout || '';
      if (/\[(ERR-[A-Z0-9]+|ERR \d+)/i.test(countStdout)) {
        // COUNT wrap 자체가 syntax 에러일 수도 — 원본 LIMIT 으로 안전 실행
        await runSingleShot(wrapWithLimit(sqlText, 0, SINGLE_SHOT_THRESHOLD), `⚠ COUNT wrap 실패 — 안전상 ${SINGLE_SHOT_THRESHOLD}행 까지만 표시`);
        return;
      }
      const countParsed = parseIsqlOutput(countStdout);
      const totalStr = (countParsed.rows[0]?.[0] || '0').replace(/[^\d-]/g, '');
      const total = parseInt(totalStr, 10) || 0;

      if (total === 0) {
        setResult({ columns: [], rows: [], affectedText: '0 rows', raw: '' });
        setHistory(h => {
          const next = [{ ts: Date.now(), sql: sqlText, rows: 0, ms: Date.now() - t0, error: undefined }, ...h];
          saveHistory(sessionId, next); return next;
        });
        return;
      }

      // 2) 임계치 이하 — 한 번에 가져오기 (round-trip 절약)
      if (total <= SINGLE_SHOT_THRESHOLD) {
        await runSingleShot(sqlText, `총 ${total}행`);
        return;
      }

      // 3) 큰 결과 — 페이지 단위로 점진 로딩. 그리드 layout 락 방지로 MAX_DISPLAY_ROWS 에서 중단.
      let allRows: string[][] = [];
      let columns: string[] = [];
      let cappedAt = -1;
      const MAX_PAGES = Math.ceil(MAX_DISPLAY_ROWS / PAGE_SIZE) + 1; // 어떤 경우에도 이 이상 페이지는 받지 않음 (무한 루프 방어)
      let pageCount = 0;
      console.log('[SqlTool] 페이지네이션 시작:', { total, PAGE_SIZE, MAX_PAGES });
      for (let off = 0; off < total; off += PAGE_SIZE) {
        if (++pageCount > MAX_PAGES) { cappedAt = allRows.length; break; }
        if (runIdRef.current !== myRunId) return; // 취소됨
        console.log(`[SqlTool] 페이지 ${pageCount} 시작 (offset=${off})`);
        const pageCmd = buildIsqlCommand(session.dbms!, wrapWithLimit(sqlText, off, PAGE_SIZE));
        const pr = await sqlExecWithRetry(pageCmd, 60000);
        console.log(`[SqlTool] 페이지 ${pageCount} 응답:`, { success: pr?.success, stdoutBytes: pr?.stdout?.length || 0, error: pr?.error });
        if (runIdRef.current !== myRunId) return;
        if (!pr?.success) {
          setResultError(`페이지 (offset=${off}) 로드 실패: ${pr?.error || '?'}\n이미 받은 ${allRows.length}행은 표시됩니다.`);
          break;
        }
        const ps = pr.stdout || '';
        const pErrMatch = ps.match(/\[(ERR-[A-Z0-9]+|ERR \d+)[^\]]*\][^\n]*/i);
        if (pErrMatch && off === 0) {
          // 첫 페이지부터 에러 — 그대로 원본 실행으로 fallback
          await runSingleShot(sqlText);
          return;
        }
        const parsed = parseIsqlOutput(ps);
        if (columns.length === 0) columns = parsed.columns;
        allRows = allRows.concat(parsed.rows);
        // 점진 표시. setResult 가 자주 일어나면 layout 부담 — 매 페이지 그대로 두되 cap 도달 시 중단.
        setResult({
          columns,
          rows: allRows,
          affectedText: `📥 ${allRows.length.toLocaleString()} / ${total.toLocaleString()} 행 로딩 중...`,
          raw: '',
        });
        // 그리드 보호: MAX_DISPLAY_ROWS 도달 시 중단 (인풋 element 가 너무 많아지면 layout 락)
        if (allRows.length >= MAX_DISPLAY_ROWS) {
          cappedAt = allRows.length;
          allRows = allRows.slice(0, MAX_DISPLAY_ROWS);
          break;
        }
        // 한 페이지가 PAGE_SIZE 보다 작게 왔으면 더 받을 게 없음
        if (parsed.rows.length < PAGE_SIZE) break;
        // 이벤트 루프에 양보 — 취소 버튼 등 UI 이벤트 처리 시간 확보
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      if (runIdRef.current !== myRunId) return;
      const ms = Date.now() - t0;
      const cappedNote = cappedAt > 0
        ? ` ⚠ 그리드 보호로 ${MAX_DISPLAY_ROWS.toLocaleString()}행 까지만 표시. 더 보려면 WHERE/ORDER BY+LIMIT 직접 지정.`
        : '';
      setResult({
        columns,
        rows: allRows,
        affectedText: `✓ 총 ${allRows.length.toLocaleString()}${total !== allRows.length ? ` / ${total.toLocaleString()}` : ''} 행 (${ms}ms)${cappedNote}`,
        raw: '',
      });
      if (!isAuto) {
        setHistory(h => {
          const next = [{ ts: Date.now(), sql: sqlText, rows: allRows.length, ms, error: undefined }, ...h];
          saveHistory(sessionId, next); return next;
        });
      }
    } catch (e: any) {
      console.error('[SqlTool] runSql 예외:', e);
      if (runIdRef.current === myRunId) setResultError(String(e?.message || e));
    } finally {
      completed = true;
      clearTimeout(absTimer);
      // 새 runSql 이 시작됐다면 그쪽의 running 상태를 보존
      if (runIdRef.current === myRunId) setRunning(false);
    }
  }, [session, connected, sessionId, sqlExecWithRetry]);

  // 테이블 목록 로드 — Altibase SYSTEM_.SYS_TABLES_
  const loadTables = useCallback(async () => {
    if (!session?.dbms || !connected) return;
    setTablesLoading(true);
    try {
      const cmd = buildIsqlCommand(session.dbms!, "SELECT TABLE_NAME FROM SYSTEM_.SYS_TABLES_ WHERE TABLE_TYPE = 'T' ORDER BY TABLE_NAME");
      const r = await sqlExecWithRetry(cmd, 30000);
      if (r?.success && r.stdout) {
        const parsed = parseIsqlOutput(r.stdout);
        setTables(parsed.rows.map(row => (row[0] || '').trim()).filter(Boolean));
      }
    } catch {}
    setTablesLoading(false);
  }, [session, connected]);

  useEffect(() => {
    if (connected) loadTables();
  }, [connected, loadTables]);

  // 단축키
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      runCurrent();
    } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'Enter') {
      e.preventDefault();
      runSql(sql);
    }
  };

  // 현재 커서 위치의 statement(세미콜론 구분) 실행
  const runCurrent = () => {
    const ta = editorRef.current;
    if (!ta) { runSql(sql); return; }
    const pos = ta.selectionStart;
    const text = sql;
    // 세미콜론 기준 분할
    const stmts: { start: number; end: number; text: string }[] = [];
    let cursor = 0;
    text.split(';').forEach((part) => {
      const start = cursor;
      const end = cursor + part.length;
      cursor = end + 1;
      if (part.trim()) stmts.push({ start, end, text: part.trim() });
    });
    const cur = stmts.find(s => pos >= s.start && pos <= s.end + 1) || stmts[0];
    if (cur) runSql(cur.text);
  };

  // ── 결과 export 헬퍼 ──
  const escCsv = (v: string) => /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  const buildCsv = () => {
    if (!result || result.columns.length === 0) return '';
    const head = result.columns.map(escCsv).join(',');
    const body = result.rows.map((row, i) =>
      row.map((c, j) => escCsv(edits.get(`${i},${j}`) ?? c)).join(',')
    ).join('\n');
    return head + '\n' + body;
  };
  const buildTsv = () => {
    if (!result || result.columns.length === 0) return '';
    const head = result.columns.join('\t');
    const body = result.rows.map((row, i) =>
      row.map((c, j) => (edits.get(`${i},${j}`) ?? c).replace(/\t/g, ' ').replace(/\n/g, ' ')).join('\t')
    ).join('\n');
    return head + '\n' + body;
  };

  const flashHint = (msg: string) => { setCopyHint(msg); setTimeout(() => setCopyHint(''), 1800); };

  const onSaveCsv = async () => {
    if (!result || result.columns.length === 0) return;
    const name = (lastTable || 'query-result') + '-' + new Date().toISOString().slice(0,19).replace(/[:T]/g,'-') + '.csv';
    try {
      const r = await (window as any).api?.sqlSaveCsv(name, buildCsv());
      if (r?.success) flashHint(`저장됨: ${r.path}`);
      else if (!r?.canceled) flashHint(`저장 실패: ${r?.error || '?'}`);
    } catch (e: any) { flashHint(`저장 예외: ${e?.message || e}`); }
  };

  const onCopyClipboard = async () => {
    if (!result || result.columns.length === 0) return;
    try {
      await navigator.clipboard.writeText(buildTsv());
      flashHint('클립보드에 복사됨');
    } catch (e: any) { flashHint(`복사 실패: ${e?.message || e}`); }
  };

  // 테이블을 canvas 로 렌더해서 PNG 클립보드 복사
  const onCopyImage = async () => {
    if (!result || result.columns.length === 0) return;
    try {
      const cols = result.columns;
      const rows = result.rows.map((row, i) =>
        row.map((c, j) => edits.get(`${i},${j}`) ?? c)
      );
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

  // 변경된 셀 → UPDATE 쿼리 생성 후 commit
  const onApplyChanges = async () => {
    if (!result || edits.size === 0 || !lastTable) return;
    if (!session?.dbms || !connected) return;
    // row 단위로 묶기
    const byRow = new Map<number, Map<number, string>>();
    edits.forEach((v, k) => {
      const [rs, cs] = k.split(',').map(Number);
      if (!byRow.has(rs)) byRow.set(rs, new Map());
      byRow.get(rs)!.set(cs, v);
    });
    // 빈 문자열/NULL 표기 처리. isql 은 NULL 을 빈칸으로 출력하므로 빈 셀은 IS NULL 매칭.
    const sqlVal = (v: string) => v === '' ? 'NULL' : `'${v.replace(/'/g, `''`)}'`;
    const wherePart = (col: string, v: string) => v === '' ? `${col} IS NULL` : `${col} = '${v.replace(/'/g, `''`)}'`;
    const updates: string[] = [];
    byRow.forEach((cellMap, rowIdx) => {
      const origRow = result.rows[rowIdx];
      const setParts: string[] = [];
      cellMap.forEach((newV, colIdx) => {
        setParts.push(`${result.columns[colIdx]} = ${sqlVal(newV)}`);
      });
      // WHERE: 모든 원본 컬럼 매칭 (PK 정보 없음 → 보수적)
      const whereParts = result.columns.map((col, j) => wherePart(col, origRow[j]));
      updates.push(`UPDATE ${lastTable} SET ${setParts.join(', ')} WHERE ${whereParts.join(' AND ')};`);
    });
    const preview = updates.join('\n');
    const refocus = () => { try { (window as any).api?.refocusWindow?.(); } catch {} };
    const ok = confirm(`${updates.length}개 행을 UPDATE 합니다.\n\n${preview.slice(0, 500)}${preview.length > 500 ? '\n...' : ''}\n\n진행?`);
    refocus();
    if (!ok) return;
    setApplying(true);
    const t0 = Date.now();
    try {
      const fullSql = updates.join('\n') + '\nCOMMIT;';
      const cmd = buildIsqlCommand(session.dbms!, fullSql);
      const r = await sqlExecWithRetry(cmd, 60000);
      const ms = Date.now() - t0;
      if (r?.success) {
        const stdout: string = r.stdout || '';
        const errMatch = stdout.match(/\[(ERR-[A-Z0-9]+)[^\]]*\][^\n]*/i);
        // 히스토리에 적용한 UPDATE 기록 — 성공/에러 모두
        setHistory(h => {
          const next = [
            { ts: Date.now(), sql: fullSql, rows: updates.length, ms, error: errMatch ? errMatch[0] : undefined },
            ...h,
          ];
          saveHistory(sessionId, next);
          return next;
        });
        if (errMatch) {
          // 에러 시 생성된 SQL 도 같이 보여줘서 디버깅 쉽게
          console.error('[SQL apply error]', { error: errMatch[0], stdout, generatedSql: fullSql });
          alert(`UPDATE 중 에러:\n${errMatch[0]}\n\n생성된 SQL (앞 500자):\n${fullSql.slice(0, 500)}\n\nisql 출력 (마지막 500자):\n${stdout.slice(-500)}`);
          refocus();
        } else {
          alert(`적용 완료. ${updates.length}개 UPDATE + COMMIT.\n\n${stdout.slice(-300)}`);
          refocus();
          setEdits(new Map());
          // 동일 SELECT 재실행해서 결과 갱신
          if (lastTable) runSql(`SELECT * FROM ${lastTable}`);
        }
      } else {
        setHistory(h => {
          const next = [
            { ts: Date.now(), sql: fullSql, rows: 0, ms, error: r?.error || 'exec 실패' },
            ...h,
          ];
          saveHistory(sessionId, next);
          return next;
        });
        alert(`적용 실패: ${r?.error || '?'}`);
        refocus();
      }
    } finally { setApplying(false); }
  };

  const filteredTables = useMemo(() =>
    tables.filter(t => !tableFilter || t.toLowerCase().includes(tableFilter.toLowerCase())),
    [tables, tableFilter]);

  const filteredHistory = useMemo(() =>
    history.filter(h => !historyFilter || h.sql.toLowerCase().includes(historyFilter.toLowerCase())),
    [history, historyFilter]);

  const insertAtCursor = (text: string) => {
    const ta = editorRef.current;
    if (!ta) { setSql(s => s + text); return; }
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    setSql(s => s.substring(0, start) + text + s.substring(end));
    setTimeout(() => { ta.focus(); ta.selectionStart = ta.selectionEnd = start + text.length; }, 0);
  };

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0, background: '#1e1e1e', color: '#d4d4d4', fontFamily: 'system-ui, sans-serif', fontSize: 13 }}>
      {/* 좌측: 테이블 목록 */}
      <div style={{ width: 240, display: 'flex', flexDirection: 'column', borderRight: '1px solid #333', minHeight: 0 }}>
        <div style={{ padding: 8, borderBottom: '1px solid #333', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontWeight: 600 }}>📋 테이블</span>
          <button onClick={loadTables} disabled={!connected || tablesLoading} title="새로고침" style={{ marginLeft: 'auto', background: 'transparent', color: '#aaa', border: '1px solid #444', cursor: 'pointer', padding: '2px 6px', borderRadius: 3 }}>↻</button>
        </div>
        <input value={tableFilter} onChange={e => setTableFilter(e.target.value)} placeholder="검색..." style={{ margin: 6, padding: 4, background: '#2a2a2a', color: '#ddd', border: '1px solid #444', borderRadius: 3 }} />
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 4px 4px' }}>
          {tablesLoading && <div style={{ color: '#888', padding: 4 }}>로딩...</div>}
          {!tablesLoading && filteredTables.length === 0 && <div style={{ color: '#666', padding: 4 }}>테이블 없음</div>}
          {filteredTables.map(t => (
            <div key={t}
              title="더블클릭: SELECT * FROM 삽입 / 드래그: 에디터 원하는 위치에 테이블명 삽입"
              draggable
              onDragStart={e => {
                e.dataTransfer.setData('text/plain', t);
                e.dataTransfer.setData('application/x-pepe-sql-table', t);
                e.dataTransfer.effectAllowed = 'copy';
                // 반투명 커스텀 드래그 고스트 — 커서가 잘 보이도록
                const ghost = document.createElement('div');
                ghost.textContent = t;
                ghost.style.cssText = 'position:absolute;top:-1000px;left:-1000px;padding:2px 6px;background:rgba(80,140,200,0.45);color:rgba(255,255,255,0.85);font-family:monospace;font-size:12px;border-radius:3px;pointer-events:none;';
                document.body.appendChild(ghost);
                e.dataTransfer.setDragImage(ghost, 8, 8);
                setTimeout(() => { try { document.body.removeChild(ghost); } catch {} }, 0);
              }}
              onDoubleClick={() => insertAtCursor(`SELECT * FROM ${t};`)}
              style={{ padding: '3px 6px', cursor: 'grab', borderRadius: 3, fontFamily: 'monospace', fontSize: 12 }}
              onMouseEnter={e => (e.currentTarget.style.background = '#2d2d2d')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >{t}</div>
          ))}
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
          </span>
        </div>
        {connectError && <div style={{ background: '#5a1d1d', color: '#fcc', padding: 6, fontSize: 12 }}>{connectError}</div>}
        <div style={{ padding: 6, borderBottom: '1px solid #333', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={runCurrent} disabled={!connected || running} style={{ background: running ? '#555' : '#0e639c', color: '#fff', border: 0, padding: '4px 12px', borderRadius: 3, cursor: running ? 'wait' : 'pointer' }} title="Ctrl+Enter — 커서 위치 SQL 실행">
            {running ? '실행 중...' : '▶ 현재 문장 실행 (Ctrl+Enter)'}
          </button>
          <button onClick={() => runSql(sql)} disabled={!connected || running} style={{ background: '#3a7d3a', color: '#fff', border: 0, padding: '4px 12px', borderRadius: 3, cursor: running ? 'wait' : 'pointer' }} title="Ctrl+Shift+Enter — 전체 실행">
            전체 실행
          </button>
          {running && (
            <button
              onClick={() => { runIdRef.current++; setRunning(false); setResult(prev => prev ? { ...prev, affectedText: '✕ 사용자 취소' } : null); }}
              style={{ background: '#a33', color: '#fff', border: 0, padding: '4px 10px', borderRadius: 3, cursor: 'pointer' }}
              title="실행 중인 쿼리 결과 무시 — 서버에서는 계속 돌지만 UI 는 즉시 반환"
            >
              ⏹ 취소
            </button>
          )}
          <button onClick={onSaveCsv} disabled={!result || result.columns.length === 0} style={{ background: '#444', color: '#fff', border: 0, padding: '4px 10px', borderRadius: 3, cursor: 'pointer' }} title="결과를 CSV 파일로 저장">
            💾 CSV로 저장
          </button>
          <button onClick={onCopyClipboard} disabled={!result || result.columns.length === 0} style={{ background: '#444', color: '#fff', border: 0, padding: '4px 10px', borderRadius: 3, cursor: 'pointer' }} title="결과를 TSV 로 클립보드 복사 (Excel 붙여넣기 호환)">
            📋 클립보드로 복사
          </button>
          <button onClick={onCopyImage} disabled={!result || result.columns.length === 0} style={{ background: '#444', color: '#fff', border: 0, padding: '4px 10px', borderRadius: 3, cursor: 'pointer' }} title="결과를 PNG 이미지로 클립보드 복사">
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
        <textarea
          ref={editorRef}
          value={sql}
          onChange={e => setSql(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          onDragOver={e => {
            if (!(e.dataTransfer.types.includes('application/x-pepe-sql-table') || e.dataTransfer.types.includes('text/plain'))) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            const ta = editorRef.current;
            if (!ta) return;
            if (document.activeElement !== ta) ta.focus();
            const pos = getTextareaCaretFromPoint(ta, e.clientX, e.clientY);
            if (ta.selectionStart !== pos || ta.selectionEnd !== pos) {
              ta.setSelectionRange(pos, pos);
            }
          }}
          onDrop={e => {
            const text = e.dataTransfer.getData('application/x-pepe-sql-table') || e.dataTransfer.getData('text/plain');
            if (!text) return;
            e.preventDefault();
            const ta = editorRef.current;
            if (!ta) { setSql(s => s + text); return; }
            const pos = getTextareaCaretFromPoint(ta, e.clientX, e.clientY);
            setSql(s => s.substring(0, pos) + text + s.substring(pos));
            setTimeout(() => { ta.focus(); ta.setSelectionRange(pos + text.length, pos + text.length); }, 0);
          }}
          style={{ flex: '0 0 35%', minHeight: 80, background: '#1e1e1e', color: '#d4d4d4', border: 0, borderBottom: '1px solid #333', padding: 8, fontFamily: 'monospace', fontSize: 13, resize: 'none', outline: 'none' }}
        />
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0, minWidth: 0, position: 'relative' }}>
          {resultError && (
            <div style={{ background: '#5a1d1d', color: '#fcc', padding: 8, fontSize: 12, fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>{resultError}</div>
          )}
          {result && result.columns.length > 0 && (
            <>
              {/* 헤더 우상단 floating 적용하기 버튼 */}
              <button
                onClick={onApplyChanges}
                disabled={edits.size === 0 || applying || !lastTable}
                title={!lastTable ? '단일 테이블 SELECT 결과에서만 사용 가능' : edits.size === 0 ? '변경된 셀 없음' : `${edits.size}개 셀 → UPDATE + COMMIT`}
                style={{ position: 'sticky', top: 6, float: 'right', marginRight: 8, marginTop: 6, zIndex: 5, background: edits.size > 0 && lastTable ? '#c97a2a' : '#888', color: '#fff', border: 0, padding: '4px 12px', borderRadius: 3, cursor: edits.size > 0 && lastTable ? 'pointer' : 'not-allowed', fontSize: 11, fontWeight: 600, boxShadow: '0 2px 6px rgba(0,0,0,0.25)' }}
              >
                {applying ? '적용 중...' : `✔ 적용하기${edits.size > 0 ? ` (${edits.size})` : ''}`}
              </button>
              <table style={{ borderCollapse: 'separate', borderSpacing: 0, width: 'max-content', minWidth: '100%', fontFamily: 'monospace', fontSize: 12, color: '#d4d4d4' }}>
                <thead>
                  <tr>
                    <th style={{ position: 'sticky', top: 0, background: '#2d2d2d', color: '#9cdcfe', padding: '5px 10px', textAlign: 'center', border: '1px solid #3f3f46', fontWeight: 600, zIndex: 2, minWidth: 36 }}>#</th>
                    {result.columns.map((c, i) => (
                      <th key={i} style={{ position: 'sticky', top: 0, background: '#2d2d2d', color: '#9cdcfe', padding: '5px 12px', textAlign: 'left', border: '1px solid #3f3f46', borderLeft: 0, fontWeight: 600, zIndex: 2, whiteSpace: 'nowrap' }}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, i) => (
                    <tr key={i}>
                      <td style={{ padding: '4px 8px', color: '#888', background: '#252525', border: '1px solid #3f3f46', borderTop: 0, textAlign: 'center', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{i + 1}</td>
                      {row.map((c, j) => {
                        const key = `${i},${j}`;
                        const edited = edits.has(key);
                        const value = edited ? edits.get(key)! : c;
                        const isEditing = editingCell === key;
                        return (
                          <td key={j} style={{ padding: 0, border: '1px solid #3f3f46', borderTop: 0, borderLeft: 0, background: edited ? '#3d2a14' : (i % 2 ? '#222' : '#1e1e1e'), maxWidth: isEditing ? 'none' : 360, position: 'relative' }}>
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
                                onClick={() => setEditingCell(key)}
                                title={value.length > 40 ? value : undefined}
                                style={{ padding: '4px 12px', color: edited ? '#ffd680' : '#d4d4d4', fontFamily: 'monospace', fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', cursor: 'text' }}
                              >{value || ' '}</div>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {result && result.affectedText && (
            <div style={{ padding: 6, color: '#888', fontSize: 11, fontFamily: 'monospace', borderTop: '1px solid #333' }}>{result.affectedText}</div>
          )}
          {result && result.columns.length === 0 && !resultError && (
            <pre style={{ padding: 8, fontSize: 12, color: '#aaa', whiteSpace: 'pre-wrap' }}>{result.raw}</pre>
          )}
        </div>
      </div>

      {/* 우측: 히스토리 */}
      <div style={{ width: 280, display: 'flex', flexDirection: 'column', borderLeft: '1px solid #333', minHeight: 0 }}>
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
    </div>
  );
};
