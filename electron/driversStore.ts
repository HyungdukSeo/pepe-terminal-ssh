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

// DBeaver 기본 드라이버 라이브러리 = Maven Central artifact 좌표. 사용자가 Driver Manager 에서
// "Download / Update" 누르면 사이드카 호출 전 자동 다운로드. 기존 번들 .jar 가 있어도 우선 사용 가능.
const BUILTIN_DRIVERS: JdbcDriverDef[] = [
  {
    id: 'postgres-builtin',
    name: 'PostgreSQL',
    className: 'org.postgresql.Driver',
    urlTemplate: 'jdbc:postgresql://{host}:{port}/{database}',
    defaultPort: 5432,
    // DBeaver 기본 라이브러리 셋 — 메인 드라이버 + postgis 확장 + waffle-jna (Windows SSO)
    jars: [
      'maven:org.postgresql:postgresql:42.7.4',
      'maven:net.postgis:postgis-jdbc:2024.1.0',
      'maven:net.postgis:postgis-geometry:2024.1.0',
      'maven:com.github.waffle:waffle-jna:3.5.1',
    ],
    builtin: true,
    dialect: 'postgres',
  },
  {
    id: 'mariadb-builtin',
    name: 'MySQL / MariaDB',
    className: 'org.mariadb.jdbc.Driver',
    urlTemplate: 'jdbc:mariadb://{host}:{port}/{database}',
    defaultPort: 3306,
    jars: [
      'maven:org.mariadb.jdbc:mariadb-java-client:3.5.2',
    ],
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
    // DBeaver 기본 라이브러리 셋 — 메인 드라이버 + Windows 통합 인증.
    //   jre11 변형 대신 jre8 변형 사용 (사이드카 JVM Java 8 호환).
    //   mssql-jdbc_auth 는 Maven 에서 packaging=dll, version=<ver>.x64 형식 (네이티브 라이브러리).
    //   → 좌표 @dll 로 확장자 지정. (classpath 에는 안 들어가고 java.library.path 용)
    jars: [
      'maven:com.microsoft.sqlserver:mssql-jdbc:12.8.1.jre8',
      'maven:com.microsoft.sqlserver:mssql-jdbc_auth:12.8.1.x64@dll',
    ],
    builtin: true,
    dialect: 'mssql',
  },
  {
    id: 'sqlite-builtin',
    name: 'SQLite',
    className: 'org.sqlite.JDBC',
    urlTemplate: 'jdbc:sqlite:{database}',
    defaultPort: 0,
    // sqlite-jdbc 3.45+ 는 slf4j-api 를 transitive 로 요구 (없으면 NoClassDefFoundError: org/slf4j/LoggerFactory)
    jars: [
      'maven:org.xerial:sqlite-jdbc:3.46.1.0',
      'maven:org.slf4j:slf4j-api:2.0.13',
    ],
    builtin: true,
    dialect: 'sqlite',
    note: 'database = 로컬 .db 파일 경로. slf4j-api 가 함께 필요합니다.',
  },
  {
    id: 'altibase-builtin',
    name: 'Altibase 7.x',
    className: 'Altibase.jdbc.driver.AltibaseDriver',
    urlTemplate: 'jdbc:Altibase://{host}:{port}/{database}',
    defaultPort: 20300,
    // Altibase 는 Maven Central 에 미러링됨 (com.altibase:altibase-jdbc)
    jars: [
      'maven:com.altibase:altibase-jdbc:7.1.0.9.0',
    ],
    builtin: true,
    dialect: 'altibase',
    note: 'Maven Central 의 com.altibase:altibase-jdbc 자동 다운로드 (또는 번들/사용자 폴더 jar 사용).',
  },
  {
    id: 'altibase-6-builtin',
    name: 'Altibase 6.x',
    className: 'Altibase.jdbc.driver.AltibaseDriver',
    urlTemplate: 'jdbc:Altibase://{host}:{port}/{database}',
    defaultPort: 20300,
    jars: [
      '${bundled}/altibase-6.jar',
    ],
    builtin: true,
    dialect: 'altibase',
    note: '기본 번들 Altibase 6.x JDBC 드라이버(Altibase.jar). Altibase 6.x 서버 접속용.',
  },
  {
    id: 'oracle-template',
    name: 'Oracle',
    className: 'oracle.jdbc.OracleDriver',
    urlTemplate: 'jdbc:oracle:thin:@{host}:{port}/{database}',
    defaultPort: 1521,
    // DBeaver 기본 라이브러리 셋 — ojdbc + 부속(NLS, XDB, XML Parser).
    //   주의: ojdbc11(JDK 11+) 대신 ojdbc8(JDK 8+) 사용 — 사이드카 JVM 호환.
    jars: [
      'maven:com.oracle.database.jdbc:ojdbc8:23.5.0.24.07',
      'maven:com.oracle.database.nls:orai18n:23.5.0.24.07',
      'maven:com.oracle.database.xml:xdb:23.5.0.24.07',
      'maven:com.oracle.database.xml:xmlparserv2:23.5.0.24.07',
    ],
    builtin: true,
    dialect: 'oracle',
    note: 'Maven Central 의 com.oracle.database.jdbc:ojdbc8 자동 다운로드 (사이드카 JVM(Java 8) 호환). 23c 기준.',
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

/**
 * Maven 좌표 파싱 — DBeaver 의 Maven dependency 표기와 호환.
 *   maven:groupId:artifactId:version
 *   maven:groupId:artifactId:version:classifier            (예: sources)
 *   maven:groupId:artifactId:version@ext                   (packaging type 지정 — 예: dll)
 *   maven:groupId:artifactId:version:classifier@ext
 * Maven Central 파일명 규칙: {artifactId}-{version}[-{classifier}].{ext}
 *   (ext 기본값 = jar. mssql-jdbc_auth 처럼 네이티브 라이브러리는 ext=dll)
 */
export function parseMavenCoord(coord: string): { groupId: string; artifactId: string; version: string; classifier: string; ext: string; fileName: string } | null {
  if (!coord.startsWith('maven:')) return null;
  let body = coord.slice('maven:'.length);
  // @ext 접미사 분리 (확장자/패키징 타입)
  let ext = 'jar';
  const atIdx = body.lastIndexOf('@');
  if (atIdx >= 0) { ext = body.slice(atIdx + 1) || 'jar'; body = body.slice(0, atIdx); }
  const parts = body.split(':');
  if (parts.length < 3) return null;
  const [groupId, artifactId, version] = parts;
  const classifier = parts.length >= 4 ? parts[3] : '';
  const fileName = `${artifactId}-${version}${classifier ? '-' + classifier : ''}.${ext}`;
  return { groupId, artifactId, version, classifier, ext, fileName };
}
/** Maven 좌표 → 로컬 캐시 경로 (`${userJdbc}/{fileName}`). */
export function mavenCoordToCachedPath(coord: string): string | null {
  const p = parseMavenCoord(coord);
  if (!p) return null;
  return path.join(getUserJdbcDriversRoot(), p.fileName);
}
/** Maven 좌표 → Maven Central 다운로드 URL. */
export function mavenCoordToUrl(coord: string): string | null {
  const p = parseMavenCoord(coord);
  if (!p) return null;
  return `https://repo1.maven.org/maven2/${p.groupId.replace(/\./g, '/')}/${p.artifactId}/${p.version}/${p.fileName}`;
}
export function resolveDriverJars(jars: string[]): string[] {
  const bundled = getBundledDriversRoot();
  const userJdbc = getUserJdbcDriversRoot();
  return jars.map(j => {
    // Maven 좌표면 user JAR 캐시 경로로 변환
    const mvn = mavenCoordToCachedPath(j);
    if (mvn) return mvn;
    return j.replace('${bundled}', bundled).replace('${userJdbc}', userJdbc);
  });
}

/** Existing classpath JAR paths — 사이드카 URLClassLoader 용. .jar 만 포함(.dll 등 네이티브 라이브러리는 제외). */
export function resolveDriverJarsExisting(jars: string[]): string[] {
  return resolveDriverJars(jars).filter(p => {
    try {
      if (!fs.statSync(p).isFile()) return false;
      // .dll/.so/.dylib 같은 네이티브 라이브러리는 URLClassLoader 에 넣으면 안 됨 (classpath 는 .jar/.zip 만).
      return /\.(jar|zip)$/i.test(p);
    } catch { return false; }
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
      properties: d.properties && typeof d.properties === 'object' ? d.properties : undefined,
      meta: d.meta && typeof d.meta === 'object' ? d.meta : undefined,
    } as any as JdbcDriverDef));
  } catch { return []; }
}

function writeUserDrivers(list: JdbcDriverDef[]) {
  const p = driversJsonPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const userOnly = list.filter(d => !d.builtin).map((d: any) => ({
    id: d.id,
    name: d.name,
    className: d.className,
    urlTemplate: d.urlTemplate,
    defaultPort: d.defaultPort,
    jars: d.jars,
    dialect: d.dialect,
    note: d.note,
    properties: d.properties,
    meta: d.meta,
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
