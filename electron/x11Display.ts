// electron/x11Display.ts
// 임베디드 X 서버의 그리기 이벤트를 받아 BrowserWindow 안 canvas 에 렌더링.
import { BrowserWindow, ipcMain } from 'electron';
import { onX11Render, injectX11Motion, injectX11Button, type XRenderEvent } from './x11Server';

let displayWin: BrowserWindow | null = null;
let pendingEvents: XRenderEvent[] = [];

const HTML = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8" />
<title>X11 Display (PePe Terminal)</title>
<style>
  html, body { margin: 0; padding: 0; background: #303030; color: #eee; font-family: sans-serif; height: 100%; overflow: hidden; }
  #stage { position: relative; width: 100vw; height: 100vh; overflow: auto; }
  .x-window { position: absolute; background: #888; border: 1px solid #555; box-shadow: 0 2px 8px rgba(0,0,0,0.4); }
  .x-window canvas { display: block; }
  #status { position: fixed; bottom: 4px; left: 4px; font-size: 11px; color: #888; background: rgba(0,0,0,0.5); padding: 2px 6px; border-radius: 3px; }
</style>
</head><body>
<div id="stage"></div>
<div id="status">X Display ready</div>
<script>
  const { ipcRenderer } = require('electron');
  const stage = document.getElementById('stage');
  const status = document.getElementById('status');
  const wins = new Map(); // id -> { div, canvas, ctx, x, y, w, h, ... }
  const pixmaps = new Map(); // id -> { canvas (offscreen), ctx, w, h, depth }
  function pixelToCss(p) { const r = (p >> 16) & 0xFF, g = (p >> 8) & 0xFF, b = p & 0xFF; return 'rgb(' + r + ',' + g + ',' + b + ')'; }
  function ensurePixmap(id, w, h, depth) {
    let p = pixmaps.get(id);
    if (p) return p;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    p = { canvas: c, ctx: c.getContext('2d'), w, h, depth };
    pixmaps.set(id, p);
    return p;
  }
  // Shape mask 의 가장자리(에지) 픽셀들을 별도 오버레이 캔버스에 검정색으로 그림 — 윈도우 외곽선 효과
  function renderShapeEdge(e) {
    if (!e.shapeMask) return;
    const p = e.shapeMask;
    const w = e.w, h = e.h;
    if (!e.edgeCanvas) {
      const ec = document.createElement('canvas');
      ec.width = w; ec.height = h;
      ec.style.position = 'absolute';
      ec.style.left = '0'; ec.style.top = '0';
      ec.style.pointerEvents = 'none';
      ec.style.zIndex = '1000'; // 자식 윈도우보다 위에 그려야 외곽선이 보임
      e.div.appendChild(ec);
      e.edgeCanvas = ec;
      e.edgeCtx = ec.getContext('2d');
    } else {
      // 자식 추가된 후에도 항상 최상위에 — 다시 append 하면 마지막 자식이 됨
      e.div.appendChild(e.edgeCanvas);
    }
    const eg = e.edgeCtx;
    eg.clearRect(0, 0, w, h);
    const maskData = p.ctx.getImageData(0, 0, p.w, p.h);
    const a = maskData.data;
    const thick = e.borderWidth || 3;
    const out = eg.getImageData(0, 0, w, h);
    const outA = out.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * p.w + x) * 4 + 3;
        if (a[idx] === 0) continue;
        let isEdge = false;
        for (let dy = -thick; dy <= thick && !isEdge; dy++) {
          for (let dx = -thick; dx <= thick && !isEdge; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= p.w || ny >= p.h) { isEdge = true; break; }
            if (a[(ny * p.w + nx) * 4 + 3] === 0) { isEdge = true; break; }
          }
        }
        if (isEdge) {
          const o = (y * w + x) * 4;
          const bp = e.borderPixel ?? 0;
          outA[o] = (bp >> 16) & 0xFF;
          outA[o + 1] = (bp >> 8) & 0xFF;
          outA[o + 2] = bp & 0xFF;
          outA[o + 3] = 255;
        }
      }
    }
    eg.putImageData(out, 0, 0);
  }
  // Shape mask 적용 — pixmap 의 알파 채널 (불투명한 곳만 표시)
  function applyShape(e) {
    if (!e.shapeMask) {
      e.div.style.webkitMaskImage = '';
      e.div.style.maskImage = '';
      if (e.edgeCanvas) { e.edgeCanvas.remove(); e.edgeCanvas = null; }
      return;
    }
    const p = e.shapeMask;
    const dataUrl = p.canvas.toDataURL();
    const maskCss = 'url("' + dataUrl + '")';
    const sizeCss = e.w + 'px ' + e.h + 'px';
    e.div.style.webkitMaskImage = maskCss;
    e.div.style.webkitMaskSize = sizeCss;
    e.div.style.webkitMaskRepeat = 'no-repeat';
    e.div.style.webkitMaskPosition = '0 0';
    e.div.style.maskImage = maskCss;
    e.div.style.maskSize = sizeCss;
    e.div.style.maskRepeat = 'no-repeat';
    e.div.style.maskPosition = '0 0';
    e.div.style.background = 'transparent';
    e.div.style.border = 'none';
    e.div.style.boxShadow = 'none';
    renderShapeEdge(e);
    status.textContent = 'shape applied: pixmap=' + p.w + 'x' + p.h + ' urlLen=' + dataUrl.length;
  }
  function ensureWin(id, x, y, w, h, bg, parent) {
    let entry = wins.get(id);
    if (entry) return entry;
    const div = document.createElement('div');
    div.className = 'x-window';
    div.style.left = (x || 0) + 'px';
    div.style.top = (y || 0) + 'px';
    div.style.width = (w || 100) + 'px';
    div.style.height = (h || 100) + 'px';
    const canvas = document.createElement('canvas');
    canvas.width = w || 100;
    canvas.height = h || 100;
    div.appendChild(canvas);
    // 부모 윈도우 div 안에 자식 div 를 nest — Shape mask 가 자동으로 자식까지 전파됨
    const parentEntry = parent !== undefined ? wins.get(parent) : null;
    if (parentEntry) parentEntry.div.appendChild(div);
    else stage.appendChild(div);
    const ctx2 = canvas.getContext('2d');
    // bg 미지정 시 흰색 — Shape 적용 시 눈 안쪽이 흰색이어야 함 (xeyes 가정)
    const effectiveBg = bg !== undefined ? bg : 0xFFFFFF;
    entry = { div, canvas, ctx: ctx2, x: x || 0, y: y || 0, w: w || 100, h: h || 100, mapped: false, bg: effectiveBg, bgExplicit: bg !== undefined, parent };
    const cssBg = pixelToCss(effectiveBg);
    div.style.background = cssBg;
    ctx2.fillStyle = cssBg;
    ctx2.fillRect(0, 0, canvas.width, canvas.height);
    wins.set(id, entry);
    return entry;
  }
  function render(ev) {
    try {
      switch (ev.kind) {
        case 'window-create': {
          const w = ev.win;
          const e = ensureWin(w.id, w.x, w.y, w.width, w.height, w.bgPixel, w.parent);
          // Border 처리 — borderWidth 만큼 box-shadow inset 으로 윤곽 그림 (Shape mask 와 함께 작동)
          // 시각적 가독성을 위해 최소 3px 보정 — bw=1 같은 얇은 테두리는 화면에서 거의 안 보임
          if (w.borderWidth > 0 && w.borderPixel !== undefined) {
            const visualBw = Math.max(w.borderWidth, 3);
            e.borderWidth = visualBw;
            e.borderPixel = w.borderPixel;
            e.div.style.boxShadow = 'inset 0 0 0 ' + visualBw + 'px ' + pixelToCss(w.borderPixel);
          }
          break;
        }
        case 'window-bg': {
          const e = wins.get(ev.id);
          if (!e) break;
          const cssBg = pixelToCss(ev.bgPixel);
          e.bg = ev.bgPixel;
          e.div.style.background = cssBg;
          e.ctx.fillStyle = cssBg;
          e.ctx.fillRect(0, 0, e.canvas.width, e.canvas.height);
          break;
        }
        case 'window-map': {
          const e = wins.get(ev.id);
          if (e) { e.div.style.display = 'block'; e.mapped = true; }
          break;
        }
        case 'window-unmap': {
          const e = wins.get(ev.id);
          if (e) { e.div.style.display = 'none'; e.mapped = false; }
          break;
        }
        case 'window-destroy': {
          const e = wins.get(ev.id);
          if (e) { e.div.remove(); wins.delete(ev.id); }
          break;
        }
        case 'pixmap-create': {
          ensurePixmap(ev.id, ev.w, ev.h, ev.depth);
          break;
        }
        case 'pixmap-destroy': {
          pixmaps.delete(ev.id);
          break;
        }
        case 'window-shape': {
          // Shape 확장 — pixmap 의 알파 마스크를 윈도우 클립으로 적용
          const e = wins.get(ev.win);
          const p = pixmaps.get(ev.pixmap);
          if (!e) break;
          if (!p) {
            // 마스크 제거 (None)
            e.shapeMask = null;
            e.div.style.clipPath = '';
            applyShape(e);
            break;
          }
          e.shapeMask = p;
          applyShape(e);
          break;
        }
        case 'window-configure': {
          const e = wins.get(ev.id);
          if (!e) break;
          if (ev.x !== undefined) { e.x = ev.x; e.div.style.left = ev.x + 'px'; }
          if (ev.y !== undefined) { e.y = ev.y; e.div.style.top = ev.y + 'px'; }
          if (ev.w !== undefined) { e.w = ev.w; e.div.style.width = ev.w + 'px'; e.canvas.width = ev.w; }
          if (ev.h !== undefined) { e.h = ev.h; e.div.style.height = ev.h + 'px'; e.canvas.height = ev.h; }
          break;
        }
        case 'clear-area': {
          const e = wins.get(ev.win) || pixmaps.get(ev.win);
          if (!e) break;
          if (e.bg !== undefined) {
            e.ctx.fillStyle = pixelToCss(e.bg);
            e.ctx.fillRect(ev.x, ev.y, ev.w, ev.h);
          } else {
            e.ctx.clearRect(ev.x, ev.y, ev.w, ev.h);
          }
          break;
        }
        case 'pixmap-fill-bg': {
          // 픽스맵 전체 채우기 (1bpp 마스크 초기화 등)
          const p = pixmaps.get(ev.id);
          if (!p) break;
          p.ctx.fillStyle = pixelToCss(ev.fg);
          p.ctx.fillRect(0, 0, p.w, p.h);
          break;
        }
        case 'put-image': {
          const target = wins.get(ev.drawable) || pixmaps.get(ev.drawable);
          if (!target) break;
          const imgData = new ImageData(new Uint8ClampedArray(ev.rgba), ev.w, ev.h);
          target.ctx.putImageData(imgData, ev.x, ev.y);
          // 만약 이 pixmap 이 어떤 윈도우의 shape mask 라면 갱신
          for (const [, w] of wins) {
            if (w.shapeMask === target) applyShape(w);
          }
          break;
        }
        case 'window-shape-rects': {
          const e = wins.get(ev.win);
          if (!e) break;
          // rectangles 기반 shape — 사각형 합집합으로 clip-path 적용
          if (!ev.rects.length) {
            // 빈 영역 — 윈도우 숨김
            e.div.style.clipPath = 'inset(100%)';
          } else {
            const polys = ev.rects.map(r => 'inset(' + r.y + 'px ' + (e.w - r.x - r.w) + 'px ' + (e.h - r.y - r.h) + 'px ' + r.x + 'px)').join(',');
            // CSS clip-path 는 단일 영역만 가능 — rects 가 1개일 때만 정확히 적용. 다수일 땐 첫 번째만.
            const r = ev.rects[0];
            e.div.style.clipPath = 'inset(' + r.y + 'px ' + (e.w - r.x - r.w) + 'px ' + (e.h - r.y - r.h) + 'px ' + r.x + 'px)';
          }
          e.div.style.background = 'transparent';
          e.div.style.border = 'none';
          e.div.style.boxShadow = 'none';
          break;
        }
        case 'fill-rect': {
          const e = wins.get(ev.drawable) || pixmaps.get(ev.drawable);
          if (!e) break;
          // 1bpp 픽스맵: 0 → 완전 투명 (숨김), 1 → 흰색 불투명 (표시) — alpha 마스크 용도
          if (e.depth === 1) {
            if (ev.fg === 0) {
              for (const r of ev.rects) e.ctx.clearRect(r.x, r.y, r.w, r.h);
            } else {
              e.ctx.fillStyle = '#fff';
              for (const r of ev.rects) e.ctx.fillRect(r.x, r.y, r.w, r.h);
            }
          } else {
            e.ctx.fillStyle = pixelToCss(ev.fg);
            for (const r of ev.rects) e.ctx.fillRect(r.x, r.y, r.w, r.h);
          }
          for (const [, w] of wins) { if (w.shapeMask === e) applyShape(w); }
          break;
        }
        case 'fill-arc': {
          const e = wins.get(ev.drawable) || pixmaps.get(ev.drawable);
          if (!e) break;
          const cx = ev.x + ev.w / 2, cy = ev.y + ev.h / 2;
          const rx = ev.w / 2, ry = ev.h / 2;
          const start = -ev.angle1 * Math.PI / (180 * 64);
          const end = start - ev.angle2 * Math.PI / (180 * 64);
          if (e.depth === 1) {
            // alpha 마스크: fg=0 → 투명(clearRect 영역), fg=1 → 흰색
            if (ev.fg === 0) {
              e.ctx.save();
              e.ctx.beginPath();
              e.ctx.ellipse(cx, cy, rx, ry, 0, Math.min(start, end), Math.max(start, end));
              e.ctx.closePath();
              e.ctx.clip();
              e.ctx.clearRect(ev.x, ev.y, ev.w, ev.h);
              e.ctx.restore();
            } else {
              e.ctx.fillStyle = '#fff';
              e.ctx.beginPath();
              e.ctx.ellipse(cx, cy, rx, ry, 0, Math.min(start, end), Math.max(start, end));
              e.ctx.closePath();
              e.ctx.fill();
            }
          } else {
            e.ctx.fillStyle = pixelToCss(ev.fg);
            e.ctx.beginPath();
            e.ctx.ellipse(cx, cy, rx, ry, 0, Math.min(start, end), Math.max(start, end));
            e.ctx.closePath();
            e.ctx.fill();
          }
          for (const [, w] of wins) { if (w.shapeMask === e) applyShape(w); }
          break;
        }
        case 'arc': {
          // 외곽선 호 (PolyArc)
          const e = wins.get(ev.drawable);
          if (!e) break;
          e.ctx.strokeStyle = pixelToCss(ev.fg);
          const cx = ev.x + ev.w / 2, cy = ev.y + ev.h / 2;
          const rx = ev.w / 2, ry = ev.h / 2;
          const start = -ev.angle1 * Math.PI / (180 * 64);
          const end = start - ev.angle2 * Math.PI / (180 * 64);
          e.ctx.beginPath();
          e.ctx.ellipse(cx, cy, rx, ry, 0, Math.min(start, end), Math.max(start, end));
          e.ctx.stroke();
          break;
        }
        case 'fill-poly': {
          const e = wins.get(ev.drawable);
          if (!e || !ev.points.length) break;
          e.ctx.fillStyle = pixelToCss(ev.fg);
          e.ctx.beginPath();
          if (ev.relative) {
            let cx = ev.points[0].x, cy = ev.points[0].y;
            e.ctx.moveTo(cx, cy);
            for (let i = 1; i < ev.points.length; i++) {
              cx += ev.points[i].x; cy += ev.points[i].y;
              e.ctx.lineTo(cx, cy);
            }
          } else {
            e.ctx.moveTo(ev.points[0].x, ev.points[0].y);
            for (let i = 1; i < ev.points.length; i++) e.ctx.lineTo(ev.points[i].x, ev.points[i].y);
          }
          e.ctx.closePath();
          e.ctx.fill();
          break;
        }
        case 'poly-line': {
          const e = wins.get(ev.drawable);
          if (!e || !ev.points.length) break;
          e.ctx.strokeStyle = pixelToCss(ev.fg);
          e.ctx.beginPath();
          if (ev.relative) {
            let cx = ev.points[0].x, cy = ev.points[0].y;
            e.ctx.moveTo(cx, cy);
            for (let i = 1; i < ev.points.length; i++) {
              cx += ev.points[i].x; cy += ev.points[i].y;
              e.ctx.lineTo(cx, cy);
            }
          } else {
            e.ctx.moveTo(ev.points[0].x, ev.points[0].y);
            for (let i = 1; i < ev.points.length; i++) e.ctx.lineTo(ev.points[i].x, ev.points[i].y);
          }
          e.ctx.stroke();
          break;
        }
        case 'image-text': {
          const e = wins.get(ev.drawable);
          if (!e) break;
          if (ev.bg !== undefined) {
            // bg 박스 채우기 (텍스트 폭만큼)
            e.ctx.fillStyle = pixelToCss(ev.bg);
            const m = e.ctx.measureText(ev.text);
            e.ctx.fillRect(ev.x, ev.y - 12, m.width, 14);
          }
          e.ctx.fillStyle = pixelToCss(ev.fg);
          e.ctx.font = '12px sans-serif';
          e.ctx.fillText(ev.text, ev.x, ev.y);
          break;
        }
      }
      status.textContent = 'wins=' + wins.size + ' last=' + ev.kind;
    } catch (err) {
      console.error('render error', err);
    }
  }
  ipcRenderer.on('x-render', (_e, ev) => render(ev));
  // 윈도우 준비 시 main 에게 알림 — pendingEvents 를 받기 위함
  ipcRenderer.send('x-display-ready');

  // 마우스 이벤트를 X 클라이언트로 전달
  function handleMouseEvent(canvas, winId, kind, button, e) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.round(e.clientX - rect.left);
    const y = Math.round(e.clientY - rect.top);
    ipcRenderer.send('x-input', { kind: kind, winId: winId, x: x, y: y, button: button });
  }
  // 새 윈도우 생성 시 mouse listener 등록
  const origEnsureWin = ensureWin;
  function attachMouseHandlers(entry, winId) {
    entry.canvas.addEventListener('mousemove', e => handleMouseEvent(entry.canvas, winId, 'motion', 0, e));
    entry.canvas.addEventListener('mousedown', e => handleMouseEvent(entry.canvas, winId, 'press', e.button + 1, e));
    entry.canvas.addEventListener('mouseup', e => handleMouseEvent(entry.canvas, winId, 'release', e.button + 1, e));
  }
  // 모든 ensureWin 호출 후 마우스 핸들러 추가 — 더 간단히, 각 case 'window-create' 에서 처리
  // 위 render 함수에 변경 적용은 복잡하므로, 신규 윈도우 마다 attach
  const observer = new MutationObserver(() => {
    wins.forEach((entry, winId) => {
      if (!entry._mouseAttached) {
        attachMouseHandlers(entry, winId);
        entry._mouseAttached = true;
      }
    });
  });
  observer.observe(stage, { childList: true, subtree: true });
