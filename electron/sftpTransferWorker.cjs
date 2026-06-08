'use strict';
// SFTP 전송 전용 Worker Thread — 모든 SFTP I/O를 메인 이벤트 루프에서 분리
const { workerData, parentPort } = require('worker_threads');
const { Client } = require('ssh2');
const fs = require('fs');

const session = workerData.session;
let sftpConn = null;   // 전용 SSH Client
let sftp = null;       // SFTP 세션

// 원격→원격 전송용 목적지 연결 캐시 (dstKey → { client, sftp })
const dstConnections = new Map();

// 처리량 우선 알고리즘 — AES-NI 가속 GCM 을 최우선(대부분 최신 CPU 에서 가장 빠름).
// ⚠ ssh2 의 algorithms 옵션은 기본 목록을 "완전 대체" 하므로, 빠른 항목을 앞에 두되
//    SUPPORTED_* 전체를 뒤에 붙여 구버전 서버 호환성을 유지한다(우선순위만 변경).
const FAST_ALGORITHMS = (() => {
  let SUP;
  try { SUP = require('ssh2/lib/protocol/constants'); } catch (_e) { SUP = null; }
  const dedup = (preferred, full) => {
    const out = [];
    const seen = new Set();
    for (const a of preferred) { if (!seen.has(a)) { seen.add(a); out.push(a); } }
    for (const a of (full || [])) { if (!seen.has(a)) { seen.add(a); out.push(a); } }
    return out;
  };
  const fastCipher = ['aes128-gcm@openssh.com', 'aes256-gcm@openssh.com', 'aes128-ctr', 'aes192-ctr', 'aes256-ctr', 'chacha20-poly1305@openssh.com'];
  const fastKex = ['curve25519-sha256', 'curve25519-sha256@libssh.org', 'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521'];
  if (!SUP) return { cipher: fastCipher, kex: fastKex };
  return {
    cipher: dedup(fastCipher, SUP.SUPPORTED_CIPHER),
    kex: dedup(fastKex, SUP.SUPPORTED_KEX),
    serverHostKey: SUP.SUPPORTED_SERVER_HOST_KEY,
    hmac: SUP.SUPPORTED_MAC,
  };
})();

function buildAuth(s) {
  const cfg = {
    username: s.username, tryKeyboard: true, readyTimeout: 15000, keepaliveInterval: 10000,
    algorithms: FAST_ALGORITHMS,
    // 압축 비활성 — LAN/고대역 환경에서 압축은 CPU 병목만 유발 (이미 압축된 파일도 많음)
    compress: false,
  };
  if (s.auth && s.auth.type === 'password' && s.auth.password) {
    cfg.password = s.auth.password;
  } else if (s.auth && s.auth.type === 'key' && s.auth.keyPath) {
    try { cfg.privateKey = fs.readFileSync(s.auth.keyPath); } catch (_e) {}
  }
  return cfg;
}

function openSftpOn(client) {
  return new Promise((resolve, reject) => {
    client.sftp((err, s) => {
      if (err) return reject(err);
      s.on('close', () => { sftp = null; });
      s.on('end',   () => { sftp = null; });
      sftp = s;
      resolve(s);
    });
  });
}

function connectDirect() {
  return new Promise((resolve, reject) => {
    const authCfg = buildAuth(session);
    const client = new Client();
    sftpConn = client;
    client.on('error', reject);
    client.on('keyboard-interactive', (_n, _i, _l, _ps, finish) => {
      finish(authCfg.password ? [authCfg.password] : []);
    });
    client.once('ready', () => openSftpOn(client).then(resolve).catch(reject));
    client.connect({ host: session.host, port: session.port || 22, ...authCfg });
  });
}

