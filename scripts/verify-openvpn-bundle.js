#!/usr/bin/env node
// scripts/verify-openvpn-bundle.js
// 빌드 전 OpenVPN 번들 파일이 모두 존재하는지 확인.
// 누락 시 빌드 실패 + 안내 출력.
//
// 사용법:
//   node scripts/verify-openvpn-bundle.js          → 현재 OS 기준 검증
//   node scripts/verify-openvpn-bundle.js --all    → win/mac 둘 다 검증
//   node scripts/verify-openvpn-bundle.js --skip   → 검증 건너뜀 (VPN 없는 빌드)

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
if (args.includes('--skip')) {
  console.log('[verify-openvpn-bundle] --skip 플래그 — 검증 건너뜀');
  process.exit(0);
}

const checkAll = args.includes('--all');
const platform = process.platform;

// OpenVPN 2.6 기준 필수. 2.7 RC4 는 Wintun 지원 제거 + LZO 정적 링크라 일부 불필요.
// 실제 OpenVPN 설치 폴더의 bin/ 에서 동봉하면 됨 — 외부 어디서나 받은 DLL 은 ABI 미스매치 가능.
const WIN_REQUIRED = [
  'openvpn.exe',
  'libssl-3-x64.dll',
  'libcrypto-3-x64.dll',
  'libpkcs11-helper-1.dll',
];
// 버전/빌드에 따라 있을 수도 없을 수도. OpenVPN 설치 폴더 bin/ 에 있으면 함께 동봉, 없으면 패스.
const WIN_OPTIONAL = [
  'wintun.dll',         // 2.6 까지만 필요. 2.7 은 ovpn-dco 사용으로 불필요
  'liblzo2-2.dll',      // 2.6 까지 동적 링크. 2.7 은 정적 링크 가능성
  'libxxhash.dll',
  'vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll',
];

const MAC_REQUIRED = ['openvpn'];
const MAC_OPTIONAL = []; // dylib 들은 otool 로 의존성 추출 필요 — 후속 작업

function verifyDir(label, dir, required, optional) {
  const missing = [];
  const present = [];
  for (const f of required) {
    if (fs.existsSync(path.join(dir, f))) present.push(f);
    else missing.push(f);
  }
  const missingOpt = optional.filter(f => !fs.existsSync(path.join(dir, f)));

  console.log(`\n[${label}] ${dir}`);
  if (present.length > 0) console.log('  ✓ ' + present.join(', '));
  if (missing.length > 0) console.log('  ✕ 누락: ' + missing.join(', '));
  if (missingOpt.length > 0) console.log('  ⚠ 선택사항 누락 (대부분 시스템에 있어 무방): ' + missingOpt.join(', '));

  return missing.length === 0;
}

const winDir = path.join(__dirname, '..', 'resources', 'openvpn-win');
const macDir = path.join(__dirname, '..', 'resources', 'openvpn-mac');

const targets = [];
if (checkAll || platform === 'win32') targets.push(['Windows', winDir, WIN_REQUIRED, WIN_OPTIONAL]);
if (checkAll || platform === 'darwin') targets.push(['macOS', macDir, MAC_REQUIRED, MAC_OPTIONAL]);

let allOk = true;
for (const [label, dir, req, opt] of targets) {
  if (!verifyDir(label, dir, req, opt)) allOk = false;
}

if (!allOk) {
  console.error('\n[verify-openvpn-bundle] ✕ 필수 OpenVPN 바이너리가 누락되었습니다.');
  console.error('  → resources/openvpn-' + (platform === 'darwin' ? 'mac' : 'win') + '/README.md 의 안내대로 파일을 복사해 주세요.');
  console.error('  → 또는 VPN 기능을 빠진 빌드로 만들려면: node scripts/verify-openvpn-bundle.js --skip');
  process.exit(1);
}

console.log('\n[verify-openvpn-bundle] ✓ 모든 필수 파일 확인됨.');
process.exit(0);
