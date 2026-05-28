// src/components/FileEditor.tsx
import React, { useState, useEffect, useRef, useCallback } from 'react';
import Editor, { OnMount } from '@monaco-editor/react';
import { useTranslation } from 'react-i18next';

// Electron 환경에서 Monaco 우클릭 메뉴의 Paste 가 동작하지 않는 문제 수정.
// 원인: standalone monaco 의 PasteAction 이 clipboardService.triggerPaste() 에 의존하는데
// 그 서비스는 standalone 환경에서 undefined 를 반환하고, navigator.clipboard fallback 은
// `isWeb === true` 일 때만 타서 Electron 에서는 paste 가 no-op 이 됨.
// 해결: monaco.editor.registerCommand 로 동일한 command id 를 덮어써서 paste 커맨드 자체를 교체.
let pasteOverrideInstalled = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function installMonacoPasteOverride(monaco: any) {
  if (pasteOverrideInstalled) return;
  pasteOverrideInstalled = true;
  monaco.editor.registerCommand('editor.action.clipboardPasteAction', async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const editors: any[] = monaco.editor.getEditors();
      const focused = editors.find(e => e?.hasTextFocus?.());
      if (!focused || !focused.hasModel?.()) return;
      const text = await navigator.clipboard.readText();
      if (!text) return;
      focused.trigger('keyboard', 'paste', { text });
    } catch {
      // 클립보드 읽기 실패 시 조용히 무시
    }
  });
}

type Props = {
  termId: string;
  remotePath: string;
  fileName: string;
  onDirtyChange?: (dirty: boolean) => void;
  onAnalyzeWithAI?: (ctx: { fileName: string; remotePath: string; content: string }, agent: 'claude' | 'gemini' | 'codex') => void;
};

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

// AI 에이전트 브랜드 아이콘 — ClaudeChat 의 탭 아이콘과 동일
const ClaudeIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" fill="#D97757"/>
  </svg>
);
const GeminiIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="feGeminiGrad" x1="12" y1="0" x2="12" y2="24" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stopColor="#4285F4"/>
        <stop offset="100%" stopColor="#00BFA5"/>
      </linearGradient>
    </defs>
    <path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" fill="url(#feGeminiGrad)"/>
  </svg>
);
const CodexIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" fill="#b0b0b0"/>
  </svg>
);

// 확장자 → Monaco 언어
function detectLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
    c: 'c', cc: 'cpp', cpp: 'cpp', h: 'c', hpp: 'cpp',
    cs: 'csharp', swift: 'swift', kt: 'kotlin', scala: 'scala',
    sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
    ps1: 'powershell', psm1: 'powershell',
    json: 'json', xml: 'xml', yaml: 'yaml', yml: 'yaml', toml: 'ini',
    html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
    md: 'markdown', markdown: 'markdown',
    sql: 'sql', graphql: 'graphql',
    dockerfile: 'dockerfile',
    conf: 'ini', ini: 'ini', cfg: 'ini',
    log: 'plaintext', txt: 'plaintext',
    php: 'php', lua: 'lua', r: 'r', pl: 'perl',
    vue: 'html', svelte: 'html',
  };
  return map[ext] || 'plaintext';
}

// 바이너리 파일 감지
const BINARY_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'zip', 'gz', 'tar', 'bz2', '7z', 'rar', 'exe', 'dll', 'so', 'dylib', 'bin', 'pdf', 'mp3', 'mp4', 'avi', 'mkv', 'wav', 'flac', 'ogg']);
function isBinaryFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return BINARY_EXT.has(ext);
}