function connectViaJump() {
  return new Promise((resolve, reject) => {
    const authCfg = buildAuth(session);
    const jumpHost = session.jumpTargetHost.trim();
    const jumpPort = session.jumpTargetPort || 22;

    // 1) primary 연결
    const primary = new Client();
    primary.on('error', reject);
    primary.on('keyboard-interactive', (_n, _i, _l, _ps, finish) => {
      finish(authCfg.password ? [authCfg.password] : []);
    });
    primary.once('ready', () => {
      // 2) 터널
      primary.forwardOut('127.0.0.1', 0, jumpHost, jumpPort, (err, stream) => {
        if (err) return reject(err);
        const jumpUser = session.jumpTargetUser || session.username;
        const jumpCfg = { sock: stream, username: jumpUser, tryKeyboard: true, readyTimeout: 15000, algorithms: FAST_ALGORITHMS, compress: false };
        if (session.jumpAuth && session.jumpAuth.type === 'password' && session.jumpAuth.password) {
          jumpCfg.password = session.jumpAuth.password;
        } else if (session.jumpAuth && session.jumpAuth.type === 'key' && session.jumpAuth.keyPath) {
          try { jumpCfg.privateKey = fs.readFileSync(session.jumpAuth.keyPath); } catch (_e) {}
        } else {
          if (authCfg.password)    jumpCfg.password    = authCfg.password;
          if (authCfg.privateKey)  jumpCfg.privateKey  = authCfg.privateKey;
        }
        // 3) jump 타겟 연결
        const target = new Client();
        sftpConn = target;
        target.on('error', reject);
        target.on('keyboard-interactive', (_n, _i, _l, _ps, finish) => {
          finish(jumpCfg.password ? [jumpCfg.password] : []);
        });
        target.once('ready', () => openSftpOn(target).then(resolve).catch(reject));
        target.connect(jumpCfg);
      });
    });
    primary.connect({ host: session.host, port: session.port || 22, ...authCfg });
  });
}

// 원격→원격용 목적지 SSH 연결 + SFTP 세션 (캐시)
function getOrCreateDstSftp(dstSession) {
  // 캐시 키: host:port:username (jump 포함)
  const key = `${dstSession.host}:${dstSession.port || 22}:${dstSession.username}` +
              (dstSession.jumpTargetHost ? `:jump:${dstSession.jumpTargetHost}:${dstSession.jumpTargetPort || 22}:${dstSession.jumpTargetUser || dstSession.username}` : '');
  const cached = dstConnections.get(key);
  if (cached && cached.sftp) return Promise.resolve(cached.sftp);

  return new Promise((resolve, reject) => {
    const authCfg = buildAuth(dstSession);

    const openDstSftp = (client) => {
      client.sftp((err, s) => {
        if (err) { dstConnections.delete(key); return reject(err); }
        const entry = { client, sftp: s };
        dstConnections.set(key, entry);
        s.on('close', () => { dstConnections.delete(key); });
        s.on('end',   () => { dstConnections.delete(key); });
        resolve(s);
      });
    };

    const jumpHost = dstSession.jumpTargetHost && dstSession.jumpTargetHost.trim();
    if (jumpHost) {
      // 점프 호스트를 통한 연결 — 기존 src sftpConn 을 사용할 수 없으므로 새 primary 연결
      const primary = new Client();
      primary.on('error', reject);
      primary.on('keyboard-interactive', (_n, _i, _l, _ps, finish) => {
        finish(authCfg.password ? [authCfg.password] : []);
      });
      primary.once('ready', () => {
        const jHost = jumpHost;
        const jPort = dstSession.jumpTargetPort || 22;
        primary.forwardOut('127.0.0.1', 0, jHost, jPort, (err, stream) => {
          if (err) return reject(err);
          const jumpUser = dstSession.jumpTargetUser || dstSession.username;
          const jumpCfg = { sock: stream, username: jumpUser, tryKeyboard: true, readyTimeout: 15000 };
          if (dstSession.jumpAuth && dstSession.jumpAuth.type === 'password' && dstSession.jumpAuth.password) {
            jumpCfg.password = dstSession.jumpAuth.password;
          } else if (dstSession.jumpAuth && dstSession.jumpAuth.type === 'key' && dstSession.jumpAuth.keyPath) {
            try { jumpCfg.privateKey = fs.readFileSync(dstSession.jumpAuth.keyPath); } catch (_e) {}
          } else {
            if (authCfg.password)   jumpCfg.password   = authCfg.password;
            if (authCfg.privateKey) jumpCfg.privateKey = authCfg.privateKey;
          }
          const target = new Client();
          target.on('error', reject);
          target.on('keyboard-interactive', (_n, _i, _l, _ps, finish) => {
            finish(jumpCfg.password ? [jumpCfg.password] : []);
          });
          target.once('ready', () => openDstSftp(target));
          target.connect(jumpCfg);
        });
      });
      primary.connect({ host: dstSession.host, port: dstSession.port || 22, ...authCfg });
    } else {
      const client = new Client();
      client.on('error', (err) => { dstConnections.delete(key); reject(err); });
      client.on('keyboard-interactive', (_n, _i, _l, _ps, finish) => {
        finish(authCfg.password ? [authCfg.password] : []);
      });
      client.once('ready', () => openDstSftp(client));
      client.connect({ host: dstSession.host, port: dstSession.port || 22, ...authCfg });
    }
  });
}

