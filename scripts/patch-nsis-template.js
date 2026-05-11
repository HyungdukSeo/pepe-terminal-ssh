// electron-builder 의 NSIS 템플릿 패치 — 설치 진행 중 detail 패널이 비어 보이지 않게 함.
//
// 기본 템플릿(installSection.nsh)은 install section 진입 시 `SetDetailsPrint none` 으로
// 강제하여 파일 복사 중 어떤 출력도 detail 패널에 안 보임. 사용자는 progress bar 만 보고
// 멍하니 기다리게 됨.
//
// 이 스크립트는 그 한 줄을 `SetDetailsPrint listonly` 로 바꿔서 파일 복사 진행이
// 패널에 표시되도록 한다. 이미 패치돼 있으면 skip.
//
// npm install 등으로 node_modules 가 재설치되면 다시 적용해야 하므로 빌드 스크립트
// 앞단에 호출한다.

const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, '..', 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'installSection.nsh');

try {
  if (!fs.existsSync(target)) {
    console.warn('[patch-nsis] template not found:', target);
    process.exit(0);
  }
  let content = fs.readFileSync(target, 'utf8');
  if (content.includes('SetDetailsPrint listonly')) {
    console.log('[patch-nsis] already patched');
    process.exit(0);
  }
  // 원본:
  //   ${IfNot} ${Silent}
  //     SetDetailsPrint none
  //   ${endif}
  // → SetDetailsPrint listonly 로 교체
  const patched = content.replace(
    /(\$\{IfNot\}\s+\$\{Silent\}\s*\n\s*)SetDetailsPrint\s+none(\s*\n\s*\$\{endif\})/,
    '$1SetDetailsPrint listonly$2'
  );
  if (patched === content) {
    console.warn('[patch-nsis] target pattern not found — template format may have changed');
    process.exit(0);
  }
  fs.writeFileSync(target, patched, 'utf8');
  console.log('[patch-nsis] patched:', target);
} catch (err) {
  console.error('[patch-nsis] error:', err);
  process.exit(1);
}
