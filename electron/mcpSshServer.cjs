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

function callExec(termId, command, timeoutMs) {
  return new Promise(async (resolve, reject) => {
    try {
      const sock = await ensureCtrl();
      const id = ++reqCounter;
      pendingById.set(id, (msg) => {
        if (msg.error) return reject(new Error(msg.error));
        resolve(msg.result);
      });
      sock.write(JSON.stringify({ id, token: CTRL_TOKEN, op: 'exec', termId, command, timeoutMs }) + '\n');
    } catch (err) { reject(err); }
  });
}

// ── MCP stdio JSON-RPC protocol ──
function sendMsg(msg) {
  const json = JSON.stringify(msg);
  process.stdout.write(json + '\n');
}

// 원격 경로를 셸에 안전하게 넣기 (단일따옴표 escape)
function shq(p) { return "'" + String(p).replace(/'/g, "'\\''") + "'"; }

const TOOLS = [
  {
    name: 'ssh_exec',
    description: 'Execute a shell command on the remote SSH server and return stdout/stderr/exit code. Use for commands that must run on the remote Linux host (cleartool, git, make, grep, find, ls, sed, awk, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute on remote SSH. Example: "ctco /view/.../file.c" or "ls -la /tmp"' },
        timeout_ms: { type: 'number', description: 'Max wait in milliseconds (default 60000)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'ssh_read_file',
    description: 'Read the full contents of a file on the remote SSH server. Use this to read remote files (binary-safe via base64 transport).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the file on the remote host. Example: "/view/.../TraceJob.c"' },
      },
      required: ['path'],
    },
  },
  {
    name: 'ssh_write_file',
    description: 'Write (create or overwrite) a file on the remote SSH server with the given text content. Use this to save edits to remote files.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the file on the remote host.' },
        content: { type: 'string', description: 'Full text content to write to the file.' },
      },
      required: ['path', 'content'],
    },
  },
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

    if (name === 'ssh_exec') {
      const command = String(args.command || '');
      const timeoutMs = Number(args.timeout_ms) || 60000;
      if (!command.trim()) { sendMsg({ jsonrpc: '2.0', id, error: { code: -32602, message: 'command is required' } }); return; }
      callExec(DEFAULT_TERM_ID, command, timeoutMs)
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
      // base64 로 전송 → 인코딩/바이너리 안전
      callExec(DEFAULT_TERM_ID, `base64 ${shq(p)}`, 60000)
        .then(result => {
          if (result.exitCode !== 0 && result.exitCode !== null) {
            ok(`Failed to read ${p}:\n${result.stderr || '(no stderr)'}`, true);
            return;
          }
          let text;
          try { text = Buffer.from(String(result.stdout || '').replace(/\s+/g, ''), 'base64').toString('utf-8'); }
          catch { text = String(result.stdout || ''); }
          ok(text);
        })
        .catch(fail);
      return;
    }

    if (name === 'ssh_write_file') {
      const p = String(args.path || '');
      if (!p.trim()) { sendMsg({ jsonrpc: '2.0', id, error: { code: -32602, message: 'path is required' } }); return; }
      const content = String(args.content != null ? args.content : '');
      const b64 = Buffer.from(content, 'utf-8').toString('base64');
      // heredoc 으로 base64 전달 → base64 -d 로 디코드해 파일에 기록 (셸 escape 안전)
      const cmd = `base64 -d > ${shq(p)} <<'PEPE_B64_EOF'\n${b64}\nPEPE_B64_EOF`;
      callExec(DEFAULT_TERM_ID, cmd, 60000)
        .then(result => {
          if (result.exitCode !== 0 && result.exitCode !== null) {
            ok(`Failed to write ${p}:\n${result.stderr || '(no stderr)'}`, true);
            return;
          }
          ok(`Wrote ${Buffer.byteLength(content, 'utf-8')} bytes to ${p}`);
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

log('ready', `port=${CTRL_PORT}`, `term=${DEFAULT_TERM_ID}`);
