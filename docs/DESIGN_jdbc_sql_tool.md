# SQL Tool — JDBC 기반 다중 DBMS 지원 설계

> 목표: 현재 SSH+CLI(isql) 파이프 방식을 폐기하고 DBeaver 와 동일한 모델로 전환.
> JVM 사이드카 + JDBC 드라이버 JAR 로 모든 DBMS 통합 지원.

---

## 1. 아키텍처 개요

```
┌─────────────────────────────────────────────────────────────────────┐
│  Renderer (React)                                                   │
│  ┌─────────────────────────────┐    ┌──────────────────────────────┐│
│  │ SqlToolWorkspace            │    │ Driver Manager (모달)         ││
│  │  - Monaco 에디터            │    │  - 등록된 드라이버 목록       ││
│  │  - 결과 그리드 / 스냅샷 탭  │    │  - JAR/Class/URL 템플릿 편집  ││
│  │  - 스키마 트리              │    └──────────────────────────────┘│
│  │  - PK 편집 / 트랜잭션       │    ┌──────────────────────────────┐│
│  │  - jdbcDriver (DbmsDriver)  │    │ SessionEditor DBMS 탭         ││
│  └────────────┬────────────────┘    │  - 드라이버 선택              ││
│               │ window.api.jdbc.*   │  - 직접 TCP / SSH 터널 모드   ││
└───────────────┼──────────────────────│  - URL 자동 합성              ││
                │                     └──────────────────────────────┘│
└────────────── │ IPC (Electron contextBridge) ─────────────────────── ┘
                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Electron Main (Node.js)                                            │
│  - jdbcBridge.ts                                                    │
│    - 세션별 사이드카 JVM 프로세스 매니저                            │
│    - JSON-RPC over stdin/stdout                                     │
│    - 드라이버 등록 정보(JSON) 영속화                                │
│    - SSH 터널 포트 포워드(ssh2.forwardOut)                          │
└────────────────────────┬────────────────────────────────────────────┘
                         │ child_process.spawn(java, jvmArgs)
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Java Sidecar (resources/jdbc-sidecar/pepe-jdbc.jar)                │
│  - JSON-RPC 루프 (stdin/stdout, line-delimited)                     │
│  - URLClassLoader 로 JDBC JAR 동적 로드                             │
│  - java.sql.Driver / DriverManager 로 연결                          │
│  - PreparedStatement / Statement 실행                               │
│  - ResultSet 직렬화 (columns + rows 청크)                           │
└─────────────────────────────────────────────────────────────────────┘
                         ▲
                         │ -Djava.class.path=<jdbc jars>
                         │
┌─────────────────────────────────────────────────────────────────────┐
│  Bundled JRE (Eclipse Adoptium Temurin 21 LTS)                      │
│  resources/jre/{win,mac,linux}/                                     │
│  - 압축 ~50MB, 압축 해제 ~150MB                                     │
└─────────────────────────────────────────────────────────────────────┘
```

세션 하나당 사이드카 JVM 하나(가벼움/격리/실패 격리). 풀링은 추후 H 단계에서.

---

## 2. JRE 번들링 전략

### 선택
- **Eclipse Adoptium Temurin 21 LTS** (이전 명칭 AdoptOpenJDK).
- jdk **JRE** 만 (JDK 아님) — 압축 해제 후 ~150MB.

### 디렉토리
```
resources/
  jre/
    win-x64/        (Windows 빌드에만 포함)
    win-arm64/      (선택)
    mac-x64/        (mac dmg-x64 에 포함)
    mac-arm64/      (mac dmg-arm64 에 포함)
    linux-x64/      (선택, AppImage 등 추가 시)
```

### electron-builder 설정
```json
{
  "win":   { "extraResources": [{ "from": "resources/jre/win-x64",   "to": "jre" }] },
  "mac":   { "extraResources": [{ "from": "resources/jre/mac-${arch}", "to": "jre" }] },
  "linux": { "extraResources": [{ "from": "resources/jre/linux-x64", "to": "jre" }] }
}
```

