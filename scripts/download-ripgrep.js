'use strict';

// scripts/download-ripgrep.js
//
// Downloads the official ripgrep binary release for the current platform and
// installs it under resources/rg/<platform>/ so the packaged app can ship with
// rg available on PATH.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RES_DIR = path.join(ROOT, 'resources', 'rg');
const VERSION = '15.1.0';
const BASE = `https://github.com/BurntSushi/ripgrep/releases/download/${VERSION}`;

const PLATFORMS = {
  'win-x64': {
    asset: `ripgrep-${VERSION}-x86_64-pc-windows-msvc.zip`,
    extractDir: `ripgrep-${VERSION}-x86_64-pc-windows-msvc`,
    binRel: 'rg.exe',
  },
  'win-arm64': {
    asset: `ripgrep-${VERSION}-aarch64-pc-windows-msvc.zip`,
    extractDir: `ripgrep-${VERSION}-aarch64-pc-windows-msvc`,
    binRel: 'rg.exe',
  },
  'mac-x64': {
    asset: `ripgrep-${VERSION}-x86_64-apple-darwin.tar.gz`,
    extractDir: `ripgrep-${VERSION}-x86_64-apple-darwin`,
    binRel: 'rg',
  },
  'mac-arm64': {
    asset: `ripgrep-${VERSION}-aarch64-apple-darwin.tar.gz`,
    extractDir: `ripgrep-${VERSION}-aarch64-apple-darwin`,
    binRel: 'rg',
  },
  'linux-x64': {
    asset: `ripgrep-${VERSION}-x86_64-unknown-linux-musl.tar.gz`,
    extractDir: `ripgrep-${VERSION}-x86_64-unknown-linux-musl`,
    binRel: 'rg',
  },
  'linux-arm64': {
    asset: `ripgrep-${VERSION}-aarch64-unknown-linux-musl.tar.gz`,
    extractDir: `ripgrep-${VERSION}-aarch64-unknown-linux-musl`,
    binRel: 'rg',
  },
};

function detectCurrentPlat() {
  if (process.platform === 'win32') return process.arch === 'arm64' ? 'win-arm64' : 'win-x64';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  if (process.platform === 'linux') return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
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
          if (total) process.stdout.write(`\r[ripgrep] ${(downloaded / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB`);
          else process.stdout.write(`\r[ripgrep] ${(downloaded / 1024 / 1024).toFixed(1)} MB`);
        }
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => { process.stdout.write('\n'); resolve(); }));
      out.on('error', (e) => { try { fs.unlinkSync(dest); } catch {} reject(e); });
    });
    req.on('error', reject);
  });
}

function extract(archive, destDir) {
  const tarArgs = archive.endsWith('.zip') ? ['-xf', archive, '-C', destDir] : ['-xzf', archive, '-C', destDir];
  let r = spawnSync('tar', tarArgs, { stdio: 'inherit' });
  if (r.status === 0) return;
  if (archive.endsWith('.zip')) {
    r = spawnSync('powershell', ['-NoProfile', '-Command',
      `[System.Reflection.Assembly]::LoadWithPartialName('System.IO.Compression.FileSystem') | Out-Null;` +
      `[System.IO.Compression.ZipFile]::ExtractToDirectory('${archive.replace(/'/g, "''")}', '${destDir.replace(/'/g, "''")}')`,
    ], { stdio: 'inherit' });
    if (r.status === 0) return;
  }
  throw new Error(`failed to extract ${path.basename(archive)}`);
}

async function main() {
  const args = parseArgs();
  const platKey = args.platform || detectCurrentPlat();
  if (!platKey || !PLATFORMS[platKey]) {
    console.error(`[ripgrep] unsupported platform: ${platKey}`);
    process.exit(1);
  }
  const plat = PLATFORMS[platKey];
  const destDir = path.join(RES_DIR, platKey);
  const binPath = path.join(destDir, plat.binRel);
  const url = `${BASE}/${plat.asset}`;

  if (args.checkOnly) {
    if (fs.existsSync(binPath)) {
      console.log(`[ripgrep] ✓ installed: ${path.relative(ROOT, binPath)}`);
      process.exit(0);
    }
    console.error(`[ripgrep] ✗ missing: ${path.relative(ROOT, binPath)}`);
    process.exit(1);
  }

  if (fs.existsSync(binPath) && !args.force) {
    console.log(`[ripgrep] ✓ already installed: ${path.relative(ROOT, binPath)}`);
    return;
  }

  fs.mkdirSync(RES_DIR, { recursive: true });
  const tmpDir = path.join(RES_DIR, '_tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const archive = path.join(tmpDir, plat.asset);
  const stageDir = path.join(tmpDir, plat.extractDir);
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  console.log(`[ripgrep] plat=${platKey} → ${url}`);
  await get(url, archive);
  console.log(`[ripgrep] extracting → ${path.relative(ROOT, stageDir)}`);
  extract(archive, stageDir);

  const entries = fs.readdirSync(stageDir);
  const rootSub = entries.length === 1 ? path.join(stageDir, entries[0]) : stageDir;
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of fs.readdirSync(rootSub)) {
    fs.cpSync(path.join(rootSub, name), path.join(destDir, name), { recursive: true });
  }

  fs.rmSync(stageDir, { recursive: true, force: true });
  try { fs.unlinkSync(archive); } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });

  if (!fs.existsSync(binPath)) {
    throw new Error(`rg executable missing after extract: ${binPath}`);
  }
  try { fs.chmodSync(binPath, 0o755); } catch {}
  const smoke = spawnSync(binPath, ['--version'], { encoding: 'utf8' });
  console.log(`[ripgrep] ✓ installed at ${path.relative(ROOT, destDir)}`);
  const out = String(smoke.stdout || smoke.stderr || '').trim().split('\n')[0];
  if (out) console.log(`[ripgrep] ${out}`);
}

main().catch((err) => {
  console.error(`[ripgrep] FAILED: ${err.message}`);
  process.exit(1);
});
