// src/components/TranslationEditor.tsx
// 다국어 번역 편집 워크스페이스 — Excel 스타일 테이블.
// 행: 번역 키 (선택된 namespace 내)
// 열: 언어들 (번들 + 사용자 추가)
// 셀: 인라인 편집. 저장 시 userData/i18n/<lang>/<ns>.json 에 오버라이드 기록.
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { reloadNamespace, setLanguage, getCurrentLanguage } from '../i18n';
import { searchLanguages } from './languageCodes';
import { notifyConfirm } from './Notify';

const api = (window as any).api || {};

type AgentType = 'claude' | 'gemini' | 'codex';
export const TranslationEditor: React.FC<{ aiAgent?: AgentType }> = ({ aiAgent = 'claude' }) => {
  const { t } = useTranslation('translationEditor');
  const [languages, setLanguages] = useState<string[]>([]);
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [currentNs, setCurrentNs] = useState<string>('');
  // table[lang][key] = value. 화면에 보이는 keys 는 모든 언어의 키 union.
  const [table, setTable] = useState<Record<string, Record<string, string>>>({});
  const [dirty, setDirty] = useState<Record<string, boolean>>({});  // lang → 변경됨
  const [filter, setFilter] = useState('');
  const [newLangCode, setNewLangCode] = useState('');
  const [showLangPicker, setShowLangPicker] = useState(false);
  const [langPickerQ, setLangPickerQ] = useState('');
  const [status, setStatus] = useState('');
  const [activeLang, setActiveLang] = useState<string>(getCurrentLanguage());
  const agentLabel = aiAgent === 'gemini' ? 'Gemini' : aiAgent === 'codex' ? 'Codex' : 'Claude';

  // en, ko 를 앞에, 나머지는 추가된 순서대로 (api 가 반환하는 순서 그대로) 정렬
  const sortLanguages = (arr: string[]): string[] => {
    const priority = ['en', 'ko'];
    const head = priority.filter(p => arr.includes(p));
    const rest = arr.filter(l => !priority.includes(l));
    return [...head, ...rest];
  };

  // 언어 목록 + namespace 목록 로드
  const refreshLangs = useCallback(async () => {
    const langsRaw: string[] = await api.i18nListLanguages?.() || [];
    const langs = sortLanguages(langsRaw);
    setLanguages(langs);
    if (langs.length > 0) {
      const namesArr: string[] = await api.i18nListNamespaces?.(langs[0]) || [];
      setNamespaces(namesArr);
      if (namesArr.length > 0 && !currentNs) setCurrentNs(namesArr[0]);
    }
  }, [currentNs]);

  useEffect(() => { refreshLangs(); }, [refreshLangs]);

  // 현재 namespace 의 모든 언어 데이터 로드
  const reloadTable = useCallback(async (ns: string) => {
    if (!ns) return;
    const tbl: Record<string, Record<string, string>> = {};
    for (const lang of languages) {
      try {
        tbl[lang] = await api.i18nLoad?.(lang, ns) || {};
      } catch { tbl[lang] = {}; }
    }
    setTable(tbl);
    setDirty({});
  }, [languages]);

  useEffect(() => { reloadTable(currentNs); }, [currentNs, reloadTable]);

  const allKeys = useMemo(() => {
    const s = new Set<string>();
    for (const lang of languages) for (const k of Object.keys(table[lang] || {})) s.add(k);
    const arr = Array.from(s).sort();
    if (!filter.trim()) return arr;
    const q = filter.trim().toLowerCase();
    return arr.filter(k => {
      if (k.toLowerCase().includes(q)) return true;
      for (const lang of languages) {
        const v = (table[lang]?.[k] || '').toLowerCase();
        if (v.includes(q)) return true;
      }
      return false;
    });
  }, [table, languages, filter]);

  const onCellChange = (lang: string, key: string, value: string) => {
    setTable(prev => ({ ...prev, [lang]: { ...(prev[lang] || {}), [key]: value } }));
    setDirty(prev => ({ ...prev, [lang]: true }));
  };

  const saveLanguage = useCallback(async (lang: string) => {
    const r = await api.i18nSaveOverride?.(lang, currentNs, table[lang] || {});
    if (r?.ok) {
      await reloadNamespace(lang, currentNs);
      setDirty(prev => ({ ...prev, [lang]: false }));
      setStatus(t('saveOk', { lang, ns: currentNs }));
      setTimeout(() => setStatus(''), 2500);
    } else {
      setStatus(t('saveError', { error: r?.error || 'unknown' }));
    }
  }, [currentNs, table]);

  const saveAll = useCallback(async () => {
    for (const lang of Object.keys(dirty)) {
      if (dirty[lang]) await saveLanguage(lang);
    }
  }, [dirty, saveLanguage]);

  const addLanguage = useCallback(async () => {
    const code = newLangCode.trim();
    if (!code) return;
    const r = await api.i18nAddLanguage?.(code);
    if (r?.ok) {
      setNewLangCode('');
      await refreshLangs();
      setStatus(t('addLangOk', { code }));
      setTimeout(() => setStatus(''), 3500);
    } else {
      setStatus(t('addLangError', { error: r?.error || 'unknown' }));
    }
  }, [newLangCode, refreshLangs]);

  const removeLanguage = useCallback(async (lang: string) => {
    if (!await notifyConfirm(t('removeLangTitle') || '언어 제거', t('removeLangConfirm', { lang }))) return;
    const r = await api.i18nRemoveLanguage?.(lang);
    if (r?.ok) {
      await refreshLangs();
      setStatus(t('removeLangOk', { lang }));
      setTimeout(() => setStatus(''), 2500);
    } else {
      setStatus(t('removeLangError', { error: r?.error || 'unknown' }));
    }
  }, [refreshLangs]);

  const [translatingLang, setTranslatingLang] = useState<string>('');
  const translateDisposeRef = useRef<(() => void) | null>(null);
  const baseLang = languages[0] || 'ko';

  const autoTranslate = useCallback(async (targetLang: string, mode: 'empty' | 'all') => {
    const baseItems = table[baseLang] || {};
    const tgtItems = table[targetLang] || {};
    const items: Record<string, string> = {};
    for (const k of Object.keys(baseItems)) {
      const src = baseItems[k];
      if (!src) continue;
      if (mode === 'empty' && tgtItems[k]) continue;
      items[k] = src;
    }
    if (Object.keys(items).length === 0) {
      setStatus(t('noItems'));
      setTimeout(() => setStatus(''), 2500);
      return;
    }

    try { translateDisposeRef.current?.(); } catch {}
    translateDisposeRef.current = null;

    setTranslatingLang(targetLang);
    setStatus(t('aiTranslating', { base: baseLang, target: targetLang, count: Object.keys(items).length }));

    const requestId = `i18ngen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const claudeSessionId = `i18n-editor-${currentNs}`;
    let collected = '';
    let finalized = false;

    const prompt =
      `${t('aiPromptIntro', { base: baseLang, target: targetLang })}\n` +
      `${t('aiPromptRules')}\n` +
      `${t('aiPromptRuleKeys', { target: targetLang })}\n` +
      `${t('aiPromptRuleVars', { vars: '{{var}}' })}\n` +
      `${t('aiPromptRuleEmoji')}\n` +
      `${t('aiPromptRuleButtons')}\n` +
      `${t('aiPromptRuleJson')}\n\n` +
      `${t('aiPromptOrigin', { base: baseLang })}\n${JSON.stringify(items, null, 2)}`;

    const finish = (ok: boolean, errMsg?: string) => {
      if (finalized) return;
      finalized = true;
      if (!ok) setStatus(t('aiFailed', { error: errMsg || 'unknown' }));
      setTranslatingLang('');
      try { translateDisposeRef.current?.(); } catch {}
      translateDisposeRef.current = null;
    };

    const dispose = (window as any).api?.onClaudeStream?.((p: any) => {
      if (p.requestId !== requestId) return;
      const msg = p.message;
      if (!msg) return;
      if (msg.type === 'assistant' && msg.message?.content) {
        const texts = (msg.message.content as any[]).filter(c => c?.type === 'text').map(c => c.text || '').join('');
        if (texts) collected += texts;
      } else if (msg.type === 'text' && typeof msg.text === 'string') {
        collected += msg.text;
      } else if (msg.type === 'error' && !finalized) {
        finish(false, (msg.text || '').slice(0, 120));
      } else if ((msg.type === 'result' || msg.type === 'done') && !finalized) {
        const tryParse = (s: string): Record<string, string> | null => {
          if (!s) return null;
          // 1) BOM, zero-width, RTL marks, etc. 제거
          const base = s
            .replace(/﻿/g, '')
            .replace(/[​-‏‪-‮⁦-⁩]/g, '')
            .trim();
          // 1단계: 원본 그대로 파싱 (콘텐츠 안의 “…” 같은 따옴표 보존)
          try { return JSON.parse(base); } catch {}
          // 2단계: trailing comma 만 제거하고 재시도
          const noTrailComma = base.replace(/,(\s*[}\]])/g, '$1');
          try { return JSON.parse(noTrailComma); } catch {}
          // 3단계: smart quotes → straight quotes (최후 수단, 콘텐츠 깨질 위험)
          const stripped = noTrailComma.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
          try { return JSON.parse(stripped); } catch {}
          return null;
        };
        const candidates: string[] = [];
        const raw0 = collected.trim();
        // 모든 ```json ... ``` 블록 추출 + ``` ... ``` 일반 블록 + raw 전체 + 가장 외곽 {} 추출
        const blockRe = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/g;
        let m;
        while ((m = blockRe.exec(collected)) !== null) candidates.push(m[1].trim());
        candidates.push(raw0);
        const braceMatch = raw0.match(/\{[\s\S]*\}/);
        if (braceMatch) candidates.push(braceMatch[0]);
        let parsed: Record<string, string> | null = null;
        for (const c of candidates) {
          parsed = tryParse(c);
          if (parsed && typeof parsed === 'object') break;
        }
        if (!parsed || typeof parsed !== 'object') {
          console.warn('[i18n auto-translate] parse fail. Raw response:\n', collected);
          finish(false, t('aiParseFail') + ` (raw=${collected.length}자, 콘솔에 원본 출력)`);
          return;
        }
        const cleaned: Record<string, string> = {};
        for (const k of Object.keys(items)) {
          const v = (parsed as any)[k];
          if (typeof v === 'string') cleaned[k] = v;
        }
        setTable(prev => ({ ...prev, [targetLang]: { ...(prev[targetLang] || {}), ...cleaned } }));
        setDirty(prev => ({ ...prev, [targetLang]: true }));
        setStatus(t('aiDone', { filled: Object.keys(cleaned).length, total: Object.keys(items).length }));
        setTimeout(() => setStatus(''), 4000);
        finalized = true;
        setTranslatingLang('');
        try { translateDisposeRef.current?.(); } catch {}
        translateDisposeRef.current = null;
      }
    });
    translateDisposeRef.current = dispose || null;

    try {
      let r: any;
      if (aiAgent === 'gemini') {
        r = await (window as any).api?.geminiSend?.(claudeSessionId, prompt, requestId, undefined, true);
      } else if (aiAgent === 'codex') {
        r = await (window as any).api?.codexSend?.(claudeSessionId, prompt, requestId, undefined, 'full-auto');
      } else {
        r = await (window as any).api?.claudeSend?.(
          claudeSessionId, prompt, undefined, true, undefined, null, 'bypassPermissions', undefined, false, requestId,
        );
      }
      if (!r?.success) finish(false, r?.error || '?');
    } catch (e: any) {
      finish(false, e?.message || String(e));
    }
  }, [table, baseLang, currentNs, aiAgent]);

  useEffect(() => () => { try { translateDisposeRef.current?.(); } catch {} }, []);

  const applyLang = (lang: string) => {
    setActiveLang(lang);
    setLanguage(lang);
    setStatus(t('uiLangApplied', { lang }));
    setTimeout(() => setStatus(''), 2000);
  };

  // 테이블 가로 스크롤 컨테이너 ref — 언어 많을 때 horizontal scroll
  const scrollRef = useRef<HTMLDivElement | null>(null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', background: '#1a1a1a' }}>
      {/* 헤더 — namespace 선택 + 언어 추가 + 저장 + UI 언어 */}
      <div style={{ padding: '8px 12px', background: '#222', borderBottom: '1px solid #333', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: '#bbb' }}>{t('nsLabel')}</span>
          <select value={currentNs} onChange={e => setCurrentNs(e.target.value)} style={{ fontSize: 12 }}>
            {namespaces.map(ns => <option key={ns} value={ns}>{ns === 'claudeChat' ? 'AI Chat' : ns}</option>)}
          </select>
          <span style={{ width: 16 }} />
          <input type="text" value={filter} onChange={e => setFilter(e.target.value)} placeholder={t('filterPlaceholder')}
            onKeyDown={e => e.stopPropagation()}
            style={{ fontSize: 12, padding: '3px 6px', width: 220 }} />
          <span style={{ flex: 1 }} />
          <button onClick={saveAll} disabled={!Object.values(dirty).some(v => v)} className="primary"
            style={{ padding: '4px 12px', fontSize: 12 }}>
            {t('saveAll')}
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: '#bbb' }}>{t('currentUiLang')}</span>
          <select value={activeLang} onChange={e => applyLang(e.target.value)} style={{ fontSize: 12 }}>
            {languages.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
          <span style={{ width: 16 }} />
          <span style={{ fontSize: 12, color: '#bbb' }}>{t('currentAiService', { agent: agentLabel })}</span>
          <span style={{ width: 24 }} />
          <span style={{ fontSize: 12, color: '#bbb' }}>{t('addNewLang')}</span>
          <input type="text" value={newLangCode} onChange={e => setNewLangCode(e.target.value)}
            onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') addLanguage(); }}
            placeholder="ja, zh-CN, fr ..."
            style={{ fontSize: 12, padding: '3px 6px', width: 140 }} />
          <button onClick={addLanguage} disabled={!newLangCode.trim()} style={{ padding: '3px 10px', fontSize: 12 }}>{t('addBtn')}</button>
          <button onClick={() => { setShowLangPicker(true); setLangPickerQ(''); }} style={{ padding: '3px 10px', fontSize: 12 }} title={t('searchLangTitle')}>{t('searchLang')}</button>
          <span style={{ flex: 1 }} />
          {status && <span style={{ fontSize: 11, color: status.startsWith('✕') ? '#e36b6b' : '#7fcf6e' }}>{status}</span>}
        </div>
      </div>

      {/* 테이블 — Key + en 컬럼 가로 스크롤 고정 */}
      <div ref={scrollRef} style={{ flex: 1, minWidth: 0, minHeight: 0, overflowX: 'auto', overflowY: 'auto', background: '#161616' }}>
        <table style={{ borderCollapse: 'separate', borderSpacing: 0, fontSize: 11, tableLayout: 'fixed', width: (languages.length + 1) * 240 }}>
          <thead>
            <tr>
              <th style={{ padding: '6px 8px', borderRight: '1px solid #333', borderBottom: '1px solid #333', textAlign: 'left', color: '#888', minWidth: 240, width: 240, position: 'sticky', left: 0, top: 0, zIndex: 5, background: '#1c1c1c' }}>Key</th>
              {languages.map(lang => {
                const isEn = lang === 'en';
                const stickyStyle: React.CSSProperties = isEn
                  ? { position: 'sticky', left: 240, top: 0, zIndex: 5, background: '#1c1c1c' }
                  : { position: 'sticky', top: 0, zIndex: 4, background: '#1c1c1c' };
                return (
                <th key={lang} style={{ padding: '6px 8px', borderRight: '1px solid #333', borderBottom: '1px solid #333', textAlign: 'left', color: '#bbb', minWidth: 240, width: 240, ...stickyStyle }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span>{lang}{dirty[lang] && <span style={{ color: '#d8b556', marginLeft: 4 }}>●</span>}</span>
                      <span style={{ flex: 1 }} />
                      <button onClick={() => saveLanguage(lang)} disabled={!dirty[lang]} style={{ fontSize: 10, padding: '1px 5px' }}>{t('save')}</button>
                      {lang !== 'en' && (
                        <button onClick={() => removeLanguage(lang)} title={t('removeLang')} style={{ fontSize: 10, padding: '1px 5px', color: '#e36b6b' }}>✕</button>
                      )}
                    </div>
                    {lang !== baseLang && (() => {
                      const baseItems = table[baseLang] || {};
                      const tgtItems = table[lang] || {};
                      let emptyCount = 0;
                      for (const k of Object.keys(baseItems)) {
                        if (baseItems[k] && !tgtItems[k]) emptyCount++;
                      }
                      const noEmpty = emptyCount === 0;
                      return (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <button
                          onClick={() => autoTranslate(lang, 'empty')}
                          disabled={translatingLang === lang || noEmpty}
                          title={noEmpty ? t('noEmptyCells') : t('aiEmptyTitle', { base: baseLang })}
                          style={{ fontSize: 10, padding: '1px 5px', flex: 1, background: noEmpty ? '#2a2a2a' : '#2a4a6a', color: noEmpty ? '#666' : '#cde', border: `1px solid ${noEmpty ? '#333' : '#3a5a7a'}` }}>
                          {translatingLang === lang ? '...' : `${t('aiEmptyBtnWithAgent', { base: baseLang, target: lang, agent: agentLabel })}${noEmpty ? '' : ` (${emptyCount})`}`}
                        </button>
                        <button
                          onClick={() => autoTranslate(lang, 'all')}
                          disabled={translatingLang === lang}
                          title={t('aiAllTitle', { base: baseLang })}
                          style={{ fontSize: 10, padding: '1px 5px', background: '#3a3a5a', color: '#cde', border: '1px solid #4a4a6a' }}>
                          {t('aiAllBtnWithAgent', { agent: agentLabel })}
                        </button>
                      </div>
                      );
                    })()}
                  </div>
                </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {allKeys.length === 0 ? (
              <tr><td colSpan={languages.length + 1} style={{ padding: 16, color: '#666', textAlign: 'center' }}>{t('noKeys')}</td></tr>
            ) : allKeys.map(key => (
              <tr key={key}>
                <td style={{ padding: '3px 8px', borderRight: '1px solid #2a2a2a', borderBottom: '1px solid #2a2a2a', color: '#9ab', verticalAlign: 'top', fontFamily: 'monospace', position: 'sticky', left: 0, zIndex: 3, background: '#161616', minWidth: 240, width: 240 }}>{key}</td>
                {languages.map(lang => {
                  const v = table[lang]?.[key] || '';
                  const isEn = lang === 'en';
                  const cellSticky: React.CSSProperties = isEn
                    ? { position: 'sticky', left: 240, zIndex: 3, background: '#161616' }
                    : {};
                  return (
                    <td key={lang} style={{ padding: '0', borderRight: '1px solid #2a2a2a', borderBottom: '1px solid #2a2a2a', minWidth: 240, width: 240, ...cellSticky }}>
                      <textarea
                        value={v}
                        onChange={e => onCellChange(lang, key, e.target.value)}
                        onKeyDown={e => e.stopPropagation()}
                        rows={1}
                        style={{
                          width: '100%', minHeight: 22, padding: '3px 6px',
                          background: v ? 'transparent' : 'rgba(127,190,234,0.05)',
                          color: '#ccc', fontSize: 11, border: 'none', resize: 'vertical', fontFamily: 'inherit',
                          boxSizing: 'border-box', outline: 'none',
                        }}
                        placeholder={t('emptyPlaceholder')}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showLangPicker && (
        <div
          onClick={() => setShowLangPicker(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ background: '#222', border: '1px solid #444', borderRadius: 6, padding: 12, width: 520, maxHeight: '70vh', display: 'flex', flexDirection: 'column', gap: 8 }}
          >
            <div style={{ fontSize: 13, color: '#ddd', fontWeight: 'bold' }}>{t('langPickerTitle')}</div>
            <input
              autoFocus
              type="text"
              value={langPickerQ}
              onChange={e => setLangPickerQ(e.target.value)}
              onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') setShowLangPicker(false); }}
              placeholder={t('langPickerPlaceholder')}
              style={{ fontSize: 13, padding: '6px 10px', background: '#1a1a1a', color: '#ddd', border: '1px solid #444', borderRadius: 4 }}
            />
            <div style={{ flex: 1, overflow: 'auto', border: '1px solid #333', borderRadius: 4 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: '#1a1a1a', position: 'sticky', top: 0 }}>
                    <th style={{ padding: '6px 8px', textAlign: 'left', color: '#888', borderBottom: '1px solid #333', width: 80 }}>{t('code')}</th>
                    <th style={{ padding: '6px 8px', textAlign: 'left', color: '#888', borderBottom: '1px solid #333' }}>English name</th>
                    <th style={{ padding: '6px 8px', textAlign: 'left', color: '#888', borderBottom: '1px solid #333' }}>Native name</th>
                    <th style={{ padding: '6px 8px', textAlign: 'left', color: '#888', borderBottom: '1px solid #333' }}>Region</th>
                  </tr>
                </thead>
                <tbody>
                  {searchLanguages(langPickerQ).map(lang => {
                    const already = languages.includes(lang.code);
                    return (
                      <tr
                        key={lang.code}
                        onClick={() => {
                          if (already) {
                            setStatus(t('alreadyAdded', { code: lang.code }));
                            setTimeout(() => setStatus(''), 2000);
                            return;
                          }
                          setNewLangCode(lang.code);
                          setShowLangPicker(false);
                        }}
                        style={{ cursor: 'pointer', background: already ? '#1a2a1a' : 'transparent' }}
                        onMouseEnter={e => { if (!already) (e.currentTarget as HTMLElement).style.background = '#2a3a4a'; }}
                        onMouseLeave={e => { if (!already) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                      >
                        <td style={{ padding: '5px 8px', color: '#7fc', fontFamily: 'monospace' }}>{lang.code}{already && <span style={{ color: '#7fcf6e', marginLeft: 4 }}>✓</span>}</td>
                        <td style={{ padding: '5px 8px', color: '#ddd' }}>{lang.englishName}</td>
                        <td style={{ padding: '5px 8px', color: '#bbb' }}>{lang.nativeName}</td>
                        <td style={{ padding: '5px 8px', color: '#888' }}>{lang.region || ''}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
              <span style={{ flex: 1, fontSize: 11, color: '#888', alignSelf: 'center' }}>{t('langPickerHint')}</span>
              <button onClick={() => setShowLangPicker(false)} style={{ padding: '4px 12px', fontSize: 12 }}>{t('close')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
