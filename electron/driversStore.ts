// electron/driversStore.ts
//
// JDBC driver definitions store (DBeaver-style Driver Manager backend).
//
// Built-in driver definitions are hardcoded here and always present in the
// returned list. User-added/customised drivers are persisted to
// `<userData>/drivers.json` and merged on top. A driver's `jars` entries may
// reference `${bundled}` which resolves to:
//   - production: <resourcesPath>/jdbc-drivers/bundled
//   - dev:        <repo>/resources/jdbc-drivers/bundled
//
// `${userJdbc}` resolves to <userData>/jdbc-drivers (user-supplied JARs).

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

export type JdbcDialect =
  | 'altibase' | 'mysql' | 'postgres' | 'oracle' | 'mssql' | 'sqlite' | 'generic';

export interface JdbcDriverDef {
  id: string;
  name: string;
  className: string;
  // URL template — placeholders {host} {port} {database} replaced by SessionEditor.
  urlTemplate: string;
  defaultPort: number;
  // JAR paths. May contain `${bundled}` or `${userJdbc}` tokens or absolute paths.
  jars: string[];
  builtin: boolean;
  dialect: JdbcDialect;
  // Optional notes shown in the UI.
  note?: string;
}

const BUILTIN_DRIVERS: JdbcDriverDef[] = [
  {
    id: 'postgres-builtin',
    name: 'PostgreSQL',
    className: 'org.postgresql.Driver',
    urlTemplate: 'jdbc:postgresql://{host}:{port}/{database}',
    defaultPort: 5432,
    jars: ['${bundled}/postgresql.jar'],
    builtin: true,
    dialect: 'postgres',
  },
  {
    id: 'mariadb-builtin',
    name: 'MySQL / MariaDB',
    className: 'org.mariadb.jdbc.Driver',
    urlTemplate: 'jdbc:mariadb://{host}:{port}/{database}',
    defaultPort: 3306,
    jars: ['${bundled}/mariadb.jar'],
    builtin: true,
    dialect: 'mysql',
    note: 'MariaDB Connector/J — MySQL 프로토콜과 호환됩니다.',
  },
  {
    id: 'mssql-builtin',
    name: 'Microsoft SQL Server',
    className: 'com.microsoft.sqlserver.jdbc.SQLServerDriver',
    urlTemplate: 'jdbc:sqlserver://{host}:{port};databaseName={database};encrypt=true;trustServerCertificate=true',
    defaultPort: 1433,
    jars: ['${bundled}/mssql.jar'],
    builtin: true,
    dialect: 'mssql',
  },
  {
    id: 'sqlite-builtin',
    name: 'SQLite',
    className: 'org.sqlite.JDBC',
    urlTemplate: 'jdbc:sqlite:{database}',
    defaultPort: 0,
    jars: ['${bundled}/sqlite.jar'],
    builtin: true,
    dialect: 'sqlite',
    note: 'database = 로컬 .db 파일 경로',
  },
  {
    id: 'altibase-builtin',
    name: 'Altibase',
    className: 'Altibase.jdbc.driver.AltibaseDriver',
    urlTemplate: 'jdbc:Altibase://{host}:{port}/{database}',
    defaultPort: 20300,
    jars: ['${bundled}/altibase.jar'],
    builtin: true,
    dialect: 'altibase',
    note: '라이선스 사정으로 JAR 자동 번들 제외 — Altibase JDBC 를 ${bundled}/altibase.jar 또는 ${userJdbc}/ 에 복사하세요.',
  },
  {
    id: 'oracle-template',
    name: 'Oracle',
    className: 'oracle.jdbc.OracleDriver',
    urlTemplate: 'jdbc:oracle:thin:@{host}:{port}/{database}',
    defaultPort: 1521,
    jars: ['${userJdbc}/ojdbc11.jar'],
    builtin: true,
    dialect: 'oracle',
    note: 'Oracle OTN 라이선스로 번들 제외 — 오라클 사이트에서 ojdbc11.jar 를 받아 ${userJdbc}/ 에 복사하세요.',
  },
];

