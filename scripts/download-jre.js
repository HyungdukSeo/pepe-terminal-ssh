// scripts/download-jre.js
//
// Downloads an Eclipse Adoptium Temurin JRE for the target platform and
// extracts it under resources/jre/<plat>/. Idempotent: skips when an
// existing JRE is already present (use --force to redownload).
//
// Usage:
//   node scripts/download-jre.js                # detect current platform
//   node scripts/download-jre.js --platform=win-x64
//   node scripts/download-jre.js --force
//   node scripts/download-jre.js --check        # exit 0 if installed, 1 otherwise
//
// Supported platform keys: win-x64, win-arm64, mac-x64, mac-arm64, linux-x64.

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RES_DIR = path.join(ROOT, 'resources', 'jre');

// Temurin release knobs. Bumping the major version is safe — Adoptium serves
// the latest GA build for that line. Keep this in sync with what the sidecar
// is tested against (target/source = 8, but runtime can be much newer).
const ADOPTIUM_API = 'https://api.adoptium.net/v3/binary/latest';
const VERSION = '21';
const RELEASE = 'ga';
const IMAGE = 'jre';
const JVM = 'hotspot';
const HEAP = 'normal';
const VENDOR = 'eclipse';

const PLATFORMS = {
  'win-x64':    { os: 'windows', arch: 'x64',     ext: 'zip',    javaRel: path.join('bin', 'java.exe') },
  'win-arm64':  { os: 'windows', arch: 'aarch64', ext: 'zip',    javaRel: path.join('bin', 'java.exe') },
  'mac-x64':    { os: 'mac',     arch: 'x64',     ext: 'tar.gz', javaRel: path.join('Contents', 'Home', 'bin', 'java') },
  'mac-arm64':  { os: 'mac',     arch: 'aarch64', ext: 'tar.gz', javaRel: path.join('Contents', 'Home', 'bin', 'java') },
  'linux-x64':  { os: 'linux',   arch: 'x64',     ext: 'tar.gz', javaRel: path.join('bin', 'java') },
};

function detectCurrentPlat() {
  if (process.platform === 'win32') return process.arch === 'arm64' ? 'win-arm64' : 'win-x64';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  if (process.platform === 'linux') return 'linux-x64';
  return null;
}

function parseArgs() {
  const out = { force: false, checkOnly: false, platform: null };
  for (const a of process.argv.slice(2)) {
    if (a === '--force') out.force = true;
    else if (a === '--check') out.checkOnly = true;
    else if (a.startsWith('--platform=')) out.platform = a.slice('--platform='.length);
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
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let downloaded = 0;
      let lastTick = 0;
      res.on('data', (chunk) => {
        downloaded += chunk.length;
        const now = Date.now();
        if (now - lastTick > 200) {
          lastTick = now;
          if (total) process.stdout.write(`\r[download-jre] ${(downloaded/1024/1024).toFixed(1)} / ${(total/1024/1024).toFixed(1)} MB`);
          else process.stdout.write(`\r[download-jre] ${(downloaded/1024/1024).toFixed(1)} MB`);
        }
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => { process.stdout.write('\n'); resolve(); }));
      out.on('error', (e) => { try { fs.unlinkSync(dest); } catch {} reject(e); });
    });
    req.on('error', reject);
  });
}

