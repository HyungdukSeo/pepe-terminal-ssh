// src/components/jdbcBackend.ts
//
// JDBC-backed data layer for SqlToolWorkspace. Wraps the Electron preload
// `jdbc*` APIs (which route to the Java sidecar) behind a per-session object.
//
// Replaces the previous SSH+isql `DbmsDriver` pattern. Schema metadata uses
// the JDBC standard `DatabaseMetaData` (exposed by the sidecar's `meta.*`
// methods), so most things work uniformly across DBMSes. Dialect-specific
// touches (pagination clause, view DDL query, identifier quoting) are still
// switched on `type`.

export type Dialect = 'altibase' | 'mysql' | 'postgres' | 'oracle' | 'mssql' | 'sqlite' | 'generic';

export type ColumnInfo = { name: string; typeText: string; nullable: boolean };
export type ParsedResult = { columns: string[]; rows: string[][]; affectedText?: string; raw?: string };

export interface ExecResult {
  columns: string[];
  rows: string[][];
  types: string[];
  rowsAffected: number;
  truncated: boolean;
}

export interface DbmsCfgLike {
  type: Dialect;
  driverId?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  urlOverride?: string;
  props?: Record<string, string>;
}

export interface ConnectInfo {
  productName?: string;
  productVersion?: string;
  driverName?: string;
  driverVersion?: string;
  url?: string;
  catalog?: string;
  schema?: string;
}

