// electron/telnetBridge.ts
// 평문 TELNET / raw TCP 터미널 브리지.
// HIWARE 등 접근통제(PAM) 솔루션은 게이트웨이가 실제 서버로 SSH 를 수행하고,
// 클라이언트 터미널에는 127.0.0.1:<port> 로 평문(TELNET) 스트림을 내준다. PePe 가
// 그 포트에 SSH 핸드셰이크를 시도하면 실패하므로, 텔넷 클라이언트로 접속해야 한다.
//
// SSH 브리지와 동일한 message 형태({type:'data'|'connected'|'closed'|'error', panelId, ...})를
// emit 해서, main 이 기존 ssh:* 렌더러 채널로 그대로 흘려보낸다(렌더러 변경 최소화).
import net from 'net';
import { EventEmitter } from 'events';
import iconv from 'iconv-lite';

// Telnet 제어 바이트
const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240;
const OPT_ECHO = 1, OPT_SGA = 3, OPT_TTYPE = 24, OPT_NAWS = 31;

type TelnetMsg =
  | { type: 'data'; panelId: string; data: string }
  | { type: 'connected'; panelId: string }
  | { type: 'closed'; panelId: string }
  | { type: 'error'; panelId: string; error: string };

interface Conn {
  sock: net.Socket;
  encoding: string;
  cols: number;
  rows: number;
  pending: Buffer;          // IAC 시퀀스가 청크 경계에 걸칠 때 보관
  willNaws: boolean;        // NAWS(window size) 협상 합의됨
  connected: boolean;
}

class TelnetBridge extends EventEmitter {
  private conns = new Map<string, Conn>();

  onMessage(cb: (msg: TelnetMsg) => void) { this.on('message', cb); }

  isConnected(panelId: string): boolean {
    const c = this.conns.get(panelId);
    return !!(c && c.connected && !c.sock.destroyed);
  }

  connect(panelId: string, host: string, port: number, cols?: number, rows?: number, encoding?: string) {
    // 기존 연결 정리
    this.disconnect(panelId);
    const sock = new net.Socket();
    const conn: Conn = {
      sock, encoding: (encoding || 'utf-8'),
      cols: cols || 80, rows: rows || 24,
      pending: Buffer.alloc(0), willNaws: false, connected: false,
    };
    this.conns.set(panelId, conn);

    sock.setNoDelay(true);
    sock.setTimeout(15000); // 연결 단계 타임아웃 (연결 후 0 으로 해제)

    sock.on('connect', () => {
      sock.setTimeout(0);
      conn.connected = true;
      this.emit('message', { type: 'connected', panelId });
      // 클라이언트 측 초기 협상 — 터미널 타입/창 크기 알릴 의사 표시
      this._send(conn, Buffer.from([
        IAC, WILL, OPT_TTYPE,
        IAC, WILL, OPT_NAWS,
        IAC, DO, OPT_SGA,
      ]));
    });
    sock.on('data', (buf: Buffer) => this._onData(panelId, conn, buf));
    sock.on('error', (err: any) => {
      this.emit('message', { type: 'error', panelId, error: String(err?.message || err) });
    });
    sock.on('timeout', () => {
      if (!conn.connected) {
        this.emit('message', { type: 'error', panelId, error: '연결 시간 초과 (telnet)' });
        try { sock.destroy(); } catch {}
      }
    });
    sock.on('close', () => {
      this.conns.delete(panelId);
      this.emit('message', { type: 'closed', panelId });
    });

    try {
      sock.connect(port, host);
    } catch (e: any) {
      this.emit('message', { type: 'error', panelId, error: String(e?.message || e) });
    }
  }

  // 수신 바이트에서 IAC 시퀀스를 처리(협상 응답)하고, 순수 데이터만 디코딩해 emit
  private _onData(panelId: string, conn: Conn, incoming: Buffer) {
    let data = conn.pending.length ? Buffer.concat([conn.pending, incoming]) : incoming;
    conn.pending = Buffer.alloc(0);
    const out: number[] = [];
    let i = 0;
    while (i < data.length) {
      const b = data[i];
      if (b !== IAC) { out.push(b); i++; continue; }
      // IAC 시퀀스
      if (i + 1 >= data.length) { conn.pending = data.slice(i); break; }
      const cmd = data[i + 1];
      if (cmd === IAC) { out.push(IAC); i += 2; continue; } // 이스케이프된 0xFF
      if (cmd === DO || cmd === DONT || cmd === WILL || cmd === WONT) {
        if (i + 2 >= data.length) { conn.pending = data.slice(i); break; }
        const opt = data[i + 2];
        this._negotiate(conn, cmd, opt);
        i += 3; continue;
      }
      if (cmd === SB) {
        // 서브협상 — IAC SE 까지 수집
        let j = i + 2;
        const sub: number[] = [];
        let found = false;
        while (j < data.length) {
          if (data[j] === IAC && j + 1 < data.length && data[j + 1] === SE) { found = true; break; }
          if (data[j] === IAC && j + 1 >= data.length) break; // 경계 — 보류
          sub.push(data[j]); j++;
        }
        if (!found) { conn.pending = data.slice(i); break; }
        this._subNegotiate(conn, sub);
        i = j + 2; continue;
      }
      // 그 외 단일 IAC 명령(GA 등) — 무시
      i += 2;
    }
    if (out.length) {
      const buf = Buffer.from(out);
      let str: string;
      const enc = (conn.encoding || 'utf-8').toLowerCase();
      try { str = (enc === 'utf-8' || enc === 'utf8') ? buf.toString('utf8') : iconv.decode(buf, enc); }
      catch { str = buf.toString('utf8'); }
      this.emit('message', { type: 'data', panelId, data: str });
    }
  }