function extractZip(zipFile, destDir) {
  // Prefer tar because it is present on modern Windows hosts and avoids
  // PowerShell module-loading issues in constrained environments.
  let r = spawnSync('tar', ['-xf', zipFile, '-C', destDir], { stdio: 'inherit' });
  if (r.status === 0) return;
  // Fallback for environments where tar cannot handle the archive.
  r = spawnSync('powershell', ['-NoProfile', '-Command',
    `[System.Reflection.Assembly]::LoadWithPartialName('System.IO.Compression.FileSystem') | Out-Null;` +
    `[System.IO.Compression.ZipFile]::ExtractToDirectory('${zipFile.replace(/'/g, "''")}', '${destDir.replace(/'/g, "''")}')`,
  ], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('zip extraction failed');
}

function extractTarGz(tarFile, destDir) {
  const r = spawnSync('tar', ['-xzf', tarFile, '-C', destDir], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('tar -xzf failed');
}

async function main() {
  const args = parseArgs();
  const platKey = args.platform || detectCurrentPlat();
  if (!platKey || !PLATFORMS[platKey]) {
    console.error(`[download-jre] unsupported platform: ${platKey}`);
    process.exit(1);
  }
  const plat = PLATFORMS[platKey];
  const destDir = path.join(RES_DIR, platKey);
  const javaPath = path.join(destDir, plat.javaRel);

  // --check 모드
  if (args.checkOnly) {
    if (fs.existsSync(javaPath)) {
      console.log(`[download-jre] ✓ installed: ${path.relative(ROOT, javaPath)}`);
      process.exit(0);
    } else {
      console.error(`[download-jre] ✗ missing: ${path.relative(ROOT, javaPath)}`);
      process.exit(1);
    }
  }

  // 이미 설치되어 있고 --force 아니면 스킵
  if (fs.existsSync(javaPath) && !args.force) {
    console.log(`[download-jre] ✓ already installed: ${path.relative(ROOT, javaPath)}`);
    return;
  }

  fs.mkdirSync(RES_DIR, { recursive: true });
  const tmpDir = path.join(RES_DIR, '_tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `jre-${platKey}.${plat.ext}`);
  const stageDir = path.join(tmpDir, `stage-${platKey}`);
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  const url = `${ADOPTIUM_API}/${VERSION}/${RELEASE}/${plat.os}/${plat.arch}/${IMAGE}/${JVM}/${HEAP}/${VENDOR}`;
  console.log(`[download-jre] plat=${platKey} → ${url}`);
  await get(url, tmpFile);
  const sz = fs.statSync(tmpFile).size;
  console.log(`[download-jre] downloaded ${path.relative(ROOT, tmpFile)} (${(sz/1024/1024).toFixed(1)} MB)`);

  console.log(`[download-jre] extracting → ${path.relative(ROOT, stageDir)}`);
  if (plat.ext === 'zip') extractZip(tmpFile, stageDir);
  else extractTarGz(tmpFile, stageDir);

  // The archive contains a single top-level directory (e.g. jdk-21.0.4+7-jre).
  // Flatten its contents into destDir.
  const stageEntries = fs.readdirSync(stageDir);
  if (stageEntries.length === 0) throw new Error('empty archive');
  const rootSub = stageEntries.length === 1
    ? path.join(stageDir, stageEntries[0])
    : stageDir;

  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  // rename across the same drive can still fail under AV / file-handle contention
  // on Windows. cpSync (recursive) is the safe portable option.
  for (const name of fs.readdirSync(rootSub)) {
    fs.cpSync(path.join(rootSub, name), path.join(destDir, name), { recursive: true });
  }

  // Cleanup tmp
  fs.rmSync(stageDir, { recursive: true, force: true });
  try { fs.unlinkSync(tmpFile); } catch {}

  if (!fs.existsSync(javaPath)) {
    throw new Error(`java executable missing after extract: ${javaPath}`);
  }
  // Make executable (no-op on Windows).
  try { fs.chmodSync(javaPath, 0o755); } catch {}

  // Smoke check `java -version`.
  const ver = spawnSync(javaPath, ['-version']);
  const verText = (ver.stderr || ver.stdout || Buffer.from('')).toString().trim();
  console.log(`[download-jre] ✓ installed at ${path.relative(ROOT, destDir)}`);
  if (verText) console.log(`[download-jre] ${verText.split('\n')[0]}`);
}

main().catch((err) => {
  console.error(`[download-jre] FAILED: ${err.message}`);
  process.exit(1);
});