export const FileEditor: React.FC<Props> = ({ termId, remotePath, fileName, onDirtyChange, onAnalyzeWithAI }) => {
  const { t } = useTranslation('fileEditor');
  const [content, setContent] = useState<string>('');
  const [originalContent, setOriginalContent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);
  const [aiAgentMenuOpen, setAiAgentMenuOpen] = useState(false);
  const [aiNewConversation, setAiNewConversation] = useState(true);
  useEffect(() => {
    if (!aiAgentMenuOpen) return;
    const close = () => setAiAgentMenuOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [aiAgentMenuOpen]);
  // AI 분석 요청 — 파일 내용을 첨부로 claude-prefill 이벤트 발행 (LogAnalyzer 와 동일 경로)
  const requestAnalyze = (agent: 'claude' | 'gemini' | 'codex') => {
    const fname = fileName || (remotePath.match(/[^\\/]+$/)?.[0] || 'file');
    const promptText = `첨부된 파일 \`${fname}\` 을 분석해줘.\n- 경로: ${remotePath}`;
    try {
      window.dispatchEvent(new CustomEvent('claude-prefill', {
        detail: {
          text: promptText,
          attachments: [{ name: fname, content }],
          newConversation: aiNewConversation,
          agent,
        },
      }));
    } catch {}
  };
  const editorRef = useRef<any>(null);

  const dirty = content !== originalContent;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const [encoding, setEncoding] = useState<string>('utf-8');

  // 깨진 문자(replacement char) 비율 — 인코딩 오선택 감지용
  const garbledRatio = (s: string): number => {
    if (!s) return 0;
    let bad = 0;
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 0xFFFD) bad++;
    return bad / s.length;
  };
  // 지정 인코딩으로 (재)로드. enc 미지정 시 세션 인코딩 사용 + 깨지면 euc-kr 자동 시도.
  const loadWithEncoding = useCallback(async (forceEnc?: string) => {
    if (isBinaryFile(fileName)) { setError(t('binaryNotEditable')); setLoading(false); return; }
    try {
      setLoading(true);
      setError(null);
      let enc = forceEnc || 'utf-8';
      if (!forceEnc) {
        try {
          const sessEnc = await (window as any).api?.getSSHEncoding?.(termId);
          if (sessEnc && typeof sessEnc === 'string') enc = sessEnc;
        } catch {}
      }
      let result = await (window as any).api?.sftpReadFile?.(termId, remotePath, enc);
      if (!result?.success) { setError(result?.error || t('cannotRead')); setLoading(false); return; }
      if (result.size > MAX_FILE_SIZE) {
        setError(t('tooLarge', { size: (result.size / 1024 / 1024).toFixed(1) }));
        setLoading(false); return;
      }
      // 자동 감지 — forceEnc 가 없고 현재 인코딩 결과가 많이 깨졌으면 euc-kr 로 재시도
      if (!forceEnc && enc.toLowerCase().replace('-', '') !== 'euckr' && garbledRatio(result.text || '') > 0.02) {
        const retry = await (window as any).api?.sftpReadFile?.(termId, remotePath, 'euc-kr');
        if (retry?.success && garbledRatio(retry.text || '') < garbledRatio(result.text || '')) {
          result = retry;
          enc = 'euc-kr';
        }
      }
      setEncoding(enc);
      const text = result.text || '';
      setContent(text);
      setOriginalContent(text);
      setLoading(false);
    } catch (err: any) {
      setError(String(err));
      setLoading(false);
    }
  }, [termId, remotePath, fileName, t]);

  // 파일 로드 (초기 + 경로/세션 변경 시)
  useEffect(() => { loadWithEncoding(); }, [termId, remotePath, fileName]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useCallback(async () => {
    if (saving || !dirty) return;
    setSaving(true);
    try {
      const result = await (window as any).api?.sftpWriteFile?.(termId, remotePath, content, encoding);
      if (result?.success) {
        setOriginalContent(content);
        setNotice({ text: t('saved'), kind: 'ok' });
        setTimeout(() => setNotice(null), 2000);
      } else {
        setNotice({ text: t('saveError', { error: result?.error || t('unknownError') }), kind: 'err' });
        setTimeout(() => setNotice(null), 4000);
      }
    } catch (err: any) {
      setNotice({ text: t('saveError', { error: String(err) }), kind: 'err' });
      setTimeout(() => setNotice(null), 4000);
    }
    setSaving(false);
  }, [saving, dirty, termId, remotePath, content]);

  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    // Ctrl+S 저장
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { save(); });
    // Electron 우클릭 Paste 동작 수정 (전역 1회 설치)
    installMonacoPasteOverride(monaco);
  };

  // 외부 레이아웃 변경 (AI 채팅 사이드바 pin/unpin, 워크스페이스 분할 등) 시 Monaco 강제 재계산.
  // bodyRef 는 callback ref — 엘리먼트가 실제로 마운트되는 시점에 ResizeObserver 붙임.
  // (useEffect+useRef 조합은 loading=true → early return 으로 ref 가 null 인 상태에서 effect 가 실행되어 누락됨)
  const roRef = useRef<ResizeObserver | null>(null);
  const bodyRef = useCallback((el: HTMLDivElement | null) => {
    if (roRef.current) { try { roRef.current.disconnect(); } catch {} roRef.current = null; }
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const ed = editorRef.current;
      if (ed) { try { ed.layout(); } catch {} }
    });
    ro.observe(el);
    roRef.current = ro;
  }, []);
  useEffect(() => () => { try { roRef.current?.disconnect(); } catch {} }, []);
  // 외부 resize 이벤트도 받음 — App.tsx 가 pin/unpin 시 명시적으로 발행
  useEffect(() => {
    const relayout = () => {
      const ed = editorRef.current;
      if (!ed) return;
      [0, 50, 200, 500].forEach(ms => setTimeout(() => { try { ed.layout(); } catch {} }, ms));
    };
    window.addEventListener('resize', relayout);
    return () => window.removeEventListener('resize', relayout);
  }, []);
  // 로딩 완료 직후 — 컨테이너가 늦게 자리잡는 케이스 보강
  useEffect(() => {
    if (loading) return;
    [50, 200, 500, 1000].forEach(ms => setTimeout(() => {
      const ed = editorRef.current;
      if (ed) { try { ed.layout(); } catch {} }
    }, ms));
  }, [loading]);

  if (loading) return <div className="file-editor-loading">{t('loading')}</div>;
  if (error) return <div className="file-editor-error">⚠ {error}</div>;

  return (
    <div className="file-editor">
      <div className="file-editor-header">
        <span className="file-editor-path">{remotePath}</span>
        {dirty && <span className="file-editor-dirty">●</span>}
        {/* 인코딩 선택 — 변경 시 그 인코딩으로 재로드 */}
        <select
          className="file-editor-encoding"
          value={encoding.toLowerCase()}
          onChange={e => loadWithEncoding(e.target.value)}
          title="파일 인코딩 (변경 시 재로드)"
          style={{ background: '#1a1a2e', color: '#ccc', border: '1px solid #3a3a5a', borderRadius: 4, fontSize: 11, padding: '2px 4px' }}
        >
          <option value="utf-8">UTF-8</option>
          <option value="euc-kr">EUC-KR</option>
          <option value="cp949">CP949</option>
          <option value="shift_jis">Shift_JIS</option>
          <option value="gbk">GBK</option>
          <option value="big5">Big5</option>
          <option value="latin1">Latin-1</option>
        </select>
        {onAnalyzeWithAI && (
          <>
          <label style={{ fontSize: 11, color: '#aac', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }} title="체크: 새 대화로 시작 / 해제: 현재 대화창에 이어서">
            <input type="checkbox" checked={aiNewConversation} onChange={e => setAiNewConversation(e.target.checked)} style={{ margin: 0 }} />
            새 대화
          </label>
          <div style={{ position: 'relative', display: 'inline-flex' }}>
            <button
              className="file-editor-claude"
              onClick={e => { e.stopPropagation(); setAiAgentMenuOpen(v => !v); }}
              title="AI 분석 요청"
            >
              🤖 AI 분석 요청 ▾
            </button>
            {aiAgentMenuOpen && (
              <div
                style={{
                  position: 'absolute', top: '100%', right: 0, marginTop: 4,
                  background: '#1a1a2e', border: '1px solid #3a3a5a', borderRadius: 6,
                  boxShadow: '0 6px 20px rgba(0,0,0,0.5)', zIndex: 1000,
                  minWidth: 160, padding: 4, display: 'flex', flexDirection: 'column', gap: 2,
                }}
                onClick={e => e.stopPropagation()}
              >
                {([
                  { id: 'claude' as const, label: 'Claude',  Icon: ClaudeIcon, color: '#a070ff' },
                  { id: 'gemini' as const, label: 'Gemini', Icon: GeminiIcon, color: '#4a9eff' },
                  { id: 'codex'  as const, label: 'Codex',  Icon: CodexIcon,  color: '#5cd97a' },
                ]).map(a => (
                  <button
                    key={a.id}
                    onClick={() => {
                      setAiAgentMenuOpen(false);
                      requestAnalyze(a.id);
                    }}
                    style={{
                      background: 'transparent', color: '#ddd', border: 0,
                      padding: '6px 10px', textAlign: 'left', cursor: 'pointer',
                      borderRadius: 4, fontSize: 12,
                      display: 'flex', alignItems: 'center', gap: 8,
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = a.color + '22')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <a.Icon />
                    <span>{a.label} 로 분석</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          </>
        )}
        <button className="file-editor-save" onClick={save} disabled={!dirty || saving}>
          {saving ? t('saving') : t('saveBtn')}
        </button>
        {notice && <span className={`file-editor-notice ${notice.kind}`}>{notice.text}</span>}
      </div>
      <div className="file-editor-body" ref={bodyRef}>
        <Editor
          height="100%"
          theme="vs-dark"
          language={detectLanguage(fileName)}
          value={content}
          onChange={v => setContent(v ?? '')}
          onMount={handleEditorMount}
          options={{
            automaticLayout: true,
            fontSize: 13,
            minimap: { enabled: true },
            scrollBeyondLastLine: false,
            wordWrap: 'on',
          }}
        />
      </div>
    </div>
  );
};
