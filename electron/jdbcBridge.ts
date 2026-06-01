// electron/jdbcBridge.ts
//
// Manages the Java sidecar process that holds JDBC connections.
//
// E-2.2 scope: a single shared sidecar (per Electron process) + ping. Per-session
// sidecars and connection plumbing land in E-4. The ping RPC is exposed via
// `jdbc:ping` IPC for the Driver Manager diagnostic UI.

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export type JdbcRpcResponse = {
  id?: number | string | null;
  result?: any;
  error?: { code: string; message: string };
};

const JAVA_EXE = process.platform === 'win32' ? 'java.exe' : 'java';

// Find an executable `java` — production first (bundled JRE under resourcesPath),
// then JAVA_HOME, then bare PATH lookup. Returns the resolved path; callers will
// still receive ENOENT from spawn if the final fallback also fails.
export function findJavaExecutable(): string {
  const tryPath = (p: string) => fs.existsSync(p) ? p : null;
  const cands: (string | null)[] = [];

  // 1) bundled JRE shipped via electron-builder extraResources → resources/jre
  if (process.resourcesPath) {
    if (process.platform === 'darwin') {
      cands.push(path.join(process.resourcesPath, 'jre', 'Contents', 'Home', 'bin', JAVA_EXE));
    }
    cands.push(path.join(process.resourcesPath, 'jre', 'bin', JAVA_EXE));
  }
  // 2) JAVA_HOME
  if (process.env.JAVA_HOME) {
    cands.push(path.join(process.env.JAVA_HOME, 'bin', JAVA_EXE));
  }

  for (const c of cands) {
    const r = c ? tryPath(c) : null;
    if (r) return r;
  }
  // 3) bare name — relies on PATH
  return JAVA_EXE;
}

// Locate pepe-jdbc.jar — production (process.resourcesPath/jdbc-sidecar) first,
// then a dev fallback (sibling resources/ next to dist-electron). Returns null
// if not found.
export function findSidecarJar(): string | null {
  const cands: string[] = [];
  if (process.resourcesPath) cands.push(path.join(process.resourcesPath, 'jdbc-sidecar', 'pepe-jdbc.jar'));
  cands.push(path.resolve(__dirname, '..', 'resources', 'jdbc-sidecar', 'pepe-jdbc.jar'));
  cands.push(path.resolve(process.cwd(), 'resources', 'jdbc-sidecar', 'pepe-jdbc.jar'));
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

class JdbcSidecar {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number | string, Pending>();
  private buffer = '';
  private starting: Promise<void> | null = null;

  isRunning(): boolean { return !!this.proc && !this.proc.killed; }

  async ensureStarted(): Promise<void> {
    if (this.isRunning()) return;
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async start(): Promise<void> {
    const jar = findSidecarJar();
    if (!jar) throw new Error('pepe-jdbc.jar not found — run `npm run build:sidecar`');
    const java = findJavaExecutable();
    console.log(`[jdbc] starting sidecar: "${java}" -jar "${jar}"`);

    const proc = spawn(java, ['-Xms32m', '-Xmx256m', '-jar', jar], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;

    proc.stdout!.setEncoding('utf8');
    proc.stdout!.on('data', (chunk: string) => this.absorbStdout(chunk));
    proc.stderr!.setEncoding('utf8');
    proc.stderr!.on('data', (chunk: string) => {
      const s = String(chunk).replace(/\s+$/, '');
      if (s) console.log(`[jdbc:stderr] ${s}`);
    });
    proc.on('exit', (code, sig) => {
      console.log(`[jdbc] sidecar exited code=${code} sig=${sig}`);
      this.rejectAllPending(new Error(`sidecar exited (code=${code}, sig=${sig})`));
      this.proc = null;
    });
    proc.on('error', (err) => {
      console.error('[jdbc] sidecar process error:', err);
      this.rejectAllPending(err);
      this.proc = null;
    });

    // Give the JVM a moment to start; the first call() will await proper
    // round-trip anyway. If the process dies during startup, the exit handler
    // above already reports it.
    await new Promise((r) => setTimeout(r, 60));
  }

  private absorbStdout(chunk: string) {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '').trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.handleLine(line);
    }
  }

  private handleLine(line: string) {
    let resp: JdbcRpcResponse;
    try { resp = JSON.parse(line); }
    catch (e) {
      console.warn('[jdbc] non-JSON line ignored:', line.slice(0, 200));
      return;
    }
    const id = resp.id as number | string | null | undefined;
    if (id === undefined || id === null) return; // notifications not used yet
    const p = this.pending.get(id);
    if (!p) {
      console.warn('[jdbc] unknown response id:', id);
      return;
    }
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (resp.error) p.reject(new Error(`${resp.error.code}: ${resp.error.message}`));
    else p.resolve(resp.result);
  }

  private rejectAllPending(err: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      try { p.reject(err); } catch {}
    }
    this.pending.clear();
  }

  async call(method: string, params?: any, timeoutMs = 10000): Promise<any> {
    await this.ensureStarted();
    if (!this.isRunning()) throw new Error('jdbc sidecar not running');
    const id = this.nextId++;
    const req = JSON.stringify({ id, method, params: params ?? null });
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`jdbc rpc timeout (${method})`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc!.stdin!.write(req + '\n', (err) => {
          if (err) {
            this.pending.delete(id);
            clearTimeout(timer);
            reject(err);
          }
        });
      } catch (e: any) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  close() {
    if (!this.proc) return;
    try { this.proc.stdin?.end(); } catch {}
    try { this.proc.kill(); } catch {}
    this.proc = null;
  }
}

let sharedSidecar: JdbcSidecar | null = null;

export function getSharedJdbcSidecar(): JdbcSidecar {
  if (!sharedSidecar) sharedSidecar = new JdbcSidecar();
  return sharedSidecar;
}

export function shutdownAllJdbcSidecars() {
  if (sharedSidecar) { sharedSidecar.close(); sharedSidecar = null; }
}