function escapeStr(s: string): string { return s.replace(/'/g, "''"); }

function quoteIdent(dialect: Dialect, name: string): string {
  if (dialect === 'mysql') return '`' + name.replace(/`/g, '``') + '`';
  if (dialect === 'mssql') return '[' + name.replace(/]/g, ']]') + ']';
  if (dialect === 'postgres' || dialect === 'oracle' || dialect === 'sqlite') {
    return '"' + name.replace(/"/g, '""') + '"';
  }
  // altibase + generic — bare name (case-folded by server)
  return name;
}

function formatType(typeName: string | null | undefined, size: number, digits: number): string {
  if (!typeName) return '';
  const t = typeName;
  if (/CHAR|VARCHAR|BINARY|VARBIT/i.test(t) && size > 0) return `${t}(${size})`;
  if (/NUMERIC|DECIMAL|NUMBER/i.test(t) && size > 0) return digits > 0 ? `${t}(${size},${digits})` : `${t}(${size})`;
  return t;
}

export class JdbcBackend {
  readonly type: Dialect;
  readonly connectionId: string;
  private _connected = false;
  private _info: ConnectInfo = {};

  constructor(
    public readonly sessionId: string,
    public readonly dbms: DbmsCfgLike,
    public readonly driverDef: any,
  ) {
    this.type = ((driverDef?.dialect || dbms?.type || 'altibase') as Dialect);
    this.connectionId = `sql-${sessionId}-${Date.now().toString(36)}`;
  }

  get connected(): boolean { return this._connected; }
  get info(): ConnectInfo { return this._info; }

  buildUrl(): string {
    if (this.dbms?.urlOverride) return this.dbms.urlOverride;
    const tpl: string = this.driverDef?.urlTemplate || '';
    return tpl
      .replace('{host}', this.dbms?.host || '127.0.0.1')
      .replace('{port}', String(this.dbms?.port || this.driverDef?.defaultPort || 0))
      .replace('{database}', this.dbms?.database || '');
  }

  async ensureConnected(): Promise<{ ok: boolean; error?: string }> {
    if (this._connected) return { ok: true };
    const api: any = (window as any).api || {};
    const r = await api.jdbcConnect?.({
      connectionId: this.connectionId,
      driver: this.driverDef,
      url: this.buildUrl(),
      user: this.dbms?.user || '',
      password: this.dbms?.password || '',
      props: this.dbms?.props,
    });
    if (!r?.success) return { ok: false, error: r?.error || 'connect failed' };
    this._connected = true;
    this._info = r.result || {};
    return { ok: true };
  }

  async disconnect(): Promise<void> {
    if (!this._connected) return;
    try { await (window as any).api?.jdbcDisconnect?.(this.connectionId); } catch {}
    this._connected = false;
  }

  async exec(sql: string, maxRows = 2000): Promise<ExecResult> {
    const api: any = (window as any).api || {};
    const r = await api.jdbcExec?.({ connectionId: this.connectionId, sql, maxRows });
    if (!r?.success) throw new Error(r?.error || 'exec failed');
    const res = r.result || {};
    return {
      columns: res.columns || [],
      rows: res.rows || [],
      types: res.types || [],
      rowsAffected: Math.max(0, res.rowsAffected || 0),
      truncated: !!res.truncated,
    };
  }

  // ── Schema metadata via DatabaseMetaData ───────────────────────────────────

  async listTables(): Promise<string[]> {
    const api: any = (window as any).api || {};
    const r = await api.jdbcMetaTables?.({ connectionId: this.connectionId, types: ['TABLE'] });
    if (!r?.success) return [];
    return ((r.result?.rows as any[]) || []).map(row => row.name).filter(Boolean);
  }
  async listViews(): Promise<string[]> {
    const api: any = (window as any).api || {};
    const r = await api.jdbcMetaTables?.({ connectionId: this.connectionId, types: ['VIEW'] });
    if (!r?.success) return [];
    return ((r.result?.rows as any[]) || []).map(row => row.name).filter(Boolean);
  }
  async listSequences(): Promise<string[]> {
    const api: any = (window as any).api || {};
    const r = await api.jdbcMetaTables?.({ connectionId: this.connectionId, types: ['SEQUENCE'] });
    if (!r?.success) return [];
    return ((r.result?.rows as any[]) || []).map(row => row.name).filter(Boolean);
  }
  async listProcedures(): Promise<string[]> {
    // Sidecar 의 meta.procedures 추가는 후속. 우선 빈 배열.
    return [];
  }

  async columns(table: string): Promise<ColumnInfo[]> {
    const api: any = (window as any).api || {};
    const r = await api.jdbcMetaColumns?.({ connectionId: this.connectionId, table });
    if (!r?.success) return [];
    return ((r.result?.rows as any[]) || []).map((row: any) => ({
      name: row.name,
      typeText: formatType(row.typeName, row.size || 0, row.digits || 0),
      nullable: !!row.nullable,
    }));
  }

  async primaryKey(table: string): Promise<string[]> {
    const api: any = (window as any).api || {};
    const r = await api.jdbcMetaPrimaryKeys?.({ connectionId: this.connectionId, table });
    if (!r?.success) return [];
    return (r.result?.cols as string[]) || [];
  }

  // ── Dialect-specific bits ──────────────────────────────────────────────────

  isPaginableSelect(sql: string): boolean {
    const t = sql.trim().replace(/;+\s*$/, '');
    if (!/^\s*select\b/i.test(t)) return false;
    if (/\blimit\s+\d|\boffset\s+\d|\bfetch\s+first/i.test(t)) return false;
    if (/^\s*select\s+(count|sum|avg|min|max)\s*\(/i.test(t)
        && !/,/.test((t.split(/\bfrom\b/i)[0] || ''))) return false;
    return true;
  }

  wrapForCount(sql: string): string {
    const t = sql.trim().replace(/;+\s*$/, '');
    return `SELECT COUNT(*) FROM (${t}) _pepe_cnt`;
  }

  wrapWithLimit(sql: string, offset: number, count: number): string {
    const t = sql.trim().replace(/;+\s*$/, '');
    switch (this.type) {
      case 'mssql':
        // MSSQL needs ORDER BY for OFFSET/FETCH; if absent, the best-effort
        // fallback is to return the original (sidecar's maxRows still caps).
        if (/\border\s+by\b/i.test(t)) {
          return `${t} OFFSET ${offset} ROWS FETCH NEXT ${count} ROWS ONLY`;
        }
        return t;
      case 'oracle':
        return `SELECT * FROM (SELECT _p.*, ROWNUM rnum FROM (${t}) _p WHERE ROWNUM <= ${offset + count}) WHERE rnum > ${offset}`;
      default:
        // postgres / mysql / sqlite / altibase / generic
        return `${t} LIMIT ${count} OFFSET ${offset}`;
    }
  }

  selectAllForTable(table: string): string {
    return `SELECT * FROM ${quoteIdent(this.type, table)}`;
  }

  async viewDefinition(name: string): Promise<string | null> {
    let sql: string;
    const upper = escapeStr(name).toUpperCase();
    const esc = escapeStr(name);
    switch (this.type) {
      case 'postgres':
        sql = `SELECT pg_get_viewdef('${esc}', true)`;
        break;
      case 'mysql':
        sql = 'SHOW CREATE VIEW ' + quoteIdent(this.type, name);
        break;
      case 'mssql':
        sql = `SELECT OBJECT_DEFINITION(OBJECT_ID('${esc}'))`;
        break;
      case 'altibase':
        sql = `SELECT PARSE FROM SYSTEM_.SYS_VIEW_PARSE_ WHERE VIEW_ID = (SELECT TABLE_ID FROM SYSTEM_.SYS_TABLES_ WHERE TABLE_NAME = '${upper}') ORDER BY SEQ_NO`;
        break;
      case 'sqlite':
        sql = `SELECT sql FROM sqlite_master WHERE type='view' AND name='${esc}'`;
        break;
      case 'oracle':
        sql = `SELECT TEXT FROM USER_VIEWS WHERE VIEW_NAME = '${upper}'`;
        break;
      default:
        return null;
    }
    try {
      const res = await this.exec(sql, 200);
      if (res.rows.length === 0) return '-- (본문 없음)';
      const body = res.rows.map(row => row[row.length - 1] || '').join('').trim();
      if (!body) return '-- (본문 없음)';
      return body;
    } catch (e: any) {
      return `-- DDL 조회 실패: ${e?.message || e}`;
    }
  }

  // ── Transactions ───────────────────────────────────────────────────────────

  async beginTx(): Promise<void> {
    // setAutoCommit(false) via SQL — different syntax per DBMS.
    let sql: string;
    switch (this.type) {
      case 'altibase': sql = 'AUTOCOMMIT OFF'; break;
      case 'mssql':    sql = 'BEGIN TRANSACTION'; break;
      case 'oracle':   sql = 'SET TRANSACTION READ WRITE'; break;
      default:         sql = 'START TRANSACTION';
    }
    try { await this.exec(sql, 1); } catch { /* not all drivers like explicit BEGIN — ignore */ }
  }

  async commit(): Promise<void> {
    try { await this.exec('COMMIT', 1); } catch {}
    if (this.type === 'altibase') { try { await this.exec('AUTOCOMMIT ON', 1); } catch {} }
  }

  /**
   * Dialect-aware EXPLAIN — returns the plan as a regular ExecResult so the UI
   * can render it in a result tab. Multi-statement cases (Oracle, Altibase)
   * issue two sidecar `exec` calls and only the second result is returned.
   */
  async explain(sql: string): Promise<ExecResult> {
    const t = sql.trim().replace(/;+\s*$/, '');
    switch (this.type) {
      case 'postgres':
        return this.exec(`EXPLAIN ANALYZE ${t}`, 5000);
      case 'mysql':
        try { return await this.exec(`EXPLAIN FORMAT=TREE ${t}`, 5000); }
        catch { return this.exec(`EXPLAIN ${t}`, 5000); }
      case 'sqlite':
        return this.exec(`EXPLAIN QUERY PLAN ${t}`, 5000);
      case 'oracle':
        await this.exec(`EXPLAIN PLAN FOR ${t}`, 1);
        return this.exec(`SELECT PLAN_TABLE_OUTPUT FROM TABLE(DBMS_XPLAN.DISPLAY())`, 5000);
      case 'altibase':
        // Altibase: EXPLAIN PLAN ON 후 쿼리 실행 시 PLAN 이 stdout 으로 출력되지만
        // JDBC ResultSet 에선 일반 결과만 반환된다. PLAN_TABLE 조회로 대체.
        try { await this.exec(`EXPLAIN PLAN ON`, 1); } catch {}
        try { return await this.exec(`SELECT * FROM SYSTEM_.SYS_PLAN_CACHE_`, 5000); } catch {}
        // 폴백: 그냥 SQL 을 실행하지 않고 가이드 메시지 형태로 빈 결과 반환
        return { columns: ['plan'], rows: [['Altibase: PLAN_CACHE 미지원 버전 — isql 의 EXPLAIN PLAN ON 사용 권장']], types: ['text'], rowsAffected: 0, truncated: false };
      case 'mssql':
        // MSSQL: SET SHOWPLAN_ALL ON 은 다음 BATCH 부터 적용. 사이드카는 단일 statement 만 — 베스트 에포트.
        return this.exec(`SET SHOWPLAN_ALL ON ${t}`, 5000).catch(() => this.exec(t, 5000));
      default:
        return this.exec(`EXPLAIN ${t}`, 5000);
    }
  }

  async rollback(): Promise<void> {
    try { await this.exec('ROLLBACK', 1); } catch {}
    if (this.type === 'altibase') { try { await this.exec('AUTOCOMMIT ON', 1); } catch {} }
  }
}

/** Resolve the driver definition for a session — by driverId, then by dialect, then first usable. */
export function resolveDriverFromList(drivers: any[], cfg: DbmsCfgLike): any | null {
  if (!drivers || drivers.length === 0) return null;
  const byId = cfg.driverId ? drivers.find(d => d.id === cfg.driverId) : null;
  if (byId) return byId;
  const byDialect = drivers.find(d => d.dialect === cfg.type);
  if (byDialect) return byDialect;
  return drivers.find(d => d.diag?.usable) || drivers[0];
}
