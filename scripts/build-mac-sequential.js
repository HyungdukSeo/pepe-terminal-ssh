#!/usr/bin/env node
// Mac DMG 를 arm64 → x64 순서로 순차 빌드 (병렬 hdiutil 충돌 방지)
// 전략: 임시 electron-builder 설정 파일로 단일 arch 강제
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));

function buildArch(arch) {
  console.log('\n[build-mac] building arch=' + arch);

  // 단일 arch 설정으로 임시 config 파일 생성
  var cfgPath = path.join(ROOT, '.electron-builder-' + arch + '.json');
  var cfg = Object.assign({}, PKG.build, {
    mac: Object.assign({}, PKG.build.mac, {
      target: [{ target: 'dmg', arch: [arch] }]
    })
  });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  try {
    var r = spawnSync('npx', ['electron-builder', '--mac', '--config', cfgPath], {
      cwd: ROOT, stdio: 'inherit', shell: false,
    });
    if (r.status !== 0) {
      console.error('[build-mac] ' + arch + ' 실패');
      process.exit(r.status || 1);
    }
  } finally {
    try { fs.unlinkSync(cfgPath); } catch (_) {}
    // 앱 번들(용량 큰 임시 폴더) 정리
    fs.rmSync(path.join(ROOT, 'release', 'mac-arm64'), { recursive: true, force: true });
    fs.rmSync(path.join(ROOT, 'release', 'mac'), { recursive: true, force: true });
  }
}

buildArch('arm64');
buildArch('x64');
console.log('\n[build-mac] ✓ 완료');
