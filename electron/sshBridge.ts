// electron/sshBridge.ts
import { Client } from 'ssh2';
import { EventEmitter } from 'events';
import net from 'net';
import fs from 'fs';
import path from 'path';
import iconv from 'iconv-lite';
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

interface ClientRecord {
  conn: any;           // 활성 SSH 연결 (점프 미사용 시 primary, 사용 시 jumpConn)
  stream?: any;
  encoding?: string;
  primaryConn?: any;   // 점프 사용 시 transport 로 쓰이는 primary 연결 (세션 종료 시 함께 해제)
}

interface BridgeMessage {
  type: 'data' | 'connected' | 'closed' | 'error' | 'auth-prompt' | 'sftp-progress' | 'sftp-complete' | 'sftp-error' | 'auto-track' | 'x11-log';
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
  private scriptRunners: Map<string, ExpectSendRunner> = new Map();
  private pendingAuth: Map<string, (responses: string[]) => void> = new Map();
  // 파일 충돌(이미 존재) 시 사용자 응답 대기
  private conflictResolvers: Map<string, (decision: any) => void> = new Map();
  // 전송별 "모두 적용" 기본 결정 — { [transferId]: { file?: 'overwrite'|'skip'|'resume', dir?: 'overwrite'|'skip' } }
  private transferDefaults: Map<string, { file?: string; dir?: string }> = new Map();
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
        const sftp = await this.getSftp(dst.termId!);
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
      const jumpHost = session.jumpTargetHost?.trim();
      if (jumpHost) {
        logLine('96', `▶ 점프 호스트 ${jumpHost}:${session.jumpTargetPort || 22} (${session.jumpTargetUser || 'root'}) 연결 중...`);
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

  // 점프 호스트 설정: primary 연결 위에 TCP 터널 생성 + 두번째 SSH 핸드셰이크 + 셸 오픈.
  // primary 의 ~/.ssh/ 에 있는 키 파일(id_rsa/id_ed25519/id_ecdsa)을 SFTP 로 읽어
  // 점프 타겟 인증에 재사용 (EMS→MPM01 passwordless 설정 그대로 활용).
  private async _setupJumpedSession(panelId: string, session: any, primaryConn: any, cols?: number, rows?: number): Promise<void> {
    const jumpHost = session.jumpTargetHost.trim();
    const jumpUser = (session.jumpTargetUser || 'root').trim();
    const jumpPort = Number(session.jumpTargetPort) || 22;
    const jumpPassword = typeof session.jumpTargetPassword === 'string' ? session.jumpTargetPassword : '';
    const t0 = Date.now();
    const stage = (name: string) => {
      const msg = `[jump-${panelId.slice(-6)}] ${name} +${Date.now() - t0}ms`;
      console.log(msg);
      try { require('electron').BrowserWindow.getAllWindows()[0]?.webContents.send('debug:log', msg); } catch {}
    };
    stage('start');

    // 1. 인증 방법 결정: 비밀번호 우선, 없으면 primary 의 ~/.ssh/ 키 자동 사용
    const authCfg: any = {};
    if (jumpPassword) {
      authCfg.password = jumpPassword;
    } else {
      const keyBuf = await this._readSshKeyFromConn(primaryConn);
      if (!keyBuf) {
        throw new Error(`${session.host} 의 ~/.ssh/ 에서 사용 가능한 SSH 키(id_rsa/id_ed25519/id_ecdsa) 미발견. 점프 타겟 비밀번호를 입력하거나 키 파일을 등록하세요.`);
      }
      authCfg.privateKey = keyBuf;
    }

    stage('key-read done');
    // 2. primary 위에 TCP 포워딩 — 점프 타겟:port 로
    const sock: any = await new Promise((resolve, reject) => {
      primaryConn.forwardOut('127.0.0.1', 0, jumpHost, jumpPort, (err: any, s: any) => {
        if (err) return reject(err);
        resolve(s);
      });
    });
    stage('forwardOut done');
    // sock 스트림에도 error 핸들러 — 미처리 시 main 프로세스 크래시
    sock.on('error', (e: any) => {
      console.log(`[jump-${panelId.slice(-6)}] tunnel sock error:`, e?.message || e);
    });

    // 3. 그 소켓 위에 두번째 SSH Client 연결
    //    점프 타겟이 Solaris/레거시 OpenSSH 등 구버전일 수 있어서 기본 알고리즘 외
    //    레거시까지 허용. SUPPORTED_* 는 ssh2 가 현재 시스템 crypto 기준으로 이미
    //    필터한 목록이라, unsupported algorithm 에러 없이 안전하게 넓혀 쓸 수 있음.
    const ssh2Constants = require('ssh2/lib/protocol/constants');
    const LEGACY_ALGORITHMS = {
      kex: ssh2Constants.SUPPORTED_KEX,
      serverHostKey: ssh2Constants.SUPPORTED_SERVER_HOST_KEY,
      cipher: ssh2Constants.SUPPORTED_CIPHER,
      hmac: ssh2Constants.SUPPORTED_MAC,
    };
    const jumpConn = new Client();
    // 영구 에러 핸들러 — handshake 이후 tunnel 이 끊겨도 uncaught exception 안 나게.
    // 에러 발생 시 해당 panel 로 error 메시지 전달.
    jumpConn.on('error', (e: any) => {
      console.log(`[jump-${panelId.slice(-6)}] jumpConn error:`, e?.message || e);
      try { this.emit('message', { type: 'error', panelId, error: `점프 연결 오류: ${e?.message || String(e)}` }); } catch {}
    });
    await new Promise<void>((resolve, reject) => {
      const onReady = () => { cleanup(); resolve(); };
      const onErr = (e: any) => { cleanup(); reject(e); };
      // 영구 error 핸들러는 위에서 이미 걸었으니 여기선 한번만 reject 용으로 래핑
      const wrappedErr = (e: any) => onErr(e);
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
        username: jumpUser,
        ...authCfg,
        algorithms: LEGACY_ALGORITHMS,
        tryKeyboard: !!jumpPassword, // 비밀번호 모드면 keyboard-interactive 도 허용
        // Solaris 레거시 KEX 는 CPU 집약적이라 동시 접속 시 15초로 부족. 30초로 늘림.
        readyTimeout: 30000,
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
        debug: x11Debug,
      } as any);
    });