런타임 위치:
- Windows: `process.resourcesPath/jre/bin/java.exe`
- macOS:   `process.resourcesPath/jre/Contents/Home/bin/java`
- Linux:   `process.resourcesPath/jre/bin/java`

dev 모드: `JAVA_HOME` 환경변수 또는 `which java` 폴백.

### 빌드 스크립트
`scripts/download-jre.js`:
- 첫 빌드 시 Adoptium API 에서 플랫폼별 zip 다운로드 → `resources/jre/<plat>/` 압축 해제.
- `npm run build` 의 사전 단계로 실행.
- 캐시 (이미 있으면 스킵).

번들 사이즈 증가:
- Windows installer: 기존 ~95MB → ~245MB 예상.

---

## 3. JDBC JAR 레이아웃

### 기본 번들 드라이버
| DBMS | JAR | 라이선스 |
|---|---|---|
| PostgreSQL | postgresql-42.x.jar | BSD-2 |
| MySQL / MariaDB | mariadb-java-client-3.x.jar | LGPL-2.1 |
| MS SQL Server | mssql-jdbc-12.x.jar | MIT |
| SQLite | sqlite-jdbc-3.x.jar | Apache 2.0 |
| Altibase | Altibase-1.0-RC8.jar 등 | (Altibase 라이선스, 재배포 권한 확인 필요) |
| Oracle | (번들 제외) | OTN |

### 디렉토리
```
resources/
  jdbc-sidecar/
    pepe-jdbc.jar          (사이드카 본체)
  jdbc-drivers/
    bundled/
      postgresql.jar
      mariadb.jar
      mssql.jar
      sqlite.jar
      altibase.jar
  
~/.pepe-terminal/
  jdbc-drivers/
    user/                   (사용자가 추가한 JAR)
  drivers.json              (사용자 드라이버 정의)
```

`drivers.json` (예):
```json
[
  {
    "id": "altibase-builtin",
    "name": "Altibase",
    "className": "Altibase.jdbc.driver.AltibaseDriver",
    "urlTemplate": "jdbc:Altibase://{host}:{port}/{database}",
    "defaultPort": 20300,
    "jars": ["${bundled}/altibase.jar"],
    "builtin": true,
    "dialect": "altibase"
  },
  ...
]
```

`${bundled}` 는 `resources/jdbc-drivers/bundled/` 로 치환.

---

## 4. Java 사이드카

### 프로젝트
```
java-sidecar/
  src/main/java/com/pepe/jdbc/
    Main.java
    Bridge.java
    Connection.java
    QueryResult.java
    JsonRpc.java
  build.gradle (또는 pom.xml)
```

### 의존성
- Jackson (JSON) 또는 minimal-json (가벼움)
- 표준 JDK java.sql

### 메인 루프 (의사 코드)
```java
public class Main {
  public static void main(String[] args) throws Exception {
    Bridge bridge = new Bridge();
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in, UTF_8));
    PrintWriter out = new PrintWriter(new OutputStreamWriter(System.out, UTF_8), true);
    String line;
    while ((line = in.readLine()) != null) {
      JsonObject req = parse(line);
      JsonObject resp = bridge.handle(req);
      out.println(resp.toString());
    }
  }
}
```

### IPC 프로토콜 (JSON-RPC, line-delimited)

요청:
```json
{ "id": 17, "method": "exec", "params": { "connectionId": "c1", "sql": "SELECT 1" } }
```

응답:
```json
{ "id": 17, "result": { "columns": ["1"], "rows": [["1"]], "rowsAffected": 0 } }
```

또는:
```json
{ "id": 17, "error": { "code": "SQL_ERROR", "message": "...", "sqlState": "42000", "vendorCode": -1 } }
```

서버 → 클라이언트 알림 (선택):
```json
{ "method": "stream", "params": { "connectionId": "c1", "queryId": "q1", "rowsChunk": [[...]] } }
```

### 메서드