  private _negotiate(conn: Conn, cmd: number, opt: number) {
    // 우리는 클라이언트. 안전한 옵션만 수락, 나머지는 거절.
    if (cmd === DO) {
      if (opt === OPT_TTYPE || opt === OPT_NAWS || opt === OPT_SGA) {
        this._send(conn, Buffer.from([IAC, WILL, opt]));
        if (opt === OPT_NAWS) { conn.willNaws = true; this._sendNaws(conn); }
      } else {
        this._send(conn, Buffer.from([IAC, WONT, opt]));
      }
    } else if (cmd === DONT) {
      this._send(conn, Buffer.from([IAC, WONT, opt]));
    } else if (cmd === WILL) {
      // 서버가 ECHO/SGA 를 하겠다면 수락(서버 에코) — 로컬 에코 안 함
      if (opt === OPT_ECHO || opt === OPT_SGA) this._send(conn, Buffer.from([IAC, DO, opt]));
      else this._send(conn, Buffer.from([IAC, DONT, opt]));
    } else if (cmd === WONT) {
      this._send(conn, Buffer.from([IAC, DONT, opt]));
    }
  }

  private _subNegotiate(conn: Conn, sub: number[]) {
    if (sub.length === 0) return;
    const opt = sub[0];
    if (opt === OPT_TTYPE && sub[1] === 1 /* SEND */) {
      // IAC SB TTYPE IS "xterm-256color" IAC SE
      const name = Buffer.from('xterm-256color', 'ascii');
      this._send(conn, Buffer.concat([Buffer.from([IAC, SB, OPT_TTYPE, 0 /* IS */]), name, Buffer.from([IAC, SE])]));
    }
  }

  private _sendNaws(conn: Conn) {
    if (!conn.willNaws) return;
    const w = conn.cols & 0xffff, h = conn.rows & 0xffff;
    // 값 안의 255(IAC) 는 이스케이프 필요
    const esc = (n: number) => n === 255 ? [255, 255] : [n];
    const payload = [...esc(w >> 8), ...esc(w & 0xff), ...esc(h >> 8), ...esc(h & 0xff)];
    this._send(conn, Buffer.from([IAC, SB, OPT_NAWS, ...payload, IAC, SE]));
  }

  private _send(conn: Conn, buf: Buffer) {
    try { if (!conn.sock.destroyed) conn.sock.write(buf); } catch {}
  }

  input(panelId: string, data?: string, b64?: string) {
    const conn = this.conns.get(panelId);
    if (!conn || conn.sock.destroyed) return;
    let buf: Buffer;
    if (typeof b64 === 'string') buf = Buffer.from(b64, 'base64');
    else if (typeof data === 'string') {
      const enc = (conn.encoding || 'utf-8').toLowerCase();
      buf = (enc === 'utf-8' || enc === 'utf8') ? Buffer.from(data, 'utf8') : iconv.encode(data, enc);
    } else return;
    // 사용자 입력 안의 0xFF(IAC) 는 0xFF 0xFF 로 이스케이프
    if (buf.includes(IAC)) {
      const parts: number[] = [];
      for (const b of buf) { parts.push(b); if (b === IAC) parts.push(IAC); }
      buf = Buffer.from(parts);
    }
    this._send(conn, buf);
  }

  resize(panelId: string, cols: number, rows: number) {
    const conn = this.conns.get(panelId);
    if (!conn) return;
    conn.cols = cols; conn.rows = rows;
    this._sendNaws(conn);
  }

  setEncoding(panelId: string, encoding: string) {
    const conn = this.conns.get(panelId);
    if (conn) conn.encoding = encoding;
    return true;
  }

  disconnect(panelId: string) {
    const conn = this.conns.get(panelId);
    if (conn) {
      try { conn.sock.destroy(); } catch {}
      this.conns.delete(panelId);
    }
  }
}

let _bridge: TelnetBridge | null = null;
export function getTelnetBridge(): TelnetBridge {
  if (!_bridge) _bridge = new TelnetBridge();
  return _bridge;
}
