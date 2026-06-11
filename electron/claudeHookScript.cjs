#!/usr/bin/env node
// Claude Code PreToolUse hook — 각 툴 호출 직전에 실행되어 승인 요청
// Env: PEPE_CTRL_PORT, PEPE_CTRL_TOKEN, PEPE_APPROVAL_REQ_TIMEOUT_MS
// stdin: hook event JSON (tool_name, tool_input, session_id, etc)
// stdout: decision JSON 또는 exit code 2 (block)

'use strict';
const net = require('net');

const CTRL_PORT = parseInt(process.env.PEPE_CTRL_PORT || '0', 10);
const CTRL_TOKEN = process.env.PEPE_CTRL_TOKEN || '';
const TIMEOUT_MS = parseInt(process.env.PEPE_APPROVAL_REQ_TIMEOUT_MS || '300000', 10); // 5분

function log(...args) {
  try { process.stderr.write('[hook] ' + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n'); } catch {}
}

// 읽기 전용 셸 명령 화이트리스트 — 이 집합 안의 명령들만으로 구성된 파이프라인은
// 파일/시스템 변경이 없다고 판단해 승인 없이 자동 허용.
// 보수적 운영: 의심스러우면 빠뜨려 승인을 받게 한다 (불편 < 사고).
const SAFE_BASE_CMDS = new Set([
  // 디렉토리/파일 조회
  'ls', 'll', 'dir', 'pwd', 'find', 'tree', 'stat', 'file', 'readlink', 'realpath', 'basename', 'dirname',
  // 파일 읽기
  'cat', 'head', 'tail', 'more', 'less', 'tac', 'nl', 'od', 'xxd', 'hexdump', 'strings',
  // 출력/문자열
  'echo', 'printf', 'true', 'false', 'yes', 'seq',
  // 검색/처리 (in-place 미사용 가정 — sed/awk 는 별도 검증)
  'grep', 'egrep', 'fgrep', 'rg', 'ack', 'wc', 'sort', 'uniq', 'cut', 'tr', 'fold', 'expand', 'unexpand', 'rev',
  'diff', 'cmp', 'comm', 'join', 'paste', 'column', 'jq', 'yq', 'xmllint',
  // 시스템 정보
  'whoami', 'id', 'groups', 'hostname', 'uname', 'date', 'cal', 'uptime', 'who', 'w', 'last', 'tty',
  'ps', 'top', 'htop', 'pgrep', 'pidof', 'jobs',
  // 디스크/메모리 조회
  'df', 'du', 'free', 'lsblk', 'lsof', 'mount', 'lspci', 'lsusb',
  // 네트워크 조회
  'ip', 'ifconfig', 'netstat', 'ss', 'ping', 'traceroute', 'tracepath', 'dig', 'nslookup', 'host', 'getent', 'arp', 'route',
  // 환경/패스
  'env', 'printenv', 'which', 'whereis', 'type', 'command', 'alias', 'history',
  // 인코딩/해시 (읽기만)
  'md5sum', 'sha1sum', 'sha256sum', 'sha512sum', 'cksum', 'base64',
  // 압축 stdout 조회만 (tar/gunzip 등 파일 생성하는 건 제외)
  'zcat', 'gzcat', 'bzcat', 'xzcat',
  // 사용자/문서
  'man', 'info', 'help', 'whatis', 'apropos',
  // node/python REPL 단순 evaluation (-e/-c) — 별도 검증
]);
// git 읽기 전용 서브커맨드
const SAFE_GIT_SUB = new Set([
  'status', 'log', 'show', 'diff', 'branch', 'tag', 'remote', 'config', 'rev-parse',
  'rev-list', 'ls-files', 'ls-remote', 'ls-tree', 'cat-file', 'describe', 'blame',
  'shortlog', 'reflog', 'stash', 'whatchanged', 'name-rev', 'for-each-ref', 'help', 'version',
  'show-ref', 'show-branch', 'bisect', 'count-objects',
]);
// npm/yarn/pnpm 읽기 전용 서브커맨드 (install/uninstall/publish/run 등 부작용 있는 건 제외)
const SAFE_PKGMGR_SUB = new Set(['list', 'ls', 'view', 'show', 'outdated', 'audit', 'config', 'help', 'doctor', 'info', 'why']);
// ClearCase cleartool 의 read-only 서브커맨드 (ls/desc/lshistory 등 — 파일/VOB 무변경)
const SAFE_CLEARTOOL_SUB = new Set([
  'ls', 'lsview', 'lstype', 'lsvob', 'lsstgloc', 'lspool', 'lscheckout', 'lsco',
  'lshistory', 'lshist', 'lsactivity', 'lsstream', 'lsproject', 'lsbl', 'lsbaseline',
  'describe', 'desc', 'catcs', 'cat', 'pwv', 'pwd', 'find', 'diff', 'annotate', 'ann',
  'getlog', 'getcache', 'help', 'man', 'hostinfo', 'space', 'host',
]);
// ClearCase 단축/alias 명령들 — 사용자가 만든 ct/act 계열 alias 는 거의 다 write 작업.
// (ct=cleartool, co=checkout, ci=checkin, cocr=checkout reserved, unco=uncheckout, mkelem 등)
// 안전 측면에서 base 명령이 이 패턴에 매칭되면 무조건 승인 요청.
const CT_WRITE_ALIAS_RE = /^a?ct(?:co|ci|cocr|cor|unco|mkelem|mkdir|rmname|rmver|rm|mv|ln|merge|deliver|rebase|mklabel|rmlabel|mkattr|rmattr|mktype|rmtype|mktrigger|rmtrigger|protect|setcs|update|mkview|rmview|lock|unlock|chevent|chmaster|chactivity|chstream|chproject|setplevel|setvalue|chtype|chpool)$/i;

function isSafeSegment(seg) {
  // 한 파이프라인 segment 검사 — "cmd arg1 arg2 ..."
  const trimmed = seg.trim();
  if (!trimmed) return true;
  // 리다이렉트 토큰 검출 — >, >>, &>, 2>, |& (tee/dd 등 화이트리스트에 없으므로 우리 화이트리스트 한정에선 >>/| 만 위험)
  // 단순 검출: 쉘 quoting 안의 > 도 잡지만 안전 측면에서 OK (의심스러우면 거부)
  if (/(^|[^&\\])(>|>>|>&|2>|&>)/.test(trimmed)) return false;
  // sudo / nohup / time / env VAR=x prefix 처리 — prefix 만 떼고 다음 토큰 재검사
  const noPrefix = trimmed.replace(/^(sudo\s+(-[^\s]+\s+)*|nohup\s+|time\s+|stdbuf\s+(-[^\s]+\s+)*|nice\s+(-n\s+\d+\s+)?|ionice\s+(-[^\s]+\s+)*)+/, '');
  // env VAR=x cmd — 첫 토큰이 VAR=값 패턴이면 건너뜀
  const tokens = noPrefix.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  if (i >= tokens.length) return true;
  const base = tokens[i];
  const rest = tokens.slice(i + 1);
  // git <sub>
  if (base === 'git') return rest.length > 0 && SAFE_GIT_SUB.has(rest[0]);
  // npm/yarn/pnpm/bun <sub>
  if (base === 'npm' || base === 'yarn' || base === 'pnpm' || base === 'bun') return rest.length > 0 && SAFE_PKGMGR_SUB.has(rest[0]);
  // ClearCase: cleartool / ct (alias) — read-only 서브만 허용, 그 외 (co/ci/mkelem 등) 거부
  if (base === 'cleartool' || base === 'ct') return rest.length > 0 && SAFE_CLEARTOOL_SUB.has(rest[0]);
  // ClearCase 사용자 alias (ctco/ctci/ctcocr/actci/ctunco 등) — 무조건 승인 요청
  if (CT_WRITE_ALIAS_RE.test(base)) return false;
  // docker / kubectl 등은 매우 다양 — 보수적으로 거부 (필요 시 명시 승인)
  if (base === 'docker' || base === 'kubectl' || base === 'systemctl' || base === 'service') return false;
  // sed/awk: in-place 옵션 있으면 거부
  if (base === 'sed' && rest.some(t => t === '-i' || t.startsWith('-i'))) return false;
  if (base === 'awk' && rest.some(t => t === '-i' || t === '--in-place')) return false;
  // tee 는 항상 파일 쓰기
  if (base === 'tee') return false;
  // curl/wget: -o/-O 출력 파일 옵션 있으면 거부
  if (base === 'curl' && rest.some(t => t === '-o' || t === '-O' || t === '--output')) return false;
  if (base === 'wget' && rest.some(t => t === '-O' || t === '-o' || t === '--output-document')) return false;
  // node/python -e/-c 의 코드 내용은 평가 불가 — 보수적 거부
  if ((base === 'node' || base === 'python' || base === 'python3' || base === 'perl' || base === 'ruby') &&
      rest.some(t => t === '-e' || t === '-c')) return false;
  // 위 화이트리스트 외 거부
  return SAFE_BASE_CMDS.has(base);
}

function isReadOnlyShellCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return false;
  // 한 줄 안 ; && || | 로 묶인 파이프라인 → 각 segment 모두 안전해야 통과.
  // (셸 quoting 안의 | 도 잡지만 안전 측면에서 OK — 의심스러우면 거부)
  // 명령 치환 $(...) / 백틱은 보수적으로 거부
  if (/\$\(|`/.test(command)) return false;
  const segments = command.split(/\|\||&&|;|\|/);
  for (const s of segments) if (!isSafeSegment(s)) return false;
  return true;
}

let inputBuf = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', c => { inputBuf += c; });
process.stdin.on('end', () => {
  let event = {};
  try { event = JSON.parse(inputBuf); } catch (e) { log('parse err', e); process.exit(0); return; }
  const toolName = event.tool_name || event.toolName || 'unknown';
  const toolInput = event.tool_input || event.toolInput || {};

  // 읽기 전용 툴은 자동 허용 (사용자 피로도 감소)
  const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch']);
  if (READ_ONLY_TOOLS.has(toolName)) { process.exit(0); return; }

  // Bash/PowerShell/MCP ssh_exec 은 명령 내용을 분석해 read-only 면 자동 허용
  // (ls/cat/find/echo/grep/git status 등 — 파일/시스템 변경 없음)
  if (toolName === 'Bash' || toolName === 'PowerShell' || toolName === 'mcp__pepe_ssh__ssh_exec') {
    try {
      const cmd = String(toolInput.command || '').trim();
      if (cmd && isReadOnlyShellCommand(cmd)) {
        log('auto-allowed read-only shell:', cmd.slice(0, 80));
        process.exit(0); return;
      }
    } catch (e) { log('bash classify err', e); }
  }
  // MCP ssh_read 는 본질적으로 읽기 — 자동 허용
  if (toolName === 'mcp__pepe_ssh__ssh_read') { process.exit(0); return; }

  // 파괴적/편집 툴은 승인 요청
  log('requesting approval for', toolName);
  const sock = net.createConnection(CTRL_PORT, '127.0.0.1');
  let buf = '';
  sock.setEncoding('utf-8');
  let done = false;
  const finish = (decision, reason) => {
    if (done) return;
    done = true;
    try { sock.end(); } catch {}
    if (decision === 'allow') {
      // 허용 → exit 0 (아무 출력 없이 진행)
      process.exit(0);
    } else {
      // 거부 → exit 2 with stderr
      process.stderr.write(reason || 'User denied');
      process.exit(2);
    }
  };
  const to = setTimeout(() => finish('deny', 'User approval timeout'), TIMEOUT_MS);
  sock.on('connect', () => {
    const req = { id: Date.now(), token: CTRL_TOKEN, op: 'hook-approve', toolName, toolInput, sessionId: event.session_id };
    sock.write(JSON.stringify(req) + '\n');
  });
  sock.on('data', d => {
    buf += d;
    const idx = buf.indexOf('\n');
    if (idx < 0) return;
    const line = buf.slice(0, idx);
    try {
      const msg = JSON.parse(line);
      clearTimeout(to);
      if (msg.result === 'allow') finish('allow');
      else finish('deny', msg.reason || 'Denied');
    } catch (e) {
      clearTimeout(to);
      finish('deny', 'Bad response');
    }
  });
  sock.on('error', e => {
    clearTimeout(to);
    log('sock err', e);
    // 제어 서버 연결 실패 시 안전하게 허용 (사용자 환경 보호 목적으로 거부해도 됨)
    finish('allow');
  });
});
