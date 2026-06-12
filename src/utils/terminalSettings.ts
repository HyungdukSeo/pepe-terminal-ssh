// src/utils/terminalSettings.ts

// 마우스 단추 동작 — 'none'(아무것도 안 함) / 'menu'(팝업 메뉴) / 'paste'(클립보드 붙여넣기)
// 'properties'(옵션 대화상자) / 'enter'(캐리지 리턴 전송) / 'paste-selection'(선택 텍스트 붙여넣기)
export type MouseButtonAction = 'none' | 'menu' | 'paste' | 'properties' | 'enter' | 'paste-selection';

export type TerminalSettings = {
  autoCopyOnSelect: boolean;
  includeTrailingNewline: boolean;
  trimTrailingWhitespace: boolean;
  multiLinePaste: 'dialog' | 'direct';
  // 여러 줄 붙여넣기 창이 떠 있을 때 다시 붙여넣으면: true=기존 내용에 누적, false=새 내용으로 교체
  multiLinePasteAccumulate: boolean;
  // 마우스 버튼 동작
  rightClickAction: MouseButtonAction;   // 오른쪽 단추
  middleClickAction: MouseButtonAction;  // 가운데 단추
  scrollback: number;
  aiAgent: 'claude' | 'gemini' | 'codex';
};

const DEFAULTS: TerminalSettings = {
  autoCopyOnSelect: true,
  includeTrailingNewline: false,
  trimTrailingWhitespace: true,
  multiLinePaste: 'dialog',
  multiLinePasteAccumulate: false,
  rightClickAction: 'menu',
  middleClickAction: 'none',
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
