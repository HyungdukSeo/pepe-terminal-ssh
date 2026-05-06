// electron/x11Server.ts
// 임베디드 X 서버 — 외부 X 서버 설치 없이 X11 forwarding 동작.
// Phase 2: 핵심 opcode (CreateWindow, MapWindow, CreateGC, drawing ops) 처리 + 렌더 이벤트 emit.
// 렌더는 별도 BrowserWindow 의 canvas 가 'x-event' IPC 를 받아 처리.
import net from 'net';
import { EventEmitter } from 'events';

const X_PROTOCOL_MAJOR = 11;
const X_PROTOCOL_MINOR = 0;
const SHAPE_OPCODE = 128; // SHAPE 확장 major opcode

function pad4(n: number): number { return (4 - (n % 4)) % 4; }

interface XWindow {
  id: number;
  parent: number;
  x: number; y: number;
  width: number; height: number;
  borderWidth: number;
  depth: number;
  bgPixel?: number;
  borderPixel?: number;
  mapped: boolean;
}

interface XGC {
  id: number;
  drawable: number;
  fg: number;
  bg: number;
  lineWidth: number;
  font?: number;
}

interface XPixmap {
  id: number;
  width: number;
  height: number;
  depth: number;
}

interface ClientCtx {
  socket: net.Socket;
  buf: Buffer;
  setupDone: boolean;
  le: boolean;
  resourceIdBase: number;
  resourceIdMask: number;
  sequence: number;
  // resources
  windows: Map<number, XWindow>;
  gcs: Map<number, XGC>;
  pixmaps: Map<number, XPixmap>;
  atoms: Map<string, number>;
  atomsRev: Map<number, string>;
  nextAtom: number;
}

export type XRenderEvent =
  | { kind: 'window-create'; win: XWindow }
  | { kind: 'window-map'; id: number }
  | { kind: 'window-unmap'; id: number }
  | { kind: 'window-destroy'; id: number }
  | { kind: 'window-configure'; id: number; x?: number; y?: number; w?: number; h?: number }
  | { kind: 'clear-area'; win: number; x: number; y: number; w: number; h: number }
  | { kind: 'fill-rect'; drawable: number; gc: number; rects: { x: number; y: number; w: number; h: number }[]; fg: number }
  | { kind: 'fill-arc'; drawable: number; gc: number; x: number; y: number; w: number; h: number; angle1: number; angle2: number; fg: number }
  | { kind: 'poly-line'; drawable: number; gc: number; points: { x: number; y: number }[]; fg: number; relative: boolean }
  | { kind: 'image-text'; drawable: number; gc: number; x: number; y: number; text: string; fg: number; bg?: number };

export class X11Server extends EventEmitter {
  private server: net.Server | null = null;
  private port: number = 6000;
  private displayNum: number = 0;
  private clients: Set<ClientCtx> = new Set();
  private nextResourceBase: number = 0x00400000;
  // 가장 최근 마우스 위치 — QueryPointer 폴링(xeyes) 응답에 사용
  private _lastPointerX: number = 0;
  private _lastPointerY: number = 0;
  getLastPointer(): { x: number; y: number } { return { x: this._lastPointerX, y: this._lastPointerY }; }

  // 외부에서 마우스 이벤트 주입 (display BrowserWindow 의 canvas 가 호출)
  injectMotion(wid: number, x: number, y: number): void {
    this._lastPointerX = x;
    this._lastPointerY = y;
    for (const ctx of this.clients) {
      if (!ctx.windows.has(wid)) continue;
      const buf = Buffer.alloc(32);
      buf[0] = 6; // MotionNotify
      buf[1] = 0;
      this._writeU16(buf, 2, ctx.sequence & 0xFFFF, ctx.le);
      this._writeU32(buf, 4, (Date.now() >>> 0), ctx.le); // time
      this._writeU32(buf, 8, 0x26, ctx.le); // root
      this._writeU32(buf, 12, wid, ctx.le); // event
      this._writeU32(buf, 16, 0, ctx.le); // child = None
      this._writeU16(buf, 20, x, ctx.le); // root_x
      this._writeU16(buf, 22, y, ctx.le); // root_y
      this._writeU16(buf, 24, x, ctx.le); // event_x
      this._writeU16(buf, 26, y, ctx.le); // event_y
      this._writeU16(buf, 28, 0, ctx.le); // state
      buf[30] = 0; // same_screen
      try { ctx.socket.write(buf); } catch {}
    }
  }

  injectButton(wid: number, x: number, y: number, button: number, press: boolean): void {
    this._lastPointerX = x;
    this._lastPointerY = y;
    for (const ctx of this.clients) {
      if (!ctx.windows.has(wid)) continue;
      const buf = Buffer.alloc(32);
      buf[0] = press ? 4 : 5; // ButtonPress / ButtonRelease
      buf[1] = button;
      this._writeU16(buf, 2, ctx.sequence & 0xFFFF, ctx.le);
      this._writeU32(buf, 4, (Date.now() >>> 0), ctx.le);
      this._writeU32(buf, 8, 0x26, ctx.le);
      this._writeU32(buf, 12, wid, ctx.le);
      this._writeU32(buf, 16, 0, ctx.le);
      this._writeU16(buf, 20, x, ctx.le);
      this._writeU16(buf, 22, y, ctx.le);
      this._writeU16(buf, 24, x, ctx.le);
      this._writeU16(buf, 26, y, ctx.le);
      this._writeU16(buf, 28, 0, ctx.le);
      buf[30] = 1;
      try { ctx.socket.write(buf); } catch {}
    }
  }

