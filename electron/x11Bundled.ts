// electron/x11Bundled.ts
// VcXsrv (또는 호환 X 서버) 를 번들된 바이너리로 spawn — Qt/GTK 앱 모두 호환.
// 우리가 직접 구현한 x11Server.ts 보다 우선 시도. 번들 바이너리 없으면 fallback.
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import net from 'net';
import { app } from 'electron';

// 같은 display 번호로 이미 띄운 인스턴스 재사용
const _running: Map<number, ChildProcess> = new Map();

// resources/x11-server.zip 이 있고 풀어진 폴더가 없으면 풀어둠 (포터블 빌드 대응 — NSIS 안 거치는 경우)
function ensureExtracted(log?: (m: string) => void): void {
  const zipCandidates = [
    path.join(process.resourcesPath, 'x11-server.zip'),
    path.join(app.getAppPath(), '..', 'x11-server.zip'),
  ];
  for (const zip of zipCandidates) {
    try {
      if (!fs.existsSync(zip)) continue;
      const target = path.join(path.dirname(zip), 'x11-server');
      if (fs.existsSync(path.join(target, 'vcxsrv.exe'))) return; // 이미 풀려있음
      log?.(`X11 서버 압축 해제 중: ${zip} → ${target}`);
      try {
        require('child_process').execFileSync('powershell', [
          '-NoProfile', '-ExecutionPolicy', 'Bypass',
          '-Command', `Expand-Archive -Path "${zip}" -DestinationPath "${target}" -Force`,
        ], { windowsHide: true });
        log?.(`X11 서버 압축 해제 완료`);
      } catch (e: any) {
        log?.(`압축 해제 실패: ${e.message}`);
      }
      return;
    } catch {}
  }
}

function getBundledPath(log?: (m: string) => void): string | null {
  ensureExtracted(log);
  // 우선순위:
  //  1. 번들된 위치 (앱 내부 resources/x11-server/)
  //  2. 시스템 설치된 VcXsrv (Program Files)
  const candidates = [
    path.join(process.resourcesPath, 'x11-server', 'vcxsrv.exe'),
    path.join(app.getAppPath(), '..', 'x11-server', 'vcxsrv.exe'),
    path.join(__dirname, '..', '..', 'resources', 'x11-server', 'vcxsrv.exe'),
    path.join(__dirname, '..', 'resources', 'x11-server', 'vcxsrv.exe'),
    'C:\\Program Files\\VcXsrv\\vcxsrv.exe',
    'C:\\Program Files (x86)\\VcXsrv\\vcxsrv.exe',
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        log?.(`VcXsrv 발견: ${p}`);
        return p;
      }
    } catch {}
  }
  log?.(`VcXsrv 바이너리 없음 — 검색 경로: ${candidates.join(' | ')}`);
  return null;
}

// 포트 점유 검사 — bind 시도 (실패하면 누군가 listen 중)
function isPortBindable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    let done = false;
    const fin = (ok: boolean) => { if (done) return; done = true; try { s.close(); } catch {} resolve(ok); };
    s.once('error', () => fin(false));
    s.once('listening', () => fin(true));
    s.listen(port, '127.0.0.1');
  });
}
async function isPortInUse(port: number): Promise<boolean> {
  return !(await isPortBindable(port));
}

export async function startBundledX11(displayNum = 0, log?: (msg: string) => void): Promise<{ proc: ChildProcess | null; usedBundled: boolean }> {
  const port = 6000 + displayNum;
  // 이미 그 디스플레이에 X 서버가 떠 있으면 그대로 사용
  if (await isPortInUse(port)) {
    log?.(`port ${port} already in use — 외부 또는 기존 X 서버 사용`);
    return { proc: null, usedBundled: false };
  }
  if (_running.has(displayNum)) {
    return { proc: _running.get(displayNum)!, usedBundled: true };
  }
  const exe = getBundledPath(log);
  if (!exe) {
    log?.(`번들/시스템 VcXsrv 미설치 — 내장 X 서버로 fallback`);
    return { proc: null, usedBundled: false };
  }
  log?.(`X 서버 실행: ${exe} :${displayNum}`);
  // VcXsrv 옵션:
  //  -multiwindow : 각 X 윈도우를 독립 Windows 창으로
  //  -clipboard   : 클립보드 동기화
  //  -wgl         : OpenGL (Qt 차트, 일부 GTK 앱)
  //  -ac          : access control off (localhost only 이므로 안전)
  //  -silent-dup-error : 동일 display 중복 실행 시 조용히 종료
  //  -nowinkill   : Ctrl+Alt+Backspace 안 받음
  //  +bs          : backing store 활성
  //  -nolisten ... : 보안 — 우린 localhost 만
  const args = [
    `:${displayNum}`,
    '-multiwindow',
    '-clipboard',
    '-wgl',
    '-ac',
    '-listen', 'tcp',         // 핵심: TCP 6000+display 포트 listen (SSH X11 forwarding 필수)
    '-silent-dup-error',
    '-nowinkill',
    '+bs',
  ];
  try {
    const cwd = path.dirname(exe); // VcXsrv 의 DLL/fonts 가 같은 폴더에서 로드되도록
    const proc = spawn(exe, args, { detached: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, cwd });
    let stderrBuf = '';
    let stdoutBuf = '';
    proc.stdout?.on('data', d => { stdoutBuf += d.toString(); });
    proc.stderr?.on('data', d => { stderrBuf += d.toString(); });
    proc.on('exit', (code, signal) => {
      log?.(`X 서버 종료 (code=${code} signal=${signal})${stderrBuf ? ` stderr: ${stderrBuf.trim()}` : ''}${stdoutBuf ? ` stdout: ${stdoutBuf.trim()}` : ''}`);
      _running.delete(displayNum);
    });
    proc.on('error', (e) => {
      log?.(`X 서버 spawn 오류: ${e.message}`);
    });
    _running.set(displayNum, proc);
    // VcXsrv 초기화 대기 (1.5s). 프로세스 살아있으면 정상이라 가정.
    // (Windows 의 0.0.0.0 vs 127.0.0.1 dual-stack bind 동작 + VcXsrv 의 X handshake 검증 때문에
    //  우리가 직접 TCP 검증하기 어려움 — 신뢰 기반)
    await new Promise(r => setTimeout(r, 1500));
    if (proc.exitCode !== null) {
      log?.(`X 서버가 시작 직후 종료됨 (code=${proc.exitCode})`);
      _running.delete(displayNum);
      return { proc: null, usedBundled: false };
    }
    log?.(`X 서버 시작됨 (PID=${proc.pid}) — DISPLAY=:${displayNum}`);
    return { proc, usedBundled: true };
  } catch (err: any) {
    log?.(`X 서버 실행 실패: ${err.message}`);
    return { proc: null, usedBundled: false };
  }
}

export function stopBundledX11(displayNum = 0): void {
  const p = _running.get(displayNum);
  if (p) {
    try { p.kill(); } catch {}
    _running.delete(displayNum);
  }
}

export function stopAllBundledX11(): void {
  for (const [num, p] of _running) {
    try { p.kill(); } catch {}
  }
  _running.clear();
}

export function isBundledX11Running(displayNum = 0): boolean {
  const p = _running.get(displayNum);
  if (!p) return false;
  return p.exitCode === null;
}

export function listRunningX11(): { displayNum: number; pid: number | undefined }[] {
  const list: { displayNum: number; pid: number | undefined }[] = [];
  for (const [num, p] of _running) {
    if (p.exitCode === null) list.push({ displayNum: num, pid: p.pid });
  }
  return list;
}