| method | params | result |
|---|---|---|
| `ping` | – | `{ ok: true, version }` |
| `loadDriver` | `{ driverId, className, jars: [absPaths] }` | `{ ok: true }` |
| `connect` | `{ connectionId, driverId, url, user, password, props? }` | `{ ok: true, dbInfo }` |
| `disconnect` | `{ connectionId }` | `{ ok: true }` |
| `exec` | `{ connectionId, sql, fetchSize?, maxRows? }` | `{ columns, rows, rowsAffected, types? }` |
| `prepareExec` | `{ connectionId, sql, params: [...] }` | (같음, PreparedStatement 사용) |
| `meta.tables` | `{ connectionId, schema?, types? }` | `{ rows: [{name, type, schema}] }` |
| `meta.columns` | `{ connectionId, schema?, table }` | `{ rows: [{name, dataType, typeName, nullable, ...}] }` |
| `meta.primaryKeys` | `{ connectionId, table }` | `{ cols: [...] }` |
| `cancel` | `{ connectionId, queryId? }` | `{ ok }` |
| `tx.begin` | `{ connectionId }` | `{ ok }` |
| `tx.commit` | `{ connectionId }` | `{ ok }` |
| `tx.rollback` | `{ connectionId }` | `{ ok }` |

### 결과 크기 정책
- 한 호출당 `maxRows` (기본 5,000) 제한.
- 초과 시 `{ truncated: true, total: N? }` 표시.
- 큰 결과는 추후 `fetch` 페이지네이션 method 로 확장.

### 에러 코드
| code | 의미 |
|---|---|
| `SQL_ERROR` | java.sql.SQLException |
| `DRIVER_NOT_FOUND` | URLClassLoader 로 Class.forName 실패 |
| `INVALID_PARAMS` | 메서드 파라미터 누락/타입 오류 |
| `CONNECTION_NOT_FOUND` | connectionId 미등록 |
| `INTERNAL` | 그 외 |

---

## 5. 사이드카 생명주기 (main 프로세스)

`electron/jdbcBridge.ts`:
- `getSidecar(sessionId): Promise<Sidecar>` — 없으면 spawn.
- `Sidecar` 객체:
  - `proc: ChildProcess`
  - `pendingRequests: Map<id, {resolve, reject, timer}>`
  - `nextId: number`
  - 라인 reader (Stream.split('\n'))
  - `call(method, params, timeoutMs?): Promise<any>`
  - `close()`
- 세션 종료 시 disconnect → kill.
- 30분 유휴 시 자동 종료 (옵션).

JVM 메모리: `-Xms64m -Xmx512m`.

`-Djava.system.class.loader` 또는 URLClassLoader 동적 로드.

---

## 6. SSH 터널 통합

세션이 `useSshTunnel: true` 면:
- SSH bridge 의 `forwardOut(localHost='127.0.0.1', localPort=ephemeral, dstHost=dbHost, dstPort=dbPort)` 사용.
- 그 결과 로컬 포트를 JDBC URL 에 사용:
  - `jdbc:postgresql://127.0.0.1:<ephemeral>/db`
- SSH 세션 종료 시 터널 정리.

직접 TCP 모드는 사용자가 입력한 host:port 그대로.

---

## 7. Driver Manager (UI)

### 데이터 모델
```ts
interface JdbcDriverDef {
  id: string;
  name: string;
  className: string;
  urlTemplate: string;   // 예: jdbc:postgresql://{host}:{port}/{database}
  defaultPort: number;
  jars: string[];        // ${bundled} 또는 절대경로
  builtin: boolean;
  dialect: 'altibase' | 'mysql' | 'postgres' | 'mssql' | 'sqlite' | 'oracle' | 'generic';
}
```

### UI 와이어프레임
```
┌─ 드라이버 관리자 ──────────────────────────────────────[×]──┐
│ ┌─ 등록된 드라이버 ──────┐  ┌─ 상세 ─────────────────────┐ │
│ │ ✓ Altibase (기본)      │  │ 이름:       [Altibase     ] │ │
│ │ ✓ PostgreSQL (기본)    │  │ 클래스명:   [Altibase.jdbc..] │ │
│ │ ✓ MySQL/Maria (기본)   │  │ URL 템플릿: [jdbc:Altibase..] │ │
│ │ ✓ MS SQL Server        │  │ 기본 포트:  [20300        ] │ │
│ │ ✓ SQLite               │  │ JAR 파일:                    │ │
│ │ ─ Oracle (라이선스)    │  │  - ${bundled}/altibase.jar   │ │
│ │ ─ MyCustomDriver       │  │  - /path/user-altibase.jar   │ │
│ └─────────────────────── ┘  │ [+ JAR 추가] [JAR 제거]      │ │
│ [+ 드라이버 추가]            │ [테스트 연결]                │ │
│ [- 드라이버 제거]            └──────────────────────────────┘ │
│                              [닫기] [저장]                    │
└──────────────────────────────────────────────────────────────┘
```

