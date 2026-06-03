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

// 바이트 수치를 사람이 읽기 좋은 단위로 (1024 단위, 정수면 정수 표기).
function formatBytes(bytes: number): string {
  if (!isFinite(bytes) || bytes <= 0) return '0';
  const units = ['B', 'K', 'M', 'G', 'T', 'P'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const num = (v >= 100 || v % 1 === 0) ? v.toFixed(0) : v.toFixed(1);
  return `${num}${units[i]}`;
}
// V$DATAFILES.STATE 코드 매핑 (Altibase). 사용자 환경 기준: 2=ONLINE.
function mapDatafileState(s: string): string {
  const m: Record<string, string> = { '0': 'OFFLINE', '1': 'BACKUP', '2': 'ONLINE', '3': 'OFFLINE_BACKUP' };
  return m[s] || s;
}

// V$DATAFILES 컬럼 → DBeaver 한글/영문 헤더 매핑.
function mapDataFileHeader(col: string): string {
  const m: Record<string, string> = {
    NAME: 'Path',
    DATAFILE_ID: 'DataFile ID',
    SPACEID: 'Tablespace ID',
    SPACE_ID: 'Tablespace ID',
    CURRENT_SIZE: 'Current Size',
    NEXT_SIZE: 'Next Size',
    INITIAL_SIZE: 'Initital Size',
    DBFILE_SIZE: 'DBFile Size',
    MAXIMUM_SIZE: 'Maximum Size',
    MAX_SIZE: 'Maximum Size',
    AUTOEXTEND_MODE: 'Auto Extended',
    AUTO_EXTENDED: 'Auto Extended',
    STATE: 'State',
    SPACE_NAME: 'Tablespace',
    ID: 'ID',
    CHECKPOINT_PATH: 'Path',
  };
  return m[col?.toUpperCase()] || col;
}

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
      const s2 = escapeStr((schema || '').toUpperCase());
      const userJoin = s2
        ? `AND USER_ID = (SELECT USER_ID FROM SYSTEM_.SYS_USERS_ WHERE USER_NAME = '${s2}')`
        : '';
      const rows: { name: string; order: number; type: string; inOut: string; length?: number; scale?: number; precision?: number; nullable?: boolean }[] = [];
      // 함수면 RETURN 행 먼저
      if (kind === 'function') {
        try {
          const retSql = `SELECT RETURN_DATA_TYPE, RETURN_SIZE, RETURN_SCALE, RETURN_PRECISION `
                       + `FROM SYSTEM_.SYS_PROCEDURES_ WHERE PROC_NAME = '${n2}' AND OBJECT_TYPE = 1 ${userJoin}`;
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
                       + `WHERE PROC_OID IN (SELECT PROC_OID FROM SYSTEM_.SYS_PROCEDURES_ WHERE PROC_NAME = '${n2}' AND OBJECT_TYPE = ${objType} ${userJoin}) `
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
  async tableConstraints(table: string, schema?: string): Promise<{ name: string; owner: string; type: string; validated: string; condition: string; columns: string[] }[]> {
    const s = escapeStr((schema || '').toUpperCase());
    const n = escapeStr(table.toUpperCase());
    let sql: string | null = null;
    switch (this.type) {
      case 'altibase':
        // DBeaver AltibaseMetaModel.prepareUniqueConstraintsLoadStatement 와 완전히 동일 SQL.
        // SYS_CONSTRAINT_COLUMNS_ 에는 COLUMN_NAME 이 없어 SYS_COLUMNS_ 와 COLUMN_ID 로 추가 JOIN.
        sql = `SELECT C.CONSTRAINT_NAME AS PK_NAME, C.CONSTRAINT_TYPE, COL.COLUMN_NAME, T.TABLE_NAME, C.VALIDATED, C.CHECK_CONDITION `
            + `FROM SYSTEM_.SYS_USERS_ U, SYSTEM_.SYS_TABLES_ T, SYSTEM_.SYS_COLUMNS_ COL, `
            + `SYSTEM_.SYS_CONSTRAINTS_ C, SYSTEM_.SYS_CONSTRAINT_COLUMNS_ CCOL `
            + `WHERE U.USER_NAME = '${s}' `
            + `AND U.USER_ID = C.USER_ID `
            + `AND U.USER_ID = T.USER_ID `
            + `AND T.TABLE_ID = C.TABLE_ID `
            + `AND C.CONSTRAINT_TYPE <> 0 `
            + `AND C.CONSTRAINT_ID = CCOL.CONSTRAINT_ID `
            + `AND CCOL.COLUMN_ID = COL.COLUMN_ID `
            + `AND T.TABLE_NAME = '${n}' `
            + `ORDER BY C.CONSTRAINT_NAME, CCOL.CONSTRAINT_COL_ORDER`;
        break;
      case 'oracle':
        sql = `SELECT C.CONSTRAINT_NAME, C.CONSTRAINT_TYPE, CC.COLUMN_NAME, C.TABLE_NAME, C.VALIDATED, C.SEARCH_CONDITION FROM ALL_CONSTRAINTS C `
            + `LEFT JOIN ALL_CONS_COLUMNS CC ON CC.CONSTRAINT_NAME = C.CONSTRAINT_NAME AND CC.OWNER = C.OWNER `
            + `WHERE C.OWNER = '${s}' AND C.TABLE_NAME = '${n}' AND C.CONSTRAINT_TYPE != 'R' ORDER BY C.CONSTRAINT_NAME, CC.POSITION`;
        break;
      default: return [];
    }
    try {
      const res = await this.exec(sql, 5000);
      const byName = new Map<string, { name: string; owner: string; type: string; validated: string; condition: string; columns: string[] }>();
      for (const row of res.rows) {
        const cname = (row[0] || '').trim();
        const ctype = this.constraintTypeLabel(row[1]);
        const col = (row[2] || '').trim();
        const owner = (row[3] || '').trim();
        const validatedRaw = (row[4] || '').toString().toUpperCase().trim();
        const validated = (validatedRaw === 'T' || validatedRaw === 'Y' || validatedRaw === 'TRUE' || validatedRaw === 'VALIDATED' || validatedRaw === '1') ? 'true' : (validatedRaw ? 'false' : '');
        const condition = (row[5] || '').toString().trim();
        if (!cname) continue;
        const entry = byName.get(cname) || { name: cname, owner, type: ctype, validated, condition, columns: [] };
        if (col) entry.columns.push(col);
        byName.set(cname, entry);
      }
      return Array.from(byName.values());
    } catch { return []; }
  }
  private constraintTypeLabel(v: any): string {
    const s = (v || '').toString().toUpperCase();
    // Altibase 코드 (DBeaver AltibaseMetaModel 기준)
    if (s === '0') return 'FOREIGN KEY';
    if (s === '1') return 'NOT NULL';
    if (s === '2') return 'UNIQUE';
    if (s === '3') return 'PRIMARY KEY';
    if (s === '5') return 'TIMESTAMP';
    if (s === '6') return 'LOCAL UNIQUE';
    if (s === '7') return 'CHECK';
    // Oracle 코드
    if (s === 'P') return 'PRIMARY KEY';
    if (s === 'U') return 'UNIQUE';
    if (s === 'C') return 'CHECK';
    if (s === 'R') return 'FOREIGN KEY';
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
                + (s ? `AND U2.USER_NAME = '${s}' ` : '')
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
  // 테이블 DDL — dialect 별 네이티브 메타데이터 함수 우선. 실패 시 null 반환(호출부 fallback).
  // DBeaver AltibaseMetaModel.getDDLFromDbmsMetadata 와 동일 패턴 (DBMS_METADATA.GET_DDL).
  async tableDdl(name: string, schema?: string): Promise<string | null> {
    const n = escapeStr(name.toUpperCase());
    // 스키마 우선순위: 인자 > info.schema > 접속 user
    const resolvedSchema = (schema || this._info?.schema || this.dbms?.user || '').toUpperCase();
    const s = escapeStr(resolvedSchema);
    if (this.type === 'altibase' || this.type === 'oracle') {
      const qSchema = s ? `, '${s}'` : '';
      try {
        const r = await this.exec(`SELECT DBMS_METADATA.GET_DDL('TABLE', '${n}'${qSchema}) FROM DUAL`, 1);
        const ddl = (r.rows[0]?.[0] || '').toString().trim();
        if (ddl && !/error|ORA-|ERR-/i.test(ddl.slice(0, 80))) {
          // 인덱스 DDL 추가 — resolvedSchema 사용
          const idxBlock = await this._collectIndexDdls(name, resolvedSchema).catch(() => '');
          return idxBlock ? `${ddl.replace(/;?\s*$/, ';')}\n\n${idxBlock}` : ddl.replace(/;?\s*$/, ';');
        }
      } catch { /* fallback */ }
    }
    return null;
  }
  // 테이블의 모든 인덱스 DDL 을 모아 문자열로 — table DDL 아래 추가용.
  private async _collectIndexDdls(table: string, schema?: string): Promise<string> {
    try {
      const idxNames = await this.listTableIndexes(table, schema);
      if (!idxNames.length) return '';
      const out: string[] = [];
      for (const idx of idxNames) {
        try {
          const d = await this.indexDetail(idx, schema);
          if (!d.table) continue;
          const q = (x: string) => `"${x}"`;
          const cols = (d.columns || []).map(c => q(c.name) + (c.sortOrder === 'D' ? ' DESC' : ''));
          const sch = (d.tableSchema || schema || '').toUpperCase();
          const head = `CREATE ${d.unique ? 'UNIQUE ' : ''}INDEX ${sch ? q(sch) + '.' : ''}${q(idx)} ON ${sch ? q(sch) + '.' : ''}${q(d.table)} (${cols.join(', ')})`;
          const parts = [head];
          if (d.typeName) parts.push(`INDEXTYPE IS ${d.typeName}`);
          if (d.tablespace) parts.push(`TABLESPACE ${q(d.tablespace)}`);
          out.push(parts.join('\n') + ';');
        } catch {}
      }
      return out.join('\n\n');
    } catch { return ''; }
  }

  // ── 테이블별 하위 (DBeaver 의 테이블 노드 펼침: 제약조건/외래키/인덱스/참조/트리거) ──
  // Altibase SYS_CONSTRAINTS_.CONSTRAINT_TYPE (DBeaver AltibaseMetaModel 기준):
  //   0=FOREIGN KEY, 1=NOT NULL, 2=UNIQUE, 3=PRIMARY KEY, 5=TIMESTAMP, 6=LOCAL UNIQUE, 7=CHECK
  // 제약조건 폴더는 FK(0) 제외, 외래키 폴더는 FK(0) 만, 참조 폴더는 다른 테이블의 FK(0) 가
  // 본 테이블을 가리키는 것.
  async listTableConstraints(table: string, schema?: string): Promise<string[]> {
    if (this.type !== 'altibase') return [];
    const s = escapeStr((schema || '').toUpperCase());
    const t = escapeStr(table.toUpperCase());
    try {
      const r = await this.exec(
        `SELECT C.CONSTRAINT_NAME FROM SYSTEM_.SYS_CONSTRAINTS_ C, SYSTEM_.SYS_TABLES_ T, SYSTEM_.SYS_USERS_ U `
      + `WHERE C.TABLE_ID = T.TABLE_ID AND C.USER_ID = T.USER_ID AND T.USER_ID = U.USER_ID `
      + `AND U.USER_NAME = '${s}' AND T.TABLE_NAME = '${t}' `
      + `AND C.CONSTRAINT_TYPE <> 0 `
      + `ORDER BY C.CONSTRAINT_NAME`, 1000);
      return r.rows.map(x => (x[0] || '').toString()).filter(Boolean);
    } catch { return []; }
  }
  async listTableForeignKeys(table: string, schema?: string): Promise<string[]> {
    if (this.type !== 'altibase') return [];
    const s = escapeStr((schema || '').toUpperCase());
    const t = escapeStr(table.toUpperCase());
    try {
      // CONSTRAINT_TYPE = 0 (FK) — DBeaver 기준
      const r = await this.exec(
        `SELECT C.CONSTRAINT_NAME FROM SYSTEM_.SYS_CONSTRAINTS_ C, SYSTEM_.SYS_TABLES_ T, SYSTEM_.SYS_USERS_ U `
      + `WHERE C.TABLE_ID = T.TABLE_ID AND C.USER_ID = T.USER_ID AND T.USER_ID = U.USER_ID `
      + `AND U.USER_NAME = '${s}' AND T.TABLE_NAME = '${t}' AND C.CONSTRAINT_TYPE = 0 `
      + `ORDER BY C.CONSTRAINT_NAME`, 1000);
      return r.rows.map(x => (x[0] || '').toString()).filter(Boolean);
    } catch { return []; }
  }
  async listTableIndexes(table: string, schema?: string): Promise<string[]> {
    if (this.type !== 'altibase') return [];
    const s = escapeStr((schema || '').toUpperCase());
    const t = escapeStr(table.toUpperCase());
    try {
      const r = await this.exec(
        `SELECT I.INDEX_NAME FROM SYSTEM_.SYS_INDICES_ I, SYSTEM_.SYS_TABLES_ T, SYSTEM_.SYS_USERS_ U `
      + `WHERE I.TABLE_ID = T.TABLE_ID AND I.USER_ID = T.USER_ID AND T.USER_ID = U.USER_ID `
      + `AND U.USER_NAME = '${s}' AND T.TABLE_NAME = '${t}' `
      + `ORDER BY I.INDEX_NAME`, 1000);
      return r.rows.map(x => (x[0] || '').toString()).filter(Boolean);
    } catch { return []; }
  }
  // 참조: 이 테이블을 가리키는 FK (다른 테이블의 FK 가 REFERENCED_TABLE_ID = 본 테이블)
  async listTableReferences(table: string, schema?: string): Promise<string[]> {
    if (this.type !== 'altibase') return [];
    const s = escapeStr((schema || '').toUpperCase());
    const t = escapeStr(table.toUpperCase());
    try {
      const r = await this.exec(
        `SELECT C.CONSTRAINT_NAME || ' (' || RT.TABLE_NAME || ')' `
      + `FROM SYSTEM_.SYS_CONSTRAINTS_ C, SYSTEM_.SYS_TABLES_ T, SYSTEM_.SYS_USERS_ U, SYSTEM_.SYS_TABLES_ RT `
      + `WHERE C.REFERENCED_TABLE_ID = T.TABLE_ID AND C.REFERENCED_USER_ID = T.USER_ID `
      + `AND T.USER_ID = U.USER_ID AND U.USER_NAME = '${s}' AND T.TABLE_NAME = '${t}' `
      + `AND C.TABLE_ID = RT.TABLE_ID AND C.USER_ID = RT.USER_ID `
      + `AND C.CONSTRAINT_TYPE = 0 ORDER BY C.CONSTRAINT_NAME`, 1000);
      return r.rows.map(x => (x[0] || '').toString()).filter(Boolean);
    } catch { return []; }
  }
  async listTableTriggers(table: string, schema?: string): Promise<string[]> {
    if (this.type !== 'altibase') return [];
    const s = escapeStr((schema || '').toUpperCase());
    const t = escapeStr(table.toUpperCase());
    try {
      const r = await this.exec(
        `SELECT TR.TRIGGER_NAME FROM SYSTEM_.SYS_TRIGGERS_ TR, SYSTEM_.SYS_TABLES_ T, SYSTEM_.SYS_USERS_ U `
      + `WHERE TR.TABLE_ID = T.TABLE_ID AND TR.USER_ID = T.USER_ID AND T.USER_ID = U.USER_ID `
      + `AND U.USER_NAME = '${s}' AND T.TABLE_NAME = '${t}' `
      + `ORDER BY TR.TRIGGER_NAME`, 1000);
      return r.rows.map(x => (x[0] || '').toString()).filter(Boolean);
    } catch { return []; }
  }

  // 스키마 레벨 패키지 목록 — DBeaver preparePackageLoadStatement 와 동일.
  async listPackages(schema?: string): Promise<string[]> {
    if (this.type !== 'altibase' && this.type !== 'oracle') return [];
    const s = escapeStr((schema || '').toUpperCase());
    let sql: string;
    if (this.type === 'altibase') {
      // DBeaver preparePackageLoadStatement 와 동일 — spec/body 합쳐 모두, 이름 중복은 DISTINCT.
      // (Altibase PACKAGE_TYPE: 6=SPEC, 7=BODY)
      sql = `SELECT DISTINCT P.PACKAGE_NAME FROM SYSTEM_.SYS_PACKAGES_ P, SYSTEM_.SYS_USERS_ U `
          + `WHERE U.USER_NAME = '${s}' AND U.USER_ID = P.USER_ID `
          + `ORDER BY P.PACKAGE_NAME`;
    } else {
      sql = `SELECT OBJECT_NAME FROM ALL_OBJECTS WHERE OWNER = '${s}' AND OBJECT_TYPE = 'PACKAGE' ORDER BY OBJECT_NAME`;
    }
    try {
      const r = await this.exec(sql, 5000);
      return r.rows.map(x => (x[0] || '').toString()).filter(Boolean);
    } catch { return []; }
  }

  // 패키지에 속한 프로시저/함수 — DBeaver prepareCallableLoadStatement(package) 와 동일.
  // SYS_PACKAGE_PARAS_.SUB_TYPE: 0=PROCEDURE, 1=FUNCTION.
  async listPackageRoutines(packageName: string, schema?: string): Promise<{ name: string; schema: string; package: string; type: 'PROCEDURE' | 'FUNCTION' }[]> {
    if (this.type !== 'altibase') return [];
    const s = escapeStr((schema || this.dbms?.user || '').toUpperCase());
    const p = escapeStr(packageName.toUpperCase());
    try {
      const r = await this.exec(
        `SELECT PP.OBJECT_NAME, PP.SUB_TYPE FROM SYSTEM_.SYS_PACKAGES_ P, SYSTEM_.SYS_USERS_ U, SYSTEM_.SYS_PACKAGE_PARAS_ PP `
      + `WHERE U.USER_NAME = '${s}' AND U.USER_ID = P.USER_ID `
      + `AND P.PACKAGE_OID = PP.PACKAGE_OID AND P.PACKAGE_NAME = '${p}' `
      + `AND (PP.PARA_ORDER = 0 OR PP.PARA_ORDER = 1) `
      + `ORDER BY PP.OBJECT_NAME`, 1000);
      const seen = new Set<string>();
      const out: { name: string; schema: string; package: string; type: 'PROCEDURE' | 'FUNCTION' }[] = [];
      for (const row of r.rows) {
        const nm = (row[0] || '').toString();
        if (!nm || seen.has(nm)) continue;
        seen.add(nm);
        const t = (row[1] || '').toString();
        out.push({ name: nm, schema: (schema || '').toUpperCase(), package: packageName, type: t === '1' ? 'FUNCTION' : 'PROCEDURE' });
      }
      return out;
    } catch { return []; }
  }

  // 패키지 상세 — properties + spec/body DDL.
  async packageDetail(name: string, schema?: string): Promise<{ properties: Record<string, string>; spec: string; body: string; routines: { name: string; schema: string; package: string; type: string }[] }> {
    const result = { properties: {} as Record<string, string>, spec: '', body: '', routines: [] as { name: string; schema: string; package: string; type: string }[] };
    if (this.type !== 'altibase' && this.type !== 'oracle') return result;
    const s = escapeStr((schema || this.dbms?.user || '').toUpperCase());
    const n = escapeStr(name.toUpperCase());
    // Properties
    if (this.type === 'altibase') {
      try {
        const r = await this.exec(
          `SELECT P.PACKAGE_NAME, P.PACKAGE_TYPE, P.AUTHID, P.STATUS FROM SYSTEM_.SYS_PACKAGES_ P, SYSTEM_.SYS_USERS_ U `
        + `WHERE U.USER_ID = P.USER_ID AND U.USER_NAME = '${s}' AND P.PACKAGE_NAME = '${n}' ORDER BY P.PACKAGE_TYPE`, 50);
        for (const row of r.rows) {
          const t = (row[1] || '').toString();
          result.properties['이름'] = (row[0] || '').toString();
          result.properties['AUTHID'] = (row[2] || '').toString();
          result.properties['상태(' + (t === '6' ? 'SPEC' : t === '7' ? 'BODY' : t) + ')'] = (row[3] || '').toString();
        }
      } catch {}
    }
    // DDL (spec / body) — DBMS_METADATA.GET_DDL
    try {
      const r = await this.exec(`SELECT DBMS_METADATA.GET_DDL('PACKAGE', '${n}', '${s}') FROM DUAL`, 1);
      result.spec = (r.rows[0]?.[0] || '').toString().trim();
    } catch {}
    try {
      const r = await this.exec(`SELECT DBMS_METADATA.GET_DDL('PACKAGE_BODY', '${n}', '${s}') FROM DUAL`, 1);
      result.body = (r.rows[0]?.[0] || '').toString().trim();
    } catch {}
    result.routines = await this.listPackageRoutines(name, schema);
    return result;
  }

  // 트리거 상세 — properties + DDL.
  async triggerDetail(name: string, schema?: string): Promise<{ properties: Record<string, string>; ddl: string }> {
    const result = { properties: {} as Record<string, string>, ddl: '' };
    if (this.type !== 'altibase' && this.type !== 'oracle') return result;
    const s = escapeStr((schema || this.dbms?.user || '').toUpperCase());
    // 트리거 노드는 "NAME (TABLE)" 형식으로 표시될 수 있어 ( 앞부분만 사용
    const rawName = name.includes(' (') ? name.split(' (')[0] : name;
    const n = escapeStr(rawName.toUpperCase());
    if (this.type === 'altibase') {
      try {
        const r = await this.exec(
          `SELECT TR.TRIGGER_NAME, T.TABLE_NAME, TR.IS_ENABLE, `
        + `CASE2(TR.EVENT_TIME = 1, 'BEFORE', TR.EVENT_TIME = 2, 'AFTER', TR.EVENT_TIME = 3, 'INSTEAD OF', 'Unknown') AS EVENT_TIME, `
        + `CASE2(TR.EVENT_TYPE = 1, 'INSERT', TR.EVENT_TYPE = 2, 'DELETE', TR.EVENT_TYPE = 4, 'UPDATE', 'Unknown') AS EVENT_TYPE, `
        + `CASE2(TR.GRANULARITY = 1, 'FOR EACH ROW', TR.GRANULARITY = 12, 'FOR EACH STATEMENT', 'Unknown') AS GRANULARITY `
        + `FROM SYSTEM_.SYS_TRIGGERS_ TR, SYSTEM_.SYS_TABLES_ T, SYSTEM_.SYS_USERS_ U `
        + `WHERE TR.TABLE_ID = T.TABLE_ID AND TR.USER_ID = T.USER_ID AND T.USER_ID = U.USER_ID `
        + `AND U.USER_NAME = '${s}' AND TR.TRIGGER_NAME = '${n}'`, 1);
        const row = r.rows[0];
        if (row) {
          result.properties['이름'] = (row[0] || '').toString();
          result.properties['대상 테이블'] = (row[1] || '').toString();
          result.properties['활성화'] = (row[2] || '').toString();
          result.properties['시점'] = (row[3] || '').toString();
          result.properties['이벤트'] = (row[4] || '').toString();
          result.properties['Granularity'] = (row[5] || '').toString();
        }
      } catch {}
    }
    // DDL
    try {
      const r = await this.exec(`SELECT DBMS_METADATA.GET_DDL('TRIGGER', '${n}', '${s}') FROM DUAL`, 1);
      result.ddl = (r.rows[0]?.[0] || '').toString().trim();
    } catch {}
    return result;
  }

  // 스키마 레벨 트리거 목록 — DBeaver prepareTableTriggersLoadStatement 패턴.
  // 표시: "TRIGGER_NAME (OWNER_TABLE)" — 트리거가 어떤 테이블에 붙어 있는지 함께.
  async listSchemaTriggers(schema?: string): Promise<string[]> {
    if (this.type !== 'altibase' && this.type !== 'oracle') return [];
    const s = escapeStr((schema || '').toUpperCase());
    let sql: string;
    if (this.type === 'altibase') {
      // SYS_TRIGGERS_ + SYS_TABLES_ join 으로 트리거-테이블 매핑.
      sql = `SELECT TR.TRIGGER_NAME || ' (' || T.TABLE_NAME || ')' FROM SYSTEM_.SYS_TRIGGERS_ TR, SYSTEM_.SYS_TABLES_ T, SYSTEM_.SYS_USERS_ U `
          + `WHERE TR.TABLE_ID = T.TABLE_ID AND TR.USER_ID = T.USER_ID AND T.USER_ID = U.USER_ID `
          + `AND U.USER_NAME = '${s}' ORDER BY TR.TRIGGER_NAME`;
    } else {
      sql = `SELECT TRIGGER_NAME || ' (' || TABLE_NAME || ')' FROM ALL_TRIGGERS WHERE OWNER = '${s}' ORDER BY TRIGGER_NAME`;
    }
    try {
      const r = await this.exec(sql, 5000);
      return r.rows.map(x => (x[0] || '').toString()).filter(Boolean);
    } catch { return []; }
  }

  // 테이블스페이스 상세 — DBeaver AltibaseTablespace 의 datafiles/tables/indexes 쿼리.
  // 데이터 파일은 SELECT * (DBeaver 와 동일) — 컬럼 구성이 dialect/버전마다 달라 동적 헤더 사용.
  async tablespaceDetail(name: string): Promise<{
    dataFileColumns: string[];
    dataFileRows: string[][];
    tables: { schema: string; table: string; partition: string }[];
    indexes: { schema: string; index: string; partition: string; tableSchema: string; table: string }[];
  }> {
    const result = { dataFileColumns: [] as string[], dataFileRows: [] as string[][], tables: [] as any[], indexes: [] as any[] };
    if (this.type !== 'altibase') return result;
    const tn = escapeStr(name.toUpperCase());
    // SPACE_ID 조회 — V$TABLESPACES.ID 가 표준이지만 SPACE_ID 도 시도
    let spaceId = -1;
    for (const idCol of ['ID', 'SPACE_ID']) {
      try {
        const r = await this.exec(`SELECT ${idCol} FROM V$TABLESPACES WHERE NAME = '${tn}'`, 1);
        if (r.rows.length > 0) {
          const v = parseInt((r.rows[0][0] || '-1').toString(), 10);
          if (!isNaN(v) && v >= 0) { spaceId = v; break; }
        }
      } catch {}
    }
    if (spaceId < 0) return result;
    // 데이터 파일 — Disk(V$DATAFILES). DBeaver 표시 컬럼만 화이트리스트로 추출.
    // DBeaver AltibaseTablespace 의 표시 헤더: Path/DataFile ID/Tablespace ID/Current Size/
    //   Next Size/Initial Size/Maximum Size/Auto Extended/State
    try {
      const r = await this.exec(`SELECT * FROM V$DATAFILES WHERE SPACEID = ${spaceId} ORDER BY NAME`, 1000);
      if (r.rows.length > 0) {
        // DBeaver AltibaseDataFile4Disk @Property 순서:
        //   Path(NAME), DataFile ID(ID), Tablespace ID(SPACEID), Current Size(CURRSIZE),
        //   Next Size(NEXTSIZE), Initital Size(INITSIZE), Maximum Size(MAXSIZE),
        //   Auto Extended(AUTOEXTEND), State(STATE)
        type Kind = 'raw' | 'size' | 'autoExt' | 'state';
        const wanted: { match: RegExp; label: string; kind: Kind }[] = [
          { match: /^NAME$/,                                    label: 'Path',           kind: 'raw' },
          { match: /^(DATAFILE_?ID|ID)$/,                       label: 'DataFile ID',    kind: 'raw' },
          { match: /^(SPACEID|SPACE_ID|TABLESPACE_ID)$/,        label: 'Tablespace ID',  kind: 'raw' },
          { match: /^(CURRSIZE|CURRENT_?SIZE|CURRENTSIZE)$/,    label: 'Current Size',   kind: 'size' },
          { match: /^(NEXTSIZE|NEXT_?SIZE)$/,                   label: 'Next Size',      kind: 'size' },
          { match: /^(INITSIZE|INIT(?:IAL)?_?SIZE)$/,           label: 'Initital Size',  kind: 'size' },
          { match: /^(MAXSIZE|MAX(?:IMUM)?_?SIZE)$/,            label: 'Maximum Size',   kind: 'size' },
          { match: /^(AUTOEXTEND|AUTOEXTEND_?MODE|AUTO_?EXTEND(?:ED)?)$/, label: 'Auto Extended', kind: 'autoExt' },
          { match: /^STATE$/,                                    label: 'State',          kind: 'state' },
        ];
        const srcCols = (r.columns || []).map(c => (c || '').toString().toUpperCase());
        const picked: { srcIdx: number; label: string; kind: Kind }[] = [];
        for (const w of wanted) {
          const idx = srcCols.findIndex(c => w.match.test(c));
          if (idx >= 0) picked.push({ srcIdx: idx, label: w.label, kind: w.kind });
        }
        // 페이지 크기 — Altibase 기본 디스크 페이지 = 8KB
        const PAGE_SIZE = 8192;
        if (picked.length > 0) {
          result.dataFileColumns = picked.map(p => p.label);
          result.dataFileRows = r.rows.map(row => picked.map(p => {
            const raw = (row[p.srcIdx] || '').toString();
            if (p.kind === 'size') return formatBytes((parseFloat(raw) || 0) * PAGE_SIZE);
            if (p.kind === 'autoExt') return raw === '1' ? '[ ✓ ]' : '[   ]';
            if (p.kind === 'state') return mapDatafileState(raw);
            return raw;
          }));
        } else {
          result.dataFileColumns = (r.columns || []).map(c => c);
          result.dataFileRows = r.rows;
        }
      }
    } catch {}
    if (result.dataFileRows.length === 0) {
      // 메모리 테이블스페이스 — DBeaver AltibaseTablespace 의 원본 쿼리.
      try {
        const r = await this.exec(
          `SELECT mt.ID ID, p.CHECKPOINT_PATH || '/' || mt.DBFILE_NAME AS NAME, mt.CURRENT_SIZE, mt.DBFILE_SIZE `
        + `FROM (SELECT 0 ID, SPACE_NAME || '-0-0' AS DBFILE_NAME, SPACE_ID, CURRENT_SIZE, DBFILE_SIZE FROM V$MEM_TABLESPACES `
        + ` UNION ALL `
        + ` SELECT 1 ID, SPACE_NAME || '-1-0' AS DBFILE_NAME, SPACE_ID, CURRENT_SIZE, DBFILE_SIZE FROM V$MEM_TABLESPACES) mt, `
        + `V$MEM_TABLESPACE_CHECKPOINT_PATHS p `
        + `WHERE p.SPACE_ID = mt.SPACE_ID AND mt.SPACE_ID = ${spaceId} ORDER BY mt.ID`, 1000);
        if (r.rows.length > 0) {
          result.dataFileColumns = ['ID', 'Path', 'Current Size', 'DBFile Size'];
          result.dataFileRows = r.rows;
        }
      } catch {}
      if (result.dataFileRows.length === 0) {
        try {
          const r = await this.exec(`SELECT * FROM V$MEM_TABLESPACES WHERE SPACE_ID = ${spaceId}`, 100);
          if (r.rows.length > 0) {
            result.dataFileColumns = (r.columns || []).map(c => mapDataFileHeader(c));
            result.dataFileRows = r.rows;
          }
        } catch {}
      }
    }
    // 테이블 (DBeaver AltibaseTablespace 쿼리 그대로)
    try {
      const r = await this.exec(
        `SELECT U.USER_NAME, T.TABLE_NAME, NULL FROM SYSTEM_.SYS_USERS_ U, SYSTEM_.SYS_TABLES_ T `
      + `WHERE U.USER_ID = T.USER_ID AND (T.TABLE_TYPE = 'T' OR T.TABLE_TYPE = 'Q') AND T.IS_PARTITIONED = 'F' AND T.TBS_ID = ${spaceId} `
      + `UNION ALL `
      + `SELECT U.USER_NAME, T.TABLE_NAME, TP.PARTITION_NAME FROM SYSTEM_.SYS_USERS_ U, SYSTEM_.SYS_TABLES_ T, SYSTEM_.SYS_TABLE_PARTITIONS_ TP `
      + `WHERE U.USER_ID = T.USER_ID AND (T.TABLE_TYPE = 'T' OR T.TABLE_TYPE = 'Q') AND T.IS_PARTITIONED = 'T' AND T.TABLE_ID = TP.TABLE_ID AND TP.TBS_ID = ${spaceId} `
      + `ORDER BY 1, 2, 3`, 5000);
      for (const row of r.rows) {
        result.tables.push({ schema: (row[0] || '').toString(), table: (row[1] || '').toString(), partition: (row[2] || '').toString() });
      }
    } catch {}
    // 인덱스 (DBeaver 쿼리 그대로)
    try {
      const r = await this.exec(
        `SELECT U.USER_NAME, I.INDEX_NAME, NULL, UT.USER_NAME, T.TABLE_NAME `
      + `FROM SYSTEM_.SYS_USERS_ U, SYSTEM_.SYS_INDICES_ I, SYSTEM_.SYS_USERS_ UT, SYSTEM_.SYS_TABLES_ T `
      + `WHERE U.USER_ID = I.USER_ID AND I.IS_PARTITIONED = 'F' AND I.TABLE_ID = T.TABLE_ID AND UT.USER_ID = T.USER_ID AND I.TBS_ID = ${spaceId} `
      + `UNION ALL `
      + `SELECT U.USER_NAME, I.INDEX_NAME, IP.INDEX_PARTITION_NAME, UT.USER_NAME, T.TABLE_NAME `
      + `FROM SYSTEM_.SYS_USERS_ U, SYSTEM_.SYS_INDICES_ I, SYSTEM_.SYS_INDEX_PARTITIONS_ IP, SYSTEM_.SYS_USERS_ UT, SYSTEM_.SYS_TABLES_ T `
      + `WHERE U.USER_ID = IP.USER_ID AND I.INDEX_ID = IP.INDEX_ID AND I.IS_PARTITIONED = 'T' AND I.TABLE_ID = T.TABLE_ID AND UT.USER_ID = T.USER_ID AND IP.TBS_ID = ${spaceId} `
      + `ORDER BY 1, 2, 3`, 5000);
      for (const row of r.rows) {
        result.indexes.push({ schema: (row[0] || '').toString(), index: (row[1] || '').toString(), partition: (row[2] || '').toString(), tableSchema: (row[3] || '').toString(), table: (row[4] || '').toString() });
      }
    } catch {}
    return result;
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
