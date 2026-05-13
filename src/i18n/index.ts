// src/i18n/index.ts
// react-i18next 초기화 — main process IPC 로 namespace lazy load.
// 언어 변경 시 localStorage('vpn-app:lang') 저장, 다음 실행에서 자동 복원.
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

const api = (window as any).api || {};

const LANG_KEY = 'app:lang';
function detectInitialLang(): string {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved) return saved;
  } catch {}
  // OS locale 폴백 — navigator.language → "ko" 또는 "en-US"
  const nav = (navigator.language || 'ko').split('-')[0];
  return nav;
}

// Custom backend — i18next 가 ns 처음 사용 시 호출
const ipcBackend = {
  type: 'backend' as const,
  init() {},
  read: async (lang: string, ns: string, callback: (err: any, data?: any) => void) => {
    try {
      const data = await api.i18nLoad?.(lang, ns);
      callback(null, data || {});
    } catch (err: any) {
      callback(err, {});
    }
  },
};

i18n
  .use(ipcBackend as any)
  .use(initReactI18next)
  .init({
    lng: detectInitialLang(),
    fallbackLng: 'en',
    ns: ['common'],
    defaultNS: 'common',
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
    partialBundledLanguages: true,
    saveMissing: false,
  });

export function setLanguage(lang: string) {
  try { localStorage.setItem(LANG_KEY, lang); } catch {}
  i18n.changeLanguage(lang);
  try { api.i18nSetLang?.(lang); } catch {}
}

export function getCurrentLanguage(): string {
  return i18n.language || 'ko';
}

// 편집기에서 저장한 후 i18next 캐시 무효화 + 리로드 트리거용
export async function reloadNamespace(lang: string, ns: string) {
  await i18n.reloadResources(lang, ns);
}

export default i18n;
