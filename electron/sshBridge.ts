// electron/sshBridge.ts
import { Client } from 'ssh2';
import { EventEmitter } from 'events';
import { Worker } from 'worker_threads';
import net from 'net';
import tls from 'tls';
import fs from 'fs';
import path from 'path';
import iconv from 'iconv-lite';

// ssh2 의 기본 KEX/Cipher 목록은 modern 만 포함 — 레거시 서버(예: 구버전 OpenSSH,
// 임베디드, Solaris/RHEL5) 는 diffie-hellman-group14-sha1 / ssh-rsa 만 제공해 negotiate 실패함.
// SUPPORTED_* 는 ssh2 가 현재 시스템 crypto 기준으로 이미 필터한 안전 목록이라 그대로 허용해도 무방.
// 모든 connect 경로(메인 SSH/jump primary/dedicated SFTP 등)에서 이 객체를 spread.
const LEGACY_ALGO_OPT = (() => {
  try {
    const c = require('ssh2/lib/protocol/constants');
    return {
      algorithms: {
        kex: c.SUPPORTED_KEX,
        serverHostKey: c.SUPPORTED_SERVER_HOST_KEY,
        cipher: c.SUPPORTED_CIPHER,
        hmac: c.SUPPORTED_MAC,
      },
    } as any;
  } catch { return {} as any; }
})();
import type { LoginScriptRule } from './sessionsStore';
import { startEmbeddedX11 } from './x11Server';
import { startBundledX11 } from './x11Bundled';

// 로컬 X 서버 (Windows VcXsrv / X410 등) 로 X11 채널 forward.
// 표준: TCP localhost:6000+display_num. display 0 가 기본.
function setupX11Forwarding(conn: any, displayNum = 0, emit?: (msg: string) => void) {
  conn.on('x11', (_info: any, accept: any, _reject: any) => {
    const xstream = accept();
    const port = 6000 + displayNum;
    const xclient = net.connect(port, '127.0.0.1', () => {
      // 양방향 파이프
      xstream.pipe(xclient).pipe(xstream);
    });
    xclient.on('error', (err: any) => {
      try { xstream.end(); } catch {}
      emit?.(`X11: 로컬 X 서버 연결 실패 (localhost:${port}). VcXsrv/X410 설치/실행 필요. ${err.message}`);
    });
    xstream.on('error', () => { try { xclient.end(); } catch {} });
    xstream.on('close', () => { try { xclient.end(); } catch {} });
  });
}

