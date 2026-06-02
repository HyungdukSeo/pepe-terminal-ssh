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
    let url = tpl
      .replace('{host}', this.dbms?.host || '127.0.0.1')
      .replace('{port}', String(this.dbms?.port || this.driverDef?.defaultPort || 0))
      .replace('{database}', this.dbms?.database || '');
    // database 가 비어있어 끝에 빈 슬래시만 남는 경우(예: jdbc:Altibase://h:p/) 그 슬래시 제거
    url = url.replace(/\/+$/, '');
    return url;
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

  // dialect 별 "전체 user/schema 목록" SQL — getSchemas 가 부실한 드라이버(Altibase 등) 보강용.
  private schemaListSql(): string | null {
    switch (this.type) {
      case 'altibase': return "SELECT USER_NAME FROM SYSTEM_.SYS_USERS_ ORDER BY USER_NAME";
      case 'oracle':   return "SELECT USERNAME FROM ALL_USERS ORDER BY USERNAME";
      case 'postgres': return "SELECT schema_name FROM information_schema.schemata ORDER BY schema_name";
      case 'mysql':    return "SELECT schema_name FROM information_schema.schemata ORDER BY schema_name";
      case 'mssql':    return "SELECT name FROM sys.schemas ORDER BY name";
      default:         return null; // sqlite/generic
    }
  }

  // 스키마(user) 목록 — DBeaver 처럼 모든 user 표시. dialect SQL 우선, 실패 시 DatabaseMetaData.
  async listSchemas(): Promise<string[]> {
    const sql = this.schemaListSql();
    if (sql) {
      try {
        const res = await this.exec(sql, 2000);
        const names = res.rows.map(r => (r[0] || '').trim()).filter(Boolean);
        if (names.length > 0) return names;
      } catch { /* 카탈로그 미지원 — getSchemas 폴백 */ }
    }
    const api: any = (window as any).api || {};
    const r = await api.jdbcMetaSchemas?.({ connectionId: this.connectionId });
    if (!r?.success) return [];
    return ((r.result?.rows as any[]) || []).map(row => row.schema).filter(Boolean);
  }
  async listTableTypes(): Promise<string[]> {
    const api: any = (window as any).api || {};
    const r = await api.jdbcMetaTableTypes?.({ connectionId: this.connectionId });
    if (!r?.success) return [];
    return (r.result?.types as string[]) || [];
  }
  // types/schema 를 지정해 객체명 목록 — 트리의 각 그룹에서 호출.
  async listByType(types: string[], schema?: string): Promise<string[]> {
    const api: any = (window as any).api || {};
    const r = await api.jdbcMetaTables?.({ connectionId: this.connectionId, types, schema });
    if (!r?.success) return [];
    return ((r.result?.rows as any[]) || []).map(row => row.name).filter(Boolean);
  }
  async listTables(schema?: string): Promise<string[]> { return this.listByType(['TABLE'], schema); }
  async listViews(schema?: string): Promise<string[]> { return this.listByType(['VIEW'], schema); }
  async listSystemTables(schema?: string): Promise<string[]> { return this.listByType(['SYSTEM TABLE'], schema); }
  // 시퀀스/시노님은 JDBC getTables 타입 필터가 부실 → dialect SQL 우선.
  private async listViaSqlOrType(sql: string | null, types: string[], schema?: string): Promise<string[]> {
    if (sql) {
      try {
        const res = await this.exec(sql, 5000);
        return res.rows.map(r => (r[0] || '').trim()).filter(Boolean);
      } catch { /* 폴백 */ }
    }
    return this.listByType(types, schema);
  }
  async listSequences(schema?: string): Promise<string[]> {
    const s = escapeStr((schema || '').toUpperCase());
    let sql: string | null = null;
    switch (this.type) {
      case 'altibase': sql = `SELECT T.TABLE_NAME FROM SYSTEM_.SYS_TABLES_ T JOIN SYSTEM_.SYS_USERS_ U ON T.USER_ID = U.USER_ID WHERE U.USER_NAME = '${s}' AND T.TABLE_TYPE = 'S' ORDER BY T.TABLE_NAME`; break;
      case 'oracle':   sql = `SELECT SEQUENCE_NAME FROM ALL_SEQUENCES WHERE SEQUENCE_OWNER = '${s}' ORDER BY SEQUENCE_NAME`; break;
      case 'postgres': sql = `SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = '${escapeStr(schema || '')}' ORDER BY sequence_name`; break;
      case 'mssql':    sql = `SELECT name FROM sys.sequences ORDER BY name`; break;
      default: sql = null;
    }
    return this.listViaSqlOrType(sql, ['SEQUENCE'], schema);
  }
  async listSynonyms(schema?: string): Promise<string[]> {
    const s = escapeStr((schema || '').toUpperCase());
    let sql: string | null = null;
    switch (this.type) {
      case 'altibase': sql = `SELECT S.SYNONYM_NAME FROM SYSTEM_.SYS_SYNONYMS_ S JOIN SYSTEM_.SYS_USERS_ U ON S.SYNONYM_OWNER_ID = U.USER_ID WHERE U.USER_NAME = '${s}' ORDER BY S.SYNONYM_NAME`; break;
      case 'oracle':   sql = `SELECT SYNONYM_NAME FROM ALL_SYNONYMS WHERE OWNER = '${s}' ORDER BY SYNONYM_NAME`; break;
      case 'mssql':    sql = `SELECT name FROM sys.synonyms ORDER BY name`; break;
      default: sql = null; // postgres/mysql 시노님 개념 없음
    }
    return this.listViaSqlOrType(sql, ['SYNONYM', 'ALIAS'], schema);
  }
  // Public(전역) 시노님 — 특정 user 소유가 아닌 공용. DBeaver 의 "Global metadata > Public Synonyms".
  async listPublicSynonyms(): Promise<string[]> {
    let sql: string | null = null;
    switch (this.type) {
      // Altibase Public Synonym = SYNONYM_OWNER_ID IS NULL (DBeaver AltibaseMetaModel 참조).
      case 'altibase':
        sql = `SELECT SYNONYM_NAME FROM SYSTEM_.SYS_SYNONYMS_ WHERE SYNONYM_OWNER_ID IS NULL ORDER BY SYNONYM_NAME`;
        break;
      case 'oracle':
        sql = `SELECT SYNONYM_NAME FROM ALL_SYNONYMS WHERE OWNER = 'PUBLIC' ORDER BY SYNONYM_NAME`;
        break;
      default: return [];
    }
    try {
      const res = await this.exec(sql, 5000);
      return res.rows.map(r => (r[0] || '').trim()).filter(Boolean);
    } catch { return []; }
  }
  // 프로시저/함수 파라미터 — DBeaver 처럼 8 컬럼: 이름/#/유형/IN-OUT/길이/Scale/정밀도/NotNull.
  // 1순위: 표준 JDBC DatabaseMetaData.getProcedureColumns / getFunctionColumns (dialect 무관, 가장 안전).
  // 2순위: dialect 별 카탈로그 SQL 폴백.
  async routineParameters(name: string, kind: 'procedure' | 'function', schema?: string): Promise<{ name: string; order: number; type: string; inOut: string; length?: number; scale?: number; precision?: number; nullable?: boolean }[]> {
    const api: any = (window as any).api || {};
    // Altibase 는 JDBC 표준 getFunctionColumns 가 RETURN_VALUE 행을 제공하지 않으므로
    // SYS_PROCEDURES_ + SYS_PROC_PARAS_ 카탈로그 SQL 직접 사용 (DBeaver 와 동일 패턴).
    // 다른 dialect 는 표준 JDBC 먼저 시도.
    if (this.type !== 'altibase') {
      const tryJdbc = async (s: string | undefined) => {
        const r = kind === 'function'
          ? await api.jdbcMetaFunctionColumns?.({ connectionId: this.connectionId, schema: s, functionName: name })
          : await api.jdbcMetaProcedureColumns?.({ connectionId: this.connectionId, schema: s, procedureName: name });
        if (!r?.success) return null;
        const rows: any[] = (r.result?.rows as any[]) || [];
        if (rows.length === 0) return null;
        return rows.map(row => ({
          name: row.name || '',
          order: row.inOut === 'RETURN' || row.inOut === 'RESULTSET' ? 0 : row.order || 0,
          type: row.typeName || '',
          inOut: row.inOut === 'RETURN' ? 'RESULTSET' : (row.inOut || ''),
          length: row.length,
          scale: row.scale,
          precision: row.precision,
          nullable: row.nullable,
        }));
      };
      try {
        const r1 = await tryJdbc(schema || undefined);
        if (r1) return r1;
        if (kind === 'function') {
          const r2 = await tryJdbc(undefined);
          if (r2) return r2;
        }
      } catch { /* fallthrough */ }
    }
    // Altibase 함수 — SYS_PROCEDURES_ 의 RETURN_* 컬럼으로 첫 행 (RETURN_VALUE) 합성 + 파라미터들
    if (this.type === 'altibase') {
      const n2 = escapeStr(name.toUpperCase());
      const rows: { name: string; order: number; type: string; inOut: string; length?: number; scale?: number; precision?: number; nullable?: boolean }[] = [];
      // 함수면 RETURN 행 먼저
      if (kind === 'function') {
        try {
          const retSql = `SELECT RETURN_DATA_TYPE, RETURN_SIZE, RETURN_SCALE, RETURN_PRECISION `
                       + `FROM SYSTEM_.SYS_PROCEDURES_ WHERE PROC_NAME = '${n2}' AND OBJECT_TYPE = 1`;
          const res = await this.exec(retSql, 5000);
          for (const row of res.rows) {
            rows.push({
              name: 'RETURN_VALUE', order: 0, inOut: 'RESULTSET',
              type: this.formatTypeFromCode(row[0]),
              length: this.parseIntOrUndef(row[1]),
              scale: this.parseIntOrUndef(row[2]),
              precision: this.parseIntOrUndef(row[3]),
              nullable: undefined,
            });
            break; // 한 함수당 한 row
          }
        } catch {}
      }
      // 파라미터들
      try {
        const objType = kind === 'function' ? 1 : 0;
        const paramSql = `SELECT PARA_NAME, PARA_ORDER, INOUT_TYPE, DATA_TYPE, SIZE, SCALE, PRECISION `
                       + `FROM SYSTEM_.SYS_PROC_PARAS_ `
                       + `WHERE PROC_OID IN (SELECT PROC_OID FROM SYSTEM_.SYS_PROCEDURES_ WHERE PROC_NAME = '${n2}' AND OBJECT_TYPE = ${objType}) `
                       + `ORDER BY PARA_ORDER`;
        const res = await this.exec(paramSql, 5000);
        for (const row of res.rows) {
          rows.push({
            name: (row[0] || '').toString().trim(),
            order: parseInt((row[1] || '0').toString(), 10) || 0,
            inOut: this.altibaseInOutLabel(row[2]),
            type: this.formatTypeFromCode(row[3]),
            length: this.parseIntOrUndef(row[4]),
            scale: this.parseIntOrUndef(row[5]),
            precision: this.parseIntOrUndef(row[6]),
            nullable: undefined,
          });
        }
      } catch {}
      return rows;
    }
    // ── dialect SQL 폴백 ──
    const s = escapeStr((schema || '').toUpperCase());
    const n = escapeStr(name.toUpperCase());
    // (Altibase 는 위에서 처리 후 return. 여기로 흐르는 것은 oracle/postgres 의 표준 JDBC 미지원 폴백)
    let sql: string | null = null;
    switch (this.type) {
      case 'oracle':
        sql = `SELECT ARGUMENT_NAME, POSITION, IN_OUT, DATA_TYPE, DATA_LENGTH, DATA_SCALE, DATA_PRECISION, NULL FROM ALL_ARGUMENTS WHERE OWNER = '${s}' AND OBJECT_NAME = '${n}' ORDER BY POSITION`;
        break;
      case 'postgres':
        sql = `SELECT parameter_name, ordinal_position, parameter_mode, data_type, character_maximum_length, numeric_scale, numeric_precision, NULL FROM information_schema.parameters WHERE specific_schema = '${escapeStr(schema || '')}' AND specific_name LIKE '${escapeStr(name)}%' ORDER BY ordinal_position`;
        break;
      default: return [];
    }
    const parseRows = (rows: string[][]) => rows.map(r => ({
      name: (r[0] || '').toString().trim(),
      order: parseInt((r[1] || '0').toString(), 10) || 0,
      inOut: this.altibaseInOutLabel(r[2]),
      type: this.formatTypeFromCode(r[3]),
      length: this.parseIntOrUndef(r[4]),
      scale: this.parseIntOrUndef(r[5]),
      precision: this.parseIntOrUndef(r[6]),
      nullable: this.parseNullable(r[7]),
    }));
    try {
      const res = await this.exec(sql, 5000);
      if (res.rows.length > 0) return parseRows(res.rows);
    } catch {}
    return [];
  }
  private parseIntOrUndef(v: any): number | undefined {
    const s = (v || '').toString().trim();
    if (!s) return undefined;
    const n = parseInt(s, 10);
    return isNaN(n) ? undefined : n;
  }
  private parseNullable(v: any): boolean | undefined {
    const s = (v || '').toString().toUpperCase().trim();
    if (!s) return undefined;
    if (s === 'Y' || s === '1' || s === 'T' || s === 'TRUE' || s === 'YES') return true;
    if (s === 'N' || s === '0' || s === 'F' || s === 'FALSE' || s === 'NO') return false;
    return undefined;
  }
  // Altibase DATA_TYPE 코드 → 타입명. 숫자 코드일 때만 매핑, 이미 문자열이면 그대로.
  private formatTypeFromCode(v: any): string {
    const s = (v || '').toString().trim();
    if (!s) return '';
    if (!/^-?\d+$/.test(s)) return s; // Oracle/Postgres 처럼 이미 문자열
    const code = parseInt(s, 10);
    const map: Record<number, string> = {
      1: 'CHAR', 12: 'VARCHAR', 2: 'NUMERIC', 3: 'DECIMAL',
      4: 'INTEGER', 5: 'SMALLINT', [-5]: 'BIGINT', [-6]: 'TINYINT',
      6: 'FLOAT', 7: 'REAL', 8: 'DOUBLE',
      91: 'DATE', 93: 'TIMESTAMP',
      [-2]: 'BINARY', [-3]: 'VARBIT', [-4]: 'BLOB',
      30: 'BLOB', 40: 'CLOB',
      [-7]: 'BIT', [-8]: 'NCHAR', [-9]: 'NVARCHAR',
      0: 'RESULTSET',
    };
    return map[code] || `T${code}`;
  }
  private altibaseInOutLabel(v: any): string {
    const s = (v || '').toString().toUpperCase().trim();
    if (s === '0' || s === 'IN') return 'IN';
    if (s === '1' || s === 'OUT') return 'OUT';
    if (s === '2' || s === 'INOUT' || s === 'IN/OUT') return 'INOUT';
    if (s === '3' || s === 'RESULTSET' || s === 'RESULT') return 'RESULTSET';
    return s;
  }
  // 테이블 제약조건 (PK/UNIQUE/CHECK/NOT NULL).
  async tableConstraints(table: string, schema?: string): Promise<{ name: string; type: string; columns: string[] }[]> {
    const s = escapeStr((schema || '').toUpperCase());
    const n = escapeStr(table.toUpperCase());
    let sql: string | null = null;
    switch (this.type) {
      case 'altibase':
        // CONSTRAINT_TYPE: 0=PK, 1=Unique, 2=NotNull, 3=FK
        sql = `SELECT C.CONSTRAINT_NAME, C.CONSTRAINT_TYPE, CC.COLUMN_NAME `
            + `FROM SYSTEM_.SYS_CONSTRAINTS_ C `
            + `JOIN SYSTEM_.SYS_TABLES_ T ON C.TABLE_ID = T.TABLE_ID `
            + `JOIN SYSTEM_.SYS_USERS_ U ON T.USER_ID = U.USER_ID `
            + `LEFT JOIN SYSTEM_.SYS_CONSTRAINT_COLUMNS_ CC ON CC.CONSTRAINT_ID = C.CONSTRAINT_ID `
            + `WHERE U.USER_NAME = '${s}' AND T.TABLE_NAME = '${n}' AND C.CONSTRAINT_TYPE != 3 `
            + `ORDER BY C.CONSTRAINT_NAME, CC.CONSTRAINT_COL_ORDER`;
        break;
      case 'oracle':
        sql = `SELECT C.CONSTRAINT_NAME, C.CONSTRAINT_TYPE, CC.COLUMN_NAME FROM ALL_CONSTRAINTS C `
            + `LEFT JOIN ALL_CONS_COLUMNS CC ON CC.CONSTRAINT_NAME = C.CONSTRAINT_NAME AND CC.OWNER = C.OWNER `
            + `WHERE C.OWNER = '${s}' AND C.TABLE_NAME = '${n}' AND C.CONSTRAINT_TYPE != 'R' ORDER BY C.CONSTRAINT_NAME, CC.POSITION`;
        break;
      default: return [];
    }
    try {
      const res = await this.exec(sql, 5000);
      const byName = new Map<string, { name: string; type: string; columns: string[] }>();
      for (const row of res.rows) {
        const cname = (row[0] || '').trim();
        const ctype = this.constraintTypeLabel(row[1]);
        const col = (row[2] || '').trim();
        if (!cname) continue;
        const entry = byName.get(cname) || { name: cname, type: ctype, columns: [] };
        if (col) entry.columns.push(col);
        byName.set(cname, entry);
      }
      return Array.from(byName.values());
    } catch { return []; }
  }
  private constraintTypeLabel(v: any): string {
    const s = (v || '').toString().toUpperCase();
    if (s === '0' || s === 'P') return 'PRIMARY KEY';
    if (s === '1' || s === 'U') return 'UNIQUE';
    if (s === '2' || s === 'C') return 'NOT NULL';
    if (s === '3' || s === 'R') return 'FOREIGN KEY';
    if (s === '4') return 'CHECK';
    return s;
  }
  // 테이블 외래키.
  async tableForeignKeys(table: string, schema?: string): Promise<{ name: string; columns: string[]; refTable: string; refColumns: string[] }[]> {
    const s = escapeStr((schema || '').toUpperCase());
    const n = escapeStr(table.toUpperCase());
    let sql: string | null = null;
    switch (this.type) {
      case 'altibase':
        sql = `SELECT C.CONSTRAINT_NAME, CC.COLUMN_NAME, T2.TABLE_NAME, RC.COLUMN_NAME `
            + `FROM SYSTEM_.SYS_CONSTRAINTS_ C `
            + `JOIN SYSTEM_.SYS_TABLES_ T ON C.TABLE_ID = T.TABLE_ID `
            + `JOIN SYSTEM_.SYS_USERS_ U ON T.USER_ID = U.USER_ID `
            + `LEFT JOIN SYSTEM_.SYS_CONSTRAINT_COLUMNS_ CC ON CC.CONSTRAINT_ID = C.CONSTRAINT_ID `
            + `LEFT JOIN SYSTEM_.SYS_TABLES_ T2 ON C.REFERENCED_TABLE_ID = T2.TABLE_ID `
            + `LEFT JOIN SYSTEM_.SYS_CONSTRAINTS_ RC2 ON RC2.CONSTRAINT_ID = C.REFERENCED_CONSTRAINT_ID `
            + `LEFT JOIN SYSTEM_.SYS_CONSTRAINT_COLUMNS_ RC ON RC.CONSTRAINT_ID = RC2.CONSTRAINT_ID AND RC.CONSTRAINT_COL_ORDER = CC.CONSTRAINT_COL_ORDER `
            + `WHERE U.USER_NAME = '${s}' AND T.TABLE_NAME = '${n}' AND C.CONSTRAINT_TYPE = 3 `
            + `ORDER BY C.CONSTRAINT_NAME, CC.CONSTRAINT_COL_ORDER`;
        break;
      case 'oracle':
        sql = `SELECT C.CONSTRAINT_NAME, CC.COLUMN_NAME, RC.TABLE_NAME, RCC.COLUMN_NAME FROM ALL_CONSTRAINTS C `
            + `JOIN ALL_CONS_COLUMNS CC ON CC.CONSTRAINT_NAME = C.CONSTRAINT_NAME AND CC.OWNER = C.OWNER `
            + `JOIN ALL_CONSTRAINTS RC ON RC.OWNER = C.R_OWNER AND RC.CONSTRAINT_NAME = C.R_CONSTRAINT_NAME `
            + `JOIN ALL_CONS_COLUMNS RCC ON RCC.CONSTRAINT_NAME = RC.CONSTRAINT_NAME AND RCC.POSITION = CC.POSITION `
            + `WHERE C.OWNER = '${s}' AND C.TABLE_NAME = '${n}' AND C.CONSTRAINT_TYPE = 'R' ORDER BY C.CONSTRAINT_NAME, CC.POSITION`;
        break;
      default: return [];
    }
    try {
      const res = await this.exec(sql, 5000);
      const byName = new Map<string, { name: string; columns: string[]; refTable: string; refColumns: string[] }>();
      for (const row of res.rows) {
        const fname = (row[0] || '').trim();
        if (!fname) continue;
        const e = byName.get(fname) || { name: fname, columns: [], refTable: (row[2] || '').trim(), refColumns: [] };
        if (row[1]) e.columns.push((row[1] || '').trim());
        if (row[3]) e.refColumns.push((row[3] || '').trim());
        byName.set(fname, e);
      }
      return Array.from(byName.values());
    } catch { return []; }
  }
  // 이 테이블을 참조하는 다른 테이블 외래키 (referenced by).
  async tableReferencedBy(table: string, schema?: string): Promise<{ name: string; fromTable: string; fromColumns: string[] }[]> {
    const s = escapeStr((schema || '').toUpperCase());
    const n = escapeStr(table.toUpperCase());
    let sql: string | null = null;
    switch (this.type) {
      case 'altibase':
        sql = `SELECT C.CONSTRAINT_NAME, T.TABLE_NAME, CC.COLUMN_NAME `
            + `FROM SYSTEM_.SYS_CONSTRAINTS_ C `
            + `JOIN SYSTEM_.SYS_TABLES_ T_REF ON C.REFERENCED_TABLE_ID = T_REF.TABLE_ID `
            + `JOIN SYSTEM_.SYS_USERS_ U_REF ON T_REF.USER_ID = U_REF.USER_ID `
            + `JOIN SYSTEM_.SYS_TABLES_ T ON C.TABLE_ID = T.TABLE_ID `
            + `LEFT JOIN SYSTEM_.SYS_CONSTRAINT_COLUMNS_ CC ON CC.CONSTRAINT_ID = C.CONSTRAINT_ID `
            + `WHERE U_REF.USER_NAME = '${s}' AND T_REF.TABLE_NAME = '${n}' AND C.CONSTRAINT_TYPE = 3 `
            + `ORDER BY C.CONSTRAINT_NAME, CC.CONSTRAINT_COL_ORDER`;
        break;
      case 'oracle':
        sql = `SELECT C.CONSTRAINT_NAME, C.TABLE_NAME, CC.COLUMN_NAME FROM ALL_CONSTRAINTS C `
            + `JOIN ALL_CONS_COLUMNS CC ON CC.CONSTRAINT_NAME = C.CONSTRAINT_NAME AND CC.OWNER = C.OWNER `
            + `JOIN ALL_CONSTRAINTS RC ON RC.OWNER = C.R_OWNER AND RC.CONSTRAINT_NAME = C.R_CONSTRAINT_NAME `
            + `WHERE RC.OWNER = '${s}' AND RC.TABLE_NAME = '${n}' AND C.CONSTRAINT_TYPE = 'R' ORDER BY C.CONSTRAINT_NAME, CC.POSITION`;
        break;
      default: return [];
    }
    try {
      const res = await this.exec(sql, 5000);
      const byName = new Map<string, { name: string; fromTable: string; fromColumns: string[] }>();
      for (const row of res.rows) {
        const cname = (row[0] || '').trim();
        if (!cname) continue;
        const e = byName.get(cname) || { name: cname, fromTable: (row[1] || '').trim(), fromColumns: [] };
        if (row[2]) e.fromColumns.push((row[2] || '').trim());
        byName.set(cname, e);
      }
      return Array.from(byName.values());
    } catch { return []; }
  }
  // 테이블 트리거.
  async tableTriggers(table: string, schema?: string): Promise<{ name: string; event: string; timing: string }[]> {
    const s = escapeStr((schema || '').toUpperCase());
    const n = escapeStr(table.toUpperCase());
    let sql: string | null = null;
    switch (this.type) {
      case 'altibase':
        sql = `SELECT TR.TRIGGER_NAME, TR.EVENT_TYPE, TR.IS_BEFORE FROM SYSTEM_.SYS_TRIGGERS_ TR `
            + `JOIN SYSTEM_.SYS_TABLES_ T ON TR.TABLE_ID = T.TABLE_ID `
            + `JOIN SYSTEM_.SYS_USERS_ U ON T.USER_ID = U.USER_ID `
            + `WHERE U.USER_NAME = '${s}' AND T.TABLE_NAME = '${n}' ORDER BY TR.TRIGGER_NAME`;
        break;
      case 'oracle':
        sql = `SELECT TRIGGER_NAME, TRIGGERING_EVENT, TRIGGER_TYPE FROM ALL_TRIGGERS WHERE OWNER = '${s}' AND TABLE_NAME = '${n}' ORDER BY TRIGGER_NAME`;
        break;
      default: return [];
    }
    try {
      const res = await this.exec(sql, 5000);
      return res.rows.map(r => ({ name: (r[0] || '').trim(), event: (r[1] || '').toString(), timing: (r[2] || '').toString() })).filter(t => t.name);
    } catch { return []; }
  }
  // 시노님이 가리키는 대상 (Declaration 합성용).
  async synonymTarget(name: string): Promise<{ ownerName: string; objectName: string } | null> {
    if (this.type !== 'altibase' && this.type !== 'oracle') return null;
    const n = escapeStr(name.toUpperCase());
    const sql = this.type === 'altibase'
      ? `SELECT OBJECT_OWNER_NAME, OBJECT_NAME FROM SYSTEM_.SYS_SYNONYMS_ WHERE SYNONYM_NAME = '${n}'`
      : `SELECT TABLE_OWNER, TABLE_NAME FROM ALL_SYNONYMS WHERE OWNER = 'PUBLIC' AND SYNONYM_NAME = '${n}'`;
    try {
      const res = await this.exec(sql, 5000);
      if (res.rows.length === 0) return null;
      return { ownerName: (res.rows[0][0] || '').trim(), objectName: (res.rows[0][1] || '').trim() };
    } catch { return null; }
  }

  // 인덱스 상세 — DBeaver 스타일. table/columns 외에 컬럼별 SORT_ORDER, INDEX_TYPE, TABLESPACE 도 반환.
  async indexDetail(name: string, schema?: string): Promise<{ table: string; tableSchema?: string; columns: { name: string; sortOrder: 'A' | 'D' }[]; unique: boolean; typeName?: string; tablespace?: string }> {
    const s = escapeStr((schema || '').toUpperCase());
    const n = escapeStr(name.toUpperCase());
    let listSql: string | null = null;
    switch (this.type) {
      case 'altibase':
        // SYS_INDEX_COLUMNS_ 에 COLUMN_NAME 없음 → COLUMN_ID 로 SYS_COLUMNS_ join 필요.
        // 정렬: INDEX_COL_ORDER. IS_UNIQUE: 'T'/'F'. SORT_ORDER: 'A'/'D'. INDEX_TYPE: 정수.
        // 테이블스페이스: SYS_TABLESPACES_ NAME (LEFT join — 일부 인덱스는 TBS_ID NULL 가능).
        listSql = `SELECT T.TABLE_NAME, C.COLUMN_NAME, I.IS_UNIQUE, I.INDEX_TYPE, IC.SORT_ORDER, TBS.NAME, U2.USER_NAME `
                + `FROM SYSTEM_.SYS_INDICES_ I, SYSTEM_.SYS_TABLES_ T, SYSTEM_.SYS_INDEX_COLUMNS_ IC, SYSTEM_.SYS_COLUMNS_ C `
                + `LEFT JOIN SYSTEM_.SYS_TABLESPACES_ TBS ON 1 = 0 `  // 자리채움 — 아래서 실제 join
                + `, SYSTEM_.SYS_USERS_ U2 `
                + `WHERE I.INDEX_NAME = '${n}' `
                + `AND I.TABLE_ID = T.TABLE_ID AND I.USER_ID = T.USER_ID `
                + `AND IC.INDEX_ID = I.INDEX_ID AND IC.USER_ID = I.USER_ID `
                + `AND C.COLUMN_ID = IC.COLUMN_ID `
                + `AND U2.USER_ID = T.USER_ID `
                + `ORDER BY IC.INDEX_COL_ORDER`;
        // SYS_TABLESPACES_.NAME 도 함께 — TBS_ID = SPACE_ID. 인덱스 TBS_ID 가 NULL 이면 테이블의 TBS_ID 사용.
        // DBeaver AltibaseTableIndex 와 동일한 패턴.
        listSql = `SELECT T.TABLE_NAME, C.COLUMN_NAME, I.IS_UNIQUE, I.INDEX_TYPE, IC.SORT_ORDER, `
                + `NVL(I.TBS_ID, T.TBS_ID), `
                + `U2.USER_NAME `
                + `FROM SYSTEM_.SYS_INDICES_ I, SYSTEM_.SYS_TABLES_ T, SYSTEM_.SYS_INDEX_COLUMNS_ IC, SYSTEM_.SYS_COLUMNS_ C, SYSTEM_.SYS_USERS_ U2 `
                + `WHERE I.INDEX_NAME = '${n}' `
                + `AND I.TABLE_ID = T.TABLE_ID AND I.USER_ID = T.USER_ID `
                + `AND IC.INDEX_ID = I.INDEX_ID AND IC.USER_ID = I.USER_ID `
                + `AND C.COLUMN_ID = IC.COLUMN_ID `
                + `AND U2.USER_ID = T.USER_ID `
                + `ORDER BY IC.INDEX_COL_ORDER`;
        break;
      case 'oracle':
        listSql = `SELECT IC.TABLE_NAME, IC.COLUMN_NAME, I.UNIQUENESS, I.INDEX_TYPE `
                + `FROM ALL_IND_COLUMNS IC `
                + `JOIN ALL_INDEXES I ON I.INDEX_NAME = IC.INDEX_NAME AND I.OWNER = IC.INDEX_OWNER `
                + `WHERE IC.INDEX_OWNER = '${s}' AND IC.INDEX_NAME = '${n}' ORDER BY IC.COLUMN_POSITION`;
        break;
      case 'postgres':
        listSql = `SELECT tablename, indexname FROM pg_indexes WHERE schemaname = '${escapeStr(schema || '')}' AND indexname = '${escapeStr(name)}'`;
        break;
      default: return { table: '', columns: [], unique: false, tableSchema: undefined, typeName: undefined, tablespace: undefined };
    }
    const indexTypeName = (code: any): string | undefined => {
      const c = parseInt((code || '').toString(), 10);
      const m: Record<number, string> = { 1: 'BTREE', 2: 'RTREE', 6: 'MEMORY' };
      return m[c] || (isNaN(c) ? (code ? code.toString() : undefined) : `TYPE_${c}`);
    };
    const parseIdxRows = (rows: string[][]) => {
      const table = (rows[0][0] || '').toString();
      const columns = rows.map(r => {
        const colName = (r[1] || '').toString();
        const so = (rows[0].length > 4 ? (r[4] || '') : '').toString().toUpperCase();
        const sortOrder: 'A' | 'D' = so === 'D' ? 'D' : 'A';
        return { name: colName, sortOrder };
      }).filter(c => c.name);
      const uniqueRaw = rows[0].length > 2 ? (rows[0][2] || '').toString().toUpperCase() : '';
      const unique = uniqueRaw === '1' || uniqueRaw === 'T' || uniqueRaw === 'TRUE' || uniqueRaw === 'Y' || uniqueRaw === 'UNIQUE';
      const typeName = rows[0].length > 3 ? indexTypeName(rows[0][3]) : undefined;
      // 컬럼 순서: [TABLE_NAME, COLUMN_NAME, IS_UNIQUE, INDEX_TYPE, SORT_ORDER, TBS_ID(raw), USER_NAME]
      // tablespace 는 호출부에서 SYS_TABLESPACES_ 조회 후 채움.
      const tbsIdRaw = rows[0].length > 5 ? ((rows[0][5] || '').toString() || undefined) : undefined;
      const tableSchema = rows[0].length > 6 ? (rows[0][6] || '').toString() || undefined : undefined;
      return { table, tableSchema, columns, unique, typeName, tablespace: undefined as string | undefined, _tbsId: tbsIdRaw } as any;
    };
    try {
      const res = await this.exec(listSql, 5000);
      if (res.rows.length > 0) {
        const parsed: any = parseIdxRows(res.rows);
        if (this.type === 'altibase') {
          const tbsId = (parsed._tbsId || '').toString();
          if (tbsId && tbsId !== '0' && tbsId.toUpperCase() !== 'NULL') {
            const idNum = parseInt(tbsId, 10);
            if (!isNaN(idNum)) {
              // DBeaver AltibaseDataSource.TablespaceCache 참조 — V$TABLESPACES 사용 (SYS_TABLESPACES_ 는 없음).
              try {
                const tr = await this.exec(`SELECT NAME FROM V$TABLESPACES WHERE ID = ${idNum}`, 10);
                if (tr.rows.length > 0 && tr.rows[0][0]) {
                  parsed.tablespace = (tr.rows[0][0] || '').toString();
                }
              } catch {}
            }
          }
        }
        delete parsed._tbsId;
        return parsed;
      }
    } catch {}
    // Altibase 폴백 — 정렬 없이
    if (this.type === 'altibase') {
      const fallback = `SELECT T.TABLE_NAME, C.COLUMN_NAME, I.IS_UNIQUE, I.INDEX_TYPE `
                     + `FROM SYSTEM_.SYS_INDICES_ I, SYSTEM_.SYS_TABLES_ T, SYSTEM_.SYS_INDEX_COLUMNS_ IC, SYSTEM_.SYS_COLUMNS_ C `
                     + `WHERE I.INDEX_NAME = '${n}' `
                     + `AND I.TABLE_ID = T.TABLE_ID AND I.USER_ID = T.USER_ID `
                     + `AND IC.INDEX_ID = I.INDEX_ID AND IC.USER_ID = I.USER_ID `
                     + `AND C.COLUMN_ID = IC.COLUMN_ID`;
      try {
        const r2 = await this.exec(fallback, 5000);
        if (r2.rows.length > 0) return parseIdxRows(r2.rows);
      } catch {}
    }
    return { table: '', columns: [], unique: false, tableSchema: undefined, typeName: undefined, tablespace: undefined };
  }
  // 시퀀스 상세 — 동적 컬럼 (Altibase 버전마다 컬럼명이 다를 수 있어 SELECT * 후 columns/rows 그대로 표시).
  async sequenceDetail(name: string, schema?: string): Promise<Record<string, string>> {
    const s = escapeStr((schema || '').toUpperCase());
    const n = escapeStr(name.toUpperCase());
    let sql: string | null = null;
    switch (this.type) {
      case 'altibase':
        // DBeaver AltibaseMetaModel 참조 — V$SEQ 뷰 + TABLE_OID = SEQ_OID JOIN
        sql = `SELECT T.TABLE_NAME, S.CURRENT_SEQ, S.START_SEQ, S.INCREMENT_SEQ, S.CACHE_SIZE, S.MAX_SEQ, S.MIN_SEQ, S.IS_CYCLE `
            + `FROM V$SEQ S, SYSTEM_.SYS_TABLES_ T, SYSTEM_.SYS_USERS_ U `
            + `WHERE U.USER_NAME = '${s}' AND U.USER_ID = T.USER_ID `
            + `AND T.TABLE_OID = S.SEQ_OID AND T.TABLE_TYPE = 'S' AND T.TABLE_NAME = '${n}'`;
        break;
      case 'oracle':
        sql = `SELECT * FROM ALL_SEQUENCES WHERE SEQUENCE_OWNER = '${s}' AND SEQUENCE_NAME = '${n}'`;
        break;
      default: return {};
    }
    try {
      const res = await this.exec(sql, 5000);
      if (res.rows.length === 0) return {};
      // 의미 있는 컬럼만 (이름에 SEQ/INCREMENT/START/MIN/MAX/CACHE/CURRENT 포함) 추출
      const interestingPattern = /SEQ|INCREMENT|START|MIN|MAX|CACHE|CURRENT|LAST|CYCLE|ORDER/i;
      const out: Record<string, string> = {};
      const row = res.rows[0];
      res.columns.forEach((col, i) => {
        if (!interestingPattern.test(col)) return;
        const v = (row[i] ?? '').toString().trim();
        if (v) out[col] = v;
      });
      // 의미 있는 게 하나도 없으면 모든 컬럼 표시 (fallback)
      if (Object.keys(out).length === 0) {
        res.columns.forEach((col, i) => { out[col] = (row[i] ?? '').toString(); });
      }
      return out;
    } catch { return {}; }
  }
  // 프로시저/함수 본문 (소스 텍스트).
  async routineSource(name: string, kind: 'procedure' | 'function', schema?: string): Promise<string | null> {
    const s = escapeStr((schema || '').toUpperCase());
    const n = escapeStr(name.toUpperCase());
    let sql: string | null = null;
    switch (this.type) {
      case 'altibase':
        // SYS_PROC_PARSE_.PARSE 가 본문. SEQ_NO 순으로 join.
        sql = `SELECT PP.PARSE FROM SYSTEM_.SYS_PROC_PARSE_ PP `
            + `JOIN SYSTEM_.SYS_PROCEDURES_ P ON PP.PROC_OID = P.PROC_OID `
            + `JOIN SYSTEM_.SYS_USERS_ U ON P.USER_ID = U.USER_ID `
            + `WHERE U.USER_NAME = '${s}' AND P.PROC_NAME = '${n}' `
            + `ORDER BY PP.SEQ_NO`;
        break;
      case 'oracle':
        sql = `SELECT TEXT FROM ALL_SOURCE WHERE OWNER = '${s}' AND NAME = '${n}' AND TYPE = '${kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION'}' ORDER BY LINE`;
        break;
      case 'postgres':
        sql = `SELECT prosrc FROM pg_proc P JOIN pg_namespace N ON P.pronamespace = N.oid WHERE N.nspname = '${escapeStr(schema || '')}' AND P.proname = '${escapeStr(name)}'`;
        break;
      case 'mssql':
        sql = `SELECT OBJECT_DEFINITION(OBJECT_ID('${escapeStr(name)}'))`;
        break;
      default: return null;
    }
    try {
      const res = await this.exec(sql, 10000);
      if (res.rows.length === 0) return null;
      const body = res.rows.map(r => r[0] || '').join('').trim();
      return body || null;
    } catch { return null; }
  }
  // 스키마(user) 의 모든 인덱스 — DatabaseMetaData.getIndexInfo 는 테이블 단위라 dialect SQL 필요.
  // 인덱스 목록 — "TABLE.INDEX" 형식으로 반환 (DBeaver 스타일).
  async listSchemaIndexes(schema?: string): Promise<string[]> {
    const s = escapeStr((schema || '').toUpperCase());
    let sql: string | null = null;
    switch (this.type) {
      case 'altibase':
        // 테이블명도 같이 — TABLE.INDEX 형식
        sql = `SELECT T.TABLE_NAME || '.' || I.INDEX_NAME FROM SYSTEM_.SYS_INDICES_ I `
            + `JOIN SYSTEM_.SYS_TABLES_ T ON I.TABLE_ID = T.TABLE_ID AND I.USER_ID = T.USER_ID `
            + `JOIN SYSTEM_.SYS_USERS_ U ON I.USER_ID = U.USER_ID `
            + `WHERE U.USER_NAME = '${s}' ORDER BY T.TABLE_NAME, I.INDEX_NAME`;
        break;
      case 'oracle':
        sql = `SELECT TABLE_NAME || '.' || INDEX_NAME FROM ALL_INDEXES WHERE OWNER = '${s}' ORDER BY TABLE_NAME, INDEX_NAME`;
        break;
      case 'postgres':
        sql = `SELECT tablename || '.' || indexname FROM pg_indexes WHERE schemaname = '${escapeStr(schema || '')}' ORDER BY tablename, indexname`;
        break;
      case 'mysql':
        sql = `SELECT DISTINCT CONCAT(table_name, '.', index_name) FROM information_schema.statistics WHERE table_schema = '${escapeStr(schema || '')}' ORDER BY 1`;
        break;
      case 'mssql':
        sql = `SELECT OBJECT_NAME(object_id) + '.' + name FROM sys.indexes WHERE name IS NOT NULL ORDER BY 1`;
        break;
      default: return [];
    }
    try {
      const res = await this.exec(sql, 10000);
      return res.rows.map(r => (r[0] || '').trim()).filter(Boolean);
    } catch { return []; }
  }
  // 테이블스페이스 목록 — DBeaver 의 "저장소 > 테이블스페이스" 노드.
  // dialect 별 카탈로그 뷰. 결과는 "NAME (SIZE)" 또는 단순 "NAME".
  async listTablespaces(): Promise<string[]> {
    let sql: string | null = null;
    switch (this.type) {
      case 'altibase':
        // DBeaver AltibaseDataSource.TablespaceCache 참조 — V$TABLESPACES.
        sql = `SELECT NAME FROM V$TABLESPACES ORDER BY NAME`;
        break;
      case 'oracle':
        sql = `SELECT TABLESPACE_NAME FROM DBA_TABLESPACES ORDER BY TABLESPACE_NAME`;
        break;
      case 'postgres':
        sql = `SELECT spcname FROM pg_tablespace ORDER BY spcname`;
        break;
      case 'mssql':
        sql = `SELECT name FROM sys.filegroups ORDER BY name`;
        break;
      default: return [];
    }
    try {
      const res = await this.exec(sql, 5000);
      return res.rows.map(r => (r[0] || '').trim()).filter(Boolean);
    } catch {
      // Altibase 폴백 — DBA_TABLESPACES (있는 경우)
      if (this.type === 'altibase') {
        try {
          const r2 = await this.exec(`SELECT NAME FROM V$TABLESPACES ORDER BY NAME`, 5000);
          return r2.rows.map(r => (r[0] || '').trim()).filter(Boolean);
        } catch { return []; }
      }
      return [];
    }
  }
  // Altibase 이중화 객체 — SYS_REPLICATIONS_. DBMS-전역(특정 user 소유 X).
  async listReplications(): Promise<string[]> {
    if (this.type !== 'altibase') return [];
    try {
      const res = await this.exec(`SELECT REPLICATION_NAME FROM SYSTEM_.SYS_REPLICATIONS_ ORDER BY REPLICATION_NAME`, 5000);
      return res.rows.map(r => (r[0] || '').trim()).filter(Boolean);
    } catch { return []; }
  }
  // dialect 별 프로시저/함수 목록 SQL — JDBC getProcedures/getFunctions 가 부실한 드라이버 보강.
  private routineListSql(schema: string | undefined, kind: 'procedure' | 'function'): string | null {
    const s = escapeStr((schema || '').toUpperCase());
    switch (this.type) {
      case 'altibase':
        // SYS_PROCEDURES_.OBJECT_TYPE: 0=Procedure, 1=Function (Altibase). USER_ID 로 스키마 필터.
        return `SELECT P.PROC_NAME FROM SYSTEM_.SYS_PROCEDURES_ P JOIN SYSTEM_.SYS_USERS_ U ON P.USER_ID = U.USER_ID `
          + `WHERE U.USER_NAME = '${s}' AND P.OBJECT_TYPE = ${kind === 'procedure' ? 0 : 1} ORDER BY P.PROC_NAME`;
      case 'oracle':
        return `SELECT OBJECT_NAME FROM ALL_OBJECTS WHERE OWNER = '${s}' AND OBJECT_TYPE = '${kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION'}' ORDER BY OBJECT_NAME`;
      case 'postgres':
        return `SELECT routine_name FROM information_schema.routines WHERE routine_schema = '${escapeStr(schema || '')}' AND routine_type = '${kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION'}' ORDER BY routine_name`;
      case 'mysql':
        return `SELECT routine_name FROM information_schema.routines WHERE routine_schema = '${escapeStr(schema || '')}' AND routine_type = '${kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION'}' ORDER BY routine_name`;
      case 'mssql':
        return kind === 'procedure'
          ? `SELECT name FROM sys.procedures ORDER BY name`
          : `SELECT name FROM sys.objects WHERE type IN ('FN','IF','TF') ORDER BY name`;
      default:
        return null;
    }
  }

  async listProcedures(schema?: string): Promise<string[]> {
    const sql = this.routineListSql(schema, 'procedure');
    if (sql) {
      try {
        const res = await this.exec(sql, 5000);
        const names = res.rows.map(r => (r[0] || '').trim()).filter(Boolean);
        // 비어도 SQL 이 정상 실행됐으면 그대로 반환(진짜 없음). 예외 시만 폴백.
        return names;
      } catch { /* 폴백 */ }
    }
    const api: any = (window as any).api || {};
    const r = await api.jdbcMetaProcedures?.({ connectionId: this.connectionId, schema });
    if (!r?.success) return [];
    return ((r.result?.rows as any[]) || []).map(row => row.name).filter(Boolean);
  }
  async listFunctions(schema?: string): Promise<string[]> {
    const sql = this.routineListSql(schema, 'function');
    if (sql) {
      try {
        const res = await this.exec(sql, 5000);
        return res.rows.map(r => (r[0] || '').trim()).filter(Boolean);
      } catch { /* 폴백 */ }
    }
    const api: any = (window as any).api || {};
    const r = await api.jdbcMetaFunctions?.({ connectionId: this.connectionId, schema });
    if (!r?.success) return [];
    return ((r.result?.rows as any[]) || []).map(row => row.name).filter(Boolean);
  }
  async indexes(table: string, schema?: string): Promise<{ name: string; columns: string[] }[]> {
    const api: any = (window as any).api || {};
    const r = await api.jdbcMetaIndexes?.({ connectionId: this.connectionId, table, schema });
    if (!r?.success) return [];
    return ((r.result?.rows as any[]) || []).map(row => ({ name: row.name, columns: row.columns || [] }));
  }

  async columns(table: string, schema?: string): Promise<ColumnInfo[]> {
    const api: any = (window as any).api || {};
    const r = await api.jdbcMetaColumns?.({ connectionId: this.connectionId, table, schema });
    if (!r?.success) return [];
    return ((r.result?.rows as any[]) || []).map((row: any) => ({
      name: row.name,
      typeText: formatType(row.typeName, row.size || 0, row.digits || 0),
      nullable: !!row.nullable,
    }));
  }

  async primaryKey(table: string, schema?: string): Promise<string[]> {
    const api: any = (window as any).api || {};
    const r = await api.jdbcMetaPrimaryKeys?.({ connectionId: this.connectionId, table, schema });
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