function processTransfer(msg) {
  const { id, action, srcPath, dstPath } = msg;
  if (!sftp) {
    parentPort.postMessage({ type: 'error', id, error: 'SFTP 세션 없음' });
    return;
  }

  // 원격 → 원격 스트림 파이프 (워커 내부에서 처리 — 메인 루프 보호)
  if (action === 'remote-remote') {
    const totalSize = msg.totalSize || 0;
    getOrCreateDstSftp(msg.dstSession).then((dstSftp) => {
      // 원격→원격 스트림 — 읽기/쓰기 버퍼와 동시 요청 수를 키워 파이프 처리량 향상.
      const readStream = sftp.createReadStream(srcPath, { highWaterMark: 1024 * 1024, concurrency: 64, chunkSize: 65536 });
      const writeStream = dstSftp.createWriteStream(dstPath, { highWaterMark: 1024 * 1024, concurrency: 64, chunkSize: 65536 });
      let transferred = 0;
      let lastEmit = 0;
      readStream.on('data', (chunk) => {
        transferred += chunk.length;
        const now = Date.now();
        if (now - lastEmit < 150 && transferred < totalSize) return;
        lastEmit = now;
        parentPort.postMessage({ type: 'progress', id, transferred, total: totalSize });
      });
      readStream.on('error', (err) => {
        parentPort.postMessage({ type: 'error', id, error: String(err) });
      });
      writeStream.on('error', (err) => {
        parentPort.postMessage({ type: 'error', id, error: String(err) });
      });
      writeStream.on('close', () => {
        parentPort.postMessage({ type: 'done', id });
      });
      readStream.pipe(writeStream);
    }).catch((err) => {
      parentPort.postMessage({ type: 'error', id, error: String(err) });
    });
    return;
  }

  let lastEmit = 0;
  const step = (transferred, _chunk, total) => {
    const now = Date.now();
    if (now - lastEmit < 150 && transferred < total) return;
    lastEmit = now;
    parentPort.postMessage({ type: 'progress', id, transferred, total });
  };
  // SFTP 파이프라인 윈도우 — 동시 요청 수 × 청크 크기 = in-flight 데이터(BDP 충족용).
  //   기존 64×64KB=4MB → 128×64KB=8MB 로 상향. 고대역/고지연 링크에서 처리량 향상,
  //   chunkSize 64KB 는 기존 출시값이라 호환성 검증됨.
  const opts = { concurrency: 128, chunkSize: 65536, step };
  const cb = (err) => {
    if (err) parentPort.postMessage({ type: 'error', id, error: String(err) });
    else     parentPort.postMessage({ type: 'done',  id });
  };
  if (action === 'download') sftp.fastGet(srcPath, dstPath, opts, cb);
  else                       sftp.fastPut(srcPath, dstPath, opts, cb);
}

