// electron-builder afterPack hook.
//
// PePe 는 자가서명 인증서(CN=PePe Terminal)로 코드 서명한다. electron-builder 는
// app-update.yml 에 publisherName: [PePe Terminal] 을 기록하는데, electron-updater 가
// 업데이트 다운로드 후 Windows 의 trust chain 으로 이 publisherName 서명을 검증하려다
// "not signed by the application owner"(자가서명 루트 미신뢰)로 거부한다.
//
// electron-updater 의 NsisUpdater.verifySignature() 는 app-update.yml 의 publisherName 이
// 없으면 검증을 통째로 스킵한다(return null). 따라서 packaging 직후 app-update.yml 에서
// publisherName 을 제거해 서명 검증을 원천적으로 비활성화한다.
// (무결성은 latest.yml 의 sha512 + GitHub HTTPS 가 보장. 런타임 override 와 이중 안전망)
//
// EV/CA 인증서 도입 시 이 훅을 제거하면 정상 검증이 복원된다.
'use strict';
const fs = require('fs');
const path = require('path');

module.exports = async function afterPack(context) {
  try {
    if (context.electronPlatformName !== 'win32') return;
    const ymlPath = path.join(context.appOutDir, 'resources', 'app-update.yml');
    if (!fs.existsSync(ymlPath)) {
      console.log('[strip-publishername] app-update.yml not found:', ymlPath);
      return;
    }
    const lines = fs.readFileSync(ymlPath, 'utf8').split(/\r?\n/);
    const out = [];
    let skipping = false;
    for (const line of lines) {
      if (/^publisherName\s*:/.test(line)) { skipping = true; continue; }      // publisherName: 키 시작
      if (skipping) {
        // 하위 리스트 항목('  - ...') 또는 인덴트된 값은 계속 스킵
        if (/^\s+[-\S]/.test(line)) continue;
        skipping = false;
      }
      out.push(line);
    }
    fs.writeFileSync(ymlPath, out.join('\n'), 'utf8');
    console.log('[strip-publishername] removed publisherName from', ymlPath);
  } catch (e) {
    console.error('[strip-publishername] failed:', e && (e.message || e));
  }
};
