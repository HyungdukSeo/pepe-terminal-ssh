// electron/vpnService.ts
// OpenVPN community 바이너리(번들)를 elevated 로 spawn 하고 management 소켓으로 상태/로그 모니터링.
// 권한 모델: 매 연결마다 sudo-prompt 로 admin 상승 (UAC/macOS Authorization Services).
// 모니터링: openvpn 의 --management TCP 소켓을 PePe(일반 권한)가 일반 TCP 로 접속해서 스트림.
import path from 'path';
import fs from 'fs';
import net from 'net';
import os from 'os';
import { app } from 'electron';
import { EventEmitter } from 'events';
// sudo-prompt 는 callback 기반 — promise wrapper 사용
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sudo = require('sudo-prompt');

type Status = 'disconnected' | 'starting' | 'connecting' | 'auth' | 'connected' | 'reconnecting' | 'error';

export interface VpnState {
  status: Status;
  configPath?: string;
  configName?: string;
  assignedIp?: string;
  connectedSince?: number;
  bytesIn?: number;
  bytesOut?: number;
  lastError?: string;
}

class VpnService extends EventEmitter {
  private state: VpnState = { status: 'disconnected' };
  private logs: string[] = [];
  private mgmtPort = 7505;
  private mgmtSock: net.Socket | null = null;
  private mgmtBuf = '';
  private pidFile: string | null = null;
  private logFile: string | null = null;
  private logTailTimer: NodeJS.Timeout | null = null;
  private bytecountTimer: NodeJS.Timeout | null = null;

  // openvpn 바이너리 경로 — 환경변수 PEPE_VPN_PREFER_SYSTEM=1 면 시스템 우선, 아니면 번들 우선.
  // 시스템 설치본은 OpenVPN GUI 와 동일한 .exe + DLL 세트라 호환성 검증에 유용.
  binaryPath(): string | null {
    const dev = !app.isPackaged;
    const platform = process.platform;
    const preferSystem = process.env.PEPE_VPN_PREFER_SYSTEM === '1';
    if (platform === 'win32') {
      const bundlePath = dev
        ? path.join(process.cwd(), 'resources', 'openvpn-win', 'openvpn.exe')
        : path.join(process.resourcesPath, 'openvpn', 'openvpn.exe');
      const systemPaths = [
        'C:\\Program Files\\OpenVPN\\bin\\openvpn.exe',
        'C:\\Program Files (x86)\\OpenVPN\\bin\\openvpn.exe',
      ];
      const candidates = preferSystem
        ? [...systemPaths, bundlePath]
        : [bundlePath, ...systemPaths];
      for (const p of candidates) if (fs.existsSync(p)) return p;
      return null;
    } else if (platform === 'darwin') {
      const candidates = [
        dev
          ? path.join(process.cwd(), 'resources', 'openvpn-mac', 'openvpn')
          : path.join(process.resourcesPath, 'openvpn', 'openvpn'),
        // Homebrew Apple Silicon / Intel
        '/opt/homebrew/sbin/openvpn',
        '/opt/homebrew/opt/openvpn/sbin/openvpn',
        '/usr/local/sbin/openvpn',
        '/usr/local/opt/openvpn/sbin/openvpn',
        // Tunnelblick 번들
        '/Applications/Tunnelblick.app/Contents/Resources/openvpn/default/openvpn',
      ];
      for (const p of candidates) if (fs.existsSync(p)) return p;
      return null;
    }
    return null;
  }

