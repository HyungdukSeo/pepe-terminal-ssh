#!/usr/bin/env node
// Minimal MCP stdio server exposing `ssh_exec` tool.
// Communicates with PePe main process via TCP control channel for actual SSH exec.
//
// Env vars:
//   PEPE_CTRL_PORT   - control TCP port
//   PEPE_CTRL_TOKEN  - auth token
//   PEPE_TERM_ID     - default SSH session termId

'use strict';

const net = require('net');

const CTRL_PORT = parseInt(process.env.PEPE_CTRL_PORT || '0', 10);
const CTRL_TOKEN = process.env.PEPE_CTRL_TOKEN || '';
const DEFAULT_TERM_ID = process.env.PEPE_TERM_ID || '';
// 멀티 SSH 세션 — [{id,label}]. 없으면 DEFAULT_TERM_ID 하나.
let SESSIONS = [];
try {
  const parsed = JSON.parse(process.env.PEPE_TERM_IDS || '[]');
  if (Array.isArray(parsed)) SESSIONS = parsed.filter(s => s && s.id);
} catch {}
if (SESSIONS.length === 0 && DEFAULT_TERM_ID) SESSIONS = [{ id: DEFAULT_TERM_ID, label: DEFAULT_TERM_ID }];
// session 인자(라벨 또는 id) → termId 해석. 미지정/미매칭 시 첫 세션.
function resolveTermId(sessionArg) {
  if (!sessionArg) return SESSIONS[0]?.id || DEFAULT_TERM_ID;
  const q = String(sessionArg).toLowerCase();
  const byId = SESSIONS.find(s => String(s.id).toLowerCase() === q);
  if (byId) return byId.id;
  const byLabel = SESSIONS.find(s => String(s.label || '').toLowerCase() === q);
  if (byLabel) return byLabel.id;
  const partial = SESSIONS.find(s => String(s.label || '').toLowerCase().includes(q));
  return partial ? partial.id : (SESSIONS[0]?.id || DEFAULT_TERM_ID);
}

const fs = require('fs');
const LOG_PATH = process.env.PEPE_LOG_PATH || '';
function log(...args) {
  const line = '[mcp-ssh ' + new Date().toISOString() + '] ' + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n';
  try { process.stderr.write(line); } catch {}
  if (LOG_PATH) { try { fs.appendFileSync(LOG_PATH, line); } catch {} }
}

// 단일 연결 유지하며 요청/응답 라인 기반으로 처리
let ctrlSock = null;
let pendingById = new Map();
let reqCounter = 0;

function ensureCtrl() {
  if (ctrlSock && !ctrlSock.destroyed) return Promise.resolve(ctrlSock);
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(CTRL_PORT, '127.0.0.1');
    let buf = '';
    sock.setEncoding('utf-8');
    sock.on('connect', () => { ctrlSock = sock; resolve(sock); });
    sock.on('error', (err) => { ctrlSock = null; reject(err); });
    sock.on('close', () => { ctrlSock = null; });
    sock.on('data', (d) => {
      buf += d;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          const h = pendingById.get(msg.id);
          if (h) { pendingById.delete(msg.id); h(msg); }
        } catch (e) { log('parse err', e); }
      }
    });
  });
}

// 제어 서버로 임의 op 요청 — 응답은 id 로 매칭. exec/sftp-read/sftp-write 공용.
function callOp(payload) {
  return new Promise(async (resolve, reject) => {
    try {
      const sock = await ensureCtrl();
      const id = ++reqCounter;
      pendingById.set(id, (msg) => {
        if (msg.error) return reject(new Error(msg.error));
        resolve(msg.result);
      });
      sock.write(JSON.stringify({ id, token: CTRL_TOKEN, ...payload }) + '\n');
    } catch (err) { reject(err); }
  });
}

function callExec(termId, command, timeoutMs) {
  return callOp({ op: 'exec', termId, command, timeoutMs });
}

