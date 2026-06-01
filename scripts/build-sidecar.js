// scripts/build-sidecar.js
//
// Builds the Java sidecar:
//
//   1. Downloads Jackson JARs (jackson-databind/core/annotations) into
//      java-sidecar/lib/ if not yet present.
//   2. Compiles java-sidecar/src/**/*.java with `javac -cp lib/*` into
//      java-sidecar/build/.
//   3. Packages into resources/jdbc-sidecar/pepe-jdbc.jar with a manifest that
//      sets Main-Class and Class-Path pointing at the sibling Jackson JARs.
//   4. Copies the Jackson JARs into resources/jdbc-sidecar/ so the sidecar JAR
//      can find them at runtime via the manifest Class-Path.
//
// Idempotent: skips downloads when JARs already present (use --force).

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'java-sidecar', 'src');
const LIB_DIR = path.join(ROOT, 'java-sidecar', 'lib');
const BUILD_DIR = path.join(ROOT, 'java-sidecar', 'build');
const TARGET_DIR = path.join(ROOT, 'resources', 'jdbc-sidecar');
const TARGET_JAR = path.join(TARGET_DIR, 'pepe-jdbc.jar');

const JACKSON_VERSION = '2.17.2';
const JACKSON = [
  { group: 'com.fasterxml.jackson.core', artifact: 'jackson-core',        version: JACKSON_VERSION },
  { group: 'com.fasterxml.jackson.core', artifact: 'jackson-databind',    version: JACKSON_VERSION },
  { group: 'com.fasterxml.jackson.core', artifact: 'jackson-annotations', version: JACKSON_VERSION },
];
const MAVEN_BASE = 'https://repo1.maven.org/maven2';

function exe(name) { return process.platform === 'win32' ? `${name}.exe` : name; }
function resolveJdkTool(name) {
  if (process.env.JAVA_HOME) {
    const p = path.join(process.env.JAVA_HOME, 'bin', exe(name));
    if (fs.existsSync(p)) return p;
  }
  return name;
}

function runOrDie(cmd, args, opts) {
  const r = spawnSync(cmd, args, Object.assign({ stdio: 'inherit' }, opts || {}));
  if (r.error) { console.error(`[build-sidecar] ${cmd}: ${r.error.message}`); process.exit(1); }
  if (r.status !== 0) { console.error(`[build-sidecar] ${cmd} exited with status ${r.status}`); process.exit(r.status); }
}

function walkJavaSources(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkJavaSources(full, out);
    else if (e.isFile() && e.name.endsWith('.java')) out.push(full);
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
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} on ${url}`)); }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
      out.on('error', (e) => { try { fs.unlinkSync(dest); } catch {} reject(e); });
    });
    req.on('error', reject);
  });
}

async function ensureJackson() {
  fs.mkdirSync(LIB_DIR, { recursive: true });
  for (const j of JACKSON) {
    const name = `${j.artifact}-${j.version}.jar`;
    const dest = path.join(LIB_DIR, name);
    if (fs.existsSync(dest)) continue;
    const url = `${MAVEN_BASE}/${j.group.replace(/\./g, '/')}/${j.artifact}/${j.version}/${name}`;
    console.log(`[build-sidecar] ⬇ ${name}`);
    await get(url, dest);
  }
}

function jarsInLib() {
  return fs.readdirSync(LIB_DIR).filter(n => n.endsWith('.jar'));
}

async function main() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error(`[build-sidecar] source dir missing: ${SRC_DIR}`);
    process.exit(1);
  }
  await ensureJackson();

  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  fs.mkdirSync(TARGET_DIR, { recursive: true });

  const javac = resolveJdkTool('javac');
  const jar = resolveJdkTool('jar');

  const libJars = jarsInLib();
  // Use platform classpath separator
  const sep = process.platform === 'win32' ? ';' : ':';
  const cp = libJars.map(j => path.join(LIB_DIR, j)).join(sep);

  const sources = walkJavaSources(SRC_DIR, []);
  if (sources.length === 0) { console.error('[build-sidecar] no .java sources'); process.exit(1); }
  // Target 8 keeps us compatible with old system Java users.
  runOrDie(javac, ['-encoding', 'UTF-8', '-source', '8', '-target', '8', '-cp', cp, '-d', BUILD_DIR, ...sources]);

  // Manifest. Class-Path is space-separated relative paths from the JAR's location.
  const classPathEntries = libJars.join(' ');
  const manifest =
      'Manifest-Version: 1.0\n'
    + 'Main-Class: com.pepe.jdbc.Main\n'
    + 'Class-Path: ' + classPathEntries + '\n';
  const manifestPath = path.join(BUILD_DIR, 'MANIFEST.MF');
  fs.writeFileSync(manifestPath, manifest, 'utf8');

  runOrDie(jar, ['cfm', TARGET_JAR, manifestPath, '-C', BUILD_DIR, 'com']);

  // Copy Jackson JARs alongside the sidecar JAR so the manifest Class-Path
  // resolves at runtime.
  for (const name of libJars) {
    const src = path.join(LIB_DIR, name);
    const dst = path.join(TARGET_DIR, name);
    fs.copyFileSync(src, dst);
  }

  const sz = fs.statSync(TARGET_JAR).size;
  console.log(`[build-sidecar] ✓ ${path.relative(ROOT, TARGET_JAR)} (${sz} bytes)`);
  console.log(`[build-sidecar] ✓ Class-Path JARs: ${classPathEntries}`);
}

main().catch((err) => { console.error(`[build-sidecar] FAILED: ${err.message}`); process.exit(1); });