  // PePe userData 안에 .ovpn 저장 디렉토리
  configDir(): string {
    const dir = path.join(app.getPath('userData'), 'vpn-configs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  getState(): VpnState { return { ...this.state }; }
  getLogs(): string[] { return [...this.logs]; }
  isAvailable(): { ok: boolean; reason?: string; binaryPath?: string } {
    const bin = this.binaryPath();
    if (!bin) return { ok: false, reason: process.platform === 'win32' ? 'resources/openvpn-win/openvpn.exe 가 없습니다 (번들 누락)' : process.platform === 'darwin' ? 'resources/openvpn-mac/openvpn 가 없습니다 (번들 누락)' : '지원하지 않는 플랫폼' };
    return { ok: true, binaryPath: bin };
  }

  // 사용자가 import 한 .ovpn 파일을 userData 로 복사
  importConfig(srcPath: string): { ok: boolean; storedPath?: string; reason?: string } {
    try {
      if (!fs.existsSync(srcPath)) return { ok: false, reason: '파일을 찾을 수 없음' };
      const baseName = path.basename(srcPath);
      const dest = path.join(this.configDir(), baseName);
      fs.copyFileSync(srcPath, dest);
      return { ok: true, storedPath: dest };
    } catch (err: any) {
      return { ok: false, reason: String(err?.message || err) };
    }
  }

  listConfigs(): { name: string; path: string }[] {
    try {
      return fs.readdirSync(this.configDir())
        .filter(f => f.toLowerCase().endsWith('.ovpn'))
        .map(f => ({ name: f, path: path.join(this.configDir(), f) }));
    } catch { return []; }
  }

  removeConfig(filePath: string): boolean {
    try {
      if (!filePath.startsWith(this.configDir())) return false; // 안전: 다른 경로 삭제 차단
      fs.unlinkSync(filePath);
      return true;
    } catch { return false; }
  }

  private setState(patch: Partial<VpnState>) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }
  private addLog(line: string) {
    // 메모리 보호 — 최대 5000 줄
    this.logs.push(line);
    if (this.logs.length > 5000) this.logs.splice(0, this.logs.length - 5000);
    this.emit('log', line);
  }

  // 사용 중 mgmt 포트 잡기
  private async pickMgmtPort(): Promise<number> {
    // 7505 ~ 7599 중 free 찾기
    for (let p = 7505; p < 7600; p++) {
      const free = await new Promise<boolean>((res) => {
        const tester = net.createServer().once('error', () => res(false))
          .once('listening', () => tester.close(() => res(true)))
          .listen(p, '127.0.0.1');
      });
      if (free) return p;
    }
    return 7505;
  }

  async connect(configPath: string, opts?: { username?: string; password?: string }): Promise<{ ok: boolean; reason?: string }> {
    if (this.state.status !== 'disconnected' && this.state.status !== 'error') {
      return { ok: false, reason: '이미 연결 중이거나 연결되어 있음' };
    }
    const avail = this.isAvailable();
    if (!avail.ok) { this.setState({ status: 'error', lastError: avail.reason }); return { ok: false, reason: avail.reason }; }
    if (!fs.existsSync(configPath)) { this.setState({ status: 'error', lastError: '설정 파일 없음' }); return { ok: false, reason: '설정 파일 없음' }; }

    this.logs = [];
    this.setState({ status: 'starting', configPath, configName: path.basename(configPath), assignedIp: undefined, connectedSince: undefined, lastError: undefined });

    this.mgmtPort = await this.pickMgmtPort();
    this.pidFile = path.join(os.tmpdir(), `pepe-openvpn-${Date.now()}.pid`);
    this.logFile = path.join(os.tmpdir(), `pepe-openvpn-${Date.now()}.log`);

    // username/password 가 있으면 임시 파일 (admin 으로 spawn 되는 openvpn 이 읽음) — 메모리 only 가 이상적이지만 --auth-user-pass 가 파일을 요구
    let authFile: string | null = null;
    if (opts?.username) {
      authFile = path.join(os.tmpdir(), `pepe-openvpn-auth-${Date.now()}`);
      fs.writeFileSync(authFile, `${opts.username}\n${opts.password || ''}\n`, { mode: 0o600 });
    }

    const bin = avail.binaryPath!;
    const argsArr = [
      '--config', configPath,
      '--management', '127.0.0.1', String(this.mgmtPort),
      '--management-hold',
      // --management-query-passwords 는 제거 — auth-user-pass 가 있을 때 openvpn 이 management
      // 응답을 추가로 기다려서 hang 됨. --auth-user-pass <file> 만으로 충분.
      '--writepid', this.pidFile,
      // --log 제거 — management 'log on all' 이 동일 로그 스트림 (중복 방지)
      '--verb', '3',
      // 서버가 OpenVPN 2.7 미지원 syntax "route add ..." 로 push 하는 경우 — OpenVPN 2.7 이 parse 실패 후
      // TEST ROUTES 루프에 빠짐. 잘못된 라인을 미리 ignore 해서 stuck 회피.
      // (정상 syntax "route 1.2.3.0 255.255.255.0 [gw]" 는 영향 없음)
      '--pull-filter', 'ignore', 'route add',
    ];
    // (한때 --route-method exe / --ip-win32 netsh 추가했으나 OpenVPN 2.7 의 ovpn-dco 드라이버와
    //  충돌해 "NETSH: command failed" 발생. 제거 — DCO 가 자체 IP/라우팅 처리하도록 openvpn 기본값 사용.)
    // OpenVPN 2.7 의 ovpn-dco 드라이버 명시 사용 — DHCP 거치지 않고 직접 IP 설정. TAP-Windows 의
    // APIPA fallback 이슈 회피. .ovpn 에 `windows-driver wintun` 같은 명시가 없으면 DCO 우선.
    if (process.platform === 'win32') {
      argsArr.push('--windows-driver', 'ovpn-dco');
    }
    if (authFile) argsArr.push('--auth-user-pass', authFile);

    // sudo-prompt 로 admin 권한 spawn — 매 연결마다 UAC 1회. 단순/안정 우선.
    // 같은 admin 세션 안에서 좀비 openvpn.exe 먼저 정리 → 새 openvpn 실행. TAP 어댑터 점유 해제.
    this.addLog('[startup] sudo-prompt 로 elevated spawn (연결마다 UAC 1회)');
    this.addLog(`[startup] openvpn.exe 경로: ${bin}`);  // 어느 바이너리가 실제로 spawn 되는지 확인용
    const quote = (s: string) => process.platform === 'win32' ? `"${s}"` : `'${s.replace(/'/g, "'\\''")}'`;
    const opvCmd = [bin, ...argsArr].map(quote).join(' ');
    // Windows: cmd `&` 로 명령 체이닝. taskkill 실패해도 (좀비 없음) 진행.
    // Mac/Linux: pkill 사용 — 마찬가지로 fail-soft.
    const cleanupCmd = process.platform === 'win32'
      ? `taskkill /F /IM openvpn.exe >nul 2>&1 & ${opvCmd}`
      : `pkill -f openvpn 2>/dev/null; ${opvCmd}`;
    const cmd = cleanupCmd;
    sudo.exec(cmd, { name: 'PePe Terminal SSH' }, (err: any, stdout: any, stderr: any) => {
      const out = (stdout?.toString?.() || '') + (stderr?.toString?.() || '');
      if (out) this.addLog('[exit] ' + out.trim());
      if (err) {
        const msg = String(err.message || err);
        const isUacCancel = /did not grant permission|user.*cancelled|user.*denied/i.test(msg);
        if (this.state.status === 'starting') {
          if (isUacCancel) {
            // UAC 취소는 에러가 아니라 일반 disconnected 로 — 다음 시도 깨끗하게
            this.addLog('[startup] UAC 권한 요청 취소됨 — 연결 시도 종료');
            this.setState({ status: 'disconnected', assignedIp: undefined, connectedSince: undefined, lastError: undefined });
          } else {
            this.setState({ status: 'error', lastError: '권한 상승 실패: ' + msg });
          }
        }
      }
      if (authFile && fs.existsSync(authFile)) try { fs.unlinkSync(authFile); } catch {}
      this.stopMonitoring();
      if (this.state.status !== 'error' && this.state.status !== 'disconnected') {
        this.setState({ status: 'disconnected', assignedIp: undefined, connectedSince: undefined });
      }
    });

    // openvpn 이 management 소켓 listen 할 때까지 폴링 (최대 90초)
    setTimeout(() => this.connectMgmt(), 800);
    return { ok: true };
  }

  private connectMgmt(retry = 0) {
    // 연결 시도가 이미 취소/실패 처리된 상태면 재시도 중단 (UAC 거부 등으로 sudo.exec 가 일찍 끝난 경우)
    if (this.state.status === 'disconnected' || this.state.status === 'error') return;
    // 처음 200회까진 100ms 간격 (빠른 응답), 그 후 500ms (UAC 늦게 클릭 등 긴 대기용)
    // 최대 ~110초 대기 가능
    const MAX_RETRY = 400;
    if (retry > MAX_RETRY) {
      // 실패 원인 추정 — pidFile 존재 여부로 openvpn 이 실제 시작됐는지 판단
      const pidExists = this.pidFile && fs.existsSync(this.pidFile);
      const reason = pidExists
        ? `management 소켓 (127.0.0.1:${this.mgmtPort}) 연결 실패 — openvpn 은 떠 있는데 포트 응답 없음. 방화벽 확인.`
        : `openvpn 프로세스가 시작되지 않음 — UAC 거부했거나 바이너리/드라이버 문제. 로그 패널 [exit] 항목 확인.`;
      this.addLog(`[management] ${reason}`);
      this.setState({ status: 'error', lastError: reason });
      return;
    }
    // 초반 빠른 폴링 (openvpn 평소 1~2초 안에 management 소켓 listen 시작), 후반 느린 폴링 (UAC 지연 대비)
    const delayMs = retry < 200 ? 100 : 500;

    const s = net.createConnection({ host: '127.0.0.1', port: this.mgmtPort });
    let resolved = false;
    s.on('connect', () => {
      resolved = true;
      this.mgmtSock = s;
      this.mgmtBuf = '';
      if (retry > 0) this.addLog(`[management] 연결 성공 (시도 ${retry + 1})`);
      // 순서 중요: subscriptions 먼저 설정 → 마지막에 hold release. 명령마다 약간 지연 (2.7 RC 가 동시 처리 약함)
      const cmds = ['state on', 'log on all', 'bytecount 2', 'hold release'];
      let i = 0;
      const sendNext = () => {
        if (i >= cmds.length) return;
        this.send(cmds[i] + '\n');
        this.addLog(`[mgmt-send] ${cmds[i]}`);
        i++;
        setTimeout(sendNext, 100);
      };
      sendNext();
      this.setState({ status: 'connecting' });
      // 파일 tail 비활성 — management 'log on all' 이 동일 로그를 실시간 스트림하므로 중복 방지
      // (예전엔 fallback 으로 켰는데 management 가 잘 작동하므로 불필요)
      // this.startLogTail();
    });
    s.on('data', (chunk: Buffer) => this.onMgmtData(chunk.toString('utf-8')));
    s.on('close', () => {
      if (this.mgmtSock === s) this.mgmtSock = null;
    });
    s.on('error', () => {
      if (resolved) return; // 이미 연결 후 끊김은 별도
      // 진행 상황 가끔 알려줌 (스팸 방지)
      if (retry > 0 && retry % 20 === 0) this.addLog(`[management] 연결 대기 중... (${retry * delayMs / 1000}초 경과)`);
      setTimeout(() => this.connectMgmt(retry + 1), delayMs);
    });
  }

  private send(cmd: string) {
    try { this.mgmtSock?.write(cmd); } catch {}
  }

  private onMgmtData(s: string) {
    this.mgmtBuf += s;
    let idx;
    while ((idx = this.mgmtBuf.indexOf('\n')) >= 0) {
      const line = this.mgmtBuf.slice(0, idx).replace(/\r$/, '');
      this.mgmtBuf = this.mgmtBuf.slice(idx + 1);
      this.parseMgmtLine(line);
    }
  }

  private parseMgmtLine(line: string) {
    if (!line) return;
    // State: ">STATE:timestamp,state,desc,localIp,remoteIp"
    if (line.startsWith('>STATE:')) {
      const parts = line.slice(7).split(',');
      const st = parts[1];
      const desc = parts[2];
      const localIp = parts[3];
      if (st === 'CONNECTED') {
        const patch: any = { status: 'connected', assignedIp: localIp || undefined, connectedSince: Date.now() };
        // description 이 ERROR/non-empty 면 부분 성공 — lastError 에 경고 메모
        if (desc && desc !== 'SUCCESS' && desc !== '') {
          patch.lastError = `연결됨 (경고: ${desc}) — TLS/터널은 동작하나 Windows DHCP/라우팅 자동 설정 일부 실패. ipconfig 로 어댑터 확인 권장.`;
          this.addLog(`[warning] CONNECTED 상태이나 description=${desc} — DHCP 클라이언트 서비스 / 라우팅 자동화 이슈 가능`);
        } else {
          patch.lastError = undefined;
        }
        this.setState(patch);
      } else if (st === 'AUTH') {
        this.setState({ status: 'auth' });
      } else if (st === 'WAIT' || st === 'TCP_CONNECT' || st === 'RESOLVE' || st === 'GET_CONFIG' || st === 'ASSIGN_IP') {
        this.setState({ status: 'connecting' });
      } else if (st === 'RECONNECTING') {
        this.setState({ status: 'reconnecting' });
      } else if (st === 'EXITING') {
        this.setState({ status: 'disconnected' });
      }
    } else if (line.startsWith('>BYTECOUNT:')) {
      const [inB, outB] = line.slice(11).split(',').map(Number);
      this.setState({ bytesIn: inB, bytesOut: outB });
    } else if (line.startsWith('>LOG:')) {
      // ">LOG:timestamp,flags,message"
      const tail = line.slice(5);
      const firstComma = tail.indexOf(',');
      const secondComma = tail.indexOf(',', firstComma + 1);
      const msg = secondComma >= 0 ? tail.slice(secondComma + 1) : tail;
      this.addLog(msg);
    } else if (line.startsWith('>PASSWORD:')) {
      // 비밀번호 필요. 로그에도 명시적으로 표시 (사용자가 hang 원인 파악 가능)
      this.addLog(`[auth] ${line}`);
      this.addLog('[auth] openvpn 이 자격증명 대기 중. "사용자/비밀번호 입력 후 연결" 버튼 사용하세요. (자동 입력 모달은 추후 구현)');
      this.emit('passwordRequired', line);
    } else if (line.startsWith('SUCCESS:') || line.startsWith('ERROR:')) {
      // 명령 응답 — 진단용으로 로그
      this.addLog(`[mgmt-resp] ${line}`);
    } else if (line.startsWith('>FATAL:')) {
      this.setState({ status: 'error', lastError: line.slice(7) });
    }
  }

  private stopMonitoring() {
    try { this.mgmtSock?.end(); } catch {}
    this.mgmtSock = null;
    if (this.logTailTimer) { clearInterval(this.logTailTimer); this.logTailTimer = null; }
    if (this.bytecountTimer) { clearInterval(this.bytecountTimer); this.bytecountTimer = null; }
    if (this.pidFile && fs.existsSync(this.pidFile)) try { fs.unlinkSync(this.pidFile); } catch {}
    if (this.logFile && fs.existsSync(this.logFile)) try { fs.unlinkSync(this.logFile); } catch {}
    this.pidFile = null;
    this.logFile = null;
  }

  async disconnect(): Promise<{ ok: boolean }> {
    if (this.state.status === 'disconnected') return { ok: true };
    // 1) management 채널로 graceful shutdown — 소켓이 떠 있을 때만 동작
    this.send('signal SIGTERM\n');
    const pidFile = this.pidFile;
    this.setState({ status: 'disconnected', assignedIp: undefined, connectedSince: undefined });
    // 2) 8초 뒤 강제 종료 fallback. openvpn 의 TAP/DHCP 정리에 보통 2~5초 걸리므로 충분히 기다림.
    //    sudo.exec exit callback 이 stopMonitoring 호출하며 this.pidFile = null 로 셋팅함.
    //    따라서 this.pidFile === null 이면 이미 정상 종료된 것 → 강제 종료 불필요 (UAC 안 뜸).
    setTimeout(() => {
      try {
        if (this.pidFile === null) return; // 이미 sudo.exec 콜백에서 정상 종료 처리됨
        if (!pidFile || !fs.existsSync(pidFile)) return; // pid 파일 없으면 죽은 것
        const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
        if (pid && Number.isFinite(pid)) {
          this.addLog(`[disconnect] graceful shutdown 8초 후에도 PID ${pid} 살아있음 — 강제 종료 (UAC)`);
          const cmd = process.platform === 'win32' ? `taskkill /F /PID ${pid}` : `kill -9 ${pid}`;
          sudo.exec(cmd, { name: 'PePe Terminal SSH' }, () => {});
        }
      } catch {}
    }, 8000);
    return { ok: true };
  }
}

let _svc: VpnService | null = null;
export function getVpnService(): VpnService {
  if (!_svc) _svc = new VpnService();
  return _svc;
}