빌트인 드라이버는 삭제 불가, 이름/JAR 만 추가 편집 가능.

---

## 8. SessionEditor DBMS 탭 재설계

```
[v] SQL Tool 활성화
드라이버:          [Altibase ▼] [드라이버 관리자...]
연결 방식:         ( ) 직접 TCP   ( ) SSH 터널 경유  (현재 SSH 세션이면 후자 기본)
호스트:            [127.0.0.1                ]
포트:              [20300                    ]
데이터베이스:      [mydb                     ]   (드라이버에 따라 옵션)
사용자:            [ipageon                  ]
비밀번호:          [********  ] [👁]
JDBC URL (자동):   [jdbc:Altibase://127.0.0.1:20300/mydb ]
                   [▸ 직접 입력]                              ← 확장 시 자유 편집
연결 속성(추가):   key=value 라인들 (선택)

[테스트 연결] [저장]
```

`연결 방식` SSH 터널 선택 시 호스트/포트는 "원격에서 본 host" (예: 127.0.0.1) — main 이 자동으로 SSH forwardOut.

---

## 9. SqlToolWorkspace 의 jdbcDriver

`DbmsDriver` 인터페이스 그대로 두되, 새 `jdbcDriver(dialect, connectionId)` 가 구현 모두 IPC 호출로 위임:
- `buildCommand`/`parseOutput`/`detectError`/`wrapForCount` 등은 더 이상 필요 없음 → 인터페이스 슬림화.

새 인터페이스 (제안):
```ts
interface DbmsDriver {
  dialect: DbmsDialect;
  exec(sql: string, opts?): Promise<ParsedResult>;
  listTables(): Promise<string[]>;
  listViews(): Promise<string[]>;
  listSequences(): Promise<string[]>;
  listProcedures(): Promise<string[]>;
  columns(table: string): Promise<ColumnInfo[]>;
  primaryKey(table: string): Promise<string[]>;
  beginTx(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  selectAllSql(table: string): string;   // 표시용 SQL (실행은 exec 로)
  // pagination 은 driver 가 내부에서 처리 — caller 는 exec 만 호출
}
```

페이지네이션은 사이드카가 maxRows 로 자르고 truncated 플래그 반환 → 다음 페이지는 별도 method (`fetch`) 로 받는 모델. 또는 LIMIT/OFFSET 을 driver 가 dialect 별로 생성.

메타데이터는 가능한 한 `DatabaseMetaData` (JDBC 표준) 사용:
- `getTables`, `getColumns`, `getPrimaryKeys`, `getProcedures`, `getIndexInfo`.

이렇게 하면 dialect 별 분기 최소화.

---

## 10. 빌드 / 패키징 변경

추가 단계 (`package.json` scripts):
```
"build:sidecar": "cd java-sidecar && ./gradlew shadowJar && cp build/libs/pepe-jdbc-all.jar ../resources/jdbc-sidecar/pepe-jdbc.jar",
"download:jre": "node scripts/download-jre.js",
"download:jdbc": "node scripts/download-jdbc-drivers.js",
"build": "npm run build:sidecar && npm run download:jre && npm run download:jdbc && ... (기존 빌드)"
```

`electron-builder.yml`:
- `extraResources`:
  - `resources/jre/<plat>` → `jre/`
  - `resources/jdbc-sidecar` → `jdbc-sidecar/`
  - `resources/jdbc-drivers/bundled` → `jdbc-drivers/bundled/`

`.gitignore`:
- `resources/jre/`
- `resources/jdbc-drivers/bundled/`
- `resources/jdbc-sidecar/pepe-jdbc.jar`
(빌드 산출물; 다운로드 스크립트로 재생산)