    stage('jumpConn ready');
    // 4. 점프 타겟에서 shell + SFTP. primary 는 transport 로 유지.
    this._openShellOnConn(panelId, session, jumpConn, cols, rows, primaryConn);
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

  // 주어진 연결 위에 shell 을 열고 스트림·핸들러 연결. jump 사용 시 primaryConn 도 함께 받아
  // close 시 둘 다 정리.
  private _openShellOnConn(panelId: string, session: any, conn: any, cols: number | undefined, rows: number | undefined, primaryConn: any | undefined): void {
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
        try { primaryConn?.end(); } catch {}
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
        this.emit('message', { type: 'closed', panelId });
        try { conn.end(); } catch {}
        try { primaryConn?.end(); } catch {}
      });

      this.clients.set(panelId, { conn, stream, encoding: initialEncoding, primaryConn });

      // 세션 옵션 autoTrackPwd 가 켜져 있으면 백그라운드 PID 탐지 + cwd 폴링 시작 — 셸에 명령 안 보냄.
      if (session.autoTrackPwd) {
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
  // panel → 마지막으로 알려진 cwd (변경 감지용)
  private lastCwd: Map<string, string> = new Map();
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
    this._stopCwdPolling(panelId); // 중복 방지
    const baseInterval = 400;
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
      inFlight = true;
      const cmd = `/bin/sh -c 'printf "<<PEPE>>"; readlink /proc/${curPid}/cwd 2>/dev/null; printf "<<END>>"'`;
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
          let path = '';
          if (inner === '/') {
            path = '/';
          } else {
            const pathMatch = inner.match(/\/[A-Za-z0-9_\-./~]+/);
            if (pathMatch) path = pathMatch[0];
          }
          if (path) {
            const last = this.lastCwd.get(panelId);
            if (path !== last) {
              console.log(`[autotrack-${panelId.slice(-6)}] cwd changed: ${last} → ${path}`);
              this.lastCwd.set(panelId, path);
              const oscSeq = `\x1b]7;file://localhost${path}\x1b\\`;
              this.emit('message', { type: 'data', panelId, data: oscSeq });
            }
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
      if (this.shellPids.has(panelId)) {
        // PID 이미 알려짐 — 폴링만 시작
        this._startCwdPolling(panelId);
        this.emit('message', { type: 'auto-track', panelId, enabled: true });
      } else {
        // PID 미탐지 — exec 채널로 백그라운드 탐지 (셸에 명령 안 보냄)
        this._installOsc7Hook(panelId, '');
      }
    } else {
      // 폴링만 중지
      this._stopCwdPolling(panelId);
      this.emit('message', { type: 'auto-track', panelId, enabled: false });
    }
    return { success: true };
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
    this._stopCwdPolling(panelId);
    this.shellPids.delete(panelId);
    this.lastCwd.delete(panelId);
  }

  // 앱 종료 시 — 모든 SSH 연결을 일괄 종료. 비차단(fire-and-forget).
  disconnectAll() {
    for (const panelId of [...this.clients.keys()]) this.handleDisconnect(panelId);
    for (const panelId of [...this.pendingConnects.keys()]) this.handleDisconnect(panelId);
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

  async handleSFTPDownload(panelId: string, remotePath: string, localPath: string, ctx?: any): Promise<void> {
    const sftp = await this.getSftp(panelId);
    const filename = remotePath.split('/').pop() || remotePath;
    const extra = ctx ? { transferId: ctx.transferId, rel: ctx.rel ?? '', rootName: ctx.rootName, srcPath: remotePath, dstPath: localPath } : {};
    // 0바이트 파일 처리
    try {
      const stat: any = await new Promise((res, rej) => sftp.stat(remotePath, (e: any, s: any) => e ? rej(e) : res(s)));
      if (stat.size === 0) {
        fs.writeFileSync(localPath, Buffer.alloc(0));
        this.emit('message', { type: 'sftp-complete', panelId, data: JSON.stringify({ filename, direction: 'download', localPath, ...extra }) });
        return;
      }
    } catch { /* stat 실패하면 일반 다운로드 시도 */ }
    return new Promise((resolve, reject) => {
      sftp.fastGet(remotePath, localPath, {
        concurrency: 64,
        chunkSize: 32768,
        step: (transferred: number, _chunk: number, total: number) => {
          this.emit('message', { type: 'sftp-progress', panelId, data: JSON.stringify({ transferred, total, filename, direction: 'download', ...extra }) });
        },
      }, (err: any) => {
        if (err) {
          this.emit('message', { type: 'sftp-error', panelId, error: String(err), data: JSON.stringify({ filename, direction: 'download', ...extra }) });
          return reject(err);
        }
        this.emit('message', { type: 'sftp-complete', panelId, data: JSON.stringify({ filename, direction: 'download', localPath, ...extra }) });
        resolve();
      });
    });
  }

  async handleSFTPUpload(panelId: string, localPath: string, remotePath: string, ctx?: any): Promise<void> {
    const sftp = await this.getSftp(panelId);
    const filename = localPath.replace(/\\/g, '/').split('/').pop() || localPath;
    const extra = ctx ? { transferId: ctx.transferId, rel: ctx.rel ?? '', rootName: ctx.rootName, srcPath: localPath, dstPath: remotePath } : {};
    // 0바이트 파일 처리
    try {
      const localStat = fs.statSync(localPath);
      if (localStat.size === 0) {
        await new Promise<void>((res, rej) => {
          sftp.open(remotePath, 'w', (err: any, handle: any) => {
            if (err) return rej(err);
            sftp.close(handle, (e: any) => e ? rej(e) : res());
          });
        });
        this.emit('message', { type: 'sftp-complete', panelId, data: JSON.stringify({ filename, direction: 'upload', remotePath, ...extra }) });
        return;
      }
    } catch { /* stat 실패하면 일반 업로드 시도 */ }
    return new Promise((resolve, reject) => {
      sftp.fastPut(localPath, remotePath, {
        concurrency: 64,
        chunkSize: 32768,
        step: (transferred: number, _chunk: number, total: number) => {
          this.emit('message', { type: 'sftp-progress', panelId, data: JSON.stringify({ transferred, total, filename, direction: 'upload', ...extra }) });
        },
      }, (err: any) => {
        if (err) {
          this.emit('message', { type: 'sftp-error', panelId, error: String(err), data: JSON.stringify({ filename, direction: 'upload', ...extra }) });
          return reject(err);
        }
        this.emit('message', { type: 'sftp-complete', panelId, data: JSON.stringify({ filename, direction: 'upload', remotePath, ...extra }) });
        resolve();
      });
    });
  }

  async handleSFTPListDir(panelId: string, remotePath: string): Promise<any[]> {
    const sftp = await this.getSftp(panelId);
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

  async handleLocalMkdir(dirPath: string): Promise<void> {
    await fs.promises.mkdir(dirPath, { recursive: true });
  }

  async handleLocalRename(oldPath: string, newPath: string): Promise<void> {
    await fs.promises.rename(oldPath, newPath);
  }

  async handleSFTPReadFile(panelId: string, remotePath: string): Promise<Buffer> {
    const sftp = await this.getSftp(panelId);
    return new Promise((resolve, reject) => {
      sftp.readFile(remotePath, (err: any, data: Buffer) => {
        if (err) return reject(err);
        resolve(data);
      });
    });
  }

  async handleSFTPWriteFile(panelId: string, remotePath: string, content: Buffer | string): Promise<void> {
    const sftp = await this.getSftp(panelId);
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
    return new Promise((resolve, reject) => {
      sftp.writeFile(remotePath, buf, (err: any) => err ? reject(err) : resolve());
    });
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

  private async getSrcStat(src: { mode: string; termId?: string; path: string }): Promise<{ size: number; atime: number; mtime: number }> {
    if (src.mode === 'local') {
      const s = await fs.promises.stat(src.path);
      return { size: s.size, atime: Math.floor(s.atimeMs / 1000), mtime: Math.floor(s.mtimeMs / 1000) };
    } else {
      const sftp = await this.getSftp(src.termId!);
      const s: any = await new Promise((res, rej) => sftp.stat(src.path, (e: any, st: any) => e ? rej(e) : res(st)));
      return { size: s.size, atime: s.atime, mtime: s.mtime };
    }
  }

  private async createEmptyFile(dst: { mode: string; termId?: string; path: string }): Promise<void> {
    if (dst.mode === 'local') {
      await fs.promises.writeFile(dst.path, Buffer.alloc(0));
    } else {
      const sftp = await this.getSftp(dst.termId!);
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
        const sftp = await this.getSftp(dst.termId!);
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
        const sftp = await this.getSftp(src.termId!);
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
        const sftp = await this.getSftp(dst.termId!);
        try {
          await new Promise<void>((res, rej) => sftp.stat(dst.path, (e: any) => e ? rej(e) : res()));
          return; // 이미 존재
        } catch {}
        await new Promise<void>((res, rej) => sftp.mkdir(dst.path, (e: any) => e ? rej(e) : res()));
      }
    } catch (err) { /* 이미 존재하면 무시 */ }
  }

  // 소스 디렉토리 내용 나열
  private async listSrcDir(src: { mode: string; termId?: string; path: string }): Promise<string[]> {
    if (src.mode === 'local') {
      return await fs.promises.readdir(src.path);
    } else {
      const sftp = await this.getSftp(src.termId!);
      const list: any[] = await new Promise((res, rej) => sftp.readdir(src.path, (e: any, l: any) => e ? rej(e) : res(l)));
      return list.map((item: any) => item.filename);
    }
  }

  async handleTransfer(
    src: { mode: string; termId?: string; path: string },
    dst: { mode: string; termId?: string; path: string },
    filename: string,
    ctx?: { transferId: string; rootName: string; rel: string; rootIsDir?: boolean },
  ): Promise<void> {
    // 최상위 호출이면 ctx 자동 생성 + transfer-start 이벤트 송출
    const isRoot = !ctx;
    if (isRoot) {
      ctx = { transferId: `tx-${Date.now()}-${Math.random().toString(36).slice(2,8)}`, rootName: filename, rel: '' };
      const rootIsDir = await this.isSrcDirectory(src);
      ctx.rootIsDir = rootIsDir;
      // 전체 크기 사전 계산 (로컬 디렉토리만 사전 계산 — 원격은 비용 큼)
      let totalSize = 0;
      try {
        if (rootIsDir) totalSize = await this.computeTreeSize(src);
        else totalSize = (await this.getSrcStat(src)).size;
      } catch {}
      this.emit('message', { type: 'sftp-transfer-start', panelId: 'transfer', data: JSON.stringify({
        transferId: ctx.transferId, rootName: filename, rel: '', isDir: rootIsDir, totalSize,
        srcPath: src.path, dstPath: dst.path,
        srcMode: src.mode, dstMode: dst.mode,
        direction: src.mode === 'local' && dst.mode === 'remote' ? 'upload' : (src.mode === 'remote' && dst.mode === 'local' ? 'download' : (src.mode === 'remote' && dst.mode === 'remote' ? 'remote-remote' : 'local-copy')),
      })});
    }

    // 사용자가 취소했으면 중단
    if (this.cancelledTransfers.has(ctx!.transferId)) {
      this.emit('message', { type: 'sftp-complete', panelId: 'transfer', data: JSON.stringify({ filename, direction: 'cancelled', transferId: ctx!.transferId, rel: ctx!.rel, rootName: ctx!.rootName }) });
      return;
    }

    // 충돌 검사 — 대상이 이미 존재하는지
    const srcIsDir = await this.isSrcDirectory(src);
    const stat = await this.dstStat(dst);
    let resumeFrom = 0; // 파일 resume 용 — dst 의 기존 size
    if (stat.exists) {
      const defaults = this.transferDefaults.get(ctx!.transferId) || {};
      const def = srcIsDir ? defaults.dir : defaults.file;
      let action: string;
      let newName: string | undefined;
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
        }
        if (decision?.cancel) {
          this.cancelledTransfers.add(ctx!.transferId);
          this.emit('message', { type: 'sftp-complete', panelId: 'transfer', data: JSON.stringify({ filename, direction: 'cancelled', transferId: ctx!.transferId, rel: ctx!.rel, rootName: ctx!.rootName, isDir: srcIsDir }) });
          return;
        }
      }
      if (action === 'skip') {
        this.emit('message', { type: 'sftp-complete', panelId: 'transfer', data: JSON.stringify({ filename, direction: 'skipped', transferId: ctx!.transferId, rel: ctx!.rel, rootName: ctx!.rootName, isDir: srcIsDir }) });
        return;
      } else if (action === 'rename' && newName) {
        dst = this.renameDstPath(dst, newName);
      } else if (action === 'resume' && !srcIsDir) {
        resumeFrom = stat.size;
      }
      // 'overwrite' 면 그대로 진행
    }
    // 디렉토리면 재귀 복사
    if (await this.isSrcDirectory(src)) {
      await this.ensureDstDir(dst);
      const entries = await this.listSrcDir(src);
      // 로컬은 OS 네이티브 separator(path.sep), 원격(SFTP)은 항상 '/'
      const joinPath = (base: string, name: string, mode: string): string => {
        if (mode === 'local') return path.join(base, name);
        if (base.endsWith('/')) return base + name;
        return base + '/' + name;
      };
      for (const entry of entries) {
        const childSrc = { ...src, path: joinPath(src.path, entry, src.mode) };
        const childDst = { ...dst, path: joinPath(dst.path, entry, dst.mode) };
        const childRel = ctx!.rel ? `${ctx!.rel}/${entry}` : entry;
        await this.handleTransfer(childSrc, childDst, entry, { ...ctx!, rel: childRel });
      }
      this.emit('message', { type: 'sftp-complete', panelId: 'transfer', data: JSON.stringify({ filename, direction: 'dir-done', transferId: ctx!.transferId, rel: ctx!.rel, rootName: ctx!.rootName, isDir: true }) });
      return;
    }

    // 소스 파일 속성 가져오기
    let srcStat: { size: number; atime: number; mtime: number };
    try { srcStat = await this.getSrcStat(src); } catch { srcStat = { size: -1, atime: 0, mtime: 0 }; }

    // 파일 시작 알림 (size 포함)
    this.emit('message', { type: 'sftp-file-start', panelId: 'transfer', data: JSON.stringify({
      transferId: ctx!.transferId, rel: ctx!.rel, rootName: ctx!.rootName, size: srcStat.size,
      srcPath: src.path, dstPath: dst.path,
    })});

    // 0바이트 파일 처리
    if (srcStat.size === 0) {
      await this.createEmptyFile(dst);
      await this.setDstTimestamp(dst, srcStat.atime, srcStat.mtime);
      this.emit('message', { type: 'sftp-complete', panelId: 'transfer', data: JSON.stringify({ filename, direction: 'zero-byte', transferId: ctx!.transferId, rel: ctx!.rel, rootName: ctx!.rootName }) });
      return;
    }

    const srcLocal = src.mode === 'local';
    const dstLocal = dst.mode === 'local';

    // resume(이어쓰기) — 비-디렉토리만 지원
    if (resumeFrom > 0 && resumeFrom < srcStat.size) {
      await this.resumeTransfer(src, dst, resumeFrom, srcStat.size, filename, ctx!);
      await this.setDstTimestamp(dst, srcStat.atime, srcStat.mtime);
      return;
    }
    if (resumeFrom > 0 && resumeFrom >= srcStat.size) {
      // 이미 동일 또는 더 큰 크기 → 완료 처리
      this.emit('message', { type: 'sftp-complete', panelId: 'transfer', data: JSON.stringify({ filename, direction: 'resume-skipped', transferId: ctx!.transferId, rel: ctx!.rel, rootName: ctx!.rootName }) });
      return;
    }
    if (srcLocal && dstLocal) {
      // 로컬 → 로컬
      await fs.promises.copyFile(src.path, dst.path);
      await this.setDstTimestamp(dst, srcStat.atime, srcStat.mtime);
      this.emit('message', { type: 'sftp-complete', panelId: 'transfer', data: JSON.stringify({ filename, direction: 'local-copy', transferId: ctx!.transferId, rel: ctx!.rel, rootName: ctx!.rootName }) });
    } else if (srcLocal && !dstLocal) {
      // 로컬 → 원격
      await this.handleSFTPUpload(dst.termId!, src.path, dst.path, ctx);
      await this.setDstTimestamp(dst, srcStat.atime, srcStat.mtime);
    } else if (!srcLocal && dstLocal) {
      // 원격 → 로컬
      await this.handleSFTPDownload(src.termId!, src.path, dst.path, ctx);
      await this.setDstTimestamp(dst, srcStat.atime, srcStat.mtime);
    } else {
      // 원격 → 원격 (스트림 파이프)
      const srcSftp = await this.getSftp(src.termId!);
      const dstSftp = await this.getSftp(dst.termId!);
      return new Promise((resolve, reject) => {
        const readStream = srcSftp.createReadStream(src.path);
        const writeStream = dstSftp.createWriteStream(dst.path);
        let transferred = 0;
        readStream.on('data', (chunk: Buffer) => {
          transferred += chunk.length;
          this.emit('message', { type: 'sftp-progress', panelId: 'transfer', data: JSON.stringify({ transferred, total: srcStat.size, filename, direction: 'remote-remote', transferId: ctx!.transferId, rel: ctx!.rel, rootName: ctx!.rootName }) });
        });
        readStream.on('error', (err: any) => reject(err));
        writeStream.on('error', (err: any) => reject(err));
        writeStream.on('close', async () => {
          await this.setDstTimestamp(dst, srcStat.atime, srcStat.mtime);
          this.emit('message', { type: 'sftp-complete', panelId: 'transfer', data: JSON.stringify({ filename, direction: 'remote-remote', transferId: ctx!.transferId, rel: ctx!.rel, rootName: ctx!.rootName }) });
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
      const sftp = await this.getSftp(src.termId!);
      readStream = sftp.createReadStream(src.path, { start: resumeFrom });
    }
    if (dst.mode === 'local') {
      writeStream = fs.createWriteStream(dst.path, { flags: 'a' });
    } else {
      const sftp = await this.getSftp(dst.termId!);
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

  // 트리 전체 크기 계산 (로컬만 정확 / 원격은 한 단계만)
  private async computeTreeSize(src: { mode: string; termId?: string; path: string }): Promise<number> {
    try {
      if (src.mode === 'local') {
        const stat = await fs.promises.stat(src.path);
        if (!stat.isDirectory()) return stat.size;
        let total = 0;
        const entries = await fs.promises.readdir(src.path);
        for (const e of entries) {
          total += await this.computeTreeSize({ ...src, path: path.join(src.path, e) });
        }
        return total;
      } else {
        const sftp = await this.getSftp(src.termId!);
        const stat: any = await new Promise((res, rej) => sftp.stat(src.path, (e: any, s: any) => e ? rej(e) : res(s)));
        if (!stat.isDirectory()) return stat.size;
        const list: any[] = await new Promise((res, rej) => sftp.readdir(src.path, (e: any, l: any) => e ? rej(e) : res(l)));
        let total = 0;
        for (const item of list) {
          total += await this.computeTreeSize({ ...src, path: src.path.endsWith('/') ? src.path + item.filename : src.path + '/' + item.filename });
        }
        return total;
      }
    } catch { return 0; }
  }

  // SSH exec: 원격에서 쉘 명령 실행하고 stdout/stderr/exitCode 반환
  // 세션 인코딩(utf-8/cp949/euc-kr 등)에 맞춰 command 바이트 변환 + 출력 디코딩
  public async handleExec(panelId: string, command: string, timeoutMs = 60000): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
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
          const stdout = useIconv ? iconv.decode(outBuf, enc) : outBuf.toString('utf-8');
          const stderr = useIconv ? iconv.decode(errBuf, enc) : errBuf.toString('utf-8');
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

  // jumpOpts 가 주어지면 primary(host) 를 경유해서 점프 타겟에 SFTP 직결.
  // 터미널 세션의 handleConnect 와 동일한 ProxyJump 패턴이지만 shell 대신 SFTP 채널만 유지.
  async handleSFTPConnect(
    connId: string,
    host: string,
    port: number,
    username: string,
    auth?: any,
    jumpOpts?: { host: string; user?: string; port?: number; password?: string }
  ): Promise<void> {
    if (this.clients.has(connId)) return;
    const log = (msg: string) => {
      console.log(`[sftp-connect-${connId}] ${msg}`);
      try { require('electron').BrowserWindow.getAllWindows()[0]?.webContents.send('debug:log', `[sftp-connect] ${msg}`); } catch {}
    };
    log(`start host=${host} user=${username} jump=${jumpOpts?.host || '(none)'}`);
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
      primaryConn.on('ready', async () => {
        log(`primary ready`);
        if (!jumpOpts?.host) {
          this.clients.set(connId, { conn: primaryConn });
          log(`no jump, saved as ${connId}`);
          resolve();
          return;
        }
        try {
          const jumpHost = jumpOpts.host;
          const jumpUser = jumpOpts.user || 'root';
          const jumpPort = jumpOpts.port || 22;
          const authCfg: any = {};
          if (jumpOpts.password) {
            authCfg.password = jumpOpts.password;
            log(`jump auth: password`);
          } else {
            log(`jump auth: reading key from primary...`);
            const keyBuf = await this._readSshKeyFromConn(primaryConn);
            if (!keyBuf) throw new Error(`${host} 의 ~/.ssh/ 에서 사용 가능한 키 미발견`);
            authCfg.privateKey = keyBuf;
            log(`jump auth: key read (${keyBuf.length}B)`);
          }
          log(`forwardOut → ${jumpHost}:${jumpPort}`);
          const sock: any = await new Promise((res, rej) => {
            primaryConn.forwardOut('127.0.0.1', 0, jumpHost, jumpPort, (e: any, s: any) => e ? rej(e) : res(s));
          });
          sock.on('error', (e: any) => log(`sock error: ${e?.message}`));
          log(`forwardOut done, opening jump SSH`);
          const ssh2Constants = require('ssh2/lib/protocol/constants');
          const jumpConn = new Client();
          jumpConn.on('error', (e: any) => log(`jumpConn error: ${e?.message}`));
          await new Promise<void>((res, rej) => {
            const onReady = () => { cleanup(); res(); };
            const onErr = (e: any) => { cleanup(); rej(e); };
            const cleanup = () => { jumpConn.removeListener('ready', onReady); jumpConn.removeListener('error', onErr); };
            jumpConn.once('ready', onReady);
            jumpConn.once('error', onErr);
            jumpConn.connect({
              sock,
              username: jumpUser,
              ...authCfg,
              algorithms: {
                kex: ssh2Constants.SUPPORTED_KEX,
                serverHostKey: ssh2Constants.SUPPORTED_SERVER_HOST_KEY,
                cipher: ssh2Constants.SUPPORTED_CIPHER,
                hmac: ssh2Constants.SUPPORTED_MAC,
              },
              tryKeyboard: !!jumpOpts.password,
              readyTimeout: 30000,
            } as any);
          });
          log(`jumpConn ready`);
          this.clients.set(connId, { conn: jumpConn, primaryConn });
          resolve();
        } catch (err: any) {
          log(`jump setup FAILED: ${err?.message || err}`);
          try { primaryConn.end(); } catch {}
          reject(err);
        }
      });
      // tryKeyboard: true 로 확장 — 비밀번호 모저장 세션 등 대비
      const cfg: any = { host, port, username, tryKeyboard: true, readyTimeout: 15000 };
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
