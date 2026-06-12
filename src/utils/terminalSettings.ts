// src/utils/terminalSettings.ts

export type TerminalSettings = {
  autoCopyOnSelect: boolean;
  includeTrailingNewline: boolean;
  trimTrailingWhitespace: boolean;
  multiLinePaste: 'dialog' | 'direct';
  // 여러 줄 붙여넣기 창이 떠 있을 때 다시 붙여넣으면: true=기존 내용에 누적, false=새 내용으로 교체
  multiLinePasteAccumulate: boolean;
  scrollback: number;
  aiAgent: 'claude' | 'gemini' | 'codex';
};

const DEFAULTS: TerminalSettings = {
  autoCopyOnSelect: true,
  includeTrailingNewline: false,
  trimTrailingWhitespace: true,
  multiLinePaste: 'dialog',
  multiLinePasteAccumulate: false,
  scrollback: 10000,
  aiAgent: 'claude',
};

let cached: TerminalSettings | null = null;

export function getTerminalSettings(): TerminalSettings {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem('terminalSettings');
    if (raw) { cached = { ...DEFAULTS, ...JSON.parse(raw) }; return cached!; }
  } catch {}
  cached = { ...DEFAULTS };
  return cached;
}

export function saveTerminalSettings(s: TerminalSettings) {
  cached = { ...s };
  localStorage.setItem('terminalSettings', JSON.stringify(s));
}
