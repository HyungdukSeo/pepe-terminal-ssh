#!/usr/bin/env node
// scripts/sign-with-retry.js
// V3 같은 백신이 파일 락을 잡고 있을 때를 위한 signtool 커스텀 retry 래퍼.
// electron-builder 의 win.sign 옵션이 이 함수를 호출.
//
// 동작:
//   1) 대상 파일이 쓰기 가능 상태 (락 없음) 될 때까지 폴링 (최대 N초)
//   2) signtool 실행
//   3) "file is being used by another process" 류 에러면 지수 backoff 로 재시도
//
// 환경변수:
//   PEPE_SIGN_MAX_RETRY      재시도 횟수 (기본 8)
//   PEPE_SIGN_INITIAL_WAIT   파일 unlock 폴링 최대 대기 (초, 기본 30)

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const MAX_RETRY = parseInt(process.env.PEPE_SIGN_MAX_RETRY || '8', 10);
const INITIAL_WAIT = parseInt(process.env.PEPE_SIGN_INITIAL_WAIT || '30', 10);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 파일을 exclusive 쓰기로 잠시 열어보고 락 여부 판단. 실패하면 V3 등이 쥐고 있음.
async function waitForUnlock(filePath, maxSeconds) {
  const deadline = Date.now() + maxSeconds * 1000;
  let attempt = 0;
  while (Date.now() < deadline) {
    try {
      // r+ 모드로 열면 다른 프로세스가 쓰기 락을 잡고 있을 때 EBUSY/EPERM
      const fd = fs.openSync(filePath, 'r+');
      fs.closeSync(fd);
      if (attempt > 0) console.log(`[sign-with-retry] 파일 락 해제됨 (${attempt}회 폴링 후)`);
      return true;
    } catch (e) {
      attempt++;
      if (attempt % 4 === 1) console.log(`[sign-with-retry] 파일 락 대기 중... (${attempt}회) — ${e.code || e.message}`);
      await sleep(1500);
    }
  }
  console.warn(`[sign-with-retry] 파일 락이 ${maxSeconds}초 안에 풀리지 않음 — 그래도 signtool 시도`);
  return false;
}