// ── 단기 read 캐시 ── 같은 파일을 짧은 시간 안에 여러 번 읽는 경우(에이전트가
// 컨텍스트 재확인 등으로 흔히 반복) 원격 왕복을 줄인다. TTL 이 짧아(기본 4s)
// 외부 변경을 오래 가리지 않으며, ssh_write_file 은 즉시 무효화한다.
// ⚠ ssh_exec 로 sed -i 등 우회 수정 시엔 TTL 만료까지 stale 가능 — 짧게 유지.
const READ_CACHE_TTL_MS = 4000;
const READ_CACHE_MAX = 64;
const readCache = new Map(); // key → { text, expires }
function readCacheGet(key) {
  const e = readCache.get(key);
  if (!e) return null;
  if (Date.now() > e.expires) { readCache.delete(key); return null; }
  return e.text;
}
function readCacheSet(key, text) {
  // 너무 큰 파일은 캐시하지 않음 (메모리 보호)
  if (text == null || text.length > 256 * 1024) return;
  if (readCache.size >= READ_CACHE_MAX) {
    const oldest = readCache.keys().next().value;
    if (oldest !== undefined) readCache.delete(oldest);
  }
  readCache.set(key, { text, expires: Date.now() + READ_CACHE_TTL_MS });
}
function readCacheInvalidate(key) { readCache.delete(key); }

// ── MCP stdio JSON-RPC protocol ──
// Claude Code 가 컨텍스트 전환/재연결 시 MCP 서버의 stdout 파이프를 닫으면
// 다음 write 가 Windows 에서 EPIPE("nonexistent pipe") 를 던져 프로세스가 죽고,
// 이후 Claude 가 죽은 프로세스 stdin 에 쓰면 같은 오류가 사용자에게 노출됨.
// → write 를 try/catch 로 감싸고, stdout error 이벤트도 삼켜서 조용히 종료만 한다.
let stdoutBroken = false;
try {
  process.stdout.on('error', (err) => {
    if (err && (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED')) {
      stdoutBroken = true;
      try { process.exit(0); } catch (_) {}
    }
  });
} catch (_) {}
function sendMsg(msg) {
  if (stdoutBroken) return;
  try {
    const json = JSON.stringify(msg);
    process.stdout.write(json + '\n');
  } catch (err) {
    if (err && (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED')) {
      stdoutBroken = true;
      try { process.exit(0); } catch (_) {}
      return;
    }
    // 기타 직렬화 오류 등은 무시 (프로세스 유지)
  }
}

// 원격 경로를 셸에 안전하게 넣기 (단일따옴표 escape)
function shq(p) { return "'" + String(p).replace(/'/g, "'\\''") + "'"; }

const MULTI = SESSIONS.length > 1;
const sessionHint = MULTI
  ? ` Multiple SSH sessions are connected: ${SESSIONS.map(s => s.label).join(', ')}. Use the "session" argument (label or id) to pick which host; omit to use the first (${SESSIONS[0] && SESSIONS[0].label}). Call ssh_list_sessions to see all.`
  : '';
const sessionProp = { session: { type: 'string', description: 'Which SSH session to target — its label or id. Omit to use the first/default session.' } };

const TOOLS = [
  {
    name: 'ssh_exec',
    description: 'Execute a shell command on the remote SSH server and return stdout/stderr/exit code. Use for commands that must run on the remote Linux host (cleartool, git, make, grep, find, ls, sed, awk, etc.).' + sessionHint,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute on remote SSH. Example: "ctco /view/.../file.c" or "ls -la /tmp"' },
        timeout_ms: { type: 'number', description: 'Max wait in milliseconds (default 60000)' },
        ...sessionProp,
      },
      required: ['command'],
    },
  },
  {
    name: 'ssh_read_file',
    description: 'Read the full contents of a file on the remote SSH server. Use this to read remote files (binary-safe via base64 transport).' + sessionHint,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the file on the remote host. Example: "/view/.../TraceJob.c"' },
        ...sessionProp,
      },
      required: ['path'],
    },
  },
  {
    name: 'ssh_write_file',
    description: 'Write (create or overwrite) a file on the remote SSH server with the given text content. Use this to save edits to remote files.' + sessionHint,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the file on the remote host.' },
        content: { type: 'string', description: 'Full text content to write to the file.' },
        ...sessionProp,
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'ssh_grep',
    description: 'Search file CONTENTS on the remote SSH server (like grep -rn). Returns matching lines as "path:line: text". Use instead of a local Grep tool for remote files.' + sessionHint,
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for (passed to grep -E).' },
        path: { type: 'string', description: 'Directory or file to search under (remote absolute path). Default current dir.' },
        glob: { type: 'string', description: 'Optional filename filter, e.g. "*.c" (grep --include).' },
        ignore_case: { type: 'boolean', description: 'Case-insensitive search.' },
        max_results: { type: 'number', description: 'Max matching lines to return (default 200).' },
        ...sessionProp,
      },
      required: ['pattern'],
    },
  },
  {
    name: 'ssh_glob',
    description: 'Find FILES by name pattern on the remote SSH server (like find -name). Returns matching file paths. Use instead of a local Glob tool for remote files.' + sessionHint,
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Filename glob, e.g. "*.c" or "**/*.java" (matched against the file name).' },
        path: { type: 'string', description: 'Base directory to search under (remote absolute path). Default current dir.' },
        max_results: { type: 'number', description: 'Max file paths to return (default 200).' },
        ...sessionProp,
      },
      required: ['pattern'],
    },
  },
  ...(MULTI ? [{
    name: 'ssh_list_sessions',
    description: 'List the connected SSH sessions available for ssh_exec/ssh_read_file/ssh_write_file. Returns each session label and id; pass label/id as the "session" argument to target a specific host.',
    inputSchema: { type: 'object', properties: {} },
  }] : []),
];

