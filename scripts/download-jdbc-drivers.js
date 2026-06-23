// scripts/download-jdbc-drivers.js
//
// Downloads bundled JDBC driver JARs from Maven Central into
// resources/jdbc-drivers/bundled/. Idempotent: skips drivers whose target
// JAR already exists at the expected size (or use --force).
//
// Altibase 7.x is resolved from Maven Central by the driver definition.
// Altibase 6.x is bundled as resources/jdbc-drivers/bundled/altibase-6.jar
// from a user-provided vendor JAR.

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const DEST_DIR = path.join(ROOT, 'resources', 'jdbc-drivers', 'bundled');

const MAVEN_BASE = 'https://repo1.maven.org/maven2';

// Driver matrix. `target` is the file name we save as (stable across version
// bumps — the renderer just refers to ${bundled}/<target>).
const DRIVERS = [
  {
    label: 'PostgreSQL',
    group: 'org.postgresql',
    artifact: 'postgresql',
    version: '42.7.4',
    target: 'postgresql.jar',
  },
  {
    label: 'MariaDB Connector/J (also speaks MySQL)',
    group: 'org.mariadb.jdbc',
    artifact: 'mariadb-java-client',
    version: '3.4.1',
    target: 'mariadb.jar',
  },
  {
    label: 'Microsoft SQL Server',
    group: 'com.microsoft.sqlserver',
    artifact: 'mssql-jdbc',
    version: '12.8.1.jre11',
    target: 'mssql.jar',
  },
  {
    label: 'SQLite (xerial)',
    group: 'org.xerial',
    artifact: 'sqlite-jdbc',
    version: '3.46.1.3',
    target: 'sqlite.jar',
  },
];

function parseArgs() {
  const out = { force: false, only: null };
  for (const a of process.argv.slice(2)) {
    if (a === '--force') out.force = true;
    else if (a.startsWith('--only=')) out.only = a.slice('--only='.length);
  }
  return out;
}

function get(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('too many redirects'));
    const req = https.get(url, { headers: { 'User-Agent': 'pepe-terminal-build' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return get(next, dest, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} on ${url}`));
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
      out.on('error', (e) => { try { fs.unlinkSync(dest); } catch {} reject(e); });
    });
    req.on('error', reject);
  });
}

function mavenUrl(d) {
  const groupPath = d.group.replace(/\./g, '/');
  return `${MAVEN_BASE}/${groupPath}/${d.artifact}/${d.version}/${d.artifact}-${d.version}.jar`;
}

async function main() {
  const args = parseArgs();
  fs.mkdirSync(DEST_DIR, { recursive: true });

  // README that documents the bundled JARs + license summary
  const readme = path.join(DEST_DIR, 'README.md');
  fs.writeFileSync(readme, [
    '# Bundled JDBC drivers',
    '',
    '이 디렉토리는 `scripts/download-jdbc-drivers.js` 가 생성/갱신합니다.',
    'JAR 자체는 git 추적에서 제외 (.gitignore) 됩니다.',
    '',
    '| File | Maven coordinate | License |',
    '| --- | --- | --- |',
    '| postgresql.jar | org.postgresql:postgresql | BSD-2 |',
    '| mariadb.jar    | org.mariadb.jdbc:mariadb-java-client | LGPL-2.1 |',
    '| mssql.jar      | com.microsoft.sqlserver:mssql-jdbc | MIT |',
    '| sqlite.jar     | org.xerial:sqlite-jdbc | Apache-2.0 |',
    '| altibase-6.jar | user-provided Altibase.jar for Altibase 6.x | Altibase vendor license |',
    '',
    'Oracle ojdbc 는 OTN 라이선스 제약으로 번들하지 않습니다. 사용자가 직접 추가하세요.',
    '',
  ].join('\n'), 'utf8');

  for (const d of DRIVERS) {
    if (args.only && d.target !== args.only) continue;
    const targetPath = path.join(DEST_DIR, d.target);
    if (fs.existsSync(targetPath) && !args.force) {
      const sz = fs.statSync(targetPath).size;
      console.log(`[jdbc-drivers] ✓ ${d.target} already present (${(sz/1024/1024).toFixed(1)} MB)`);
      continue;
    }
    const url = mavenUrl(d);
    console.log(`[jdbc-drivers] ⬇ ${d.label}: ${url}`);
    try {
      await get(url, targetPath);
      const sz = fs.statSync(targetPath).size;
      console.log(`[jdbc-drivers] ✓ ${d.target} (${(sz/1024/1024).toFixed(1)} MB)`);
    } catch (e) {
      console.error(`[jdbc-drivers] FAILED ${d.label}: ${e.message}`);
      try { fs.unlinkSync(targetPath); } catch {}
      process.exitCode = 1;
    }
  }

  // Altibase 6.x placeholder note — the actual altibase-6.jar is tracked
  // separately as a user-provided vendor JAR.
  const altibaseNote = path.join(DEST_DIR, 'altibase.jar.NOTE.txt');
  if (!fs.existsSync(altibaseNote)) {
    fs.writeFileSync(altibaseNote,
      'Altibase 6.x JDBC JAR 은 altibase-6.jar 파일명으로 번들됩니다.\n' +
      'Altibase 7.x 는 드라이버 관리자에서 Maven Central 의 com.altibase:altibase-jdbc 로 자동 다운로드됩니다.\n' +
      '또는 Driver Manager UI(E-5)에서 다른 경로의 JAR 을 지정할 수 있습니다.\n',
      'utf8');
  }
}

main().catch((err) => {
  console.error(`[jdbc-drivers] FAILED: ${err.message}`);
  process.exit(1);
});