`java-sidecar/` 소스만 git 포함.

---

## 11. 레거시 제거

- `buildIsqlCommand`, `parseIsqlOutput`, `parseIsqlOutputUnsafe`, `altibaseTypeName`, `ALTIBASE_TYPE_MAP`, `altibaseDriver` (CLI 버전) 모두 제거.
- IPC `sql:exec` (현재 ssh exec) 의 `sqlExec` 경로는 SQL Tool 에서는 더 이상 사용하지 않음. 다른 곳(예: TerminalPanel) 에서 쓰지 않으면 deprecate.
- 단순화: SqlToolWorkspace 는 `(window as any).api.jdbc.exec(connectionId, sql)` 만 호출.

---

## 12. 단계별 실행 순서 (E-2 → E-8)

1. **E-2.1** java-sidecar 스켈레톤 + ping (Java 코드 + gradle + shadowJar)
2. **E-2.2** electron 측 jdbcBridge.ts + IPC `jdbc:ping` + preload
3. **E-2.3** download-jre 스크립트 + electron-builder 통합
4. **E-3.1** download-jdbc-drivers 스크립트 (bundled 4종 + altibase 자리만)
5. **E-3.2** Driver Manager 영속화 (drivers.json) + 기본 등록
6. **E-4.1** 사이드카에 `loadDriver` / `connect` / `exec` 구현
7. **E-4.2** SqlToolWorkspace 의 driver 인터페이스 슬림화 + jdbcDriver 구현 (Altibase dialect)
8. **E-4.3** SqlToolWorkspace 메타데이터 호출을 DatabaseMetaData 기반으로 교체
9. **E-5** Driver Manager UI 모달
10. **E-6** SessionEditor DBMS 탭 재설계 + SSH 터널 옵션 + URL 자동/직접 입력 토글
11. **E-7.1** PostgreSQL dialect 매핑/검증
12. **E-7.2** MySQL/MariaDB dialect 매핑/검증
13. **E-7.3** MSSQL dialect 매핑/검증
14. **E-7.4** SQLite dialect 매핑/검증
15. **E-7.5** Oracle (드라이버 사용자 지정) 검증
16. **E-8** 레거시 CLI 경로 제거

각 단계 끝나면 typecheck + 짧은 수동 검증 + 커밋.

---

## 13. 결정 사항 / 의문점 (Open)

- **JRE 라이선스**: Adoptium Temurin 21 (GPLv2 with Classpath Exception) — 재배포 OK. `LICENSE` 디렉토리 동봉 필요.
- **Altibase JDBC 라이선스**: 번들 가능 여부 확인 필요. 어려우면 "사용자 지정" 으로 강등하고 안내 메시지.
- **MySQL Connector/J**: GPL → 회피 위해 MariaDB Connector/J 사용 권장 (LGPL).
- **사이드카 한 개 vs 세션별**: 일단 세션별. 메모리 부담 크면 추후 풀링.
- **결과 스트리밍**: 우선 `maxRows` 컷오프. 필요 시 fetch/next page method 추가.
- **bin 호환성**: Windows x64 만 우선 (현재 nsis 타겟). mac/linux 는 후순위.
- **타입 매핑**: JDBC `Types` 상수 → 사람이 읽는 텍스트 매핑 테이블 사이드카에서 처리.

---

## 14. 위험 / 완화

| 위험 | 영향 | 완화 |
|---|---|---|
| 설치본 크기 폭증 (~+150MB) | 사용자 부담 | JRE 강력 압축; LZMA NSIS 옵션; 또는 web installer 분리 옵션 추후 |
| 사이드카 비정상 종료 | 쿼리 도중 끊김 | 자동 재시작 + 마지막 쿼리 에러 표시 |
| 사용자 JAR 호환성 | 드라이버 클래스 못 찾음 | 친절한 에러 + 클래스명 자동 탐지 시도 |
| Altibase 번들 불가 | 즉시 사용 불가 | 사용자 지정 안내 + drivers.json 자동 항목 |
| Oracle 라이선스 | 빌드 차단 | 번들 제외 — 사용자 OTN 다운로드 안내 |