function handleMessage(msg) {
  const { id, method, params } = msg;
  log('rx', method, id);

  if (method === 'initialize') {
    sendMsg({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'pepe_ssh', version: '1.0.0' },
      },
    });
    return;
  }
  if (method === 'notifications/initialized') return; // notify, no reply

  if (method === 'tools/list') {
    sendMsg({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    if (!DEFAULT_TERM_ID) {
      sendMsg({ jsonrpc: '2.0', id, error: { code: -32000, message: 'No SSH session configured (PEPE_TERM_ID missing)' } });
      return;
    }
    const ok = (text, isError) => sendMsg({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: !!isError } });
    const fail = (msg2) => sendMsg({ jsonrpc: '2.0', id, error: { code: -32000, message: String(msg2) } });
    // 이 호출의 대상 termId — session 인자(라벨/id) 로 해석
    const termId = resolveTermId(args.session);

    if (name === 'ssh_list_sessions') {
      const text = SESSIONS.map((s, i) => `${i + 1}. ${s.label}${i === 0 ? ' (default)' : ''}`).join('\n') || '(none)';
      ok('Connected SSH sessions:\n' + text);
      return;
    }

    if (name === 'ssh_exec') {
      const command = String(args.command || '');
      const timeoutMs = Number(args.timeout_ms) || 60000;
      if (!command.trim()) { sendMsg({ jsonrpc: '2.0', id, error: { code: -32602, message: 'command is required' } }); return; }
      callExec(termId, command, timeoutMs)
        .then(result => {
          const text = `$ ${command}\n\n[stdout]\n${result.stdout || '(empty)'}\n\n[stderr]\n${result.stderr || '(empty)'}\n\n[exit code] ${result.exitCode}`;
          ok(text, result.exitCode !== 0 && result.exitCode !== null);
        })
        .catch(fail);
      return;
    }

    if (name === 'ssh_read_file') {
      const p = String(args.path || '');
      if (!p.trim()) { sendMsg({ jsonrpc: '2.0', id, error: { code: -32602, message: 'path is required' } }); return; }
      const cacheKey = `${termId}:${p}`;
      const cached = readCacheGet(cacheKey);
      if (cached != null) { ok(cached); return; }
      // SFTP 직접 읽기 — 셸 rc·base64 인플레이션 없이 바이너리 안전 전송
      callOp({ op: 'sftp-read', termId, path: p })
        .then(result => {
          let text;
          const buf = Buffer.from(String(result.base64 || ''), 'base64');
          try {
            text = buf.toString('utf-8');
            // utf-8 디코드 실패 문자(U+FFFD)가 있으면 EUC-KR(CP949) 로 재디코드해 더 적게 깨지는 쪽 채택
            if (text.indexOf('�') >= 0) {
              try {
                const k = new TextDecoder('euc-kr').decode(buf);
                const cU = (text.match(/�/g) || []).length;
                const cK = (k.match(/�/g) || []).length;
                if (cK < cU) text = k;
              } catch (_) { /* TextDecoder euc-kr 미지원 → utf-8 유지 */ }
            }
          } catch { text = buf.toString('utf-8'); }
          readCacheSet(cacheKey, text);
          ok(text);
        })
        // 읽기 실패(없는 파일/권한 등)는 프로토콜 에러 대신 content 에러로 — 에이전트가 더 잘 처리
        .catch(err => ok(`Failed to read ${p}: ${err && err.message ? err.message : String(err)}`, true));
      return;
    }

    if (name === 'ssh_write_file') {
      const p = String(args.path || '');
      if (!p.trim()) { sendMsg({ jsonrpc: '2.0', id, error: { code: -32602, message: 'path is required' } }); return; }
      const content = String(args.content != null ? args.content : '');
      const b64 = Buffer.from(content, 'utf-8').toString('base64');
      // SFTP writeFile — heredoc exec 대신 직접 기록
      callOp({ op: 'sftp-write', termId, path: p, base64: b64 })
        .then(result => {
          readCacheInvalidate(`${termId}:${p}`); // 쓰기 후 캐시 무효화
          ok(`Wrote ${result.bytes != null ? result.bytes : Buffer.byteLength(content, 'utf-8')} bytes to ${p}`);
        })
        .catch(err => ok(`Failed to write ${p}: ${err && err.message ? err.message : String(err)}`, true));
      return;
    }

    if (name === 'ssh_grep') {
      const pattern = String(args.pattern || '');
      if (!pattern.trim()) { sendMsg({ jsonrpc: '2.0', id, error: { code: -32602, message: 'pattern is required' } }); return; }
      const base = String(args.path || '.');
      const max = Math.max(1, Math.min(2000, Number(args.max_results) || 200));
      const ic = args.ignore_case ? '-i ' : '';
      const inc = args.glob ? `--include=${shq(String(args.glob))} ` : '';
      // -rnI: 재귀+줄번호+바이너리 무시. 2>/dev/null 로 권한오류 잡음 제거. head 로 결과 캡.
      const cmd = `grep -rnI ${ic}-E ${inc}-e ${shq(pattern)} ${shq(base)} 2>/dev/null | head -n ${max}`;
      callExec(termId, cmd, 60000)
        .then(result => {
          const out = String(result.stdout || '').trimEnd();
          ok(out ? out : `(no matches for /${pattern}/ under ${base})`);
        })
        .catch(fail);
      return;
    }

    if (name === 'ssh_glob') {
      const pattern = String(args.pattern || '');
      if (!pattern.trim()) { sendMsg({ jsonrpc: '2.0', id, error: { code: -32602, message: 'pattern is required' } }); return; }
      const base = String(args.path || '.');
      const max = Math.max(1, Math.min(5000, Number(args.max_results) || 200));
      // "**/" 같은 디렉토리 와일드카드는 find -name 의 basename 매칭으로 단순화.
      const namePat = pattern.replace(/^.*\*\*\/+/, '').replace(/^.*\/+/, '') || pattern;
      const globKey = `glob:${termId}:${base}:${namePat}:${max}`;
      const globCached = readCacheGet(globKey);
      if (globCached != null) { ok(globCached); return; }
      const cmd = `find ${shq(base)} -type f -name ${shq(namePat)} 2>/dev/null | head -n ${max}`;
      callExec(termId, cmd, 60000)
        .then(result => {
          const out = String(result.stdout || '').trimEnd();
          const text = out ? out : `(no files matching ${pattern} under ${base})`;
          readCacheSet(globKey, text);
          ok(text);
        })
        .catch(fail);
      return;
    }

    sendMsg({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } });
    return;
  }

  if (id !== undefined) {
    sendMsg({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } });
  }
}

// stdio line-delimited JSON 파싱
let inputBuf = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  inputBuf += chunk;
  let idx;
  while ((idx = inputBuf.indexOf('\n')) >= 0) {
    const line = inputBuf.slice(0, idx);
    inputBuf = inputBuf.slice(idx + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      handleMessage(msg);
    } catch (err) { log('bad input:', err, line.slice(0, 100)); }
  }
});

process.stdin.on('end', () => { process.exit(0); });
process.on('SIGTERM', () => process.exit(0));
// stdin 파이프가 닫히며 던지는 EPIPE/ECONNRESET 도 조용히 종료 (사용자 노출 방지)
process.stdin.on('error', () => { try { process.exit(0); } catch (_) {} });
// 최종 안전망 — 어디서든 뒤늦게 올라온 EPIPE 류는 삼키고, 그 외만 로깅
process.on('uncaughtException', (err) => {
  if (err && (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED' || err.code === 'ECONNRESET')) {
    try { process.exit(0); } catch (_) {}
    return;
  }
  try { log('uncaught:', err && (err.stack || err.message || err)); } catch (_) {}
});

log('ready', `port=${CTRL_PORT}`, `term=${DEFAULT_TERM_ID}`);