// 초기화
const connectFn = (session.jumpTargetHost && session.jumpTargetHost.trim()) ? connectViaJump : connectDirect;
connectFn().then(() => {
  parentPort.postMessage({ type: 'ready' });
  parentPort.on('message', (msg) => {
    if (msg.type === 'transfer') {
      processTransfer(msg);
    } else if (msg.type === 'sftp-op') {
      // stat/readdir/mkdir 등 SFTP 메타데이터 연산 — worker 스레드에서 처리해 main event loop 보호
      const { id, op, path, args, otherSession } = msg;
      const getTarget = otherSession ? getOrCreateDstSftp(otherSession) : Promise.resolve(sftp);
      getTarget.then(s => {
        if (!s) { parentPort.postMessage({ type: 'sftp-op-error', id, error: 'SFTP 없음' }); return; }
        const ok  = (r) => parentPort.postMessage({ type: 'sftp-op-result', id, result: r !== undefined ? r : null });
        const fail = (e) => parentPort.postMessage({ type: 'sftp-op-error',  id, error: String(e) });
        switch (op) {
          case 'stat':    s.stat(path,   (e, r) => e ? fail(e) : ok(r)); break;
          case 'lstat':   s.lstat(path,  (e, r) => e ? fail(e) : ok(r)); break;
          case 'readdir': s.readdir(path,(e, r) => e ? fail(e) : ok(r)); break;
          case 'mkdir':   s.mkdir(path,  (e)    => e ? fail(e) : ok(null)); break;
          case 'utimes':  s.utimes(path, args.atime, args.mtime, (e) => e ? fail(e) : ok(null)); break;
          case 'chmod':   s.chmod(path,  args.mode, (e) => e ? fail(e) : ok(null)); break;
          case 'unlink':  s.unlink(path, (e) => e ? fail(e) : ok(null)); break;
          case 'rmdir':   s.rmdir(path,  (e) => e ? fail(e) : ok(null)); break;
          case 'rename':  s.rename(path, args.newPath, (e) => e ? fail(e) : ok(null)); break;
          case 'tree-size': {
            (async function calcSize(s2, p) {
              const st = await new Promise((res, rej) => s2.stat(p, (e, r) => e ? rej(e) : res(r)));
              const isDir = typeof st.isDirectory === 'function' ? st.isDirectory()
                          : !!(st.mode && (st.mode & 0o170000) === 0o040000);
              if (!isDir) return st.size || 0;
              const list = await new Promise((res, rej) => s2.readdir(p, (e, r) => e ? rej(e) : res(r)));
              const sizes = await Promise.all(list.map(e => {
                const cp = p.endsWith('/') ? p + e.filename : p + '/' + e.filename;
                return calcSize(s2, cp).catch(() => 0);
              }));
              return sizes.reduce((a, b) => a + b, 0);
            })(s, path).then(size => ok(size)).catch(fail);
            break;
          }
          case 'tree-list': {
            const entries = [];
            (async function walk(s2, dirPath, relBase) {
              const list = await new Promise((res, rej) => s2.readdir(dirPath, (e, r) => e ? rej(e) : res(r)));
              for (const e of list) {
                const rel = relBase ? relBase + '/' + e.filename : e.filename;
                const isDir = e.attrs && typeof e.attrs.isDirectory === 'function' ? e.attrs.isDirectory()
                            : !!(e.attrs && e.attrs.mode && (e.attrs.mode & 0o170000) === 0o040000);
                entries.push({ rel, isDir });
                if (isDir) {
                  const cp = dirPath.endsWith('/') ? dirPath + e.filename : dirPath + '/' + e.filename;
                  await walk(s2, cp, rel).catch(() => {});
                }
              }
            })(s, path, '').then(() => ok(entries)).catch(fail);
            break;
          }
          default: fail('Unknown op: ' + op);
        }
      }).catch(e => parentPort.postMessage({ type: 'sftp-op-error', id, error: String(e) }));
    } else if (msg.type === 'shutdown') {
      // 목적지 연결 모두 정리
      for (const entry of dstConnections.values()) {
        try { entry.sftp && entry.sftp.end(); } catch (_e) {}
        try { entry.client && entry.client.end(); } catch (_e) {}
      }
      dstConnections.clear();
      try { sftp && sftp.end(); } catch (_e) {}
      try { sftpConn && sftpConn.end(); } catch (_e) {}
      process.exit(0);
    }
  });
}).catch((err) => {
  parentPort.postMessage({ type: 'connect-error', error: String(err) });
});