function driversJsonPath(): string {
  return path.join(app.getPath('userData'), 'drivers.json');
}

export function getBundledDriversRoot(): string {
  if (app.isPackaged && process.resourcesPath) {
    return path.join(process.resourcesPath, 'jdbc-drivers', 'bundled');
  }
  return path.resolve(__dirname, '..', 'resources', 'jdbc-drivers', 'bundled');
}

export function getUserJdbcDriversRoot(): string {
  const root = path.join(app.getPath('userData'), 'jdbc-drivers');
  try { fs.mkdirSync(root, { recursive: true }); } catch {}
  return root;
}

export function resolveDriverJars(jars: string[]): string[] {
  const bundled = getBundledDriversRoot();
  const userJdbc = getUserJdbcDriversRoot();
  return jars.map(j =>
    j.replace('${bundled}', bundled).replace('${userJdbc}', userJdbc));
}

/** Existing JAR paths (after token resolve) — used by the sidecar to load classes. */
export function resolveDriverJarsExisting(jars: string[]): string[] {
  return resolveDriverJars(jars).filter(p => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  });
}

function readUserDrivers(): JdbcDriverDef[] {
  try {
    const p = driversJsonPath();
    if (!fs.existsSync(p)) return [];
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw.filter((d: any) => d && typeof d.id === 'string').map((d: any) => ({
      id: d.id,
      name: typeof d.name === 'string' ? d.name : d.id,
      className: typeof d.className === 'string' ? d.className : '',
      urlTemplate: typeof d.urlTemplate === 'string' ? d.urlTemplate : '',
      defaultPort: typeof d.defaultPort === 'number' ? d.defaultPort : 0,
      jars: Array.isArray(d.jars) ? d.jars.filter((j: any) => typeof j === 'string') : [],
      builtin: false,
      dialect: typeof d.dialect === 'string' ? d.dialect : 'generic',
      note: typeof d.note === 'string' ? d.note : undefined,
    } as JdbcDriverDef));
  } catch { return []; }
}

function writeUserDrivers(list: JdbcDriverDef[]) {
  const p = driversJsonPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const userOnly = list.filter(d => !d.builtin).map(d => ({
    id: d.id,
    name: d.name,
    className: d.className,
    urlTemplate: d.urlTemplate,
    defaultPort: d.defaultPort,
    jars: d.jars,
    dialect: d.dialect,
    note: d.note,
  }));
  fs.writeFileSync(p, JSON.stringify(userOnly, null, 2), 'utf8');
}

/**
 * Returns merged list: built-in drivers + user-added/customised drivers.
 *
 * A user driver may "override" a built-in by reusing its id; in that case
 * the user copy replaces the built-in in the result, but `builtin` stays
 * true on the original definition so the UI can show "based on builtin".
 * For E-3.2 we keep it simple: user drivers always come after built-ins;
 * id collision → user wins.
 */
export function listDrivers(): JdbcDriverDef[] {
  const out = new Map<string, JdbcDriverDef>();
  for (const d of BUILTIN_DRIVERS) out.set(d.id, { ...d });
  for (const d of readUserDrivers()) out.set(d.id, { ...d, builtin: false });
  return Array.from(out.values());
}

export function upsertUserDriver(def: JdbcDriverDef): JdbcDriverDef[] {
  const list = readUserDrivers();
  const i = list.findIndex(d => d.id === def.id);
  if (i >= 0) list[i] = { ...def, builtin: false };
  else list.push({ ...def, builtin: false });
  writeUserDrivers(list);
  return listDrivers();
}

export function removeUserDriver(id: string): JdbcDriverDef[] {
  const list = readUserDrivers().filter(d => d.id !== id);
  writeUserDrivers(list);
  return listDrivers();
}

/** Diagnostic — used by Driver Manager UI to show "missing JAR" warnings. */
export function diagnoseDriver(def: JdbcDriverDef) {
  const resolved = resolveDriverJars(def.jars);
  const existing = resolved.filter(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  const missing = resolved.filter(p => !existing.includes(p));
  return { resolved, existing, missing, usable: existing.length > 0 && missing.length === 0 };
}
