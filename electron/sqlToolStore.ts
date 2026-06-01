// electron/sqlToolStore.ts
//
// Per-session persistence for SQL Tool (history, favorites, editor tabs).
// Replaces the renderer's localStorage usage with main-process JSON files
// under <userData>/sql-tool/<sessionId>.json — keeps the renderer free of
// `localStorage` (memory rule) and lets the data survive Electron upgrades
// without renderer-side migration tricks.

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

export interface SqlToolSessionState {
  history?: any[];
  favorites?: any[];
  editorTabs?: any[];
}

function statePath(sessionId: string): string {
  const dir = path.join(app.getPath('userData'), 'sql-tool');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  // sessionId 가 파일명 안전한 형태가 아니면 sanitize.
  const safe = sessionId.replace(/[^A-Za-z0-9_.\-]/g, '_');
  return path.join(dir, `${safe}.json`);
}

export function getSessionState(sessionId: string): SqlToolSessionState {
  try {
    const p = statePath(sessionId);
    if (!fs.existsSync(p)) return {};
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}

export function setSessionState(sessionId: string, partial: SqlToolSessionState): SqlToolSessionState {
  const cur = getSessionState(sessionId);
  const next: SqlToolSessionState = { ...cur };
  if (partial.history !== undefined)    next.history    = partial.history;
  if (partial.favorites !== undefined)  next.favorites  = partial.favorites;
  if (partial.editorTabs !== undefined) next.editorTabs = partial.editorTabs;
  try {
    fs.writeFileSync(statePath(sessionId), JSON.stringify(next, null, 2), 'utf8');
  } catch (err: any) {
    console.warn('[sql-tool] persist failed:', err?.message || err);
  }
  return next;
}