function runSigntool(signtoolPath, args, filePath) {
  return new Promise((resolve, reject) => {
    execFile(signtoolPath, [...args, filePath], { windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout; err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

function findWindowsKitSigntool() {
  const roots = [
    process.env.PEPE_SIGNTOOL_DIR,
    'C:\\Program Files (x86)\\Windows Kits\\10\\bin',
    'C:\\Program Files\\Windows Kits\\10\\bin',
  ].filter(Boolean);
  for (const root of roots) {
    try {
      if (!fs.existsSync(root)) continue;
      const candidates = [];
      for (const version of fs.readdirSync(root)) {
        const p = path.join(root, version, 'x64', 'signtool.exe');
        if (fs.existsSync(p)) candidates.push(p);
      }
      candidates.sort().reverse();
      if (candidates[0]) return candidates[0];
    } catch {}
  }
  return null;
}

// electron-builder 가 호출하는 진입점
module.exports = async function (configuration) {
  const filePath = configuration.path;
  const cscInfo = configuration.options || {};
  const hash = configuration.hash || (cscInfo.signingHashAlgorithms && cscInfo.signingHashAlgorithms[0]) || 'sha256';
  // RFC3161 타임스탬프 서버 목록 — 하나가 일시적으로 불통이면 다음 서버로 자동 로테이션.
  const tsServers = [
    'http://timestamp.digicert.com',
    'http://timestamp.sectigo.com',
    'http://timestamp.globalsign.com/tsa/r6advanced1',
    'http://time.certum.pl',
  ];

  // PFX 위치 — package.json 의 win.certificateFile / certificatePassword 사용
  // configuration.cscInfo 또는 configuration.options.cscInfo 위치 차이 처리
  const cscFile = (configuration.cscInfo && configuration.cscInfo.file) || cscInfo.certificateFile || process.env.CSC_LINK;
  const cscPass = (configuration.cscInfo && configuration.cscInfo.password) || cscInfo.certificatePassword || process.env.CSC_KEY_PASSWORD;
  const productName = cscInfo.productName || configuration.name || '';
  const site = configuration.site || '';

  // signtool 경로 — electron-builder 가 다운로드한 winCodeSign 캐시 사용
  const home = process.env.LOCALAPPDATA || process.env.APPDATA || process.env.HOME;
  const winCodeSignDir = path.join(home, 'electron-builder', 'Cache', 'winCodeSign');
  // 최신 winCodeSign-X.Y.Z 디렉토리 찾기
  let signtoolPath;
  try {
    const versions = fs.readdirSync(winCodeSignDir).filter(d => d.startsWith('winCodeSign-')).sort().reverse();
    if (versions.length === 0) throw new Error('winCodeSign 캐시 없음');
    signtoolPath = path.join(winCodeSignDir, versions[0], 'windows-10', 'x64', 'signtool.exe');
    if (!fs.existsSync(signtoolPath)) throw new Error('signtool.exe 없음: ' + signtoolPath);
  } catch (err) {
    signtoolPath = findWindowsKitSigntool();
    if (!signtoolPath) throw new Error('[sign-with-retry] signtool 위치 탐색 실패: ' + err.message);
    console.warn(`[sign-with-retry] winCodeSign cache unavailable; using Windows Kits signtool: ${signtoolPath}`);
  }

  const argsFor = (tsUrl) => {
    const a = ['sign', '/tr', tsUrl, '/f', cscFile, '/fd', hash, '/td', hash];
    if (productName) a.push('/d', productName);
    if (site) a.push('/du', site);
    if (cscPass) a.push('/p', cscPass);
    return a;
  };

  console.log(`[sign-with-retry] 서명 시작: ${path.basename(filePath)}`);

  // 1) 파일 unlock 대기
  await waitForUnlock(filePath, INITIAL_WAIT);

  // 2) signtool 시도 — 락/타임스탬프 오류 시 백오프 + 타임스탬프 서버 로테이션
  const backoff = [2000, 5000, 10000, 20000, 30000, 45000, 60000, 90000];
  // 락 외 오류(주로 타임스탬프)는 최소 서버 개수만큼은 더 돌려본다
  const maxRetry = Math.max(MAX_RETRY, tsServers.length + 2);
  let lastErr;
  let tsIdx = 0;
  for (let attempt = 0; attempt < maxRetry; attempt++) {
    const tsUrl = tsServers[tsIdx % tsServers.length];
    try {
      await runSigntool(signtoolPath, argsFor(tsUrl), filePath);
      console.log(`[sign-with-retry] ✓ 서명 성공: ${path.basename(filePath)} (시도 ${attempt + 1}, ts=${tsUrl})`);
      return;
    } catch (err) {
      lastErr = err;
      const out = (err.stdout || '') + (err.stderr || '');
      const isLock = /file is being used|sharing violation|access is denied/i.test(out);
      const isTs = /timestamp server|could not be reached|RFC3161|timestamp/i.test(out);
      if (!isLock && !isTs) {
        console.error(`[sign-with-retry] ✕ 서명 실패 (락/타임스탬프 아님):`, out.trim());
        throw err;
      }
      if (isTs) {
        // 다음 타임스탬프 서버로 로테이션 후 짧게 재시도
        tsIdx++;
        const wait = Math.min(3000 + attempt * 2000, 15000);
        console.warn(`[sign-with-retry] 시도 ${attempt + 1} 타임스탬프 오류(${tsUrl}) — 다음 서버로 ${wait}ms 후 재시도`);
        await sleep(wait);
      } else {
        const wait = backoff[Math.min(attempt, backoff.length - 1)];
        console.warn(`[sign-with-retry] 시도 ${attempt + 1} 락 에러 — ${wait}ms 후 재시도`);
        await sleep(wait);
        await waitForUnlock(filePath, 10);
      }
    }
  }
  console.error(`[sign-with-retry] ✕ 최대 재시도 (${maxRetry}) 초과`);
  throw lastErr || new Error('서명 실패');
};