  start(displayNum = 0): Promise<void> {
    this.displayNum = displayNum;
    this.port = 6000 + displayNum;
    return new Promise((resolve, reject) => {
      const srv = net.createServer((sock) => this._onConnection(sock));
      srv.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          this.emit('log', `port ${this.port} already in use — 외부 X 서버 사용 중`);
        }
        reject(err);
      });
      srv.listen(this.port, '127.0.0.1', () => {
        this.emit('log', `X server listening on localhost:${this.port} (DISPLAY=:${this.displayNum})`);
        resolve();
      });
      this.server = srv;
    });
  }

  stop(): void {
    for (const c of this.clients) { try { c.socket.destroy(); } catch {} }
    this.clients.clear();
    if (this.server) { try { this.server.close(); } catch {} this.server = null; }
  }

  private _onConnection(socket: net.Socket): void {
    const ctx: ClientCtx = {
      socket,
      buf: Buffer.alloc(0),
      setupDone: false,
      le: true,
      resourceIdBase: this.nextResourceBase,
      resourceIdMask: 0x001FFFFF,
      sequence: 0,
      windows: new Map(),
      gcs: new Map(),
      pixmaps: new Map(),
      atoms: new Map(),
      atomsRev: new Map(),
      nextAtom: 1,
    };
    this.nextResourceBase += 0x00100000;
    // 기본 atom 등록
    const builtinAtoms = ['PRIMARY','SECONDARY','ARC','ATOM','BITMAP','CARDINAL','COLORMAP','CURSOR','CUT_BUFFER0','CUT_BUFFER1','CUT_BUFFER2','CUT_BUFFER3','CUT_BUFFER4','CUT_BUFFER5','CUT_BUFFER6','CUT_BUFFER7','DRAWABLE','FONT','INTEGER','PIXMAP','POINT','RECTANGLE','RESOURCE_MANAGER','RGB_COLOR_MAP','RGB_BEST_MAP','RGB_BLUE_MAP','RGB_DEFAULT_MAP','RGB_GRAY_MAP','RGB_GREEN_MAP','RGB_RED_MAP','STRING','VISUALID','WINDOW','WM_COMMAND','WM_HINTS','WM_CLIENT_MACHINE','WM_ICON_NAME','WM_ICON_SIZE','WM_NAME','WM_NORMAL_HINTS','WM_SIZE_HINTS','WM_ZOOM_HINTS','MIN_SPACE','NORM_SPACE','MAX_SPACE','END_SPACE','SUPERSCRIPT_X','SUPERSCRIPT_Y','SUBSCRIPT_X','SUBSCRIPT_Y','UNDERLINE_POSITION','UNDERLINE_THICKNESS','STRIKEOUT_ASCENT','STRIKEOUT_DESCENT','ITALIC_ANGLE','X_HEIGHT','QUAD_WIDTH','WEIGHT','POINT_SIZE','RESOLUTION','COPYRIGHT','NOTICE','FONT_NAME','FAMILY_NAME','FULL_NAME','CAP_HEIGHT','WM_CLASS','WM_TRANSIENT_FOR'];
    builtinAtoms.forEach((name, i) => {
      ctx.atoms.set(name, i + 1);
      ctx.atomsRev.set(i + 1, name);
    });
    ctx.nextAtom = builtinAtoms.length + 1;
    this.clients.add(ctx);
    this.emit('log', `client connected from ${socket.remoteAddress}:${socket.remotePort}`);

    socket.on('data', (chunk: Buffer) => {
      ctx.buf = Buffer.concat([ctx.buf, chunk]);
      try { this._processBuffer(ctx); }
      catch (err: any) {
        this.emit('log', `process error: ${err.message}\n${err.stack?.split('\n').slice(0, 3).join(' | ')}`);
      }
    });
    socket.on('close', () => {
      // 모든 윈도우 destroy 이벤트 발생
      for (const winId of ctx.windows.keys()) {
        this.emit('render', { kind: 'window-destroy', id: winId } as XRenderEvent);
      }
      this.clients.delete(ctx);
      this.emit('log', `client disconnected`);
    });
    socket.on('error', (err) => {
      this.emit('log', `client error: ${err.message}`);
    });
  }

  private _processBuffer(ctx: ClientCtx): void {
    if (!ctx.setupDone) {
      if (ctx.buf.length < 12) return;
      const bo = ctx.buf[0];
      ctx.le = (bo === 0x6c);
      const n = ctx.le ? ctx.buf.readUInt16LE(6) : ctx.buf.readUInt16BE(6);
      const d = ctx.le ? ctx.buf.readUInt16LE(8) : ctx.buf.readUInt16BE(8);
      const totalSetupLen = 12 + n + pad4(n) + d + pad4(d);
      if (ctx.buf.length < totalSetupLen) return;
      ctx.buf = ctx.buf.subarray(totalSetupLen);
      ctx.setupDone = true;
      this._sendSetupResponse(ctx);
    }
    while (ctx.buf.length >= 4) {
      const lenUnits = ctx.le ? ctx.buf.readUInt16LE(2) : ctx.buf.readUInt16BE(2);
      const reqLen = lenUnits * 4;
      if (reqLen === 0 || reqLen > ctx.buf.length) return;
      const opcode = ctx.buf[0];
      const data = ctx.buf.subarray(0, reqLen);
      ctx.buf = ctx.buf.subarray(reqLen);
      this._handleRequest(ctx, opcode, data);
    }
  }

  private _u16(buf: Buffer, off: number, le: boolean): number { return le ? buf.readUInt16LE(off) : buf.readUInt16BE(off); }
  private _u32(buf: Buffer, off: number, le: boolean): number { return le ? buf.readUInt32LE(off) : buf.readUInt32BE(off); }
  private _i16(buf: Buffer, off: number, le: boolean): number { return le ? buf.readInt16LE(off) : buf.readInt16BE(off); }

  private _handleRequest(ctx: ClientCtx, opcode: number, data: Buffer): void {
    ctx.sequence++;
    const le = ctx.le;
    const u16 = (off: number) => this._u16(data, off, le);
    const u32 = (off: number) => this._u32(data, off, le);
    const i16 = (off: number) => this._i16(data, off, le);

    // 디버그: 모든 요청 로깅 (오류 원인 추적)
    this.emit('log', `req opcode=${opcode} len=${data.length} seq=${ctx.sequence}`);

    switch (opcode) {
      case 1: { // CreateWindow
        const depth = data[1];
        const wid = u32(4);
        const parent = u32(8);
        const x = i16(12); const y = i16(14);
        const w = u16(16); const h = u16(18);
        const borderWidth = u16(20);
        // class @ 22, visual @ 24, valueMask @ 28
        const valueMask = u32(28);
        let bgPixel: number | undefined;
        let borderPixel: number | undefined;
        let bgPixmap: number | undefined;
        // CW value list: 15 가능 비트 (0..14). 각 4byte. 순서대로 모두 파싱.
        let off = 32;
        for (let bit = 0; bit < 15; bit++) {
          if (!(valueMask & (1 << bit))) continue;
          const v = u32(off);
          off += 4;
          if (bit === 0) bgPixmap = v;
          else if (bit === 1) bgPixel = v;
          else if (bit === 3) borderPixel = v;
        }
        // bgPixel 미지정인데 bgPixmap === 1 (ParentRelative) 또는 0 (None) 인 경우, parent 의 bgPixel 상속
        if (bgPixel === undefined && bgPixmap !== undefined && bgPixmap <= 1) {
          const p = ctx.windows.get(parent);
          if (p?.bgPixel !== undefined) bgPixel = p.bgPixel;
        }
        this.emit('log', `CreateWindow id=${wid.toString(16)} parent=${parent.toString(16)} ${w}x${h} bw=${borderWidth} mask=0x${valueMask.toString(16)} bgPixel=${bgPixel?.toString(16) ?? 'undef'} borderPixel=${borderPixel?.toString(16) ?? 'undef'}`);
        const win: XWindow = { id: wid, parent, x, y, width: w, height: h, borderWidth, depth, bgPixel, borderPixel, mapped: false };
        ctx.windows.set(wid, win);
        this.emit('render', { kind: 'window-create', win } as XRenderEvent);
        break;
      }
      case 2: { // ChangeWindowAttributes — 속성 변경 (특히 bg pixel)
        const wid = u32(4);
        const valueMask = u32(8);
        const win = ctx.windows.get(wid);
        let off = 12;
        for (let bit = 0; bit < 15; bit++) {
          if (!(valueMask & (1 << bit))) continue;
          const v = u32(off);
          off += 4;
          if (bit === 1 && win) {
            win.bgPixel = v;
            this.emit('render', { kind: 'window-bg', id: wid, bgPixel: v } as any);
            this.emit('log', `ChangeWindowAttributes id=${wid.toString(16)} bgPixel=${v.toString(16)}`);
          }
        }
        break;
      }
      case 4: { // DestroyWindow
        const wid = u32(4);
        ctx.windows.delete(wid);
        this.emit('render', { kind: 'window-destroy', id: wid } as XRenderEvent);
        break;
      }
      case 8: { // MapWindow
        const wid = u32(4);
        const win = ctx.windows.get(wid);
        if (win) {
          win.mapped = true;
          this.emit('render', { kind: 'window-map', id: wid } as XRenderEvent);
          // MapNotify + ConfigureNotify + Expose 이벤트 전송 — 클라이언트가 윈도우에 그릴 시점 인지
          this._sendMapNotify(ctx, wid);
          this._sendConfigureNotify(ctx, wid, win.x, win.y, win.width, win.height);
          this._sendExpose(ctx, wid, 0, 0, win.width, win.height);
        }
        break;
      }
      case 10: { // UnmapWindow
        const wid = u32(4);
        const win = ctx.windows.get(wid);
        if (win) { win.mapped = false; this.emit('render', { kind: 'window-unmap', id: wid } as XRenderEvent); }
        break;
      }
      case 12: { // ConfigureWindow
        const wid = u32(4);
        const valueMask = u16(8);
        let off = 12;
        const get = () => { const v = i16(off); off += 4; return v; }; // values are 4 bytes each (int16 with pad)
        let nx, ny, nw, nh;
        if (valueMask & 0x01) nx = get();
        if (valueMask & 0x02) ny = get();
        if (valueMask & 0x04) nw = get() & 0xFFFF;
        if (valueMask & 0x08) nh = get() & 0xFFFF;
        const w = ctx.windows.get(wid);
        if (w) {
          if (nx !== undefined) w.x = nx;
          if (ny !== undefined) w.y = ny;
          if (nw !== undefined) w.width = nw;
          if (nh !== undefined) w.height = nh;
          this.emit('render', { kind: 'window-configure', id: wid, x: nx, y: ny, w: nw, h: nh } as XRenderEvent);
        }
        break;
      }
      case 14: { // GetGeometry — reply 필요
        const did = u32(4);
        const w = ctx.windows.get(did);
        const reply = Buffer.alloc(32);
        reply[0] = 1; // reply
        reply[1] = 24; // depth
        if (le) reply.writeUInt16LE(ctx.sequence & 0xFFFF, 2); else reply.writeUInt16BE(ctx.sequence & 0xFFFF, 2);
        if (le) reply.writeUInt32LE(0, 4); else reply.writeUInt32BE(0, 4); // length 0
        if (le) reply.writeUInt32LE(0x26, 8); else reply.writeUInt32BE(0x26, 8); // root
        if (le) reply.writeInt16LE(w?.x || 0, 12); else reply.writeInt16BE(w?.x || 0, 12);
        if (le) reply.writeInt16LE(w?.y || 0, 14); else reply.writeInt16BE(w?.y || 0, 14);
        if (le) reply.writeUInt16LE(w?.width || 1, 16); else reply.writeUInt16BE(w?.width || 1, 16);
        if (le) reply.writeUInt16LE(w?.height || 1, 18); else reply.writeUInt16BE(w?.height || 1, 18);
        if (le) reply.writeUInt16LE(w?.borderWidth || 0, 20); else reply.writeUInt16BE(w?.borderWidth || 0, 20);
        ctx.socket.write(reply);
        break;
      }
      case 16: { // InternAtom
        const onlyIfExists = data[1] !== 0;
        const nameLen = u16(4);
        const name = data.subarray(8, 8 + nameLen).toString('utf8');
        let atom = ctx.atoms.get(name);
        if (!atom && !onlyIfExists) {
          atom = ctx.nextAtom++;
          ctx.atoms.set(name, atom);
          ctx.atomsRev.set(atom, name);
        }
        const reply = Buffer.alloc(32);
        reply[0] = 1;
        if (le) reply.writeUInt16LE(ctx.sequence & 0xFFFF, 2); else reply.writeUInt16BE(ctx.sequence & 0xFFFF, 2);
        if (le) reply.writeUInt32LE(0, 4); else reply.writeUInt32BE(0, 4);
        if (le) reply.writeUInt32LE(atom || 0, 8); else reply.writeUInt32BE(atom || 0, 8);
        ctx.socket.write(reply);
        break;
      }
      case 18: // ChangeProperty (WM_NAME 등) — 무시
      case 19: // DeleteProperty
        break;
      case 20: { // GetProperty — 빈 reply
        const reply = Buffer.alloc(32);
        reply[0] = 1;
        if (le) reply.writeUInt16LE(ctx.sequence & 0xFFFF, 2); else reply.writeUInt16BE(ctx.sequence & 0xFFFF, 2);
        ctx.socket.write(reply);
        break;
      }
      case 23: { // GetSelectionOwner
        const reply = Buffer.alloc(32);
        reply[0] = 1;
        if (le) reply.writeUInt16LE(ctx.sequence & 0xFFFF, 2); else reply.writeUInt16BE(ctx.sequence & 0xFFFF, 2);
        ctx.socket.write(reply);
        break;
      }
      case 38: { // QueryPointer
        const reply = Buffer.alloc(32);
        reply[0] = 1;
        reply[1] = 1; // same_screen=true
        this._writeU16(reply, 2, ctx.sequence & 0xFFFF, le);
        this._writeU32(reply, 4, 0, le); // reply length 0
        this._writeU32(reply, 8, 0x26, le); // root
        this._writeU32(reply, 12, 0, le); // child=None
        // root_x, root_y, win_x, win_y — 가장 최근 마우스 위치
        const px = this._lastPointerX & 0xFFFF;
        const py = this._lastPointerY & 0xFFFF;
        this._writeU16(reply, 16, px, le);
        this._writeU16(reply, 18, py, le);
        this._writeU16(reply, 20, px, le);
        this._writeU16(reply, 22, py, le);
        this._writeU16(reply, 24, 0, le); // mask
        ctx.socket.write(reply);
        break;
      }
      case 53: { // CreatePixmap
        const depth = data[1];
        const pid = u32(4);
        const w = u16(12), h = u16(14);
        ctx.pixmaps.set(pid, { id: pid, width: w, height: h, depth });
        this.emit('render', { kind: 'pixmap-create', id: pid, w, h, depth } as any);
        break;
      }
      case 54: { // FreePixmap
        const pid = u32(4);
        ctx.pixmaps.delete(pid);
        this.emit('render', { kind: 'pixmap-destroy', id: pid } as any);
        break;
      }
      case 55: { // CreateGC
        const gcid = u32(4);
        const drawable = u32(8);
        const valueMask = u32(12);
        let fg = 0x000000, bg = 0xFFFFFF, lineWidth = 0, font = 0;
        const setBits: number[] = [];
        let off = 16;
        for (let bit = 0; bit < 23; bit++) {
          if (!(valueMask & (1 << bit))) continue;
          const v = u32(off);
          off += 4;
          setBits.push(bit);
          if (bit === 2) fg = v;
          else if (bit === 3) bg = v;
          else if (bit === 4) lineWidth = v & 0xFFFF;
          else if (bit === 14) font = v;
        }
        this.emit('log', `CreateGC gc=${gcid.toString(16)} mask=0x${valueMask.toString(16)} bits=[${setBits.join(',')}] fg=${fg.toString(16)} bg=${bg.toString(16)}`);
        ctx.gcs.set(gcid, { id: gcid, drawable, fg, bg, lineWidth, font });
        break;
      }
      case 56: { // ChangeGC
        const gcid = u32(4);
        const valueMask = u32(8);
        const gc = ctx.gcs.get(gcid);
        if (!gc) break;
        let off = 12;
        for (let bit = 0; bit < 23; bit++) {
          if (!(valueMask & (1 << bit))) continue;
          const v = u32(off);
          off += 4;
          if (bit === 2) gc.fg = v;
          else if (bit === 3) gc.bg = v;
          else if (bit === 4) gc.lineWidth = v & 0xFFFF;
          else if (bit === 14) gc.font = v;
        }
        break;
      }
      case 60: { // FreeGC
        ctx.gcs.delete(u32(4));
        break;
      }
      case 61: { // ClearArea
        const wid = u32(4);
        const x = i16(8), y = i16(10), w = u16(12), h = u16(14);
        const win = ctx.windows.get(wid);
        const cw = w === 0 ? (win?.width || 0) : w;
        const ch = h === 0 ? (win?.height || 0) : h;
        this.emit('render', { kind: 'clear-area', win: wid, x, y, w: cw, h: ch } as XRenderEvent);
        break;
      }
      case 65: { // PolyLine
        const drawable = u32(4);
        const gcid = u32(8);
        const coordMode = data[1]; // 0=Origin (absolute), 1=Previous (relative)
        const numPoints = (data.length - 12) / 4;
        const points: { x: number; y: number }[] = [];
        for (let i = 0; i < numPoints; i++) {
          const px = i16(12 + i * 4);
          const py = i16(14 + i * 4);
          points.push({ x: px, y: py });
        }
        const gc = ctx.gcs.get(gcid);
        this.emit('render', { kind: 'poly-line', drawable, gc: gcid, points, fg: gc?.fg || 0, relative: coordMode === 1 } as XRenderEvent);
        break;
      }
      case 64: { // PolyPoint
        const drawable = u32(4);
        const gcid = u32(8);
        const numPoints = (data.length - 12) / 4;
        const rects: { x: number; y: number; w: number; h: number }[] = [];
        for (let i = 0; i < numPoints; i++) {
          rects.push({ x: i16(12 + i * 4), y: i16(14 + i * 4), w: 1, h: 1 });
        }
        const gc = ctx.gcs.get(gcid);
        this.emit('render', { kind: 'fill-rect', drawable, gc: gcid, rects, fg: gc?.fg || 0 } as XRenderEvent);
        break;
      }
      case 66: { // PolySegment — 선분 N 개
        const drawable = u32(4);
        const gcid = u32(8);
        const numSegs = (data.length - 12) / 8;
        const gc = ctx.gcs.get(gcid);
        for (let i = 0; i < numSegs; i++) {
          const off = 12 + i * 8;
          const points = [
            { x: i16(off), y: i16(off + 2) },
            { x: i16(off + 4), y: i16(off + 6) },
          ];
          this.emit('render', { kind: 'poly-line', drawable, gc: gcid, points, fg: gc?.fg || 0, relative: false } as XRenderEvent);
        }
        break;
      }
      case 67: { // PolyRectangle — 사각형 외곽선
        const drawable = u32(4);
        const gcid = u32(8);
        const numRects = (data.length - 12) / 8;
        const gc = ctx.gcs.get(gcid);
        for (let i = 0; i < numRects; i++) {
          const off = 12 + i * 8;
          const rx = i16(off), ry = i16(off + 2);
          const rw = u16(off + 4), rh = u16(off + 6);
          const points = [
            { x: rx, y: ry },
            { x: rx + rw, y: ry },
            { x: rx + rw, y: ry + rh },
            { x: rx, y: ry + rh },
            { x: rx, y: ry },
          ];
          this.emit('render', { kind: 'poly-line', drawable, gc: gcid, points, fg: gc?.fg || 0, relative: false } as XRenderEvent);
        }
        break;
      }
      case 68: { // PolyArc — 외곽선 호
        const drawable = u32(4);
        const gcid = u32(8);
        const numArcs = (data.length - 12) / 12;
        const gc = ctx.gcs.get(gcid);
        for (let i = 0; i < numArcs; i++) {
          const off = 12 + i * 12;
          const x = i16(off), y = i16(off + 2);
          const aw = u16(off + 4), ah = u16(off + 6);
          const a1 = i16(off + 8), a2 = i16(off + 10);
          // 외곽선 호는 fill-arc 와 같은 형식 + filled=false 필드 추가
          this.emit('render', { kind: 'arc', drawable, gc: gcid, x, y, w: aw, h: ah, angle1: a1, angle2: a2, fg: gc?.fg || 0, filled: false } as any);
        }
        break;
      }
      case 69: { // FillPoly
        const drawable = u32(4);
        const gcid = u32(8);
        // shape(1) at offset 12, coordinateMode(1) at 13, then points
        const coordMode = data[13];
        const numPoints = (data.length - 16) / 4;
        const gc = ctx.gcs.get(gcid);
        const points: { x: number; y: number }[] = [];
        for (let i = 0; i < numPoints; i++) {
          points.push({ x: i16(16 + i * 4), y: i16(18 + i * 4) });
        }
        this.emit('render', { kind: 'fill-poly', drawable, gc: gcid, points, fg: gc?.fg || 0, relative: coordMode === 1 } as any);
        break;
      }
      case 70: { // PolyFillRectangle
        const drawable = u32(4);
        const gcid = u32(8);
        const numRects = (data.length - 12) / 8;
        const gcDbg = ctx.gcs.get(gcid);
        this.emit('log', `PolyFillRect drawable=${drawable.toString(16)} gc=${gcid.toString(16)} fg=${gcDbg?.fg.toString(16)} rects=${numRects}`);
        const rects: { x: number; y: number; w: number; h: number }[] = [];
        for (let i = 0; i < numRects; i++) {
          const off = 12 + i * 8;
          rects.push({ x: i16(off), y: i16(off + 2), w: u16(off + 4), h: u16(off + 6) });
        }
        const gc = ctx.gcs.get(gcid);
        this.emit('render', { kind: 'fill-rect', drawable, gc: gcid, rects, fg: gc?.fg || 0 } as XRenderEvent);
        break;
      }
      case 71: { // PolyFillArc — 같은 형식
        const drawable = u32(4);
        const gcid = u32(8);
        const numArcs = (data.length - 12) / 12;
        const gc = ctx.gcs.get(gcid);
        this.emit('log', `PolyFillArc drawable=${drawable.toString(16)} gc=${gcid.toString(16)} fg=${gc?.fg.toString(16)} arcs=${numArcs}`);
        for (let i = 0; i < numArcs; i++) {
          const off = 12 + i * 12;
          const x = i16(off), y = i16(off + 2);
          const w = u16(off + 4), h = u16(off + 6);
          const a1 = i16(off + 8), a2 = i16(off + 10);
          this.emit('log', `  arc[${i}] x=${x} y=${y} w=${w} h=${h} a1=${a1} a2=${a2}`);
          this.emit('render', { kind: 'fill-arc', drawable, gc: gcid, x, y, w, h, angle1: a1, angle2: a2, fg: gc?.fg || 0 } as XRenderEvent);
        }
        break;
      }
      case 72: { // PutImage
        // const format = data[1]; // 0=Bitmap, 1=XYPixmap, 2=ZPixmap (depth 로 분기)
        const drawable = u32(4);
        const gcid = u32(8);
        const w = u16(12), h = u16(14);
        const dx = i16(16), dy = i16(18);
        const leftPad = data[20];
        const depth = data[21];
        const pixelData = data.subarray(24);
        const gc = ctx.gcs.get(gcid);
        // depth=1 (bitmap mask) — 1bpp data → 0/1 픽셀, fg/bg 색으로 매핑
        if (depth === 1) {
          const fg = gc?.fg ?? 0xFFFFFF;
          const bg = gc?.bg ?? 0x000000;
          // 행당 바이트 = ceil((w + leftPad) / 8), 4byte align
          const bytesPerRow = Math.ceil((w + leftPad) / 8);
          const padded = Math.ceil(bytesPerRow / 4) * 4;
          // RGBA 픽셀 배열 만들기
          const rgba = Buffer.alloc(w * h * 4);
          for (let py = 0; py < h; py++) {
            for (let px = 0; px < w; px++) {
              const bitIdx = px + leftPad;
              const byteOff = py * padded + (bitIdx >> 3);
              const bitMask = 1 << (bitIdx & 7); // LSB-first (대부분의 X 클라이언트 기본)
              const isOne = (pixelData[byteOff] & bitMask) !== 0;
              const px32 = isOne ? fg : bg;
              const off = (py * w + px) * 4;
              rgba[off] = (px32 >> 16) & 0xFF;
              rgba[off + 1] = (px32 >> 8) & 0xFF;
              rgba[off + 2] = px32 & 0xFF;
              rgba[off + 3] = 0xFF;
            }
          }
          this.emit('render', { kind: 'put-image', drawable, x: dx, y: dy, w, h, rgba } as any);
        }
        // depth>1 ZPixmap — TODO (현재 xeyes/xclock 미사용)
        break;
      }
      case 76: { // ImageText8
        const stringLen = data[1];
        const drawable = u32(4);
        const gcid = u32(8);
        const x = i16(12), y = i16(14);
        const text = data.subarray(16, 16 + stringLen).toString('latin1');
        const gc = ctx.gcs.get(gcid);
        this.emit('render', { kind: 'image-text', drawable, gc: gcid, x, y, text, fg: gc?.fg || 0, bg: gc?.bg } as XRenderEvent);
        break;
      }
      case 3: { // GetWindowAttributes — needs reply
        const wid = u32(4);
        const w = ctx.windows.get(wid);
        const reply = Buffer.alloc(44);
        reply[0] = 1; // reply
        reply[1] = 0; // backing-store: NotUseful
        this._writeU16(reply, 2, ctx.sequence & 0xFFFF, le);
        this._writeU32(reply, 4, 3, le); // length: 3 extra 4-byte units
        this._writeU32(reply, 8, 0x21, le); // visual
        this._writeU16(reply, 12, w?.mapped ? 2 : 0, le); // map state
        ctx.socket.write(reply);
        break;
      }
      case 17: { // GetAtomName
        const atom = u32(4);
        const name = ctx.atomsRev.get(atom) || '';
        const nameBuf = Buffer.from(name, 'utf8');
        const padLen = pad4(nameBuf.length);
        const reply = Buffer.alloc(32 + nameBuf.length + padLen);
        reply[0] = 1;
        this._writeU16(reply, 2, ctx.sequence & 0xFFFF, le);
        this._writeU32(reply, 4, (nameBuf.length + padLen) / 4, le);
        this._writeU16(reply, 8, nameBuf.length, le);
        nameBuf.copy(reply, 32);
        ctx.socket.write(reply);
        break;
      }
      case 26: { // GrabPointer
        const reply = Buffer.alloc(32);
        reply[0] = 1; reply[1] = 0; // success
        this._writeU16(reply, 2, ctx.sequence & 0xFFFF, le);
        ctx.socket.write(reply);
        break;
      }
      case 31: { // GrabKeyboard
        const reply = Buffer.alloc(32);
        reply[0] = 1; reply[1] = 0;
        this._writeU16(reply, 2, ctx.sequence & 0xFFFF, le);
        ctx.socket.write(reply);
        break;
      }
      case 41: { // TranslateCoordinates
        const reply = Buffer.alloc(32);
        reply[0] = 1; reply[1] = 1; // same screen
        this._writeU16(reply, 2, ctx.sequence & 0xFFFF, le);
        this._writeU32(reply, 8, 0, le); // child = None
        ctx.socket.write(reply);
        break;
      }
      case 43: { // GetInputFocus
        const reply = Buffer.alloc(32);
        reply[0] = 1; reply[1] = 0; // revert-to: None
        this._writeU16(reply, 2, ctx.sequence & 0xFFFF, le);
        this._writeU32(reply, 8, 0, le); // focus = None
        ctx.socket.write(reply);
        break;
      }
      case 44: { // QueryKeymap
        const reply = Buffer.alloc(40);
        reply[0] = 1;
        this._writeU16(reply, 2, ctx.sequence & 0xFFFF, le);
        this._writeU32(reply, 4, 2, le); // 2 extra 4-byte units (32 bytes of keys)
        ctx.socket.write(reply);
        break;
      }
      case 45: { // OpenFont — no reply, just store
        // 폰트는 무시 (canvas 가 자체 폰트로 그림)
        break;
      }
      case 46: { // CloseFont
        break;
      }
      case 47: { // QueryFont — 신뢰성 있는 폰트 메트릭 응답
        const reply = Buffer.alloc(60);
        reply[0] = 1;
        this._writeU16(reply, 2, ctx.sequence & 0xFFFF, le);
        this._writeU32(reply, 4, 7, le);
        // min-bounds (offset 8-19): 모든 chars 가 8x14 라고 가정
        this._writeU16(reply, 8, 0, le);   // leftSideBearing
        this._writeU16(reply, 10, 8, le);  // rightSideBearing
        this._writeU16(reply, 12, 8, le);  // characterWidth
        this._writeU16(reply, 14, 11, le); // ascent
        this._writeU16(reply, 16, 3, le);  // descent
        this._writeU16(reply, 18, 0, le);  // attributes
        // max-bounds (offset 24-35)
        this._writeU16(reply, 24, 0, le);
        this._writeU16(reply, 26, 8, le);
        this._writeU16(reply, 28, 8, le);
        this._writeU16(reply, 30, 11, le);
        this._writeU16(reply, 32, 3, le);
        this._writeU16(reply, 34, 0, le);
        this._writeU16(reply, 40, 32, le); // min_char_or_byte2 (space)
        this._writeU16(reply, 42, 126, le); // max_char_or_byte2 (~)
        this._writeU16(reply, 44, 32, le); // default_char (space)
        this._writeU16(reply, 46, 0, le); // properties count
        reply[48] = 0; // draw_direction: LeftToRight
        reply[49] = 0; reply[50] = 0;
        reply[51] = 1; // all_chars_exist
        this._writeU16(reply, 52, 11, le); // font_ascent
        this._writeU16(reply, 54, 3, le); // font_descent
        this._writeU32(reply, 56, 0, le); // chars count (0 → use min/max bounds)
        ctx.socket.write(reply);
        break;
      }
      case 48: { // QueryTextExtents — 텍스트 폭 측정
        const oddLength = (data[1] !== 0); // request: pad ~ 4 bytes off, string at offset 8
        // string is at offset 8, length = (request_len_bytes - 8) / 2 chars (2 bytes per CHAR2B)
        const charCount = ((data.length - 8) / 2) - (oddLength ? 1 : 0);
        const charWidth = 8; // 균일한 폭
        const totalWidth = charCount * charWidth;
        const reply = Buffer.alloc(32);
        reply[0] = 1;
        reply[1] = 0; // draw_direction LeftToRight
        this._writeU16(reply, 2, ctx.sequence & 0xFFFF, le);
        this._writeU32(reply, 4, 0, le);
        this._writeU16(reply, 8, 11, le); // font_ascent
        this._writeU16(reply, 10, 3, le); // font_descent
        this._writeU16(reply, 12, 11, le); // overall_ascent
        this._writeU16(reply, 14, 3, le); // overall_descent
        this._writeU32(reply, 16, totalWidth, le); // overall_width
        this._writeU32(reply, 20, 0, le); // overall_left
        this._writeU32(reply, 24, totalWidth, le); // overall_right
        ctx.socket.write(reply);
        break;
      }
      case 49: { // ListFonts — return some common font names so apps don't fail
        const fonts = [
          'fixed',
          '9x15',
          '-misc-fixed-medium-r-normal--13-120-75-75-c-70-iso8859-1',
          '-misc-fixed-medium-r-normal--14-130-75-75-c-70-iso8859-1',
          '-*-helvetica-medium-r-*-*-12-*-*-*-*-*-*-*',
          '-*-courier-medium-r-*-*-12-*-*-*-*-*-*-*',
          '-*-times-medium-r-*-*-12-*-*-*-*-*-*-*',
          '-*-fixed-medium-r-*-*-*-*-*-*-*-*-iso10646-1',
          '-*-helvetica-medium-r-*-*-12-*-*-*-*-*-iso10646-1',
        ];
        // Build STRs: each is [length(1)][chars]; total padded to multiple of 4
        const strData = Buffer.concat(fonts.map(f => {
          const b = Buffer.from(f, 'utf8');
          return Buffer.concat([Buffer.from([b.length]), b]);
        }));
        const padLen = pad4(strData.length);
        const totalExtra = strData.length + padLen;
        const reply = Buffer.alloc(32 + totalExtra);
        reply[0] = 1;
        this._writeU16(reply, 2, ctx.sequence & 0xFFFF, le);
        this._writeU32(reply, 4, totalExtra / 4, le);
        this._writeU16(reply, 8, fonts.length, le);
        strData.copy(reply, 32);
        ctx.socket.write(reply);
        break;
      }
      case 50: { // ListFontsWithInfo — series of replies, last is empty.
        // 단순화: 빈 응답으로 끝 (numNames=0 → 종료 신호)
        const reply = Buffer.alloc(60);
        reply[0] = 1;
        this._writeU16(reply, 2, ctx.sequence & 0xFFFF, le);
        // length = 7 (60-32)/4
        this._writeU32(reply, 4, 7, le);
        // name length = 0 → 마지막 응답
        ctx.socket.write(reply);
        break;
      }
      case 78: { // CreateColormap — no reply
        break;
      }
      case 84: { // AllocColor — needs reply with rgb
        const r = u16(8), g = u16(10), b = u16(12);
        const reply = Buffer.alloc(32);
        reply[0] = 1;
        this._writeU16(reply, 2, ctx.sequence & 0xFFFF, le);
        this._writeU16(reply, 8, r, le);
        this._writeU16(reply, 10, g, le);
        this._writeU16(reply, 12, b, le);
        // pixel value: pack RGB to 24-bit
        const pixel = ((r >> 8) << 16) | ((g >> 8) << 8) | (b >> 8);
        this._writeU32(reply, 16, pixel, le);
        ctx.socket.write(reply);
        break;
      }
      case 85: { // AllocNamedColor — return success with arbitrary color
        const reply = Buffer.alloc(32);
        reply[0] = 1;
        this._writeU16(reply, 2, ctx.sequence & 0xFFFF, le);
        this._writeU32(reply, 8, 0xFFFFFF, le); // pixel: white
        this._writeU16(reply, 12, 0xFFFF, le); // exact red
        this._writeU16(reply, 14, 0xFFFF, le); // exact green
        this._writeU16(reply, 16, 0xFFFF, le); // exact blue
        this._writeU16(reply, 18, 0xFFFF, le);
        this._writeU16(reply, 20, 0xFFFF, le);
        this._writeU16(reply, 22, 0xFFFF, le);
        ctx.socket.write(reply);
        break;
      }
      case 91: { // QueryColors — return RGB for each requested pixel
        // request: opcode(1), unused(1), length(2), cmap(4), pixels (4 bytes each)
        const numPixels = (data.length - 8) / 4;
        const replyExtraBytes = numPixels * 8; // 8 bytes per RGB
        const reply = Buffer.alloc(32 + replyExtraBytes);
        reply[0] = 1;
        this._writeU16(reply, 2, ctx.sequence & 0xFFFF, le);
        this._writeU32(reply, 4, replyExtraBytes / 4, le); // length in 4-byte units
        this._writeU16(reply, 8, numPixels, le); // numColors
        for (let i = 0; i < numPixels; i++) {
          const pixel = u32(8 + i * 4);
          const r = ((pixel >> 16) & 0xFF) * 257; // 8bit → 16bit
          const g = ((pixel >> 8) & 0xFF) * 257;
          const b = (pixel & 0xFF) * 257;
          const off = 32 + i * 8;
          this._writeU16(reply, off, r, le);
          this._writeU16(reply, off + 2, g, le);
          this._writeU16(reply, off + 4, b, le);
          // last 2 bytes unused
        }
        ctx.socket.write(reply);
        break;
      }
      case 92: { // LookupColor — return arbitrary color match
        // request: opcode(1), unused(1), length(2), cmap(4), nameLen(2), unused(2), name(...)
        const reply = Buffer.alloc(32);
        reply[0] = 1;
        this._writeU16(reply, 2, ctx.sequence & 0xFFFF, le);
        // exact + visual rgb (모두 white 로)
        this._writeU16(reply, 8, 0xFFFF, le);
        this._writeU16(reply, 10, 0xFFFF, le);
        this._writeU16(reply, 12, 0xFFFF, le);
        this._writeU16(reply, 14, 0xFFFF, le);
        this._writeU16(reply, 16, 0xFFFF, le);
        this._writeU16(reply, 18, 0xFFFF, le);
        ctx.socket.write(reply);
        break;
      }
      case 98: { // QueryExtension
        const nameLen = u16(4);
        const name = data.subarray(8, 8 + nameLen).toString('latin1');
        const reply = Buffer.alloc(32);
        reply[0] = 1;
        this._writeU16(reply, 2, ctx.sequence & 0xFFFF, le);
        if (name === 'SHAPE') {
          reply[8] = 1; // present
          reply[9] = SHAPE_OPCODE; // major opcode
          reply[10] = 0; // first event (SHAPE 의 ShapeNotify base)
          reply[11] = 0; // first error
          this.emit('log', `QueryExtension SHAPE → present (op=${SHAPE_OPCODE})`);
        } else {
          reply[8] = 0;
          reply[9] = 0;
          reply[10] = 0;
          reply[11] = 0;
        }
        ctx.socket.write(reply);
        break;
      }
      case 99: { // ListExtensions — empty list
        const reply = Buffer.alloc(32);
        reply[0] = 1;
        reply[1] = 0; // count of extensions
        this._writeU16(reply, 2, ctx.sequence & 0xFFFF, le);
        ctx.socket.write(reply);
        break;
      }
      case 101: { // GetKeyboardMapping — needs reply
        // Return minimal 1-keysym-per-keycode mapping for full keycode range
        const minK = 8, maxK = 255;
        const numKeys = maxK - minK + 1;
        const keysymsPerCode = 1;
        const dataLen = numKeys * keysymsPerCode * 4;
        const reply = Buffer.alloc(32 + dataLen);
        reply[0] = 1;
        reply[1] = keysymsPerCode;
        this._writeU16(reply, 2, ctx.sequence & 0xFFFF, le);
        this._writeU32(reply, 4, dataLen / 4, le);
        // keysyms 모두 0 (NoSymbol)
        ctx.socket.write(reply);
        break;
      }
      case 116: { // GetKeyboardControl
        const reply = Buffer.alloc(52);
        reply[0] = 1; reply[1] = 1; // global auto repeat
        this._writeU16(reply, 2, ctx.sequence & 0xFFFF, le);
        this._writeU32(reply, 4, 5, le); // length 5
        ctx.socket.write(reply);
        break;
      }
      case 119: { // GetPointerControl
        const reply = Buffer.alloc(32);
        reply[0] = 1;
        this._writeU16(reply, 2, ctx.sequence & 0xFFFF, le);
        this._writeU16(reply, 8, 1, le); // accel num
        this._writeU16(reply, 10, 1, le); // accel den
        this._writeU16(reply, 12, 0, le); // threshold
        ctx.socket.write(reply);
        break;
      }
      case 39: { // GetMotionEvents — empty
        const reply = Buffer.alloc(32);
        reply[0] = 1;
        this._writeU16(reply, 2, ctx.sequence & 0xFFFF, le);
        ctx.socket.write(reply);
        break;
      }
      case 15: { // QueryTree — return no children
        const reply = Buffer.alloc(32);
        reply[0] = 1;
        this._writeU16(reply, 2, ctx.sequence & 0xFFFF, le);
        this._writeU32(reply, 8, 0x26, le); // root
        this._writeU32(reply, 12, 0, le); // parent
        this._writeU16(reply, 16, 0, le); // children count
        ctx.socket.write(reply);
        break;
      }
      default:
        if (opcode === SHAPE_OPCODE) {
          this._handleShape(ctx, data);
        }
        break;
    }
  }

  private _handleShape(ctx: ClientCtx, data: Buffer): void {
    const le = ctx.le;
    const u32 = (off: number) => this._u32(data, off, le);
    const sub = data[1]; // SHAPE 의 sub-opcode
    this.emit('log', `SHAPE sub=${sub} len=${data.length}`);
    switch (sub) {
      case 0: { // ShapeQueryVersion → reply 1.1
        const reply = Buffer.alloc(32);
        reply[0] = 1;
        this._writeU16(reply, 2, ctx.sequence & 0xFFFF, le);
        this._writeU16(reply, 8, 1, le); // major
        this._writeU16(reply, 10, 1, le); // minor
        ctx.socket.write(reply);
        break;
      }
      case 1: { // ShapeRectangles
        const op = data[4]; // operation: 0=Set,1=Union,...
        const kind = data[5]; // 0=Bounding,1=Clip,2=Input
        const wid = u32(8);
        const xOff = data.readInt16LE(12);
        const yOff = data.readInt16LE(14);
        const numRects = (data.length - 16) / 8;
        const rects: { x: number; y: number; w: number; h: number }[] = [];
        for (let i = 0; i < numRects; i++) {
          const off = 16 + i * 8;
          rects.push({
            x: data.readInt16LE(off),
            y: data.readInt16LE(off + 2),
            w: data.readUInt16LE(off + 4),
            h: data.readUInt16LE(off + 6),
          });
        }
        this.emit('render', { kind: 'window-shape-rects', win: wid, kindMask: kind, op, xOff, yOff, rects } as any);
        break;
      }
      case 2: { // ShapeMask
        const op = data[4];
        const kind = data[5]; // 0=Bounding
        const wid = u32(8);
        const xOff = data.readInt16LE(12);
        const yOff = data.readInt16LE(14);
        const pixmap = u32(16); // 0=None
        this.emit('log', `ShapeMask win=${wid.toString(16)} pixmap=${pixmap.toString(16)} kind=${kind} op=${op}`);
        this.emit('render', { kind: 'window-shape', win: wid, pixmap, kindMask: kind, op, xOff, yOff } as any);
        break;
      }
      // 기타 sub-opcode 는 무시 (Combine/Offset/QueryExtents/SelectInput 등)
      default:
        break;
    }
  }

  // 이벤트 송신 헬퍼들
  private _writeU16(buf: Buffer, off: number, v: number, le: boolean) { le ? buf.writeUInt16LE(v, off) : buf.writeUInt16BE(v, off); }
  private _writeU32(buf: Buffer, off: number, v: number, le: boolean) { le ? buf.writeUInt32LE(v, off) : buf.writeUInt32BE(v, off); }

  private _sendExpose(ctx: ClientCtx, wid: number, x: number, y: number, w: number, h: number): void {
    const buf = Buffer.alloc(32);
    buf[0] = 12; // Expose event
    this._writeU16(buf, 2, ctx.sequence & 0xFFFF, ctx.le);
    this._writeU32(buf, 4, wid, ctx.le);
    this._writeU16(buf, 8, x, ctx.le);
    this._writeU16(buf, 10, y, ctx.le);
    this._writeU16(buf, 12, w, ctx.le);
    this._writeU16(buf, 14, h, ctx.le);
    this._writeU16(buf, 16, 0, ctx.le); // count
    ctx.socket.write(buf);
  }

  private _sendMapNotify(ctx: ClientCtx, wid: number): void {
    const buf = Buffer.alloc(32);
    buf[0] = 19; // MapNotify
    this._writeU16(buf, 2, ctx.sequence & 0xFFFF, ctx.le);
    this._writeU32(buf, 4, wid, ctx.le); // event
    this._writeU32(buf, 8, wid, ctx.le); // window
    buf[12] = 0; // override-redirect
    ctx.socket.write(buf);
  }

  private _sendConfigureNotify(ctx: ClientCtx, wid: number, x: number, y: number, w: number, h: number): void {
    const buf = Buffer.alloc(32);
    buf[0] = 22; // ConfigureNotify
    this._writeU16(buf, 2, ctx.sequence & 0xFFFF, ctx.le);
    this._writeU32(buf, 4, wid, ctx.le); // event
    this._writeU32(buf, 8, wid, ctx.le); // window
    this._writeU32(buf, 12, 0, ctx.le); // above-sibling: None
    this._writeU16(buf, 16, x, ctx.le);
    this._writeU16(buf, 18, y, ctx.le);
    this._writeU16(buf, 20, w, ctx.le);
    this._writeU16(buf, 22, h, ctx.le);
    this._writeU16(buf, 24, 0, ctx.le); // border width
    buf[26] = 0; // override-redirect
    ctx.socket.write(buf);
  }

  private _sendSetupResponse(ctx: ClientCtx): void {
    const vendor = 'PePeTerminal';
    const screenWidthPx = 1280, screenHeightPx = 800;
    const screenWidthMm = 339, screenHeightMm = 212;
    const isLE = ctx.le;
    const w = (n: number, size: 1 | 2 | 4): Buffer => {
      const b = Buffer.alloc(size);
      if (size === 1) b.writeUInt8(n, 0);
      else if (size === 2) isLE ? b.writeUInt16LE(n, 0) : b.writeUInt16BE(n, 0);
      else isLE ? b.writeUInt32LE(n, 0) : b.writeUInt32BE(n, 0);
      return b;
    };
    const vendorBuf = Buffer.from(vendor, 'utf8');
    const vendorPad = Buffer.alloc(pad4(vendorBuf.length));
    const fmt = Buffer.concat([w(24, 1), w(32, 1), w(32, 1), Buffer.alloc(5)]);
    const visualId = 0x21;
    const visual = Buffer.concat([w(visualId, 4), w(4, 1), w(8, 1), w(256, 2), w(0xFF0000, 4), w(0x00FF00, 4), w(0x0000FF, 4), Buffer.alloc(4)]);
    const depth = Buffer.concat([w(24, 1), Buffer.alloc(1), w(1, 2), Buffer.alloc(4), visual]);
    const rootWindowId = 0x26;
    const colormapId = 0x20;
    const screen = Buffer.concat([
      w(rootWindowId, 4), w(colormapId, 4), w(0xFFFFFF, 4), w(0x000000, 4),
      w(0, 4), w(screenWidthPx, 2), w(screenHeightPx, 2), w(screenWidthMm, 2), w(screenHeightMm, 2),
      w(1, 2), w(1, 2), w(visualId, 4), w(0, 1), w(0, 1), w(24, 1), w(1, 1), depth,
    ]);
    const bodyHeader = Buffer.concat([
      w(11000000, 4), w(ctx.resourceIdBase, 4), w(ctx.resourceIdMask, 4), w(0, 4),
      w(vendorBuf.length, 2), w(65535, 2), w(1, 1), w(1, 1),
      w(isLE ? 0 : 1, 1), w(0, 1), w(32, 1), w(32, 1), w(8, 1), w(255, 1), Buffer.alloc(4),
    ]);
    const body = Buffer.concat([bodyHeader, vendorBuf, vendorPad, fmt, screen]);
    const bodyLen = body.length / 4;
    const header = Buffer.concat([w(1, 1), w(0, 1), w(X_PROTOCOL_MAJOR, 2), w(X_PROTOCOL_MINOR, 2), w(bodyLen, 2)]);
    ctx.socket.write(Buffer.concat([header, body]));
    this.emit('log', `setup response sent (LE=${ctx.le})`);
  }
}

let _currentServer: X11Server | null = null;
let _renderListeners: ((ev: XRenderEvent) => void)[] = [];

export async function startEmbeddedX11(displayNum: number, log?: (msg: string) => void): Promise<X11Server | null> {
  if (_currentServer) return _currentServer;
  const srv = new X11Server();
  if (log) srv.on('log', log);
  srv.on('render', (ev: XRenderEvent) => {
    for (const fn of _renderListeners) { try { fn(ev); } catch {} }
  });
  try {
    await srv.start(displayNum);
    _currentServer = srv;
    return srv;
  } catch (err: any) {
    log?.(`X server start failed: ${err.message}`);
    return null;
  }
}

export function stopEmbeddedX11(): void {
  if (_currentServer) { _currentServer.stop(); _currentServer = null; }
}

export function onX11Render(fn: (ev: XRenderEvent) => void): () => void {
  _renderListeners.push(fn);
  return () => { _renderListeners = _renderListeners.filter(f => f !== fn); };
}

export function injectX11Motion(wid: number, x: number, y: number): void {
  _currentServer?.injectMotion(wid, x, y);
}
export function injectX11Button(wid: number, x: number, y: number, button: number, press: boolean): void {
  _currentServer?.injectButton(wid, x, y, button, press);
}