function quoteShellArg(value: string): string {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

interface ClientRecord {
  conn: any;           // 활성 SSH 연결 (점프 미사용 시 primary, 사용 시 최종 점프 conn)
  stream?: any;
  encoding?: string;
  primaryConn?: any;   // 점프 사용 시 transport 로 쓰이는 primary 연결 (세션 종료 시 함께 해제)
  transportConns?: any[]; // 다단계 점프 시 거쳐가는 모든 중간 transport 연결 (primary 포함) — 종료 시 전부 해제
}

interface BridgeMessage {
  type: 'data' | 'connected' | 'closed' | 'error' | 'auth-prompt' | 'sftp-progress' | 'sftp-complete' | 'sftp-error' | 'sftp-transfer-start' | 'sftp-file-start' | 'sftp-dir-list' | 'sftp-conflict' | 'auto-track' | 'pwd' | 'x11-log' | 'sftp-delete-start' | 'sftp-delete-progress' | 'sftp-delete-complete';
  panelId: string;
  data?: string;
  error?: string;
  prompts?: string[];
  enabled?: boolean;
}

class SSHBridge extends EventEmitter {
  private clients: Map<string, ClientRecord> = new Map();
  // 연결 중(아직 ready 안 된) Client — handleDisconnect 가 찾을 수 있도록 별도 추적.
  // ready 시점에 삭제 + clients 에 등록. error 시에도 삭제.
  private pendingConnects: Map<string, any> = new Map();
  private sftpCache: Map<string, any> = new Map();
  // 전송 전용 별도 SSH 연결 — 터미널 채널과 분리해 전송 중 터미널 지연 방지
  private sessionStore: Map<string, any> = new Map();        // panelId → session
  private sftpDedicatedConn: Map<string, any> = new Map();   // panelId → Client
  private sftpDedicatedSubsys: Map<string, any> = new Map(); // panelId → sftp subsystem
  // Worker thread — SFTP I/O를 별도 스레드에서 처리 (메인 이벤트 루프 보호)
  private sftpWorkers: Map<string, Worker> = new Map();
  private sftpWorkerReqs: Map<string, Map<string, { onProgress:(t:number,total:number)=>void; resolve:()=>void; reject:(e:Error)=>void }>> = new Map();
  // sftp-op 결과 대기 — tree-size/tree-list 등 worker batch 연산용
  private sftpWorkerOps: Map<string, Map<string, { resolve:(r:any)=>void; reject:(e:Error)=>void }>> = new Map();
  // 생성 중인 worker promise — 동일 panelId로 중복 생성 방지
  private sftpWorkerPromises: Map<string, Promise<Worker>> = new Map();
  private scriptRunners: Map<string, ExpectSendRunner> = new Map();
  private pendingAuth: Map<string, (responses: string[]) => void> = new Map();
  // panelId → AI 에이전트(handleExec/SFTP) 진행 중 카운트 + 마지막 활동 시각.
  // cwd 폴러가 에이전트 작업 중에는 양보(스킵)하도록 — 공유 SSH 연결 경합·채널 고갈 방지.
  private agentBusy: Map<string, { count: number; lastAt: number }> = new Map();
  // 파일 충돌(이미 존재) 시 사용자 응답 대기
  private conflictResolvers: Map<string, (decision: any) => void> = new Map();
  // 전송별 "모두 적용" 기본 결정 — { [transferId]: { file?: 'overwrite'|'skip'|'resume', dir?: 'overwrite'|'skip' } }
  private transferDefaults: Map<string, { file?: string; dir?: string }> = new Map();
  // 워크스페이스 단위 "모두 적용" 기본값 — 연속된 드래그/드롭(transferId 가 매번 새로 생성됨)에도 기억.
  // 마지막 사용 후 TTL(기본 60초) 동안만 유효 → 한참 뒤 새 전송은 다시 묻도록.
  private workspaceConflictDefaults: Map<string, { file?: string; dir?: string; lastUsed: number }> = new Map();
  private readonly WORKSPACE_DEFAULT_TTL_MS = 60_000;
  private getWorkspaceConflictDefault(workspaceId: string | undefined, kind: 'file' | 'dir'): string | undefined {
    if (!workspaceId) return undefined;
    const entry = this.workspaceConflictDefaults.get(workspaceId);
    if (!entry) return undefined;
    if (Date.now() - entry.lastUsed > this.WORKSPACE_DEFAULT_TTL_MS) {
      this.workspaceConflictDefaults.delete(workspaceId);
      return undefined;
    }
    return entry[kind];
  }
  private setWorkspaceConflictDefault(workspaceId: string | undefined, kind: 'file' | 'dir', action: string) {
    if (!workspaceId) return;
    const cur = this.workspaceConflictDefaults.get(workspaceId) || { lastUsed: Date.now() };
    cur[kind] = action;
    cur.lastUsed = Date.now();
    this.workspaceConflictDefaults.set(workspaceId, cur);
  }
  // 충돌 다이얼로그 직렬화 뮤텍스 — 병렬 전송 시 다이얼로그가 동시에 뜨는 것 방지
  private conflictLock: Map<string, Promise<void>> = new Map();
  // 사용자가 취소(cancel) 한 transferId
  private cancelledTransfers: Set<string> = new Set();

  public resolveConflict(requestId: string, decision: any) {
    const fn = this.conflictResolvers.get(requestId);
    if (fn) {
      this.conflictResolvers.delete(requestId);
      fn(decision);
    }
  }

  // 전송 취소 — UI 에서 "제거" 동작 시 호출. 폴더 전송 시 다음 child 부터 중단됨.
  public cancelTransfer(transferId: string) {
    this.cancelledTransfers.add(transferId);
    // 충돌 다이얼로그 대기 중이면 cancel 응답으로 깨움
    for (const [reqId, resolver] of this.conflictResolvers.entries()) {
      this.conflictResolvers.delete(reqId);
      resolver({ cancel: true });
    }
    this.emit('message', { type: 'sftp-complete', panelId: 'transfer', data: JSON.stringify({ filename: '', direction: 'cancelled', transferId, rel: '', rootName: '' }) });
  }

  // 충돌 다이얼로그 뮤텍스 — 한 번에 하나의 다이얼로그만 표시
  private async acquireConflictLock(transferId: string): Promise<() => void> {
    // 이전 락이 풀릴 때까지 대기
    while (this.conflictLock.has(transferId)) {
      try { await this.conflictLock.get(transferId); } catch {}
    }
    let release!: () => void;
    this.conflictLock.set(transferId, new Promise<void>(res => { release = res; }));
    return () => { this.conflictLock.delete(transferId); release(); };
  }

  private requestConflictDecision(meta: any): Promise<any> {
    const requestId = `cf-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    return new Promise((resolve) => {
      this.conflictResolvers.set(requestId, resolve);
      this.emit('message', { type: 'sftp-conflict', panelId: 'transfer', data: JSON.stringify({ requestId, ...meta }) });
    });
  }

  // 대상이 존재하는지 + 정보 반환
  private async dstStat(dst: { mode: string; termId?: string; path: string }): Promise<{ exists: boolean; isDir: boolean; size: number; mtime: number }> {
    try {
      if (dst.mode === 'local') {
        const s = await fs.promises.stat(dst.path);
        return { exists: true, isDir: s.isDirectory(), size: s.size, mtime: Math.floor(s.mtimeMs / 1000) };
      } else {
        if (dst.termId && this.sftpWorkers.has(dst.termId)) {
          const s = await this.workerOp(dst.termId, 'stat', dst.path);
          const isDir = !!(s && s.mode && (s.mode & 0o170000) === 0o040000);
          return { exists: true, isDir, size: s.size, mtime: s.mtime };
        }
        const sftp = await this.getDedicatedSftp(dst.termId!);
        const s: any = await new Promise((res, rej) => sftp.stat(dst.path, (e: any, st: any) => e ? rej(e) : res(st)));
        return { exists: true, isDir: s.isDirectory(), size: s.size, mtime: s.mtime };
      }
    } catch { return { exists: false, isDir: false, size: 0, mtime: 0 }; }
  }

  // 충돌 해결시 새 경로(rename) 생성
  private renameDstPath(dst: { mode: string; termId?: string; path: string }, newName: string): { mode: string; termId?: string; path: string } {
    const sep = dst.mode === 'local' ? path.sep : '/';
    const parent = dst.path.includes(sep) ? dst.path.slice(0, dst.path.lastIndexOf(sep)) : '';
    const newPath = parent ? parent + sep + newName : newName;
    return { ...dst, path: newPath };
  }

  onMessage(fn: (m: BridgeMessage) => void) {
    this.on('message', fn);
    return () => this.off('message', fn);
  }

  async handleConnect(panelId: string, session: any, cols?: number, rows?: number) {
    if (this.clients.has(panelId)) return;
    // 세션 정보 저장 (전송 전용 SSH 연결 재생성용)
    this.sessionStore.set(panelId, session);
    // 이전 pending 연결이 있으면 먼저 정리 (retry 시 이중 연결 방지)
    const prev = this.pendingConnects.get(panelId);
    if (prev) {
      try { prev.end(); } catch {}
      this.pendingConnects.delete(panelId);
    }

    const conn = new Client();
    this.pendingConnects.set(panelId, conn);

    // 연결 진행 상황을 터미널에 출력하는 헬퍼
    const logLine = (color: string, msg: string) => {
      this.emit('message', { type: 'data', panelId, data: `\r\n\x1b[${color}m${msg}\x1b[0m\r\n` });
    };
    const logInline = (color: string, msg: string) => {
      this.emit('message', { type: 'data', panelId, data: `\x1b[${color}m${msg}\x1b[0m` });
    };

    logLine('96', `▶ ${session.host}:${session.port || 22} (${session.username}) 연결 중...`);

    conn.on('handshake', () => logInline('90', '  [handshake OK] '));
    conn.on('banner', () => logInline('90', '[banner] '));

    conn.on('ready', async () => {
      this.pendingConnects.delete(panelId);
      logInline('92', '[SSH 연결 완료]\r\n');
      this.emit('message', { type: 'connected', panelId });
      const jumps = this._normalizeJumps(session);
      if (jumps.length > 0) {
        logLine('96', `▶ 점프 체인 (${jumps.length}단계): ${jumps.map(j => `${j.host}:${j.port}`).join(' → ')} 연결 중...`);
        try {
          await this._setupJumpedSession(panelId, session, conn, cols, rows);
        } catch (err: any) {
          logLine('91', `✕ 점프 호스트 연결 실패: ${err?.message || String(err)}`);
          this.emit('message', { type: 'error', panelId, error: `점프 호스트 연결 실패: ${err?.message || String(err)}` });
          try { conn.end(); } catch {}
        }
      } else {
        this._openShellOnConn(panelId, session, conn, cols, rows, undefined);
      }
    });

    conn.on('error', (err: any) => {
      console.log(`[ssh-error] panelId=${panelId} host=${session?.host} msg=${err?.message || err} code=${err?.code || ''} level=${err?.level || ''}`);
      try { require('electron').BrowserWindow.getAllWindows()[0]?.webContents.send('debug:log', `[ssh-error] ${session?.host} ${err?.message || err}`); } catch {}
      this.pendingConnects.delete(panelId);
      this.clients.delete(panelId);
      this.sftpCache.delete(panelId);
      this.scriptRunners.delete(panelId);
      this._cleanupDedicatedSftp(panelId);
      logLine('91', `✕ 연결 오류: ${err?.message || String(err)}`);
      this.emit('message', { type: 'error', panelId, error: String(err) });
    });

    const cfg: any = {
      host: session.host,
      port: session.port || 22,
      username: session.username,
      tryKeyboard: true,
      readyTimeout: 15000,
      keepaliveInterval: 10000,
      keepaliveCountMax: 3,
      ...LEGACY_ALGO_OPT,
    } as any;

    // X11 forwarding 디버그 — ssh2 protocol 메시지 로깅
    if (session.x11Forward) {
      cfg.debug = (msg: string) => {
        // x11 관련 메시지만 필터
        if (msg.includes('x11') || msg.includes('X11')) {
          console.log(`[ssh2-debug] ${msg}`);
          this.emit('message', { type: 'x11-log', panelId, data: `[ssh2] ${msg}` });
        }
      };
    }

    if (session.auth?.type === 'password' && session.auth.password) {
      cfg.password = session.auth.password;
    } else if (session.auth?.type === 'key') {
      try {
        cfg.privateKey = fs.readFileSync(session.auth.keyPath);
      } catch {
        // key file not found - connect will fail with auth error
      }
    }

    // keyboard-interactive 인증 지원 (비밀번호 미저장 세션용)
    conn.on('keyboard-interactive', (_name: string, _instructions: string, _lang: string, prompts: any[], finish: (responses: string[]) => void) => {
      // 비밀번호가 있으면 자동 응답, 없으면 빈 응답 (renderer에서 처리)
      if (cfg.password) {
        finish([cfg.password]);
      } else {
        // renderer에 비밀번호 요청
        this.emit('message', { type: 'auth-prompt', panelId, prompts: prompts.map((p: any) => p.prompt) });
        this.pendingAuth.set(panelId, finish);
      }
    });

    conn.connect(cfg);
  }

  // transport 연결 위에 TCP 터널 + 새 SSH 핸드셰이크를 1회 수행해서 점프 conn 을 만든다.
  // 비밀번호 비어 있으면 transport(이전 홉) 의 ~/.ssh/ 키를 SFTP 로 읽어 인증에 재사용.
  // 다단계 점프를 위해 1차/2차 홉이 이 함수를 공통으로 사용.
  private async _openJumpConnOverTransport(
    panelId: string, session: any, transportConn: any,
    hop: { host: string; user: string; port: number; password: string; keySourceLabel: string },
    stage: (n: string) => void, label: string,
  ): Promise<any> {
    // 1. 인증: 비밀번호 우선, 없으면 transport(이전 홉) 의 ~/.ssh/ 키 자동 사용
    const authCfg: any = {};
    if (hop.password) {
      authCfg.password = hop.password;
    } else {
      const keyBuf = await this._readSshKeyFromConn(transportConn);
      if (!keyBuf) {
        throw new Error(`${hop.keySourceLabel} 의 ~/.ssh/ 에서 사용 가능한 SSH 키(id_rsa/id_ed25519/id_ecdsa) 미발견. ${label} 비밀번호를 입력하거나 키 파일을 등록하세요.`);
      }
      authCfg.privateKey = keyBuf;
    }
    stage(`${label} key-read done`);

    // 2. transport 위에 TCP 포워딩 — 점프 타겟:port 로
    const sock: any = await new Promise((resolve, reject) => {
      transportConn.forwardOut('127.0.0.1', 0, hop.host, hop.port, (err: any, s: any) => {
        if (err) return reject(err);
        resolve(s);
      });
    });
    stage(`${label} forwardOut done`);
    sock.on('error', (e: any) => {
      console.log(`[jump-${panelId.slice(-6)}] ${label} tunnel sock error:`, e?.message || e);
    });

    // 3. 그 소켓 위에 새 SSH Client 연결 (레거시 알고리즘 허용)
    const ssh2Constants = require('ssh2/lib/protocol/constants');
    const LEGACY_ALGORITHMS = {
      kex: ssh2Constants.SUPPORTED_KEX,
      serverHostKey: ssh2Constants.SUPPORTED_SERVER_HOST_KEY,
      cipher: ssh2Constants.SUPPORTED_CIPHER,
      hmac: ssh2Constants.SUPPORTED_MAC,
    };
    const jumpConn = new Client();
    jumpConn.on('error', (e: any) => {
      console.log(`[jump-${panelId.slice(-6)}] ${label} conn error:`, e?.message || e);
      try { this.emit('message', { type: 'error', panelId, error: `${label} 연결 오류: ${e?.message || String(e)}` }); } catch {}
    });
    await new Promise<void>((resolve, reject) => {
      const onReady = () => { cleanup(); resolve(); };
      const wrappedErr = (e: any) => { cleanup(); reject(e); };
      const cleanup = () => { jumpConn.removeListener('ready', onReady); jumpConn.removeListener('error', wrappedErr); };
      jumpConn.once('ready', onReady);
      jumpConn.once('error', wrappedErr);
      const x11Debug = session.x11Forward ? (msg: string) => {
        if (msg.includes('x11') || msg.includes('X11')) {
          console.log(`[ssh2-jump] ${msg}`);
          this.emit('message', { type: 'x11-log', panelId, data: `[ssh2-jump] ${msg}` });
        }
      } : undefined;
      jumpConn.connect({
        sock,
        username: hop.user,
        ...authCfg,
        algorithms: LEGACY_ALGORITHMS,
        tryKeyboard: !!hop.password,
        readyTimeout: 30000,
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
        debug: x11Debug,
      } as any);
    });
    stage(`${label} ready`);
    return jumpConn;
  }

  // 세션의 점프 체인을 정규화된 배열로 반환. host 있는 항목만, 첫 빈 host 에서 종료.
  private _normalizeJumps(session: any): { host: string; user: string; port: number; password: string }[] {
    const out: { host: string; user: string; port: number; password: string }[] = [];
    const arr = Array.isArray(session?.jumps) ? session.jumps : [];
    for (const j of arr) {
      const host = typeof j?.host === 'string' ? j.host.trim() : '';
      if (!host) break;
      out.push({
        host,
        user: (typeof j?.user === 'string' && j.user.trim()) ? j.user.trim() : 'root',
        port: Number(j?.port) || 22,
        password: typeof j?.password === 'string' ? j.password : '',
      });
    }
    return out;
  }

  // 점프 체인 설정: primary 위에서 jumps[] 를 순서대로 터널링해 최종 호스트까지 연결 후 셸 오픈.
  // 각 홉의 비밀번호가 비어 있으면 직전 홉의 ~/.ssh/ 키를 재사용 (passwordless 설정 활용).
  // 거쳐가는 모든 중간 연결(primary 포함)을 transportConns 로 보관해 종료 시 전부 해제.
  private async _setupJumpedSession(panelId: string, session: any, primaryConn: any, cols?: number, rows?: number): Promise<void> {
    const t0 = Date.now();
    const stage = (name: string) => {
      const msg = `[jump-${panelId.slice(-6)}] ${name} +${Date.now() - t0}ms`;
      console.log(msg);
      try { require('electron').BrowserWindow.getAllWindows()[0]?.webContents.send('debug:log', msg); } catch {}
    };
    stage('start');

    const hops = this._normalizeJumps(session);
    // 거쳐가는 transport 연결 추적 (종료 시 전부 해제). primary 가 가장 바깥.
    const transportConns: any[] = [primaryConn];
    let transport = primaryConn;          // 다음 홉이 터널링할 직전 연결
    let keySourceLabel = session.host;    // 비밀번호 없을 때 키를 읽을 직전 호스트 이름
    let finalConn = primaryConn;

    for (let i = 0; i < hops.length; i++) {
      const hop = hops[i];
      try {
        const conn = await this._openJumpConnOverTransport(panelId, session, transport, {
          host: hop.host, user: hop.user, port: hop.port, password: hop.password, keySourceLabel,
        }, stage, `${i + 1}단계 점프`);
        finalConn = conn;
        // 마지막 홉이 아니면 이 conn 도 이후 홉의 transport — 정리 목록에 추가
        if (i < hops.length - 1) transportConns.push(conn);
        transport = conn;
        keySourceLabel = hop.host;
      } catch (err) {
        // 실패 — 지금까지 연 모든 중간 연결 정리 후 전파 (primary 는 호출부에서 정리)
        for (const tc of transportConns) { if (tc !== primaryConn) { try { tc.end(); } catch {} } }
        throw err;
      }
    }

    // 최종 점프 타겟에서 shell + SFTP.
    this._openShellOnConn(panelId, session, finalConn, cols, rows, primaryConn, transportConns);
  }

  private async _readSshKeyFromConn(conn: any): Promise<Buffer | null> {
    const sftp: any = await new Promise((resolve, reject) => {
      conn.sftp((err: any, s: any) => err ? reject(err) : resolve(s));
    });
    const candidates = ['.ssh/id_rsa', '.ssh/id_ed25519', '.ssh/id_ecdsa'];
    // 병렬 시도 — 네트워크 왕복 1회 만큼의 시간에 모든 후보 확인
    const attempts = candidates.map(rel => new Promise<Buffer | null>((resolve) => {
      sftp.readFile(rel, (err: any, d: Buffer) => {
        if (err || !d || d.length === 0) return resolve(null);
        resolve(d);
      });
    }));
    const results = await Promise.all(attempts);
    // id_rsa 우선순위 — 먼저 나타난 non-null 반환
    for (const r of results) { if (r) return r; }
    return null;
  }

  // 주어진 연결 위에 shell 을 열고 스트림·핸들러 연결. jump 사용 시 transportConns(거쳐온 모든
  // 중간 연결, primary 포함)도 함께 받아 close 시 전부 정리. primaryConn 은 하위호환용(단일).
  private _openShellOnConn(panelId: string, session: any, conn: any, cols: number | undefined, rows: number | undefined, primaryConn: any | undefined, transportConns?: any[]): void {
    const shellCols = typeof cols === 'number' ? cols : 120;
    const shellRows = typeof rows === 'number' ? rows : 24;
    this.termCols.set(panelId, shellCols);

    // X11 forwarding 옵션 — 세션 설정에 따라 enable
    const x11Enabled = !!session.x11Forward;
    const x11Display = typeof session.x11Display === 'number' ? session.x11Display : 0;
    const log = (msg: string) => {
      console.log(`[x11] ${msg}`);
      this.emit('message', { type: 'x11-log', panelId, data: msg });
    };
    if (x11Enabled) {
      // ⚠️ 중요: setupX11Forwarding (conn.on('x11') 핸들러 등록) 은 conn.shell() 호출 전에
      // 동기적으로 완료돼야 함. 안 그러면 server 가 X11 채널 열려고 할 때 리스너 없어서 거부됨.
      setupX11Forwarding(conn, x11Display, log);
      // X 서버는 백그라운드로 띄움 — 도착할 X 데이터를 받기 위해선 SSH 서버가 채널 열기 전에 준비 필요
      // 하지만 listener 만 있으면 일단 OK, X 서버 자체는 첫 X 클라이언트 실행 직전까지 살아있으면 됨
      (async () => {
        const { usedBundled } = await startBundledX11(x11Display, log);
        if (!usedBundled) {
          log('번들/외부 X 서버 미사용 — 내장 X 서버 시작 (제한적 호환)');
          startEmbeddedX11(x11Display, log);
        }
      })().catch(e => log(`X11 setup 오류: ${e.message}`));
    }

    const shellOpts: any = { cols: shellCols, rows: shellRows, term: 'xterm-256color' };
    if (x11Enabled) {
      // 랜덤 32자 hex 쿠키 — MIT-MAGIC-COOKIE-1 표준 (Xshell/OpenSSH -Y 와 동일 방식)
      const cookie = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
      shellOpts.x11 = {
        single: false,                     // -Y (trusted) 동작 — 다중 X 연결 허용
        screen: x11Display,
        protocol: 'MIT-MAGIC-COOKIE-1',
        cookie,
      };
    }
    conn.shell(shellOpts, (err: any, stream: any) => {
      if (err) {
        this.emit('message', { type: 'error', panelId, error: String(err) });
        try { conn.end(); } catch {}
        const transports = transportConns && transportConns.length ? transportConns : (primaryConn ? [primaryConn] : []);
        for (const tc of transports) { try { tc?.end(); } catch {} }
        return;
      }

      const initialEncoding = session?.encoding || 'utf-8';

      // Expect/Send 로그인 스크립트 설정
      if (session.loginScript && session.loginScript.length > 0) {
        const runner = new ExpectSendRunner(stream, session.loginScript);
        this.scriptRunners.set(panelId, runner);
        runner.start();
      }

      stream.on('data', (data: Buffer) => {
        try {
          const cur = (this.clients.get(panelId)?.encoding || initialEncoding).toLowerCase();
          let str = cur === 'utf-8' || cur === 'utf8'
            ? data.toString('utf8')
            : iconv.decode(data, cur);

          // 자동추적 명령 echo 차단 (지금은 거의 안 쓰이지만 안전 장치로 유지)
          str = this._consumeEchoPrefix(panelId, str);

          this.emit('message', { type: 'data', panelId, data: str });

          // ── 프롬프트에서 cwd + ClearCase 뷰 파싱 ──
          // /proc 기반 추적이 불가한 환경(setview 서브셸 reparent/탈tty/SSH_CONNECTION 미상속, 공유서버)을 위해
          // 프롬프트에 노출된 경로를 직접 읽음. 예) [dev@host(ghj_view):/vobs/REL/SSW_70A ]
          this._parsePromptCwd(panelId, str);

          const runner = this.scriptRunners.get(panelId);
          if (runner && runner.isRunning()) {
            runner.feed(str);
          }
        } catch {
          this.emit('message', { type: 'data', panelId, data: data.toString('utf8') });
        }
      });

      // stream error 핸들러 — 미등록 시 unhandled exception → main 프로세스 크래시.
      stream.on('error', (e: any) => {
        console.log(`[shell-${panelId.slice(-6)}] stream error:`, e?.message || e);
        // close 이벤트도 뒤이어 오므로 여기선 따로 정리 안 함
      });
      stream.stderr?.on?.('error', (e: any) => {
        console.log(`[shell-${panelId.slice(-6)}] stderr error:`, e?.message || e);
      });

      stream.on('close', () => {
        this.clients.delete(panelId);
        this.sftpCache.delete(panelId);
        this.scriptRunners.delete(panelId);
        this._cleanupDedicatedSftp(panelId);
        this.emit('message', { type: 'closed', panelId });
        try { conn.end(); } catch {}
        // 모든 중간 transport 연결 해제 (다단계 점프 포함). primaryConn 은 transportConns 에 포함됨.
        const transports = transportConns && transportConns.length ? transportConns : (primaryConn ? [primaryConn] : []);
        for (const tc of transports) { try { tc?.end(); } catch {} }
      });

      this.clients.set(panelId, { conn, stream, encoding: initialEncoding, primaryConn, transportConns });

      // 세션 옵션 autoTrackPwd — fileTreeEnabled 가 켜져 있을 때만 의미가 있어 의존성 강제.
      // 켜져 있으면 즉시 UI 인디케이터 ON + 프롬프트 파싱 활성 (PID 탐지는 백그라운드).
      if (session.autoTrackPwd && session.fileTreeEnabled) {
        this.autoTrackOn.add(panelId);
        // UI 인디케이터 즉시 ON — 프롬프트 파싱은 PID 탐지 없이도 바로 동작하므로 지연 없이 활성 표시
        this.emit('message', { type: 'auto-track', panelId, enabled: true });
        const injectDelay = session.loginScript && session.loginScript.length > 0 ? 3500 : 800;
        setTimeout(() => {
          this._installOsc7Hook(panelId, '');
        }, injectDelay);
      }
    });
  }

  handleAuthResponse(panelId: string, responses: string[]) {
    const finish = this.pendingAuth.get(panelId);
    if (finish) {
      finish(responses);
      this.pendingAuth.delete(panelId);
    }
  }

  handleInput(panelId: string, data?: string, b64?: string) {
    const rec = this.clients.get(panelId);
    if (!rec?.stream) return;

    const enc = (rec.encoding || 'utf-8').toLowerCase();
    const isUtf8 = enc === 'utf-8' || enc === 'utf8';

    // 세션 인코딩이 UTF-8이 아닌 경우(euc-kr/cp949 등),
    // 렌더러가 보낸 UTF-8 바이트를 문자열로 디코드한 뒤 대상 인코딩으로 재인코딩해야 한다.
    if (!isUtf8) {
      let str: string | undefined;
      if (b64) {
        try { str = Buffer.from(b64, 'base64').toString('utf8'); } catch {}
      }
      if (str === undefined && data !== undefined) str = data;
      if (str !== undefined) {
        try {
          rec.stream.write(iconv.encode(str, enc));
          return;
        } catch {
          // fall through to raw write
        }
      }
    }

    if (b64) {
      rec.stream.write(Buffer.from(b64, 'base64'));
    } else if (data) {
      rec.stream.write(data);
    }
  }

  setEncoding(panelId: string, encoding: string) {
    const rec = this.clients.get(panelId);
    if (!rec) return false;
    rec.encoding = encoding || 'utf-8';
    return true;
  }

  getEncoding(panelId: string): string | null {
    const rec = this.clients.get(panelId);
    return rec?.encoding || null;
  }

  // 검출된 shell path 캐시 (런타임 토글 시 hook 재설치/제거용)
  private detectedShells: Map<string, string> = new Map();
  // 마지막 알려진 터미널 cols (wrap 계산용)
  private termCols: Map<string, number> = new Map();
  // panel → 인터랙티브 셸 PID (백그라운드 cwd 폴링용)
  private shellPids: Map<string, number> = new Map();
  // panel → ClearCase 뷰 루트 (CLEARCASE_ROOT, 예: /view/ghj_view). 없으면 ''. undefined=미조회
  private ccViewRoots: Map<string, string> = new Map();
  // panel → 현재 활성 셸 PID (cwd 폴링이 선택한 최신 셸 = setview 서브셸 등). CLEARCASE_ROOT 조회에 사용.
  private activeShellPids: Map<string, number> = new Map();

  // CLEARCASE_ROOT 환경변수 조회 — dynamic view 의 /vobs 경로를 실경로로 변환하기 위함.
  // setview 서브셸에만 CLEARCASE_ROOT=/view/<tag> 가 설정되므로 cwd 폴링이 선택한 활성 셸 PID 의 environ 을 읽음.
  private async getCcViewRoot(panelId: string): Promise<string> {
    if (this.ccViewRoots.has(panelId)) return this.ccViewRoots.get(panelId) || '';
    // 프롬프트 버퍼에서 뷰태그 즉석 추출 — _detectAndApplyPromptCwd 타이밍을 못 기다린 SFTP 호출 보강
    const tail = this.promptTail.get(panelId) || '';
    const tm = tail.match(/@[A-Za-z0-9_.\-]+\(([A-Za-z0-9_.\-]+)\):\//);
    if (tm) {
      const root = `/view/${tm[1]}`;
      this.ccViewRoots.set(panelId, root);
      console.log(`[clearcase-${panelId.slice(-6)}] view root from prompt(on-demand): ${root}`);
      return root;
    }
    const pid = this.activeShellPids.get(panelId) || this.shellPids.get(panelId);
    if (!pid) return '';
    try {
      const out = await this.execCommand(panelId,
        `cat /proc/${pid}/environ 2>/dev/null | tr '\\0' '\\n' | grep '^CLEARCASE_ROOT='`, 5000);
      const m = out.match(/^CLEARCASE_ROOT=(.+)$/m);
      const root = m ? m[1].trim().replace(/\/+$/, '') : '';
      // 빈 결과는 캐시하지 않음 — 뷰 설정 전 조회됐을 수 있어 다음에 재시도 (찾으면 그때 캐시)
      if (root) {
        this.ccViewRoots.set(panelId, root);
        console.log(`[clearcase-${panelId.slice(-6)}] view root: ${root} (fg pid ${pid})`);
      }
      return root;
    } catch {
      return '';
    }
  }

  // /vobs/... 같은 뷰-상대 경로를 /view/<tag>/vobs/... 실경로로 변환 (SFTP 접근용).
  // 이미 /view/ 로 시작하거나 뷰 루트가 없으면 그대로 둠.
  private async resolveCcPath(panelId: string, p: string): Promise<string> {
    if (!p || p.startsWith('/view/')) return p;
    // /vobs 계열만 변환 (다른 경로는 일반 파일시스템이라 그대로 접근 가능)
    if (!(p === '/vobs' || p.startsWith('/vobs/'))) return p;
    const root = await this.getCcViewRoot(panelId);
    if (!root) return p;
    if (p.startsWith(root)) return p;
    return root + p;
  }
  // panel → 마지막으로 알려진 cwd (변경 감지용)
  private lastCwd: Map<string, string> = new Map();

  /**
   * 대화형 셸의 현재 작업 디렉토리(cwd) 온디맨드 조회 — autoTrackPwd 미사용 세션에서도 동작.
   *   1) 자동추적이 켜진 세션은 lastCwd 가 실시간이므로 그대로 반환 (빠름).
   *      자동추적이 꺼진 세션은 lastCwd 가 접속 초기값 등으로 stale 할 수 있어 신뢰하지 않고 항상 2)로.
   *   2) 별도 exec 채널에서 우리 SSH_CONNECTION 을 공유하는 tty 보유 프로세스(=대화형 셸)의
   *      /proc/<pid>/cwd 를 readlink. 가장 깊은(자손) cwd 를 선택해 setview 같은 서브셸도 추적.
   *   exec 채널은 home 에서 시작하지만, 우리는 그 채널 cwd 가 아니라 "셸 프로세스"의 cwd 를 읽는다.
   */
  public async getShellCwd(panelId: string): Promise<string | null> {
    // 자동추적 ON 일 때만 lastCwd 를 신뢰 (실시간). OFF 면 stale 가능 → 항상 /proc 으로 신선 조회.
    const tracked = this.lastCwd.get(panelId);
    if (this.autoTrackOn.has(panelId) && tracked && tracked.startsWith('/')) return tracked;
    const rec = this.clients.get(panelId);
    if (!rec?.conn) return null;
    // /proc/self/environ 의 SSH_CONNECTION 으로 우리 연결의 프로세스만 필터, tty(pts) 있는 셸의 cwd 수집.
    const script = `/bin/sh -c '`
      + `CONN=$(tr "\\000" "\\n" < /proc/self/environ 2>/dev/null | grep "^SSH_CONNECTION="); `
      + `[ -z "$CONN" ] && exit 0; `
      + `best=""; bestlen=0; `
      + `for d in /proc/[0-9]*; do `
      + `grep -aqz "$CONN" $d/environ 2>/dev/null || continue; `
      + `tty=$(readlink $d/fd/0 2>/dev/null); case "$tty" in *pts*|*tty*) ;; *) continue;; esac; `
      + `cw=$(readlink $d/cwd 2>/dev/null); [ -z "$cw" ] && continue; `
      + `l=\${#cw}; if [ "$l" -ge "$bestlen" ]; then best="$cw"; bestlen=$l; fi; `
      + `done; printf "%s" "$best"'`;
    try {
      const out: string = await new Promise<string>((resolve, reject) => {
        rec.conn.exec(script, (err: any, stream: any) => {
          if (err) { reject(err); return; }
          let buf = '';
          const to = setTimeout(() => { try { stream.close(); } catch {}; resolve(buf); }, 4000);
          stream.on('data', (d: Buffer) => { buf += d.toString('utf8'); });
          stream.stderr?.on('data', () => {});
          stream.on('close', () => { clearTimeout(to); resolve(buf); });
        });
      });
      const cwd = (out || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean).pop() || '';
      if (cwd.startsWith('/')) return cwd;
      // /proc 조회 실패(비Linux 등) → 추적값이라도 있으면 폴백
      return (tracked && tracked.startsWith('/')) ? tracked : null;
    } catch { return (tracked && tracked.startsWith('/')) ? tracked : null; }
  }
  // panel → 프롬프트 파싱용 tail 버퍼 (chunk 경계로 프롬프트가 잘리는 것 방지)
  private promptTail: Map<string, string> = new Map();
  // 프롬프트에서 cwd 를 성공적으로 파싱한 패널 — /proc 폴러가 이 패널의 cwd 를 덮어쓰지 않게 함
  private promptCwdActive: Set<string> = new Set();
  // PWD 자동추적이 켜진 패널 — 꺼지면 /proc 폴링 + 프롬프트 파싱 모두 중지
  private autoTrackOn: Set<string> = new Set();

  // 터미널 출력에서 프롬프트의 cwd(및 ClearCase 뷰태그)를 추출 → /proc 추적이 불가한 환경 보조.
  // 지원 패턴: "(viewtag):/path " (ClearCase) 및 일반 ":/path " / "/path $" / "/path #" 등 프롬프트 말미 경로.
  private _parsePromptCwd(panelId: string, chunk: string): void {
    // 버퍼는 자동추적 on/off 와 무관하게 항상 갱신 (꺼진 동안 이동한 경로도 보존 → 재활성화 시 즉시 반영).
    // ANSI escape 제거 + tail 버퍼 누적 (마지막 2KB만 유지)
    // eslint-disable-next-line no-control-regex
    const clean = chunk.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');
    let buf = (this.promptTail.get(panelId) || '') + clean;
    if (buf.length > 4096) buf = buf.slice(-4096);
    this.promptTail.set(panelId, buf);
    // emit 은 자동추적이 켜진 경우에만
    if (this.autoTrackOn.has(panelId)) this._detectAndApplyPromptCwd(panelId);
  }

  // 현재 promptTail 버퍼 전체에서 "마지막" 프롬프트 매치를 찾아 cwd/뷰태그 적용.
  // (마지막 3줄만 보면 프롬프트 뒤에 빈 줄/커서 이동 출력이 끼었을 때 놓침 → 전체에서 가장 마지막 매치 사용)
  private _detectAndApplyPromptCwd(panelId: string): void {
    const buf = this.promptTail.get(panelId) || '';
    if (!buf) return;
    const re = /@[A-Za-z0-9_.\-]+(?:\(([A-Za-z0-9_.\-]+)\))?:(~?\/[^\s\]>$#)]*|~)\s*[\]$#>]/g;
    let m: RegExpExecArray | null;
    let lastViewTag = '';
    let lastPath = '';
    while ((m = re.exec(buf)) !== null) {
      lastViewTag = m[1] || lastViewTag; // 뷰태그는 최근 것 유지
      lastPath = m[2];
    }
    if (!lastPath) return;
    if (lastViewTag) {
      const newRoot = `/view/${lastViewTag}`;
      if (this.ccViewRoots.get(panelId) !== newRoot) {
        this.ccViewRoots.set(panelId, newRoot);
        console.log(`[clearcase-${panelId.slice(-6)}] view root from prompt: ${newRoot}`);
      }
    }
    let p = lastPath;
    if (p === '~' || p.startsWith('~/')) {
      const home = this.homeDirs.get(panelId);
      if (!home) { this._fetchHomeDir(panelId); return; }
      p = p === '~' ? home : home.replace(/\/$/, '') + p.slice(1);
    }
    if (p.startsWith('/')) {
      const wasActive = this.promptCwdActive.has(panelId);
      this.promptCwdActive.add(panelId);
      // 프롬프트 파싱이 cwd 를 제공하므로 무거운 /proc 폴링은 중단 — SSH 채널 절약
      if (!wasActive) this._stopCwdPolling(panelId);
      this._applyTrackedCwd(panelId, p);
    }
  }

  // panel → 홈 디렉토리 캐시 ("~" 프롬프트 해석용)
  private homeDirs: Map<string, string> = new Map();
  private homeFetching: Set<string> = new Set();
  private _fetchHomeDir(panelId: string): void {
    if (this.homeDirs.has(panelId) || this.homeFetching.has(panelId)) return;
    this.homeFetching.add(panelId);
    this.execCommand(panelId, 'printf %s "$HOME"', 5000)
      .then(out => { const h = out.trim(); if (h.startsWith('/')) this.homeDirs.set(panelId, h); })
      .catch(() => {})
      .finally(() => this.homeFetching.delete(panelId));
  }

  // 추적된 cwd 를 lastCwd 에 반영하고 OSC7 emit (auto-track 과 동일 동작)
  private _applyTrackedCwd(panelId: string, p: string): void {
    if (!p || !p.startsWith('/')) return;
    const last = this.lastCwd.get(panelId);
    if (p === last) return;
    this.lastCwd.set(panelId, p);
    const oscSeq = `\x1b]7;file://localhost${p}\x1b\\`;
    this.emit('message', { type: 'data', panelId, data: oscSeq });
    // xterm 파싱/포커스에 의존하지 않는 직접 경로 — 파일트리가 즉시 반영하도록
    this.emit('message', { type: 'pwd', panelId, data: p });
  }
  // panel → 폴링 timer
  private cwdPollers: Map<string, ReturnType<typeof setInterval>> = new Map();

  // 호환성용 no-op: 백그라운드 폴링 방식으로 전환 후 사용 안 함.
  private _consumeEchoPrefix(_panelId: string, str: string): string {
    return str;
  }

  // 셸 PID 를 백그라운드로 탐지하고 cwd 폴링 시작 (셸 stdin 에 명령 안 보냄).
  // 다중 전략으로 시도. 셸 종류 무관.
  private _installOsc7Hook(panelId: string, shellPath: string) {
    const rec = this.clients.get(panelId);
    if (!rec?.conn) return;
    // 프롬프트 파싱이 이미 cwd 를 처리 중이면 무거운 PID 탐지(/proc environ 전체 grep)를 건너뜀 — SFTP 채널 경쟁 회피
    if (this.promptCwdActive.has(panelId)) return;
    this.detectedShells.set(panelId, shellPath || '');
    // SSH_CONNECTION env 로 우리 연결의 셸 후보들을 모두 찾고, 그 중 가장 큰 PID 선택
    // (= 가장 최근 = 사용자의 foreground 셸. nested shell 케이스도 정확히 추적).
    // 스크립트는 base64 로 전달해 csh 의 quote/redirect 이슈 우회.
    const innerScript = `_c="$SSH_CONNECTION"
candidates=""
for f in /proc/[0-9]*/environ; do
  [ -r "$f" ] || continue
  # SSH_CONNECTION 일치 + TERM env 있음 (interactive PTY) + tty_nr != 0 (controlling TTY 보유)
  if grep -aqz "SSH_CONNECTION=$_c" "$f" 2>/dev/null && grep -aqz "TERM=" "$f" 2>/dev/null; then
    p=$(basename $(dirname "$f"))
    [ -e "/proc/$p/stat" ] || continue
    tty_nr=$(awk '{print $7}' /proc/$p/stat 2>/dev/null)
    [ -n "$tty_nr" ] && [ "$tty_nr" != "0" ] || continue
    n=$(cat /proc/$p/comm 2>/dev/null)
    case "$n" in
      csh|tcsh|bash|zsh|sh|ksh|dash|fish)
        candidates="$candidates $p"
        ;;
    esac
  fi
done
# 후보 중 가장 큰 PID 선택 (최신 셸 = foreground)
best=""
for p in $candidates; do
  if [ -z "$best" ] || [ "$p" -gt "$best" ]; then
    best="$p"
  fi
done
if [ -n "$best" ]; then
  printf '<<PEPE>>%s<<END>>' "$best"
  # 디버그: 모든 후보와 cwd 출력
  for p in $candidates; do
    cwd=$(readlink /proc/$p/cwd 2>/dev/null)
    n=$(cat /proc/$p/comm 2>/dev/null)
    echo "DBG candidate pid=$p comm=$n cwd=$cwd" >&2
  done
  exit 0
fi
# fallback: ps 기반 etime 정렬
pid2=$(ps -u "$USER" -o pid,etime,comm 2>/dev/null | awk '$3 ~ /^-?(csh|tcsh|bash|zsh|sh|ksh|dash|fish)$/ {print $1, $2}' | sort -k2 -r | head -1 | awk '{print $1}')
printf '<<PEPE>>%s<<END>>' "$pid2"`;
    const b64 = Buffer.from(innerScript).toString('base64');
    const findPidScript = `echo ${b64} | base64 -d | /bin/sh`;
    rec.conn.exec(findPidScript, (err: any, stream: any) => {
      if (err) {
        console.log(`[autotrack-${panelId.slice(-6)}] PID detect exec failed:`, err);
        return;
      }
      let out = '';
      let errOut = '';
      stream.on('data', (d: Buffer) => { out += d.toString('utf8'); });
      stream.stderr.on('data', (d: Buffer) => { errOut += d.toString('utf8'); });
      stream.on('close', () => {
        const m = out.match(/<<PEPE>>([\s\S]*?)<<END>>/);
        const trimmed = m ? m[1].trim() : out.trim();
        console.log(`[autotrack-${panelId.slice(-6)}] PID detect output: "${trimmed}" stderr: "${errOut.trim().slice(0, 200)}"`);
        const pid = parseInt(trimmed, 10);
        if (pid > 0) {
          this.shellPids.set(panelId, pid);
          console.log(`[autotrack-${panelId.slice(-6)}] shell PID=${pid}`);
          this._startCwdPolling(panelId);
          this.emit('message', { type: 'auto-track', panelId, enabled: true });
        } else {
          console.log(`[autotrack-${panelId.slice(-6)}] PID not found`);
        }
      });
    });
  }

  // 백그라운드 cwd 폴링 — separate exec 채널로 readlink /proc/PID/cwd 를 주기적으로 실행.
  // 셸에 일체 명령 보내지 않음. cwd 변경되면 fake OSC 7 emit.
  // ★ 채널 동시 개수 제한 + 연속 에러 시 백오프 — 서버의 MaxSessions 한계 회피
  private _startCwdPolling(panelId: string): void {
    // 프롬프트 파싱이 cwd 를 처리 중인 패널은 무거운 /proc 폴링을 시작하지 않음 (SSH 채널 절약)
    if (this.promptCwdActive.has(panelId)) return;
    this._stopCwdPolling(panelId); // 중복 방지
    // cwd 가 그렇게 빨리 바뀌지 않으므로 base 를 700ms 로 — 에이전트 호출이 latency 에 민감.
    const baseInterval = 700;
    const maxInterval = 30_000; // 최대 30초까지 백오프
    let currentInterval = baseInterval;
    let consecutiveErrors = 0;
    let inFlight = false; // 이전 exec 미완료면 다음 tick 스킵
    const pid = this.shellPids.get(panelId);
    if (!pid) return;
    const scheduleNext = () => {
      if (!this.cwdPollers.has(panelId)) return; // 정지됨
      const t = setTimeout(tick, currentInterval);
      this.cwdPollers.set(panelId, t);
    };
    const tick = () => {
      const rec = this.clients.get(panelId);
      if (!rec?.conn) { this._stopCwdPolling(panelId); return; }
      const curPid = this.shellPids.get(panelId);
      if (!curPid) { scheduleNext(); return; }
      if (inFlight) { scheduleNext(); return; } // 이전 호출 응답 대기 중 — 채널 누적 방지
      // AI 에이전트가 같은 연결로 작업 중이면 무거운 /proc 스캔을 미룬다 — 채널 경합·원격 부하 회피.
      if (this.isAgentBusy(panelId)) { this.cwdPollers.set(panelId, setTimeout(tick, 1000)); return; }
      inFlight = true;
      // ClearCase setview 처럼 로그인 셸이 자식 서브셸을 띄우면 추적 PID(로그인 셸, cwd=/user1/dev)가 아니라
      // 실제 사용자가 있는 자손 셸의 cwd 를 따라가야 함. 로그인 셸 tpgid(포그라운드 pgrp) + 전체 프로세스의
      // pid/ppid/cwd 를 받아 JS 에서 "포그라운드 또는 최심 자손" 의 cwd 를 선택.
      // 출력 형식: "TPGID:<n>" 한 줄 + 이후 "pid ppid cwd" 줄들.
      // 공유 개발서버(수백 프로세스 + 다중 사용자)에서 우리 세션의 셸만 정확히 식별하려면 SSH_CONNECTION
      // 환경변수로 필터해야 함 (우리 TCP 연결 고유값. setview 가 셸을 reparent/탈tty 해도 자식이 env 상속).
      // 로그인 셸(curPid) environ 에서 SSH_CONNECTION 을 읽어 그 값을 가진 프로세스만 출력.
      // 출력: "pid ppid tty comm cwd". comm 은 stat 의 (괄호) 에서 추출 (구버전 커널 /proc/pid/comm 빈 문제 회피).
      const cmd = `/bin/sh -c 'printf "<<PEPE>>\\n"; `
        + `CONN=$(tr "\\000" "\\n" < /proc/${curPid}/environ 2>/dev/null | grep "^SSH_CONNECTION="); `
        + `[ -z "$CONN" ] && { printf "<<END>>"; exit 0; }; `
        + `for d in /proc/[0-9]*; do grep -aqz "$CONN" $d/environ 2>/dev/null || continue; `
        + `st=$(cat $d/stat 2>/dev/null) || continue; `
        + `c=\${st#*(}; cm=\${c%%)*}; rr=\${st#*) }; set -- $rr; `
        + `cw=$(readlink $d/cwd 2>/dev/null); `
        + `echo "\${d#/proc/} $2 $5 $cm $cw"; done; `
        + `printf "<<END>>"'`;
      rec.conn.exec(cmd, (err: any, stream: any) => {
        if (err) {
          consecutiveErrors++;
          // 처음 1회만 로그 — 폭주 방지
          if (consecutiveErrors === 1) {
            console.log(`[autotrack-${panelId.slice(-6)}] poll exec err:`, err?.message || err);
          }
          // 백오프: 연속 에러 횟수에 따라 interval 증가
          if (consecutiveErrors >= 3) {
            currentInterval = Math.min(maxInterval, currentInterval * 2);
            if (consecutiveErrors === 3 || consecutiveErrors % 10 === 0) {
              console.log(`[autotrack-${panelId.slice(-6)}] backoff: interval=${currentInterval}ms (errors=${consecutiveErrors})`);
            }
          }
          // 너무 많이 실패하면 폴링 중단 (서버가 채널 자체 안 받음)
          if (consecutiveErrors >= 50) {
            console.log(`[autotrack-${panelId.slice(-6)}] too many errors, stop polling`);
            this._stopCwdPolling(panelId);
            return;
          }
          inFlight = false;
          scheduleNext();
          return;
        }
        // 성공 — 백오프 리셋
        if (consecutiveErrors > 0) {
          console.log(`[autotrack-${panelId.slice(-6)}] recovered (errors=${consecutiveErrors})`);
          consecutiveErrors = 0;
          currentInterval = baseInterval;
        }
        let out = '';
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          inFlight = false;
          const m = out.match(/<<PEPE>>([\s\S]*?)<<END>>/);
          const inner = (m ? m[1] : out).trim();
          // 파싱: "pid ppid tty comm cwd" 줄들
          const SHELLS = new Set(['csh', 'tcsh', 'bash', 'zsh', 'sh', 'ksh', 'dash', 'fish']);
          const procs = new Map<number, { ppid: number; tty: number; comm: string; cwd: string }>();
          for (const line of inner.split('\n')) {
            const tl = line.trim();
            if (!tl) continue;
            const parts = tl.split(/\s+/);
            if (parts.length < 4) continue; // pid ppid tty comm (cwd 없을 수 있음)
            const pid = parseInt(parts[0], 10);
            const ppid = parseInt(parts[1], 10);
            const tty = parseInt(parts[2], 10);
            const comm = parts[3] || '';
            const cwd = parts.length >= 5 ? parts.slice(4).join(' ') : '';
            if (pid) procs.set(pid, { ppid, tty, comm, cwd });
          }
          let path = '';
          let chosenPid = 0;
          if (procs.size > 0) {
            // SSH_CONNECTION 으로 이미 우리 세션 프로세스만 추려졌음 → 셸 중 최신(최대 pid)의 cwd 가 현재 활성 셸.
            // (로그인 셸 → setview 서브셸 → 그 안의 cd 등, 최신 셸이 사용자가 있는 곳)
            const shellCands = [...procs.entries()]
              .filter(([, v]) => SHELLS.has(v.comm) && v.cwd && v.cwd.startsWith('/'))
              .map(([pid, v]) => ({ pid, cwd: v.cwd }))
              .sort((a, b) => b.pid - a.pid);
            if (shellCands.length > 0) {
              path = shellCands[0].cwd; chosenPid = shellCands[0].pid;
            } else {
              // 셸이 없으면(드묾) 우리 세션 프로세스 중 cwd 있는 최신
              const any = [...procs.entries()]
                .filter(([, v]) => v.cwd && v.cwd.startsWith('/'))
                .map(([pid, v]) => ({ pid, cwd: v.cwd }))
                .sort((a, b) => b.pid - a.pid);
              if (any.length > 0) { path = any[0].cwd; chosenPid = any[0].pid; }
            }
          }
          // 활성 셸 PID 기록 — getCcViewRoot(CLEARCASE_ROOT 조회)가 이 PID 의 environ 을 읽음.
          // 새 셸(setview 등)로 바뀌면 뷰 루트 캐시도 무효화.
          if (chosenPid && this.activeShellPids.get(panelId) !== chosenPid) {
            this.activeShellPids.set(panelId, chosenPid);
            this.ccViewRoots.delete(panelId);
          }
          // 폴백: 기존 단일 경로 추출
          if (!path) {
            if (inner === '/') path = '/';
            else { const pm = inner.match(/\/[A-Za-z0-9_\-./~]+/); if (pm) path = pm[0]; }
          }
          // 프롬프트 파싱이 cwd 를 제공하는 패널(ClearCase 등)에서는 /proc 추적값으로 덮어쓰지 않음
          if (path && !this.promptCwdActive.has(panelId)) {
            this._applyTrackedCwd(panelId, path);
          }
          scheduleNext();
        };
        stream.on('data', (d: Buffer) => { out += d.toString('utf8'); });
        stream.on('close', finish);
        stream.on('error', (e: any) => { console.log(`[autotrack-${panelId.slice(-6)}] stream err:`, e?.message || e); finish(); });
        stream.stderr?.on?.('data', () => {}); // drain stderr
      });
    };
    // 초기 tick 등록 — cwdPollers 에 임시 placeholder 넣고 즉시 실행
    this.cwdPollers.set(panelId, setTimeout(tick, 0));
  }

  private _stopCwdPolling(panelId: string): void {
    const t = this.cwdPollers.get(panelId);
    if (t) {
      // setTimeout 과 setInterval 모두 clearTimeout/clearInterval 호환
      clearTimeout(t as any);
      clearInterval(t as any);
      this.cwdPollers.delete(panelId);
    }
  }

  // 런타임 PWD 자동추적 토글 — 백그라운드 폴링 시작/중지. 셸 stdin 에 명령 절대 안 보냄.
  // 첫 호출이면 exec 채널로 PID 탐지.
  setAutoTrack(panelId: string, enabled: boolean): { success: boolean; error?: string } {
    const rec = this.clients.get(panelId);
    if (!rec?.conn) return { success: false, error: 'not connected' };
    if (enabled) {
      this.autoTrackOn.add(panelId);
      // 재활성화 — 꺼져 있는 동안 쌓인 최신 프롬프트로 cwd 즉시 반영
      this._detectAndApplyPromptCwd(panelId);
      if (this.shellPids.has(panelId)) {
        // PID 이미 알려짐 — 폴링만 시작
        this._startCwdPolling(panelId);
        this.emit('message', { type: 'auto-track', panelId, enabled: true });
      } else {
        // PID 미탐지 — exec 채널로 백그라운드 탐지 (셸에 명령 안 보냄)
        this._installOsc7Hook(panelId, '');
      }
    } else {
      // PWD 자동추적 OFF — 폴링 + 프롬프트 파싱 모두 중지. SFTP/파일트리 연결은 별도 옵션이라 건드리지 않음.
      this.autoTrackOn.delete(panelId);
      this._stopCwdPolling(panelId);
      this.emit('message', { type: 'auto-track', panelId, enabled: false });
    }
    return { success: true };
  }

  // 외부에서 명시적으로 panel 의 dedicated SFTP 만 종료 (SSH 메인 연결은 유지) — 파일트리 unmount 등에서 호출
  public releaseDedicatedSftp(panelId: string) {
    try { this._cleanupDedicatedSftp(panelId); } catch {}
    try { const s = this.sftpCache.get(panelId); if (s) { s.end?.(); this.sftpCache.delete(panelId); } } catch {}
  }

  handleResize(panelId: string, cols: number, rows: number) {
    const rec = this.clients.get(panelId);
    if (!rec?.stream) return;
    if (cols > 0) this.termCols.set(panelId, cols);
    try {
      rec.stream.setWindow(rows, cols, rows, cols);
    } catch {
      // stream may already be closed
    }
  }

  handleDisconnect(panelId: string) {
    // 연결 완료 상태
    const rec = this.clients.get(panelId);
    if (rec) {
      try { rec.conn.end(); } catch {}
      this.clients.delete(panelId);
    }
    // 아직 ready 안 된 pending 연결도 정리
    const pending = this.pendingConnects.get(panelId);
    if (pending) {
      try { pending.end(); } catch {}
      this.pendingConnects.delete(panelId);
    }
    this.sftpCache.delete(panelId);
    this.scriptRunners.delete(panelId);
    this._cleanupDedicatedSftp(panelId);
    this._stopCwdPolling(panelId);
    this.shellPids.delete(panelId);
    this.lastCwd.delete(panelId);
    this.ccViewRoots.delete(panelId);
    this.activeShellPids.delete(panelId);
    this.promptTail.delete(panelId);
    this.promptCwdActive.delete(panelId);
    this.autoTrackOn.delete(panelId);
    this.homeDirs.delete(panelId);
    this.homeFetching.delete(panelId);
    for (const [forwardId, f] of [...this.localForwards.entries()]) {
      if (f.panelId !== panelId) continue;
      try { f.server.close(); } catch {}
      this.localForwards.delete(forwardId);
    }
    for (const [proxyId, p] of [...this.socksProxies.entries()]) {
      if (p.panelId !== panelId) continue;
      try { p.server.close(); } catch {}
      this.socksProxies.delete(proxyId);
    }
  }

  // 앱 종료 시 — 모든 SSH 연결을 일괄 종료. 비차단(fire-and-forget).
  disconnectAll() {
    for (const panelId of [...this.clients.keys()]) this.handleDisconnect(panelId);
    for (const panelId of [...this.pendingConnects.keys()]) this.handleDisconnect(panelId);
  }

  // 로컬 포트 포워딩 (SSH 터널) — 활성 SSH 연결을 통해 원격 host:port 를 로컬 127.0.0.1:auto 로 매핑.
  // SqlTool 의 JDBC 연결을 SSH 세션 위로 라우팅할 때 사용.
  private localForwards = new Map<string, { server: net.Server; localPort: number; panelId: string }>();
  // SOCKS5 프록시 — 브라우저/외부 클라이언트가 활성 SSH 세션을 경유하도록 함.
  private socksProxies = new Map<string, { server: net.Server; localPort: number; panelId: string }>();
  public hasActiveClient(panelId: string): boolean { return this.clients.has(panelId); }
  public listActivePanels(): string[] { return [...this.clients.keys()]; }
  public listActiveSessions(): { panelId: string; sessionId?: string; sessionName?: string; host?: string; port?: number; browserUrl?: string }[] {
    const out: { panelId: string; sessionId?: string; sessionName?: string; host?: string; port?: number; browserUrl?: string }[] = [];
    for (const panelId of this.clients.keys()) {
      const s = this.sessionStore.get(panelId);
      out.push({
        panelId,
        sessionId: s?.id,
        sessionName: s?.name,
        host: s?.host,
        port: s?.port,
        browserUrl: s?.browserUrl,
      });
    }
    return out;
  }
  // 디버그용 — 각 활성 패널의 sessionStore 정보(id, host, port) 한 줄 요약. (메인 콘솔 로그 전용)
  public dumpSessionInfo(): string {
    const lines: string[] = [];
    for (const panelId of this.clients.keys()) {
      const s = this.sessionStore.get(panelId);
      lines.push(`${panelId}=[id=${s?.id}, host=${s?.host}, port=${s?.port}]`);
    }
    return lines.length === 0 ? '(없음)' : lines.join('; ');
  }
  // 사용자 친화적 — host 가 있는 활성 SSH 세션의 유니크 host[:port] 목록.
  // (host=undefined 인 sftp-only/local shell 등은 제외 — 사용자에겐 무관)
  public listActiveHosts(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const panelId of this.clients.keys()) {
      const s = this.sessionStore.get(panelId);
      if (!s?.host) continue;
      const key = s.port && s.port !== 22 ? `${s.host}:${s.port}` : s.host;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
    return out;
  }
  // sessionStore(panelId → session) 에서 session.id 가 일치하는 첫 panelId 반환 — JDBC 터널이 사용할 SSH 연결 찾기용.
  // 1) session.id 정확 매칭
  // 2) panelId 접두/동일 매칭(legacy)
  // 3) host:port (또는 host) 매칭 — quick-connect 가 다른 id 를 쓰는 경우 fallback
  public findPanelBySessionId(sessionId: string, hint?: { host?: string; port?: number }): string | null {
    for (const [panelId, sess] of this.sessionStore.entries()) {
      if (sess?.id === sessionId && this.clients.has(panelId)) return panelId;
    }
    for (const pid of this.clients.keys()) {
      if (pid === sessionId || pid.startsWith(sessionId + '-')) return pid;
    }
    if (hint?.host) {
      // host + port 동일한 활성 SSH 세션 우선
      for (const [panelId, sess] of this.sessionStore.entries()) {
        if (!this.clients.has(panelId)) continue;
        if (sess?.host === hint.host && (!hint.port || sess?.port === hint.port)) return panelId;
      }
      // port 무시하고 host 만
      for (const [panelId, sess] of this.sessionStore.entries()) {
        if (!this.clients.has(panelId)) continue;
        if (sess?.host === hint.host) return panelId;
      }
    }
    return null;
  }
  public async openLocalForward(panelId: string, remoteHost: string, remotePort: number): Promise<{ forwardId: string; localPort: number }> {
    const rec = this.clients.get(panelId);
    if (!rec?.conn) throw new Error('SSH 연결 없음');
    return new Promise((resolve, reject) => {
      const server = net.createServer((client: net.Socket) => {
        // eslint-disable-next-line no-console
        console.log(`[ssh-tunnel] inbound connection on ${(server.address() as any)?.port} → ${remoteHost}:${remotePort}`);
        rec.conn.forwardOut('127.0.0.1', 0, remoteHost, remotePort, (err: any, stream: any) => {
          if (err) {
            console.error('[ssh-tunnel] forwardOut error:', err?.message || err);
            try { client.destroy(err); } catch {}
            return;
          }
          client.pipe(stream).pipe(client);
          client.on('error', (e: any) => { console.error('[ssh-tunnel] client err:', e?.message || e); try { stream.end(); } catch {} });
          stream.on('error', (e: any) => { console.error('[ssh-tunnel] stream err:', e?.message || e); try { client.end(); } catch {} });
          client.on('close', () => { try { stream.end(); } catch {} });
          stream.on('close', () => { try { client.end(); } catch {} });
        });
      });
      server.on('error', (e: any) => { console.error('[ssh-tunnel] server err:', e?.message || e); reject(e); });
      server.on('close', () => { console.log('[ssh-tunnel] server closed'); });
      // IPv4 127.0.0.1 단순 형태로 listen — Java 측이 127.0.0.1 로 접속하므로 정확히 매칭.
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as net.AddressInfo;
        const localPort = addr.port;
        const forwardId = `fw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        this.localForwards.set(forwardId, { server, localPort, panelId });
        // eslint-disable-next-line no-console
        console.log(`[ssh-tunnel] listening 127.0.0.1:${localPort} → ${remoteHost}:${remotePort} (panelId=${panelId}, forwardId=${forwardId})`);
        resolve({ forwardId, localPort });
      });
    });
  }
  public closeLocalForward(forwardId: string): boolean {
    const f = this.localForwards.get(forwardId);
    if (!f) return false;
    try { f.server.close(); } catch {}
    this.localForwards.delete(forwardId);
    return true;
  }

  public async openSocksProxy(panelId: string): Promise<{ proxyId: string; localPort: number }> {
    const rec = this.clients.get(panelId);
    if (!rec?.conn) throw new Error('SSH 연결 없음');

    const makeFailureReply = (rep: number) => Buffer.from([0x05, rep, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);

    return new Promise((resolve, reject) => {
      const server = net.createServer((client: net.Socket) => {
        let buffer = Buffer.alloc(0);
        let stage: 'greeting' | 'request' | 'stream' = 'greeting';
        let upstream: any = null;
        let closed = false;

        const finish = () => {
          if (closed) return;
          closed = true;
          try { client.destroy(); } catch {}
          try { upstream?.destroy?.(); } catch {}
        };

        const replyAndClose = (rep: number) => {
          try { client.write(makeFailureReply(rep)); } catch {}
          finish();
        };

        const parseRequest = () => {
          if (buffer.length < 4) return false;
          const ver = buffer[0];
          const cmd = buffer[1];
          const atyp = buffer[3];
          if (ver !== 0x05) {
            replyAndClose(0x01);
            return true;
          }
          if (cmd !== 0x01) {
            replyAndClose(0x07);
            return true;
          }

          let offset = 4;
          let host = '';
          if (atyp === 0x01) {
            if (buffer.length < offset + 4 + 2) return false;
            host = Array.from(buffer.slice(offset, offset + 4)).join('.');
            offset += 4;
          } else if (atyp === 0x03) {
            if (buffer.length < offset + 1) return false;
            const len = buffer[offset];
            offset += 1;
            if (buffer.length < offset + len + 2) return false;
            host = buffer.slice(offset, offset + len).toString('utf8');
            offset += len;
          } else if (atyp === 0x04) {
            if (buffer.length < offset + 16 + 2) return false;
            const parts: string[] = [];
            for (let i = 0; i < 16; i += 2) parts.push(buffer.readUInt16BE(offset + i).toString(16));
            host = parts.join(':');
            offset += 16;
          } else {
            replyAndClose(0x08);
            return true;
          }

          const port = buffer.readUInt16BE(offset);
          buffer = buffer.slice(offset + 2);

          rec.conn.forwardOut('127.0.0.1', 0, host, port, (err: any, stream: any) => {
            if (err || !stream) {
              console.error('[socks-proxy] forwardOut error:', err?.message || err);
              replyAndClose(0x01);
              return;
            }
            upstream = stream;
            try {
              client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            } catch {
              finish();
              return;
            }
            stage = 'stream';
            client.pipe(stream).pipe(client);
            client.on('error', (e: any) => { console.error('[socks-proxy] client err:', e?.message || e); finish(); });
            stream.on('error', (e: any) => { console.error('[socks-proxy] stream err:', e?.message || e); finish(); });
            client.on('close', finish);
            stream.on('close', finish);
          });
          return true;
        };

        client.on('data', (chunk: Buffer) => {
          if (closed) return;
          buffer = Buffer.concat([buffer, chunk]);

          if (stage === 'greeting') {
            if (buffer.length < 2) return;
            const ver = buffer[0];
            const nMethods = buffer[1];
            if (ver !== 0x05 || buffer.length < 2 + nMethods) {
              replyAndClose(0x01);
              return;
            }
            // NO AUTH only
            try { client.write(Buffer.from([0x05, 0x00])); } catch { finish(); return; }
            buffer = buffer.slice(2 + nMethods);
            stage = 'request';
          }

          if (stage === 'request') {
            parseRequest();
          }
        });

        client.on('error', (e: any) => {
          console.error('[socks-proxy] client socket err:', e?.message || e);
          finish();
        });
      });

      server.on('error', (e: any) => { console.error('[socks-proxy] server err:', e?.message || e); reject(e); });
      server.on('close', () => { console.log('[socks-proxy] server closed'); });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as net.AddressInfo;
        const localPort = addr.port;
        const proxyId = `socks-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        this.socksProxies.set(proxyId, { server, localPort, panelId });
        console.log(`[socks-proxy] listening 127.0.0.1:${localPort} (panelId=${panelId}, proxyId=${proxyId})`);
        resolve({ proxyId, localPort });
      });
    });
  }

  public closeSocksProxy(proxyId: string): boolean {
    const p = this.socksProxies.get(proxyId);
    if (!p) return false;
    try { p.server.close(); } catch {}
    this.socksProxies.delete(proxyId);
    return true;
  }

  public async testWebTarget(panelId: string, target: { protocol: 'http:' | 'https:'; host: string; port: number; path: string; timeoutMs?: number }): Promise<{
    protocol: 'http:' | 'https:';
    host: string;
    port: number;
    path: string;
    elapsedMs: number;
    statusCode?: number;
    statusLine?: string;
    mode?: 'forward' | 'exec';
  }> {
    const rec = this.clients.get(panelId);
    if (!rec?.conn) throw new Error('SSH 연결 없음');

    const started = Date.now();
    const timeoutMs = Math.max(1000, Math.min(30000, target.timeoutMs || 10000));
    const toResult = (raw: string, mode: 'forward' | 'exec') => {
      const firstLine = raw.split(/\r?\n/, 1)[0]?.trim() || '';
      const statusMatch = firstLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/i);
      return {
        protocol: target.protocol,
        host: target.host,
        port: target.port,
        path: target.path,
        elapsedMs: Date.now() - started,
        statusCode: statusMatch ? Number(statusMatch[1]) : undefined,
        statusLine: firstLine || undefined,
        mode,
      };
    };

    const probeViaForward = () => new Promise<any>((resolve, reject) => {
      let settled = false;
      let socket: any = null;
      let secure: any = null;
      let timer: NodeJS.Timeout | null = null;
      let buffer = '';
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        try { secure?.destroy?.(); } catch {}
        try { socket?.destroy?.(); } catch {}
        fn();
      };
      const fail = (err: any) => finish(() => reject(err instanceof Error ? err : new Error(String(err))));
      const ok = (raw: string) => finish(() => resolve(toResult(raw, 'forward')));

      timer = setTimeout(() => fail(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
      rec.conn.forwardOut('127.0.0.1', 0, target.host, target.port, (err: any, stream: any) => {
        if (err || !stream) return fail(err || new Error('forwardOut failed'));
        socket = stream;

        const handleData = (data: Buffer) => {
          buffer += data.toString('utf8');
          if (buffer.includes('\r\n\r\n')) ok(buffer);
        };

        if (target.protocol === 'https:') {
          secure = tls.connect({
            socket: stream,
            servername: target.host,
            rejectUnauthorized: false,
          }, () => {
            const req = [
              `HEAD ${target.path || '/'} HTTP/1.1`,
              `Host: ${target.host}`,
              'Connection: close',
              'User-Agent: PePeBrowser/1.0',
              '',
              '',
            ].join('\r\n');
            try { secure.write(req); } catch (e) { fail(e); }
          });
          secure.on('data', handleData);
          secure.on('error', fail);
          secure.on('end', () => { if (buffer) ok(buffer); else fail(new Error('empty response')); });
        } else {
          stream.on('data', handleData);
          stream.on('error', fail);
          stream.on('end', () => { if (buffer) ok(buffer); else fail(new Error('empty response')); });
          const req = [
            `HEAD ${target.path || '/'} HTTP/1.1`,
            `Host: ${target.host}`,
            'Connection: close',
            'User-Agent: PePeBrowser/1.0',
            '',
            '',
          ].join('\r\n');
          try { stream.write(req); } catch (e) { fail(e); }
        }
      });
    });

    const probeViaExec = async () => {
      const url = `${target.protocol}//${target.host}:${target.port}${target.path || '/'}`;
      const timeoutSec = Math.max(1, Math.min(30, Math.ceil(timeoutMs / 1000)));
      const shScript = `
url=${quoteShellArg(url)}
timeout_sec=${timeoutSec}
probe_curl() {
  for bin in /usr/bin/curl /bin/curl curl; do
    if command -v "$bin" >/dev/null 2>&1; then
      cmd_path="$(command -v "$bin")"
      out="$("$cmd_path" -k -sS --connect-timeout "$timeout_sec" --max-time "$timeout_sec" -o /dev/null -w 'HTTP/%{http_version} %{http_code} %{time_total}' "$url" 2>/dev/null)" || true
      if [ -n "$out" ]; then printf '%s\n' "$out"; return 0; fi
    fi
  done
  return 1
}
probe_wget() {
  for bin in /usr/bin/wget /bin/wget wget; do
    if command -v "$bin" >/dev/null 2>&1; then
      cmd_path="$(command -v "$bin")"
      out="$("$cmd_path" --no-check-certificate --spider -S -T "$timeout_sec" "$url" 2>&1)" || true
      line="$(printf '%s\n' "$out" | grep -E '^  HTTP/' | tail -n 1 | sed 's/^  //')"
      if [ -n "$line" ]; then printf '%s\n' "$line"; return 0; fi
    fi
  done
  return 1
}
probe_python() {
  for py in python3 python; do
    if command -v "$py" >/dev/null 2>&1; then
      "$py" - "$url" "$timeout_sec" <<'PY'
import ssl
import sys
import time
import urllib.request
from urllib.error import HTTPError, URLError

url = sys.argv[1]
timeout = float(sys.argv[2])
start = time.time()
ctx = ssl._create_unverified_context()
try:
    with urllib.request.urlopen(url, timeout=timeout, context=ctx) as res:
        code = getattr(res, "status", res.getcode())
        version = getattr(res, "version", 11)
        major = 1
        minor = 1 if version == 11 else 0
        print(f"HTTP/{major}.{minor} {code} {time.time() - start:.3f}")
        raise SystemExit(0)
except HTTPError as e:
    version = getattr(e, "version", 11)
    major = 1
    minor = 1 if version == 11 else 0
    print(f"HTTP/{major}.{minor} {e.code} {time.time() - start:.3f}")
    raise SystemExit(0)
except URLError as e:
    print(f"ERROR {e.reason}")
    raise SystemExit(1)
PY
      return $?
    fi
  done
  return 1
}
probe_curl || probe_wget || probe_python
`;
      const cmd = `sh -lc ${quoteShellArg(shScript)}`;
      const exec = await this.handleExec(panelId, cmd, timeoutMs + 2000);
      const raw = String(exec.stdout || '').trim();
      const firstLine = raw.split(/\r?\n/, 1)[0]?.trim() || '';
      const statusMatch = firstLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/i);
      if (statusMatch) {
        return {
          protocol: target.protocol,
          host: target.host,
          port: target.port,
          path: target.path,
          elapsedMs: Date.now() - started,
          statusCode: Number(statusMatch[1]),
          statusLine: firstLine,
          mode: 'exec' as const,
        };
      }
      throw new Error(`remote probe failed: ${raw || exec.stderr || 'no output'}`);
    };

    try {
      return await probeViaExec();
    } catch (execErr: any) {
      try {
        return await probeViaForward();
      } catch (forwardErr: any) {
        throw new Error(`${execErr?.message || execErr} / forward failed: ${forwardErr?.message || forwardErr}`);
      }
    }
  }

  // ── SFTP ──

  /** SSH 세션에서 일회성 명령 실행 — stdout 반환 (stderr 무시). git status 등 짧은 조회용. */
  public execCommand(panelId: string, command: string, timeoutMs = 5000): Promise<string> {
    return new Promise((resolve, reject) => {
      const rec = this.clients.get(panelId);
      if (!rec?.conn) return reject(new Error('연결되지 않음'));
      rec.conn.exec(command, (err: any, stream: any) => {
        if (err) return reject(err);
        let out = '';
        const to = setTimeout(() => { try { stream.close(); } catch {} reject(new Error('timeout')); }, timeoutMs);
        stream.on('data', (d: Buffer) => { out += d.toString('utf-8'); });
        stream.stderr?.on('data', () => { /* ignore */ });
        stream.on('close', () => { clearTimeout(to); resolve(out); });
        stream.on('error', (e: any) => { clearTimeout(to); reject(e); });
      });
    });
  }

  public getSftp(panelId: string): Promise<any> {
    const cached = this.sftpCache.get(panelId);
    if (cached) return Promise.resolve(cached);
    return new Promise((resolve, reject) => {
      const rec = this.clients.get(panelId);
      if (!rec?.conn) return reject(new Error('연결되지 않음'));
      rec.conn.sftp((err: any, sftp: any) => {
        if (err) return reject(err);
        this.sftpCache.set(panelId, sftp);
        sftp.on('close', () => this.sftpCache.delete(panelId));
        sftp.on('end', () => this.sftpCache.delete(panelId));
        resolve(sftp);
      });
    });
  }

  // 전용 SFTP 연결 해제 헬퍼
  private _cleanupDedicatedSftp(panelId: string) {
    const subsys = this.sftpDedicatedSubsys.get(panelId);
    if (subsys) { try { subsys.end(); } catch {} this.sftpDedicatedSubsys.delete(panelId); }
    const conn = this.sftpDedicatedConn.get(panelId);
    if (conn) { try { conn.end(); } catch {} this.sftpDedicatedConn.delete(panelId); }
    // Worker 종료
    const worker = this.sftpWorkers.get(panelId);
    if (worker) { try { worker.postMessage({ type: 'shutdown' }); } catch {} this.sftpWorkers.delete(panelId); }
    this.sftpWorkerReqs.delete(panelId);
    this.sessionStore.delete(panelId);
  }

  // Worker thread 생성/재사용 — 최초 1회만 SSH 연결, 이후 transfer 요청 처리
  private getOrCreateSftpWorker(panelId: string): Promise<Worker> {
    const existing = this.sftpWorkers.get(panelId);
    if (existing) return Promise.resolve(existing);
    // 이미 연결 중인 promise 재사용 — fire-and-forget + 실제 전송 동시에 호출 시 중복 생성 방지
    const pending = this.sftpWorkerPromises.get(panelId);
    if (pending) return pending;
    const session = this.sessionStore.get(panelId);
    if (!session) return Promise.reject(new Error('세션 정보 없음'));
    const promise = new Promise<Worker>((resolve, reject) => {
      const workerPath = path.join(__dirname, 'sftpTransferWorker.cjs');
      let worker: Worker;
      try { worker = new Worker(workerPath, { workerData: { session } }); }
      catch (e) { return reject(e); }
      const reqs = new Map<string, { onProgress:(t:number,total:number)=>void; resolve:()=>void; reject:(e:Error)=>void }>();
      this.sftpWorkerReqs.set(panelId, reqs);
      let resolved = false;
      worker.on('message', (msg: any) => {
        if (msg.type === 'ready') {
          resolved = true;
          this.sftpWorkerPromises.delete(panelId);
          this.sftpWorkers.set(panelId, worker);
          if (!this.sftpWorkerOps.has(panelId)) this.sftpWorkerOps.set(panelId, new Map());
          resolve(worker);
        } else if (msg.type === 'connect-error') {
          if (!resolved) reject(new Error(msg.error));
        } else if (msg.type === 'progress') {
          reqs.get(msg.id)?.onProgress(msg.transferred, msg.total);
        } else if (msg.type === 'done') {
          reqs.get(msg.id)?.resolve(); reqs.delete(msg.id);
        } else if (msg.type === 'error') {
          reqs.get(msg.id)?.reject(new Error(msg.error)); reqs.delete(msg.id);
        } else if (msg.type === 'sftp-op-result') {
          const ops = this.sftpWorkerOps.get(panelId);
          const pending = ops?.get(msg.id);
          if (pending) { ops!.delete(msg.id); pending.resolve(msg.result); }
        } else if (msg.type === 'sftp-op-error') {
          const ops = this.sftpWorkerOps.get(panelId);
          const pending = ops?.get(msg.id);
          if (pending) { ops!.delete(msg.id); pending.reject(new Error(msg.error)); }
        }
      });
      worker.on('error', (e: Error) => {
        this.sftpWorkerPromises.delete(panelId);
        if (!resolved) reject(e);
        for (const r of reqs.values()) r.reject(e);
        reqs.clear();
        const ops = this.sftpWorkerOps.get(panelId);
        if (ops) { for (const p of ops.values()) p.reject(e); ops.clear(); }
        this.sftpWorkers.delete(panelId);
        this.sftpWorkerReqs.delete(panelId);
        this.sftpWorkerOps.delete(panelId);
      });
      worker.on('exit', () => {
        this.sftpWorkerPromises.delete(panelId);
        const ops = this.sftpWorkerOps.get(panelId);
        if (ops) { for (const p of ops.values()) p.reject(new Error('Worker exited')); ops.clear(); }
        this.sftpWorkers.delete(panelId);
        this.sftpWorkerReqs.delete(panelId);
        this.sftpWorkerOps.delete(panelId);
      });
    });
    this.sftpWorkerPromises.set(panelId, promise);
    return promise;
  }

  // Worker thread 에 SFTP 메타데이터 연산 요청 — stat/readdir/mkdir 등이 worker event loop 에서 처리됨
  private workerOp(panelId: string, op: string, opPath: string, args?: any, otherSession?: any): Promise<any> {
    const worker = this.sftpWorkers.get(panelId);
    if (!worker) return Promise.reject(new Error(`Worker not ready for op:${op}`));
    const id = `op-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const ops = this.sftpWorkerOps.get(panelId);
    if (!ops) return Promise.reject(new Error('Worker ops map not initialized'));
    return new Promise((resolve, reject) => {
      ops.set(id, { resolve, reject });
      worker.postMessage({ type: 'sftp-op', id, op, path: opPath, args, otherSession });
    });
  }

  // 전송 전용 별도 SFTP 세션 — 터미널과 분리된 SSH 연결로 전송 중 터미널 지연 방지
  private getDedicatedSftp(panelId: string): Promise<any> {
    const cached = this.sftpDedicatedSubsys.get(panelId);
    if (cached) return Promise.resolve(cached);

    const session = this.sessionStore.get(panelId);
    if (!session) return this.getSftp(panelId); // 세션 정보 없으면 공유 연결 fallback

    const rec = this.clients.get(panelId);
    if (!rec?.conn) return Promise.reject(new Error('연결되지 않음'));

    return new Promise((resolve, reject) => {
      // 기본 auth 설정
      const authCfg: any = { username: session.username, tryKeyboard: true, readyTimeout: 15000 };
      if (session.auth?.type === 'password' && session.auth.password) {
        authCfg.password = session.auth.password;
      } else if (session.auth?.type === 'key') {
        try { authCfg.privateKey = fs.readFileSync(session.auth.keyPath); } catch {}
      }

      const dedicatedConn = new Client();
      this.sftpDedicatedConn.set(panelId, dedicatedConn);

      const openSftp = () => {
        dedicatedConn.sftp((err: any, sftp: any) => {
          if (err) {
            this.sftpDedicatedConn.delete(panelId);
            return this.getSftp(panelId).then(resolve).catch(reject); // fallback
          }
          this.sftpDedicatedSubsys.set(panelId, sftp);
          const cleanup = () => {
            this.sftpDedicatedSubsys.delete(panelId);
            this.sftpDedicatedConn.delete(panelId);
            try { dedicatedConn.end(); } catch {}
          };
          sftp.on('close', cleanup);
          sftp.on('end', cleanup);
          resolve(sftp);
        });
      };

      dedicatedConn.on('error', () => {
        this.sftpDedicatedConn.delete(panelId);
        this.sftpDedicatedSubsys.delete(panelId);
        this.getSftp(panelId).then(resolve).catch(reject); // fallback
      });
      dedicatedConn.on('keyboard-interactive', (_n: any, _i: any, _l: any, _ps: any[], finish: any) => {
        finish(authCfg.password ? [authCfg.password] : []);
      });

      const hops = this._normalizeJumps(session);
      if (hops.length > 0) {
        // 이미 살아있는 transport 체인(primary + 중간 점프들)을 재사용해 최종 호스트로 한 번만
        // 더 터널링한다 (중간 점프 재핸드셰이크 회피). transportConns = [primary, jump1, ... jump(N-1)].
        const transports = (rec.transportConns && rec.transportConns.length) ? rec.transportConns : [rec.primaryConn || rec.conn];
        const tunnelConn = transports[transports.length - 1] || rec.primaryConn || rec.conn;
        const finalHop = hops[hops.length - 1];
        // 최종 홉 비밀번호 없으면 직전 홉(tunnelConn) 의 ~/.ssh/ 키를 읽어 인증 (passwordless ProxyJump).
        const prepFinalAuth = async (): Promise<any> => {
          if (finalHop.password) return { password: finalHop.password };
          try {
            const keyBuf = await this._readSshKeyFromConn(tunnelConn);
            if (keyBuf) return { privateKey: keyBuf };
          } catch { /* best-effort */ }
          const fb: any = {};
          if (authCfg.password) fb.password = authCfg.password;
          if (authCfg.privateKey) fb.privateKey = authCfg.privateKey;
          return fb;
        };
        prepFinalAuth().then(finalAuth => {
          tunnelConn.forwardOut('127.0.0.1', 0, finalHop.host, finalHop.port, (err: any, stream: any) => {
            if (err) {
              this.sftpDedicatedConn.delete(panelId);
              return this.getSftp(panelId).then(resolve).catch(reject);
            }
            const jumpCfg: any = { sock: stream, username: finalHop.user, tryKeyboard: !!finalAuth.password, readyTimeout: 15000, ...finalAuth };
            dedicatedConn.removeAllListeners('keyboard-interactive');
            dedicatedConn.on('keyboard-interactive', (_n: any, _i: any, _l: any, _ps: any[], finish: any) => {
              finish(jumpCfg.password ? [jumpCfg.password] : []);
            });
            dedicatedConn.once('ready', openSftp);
            dedicatedConn.connect({ ...jumpCfg, ...LEGACY_ALGO_OPT });
          });
        });
      } else {
        dedicatedConn.once('ready', openSftp);
        dedicatedConn.connect({ host: session.host, port: session.port || 22, ...authCfg, ...LEGACY_ALGO_OPT });
      }
    });
  }

  async handleSFTPDownload(panelId: string, remotePath: string, localPath: string, ctx?: any): Promise<void> {
    const filename = remotePath.split('/').pop() || remotePath;
    const extra = ctx ? { transferId: ctx.transferId, rel: ctx.rel ?? '', rootName: ctx.rootName, workspaceId: ctx.workspaceId, srcPath: remotePath, dstPath: localPath } : {};
    // Worker thread 사용 (메인 이벤트 루프 보호)
    let worker: Worker | null = null;
    try { worker = await this.getOrCreateSftpWorker(panelId); } catch { /* fallback */ }
    if (worker) {
      const reqId = `dl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      return new Promise((resolve, reject) => {
        let lastProgressEmit = 0;
        this.sftpWorkerReqs.get(panelId)?.set(reqId, {
          onProgress: (t, total) => {
            const now = Date.now();
            if (now - lastProgressEmit < 100 && t < total) return;
            lastProgressEmit = now;
            this.emit('message', { type: 'sftp-progress', panelId, data: JSON.stringify({ transferred: t, total, filename, direction: 'download', ...extra }) });
          },
          resolve: () => { this.emit('message', { type: 'sftp-complete', panelId, data: JSON.stringify({ filename, direction: 'download', localPath, ...extra }) }); resolve(); },
          reject: (e) => { this.emit('message', { type: 'sftp-error', panelId, error: String(e), data: JSON.stringify({ filename, direction: 'download', ...extra }) }); reject(e); },
        });
        worker!.postMessage({ type: 'transfer', id: reqId, action: 'download', srcPath: remotePath, dstPath: localPath });
      });
    }
    // Fallback: 전용 SFTP 직접 사용
    const sftp = await this.getDedicatedSftp(panelId);
    try {
      const stat: any = await new Promise((res, rej) => sftp.stat(remotePath, (e: any, s: any) => e ? rej(e) : res(s)));
      if (stat.size === 0) {
        fs.writeFileSync(localPath, Buffer.alloc(0));
        this.emit('message', { type: 'sftp-complete', panelId, data: JSON.stringify({ filename, direction: 'download', localPath, ...extra }) });
        return;
      }
    } catch { /* stat 실패하면 일반 다운로드 시도 */ }
    return new Promise((resolve, reject) => {
      let lastStepEmit = 0;
      sftp.fastGet(remotePath, localPath, {
        concurrency: 64, chunkSize: 65536,
        step: (transferred: number, _chunk: number, total: number) => {
          const now = Date.now();
          if (now - lastStepEmit < 150 && transferred < total) return;
          lastStepEmit = now;
          this.emit('message', { type: 'sftp-progress', panelId, data: JSON.stringify({ transferred, total, filename, direction: 'download', ...extra }) });
        },
      }, (err: any) => {
        if (err) { this.emit('message', { type: 'sftp-error', panelId, error: String(err), data: JSON.stringify({ filename, direction: 'download', ...extra }) }); return reject(err); }
        this.emit('message', { type: 'sftp-complete', panelId, data: JSON.stringify({ filename, direction: 'download', localPath, ...extra }) }); resolve();
      });
    });
  }

  async handleSFTPUpload(panelId: string, localPath: string, remotePath: string, ctx?: any): Promise<void> {
    const filename = localPath.replace(/\\/g, '/').split('/').pop() || localPath;
    const extra = ctx ? { transferId: ctx.transferId, rel: ctx.rel ?? '', rootName: ctx.rootName, workspaceId: ctx.workspaceId, srcPath: localPath, dstPath: remotePath } : {};
    // 0바이트 파일은 sftp.open/close 사용
    try {
      const localStat = fs.statSync(localPath);
      if (localStat.size === 0) {
        const sftp0 = await this.getDedicatedSftp(panelId);
        await new Promise<void>((res, rej) => { sftp0.open(remotePath, 'w', (err: any, handle: any) => { if (err) return rej(err); sftp0.close(handle, (e: any) => e ? rej(e) : res()); }); });
        this.emit('message', { type: 'sftp-complete', panelId, data: JSON.stringify({ filename, direction: 'upload', remotePath, ...extra }) });
        return;
      }
    } catch { /* stat 실패하면 일반 업로드 시도 */ }
    // Worker thread 사용
    let worker: Worker | null = null;
    try { worker = await this.getOrCreateSftpWorker(panelId); } catch { /* fallback */ }
    if (worker) {
      const reqId = `ul-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      return new Promise((resolve, reject) => {
        let lastProgressEmit = 0;
        this.sftpWorkerReqs.get(panelId)?.set(reqId, {
          onProgress: (t, total) => {
            const now = Date.now();
            if (now - lastProgressEmit < 100 && t < total) return;
            lastProgressEmit = now;
            this.emit('message', { type: 'sftp-progress', panelId, data: JSON.stringify({ transferred: t, total, filename, direction: 'upload', ...extra }) });
          },
          resolve: () => { this.emit('message', { type: 'sftp-complete', panelId, data: JSON.stringify({ filename, direction: 'upload', remotePath, ...extra }) }); resolve(); },
          reject: (e) => { this.emit('message', { type: 'sftp-error', panelId, error: String(e), data: JSON.stringify({ filename, direction: 'upload', ...extra }) }); reject(e); },
        });
        worker!.postMessage({ type: 'transfer', id: reqId, action: 'upload', srcPath: localPath, dstPath: remotePath });
      });
    }
    // Fallback
    const sftp = await this.getDedicatedSftp(panelId);
    return new Promise((resolve, reject) => {
      let lastStepEmit = 0;
      sftp.fastPut(localPath, remotePath, {
        concurrency: 64, chunkSize: 65536,
        step: (transferred: number, _chunk: number, total: number) => {
          const now = Date.now();
          if (now - lastStepEmit < 150 && transferred < total) return;
          lastStepEmit = now;
          this.emit('message', { type: 'sftp-progress', panelId, data: JSON.stringify({ transferred, total, filename, direction: 'upload', ...extra }) });
        },
      }, (err: any) => {
        if (err) { this.emit('message', { type: 'sftp-error', panelId, error: String(err), data: JSON.stringify({ filename, direction: 'upload', ...extra }) }); return reject(err); }
        this.emit('message', { type: 'sftp-complete', panelId, data: JSON.stringify({ filename, direction: 'upload', remotePath, ...extra }) }); resolve();
      });
    });
  }

  async handleSFTPListDir(panelId: string, remotePath: string): Promise<any[]> {
    const sftp = await this.getSftp(panelId);
    remotePath = await this.resolveCcPath(panelId, remotePath);
    return new Promise((resolve, reject) => {
      sftp.readdir(remotePath, (err: any, list: any[]) => {
        if (err) return reject(err);
        resolve(list.map((item: any) => {
          const attrs = item.attrs;
          const isDir = attrs.isDirectory();
          const isLink = typeof attrs.isSymbolicLink === 'function' ? attrs.isSymbolicLink() : false;
          // POSIX mode → drwxr-xr-x 형식 문자열
          const m = attrs.mode || 0;
          const typeChar = isLink ? 'l' : isDir ? 'd' : '-';
          const rwx = (bits: number) => {
            return (bits & 4 ? 'r' : '-') + (bits & 2 ? 'w' : '-') + (bits & 1 ? 'x' : '-');
          };
          const perm = typeChar
            + rwx((m >> 6) & 7)
            + rwx((m >> 3) & 7)
            + rwx(m & 7);
          // longname 에서 owner/group 추출 (예: "drwxr-xr-x  3 root root 4096 May 11 10:24 RPMS")
          let owner = '';
          let group = '';
          if (item.longname && typeof item.longname === 'string') {
            const parts = item.longname.trim().split(/\s+/);
            if (parts.length >= 4) {
              owner = parts[2];
              group = parts[3];
            }
          }
          return {
            name: item.filename,
            isDir,
            size: attrs.size,
            mtime: attrs.mtime,
            mode: perm,        // drwxr-xr-x 형식
            owner: owner || (attrs.uid != null ? String(attrs.uid) : ''),
            group: group || (attrs.gid != null ? String(attrs.gid) : ''),
            isLink,
          };
        }));
      });
    });
  }


  // ── 로컬 파일 조작 ──

  async handleLocalListDir(dirPath: string): Promise<any[]> {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    // 동시 stat 제한 — 무제한 Promise.all 은 네트워크 드라이브에서 핸들 폭주 위험
    const CONCURRENCY = 32;
    const result: any[] = new Array(entries.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, entries.length) }, async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= entries.length) return;
        const entry = entries[idx];
        try {
          const fullPath = path.join(dirPath, entry.name);
          const stat = await fs.promises.stat(fullPath);
          result[idx] = {
            name: entry.name,
            isDir: entry.isDirectory(),
            size: stat.size,
            mtime: Math.floor(stat.mtimeMs / 1000),
          };
        } catch { result[idx] = null; }
      }
    });
    await Promise.all(workers);
    return result.filter(x => x !== null);
  }

  async handleLocalDelete(filePath: string): Promise<void> {
    const stat = await fs.promises.stat(filePath);
    if (stat.isDirectory()) {
      await fs.promises.rm(filePath, { recursive: true });
    } else {
      await fs.promises.unlink(filePath);
    }
  }

  // 파일/디렉토리 개수 재귀 카운트 (삭제 진행률 계산용)
  private async countItemsRecursive(mode: string, termId: string | undefined, filePath: string): Promise<number> {
    try {
      if (mode === 'local') {
        const s = await fs.promises.stat(filePath);
        if (!s.isDirectory()) return 1;
        const entries = await fs.promises.readdir(filePath);
        const counts = await Promise.all(entries.map(e => this.countItemsRecursive(mode, undefined, path.join(filePath, e)).catch(() => 0)));
        return counts.reduce((a, b) => a + b, 0) + 1; // +1 for the dir itself
      } else {
        const sftp = await this.getDedicatedSftp(termId!);
        const s: any = await new Promise((res, rej) => sftp.stat(filePath, (e: any, st: any) => e ? rej(e) : res(st)));
        if (!s.isDirectory()) return 1;
        const list: any[] = await new Promise((res, rej) => sftp.readdir(filePath, (e: any, l: any) => e ? rej(e) : res(l)));
        const counts = await Promise.all(list.map((item: any) => {
          const childPath = filePath.endsWith('/') ? filePath + item.filename : filePath + '/' + item.filename;
          return this.countItemsRecursive(mode, termId, childPath).catch(() => 0);
        }));
        return counts.reduce((a, b) => a + b, 0) + 1;
      }
    } catch { return 1; }
  }

  // 재귀 삭제 + 진행률 콜백
  private async deleteRecursiveWithProgress(
    mode: string, termId: string | undefined, filePath: string,
    onItem: (name: string) => void,
  ): Promise<void> {
    if (mode === 'local') {
      let s: any;
      try { s = await fs.promises.stat(filePath); } catch { return; }
      if (s.isDirectory()) {
        const entries = await fs.promises.readdir(filePath);
        for (const e of entries) {
          await this.deleteRecursiveWithProgress(mode, undefined, path.join(filePath, e), onItem);
        }
        await fs.promises.rmdir(filePath);
        onItem(path.basename(filePath));
      } else {
        await fs.promises.unlink(filePath);
        onItem(path.basename(filePath));
      }
    } else {
      const sftp = await this.getDedicatedSftp(termId!);
      const deleteRecursive = async (p: string): Promise<void> => {
        const stats: any = await new Promise((res, rej) => sftp.stat(p, (e: any, st: any) => e ? rej(e) : res(st)));
        const name = p.split('/').pop() || p;
        if (stats.isDirectory()) {
          const entries: any[] = await new Promise((res, rej) => sftp.readdir(p, (e: any, l: any) => e ? rej(e) : res(l)));
          for (const entry of entries) {
            if (entry.filename === '.' || entry.filename === '..') continue;
            const childPath = p.endsWith('/') ? p + entry.filename : p + '/' + entry.filename;
            await deleteRecursive(childPath);
          }
          await new Promise<void>((res, rej) => sftp.rmdir(p, (e: any) => e ? rej(e) : res()));
          onItem(name);
        } else {
          await new Promise<void>((res, rej) => sftp.unlink(p, (e: any) => e ? rej(e) : res()));
          onItem(name);
        }
      };
      await deleteRecursive(filePath);
    }
  }

  // 진행률 이벤트를 emit 하면서 삭제
  public async handleDeleteWithProgress(deleteId: string, mode: string, termId: string | undefined, filePath: string, workspaceId?: string): Promise<void> {
    const rootName = mode === 'local'
      ? path.basename(filePath)
      : (filePath.split('/').pop() || filePath);

    // 즉시 start 이벤트 (totalCount=0 — 추후 업데이트)
    this.emit('message', { type: 'sftp-delete-start', panelId: 'transfer', data: JSON.stringify({
      deleteId, rootName, totalCount: 0, path: filePath, mode, workspaceId,
    })});

    let done = 0;
    const onItem = (name: string) => {
      done++;
      this.emit('message', { type: 'sftp-delete-progress', panelId: 'transfer', data: JSON.stringify({
        deleteId, done, currentName: name, workspaceId,
      })});
    };

    try {
      if (mode === 'local') {
        // 로컬: 기존 방식 (fs.rm recursive 가 OS 레벨에서 이미 빠름)
        this.countItemsRecursive(mode, undefined, filePath).then(totalCount => {
          this.emit('message', { type: 'sftp-delete-start', panelId: 'transfer', data: JSON.stringify({ deleteId, rootName, totalCount, path: filePath, mode, workspaceId }) });
        }).catch(() => {});
        await this.deleteRecursiveWithProgress(mode, undefined, filePath, onItem);
      } else {
        // ── 원격 고속 삭제 ──────────────────────────────────────────────────
        // 1) worker 준비 (없으면 생성)
        if (termId && !this.sftpWorkers.has(termId)) {
          try { await this.getOrCreateSftpWorker(termId); } catch {}
        }
        const hasWorker = !!(termId && this.sftpWorkers.has(termId));

        if (hasWorker) {
          // 2) root stat 으로 파일인지 디렉토리인지 확인
          let isRootDir = false;
          try {
            const rootStat = await this.workerOp(termId!, 'stat', filePath);
            isRootDir = !!(rootStat && rootStat.mode && (rootStat.mode & 0o170000) === 0o040000);
          } catch {}

          if (!isRootDir) {
            // 단일 파일 — unlink 1회
            try { await this.workerOp(termId!, 'unlink', filePath); } catch {}
            onItem(rootName);
          } else {
            // 3) tree-list 로 전체 목록 1번에 취득 (worker thread — 메인 이벤트루프 비점유)
            let entries: Array<{ rel: string; isDir: boolean }> = [];
            try {
              entries = (await this.workerOp(termId!, 'tree-list', filePath)) as Array<{ rel: string; isDir: boolean }>;
            } catch {
              // tree-list 실패 시 sequential fallback
              this.countItemsRecursive(mode, termId, filePath).then(totalCount => {
                this.emit('message', { type: 'sftp-delete-start', panelId: 'transfer', data: JSON.stringify({ deleteId, rootName, totalCount, path: filePath, mode, workspaceId }) });
              }).catch(() => {});
              await this.deleteRecursiveWithProgress(mode, termId, filePath, onItem);
              this.emit('message', { type: 'sftp-delete-complete', panelId: 'transfer', data: JSON.stringify({ deleteId, rootName, done, success: true, workspaceId }) });
              return;
            }

            // totalCount 즉시 업데이트
            const totalCount = entries.length + 1;
            this.emit('message', { type: 'sftp-delete-start', panelId: 'transfer', data: JSON.stringify({ deleteId, rootName, totalCount, path: filePath, mode, workspaceId }) });

            const joinPath = (base: string, rel: string) => base.endsWith('/') ? base + rel : base + '/' + rel;
            const fileEntries = entries.filter(e => !e.isDir);
            const dirEntries  = entries.filter(e =>  e.isDir).sort((a, b) =>
              b.rel.split('/').length - a.rel.split('/').length  // 깊은 것부터 rmdir
            );

            // 4) 파일 8개 병렬 unlink (worker thread 에서 처리)
            if (fileEntries.length > 0) {
              const PDEL = 8;
              const fileQueue = [...fileEntries];
              await Promise.all(Array.from({ length: Math.min(PDEL, fileQueue.length) }, async () => {
                while (fileQueue.length > 0) {
                  const entry = fileQueue.shift();
                  if (!entry) break;
                  try { await this.workerOp(termId!, 'unlink', joinPath(filePath, entry.rel)); } catch {}
                  onItem(entry.rel.split('/').pop() || entry.rel);
                }
              }));
            }

            // 5) 디렉토리 순차 rmdir (깊은 것부터 — 비어있어야 삭제 가능)
            for (const entry of dirEntries) {
              try { await this.workerOp(termId!, 'rmdir', joinPath(filePath, entry.rel)); } catch {}
              onItem(entry.rel.split('/').pop() || entry.rel);
            }

            // 6) 루트 디렉토리 rmdir
            try { await this.workerOp(termId!, 'rmdir', filePath); } catch {}
            onItem(rootName);
          }
        } else {
          // worker 없음 — 기존 sequential fallback
          this.countItemsRecursive(mode, termId, filePath).then(totalCount => {
            this.emit('message', { type: 'sftp-delete-start', panelId: 'transfer', data: JSON.stringify({ deleteId, rootName, totalCount, path: filePath, mode, workspaceId }) });
          }).catch(() => {});
          await this.deleteRecursiveWithProgress(mode, termId, filePath, onItem);
        }
      }

      this.emit('message', { type: 'sftp-delete-complete', panelId: 'transfer', data: JSON.stringify({
        deleteId, rootName, done, success: true, workspaceId,
      })});
    } catch (err: any) {
      this.emit('message', { type: 'sftp-delete-complete', panelId: 'transfer', data: JSON.stringify({
        deleteId, rootName, done, success: false, error: String(err?.message || err), workspaceId,
      })});
      throw err;
    }
  }

  async handleLocalMkdir(dirPath: string): Promise<void> {
    await fs.promises.mkdir(dirPath, { recursive: true });
  }

  async handleLocalRename(oldPath: string, newPath: string): Promise<void> {
    await fs.promises.rename(oldPath, newPath);
  }

  async handleSFTPReadFile(panelId: string, remotePath: string): Promise<Buffer> {
    this.markAgentBusy(panelId);
    try {
      const sftp = await this.getSftp(panelId);
      remotePath = await this.resolveCcPath(panelId, remotePath);
      return await new Promise((resolve, reject) => {
        sftp.readFile(remotePath, (err: any, data: Buffer) => {
          if (err) return reject(err);
          resolve(data);
        });
      });
    } finally {
      this.markAgentIdle(panelId);
    }
  }

  async handleSFTPWriteFile(panelId: string, remotePath: string, content: Buffer | string): Promise<void> {
    this.markAgentBusy(panelId);
    try {
      const sftp = await this.getSftp(panelId);
      remotePath = await this.resolveCcPath(panelId, remotePath);
      const buf = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
      return await new Promise<void>((resolve, reject) => {
        sftp.writeFile(remotePath, buf, (err: any) => err ? reject(err) : resolve());
      });
    } finally {
      this.markAgentIdle(panelId);
    }
  }

  async handleSFTPDelete(panelId: string, filePath: string): Promise<void> {
    const sftp = await this.getSftp(panelId);
    // 재귀 구현 — 폴더는 내부 파일/하위폴더 먼저 삭제 후 rmdir
    const deleteRecursive = async (p: string): Promise<void> => {
      const stats: any = await new Promise((res, rej) => sftp.stat(p, (e: any, s: any) => e ? rej(e) : res(s)));
      if (stats.isDirectory()) {
        const entries: any[] = await new Promise((res, rej) => sftp.readdir(p, (e: any, l: any) => e ? rej(e) : res(l)));
        for (const entry of entries) {
          if (entry.filename === '.' || entry.filename === '..') continue;
          const childPath = p.endsWith('/') ? p + entry.filename : p + '/' + entry.filename;
          await deleteRecursive(childPath);
        }
        await new Promise<void>((res, rej) => sftp.rmdir(p, (e: any) => e ? rej(e) : res()));
      } else {
        await new Promise<void>((res, rej) => sftp.unlink(p, (e: any) => e ? rej(e) : res()));
      }
    };
    await deleteRecursive(filePath);
  }

  async handleSFTPMkdir(panelId: string, dirPath: string): Promise<void> {
    const sftp = await this.getSftp(panelId);
    return new Promise((resolve, reject) => {
      sftp.mkdir(dirPath, (err: any) => err ? reject(err) : resolve());
    });
  }

  async handleSFTPRename(panelId: string, oldPath: string, newPath: string): Promise<void> {
    const sftp = await this.getSftp(panelId);
    return new Promise((resolve, reject) => {
      sftp.rename(oldPath, newPath, (err: any) => err ? reject(err) : resolve());
    });
  }

  // ── 범용 전송 (4가지 조합) ──

  // stat 1회 호출로 isDir + size + atime + mtime 를 한꺼번에 반환
  // (이전: isSrcDirectory + getSrcStat = 동일 경로 stat 2~3회 → 1회로 통합)
  private async getSrcStatFull(src: { mode: string; termId?: string; path: string }): Promise<{ isDir: boolean; size: number; atime: number; mtime: number; permMode: number }> {
    if (src.mode === 'local') {
      const s = await fs.promises.stat(src.path);
      return { isDir: s.isDirectory(), size: s.size, atime: Math.floor(s.atimeMs / 1000), mtime: Math.floor(s.mtimeMs / 1000), permMode: s.mode & 0o7777 };
    } else {
      if (src.termId && this.sftpWorkers.has(src.termId)) {
        const s = await this.workerOp(src.termId, 'stat', src.path);
        const isDir = !!(s && s.mode && (s.mode & 0o170000) === 0o040000);
        return { isDir, size: s.size || 0, atime: s.atime || 0, mtime: s.mtime || 0, permMode: (s.mode || 0) & 0o7777 };
      }
      const sftp = await this.getDedicatedSftp(src.termId!);
      const s: any = await new Promise((res, rej) => sftp.stat(src.path, (e: any, st: any) => e ? rej(e) : res(st)));
      const isDir = typeof s.isDirectory === 'function' ? s.isDirectory() : !!(s.mode && (s.mode & 0o170000) === 0o040000);
      return { isDir, size: s.size || 0, atime: s.atime || 0, mtime: s.mtime || 0, permMode: (s.mode || 0) & 0o7777 };
    }
  }

  // 파일 모드 (permission bits, 0o7777) 를 destination 에 적용 — 실패해도 무시
  private async setDstMode(dst: { mode: string; termId?: string; path: string }, permMode: number): Promise<void> {
    if (!permMode) return;
    try {
      if (dst.mode === 'local') {
        await fs.promises.chmod(dst.path, permMode & 0o7777);
      } else {
        if (dst.termId && this.sftpWorkers.has(dst.termId)) {
          await this.workerOp(dst.termId, 'chmod', dst.path, { mode: permMode & 0o7777 });
          return;
        }
        const sftp = await this.getDedicatedSftp(dst.termId!);
        await new Promise<void>((res, rej) => {
          sftp.chmod(dst.path, permMode & 0o7777, (e: any) => e ? rej(e) : res());
        });
      }
    } catch { /* 권한 설정 실패해도 무시 */ }
  }

  private async getSrcStat(src: { mode: string; termId?: string; path: string }): Promise<{ size: number; atime: number; mtime: number }> {
    if (src.mode === 'local') {
      const s = await fs.promises.stat(src.path);
      return { size: s.size, atime: Math.floor(s.atimeMs / 1000), mtime: Math.floor(s.mtimeMs / 1000) };
    } else {
      if (src.termId && this.sftpWorkers.has(src.termId)) {
        const s = await this.workerOp(src.termId, 'stat', src.path);
        return { size: s.size, atime: s.atime, mtime: s.mtime };
      }
      const sftp = await this.getDedicatedSftp(src.termId!);
      const s: any = await new Promise((res, rej) => sftp.stat(src.path, (e: any, st: any) => e ? rej(e) : res(st)));
      return { size: s.size, atime: s.atime, mtime: s.mtime };
    }
  }

  private async createEmptyFile(dst: { mode: string; termId?: string; path: string }): Promise<void> {
    if (dst.mode === 'local') {
      await fs.promises.writeFile(dst.path, Buffer.alloc(0));
    } else {
      const sftp = await this.getDedicatedSftp(dst.termId!);
      await new Promise<void>((res, rej) => {
        sftp.open(dst.path, 'w', (err: any, handle: any) => {
          if (err) return rej(err);
          sftp.close(handle, (e: any) => e ? rej(e) : res());
        });
      });
    }
  }

  private async setDstTimestamp(dst: { mode: string; termId?: string; path: string }, atime: number, mtime: number): Promise<void> {
    try {
      if (dst.mode === 'local') {
        await fs.promises.utimes(dst.path, atime, mtime);
      } else {
        if (dst.termId && this.sftpWorkers.has(dst.termId)) {
          await this.workerOp(dst.termId, 'utimes', dst.path, { atime, mtime });
          return;
        }
        const sftp = await this.getDedicatedSftp(dst.termId!);
        await new Promise<void>((res, rej) => {
          sftp.utimes(dst.path, atime, mtime, (e: any) => e ? rej(e) : res());
        });
      }
    } catch { /* 타임스탬프 설정 실패해도 무시 */ }
  }

  // 소스가 디렉토리인지 확인
  private async isSrcDirectory(src: { mode: string; termId?: string; path: string }): Promise<boolean> {
    try {
      if (src.mode === 'local') {
        const s = await fs.promises.stat(src.path);
        return s.isDirectory();
      } else {
        if (src.termId && this.sftpWorkers.has(src.termId)) {
          const s = await this.workerOp(src.termId, 'stat', src.path);
          return !!(s && s.mode && (s.mode & 0o170000) === 0o040000);
        }
        const sftp = await this.getDedicatedSftp(src.termId!);
        const s: any = await new Promise((res, rej) => sftp.stat(src.path, (e: any, st: any) => e ? rej(e) : res(st)));
        return s.isDirectory();
      }
    } catch { return false; }
  }

  // 대상 디렉토리 생성 (없으면)
  private async ensureDstDir(dst: { mode: string; termId?: string; path: string }): Promise<void> {
    try {
      if (dst.mode === 'local') {
        await fs.promises.mkdir(dst.path, { recursive: true });
      } else {
        if (dst.termId && this.sftpWorkers.has(dst.termId)) {
          try { await this.workerOp(dst.termId, 'stat', dst.path); return; } catch {} // 이미 존재
          try { await this.workerOp(dst.termId, 'mkdir', dst.path); } catch {} // 생성 실패해도 무시
          return;
        }
        const sftp = await this.getDedicatedSftp(dst.termId!);
        try {
          await new Promise<void>((res, rej) => sftp.stat(dst.path, (e: any) => e ? rej(e) : res()));
          return; // 이미 존재
        } catch {}
        await new Promise<void>((res, rej) => sftp.mkdir(dst.path, (e: any) => e ? rej(e) : res()));
      }
    } catch (err) { /* 이미 존재하면 무시 */ }
  }

  // 디렉토리 내용 나열 + isDir 타입 정보 포함 (추가 stat 호출 없이 readdir 정보 활용)
  private async listSrcDirWithTypes(src: { mode: string; termId?: string; path: string }): Promise<{ name: string; isDir: boolean }[]> {
    if (src.mode === 'local') {
      const entries = await fs.promises.readdir(src.path, { withFileTypes: true });
      return entries.map(e => ({ name: e.name, isDir: e.isDirectory() }));
    } else {
      if (src.termId && this.sftpWorkers.has(src.termId)) {
        const list: any[] = await this.workerOp(src.termId, 'readdir', src.path);
        return list.map((item: any) => ({
          name: item.filename,
          isDir: !!(item.attrs?.mode && (item.attrs.mode & 0o170000) === 0o040000),
        }));
      }
      const sftp = await this.getDedicatedSftp(src.termId!);
      const list: any[] = await new Promise((res, rej) => sftp.readdir(src.path, (e: any, l: any) => e ? rej(e) : res(l)));
      return list.map((item: any) => ({
        name: item.filename,
        isDir: typeof item.attrs?.isDirectory === 'function' ? item.attrs.isDirectory() : !!(item.attrs?.mode && (item.attrs.mode & 0o170000) === 0o040000),
      }));
    }
  }

  async handleTransfer(
    src: { mode: string; termId?: string; path: string },
    dst: { mode: string; termId?: string; path: string },
    filename: string,
    ctx?: { transferId: string; rootName: string; rel: string; rootIsDir?: boolean; workspaceId?: string },
    workspaceId?: string,
  ): Promise<void> {
    // 최상위 호출이면 ctx 자동 생성 + transfer-start 이벤트 즉시 송출
    const isRoot = !ctx;
    if (isRoot) {
      const transferId = `tx-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
      const direction = src.mode === 'local' && dst.mode === 'remote' ? 'upload'
        : src.mode === 'remote' && dst.mode === 'local' ? 'download'
        : src.mode === 'remote' && dst.mode === 'remote' ? 'remote-remote'
        : 'local-copy';
      ctx = { transferId, rootName: filename, rel: '', workspaceId: workspaceId || '' };
      // ★ async 작업 전에 즉시 emit — IPC 응답보다 먼저 렌더러에 도달하도록
      this.emit('message', { type: 'sftp-transfer-start', panelId: 'transfer', data: JSON.stringify({
        transferId, rootName: filename, rel: '', isDir: false, totalSize: 0,
        srcPath: src.path, dstPath: dst.path,
        srcMode: src.mode, dstMode: dst.mode, direction, workspaceId: workspaceId || '',
      })});
      // ★ UI 즉시 표시 후 worker 준비 대기 — 이후 모든 원격 SFTP ops가 worker thread에서 실행됨
      // (getDedicatedSftp 와 동일한 연결 시간이지만 메인 이벤트 루프를 점유하지 않음)
      if (src.termId) await this.getOrCreateSftpWorker(src.termId).catch(() => {});
      if (dst.termId && dst.termId !== src.termId) await this.getOrCreateSftpWorker(dst.termId).catch(() => {});
      // 실제 크기/디렉토리 여부는 비동기로 확인 후 file-start 이벤트에서 반영
      const rootIsDir = await this.isSrcDirectory(src);
      ctx.rootIsDir = rootIsDir;
      // 디렉토리면 totalSize 백그라운드 계산 — 전송 시작을 블록하지 않음
      if (rootIsDir) {
        const _tid = transferId; const _fn = filename; const _sp = src.path; const _dp = dst.path; const _sm = src.mode; const _dm = dst.mode; const _dir = direction; const _wid = workspaceId || '';
        this.computeTreeSize(src).then(totalSize => {
          this.emit('message', { type: 'sftp-transfer-start', panelId: 'transfer', data: JSON.stringify({
            transferId: _tid, rootName: _fn, rel: '', isDir: true, totalSize,
            srcPath: _sp, dstPath: _dp, srcMode: _sm, dstMode: _dm, direction: _dir, workspaceId: _wid,
          })});
        }).catch(() => {
          this.emit('message', { type: 'sftp-transfer-start', panelId: 'transfer', data: JSON.stringify({
            transferId: _tid, rootName: _fn, rel: '', isDir: true, totalSize: 0,
            srcPath: _sp, dstPath: _dp, srcMode: _sm, dstMode: _dm, direction: _dir, workspaceId: _wid,
          })});
        });
        // 백그라운드에서 전체 트리 목록 미리 emit — 전송 전 전체 항목 즉시 표시
        this.listTreeAndEmitDirList(src, transferId, filename, '', _wid).catch(() => {});
        // await 없이 즉시 전송 시작
      }
    }

    // 사용자가 취소했으면 중단
    if (this.cancelledTransfers.has(ctx!.transferId)) {
      this.emit('message', { type: 'sftp-complete', panelId: 'transfer', data: JSON.stringify({ filename, direction: 'cancelled', transferId: ctx!.transferId, rel: ctx!.rel, rootName: ctx!.rootName, workspaceId: ctx!.workspaceId }) });
      return;
    }

    // 충돌 검사 — 대상이 이미 존재하는지
    // getSrcStatFull 로 stat 1회 호출 → isDir/size/atime/mtime 한꺼번에 취득
    const srcStatFull = await this.getSrcStatFull(src);
    const srcIsDir = srcStatFull.isDir;
    const stat = await this.dstStat(dst);
    let resumeFrom = 0; // 파일 resume 용 — dst 의 기존 size
    if (stat.exists) {
      let action: string;
      let newName: string | undefined;
      // 먼저 기존 "모두 적용" 기본값 확인 (락 없이 빠르게)
      // 1) 현재 transferId 의 기본값 → 2) 워크스페이스 단위 TTL 캐시 (연속 드롭 기억)
      const kind = srcIsDir ? 'dir' : 'file';
      const quickDef = (this.transferDefaults.get(ctx!.transferId) || {})[kind]
        || this.getWorkspaceConflictDefault(ctx!.workspaceId, kind);
      if (quickDef) {
        action = quickDef;
        // 워크스페이스 캐시에서 가져왔다면 사용 시각 갱신 + 현재 transfer 에도 캐시
        const cur = this.transferDefaults.get(ctx!.transferId) || {};
        if (srcIsDir) cur.dir = action; else cur.file = action;
        this.transferDefaults.set(ctx!.transferId, cur);
        if (ctx!.workspaceId) this.setWorkspaceConflictDefault(ctx!.workspaceId, kind, action);
      } else {
        // 뮤텍스 획득 — 한 번에 다이얼로그 하나만 표시
        const release = await this.acquireConflictLock(ctx!.transferId);
        try {
          // 락 대기 중 다른 워커가 "모두 적용" 결정했을 수 있음 — 재확인
          const def = (this.transferDefaults.get(ctx!.transferId) || {})[kind]
            || this.getWorkspaceConflictDefault(ctx!.workspaceId, kind);
          if (def) {
            action = def;
          } else {
            // 사용자에게 묻기
            let srcStat: { size: number; mtime: number } = { size: 0, mtime: 0 };
            try { const s = await this.getSrcStat(src); srcStat = { size: s.size, mtime: s.mtime }; } catch {}
            const decision = await this.requestConflictDecision({
              transferId: ctx!.transferId,
              rel: ctx!.rel,
              name: filename,
              srcIsDir, dstIsDir: stat.isDir,
              srcSize: srcStat.size, dstSize: stat.size,
              srcMtime: srcStat.mtime, dstMtime: stat.mtime,
              srcPath: src.path, dstPath: dst.path,
              direction: src.mode === 'local' && dst.mode === 'remote' ? 'upload' : (src.mode === 'remote' && dst.mode === 'local' ? 'download' : (src.mode === 'remote' && dst.mode === 'remote' ? 'remote-remote' : 'local-copy')),
            });
            action = decision?.action || 'skip';
            newName = decision?.newName;
            if (decision?.applyAll) {
              const cur = this.transferDefaults.get(ctx!.transferId) || {};
              if (srcIsDir) cur.dir = action; else cur.file = action;
              this.transferDefaults.set(ctx!.transferId, cur);
              // 워크스페이스 단위로도 저장 → 다음 드롭에서도 같은 결정 재사용
              if (ctx!.workspaceId) this.setWorkspaceConflictDefault(ctx!.workspaceId, kind, action);
            }
            if (decision?.cancel) {
              this.cancelledTransfers.add(ctx!.transferId);
              this.emit('message', { type: 'sftp-complete', panelId: 'transfer', data: JSON.stringify({ filename, direction: 'cancelled', transferId: ctx!.transferId, rel: ctx!.rel, rootName: ctx!.rootName, workspaceId: ctx!.workspaceId, isDir: srcIsDir }) });
              return;
            }
          }
        } finally {
          release();
        }
      }
      if (action === 'skip') {
        this.emit('message', { type: 'sftp-complete', panelId: 'transfer', data: JSON.stringify({ filename, direction: 'skipped', transferId: ctx!.transferId, rel: ctx!.rel, rootName: ctx!.rootName, workspaceId: ctx!.workspaceId, isDir: srcIsDir }) });
        return;
      } else if (action === 'rename' && newName) {
        dst = this.renameDstPath(dst, newName);
      } else if (action === 'resume' && !srcIsDir) {
        resumeFrom = stat.size;
      }
      // 'overwrite' 면 그대로 진행
    }
    // 디렉토리면 재귀 복사 (srcIsDir 은 위에서 getSrcStatFull로 이미 취득)
    if (srcIsDir) {
      // 하위 디렉토리 행 표시 — 루트는 이미 sftp-transfer-start 로 표시됨
      if (ctx!.rel !== '') {
        this.emit('message', { type: 'sftp-file-start', panelId: 'transfer', data: JSON.stringify({
          transferId: ctx!.transferId, rel: ctx!.rel, rootName: ctx!.rootName, workspaceId: ctx!.workspaceId,
          size: 0, isDir: true, srcPath: src.path, dstPath: dst.path,
        })});
      }
      await this.ensureDstDir(dst);
      // isDir 포함 목록 (readdir 한 번으로 처리 — 추가 stat 없음)
      const entryInfos = await this.listSrcDirWithTypes(src);
      // 자식 목록 미리 emit — UI에서 pending 상태로 즉시 표시
      this.emit('message', { type: 'sftp-dir-list', panelId: 'transfer', data: JSON.stringify({
        transferId: ctx!.transferId, rel: ctx!.rel, rootName: ctx!.rootName, workspaceId: ctx!.workspaceId,
        entries: entryInfos.map(e => ({
          name: e.name, isDir: e.isDir,
          rel: ctx!.rel ? `${ctx!.rel}/${e.name}` : e.name,
        })),
      })});
      // 로컬은 OS 네이티브 separator(path.sep), 원격(SFTP)은 항상 '/'
      const joinPath = (base: string, name: string, mode: string): string => {
        if (mode === 'local') return path.join(base, name);
        if (base.endsWith('/')) return base + name;
        return base + '/' + name;
      };
      // 파일 4개 병렬 처리, 디렉토리는 순차 처리
      // (파일만 PARALLEL 풀에 넣어 지수적 동시성 폭발 방지 — 디렉토리가 PARALLEL 슬롯을 점유한 채
      //  재귀하면 깊은 트리에서 4^depth 수준의 동시 코루틴이 메인 이벤트 루프를 범람함)
      const PARALLEL = 4;
      const fileNames = entryInfos.filter(e => !e.isDir).map(e => e.name);
      const dirNames  = entryInfos.filter(e =>  e.isDir).map(e => e.name);
      // 파일 병렬 전송
      if (fileNames.length > 0) {
        const fileQueue = [...fileNames];
        await Promise.all(Array.from({ length: Math.min(PARALLEL, fileQueue.length) }, async () => {
          while (fileQueue.length > 0) {
            if (this.cancelledTransfers.has(ctx!.transferId)) return;
            const entry = fileQueue.shift();
            if (!entry) return;
            const childSrc = { ...src, path: joinPath(src.path, entry, src.mode) };
            const childDst = { ...dst, path: joinPath(dst.path, entry, dst.mode) };
            await this.handleTransfer(childSrc, childDst, entry, { ...ctx!, rel: ctx!.rel ? `${ctx!.rel}/${entry}` : entry }).catch(() => {});
          }
        }));
      }
      // 서브디렉토리 순차 처리 (재귀 깊이만큼 쌓이지 않도록)
      for (const entry of dirNames) {
        if (this.cancelledTransfers.has(ctx!.transferId)) break;
        const childSrc = { ...src, path: joinPath(src.path, entry, src.mode) };
        const childDst = { ...dst, path: joinPath(dst.path, entry, dst.mode) };
        await this.handleTransfer(childSrc, childDst, entry, { ...ctx!, rel: ctx!.rel ? `${ctx!.rel}/${entry}` : entry }).catch(() => {});
      }
      // 디렉토리 전송 완료 후 mode + atime/mtime 보존 — 자식 파일 복사로 dst 디렉토리의 mtime 이 변경되므로 마지막에 복원
      await this.setDstTimestamp(dst, srcStatFull.atime, srcStatFull.mtime);
      await this.setDstMode(dst, srcStatFull.permMode);
      this.emit('message', { type: 'sftp-complete', panelId: 'transfer', data: JSON.stringify({ filename, direction: 'dir-done', transferId: ctx!.transferId, rel: ctx!.rel, rootName: ctx!.rootName, workspaceId: ctx!.workspaceId, isDir: true }) });
      return;
    }

    // 소스 파일 속성 — getSrcStatFull 에서 이미 취득, 별도 stat 호출 불필요
    const srcStat = { size: srcStatFull.size, atime: srcStatFull.atime, mtime: srcStatFull.mtime, permMode: srcStatFull.permMode };

    // 파일 시작 알림 (size 포함)
    this.emit('message', { type: 'sftp-file-start', panelId: 'transfer', data: JSON.stringify({
      transferId: ctx!.transferId, rel: ctx!.rel, rootName: ctx!.rootName, workspaceId: ctx!.workspaceId, size: srcStat.size,
      srcPath: src.path, dstPath: dst.path,
    })});

    // 0바이트 파일 처리
    if (srcStat.size === 0) {
      await this.createEmptyFile(dst);
      await this.setDstTimestamp(dst, srcStat.atime, srcStat.mtime);
      await this.setDstMode(dst, srcStat.permMode);
      this.emit('message', { type: 'sftp-complete', panelId: 'transfer', data: JSON.stringify({ filename, direction: 'zero-byte', transferId: ctx!.transferId, rel: ctx!.rel, rootName: ctx!.rootName, workspaceId: ctx!.workspaceId }) });
      return;
    }

    const srcLocal = src.mode === 'local';
    const dstLocal = dst.mode === 'local';

    // resume(이어쓰기) — 비-디렉토리만 지원
    if (resumeFrom > 0 && resumeFrom < srcStat.size) {
      await this.resumeTransfer(src, dst, resumeFrom, srcStat.size, filename, ctx!);
      await this.setDstTimestamp(dst, srcStat.atime, srcStat.mtime);
      await this.setDstMode(dst, srcStat.permMode);
      return;
    }
    if (resumeFrom > 0 && resumeFrom >= srcStat.size) {
      // 이미 동일 또는 더 큰 크기 → 완료 처리
      this.emit('message', { type: 'sftp-complete', panelId: 'transfer', data: JSON.stringify({ filename, direction: 'resume-skipped', transferId: ctx!.transferId, rel: ctx!.rel, rootName: ctx!.rootName, workspaceId: ctx!.workspaceId }) });
      return;
    }
    if (srcLocal && dstLocal) {
      // 로컬 → 로컬 (스트림 기반 — progress 이벤트 방출)
      await new Promise<void>((resolve, reject) => {
        const readStream = fs.createReadStream(src.path);
        const writeStream = fs.createWriteStream(dst.path);
        let transferred = 0;
        let lastEmit = 0;
        const EMIT_INTERVAL = 200 * 1024; // 200KB마다 progress 방출
        readStream.on('data', (chunk: Buffer) => {
          transferred += chunk.length;
          if (transferred - lastEmit >= EMIT_INTERVAL || transferred >= srcStat.size) {
            lastEmit = transferred;
            this.emit('message', { type: 'sftp-progress', panelId: 'transfer', data: JSON.stringify({
              transferred, total: srcStat.size, filename, direction: 'local-copy',
              transferId: ctx!.transferId, rel: ctx!.rel, rootName: ctx!.rootName, workspaceId: ctx!.workspaceId,
            })});
          }
        });
        readStream.on('error', reject);
        writeStream.on('error', reject);
        writeStream.on('close', resolve);
        readStream.pipe(writeStream);
      });
      await this.setDstTimestamp(dst, srcStat.atime, srcStat.mtime);
      await this.setDstMode(dst, srcStat.permMode);
      this.emit('message', { type: 'sftp-complete', panelId: 'transfer', data: JSON.stringify({ filename, direction: 'local-copy', transferId: ctx!.transferId, rel: ctx!.rel, rootName: ctx!.rootName, workspaceId: ctx!.workspaceId }) });
    } else if (srcLocal && !dstLocal) {
      // 로컬 → 원격
      await this.handleSFTPUpload(dst.termId!, src.path, dst.path, ctx);
      await this.setDstTimestamp(dst, srcStat.atime, srcStat.mtime);
      await this.setDstMode(dst, srcStat.permMode);
    } else if (!srcLocal && dstLocal) {
      // 원격 → 로컬
      await this.handleSFTPDownload(src.termId!, src.path, dst.path, ctx);
      await this.setDstTimestamp(dst, srcStat.atime, srcStat.mtime);
      await this.setDstMode(dst, srcStat.permMode);
    } else {
      // 원격 → 원격 (Worker thread 에서 파이프 — 메인 이벤트 루프 보호)
      const srcTermId = src.termId!;
      const dstSession = this.sessionStore.get(dst.termId!);
      const extra = { transferId: ctx!.transferId, rel: ctx!.rel ?? '', rootName: ctx!.rootName, workspaceId: ctx!.workspaceId, srcPath: src.path, dstPath: dst.path };
      let worker: Worker | null = null;
      try { worker = await this.getOrCreateSftpWorker(srcTermId); } catch { /* fallback */ }
      if (worker) {
        const reqId = `rr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        await new Promise<void>((resolve, reject) => {
          let lastRRProgressEmit = 0;
        this.sftpWorkerReqs.get(srcTermId)?.set(reqId, {
            onProgress: (t, total) => {
              const now = Date.now();
              if (now - lastRRProgressEmit < 100 && t < total) return;
              lastRRProgressEmit = now;
              this.emit('message', { type: 'sftp-progress', panelId: 'transfer', data: JSON.stringify({ transferred: t, total, filename, direction: 'remote-remote', ...extra }) });
            },
            resolve: () => resolve(),
            reject: (e) => reject(e),
          });
          worker!.postMessage({ type: 'transfer', id: reqId, action: 'remote-remote', srcPath: src.path, dstPath: dst.path, dstSession, totalSize: srcStat.size });
        });
        await this.setDstTimestamp(dst, srcStat.atime, srcStat.mtime);
      await this.setDstMode(dst, srcStat.permMode);
        this.emit('message', { type: 'sftp-complete', panelId: 'transfer', data: JSON.stringify({ filename, direction: 'remote-remote', ...extra }) });
        return;
      }
      // Fallback: 메인 스레드에서 파이프 (Worker 사용 불가 시)
      const srcSftp = await this.getDedicatedSftp(srcTermId);
      const dstSftp = await this.getDedicatedSftp(dst.termId!);
      return new Promise((resolve, reject) => {
        const readStream = srcSftp.createReadStream(src.path);
        const writeStream = dstSftp.createWriteStream(dst.path);
        let transferred = 0; let lastEmitRR = 0;
        readStream.on('data', (chunk: Buffer) => {
          transferred += chunk.length;
          const now = Date.now();
          if (now - lastEmitRR < 150 && transferred < srcStat.size) return;
          lastEmitRR = now;
          this.emit('message', { type: 'sftp-progress', panelId: 'transfer', data: JSON.stringify({ transferred, total: srcStat.size, filename, direction: 'remote-remote', ...extra }) });
        });
        readStream.on('error', (err: any) => reject(err));
        writeStream.on('error', (err: any) => reject(err));
        writeStream.on('close', async () => {
          await this.setDstTimestamp(dst, srcStat.atime, srcStat.mtime);
      await this.setDstMode(dst, srcStat.permMode);
          this.emit('message', { type: 'sftp-complete', panelId: 'transfer', data: JSON.stringify({ filename, direction: 'remote-remote', ...extra }) });
          resolve();
        });
        readStream.pipe(writeStream);
      });
    }
  }

  // 이어쓰기(resume) — dst 의 기존 size 부터 src 의 나머지를 append
  private async resumeTransfer(
    src: { mode: string; termId?: string; path: string },
    dst: { mode: string; termId?: string; path: string },
    resumeFrom: number,
    totalSize: number,
    filename: string,
    ctx: { transferId: string; rootName: string; rel: string },
  ): Promise<void> {
    const direction = src.mode === 'local' && dst.mode === 'remote' ? 'upload' :
                      src.mode === 'remote' && dst.mode === 'local' ? 'download' :
                      src.mode === 'remote' && dst.mode === 'remote' ? 'remote-remote' : 'local-copy';
    const extra = { transferId: ctx.transferId, rel: ctx.rel, rootName: ctx.rootName, srcPath: src.path, dstPath: dst.path };

    let readStream: any, writeStream: any;
    if (src.mode === 'local') {
      readStream = fs.createReadStream(src.path, { start: resumeFrom });
    } else {
      const sftp = await this.getDedicatedSftp(src.termId!);
      readStream = sftp.createReadStream(src.path, { start: resumeFrom });
    }
    if (dst.mode === 'local') {
      writeStream = fs.createWriteStream(dst.path, { flags: 'a' });
    } else {
      const sftp = await this.getDedicatedSftp(dst.termId!);
      writeStream = sftp.createWriteStream(dst.path, { flags: 'a' });
    }
    return new Promise((resolve, reject) => {
      let transferred = resumeFrom;
      let lastEmit = 0;
      readStream.on('data', (chunk: Buffer) => {
        transferred += chunk.length;
        const now = Date.now();
        if (now - lastEmit >= 100 || transferred >= totalSize) {
          lastEmit = now;
          this.emit('message', { type: 'sftp-progress', panelId: 'transfer', data: JSON.stringify({ transferred, total: totalSize, filename, direction, ...extra }) });
        }
      });
      readStream.on('error', (err: any) => reject(err));
      writeStream.on('error', (err: any) => reject(err));
      const onDone = () => {
        this.emit('message', { type: 'sftp-progress', panelId: 'transfer', data: JSON.stringify({ transferred: totalSize, total: totalSize, filename, direction, ...extra }) });
        this.emit('message', { type: 'sftp-complete', panelId: 'transfer', data: JSON.stringify({ filename, direction, resumed: true, ...extra }) });
        resolve();
      };
      writeStream.on('close', onDone);
      writeStream.on('finish', onDone);
      readStream.pipe(writeStream);
    });
  }

  // 트리 전체를 재귀 탐색하여 sftp-dir-list 를 미리 emit — 전송 전 전체 목록 표시용
  private async listTreeAndEmitDirList(
    src: { mode: string; termId?: string; path: string },
    transferId: string, rootName: string, rel: string, workspaceId = '',
  ): Promise<void> {
    // 원격 소스이고 worker 준비됨 → 단일 worker 왕복으로 트리 전체 탐색 (메인 루프 부하 없음)
    if (src.mode === 'remote' && src.termId && this.sftpWorkers.has(src.termId)) {
      try {
        const allEntries: any[] = await this.workerOp(src.termId, 'tree-list', src.path);
        // rel → children[] 맵 구성 후 per-directory emit
        const dirMap = new Map<string, { rel: string; isDir: boolean }[]>();
        dirMap.set(rel, []);
        for (const e of allEntries) {
          const fullRel = rel ? `${rel}/${e.rel}` : e.rel;
          const parts = fullRel.split('/');
          const parentRel = parts.length === 1 ? rel : parts.slice(0, -1).join('/');
          if (!dirMap.has(parentRel)) dirMap.set(parentRel, []);
          dirMap.get(parentRel)!.push({ rel: fullRel, isDir: e.isDir });
        }
        for (const [dirRel, children] of dirMap) {
          if (children.length > 0) {
            this.emit('message', { type: 'sftp-dir-list', panelId: 'transfer', data: JSON.stringify({
              transferId, rel: dirRel, rootName, workspaceId, entries: children,
            })});
          }
        }
        return;
      } catch { /* fallback */ }
    }
    // fallback: 기존 dedicated 연결 재귀 방식
    try {
      const entryInfos = await this.listSrcDirWithTypes(src);
      this.emit('message', { type: 'sftp-dir-list', panelId: 'transfer', data: JSON.stringify({
        transferId, rel, rootName, workspaceId,
        entries: entryInfos.map(e => ({
          name: e.name, isDir: e.isDir,
          rel: rel ? `${rel}/${e.name}` : e.name,
        })),
      })});
      // 하위 디렉토리도 재귀 탐색 (병렬)
      await Promise.all(entryInfos.filter(e => e.isDir).map(e => {
        const childPath = src.mode === 'local'
          ? path.join(src.path, e.name)
          : (src.path.endsWith('/') ? src.path + e.name : src.path + '/' + e.name);
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        return this.listTreeAndEmitDirList({ ...src, path: childPath }, transferId, rootName, childRel, workspaceId).catch(() => {});
      }));
    } catch { /* 실패 무시 */ }
  }

  // 트리 전체 크기 계산 — Promise.all 병렬 처리로 원격 대형 트리도 빠르게 계산
  private async computeTreeSize(src: { mode: string; termId?: string; path: string }): Promise<number> {
    try {
      if (src.mode === 'local') {
        const stat = await fs.promises.stat(src.path);
        if (!stat.isDirectory()) return stat.size;
        const entries = await fs.promises.readdir(src.path);
        const sizes = await Promise.all(entries.map(e =>
          this.computeTreeSize({ ...src, path: path.join(src.path, e) }).catch(() => 0)
        ));
        return sizes.reduce((a, b) => a + b, 0);
      } else {
        // worker 준비됨 → 단일 왕복으로 트리 전체 크기 계산 (메인 루프 부하 없음)
        if (src.termId && this.sftpWorkers.has(src.termId)) {
          try { return await this.workerOp(src.termId, 'tree-size', src.path); } catch { /* fallback */ }
        }
        const sftp = await this.getDedicatedSftp(src.termId!);
        const stat: any = await new Promise((res, rej) => sftp.stat(src.path, (e: any, s: any) => e ? rej(e) : res(s)));
        if (!stat.isDirectory()) return stat.size;
        const list: any[] = await new Promise((res, rej) => sftp.readdir(src.path, (e: any, l: any) => e ? rej(e) : res(l)));
        const sizes = await Promise.all(list.map((item: any) =>
          this.computeTreeSize({ ...src, path: src.path.endsWith('/') ? src.path + item.filename : src.path + '/' + item.filename }).catch(() => 0)
        ));
        return sizes.reduce((a, b) => a + b, 0);
      }
    } catch { return 0; }
  }

  // AI 에이전트 작업 시작/종료 표시 — cwd 폴러가 경합을 피해 양보하도록.
  private markAgentBusy(panelId: string): void {
    const e = this.agentBusy.get(panelId) || { count: 0, lastAt: 0 };
    e.count++; e.lastAt = Date.now();
    this.agentBusy.set(panelId, e);
  }
  private markAgentIdle(panelId: string): void {
    const e = this.agentBusy.get(panelId);
    if (!e) return;
    e.count = Math.max(0, e.count - 1); e.lastAt = Date.now();
  }
  // 진행 중이거나 최근 1.2초 내 에이전트 활동이 있으면 true (연속 호출 사이 짧은 공백 흡수).
  private isAgentBusy(panelId: string): boolean {
    const e = this.agentBusy.get(panelId);
    if (!e) return false;
    return e.count > 0 || (Date.now() - e.lastAt < 1200);
  }

  // SSH exec: 원격에서 쉘 명령 실행하고 stdout/stderr/exitCode 반환
  // 세션 인코딩(utf-8/cp949/euc-kr 등)에 맞춰 command 바이트 변환 + 출력 디코딩
  public async handleExec(panelId: string, command: string, timeoutMs = 60000): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    this.markAgentBusy(panelId);
    try {
      return await this._handleExecInner(panelId, command, timeoutMs);
    } finally {
      this.markAgentIdle(panelId);
    }
  }

  private async _handleExecInner(panelId: string, command: string, timeoutMs = 60000): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    const entry = this.clients.get(panelId);
    if (!entry) throw new Error(`SSH session not connected: ${panelId}`);
    const conn: any = entry.conn;
    const enc = (entry.encoding || 'utf-8').toLowerCase();
    const iconv = require('iconv-lite');
    const useIconv = iconv.encodingExists(enc) && enc !== 'utf-8' && enc !== 'utf8';

    // 명령 문자열을 세션 인코딩 바이트로 변환해서 전달 (한글 깨짐 방지)
    const commandBuf: Buffer = useIconv ? iconv.encode(command, enc) : Buffer.from(command, 'utf-8');
    const commandToSend: string | Buffer = useIconv ? commandBuf : command;

    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('exec timeout')), timeoutMs);
      conn.exec(commandToSend as any, { pty: false }, (err: any, stream: any) => {
        if (err) { clearTimeout(to); return reject(err); }
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let exitCode: number | null = null;
        stream.on('data', (data: Buffer) => { stdoutChunks.push(data); });
        stream.stderr.on('data', (data: Buffer) => { stderrChunks.push(data); });
        stream.on('exit', (code: number) => { exitCode = code; });
        stream.on('close', () => {
          clearTimeout(to);
          const outBuf = Buffer.concat(stdoutChunks);
          const errBuf = Buffer.concat(stderrChunks);
          // 세션 인코딩이 utf-8 이어도 일부 파일/주석이 EUC-KR(CP949) 이면 mojibake(U+FFFD) 발생
          // → utf-8 디코드에 깨짐 문자가 있으면 cp949 로 재디코드해 더 적게 깨지는 쪽 채택.
          const smartDecode = (buf: Buffer): string => {
            if (useIconv) return iconv.decode(buf, enc);
            const u = buf.toString('utf-8');
            if (u.indexOf('�') < 0) return u;
            try {
              const k = iconv.decode(buf, 'cp949');
              const cU = (u.match(/�/g) || []).length;
              const cK = (k.match(/�/g) || []).length;
              if (cK < cU) return k;
            } catch { /* iconv 미지원 → utf-8 유지 */ }
            return u;
          };
          // 원격 셸 rc(.cshrc/.bashrc 등)가 비-TTY exec 에서 뱉는 무의미 노이즈 라인 제거.
          const cleanNoise = (s: string): string => s
            .split('\n')
            .filter(l => !/^\s*(stty|tcsh|csh|bash|sh):?\s*(standard input|['"]?standard input['"]?)?:?\s*(Invalid argument|Inappropriate ioctl for device|no job control in this shell|cannot set terminal process group)\s*$/i.test(l)
                      && !/^\s*stty:\s/i.test(l))
            .join('\n');
          const stdout = cleanNoise(smartDecode(outBuf));
          const stderr = cleanNoise(smartDecode(errBuf));
          resolve({ stdout, stderr, exitCode });
        });
      });
    });
  }

  async handleSFTPRealPath(panelId: string, remotePath: string): Promise<string> {
    const sftp = await this.getSftp(panelId);
    return new Promise((resolve, reject) => {
      sftp.realpath(remotePath, (err: any, absPath: string) => {
        if (err) return reject(err);
        resolve(absPath);
      });
    });
  }

  // jumps[] 가 주어지면 primary(host) 를 경유해 점프 체인을 거쳐 최종 호스트에 SFTP 직결.
  // 터미널 세션의 handleConnect 와 동일한 ProxyJump 패턴이지만 shell 대신 SFTP 채널만 유지.
  // 하위호환: jumps 미지정 + 단일 jumpOpts 만 오면 1홉 체인으로 변환.
  async handleSFTPConnect(
    connId: string,
    host: string,
    port: number,
    username: string,
    auth?: any,
    jumpOpts?: { host: string; user?: string; port?: number; password?: string },
    jumps?: { host: string; user?: string; port?: number; password?: string }[]
  ): Promise<void> {
    if (this.clients.has(connId)) return;
    // 점프 체인 정규화 — jumps[] 우선, 없으면 단일 jumpOpts 를 1홉으로.
    const rawHops = (Array.isArray(jumps) && jumps.length) ? jumps : (jumpOpts?.host ? [jumpOpts] : []);
    const hops = rawHops
      .filter(h => h && typeof h.host === 'string' && h.host.trim())
      .map(h => ({ host: h.host.trim(), user: (h.user && String(h.user).trim()) || 'root', port: Number(h.port) || 22, password: typeof h.password === 'string' ? h.password : '' }));
    const log = (msg: string) => {
      console.log(`[sftp-connect-${connId}] ${msg}`);
      try { require('electron').BrowserWindow.getAllWindows()[0]?.webContents.send('debug:log', `[sftp-connect] ${msg}`); } catch {}
    };
    log(`start host=${host} user=${username} jumps=${hops.length ? hops.map(h => h.host).join('→') : '(none)'}`);
    return new Promise((resolve, reject) => {
      const primaryConn = new Client();
      primaryConn.on('error', (err: any) => {
        log(`primary error: ${err?.message || err}`);
        reject(err);
      });
      // 비밀번호 미저장 세션 대비 keyboard-interactive 도 허용
      primaryConn.on('keyboard-interactive', (_n: any, _i: any, _l: any, prompts: any[], finish: (r: string[]) => void) => {
        if (auth?.type === 'password' && auth.password) finish([auth.password]);
        else finish(prompts.map(() => ''));
      });
      // 연결이 실제로 끊겼을 때 record 도 정리 — 재시도 시 새 connect 가 동작하도록.
      const cleanupOnClose = (label: string) => {
        log(`${label} closed — clearing record ${connId}`);
        this.clients.delete(connId);
        this.sftpCache.delete(connId);
      };
      primaryConn.on('end', () => cleanupOnClose('primary end'));
      primaryConn.on('close', () => cleanupOnClose('primary close'));
      primaryConn.on('ready', async () => {
        log(`primary ready`);
        if (hops.length === 0) {
          this.clients.set(connId, { conn: primaryConn });
          log(`no jump, saved as ${connId}`);
          resolve();
          return;
        }
        const ssh2Constants = require('ssh2/lib/protocol/constants');
        const LEGACY_ALGORITHMS = {
          kex: ssh2Constants.SUPPORTED_KEX,
          serverHostKey: ssh2Constants.SUPPORTED_SERVER_HOST_KEY,
          cipher: ssh2Constants.SUPPORTED_CIPHER,
          hmac: ssh2Constants.SUPPORTED_MAC,
        };
        const transportConns: any[] = [primaryConn];
        let transport = primaryConn;
        let keySrc = host; // 키 fallback 을 읽을 직전 호스트
        try {
          for (let i = 0; i < hops.length; i++) {
            const hop = hops[i];
            const authCfg: any = {};
            if (hop.password) {
              authCfg.password = hop.password;
            } else {
              log(`hop${i + 1} auth: reading key from ${keySrc}...`);
              const keyBuf = await this._readSshKeyFromConn(transport);
              if (!keyBuf) throw new Error(`${keySrc} 의 ~/.ssh/ 에서 사용 가능한 키 미발견`);
              authCfg.privateKey = keyBuf;
            }
            log(`hop${i + 1} forwardOut → ${hop.host}:${hop.port}`);
            const sock: any = await new Promise((res, rej) => {
              transport.forwardOut('127.0.0.1', 0, hop.host, hop.port, (e: any, s: any) => e ? rej(e) : res(s));
            });
            sock.on('error', (e: any) => log(`hop${i + 1} sock error: ${e?.message}`));
            const jumpConn = new Client();
            jumpConn.on('error', (e: any) => log(`hop${i + 1} conn error: ${e?.message}`));
            jumpConn.on('end', () => cleanupOnClose(`hop${i + 1} end`));
            jumpConn.on('close', () => cleanupOnClose(`hop${i + 1} close`));
            await new Promise<void>((res, rej) => {
              const onReady = () => { cleanup(); res(); };
              const onErr = (e: any) => { cleanup(); rej(e); };
              const cleanup = () => { jumpConn.removeListener('ready', onReady); jumpConn.removeListener('error', onErr); };
              jumpConn.once('ready', onReady);
              jumpConn.once('error', onErr);
              jumpConn.connect({
                sock, username: hop.user, ...authCfg,
                algorithms: LEGACY_ALGORITHMS,
                tryKeyboard: !!hop.password,
                readyTimeout: 30000, keepaliveInterval: 10000, keepaliveCountMax: 3,
              } as any);
            });
            log(`hop${i + 1} ready (${hop.host})`);
            if (i < hops.length - 1) transportConns.push(jumpConn);
            transport = jumpConn;
            keySrc = hop.host;
          }
          this.clients.set(connId, { conn: transport, primaryConn, transportConns });
          resolve();
        } catch (err: any) {
          log(`jump setup FAILED: ${err?.message || err}`);
          for (const tc of transportConns) { try { tc.end(); } catch {} }
          reject(err);
        }
      });
      // tryKeyboard: true 로 확장 — 비밀번호 모저장 세션 등 대비
      // keepalive — SQL Tool 등 장시간 idle 후 다시 명령 보낼 때 끊김 방지
      const cfg: any = {
        host, port, username, tryKeyboard: true, readyTimeout: 15000, keepaliveInterval: 10000, keepaliveCountMax: 3,
        ...LEGACY_ALGO_OPT,
      };
      if (auth?.type === 'password') {
        cfg.password = auth.password;
      } else if (auth?.type === 'key') {
        try { cfg.privateKey = fs.readFileSync(auth.keyPath); } catch (e: any) { log(`key read fail: ${e?.message}`); }
      }
      log(`primary connect...`);
      primaryConn.connect(cfg);
    });
  }

  // SSH exec 채널로 임의 명령을 실행하고 stdout/stderr 를 모아서 반환 (SQL Tool 용)
  handleSQLExec(connId: string, command: string, timeoutMs = 60000): Promise<{ stdout: string; stderr: string; code: number | null; truncated?: boolean }> {
    return new Promise((resolve, reject) => {
      const rec = this.clients.get(connId);
      if (!rec?.conn) return reject(new Error('not connected'));
      // 메인 프로세스 메모리 보호 — stdout/stderr 한도. 초과 시 stream.close() 로 강제 종료
      // (huge isql 출력이 main 프로세스 락걸지 않도록)
      const MAX_BYTES = 20 * 1024 * 1024; // 20MB
      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let truncated = false;
      let code: number | null = null;
      let closed = false;
      const safeClose = () => { if (closed) return; closed = true; try { stream.close(); } catch {} };
      let stream: any;
      try {
        rec.conn.exec(command, (err: any, s: any) => {
          if (err) return reject(err);
          stream = s;
          const timer = setTimeout(() => { safeClose(); reject(new Error('timeout')); }, timeoutMs);
          stream.on('data', (d: Buffer) => {
            if (truncated) return;
            const n = d.length;
            if (stdoutBytes + n > MAX_BYTES) {
              const left = MAX_BYTES - stdoutBytes;
              if (left > 0) { stdout += d.subarray(0, left).toString('utf8'); stdoutBytes += left; }
              truncated = true;
              safeClose();
              return;
            }
            stdout += d.toString('utf8'); stdoutBytes += n;
          });
          stream.stderr.on('data', (d: Buffer) => {
            if (stderrBytes >= MAX_BYTES) return;
            const n = Math.min(d.length, MAX_BYTES - stderrBytes);
            stderr += d.subarray(0, n).toString('utf8'); stderrBytes += n;
          });
          stream.on('exit', (c: number) => { code = c; });
          stream.on('close', () => { clearTimeout(timer); resolve({ stdout, stderr, code, truncated }); });
          stream.on('error', (e: any) => { clearTimeout(timer); reject(e); });
        });
      } catch (e: any) {
        reject(e);
      }
    });
  }

  handleSFTPDisconnect(connId: string) {
    const rec = this.clients.get(connId);
    if (!rec) return;
    try { rec.conn.end(); } catch {}
    try { rec.primaryConn?.end(); } catch {}
    this.clients.delete(connId);
    this.sftpCache.delete(connId);
  }

  getConnectedPanelIds(): string[] {
    return [...this.clients.keys()];
  }
}

// ── Expect/Send 실행기 ──

class ExpectSendRunner {
  private stream: any;
  private rules: LoginScriptRule[];
  private currentIdx = 0;
  private buffer = '';
  private running = true;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(stream: any, rules: LoginScriptRule[]) {
    this.stream = stream;
    this.rules = rules;
  }

  start() {
    // 전체 타임아웃: 30초
    this.timer = setTimeout(() => this.stop(), 30000);
    // expect가 빈 규칙은 즉시 실행
    this.runImmediate();
  }

  private runImmediate() {
    while (this.currentIdx < this.rules.length && this.rules[this.currentIdx].expect.trim() === '') {
      try { this.stream.write(this.rules[this.currentIdx].send + '\n'); } catch {}
      this.currentIdx++;
    }
    if (this.currentIdx >= this.rules.length) this.stop();
  }

  isRunning() { return this.running; }

  feed(data: string) {
    if (!this.running) return;
    this.buffer += data;
    this.tryMatch();
  }

  private tryMatch() {
    if (this.currentIdx >= this.rules.length) { this.stop(); return; }

    const rule = this.rules[this.currentIdx];
    let matched = false;

    if (rule.isRegex) {
      try {
        matched = new RegExp(rule.expect).test(this.buffer);
      } catch { matched = false; }
    } else {
      matched = this.buffer.includes(rule.expect);
    }

    if (matched) {
      // 매칭 → send 전송
      try {
        this.stream.write(rule.send + '\n');
      } catch {}
      this.buffer = '';
      this.currentIdx++;
      // expect 빈 규칙 즉시 실행
      this.runImmediate();
    }
  }

  private stop() {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
}

let instance: SSHBridge | null = null;

export function getSSHBridge(): SSHBridge {
  if (!instance) instance = new SSHBridge();
  return instance;
}
