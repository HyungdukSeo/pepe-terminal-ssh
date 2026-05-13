// electron/i18nStore.ts
// 다국어 리소스 관리 — 번들 기본값 + 사용자 오버라이드 머지.
// 번들 위치: dev = <repo>/resources/i18n/<lang>/<ns>.json, prod = <resourcesPath>/i18n/<lang>/<ns>.json
// 오버라이드: <userData>/i18n/<lang>/<ns>.json
// 머지 정책: 사용자 오버라이드가 우선. 키 단위로 override.
import fs from 'fs';
import path from 'path';
import { app } from 'electron';

function bundledDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'i18n')
    : path.join(process.cwd(), 'resources', 'i18n');
}
function overrideDir(): string {
  return path.join(app.getPath('userData'), 'i18n');
}

function safeReadJson(p: string): Record<string, any> {
  try {
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf-8')) || {};
  } catch { return {}; }
}

function listLangDir(dir: string): string[] {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  } catch { return []; }
}

// 모든 가용 언어 코드 (번들 + 사용자 오버라이드 union)
export function listLanguages(): string[] {
  const a = new Set([...listLangDir(bundledDir()), ...listLangDir(overrideDir())]);
  return Array.from(a).sort();
}

// 특정 언어의 모든 namespace 목록
export function listNamespaces(lang: string): string[] {
  const namesB = listFilesAsNamespaces(path.join(bundledDir(), lang));
  const namesO = listFilesAsNamespaces(path.join(overrideDir(), lang));
  return Array.from(new Set([...namesB, ...namesO])).sort();
}
function listFilesAsNamespaces(dir: string): string[] {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));
  } catch { return []; }
}

// 특정 언어+namespace 의 머지된 키/값 (번들 + 오버라이드 시뮬레이트)
export function loadNamespace(lang: string, ns: string): Record<string, string> {
  const bundled = safeReadJson(path.join(bundledDir(), lang, `${ns}.json`));
  const overrideP = path.join(overrideDir(), lang, `${ns}.json`);
  const override = safeReadJson(overrideP);
  return { ...flatten(bundled), ...flatten(override) };
}

// 번들 기본값만 (override 제외) — 편집기에서 "기본값으로 복원" 비교용
export function loadBundledNamespace(lang: string, ns: string): Record<string, string> {
  return flatten(safeReadJson(path.join(bundledDir(), lang, `${ns}.json`)));
}

// override 만 (편집기 입력값 영속)
export function loadOverrideNamespace(lang: string, ns: string): Record<string, string> {
  return flatten(safeReadJson(path.join(overrideDir(), lang, `${ns}.json`)));
}

export function saveOverrideNamespace(lang: string, ns: string, kv: Record<string, string>): { ok: boolean; error?: string } {
  try {
    const dir = path.join(overrideDir(), lang);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${ns}.json`), JSON.stringify(unflatten(kv), null, 2), 'utf-8');
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) };
  }
}

// nested object → flat "a.b.c" 키
function flatten(obj: any, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  for (const k of Object.keys(obj || {})) {
    const v = obj[k];
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = String(v);
  }
  return out;
}
function unflatten(flat: Record<string, string>): any {
  const out: any = {};
  for (const k of Object.keys(flat)) {
    const parts = k.split('.');
    let cur = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {};
      cur = cur[p];
    }
    cur[parts[parts.length - 1]] = flat[k];
  }
  return out;
}

export function addLanguage(lang: string): { ok: boolean; error?: string } {
  if (!/^[a-zA-Z][\w-]*$/.test(lang)) return { ok: false, error: '언어 코드 형식 오류 (예: ja, zh-CN)' };
  try {
    const dir = path.join(overrideDir(), lang);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return { ok: true };
  } catch (err: any) { return { ok: false, error: String(err?.message || err) }; }
}

export function removeLanguage(lang: string): { ok: boolean; error?: string } {
  // 번들 언어는 삭제 불가
  if (listLangDir(bundledDir()).includes(lang)) return { ok: false, error: '번들 언어는 삭제할 수 없음 (오버라이드만 가능)' };
  try {
    const dir = path.join(overrideDir(), lang);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
    return { ok: true };
  } catch (err: any) { return { ok: false, error: String(err?.message || err) }; }
}
