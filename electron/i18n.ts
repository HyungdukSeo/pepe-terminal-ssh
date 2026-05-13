// electron/i18n.ts
// Main-process i18n — renderer 의 react-i18next 와 별개로 main 에서도 사용자 가시 문자열을 번역.
// 단일 namespace ('electronMain') 가정. ko/en 번들을 동기 로드하고 ui-prefs.appLang 으로 현재 언어를 결정.
// 보간: {{var}} 형태 (i18next 호환). 미스 키는 키 자체를 반환.
import { loadBundledNamespace, loadNamespace } from './i18nStore';
import { loadUIPrefs, saveUIPrefs } from './sessionsStore';

const NS = 'electronMain';
const FALLBACK_LANG = 'en';
const DEFAULT_LANG = 'ko';

let currentLang: string | null = null;
const bundleCache = new Map<string, Record<string, string>>();

function loadBundle(lang: string): Record<string, string> {
  const cached = bundleCache.get(lang);
  if (cached) return cached;
  let bundle: Record<string, string> = {};
  // loadNamespace 는 app 객체에 의존 — 호출 시점에 app 이 준비되지 않았으면 예외 가능. 안전 처리.
  try {
    bundle = loadNamespace(lang, NS);
  } catch {
    try { bundle = loadBundledNamespace(lang, NS); } catch { bundle = {}; }
  }
  bundleCache.set(lang, bundle);
  return bundle;
}

export function getCurrentLang(): string {
  if (currentLang) return currentLang;
  try {
    const prefs = loadUIPrefs();
    const v = prefs && typeof prefs.appLang === 'string' ? prefs.appLang : '';
    currentLang = v || DEFAULT_LANG;
  } catch {
    currentLang = DEFAULT_LANG;
  }
  return currentLang!;
}

export function setCurrentLang(lang: string) {
  if (!lang) return;
  currentLang = lang;
  bundleCache.delete(lang); // 핫리로드 — override 갱신 반영
  try { saveUIPrefs({ appLang: lang }); } catch {}
}

function interpolate(tmpl: string, vars?: Record<string, string | number>): string {
  if (!vars) return tmpl;
  return tmpl.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, k) => {
    const v = vars[k];
    return v === undefined || v === null ? '' : String(v);
  });
}

export function t(key: string, vars?: Record<string, string | number>): string {
  const lang = getCurrentLang();
  const b = loadBundle(lang);
  let val = b[key];
  if (val === undefined && lang !== FALLBACK_LANG) {
    const fb = loadBundle(FALLBACK_LANG);
    val = fb[key];
  }
  if (val === undefined) return key;
  return interpolate(val, vars);
}