</script>
</body></html>`;

function ensureWindow(): BrowserWindow {
  if (displayWin && !displayWin.isDestroyed()) return displayWin;
  displayWin = new BrowserWindow({
    width: 1024, height: 768,
    title: 'X11 Display — PePe Terminal',
    backgroundColor: '#303030',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  displayWin.on('closed', () => { displayWin = null; });
  // pending event 비우기 위한 ready 핸들러
  const { ipcMain } = require('electron');
  const onReady = () => {
    if (!displayWin) return;
    for (const ev of pendingEvents) {
      try { displayWin.webContents.send('x-render', ev); } catch {}
    }
    pendingEvents = [];
  };
  ipcMain.once('x-display-ready', onReady);
  displayWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML));
  return displayWin;
}

let _hookInstalled = false;
export function installX11DisplayHook(): void {
  if (_hookInstalled) return;
  _hookInstalled = true;
  // 마우스 이벤트 IPC 수신
  ipcMain.on('x-input', (_e, p: any) => {
    if (!p) return;
    if (p.kind === 'motion') injectX11Motion(p.winId, p.x, p.y);
    else if (p.kind === 'press') injectX11Button(p.winId, p.x, p.y, p.button, true);
    else if (p.kind === 'release') injectX11Button(p.winId, p.x, p.y, p.button, false);
  });
  onX11Render((ev) => {
    // 첫 window-create 또는 window-map 발생 시 디스플레이 창 띄움
    if (ev.kind === 'window-create' || ev.kind === 'window-map') {
      ensureWindow();
    }
    if (displayWin && !displayWin.isDestroyed() && displayWin.webContents && !displayWin.webContents.isLoading()) {
      try { displayWin.webContents.send('x-render', ev); } catch {}
    } else {
      pendingEvents.push(ev);
    }
  });
}
