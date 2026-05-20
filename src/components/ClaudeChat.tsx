// src/components/ClaudeChat.tsx
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { marked } from 'marked';
import mermaid from 'mermaid';
import { adjustClaudeFontSize } from '../utils/claudeFont';

// Mermaid 다이어그램 초기화 (모듈 로드 시 1회)
mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  securityLevel: 'loose',
  fontFamily: '"Malgun Gothic", "맑은 고딕", "Apple SD Gothic Neo", "Noto Sans KR", "Segoe UI", sans-serif',
  themeVariables: {
    fontFamily: '"Malgun Gothic", "맑은 고딕", "Apple SD Gothic Neo", "Noto Sans KR", "Segoe UI", sans-serif',
    fontSize: '14px',
  },
  flowchart: { htmlLabels: false, useMaxWidth: true, curve: 'basis' },
  sequence: { useMaxWidth: true },
});

// Mermaid 다이어그램 키워드 — 이 패턴으로 시작하면 mermaid 블록으로 간주
const MERMAID_START_RE = /^(graph\s+(TB|TD|BT|RL|LR)|flowchart\s+(TB|TD|BT|RL|LR)|sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|gantt|pie|journey|gitGraph|mindmap|timeline|quadrantChart)\b/;

// ── AI 에이전트 탭 아이콘 (실제 브랜드 SVG, simple-icons 기반) ───────────────
/** Anthropic Claude 공식 로고 (simple-icons, #D97757) */
const ClaudeTabIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" fill="#D97757"/>
  </svg>
);

/** Google Gemini 공식 로고 (simple-icons, 파랑→청록 그라디언트) */
const GeminiTabIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="geminiTabGrad" x1="12" y1="0" x2="12" y2="24" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stopColor="#4285F4"/>
        <stop offset="100%" stopColor="#00BFA5"/>
      </linearGradient>
    </defs>
    <path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" fill="url(#geminiTabGrad)"/>
  </svg>
);

/** OpenAI 공식 로고 (simple-icons, Codex 탭에 사용) */
const CodexTabIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" fill="#b0b0b0"/>
  </svg>
);
// ────────────────────────────────────────────────────────────────────────────

type CodexApprovalPolicy = 'suggest' | 'auto-edit' | 'full-auto';

const CODEX_APPROVAL_ITEMS: Array<{ value: CodexApprovalPolicy; label: string }> = [
  { value: 'suggest', label: '\uAD8C\uD55C \uC694\uCCAD' },
  { value: 'auto-edit', label: '\uC790\uB3D9 \uAC80\uD1A0' },
  { value: 'full-auto', label: '\uC804\uCCB4 \uAD8C\uD55C' },
];

function CodexApprovalIcon({ value }: { value: CodexApprovalPolicy }) {
  const color = value === 'suggest' ? '#4f8bd6' : value === 'auto-edit' ? '#7aa95a' : '#d08b45';
  if (value === 'suggest') {
    return (
      <svg className="codex-approval-icon" viewBox="0 0 20 20" aria-hidden="true" style={{ stroke: color }}>
        <path d="M7.6 9.3V4.2a1.05 1.05 0 0 1 2.1 0v4.65" />
        <path d="M9.7 8.85V3.35a1.05 1.05 0 0 1 2.1 0v5.5" />
        <path d="M11.8 8.95V4.55a1.03 1.03 0 0 1 2.05 0v5" />
        <path d="M13.85 9.75V6.6a1 1 0 0 1 2 0v4.6c0 2.45-1.72 4.25-4.12 4.25h-1.18c-1.22 0-2.33-.54-3.1-1.45l-2.82-3.34a1.12 1.12 0 0 1 .02-1.52 1.13 1.13 0 0 1 1.58.02l1.37 1.32" />
      </svg>
    );
  }
  return (
    <svg className="codex-approval-icon" viewBox="0 0 20 20" aria-hidden="true" style={{ stroke: color }}>
      <path d="M10 2.7 15.2 4.6v4.15c0 3.42-2.05 6.02-5.2 8.25-3.15-2.23-5.2-4.83-5.2-8.25V4.6L10 2.7Z" />
      {value === 'auto-edit' ? (
        <>
          <path d="M7.3 8.1 9.05 10 7.3 11.9" />
          <path d="M10.25 12.05h2.55" />
        </>
      ) : (
        <>
          <path d="M10 6.75v4.15" />
          <path d="M10 13.25h.01" />
        </>
      )}
    </svg>
  );
}

// fence 없는 mermaid 블록을 ```mermaid 로 감싸기
function autoFenceMermaid(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let i = 0;
  let inFence = false;
  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*```/.test(l)) { inFence = !inFence; out.push(l); i++; continue; }
    if (!inFence && MERMAID_START_RE.test(l.trim())) {
      // mermaid 블록 시작 — 빈줄이 2번 연속 나오거나 ## 헤더 만나기 전까지
      const block: string[] = [l];
      let j = i + 1;
      let blankRun = 0;
      while (j < lines.length) {
        const next = lines[j];
        if (/^#{1,6}\s/.test(next)) break;
        if (/^\s*```/.test(next)) break;
        if (next.trim() === '') {
          blankRun++;
          if (blankRun >= 2) break;
        } else {
          blankRun = 0;
        }
        block.push(next);
        j++;
      }
      // 끝 빈줄들 제거
      while (block.length > 0 && block[block.length - 1].trim() === '') block.pop();
      out.push('```mermaid');
      for (const b of block) out.push(b);
      out.push('```');
      i = j;
      continue;
    }
    out.push(l);
    i++;
  }
  return out.join('\n');
}

// 탭 또는 2칸 이상 공백으로 정렬된 텍스트 블록을 GFM 테이블로 자동 변환
function autoConvertTablesInMd(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let i = 0;
  // 코드 블록 안은 건너뜀
  let inCode = false;
  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*```/.test(l)) { inCode = !inCode; out.push(l); i++; continue; }
    if (inCode) { out.push(l); i++; continue; }

    // 탭 기반 블록 탐지 (2줄 이상)
    if (l.includes('\t')) {
      const block: string[] = [];
      let j = i;
      while (j < lines.length && lines[j].includes('\t') && !/^\s*```/.test(lines[j])) {
        block.push(lines[j]);
        j++;
      }
      if (block.length >= 2) {
        const rows = block.map(s => s.split('\t').map(c => c.trim()));
        const cols = Math.max(...rows.map(r => r.length));
        rows.forEach(r => { while (r.length < cols) r.push(''); });
        out.push('| ' + rows[0].join(' | ') + ' |');
        out.push('| ' + Array(cols).fill('---').join(' | ') + ' |');
        for (let r = 1; r < rows.length; r++) out.push('| ' + rows[r].join(' | ') + ' |');
        i = j;
        continue;
      }
    }
    out.push(l);
    i++;
  }
  return out.join('\n');
}

// 텍스트 줄 바로 다음에 `===+` 또는 `---+` 만 있는 라인이 오면 marked 가 setext heading 으로 해석해서
// 글자가 거대하게 렌더됨 (사용자가 붙인 SSH 출력에 자주 발생). 그 경우만 ZWSP 프리픽스로 중화.
function neutralizeSetextHeadings(text: string): string {
  const lines = text.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const cur = lines[i];
    const prev = lines[i - 1];
    if ((/^=+\s*$/.test(cur) || /^-+\s*$/.test(cur)) && cur.trim().length >= 3) {
      if (prev.trim().length > 0) lines[i] = '​' + cur;
    }
  }
  return lines.join('\n');
}
function renderMd(content: string): string {
  return marked.parse(autoConvertTablesInMd(autoFenceMermaid(neutralizeSetextHeadings(content))), { breaks: true }) as string;
}

type AgentType = 'claude' | 'gemini' | 'codex';
type Message = {
  role: 'user' | 'assistant';
  content: string;
  id: string;
  seq?: number; // 발생 순서 (타임라인 인터리브용)
  agent?: AgentType; // 응답한 에이전트 (assistant 메시지에만)
};
type ToolTimelineItem = { id: string; label: string; status: 'running' | 'done' | 'error'; resultPreview?: string; seq?: number };
type ChatHistoryEntry = {
  id: string; // 로컬 고유 id
  claudeSessionId?: string | null; // Claude CLI session_id (resume 용)
  title: string;
  pinned: boolean;
  updatedAt: number;
  messages: Message[];
  pendingRequestId?: string | null; // 진행 중 send 의 requestId
  streaming?: boolean; // 진행 중인지
  toolTimeline?: ToolTimelineItem[]; // 툴 호출 타임라인 (대화별 영속)
  lastRejectedPlan?: string | null; // 거부한 계획 (대화별 보존)
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    totalCostUsd: number;
    turns: number;
    lastTurnInput: number;
    lastTurnOutput: number;
    lastTurnFreshInput: number;
    lastTurnCacheRead: number;
    lastTurnCacheCreate: number;
    model: string;
  };
};

export type FileContextItem = { fileName: string; remotePath: string; content: string };
export type MountEntry = { termId: string; remotePath: string; uncPath: string; isDir: boolean };

type Props = {
  onClose?: () => void;
  pendingContext: FileContextItem[] | null;
  onContextConsumed: () => void;
  mountEntries?: MountEntry[];
  onClearMounted?: () => void;
  onRemoveMountedEntry?: (remotePath: string, termId: string) => void;
  connectedSessions?: { termId: string; label: string }[];
  defaultSshSession?: { termId: string; label: string } | null;
  pinned?: boolean;
  onTogglePin?: () => void;
  aiAgent?: 'claude' | 'gemini' | 'codex';
  onAgentChange?: (agent: 'claude' | 'gemini' | 'codex') => void;
};

let sessionCounter = 0;

export const ClaudeChat: React.FC<Props> = ({ onClose, pendingContext, onContextConsumed, mountEntries = [], onClearMounted, onRemoveMountedEntry, connectedSessions = [], defaultSshSession, pinned = true, onTogglePin, aiAgent = 'claude', onAgentChange }) => {
  // 채팅창 내에서 독립적으로 전환 가능한 에이전트 (전역 설정과 분리)
  const [currentAgent, setCurrentAgentState] = useState<AgentType>(aiAgent);
  const currentAgentRef = useRef<AgentType>(aiAgent);
  const setCurrentAgent = (a: AgentType) => { currentAgentRef.current = a; setCurrentAgentState(a); };
  // 전역 설정(옵션 패널 등)이 바뀌면 내부 에이전트 + 저장된 설정 복원
  useEffect(() => {
    if (currentAgentRef.current === aiAgent) return;
    saveCurrentAgentSettings();
    const saved = agentSettingsMemory.current[aiAgent];
    setCurrentAgent(aiAgent);
    setModelRaw(saved?.model ?? defaultModelFor(aiAgent));
    setEffort(saved?.effort ?? 'medium');
    setPermissionMode(saved?.permissionMode ?? 'default');
    setPerToolApproval(saved?.perToolApproval ?? true);
    setGeminiYolo(saved?.geminiYolo ?? true);
    setCodexApprovalPolicy(saved?.codexApprovalPolicy ?? 'suggest');
  }, [aiAgent]); // eslint-disable-line react-hooks/exhaustive-deps
  const { t: tt } = useTranslation('claudeChat');
  // 사용자가 선택한 활성 SSH 세션 (드롭다운). 처음엔 defaultSshSession.
  const [selectedSshTermId, setSelectedSshTermId] = useState<string | null>(defaultSshSession?.termId || null);
  useEffect(() => {
    // defaultSshSession 변경 시 선택된 적 없으면 반영
    if (defaultSshSession && !selectedSshTermId) {
      setSelectedSshTermId(defaultSshSession.termId);
    }
  }, [defaultSshSession?.termId]);
  // 실제로 selected termId 가 connectedSessions 에 존재하는지 확인 (세션 종료 시 리셋)
  useEffect(() => {
    if (selectedSshTermId && !connectedSessions.find(s => s.termId === selectedSshTermId)) {
      setSelectedSshTermId(connectedSessions[0]?.termId || null);
    }
  }, [connectedSessions.map(s => s.termId).join(',')]);
  const activeSshSession = selectedSshTermId
    ? (connectedSessions.find(s => s.termId === selectedSshTermId) || null)
    : null;
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [version, setVersion] = useState<string>('');
  const [messages, setMessages] = useState<Message[]>([]);
  // Git 상태 — 현재 cwd / 활성 SSH 세션 자동 감지
  const [gitStatus, setGitStatus] = useState<{ ok: boolean; branch?: string; additions?: number; deletions?: number } | null>(null);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  // 현재 진행 중 활동(툴 이름 등) — 스트리밍 인디케이터 옆에 표시
  const [activity, setActivity] = useState<string>('');
  // 툴 호출 타임라인 (각 호출을 별도 항목으로)
  const [toolTimeline, setToolTimeline] = useState<ToolTimelineItem[]>([]);
  // 승인 대기 중인 계획 (ExitPlanMode 수신 시)
  const [pendingPlan, setPendingPlan] = useState<string | null>(null);
  // 계획 편집 모드 — 사용자가 markdown 원본을 수정한 뒤 그 내용으로 진행 가능
  const [planEditing, setPlanEditing] = useState(false);
  const [planEditedText, setPlanEditedText] = useState('');
  // 계획 진행 시 추가 요구사항 — 계획에 덧붙여서 전송
  const [planExtraNote, setPlanExtraNote] = useState('');
  // 최근 거부한 계획 (실수 방지 — 다시 보기/재승인 가능)
  const [lastRejectedPlan, setLastRejectedPlan] = useState<string | null>(null);
  // 사용량 추적 — stream-json result 이벤트에서 누적
  type UsageStat = {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    totalCostUsd: number;
    turns: number;
    lastTurnInput: number;
    lastTurnOutput: number;
    lastTurnFreshInput: number;
    lastTurnCacheRead: number;
    lastTurnCacheCreate: number;
    model: string;
  };
  const [usage, setUsage] = useState<UsageStat>({ inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalCostUsd: 0, turns: 0, lastTurnInput: 0, lastTurnOutput: 0, lastTurnFreshInput: 0, lastTurnCacheRead: 0, lastTurnCacheCreate: 0, model: '' });
  const [showUsagePanel, setShowUsagePanel] = useState<boolean>(false);
  const [showUsageTooltip, setShowUsageTooltip] = useState<boolean>(false);
  const [usagePopupPos, setUsagePopupPos] = useState<{ left: number; bottom: number } | null>(null);
  // 외부 클릭 시 popup 닫기
  useEffect(() => {
    if (!showUsagePanel) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t) return;
      // popup 내부 클릭 또는 trigger 클릭은 무시
      if (t.closest('.claude-chat-usage-popup')) return;
      if (t.closest('.claude-chat-usage-trigger-wrap')) return;
      setShowUsagePanel(false);
    };
    // mousedown 이 클릭 직전에 발생 — 외부 클릭 즉시 감지
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showUsagePanel]);
  const usagePanelHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const usageTriggerRef = useRef<HTMLDivElement | null>(null);
  const showUsage = () => {
    if (usagePanelHideTimerRef.current) { clearTimeout(usagePanelHideTimerRef.current); usagePanelHideTimerRef.current = null; }
    if (usageTriggerRef.current) {
      const r = usageTriggerRef.current.getBoundingClientRect();
      setUsagePopupPos({
        left: Math.max(8, r.left),
        bottom: Math.max(8, window.innerHeight - r.top + 4),
      });
    }
    setShowUsagePanel(true);
  };
  const usageApiCacheRef = useRef<{ data: any; ts: number } | null>(null);
  // API 직접 호출 (trigger 클릭 시 + API 직접 버튼 클릭 시 공용) — 60s 캐시
  const fetchUsageApi = async (force: boolean = false) => {
    // 캐시 hit (60초 내) — API 재호출 안 함
    if (!force && usageApiCacheRef.current && Date.now() - usageApiCacheRef.current.ts < 60_000) {
      const d = usageApiCacheRef.current.data;
      const age = Math.round((Date.now() - usageApiCacheRef.current.ts) / 1000);
      setUsageProbe(`${tt('cachedResponse', { age })}\n────────────────────────\n${JSON.stringify(d, null, 2)}`);
      return;
    }
    setUsageProbeLoading(true);
    setUsageProbe(tt('apiCallLoading'));
    try {
      const r: any = await (window as any).api?.claudeFetchUsageApi?.();
      if (r?.success && r.data) {
        const d = r.data;
        usageApiCacheRef.current = { data: d, ts: Date.now() };
        const fmtPct = (v: any) => v == null ? null : Math.round(v.utilization || 0) + '%';
        const fmtReset = (v: any) => {
          if (!v?.resets_at) return null;
          const dt = new Date(v.resets_at);
          if (isNaN(dt.getTime())) return null;
          const diffMs = dt.getTime() - Date.now();
          if (diffMs <= 0) return tt('resetSoon');
          const mins = Math.round(diffMs / 60000);
          const hours = Math.round(diffMs / 3_600_000);
          const days = Math.round(diffMs / 86_400_000);
          if (days >= 1) return tt('resetDays', { days });
          if (hours >= 1) return tt('resetHours', { hours });
          return tt('resetMins', { mins });
        };
        setSubLimits({
          fiveHourPct: fmtPct(d.five_hour) || undefined,
          fiveHourReset: fmtReset(d.five_hour) || undefined,
          weeklyAllPct: fmtPct(d.seven_day) || undefined,
          weeklyAllReset: fmtReset(d.seven_day) || undefined,
          sonnetOnlyPct: fmtPct(d.seven_day_sonnet) || undefined,
          sonnetOnlyReset: fmtReset(d.seven_day_sonnet) || undefined,
          weeklyDesignPct: fmtPct(d.seven_day_oauth_apps) ?? '0%',
        });
        setUsageProbe(`${tt('apiResponseHeader')}\n────────────────────────\n${JSON.stringify(d, null, 2)}`);
      } else {
        setUsageProbe(`${tt('apiFailed', { error: r?.error || tt('failed') })}\n${r?.body || ''}`);
      }
    } catch (e: any) {
      setUsageProbe(`❌ ${e?.message || e}`);
    }
    setUsageProbeLoading(false);
  };
  const hideUsageDelayed = () => {
    if (usagePanelHideTimerRef.current) clearTimeout(usagePanelHideTimerRef.current);
    usagePanelHideTimerRef.current = setTimeout(() => setShowUsagePanel(false), 800);
  };
  // /usage 명령 결과 (옵션 B — claude /usage 출력 파싱 시도)
  const [usageProbe, setUsageProbe] = useState<string | null>(null);
  const [usageProbeLoading, setUsageProbeLoading] = useState(false);
  const [usageProbeExpanded, setUsageProbeExpanded] = useState(false);
  // 마운트 시 ~/.claude/settings.json 읽어 model 자동 설정
  useEffect(() => {
    (async () => {
      try {
        const r: any = await (window as any).api?.claudeReadSettings?.();
        if (r?.success && r.settings?.model) {
          const m = String(r.settings.model);
          // settings 의 model 값을 select 옵션으로 매핑
          // "claude-opus-4-7[1m]" / "opus[1m]" → "opus[1m]"
          // "claude-sonnet-4-6[1m]" / "sonnet[1m]" → "sonnet[1m]"
          // "opus" / "claude-opus-4-7" → "opus", 등
          const normalize = (raw: string): string => {
            const lower = raw.toLowerCase();
            const has1m = /\[1m\]/i.test(lower);
            if (lower.includes('opusplan') || lower.includes('opus-plan')) return 'opusplan';
            if (lower.includes('haiku')) return 'haiku';
            if (lower.includes('sonnet')) return has1m ? 'sonnet[1m]' : 'sonnet';
            if (lower.includes('opus')) return has1m ? 'opus[1m]' : 'opus';
            return 'default';
          };
          // 초기 로드 시에만 settings.json 값으로 model 설정 (메모리 저장 없이 raw 업데이트)
          setModelRaw(normalize(m));
        }
      } catch {}
    })();
  }, []);
  // 구독 한도 (TUI /usage 파싱 결과 — 채팅 세션 누적과 별개)
  const [subLimits, setSubLimits] = useState<{
    contextUsed?: string;
    contextMax?: string;
    contextPct?: string;
    planUsage?: string;
    fiveHourPct?: string;
    fiveHourReset?: string;
    weeklyAllPct?: string;
    weeklyAllReset?: string;
    weeklyDesignPct?: string;
    sonnetOnlyPct?: string;
    sonnetOnlyReset?: string;
    modelLabel?: string;
    tuiCost?: string;
    tuiInput?: string;
    tuiOutput?: string;
    tuiCacheRead?: string;
    tuiCacheWrite?: string;
  } | null>(null);

  // 툴 그룹 / 항목 확장 상태 — 기본 축소
  const [expandedToolGroups, setExpandedToolGroups] = useState<Set<string>>(new Set());
  const [expandedToolItems, setExpandedToolItems] = useState<Set<string>>(new Set());
  const toggleToolGroup = (gid: string) => setExpandedToolGroups(prev => { const n = new Set(prev); n.has(gid) ? n.delete(gid) : n.add(gid); return n; });
  const toggleToolItem = (id: string) => setExpandedToolItems(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  // 툴 단위 승인 모드 (hooks)
  const [perToolApproval, setPerToolApproval] = useState(() => {
    try { const v = localStorage.getItem('claudePerToolApproval'); return v === null ? true : v === '1'; } catch { return true; }
  });
  useEffect(() => { try { localStorage.setItem('claudePerToolApproval', perToolApproval ? '1' : '0'); } catch {} }, [perToolApproval]);
  // 현재 대기 중인 툴 승인 요청 (hook 에서 전달)
  const [pendingToolApproval, setPendingToolApproval] = useState<{ approvalId: string; toolName: string; toolInput: any } | null>(null);
  const [sessionId] = useState(() => `claude-${Date.now()}-${sessionCounter++}`);
  // 사용자가 전송 버튼을 누를 때까지 파일 컨텍스트를 로컬에서 보관 (다중 첨부)
  const [attachments, setAttachments] = useState<FileContextItem[]>([]);
  // 활성 SSH 세션의 WebDAV 마운트 루트 (세션 전체 파일시스템 접근용)
  const [activeMount, setActiveMount] = useState<{ termId: string; mountRoot: string; label: string } | null>(null);
  // Claude CLI 대화 세션 ID (이전 대화 컨텍스트 유지용 --resume)
  const claudeSessionIdRef = useRef<string | null>(null);
  // 대화 이력 목록 (UIPrefs 영속화)
  const [chatHistory, setChatHistory] = useState<ChatHistoryEntry[]>([]);
  const [activeHistoryId, setActiveHistoryId] = useState<string | null>(null);
  const [showHistoryPanel, setShowHistoryPanel] = useState(false);
  const [deleteHistoryConfirm, setDeleteHistoryConfirm] = useState<{ id: string; title: string } | null>(null);
  // 메시지 우클릭 컨텍스트 메뉴
  const [msgCtxMenu, setMsgCtxMenu] = useState<{ x: number; y: number; msgId: string; content: string } | null>(null);
  useEffect(() => {
    if (!msgCtxMenu) return;
    const close = () => setMsgCtxMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
      window.removeEventListener('keydown', close);
    };
  }, [msgCtxMenu]);
  const chatHistoryLoadedRef = useRef(false);
  // 대화 세대 카운터 — clear() / loadHistory / stop 호출 시 증가. 진행 중 stream 이벤트가 새 대화에 섞이는 것 방지
  const conversationGenRef = useRef(0);
  // 마지막 send 시점의 세대값. 이 값이 conversationGenRef 와 다르면 stream 이벤트 무시
  const activeGenRef = useRef(0);
  // 현재 활성 send 의 requestId — main 프로세스가 echo back. 이게 일치하지 않는 stream 은 무시
  const activeRequestIdRef = useRef<string | null>(null);
  // requestId → historyId 매핑. 비활성 대화의 stream 도 해당 history 항목에 계속 반영하기 위함.
  const requestToHistoryRef = useRef<Map<string, string>>(new Map());
  const requestToAgentRef = useRef<Map<string, AgentType>>(new Map());
  // activeHistoryId 의 ref 미러 — stream listener 가 stale closure 없이 즉시 현재값 사용
  const activeHistoryIdRef = useRef<string | null>(null);
  // 메시지/툴 호출 순서 카운터 — 둘을 발생 순서대로 인터리브 렌더링
  const seqCounterRef = useRef(0);
  const nextSeq = () => ++seqCounterRef.current;
  // 로드된 history 의 최대 seq 보다 카운터를 높여 새 항목이 항상 뒤에 정렬되도록 보정
  const bumpSeqFor = (msgs: Message[], tools: ToolTimelineItem[]) => {
    let maxSeq = seqCounterRef.current;
    for (const m of msgs) if (typeof m.seq === 'number' && m.seq > maxSeq) maxSeq = m.seq;
    for (const t of tools) if (typeof t.seq === 'number' && t.seq > maxSeq) maxSeq = t.seq;
    seqCounterRef.current = maxSeq;
  };

  // 이력 로드
  useEffect(() => {
    (async () => {
      try {
        const prefs = await (window as any).api?.getUIPrefs?.();
        if (prefs && Array.isArray(prefs.claudeChatHistory)) {
          setChatHistory(prefs.claudeChatHistory);
        }
      } catch {}
      chatHistoryLoadedRef.current = true;
    })();
  }, []);
  // 이력 저장
  useEffect(() => {
    if (!chatHistoryLoadedRef.current) return;
    try { (window as any).api?.setUIPrefs?.({ claudeChatHistory: chatHistory }); } catch {}
  }, [chatHistory]);
  // 최근 대화에서 언급된 로컬 Windows 경로들 — 이후 턴에서도 --add-dir 로 유지
  const recentLocalPathsRef = useRef<Set<string>>(new Set());
  // 권한 모드: default(기본, 요청 시) / acceptEdits(편집만 자동) / plan(실행 없이 계획만) / bypassPermissions(모두 허용)
  const [permissionMode, setPermissionMode] = useState<'bypassPermissions' | 'acceptEdits' | 'plan' | 'default'>('default');
  // 작업량 (effort) — claude --effort 플래그로 전달
  const [effort, setEffort] = useState<string>(() => {
    try { return localStorage.getItem('claudeEffort') || 'medium'; } catch { return 'medium'; }
  });
  useEffect(() => { try { localStorage.setItem('claudeEffort', effort); } catch {} }, [effort]);
  // Gemini: --yolo 온/오프 (기본 true)
  const [geminiYolo, setGeminiYolo] = useState<boolean>(true);
  // Codex: approval policy
  const [codexApprovalPolicy, setCodexApprovalPolicy] = useState<CodexApprovalPolicy>('suggest');
  const [codexApprovalMenuOpen, setCodexApprovalMenuOpen] = useState(false);
  // 에이전트별 설정 메모리 (탭 전환 시 복원)
  type AgentSettings = { model: string; effort: string; permissionMode: 'bypassPermissions' | 'acceptEdits' | 'plan' | 'default'; perToolApproval: boolean; geminiYolo: boolean; codexApprovalPolicy: CodexApprovalPolicy };
  const agentSettingsMemory = useRef<Partial<Record<AgentType, AgentSettings>>>({});
  // 동적 모델 목록 (Anthropic /v1/models)
  type AnthropicModel = { id: string; display_name: string; max_input_tokens?: number; capabilities?: any };
  const [availableModels, setAvailableModels] = useState<AnthropicModel[]>([]);
  useEffect(() => {
    (async () => {
      try {
        // 캐시 사용 — 1시간 이내면 재사용
        const cached = localStorage.getItem('claudeModelsCache');
        if (cached) {
          const o = JSON.parse(cached);
          if (o.ts && Date.now() - o.ts < 3600_000 && Array.isArray(o.models)) {
            setAvailableModels(o.models);
          }
        }
      } catch {}
      try {
        const r: any = await (window as any).api?.claudeFetchModels?.();
        if (r?.success && Array.isArray(r.models)) {
          setAvailableModels(r.models);
          try { localStorage.setItem('claudeModelsCache', JSON.stringify({ ts: Date.now(), models: r.models })); } catch {}
        }
      } catch {}
    })();
  }, []);
  // 모드 진입 시 툴별 승인 자동 토글: default/plan 은 ON, bypass/acceptEdits 는 OFF
  useEffect(() => {
    if (permissionMode === 'bypassPermissions' || permissionMode === 'acceptEdits') {
      if (perToolApproval) setPerToolApproval(false);
    } else if (permissionMode === 'default' || permissionMode === 'plan') {
      if (!perToolApproval) setPerToolApproval(true);
    }
  }, [permissionMode]);
  // 모델 선택 — 에이전트별 기본 모델
  const defaultModelFor = (a: AgentType) => a === 'gemini' ? 'gemini-2.5-flash' : a === 'codex' ? 'gpt-5.5' : 'opus';
  const [model, setModelRaw] = useState<string>(defaultModelFor(aiAgent));
  const saveCurrentAgentSettings = () => {
    agentSettingsMemory.current[currentAgentRef.current] = {
      model, effort, permissionMode, perToolApproval, geminiYolo, codexApprovalPolicy,
    };
  };
  const setModel = (m: string) => { saveCurrentAgentSettings(); agentSettingsMemory.current[currentAgentRef.current]!.model = m; setModelRaw(m); };
  // 에이전트 전환: 현재 설정 저장 후 이전 설정 복원
  const switchAgent = (a: AgentType) => {
    if (currentAgentRef.current === a) return;
    saveCurrentAgentSettings();
    const saved = agentSettingsMemory.current[a];
    setCurrentAgent(a);
    setModelRaw(saved?.model ?? defaultModelFor(a));
    setEffort(saved?.effort ?? 'medium');
    setPermissionMode(saved?.permissionMode ?? 'default');
    setPerToolApproval(saved?.perToolApproval ?? true);
    setGeminiYolo(saved?.geminiYolo ?? true);
    setCodexApprovalPolicy(saved?.codexApprovalPolicy ?? 'suggest');
    onAgentChange?.(a);
  };
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const [commandFilter, setCommandFilter] = useState('');
  const [commandHighlight, setCommandHighlight] = useState(0);
  const commandFilterRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!commandMenuOpen) return;
    setCommandFilter('');
    setCommandHighlight(0);
    setTimeout(() => commandFilterRef.current?.focus(), 30);
    const close = () => setCommandMenuOpen(false);
    const t = setTimeout(() => window.addEventListener('click', close), 0);
    return () => { clearTimeout(t); window.removeEventListener('click', close); };
  }, [commandMenuOpen]);
  const fileUploadRef = useRef<HTMLInputElement | null>(null);
  const folderUploadRef = useRef<HTMLInputElement | null>(null);
  // 로컬 파일 첨부 (사용자 PC 파일 내용)
  const [localFileAttachments, setLocalFileAttachments] = useState<{ name: string; content: string }[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  // ClaudeChat 은 installed 상태에 따라 여러 return 분기를 가져서 ref 부착 시점이 변함.
  // 안정적으로 listener 를 붙이기 위해 document 전체에서 target 이 claude-chat-container 내부인지
  // 확인하는 방식으로 wheel 을 처리.
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      const t = e.target as HTMLElement | null;
      if (!t || !t.closest || !t.closest('.claude-chat-sidebar, .claude-chat-container')) return;
      e.preventDefault();
      adjustClaudeFontSize(e.deltaY < 0 ? 1 : -1);
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => { window.removeEventListener('wheel', onWheel); };
  }, []);
  const currentAsstIdRef = useRef<string | null>(null);

  const scrollChatToBottom = useCallback((delay = 0) => {
    const run = () => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    };
    if (delay > 0) setTimeout(run, delay);
    else requestAnimationFrame(run);
  }, []);

  // setActiveHistoryId wrapper – ref 도 즉시 동기화 (stream listener race 방지)
  const setActiveHist = useCallback((id: string | null) => {
    activeHistoryIdRef.current = id;
    setActiveHistoryId(id);
  }, []);

  // CLI 설치 확인 (currentAgent 변경 시마다 재확인)
  useEffect(() => {
    setInstalled(null); // 에이전트 전환 시 로딩 상태로 초기화
    setVersion('');
    (async () => {
      const res = currentAgent === 'gemini'
        ? await (window as any).api?.geminiCheck?.()
        : currentAgent === 'codex'
        ? await (window as any).api?.codexCheck?.()
        : await (window as any).api?.claudeCheck?.();
      setInstalled(!!res?.installed);
      setVersion(res?.version || '');
    })();
  }, [currentAgent]);

  // Hook 승인 요청 리스너
  useEffect(() => {
    const dispose = (window as any).api?.onClaudeHookApprovalRequest?.((p: any) => {
      setPendingToolApproval({ approvalId: p.approvalId, toolName: p.toolName, toolInput: p.toolInput });
    });
    return () => { if (dispose) dispose(); };
  }, []);

  // 활성 SSH 세션이 변경되면 WebDAV 마운트 등록 + 루트 경로 저장
  useEffect(() => {
    (async () => {
      if (!activeSshSession) { setActiveMount(null); return; }
      if (activeMount?.termId === activeSshSession.termId) return; // 이미 등록됨
      try {
        const reg: any = await (window as any).api?.claudeRegisterMount?.(activeSshSession.termId, activeSshSession.label);
        if (!reg?.success) { setActiveMount(null); return; }
        const pathRes: any = await (window as any).api?.claudeGetMountPath?.(activeSshSession.termId, '/');
        if (!pathRes?.success) { setActiveMount(null); return; }
        // "/" 에 대한 uncPath 가 세션 루트
        setActiveMount({ termId: activeSshSession.termId, mountRoot: pathRes.uncPath.replace(/\\$/, ''), label: activeSshSession.label });
      } catch (err) {
        console.error('[ClaudeChat] auto-mount failed:', err);
        setActiveMount(null);
      }
    })();
  }, [activeSshSession?.termId, activeSshSession?.label]);

  // 스트리밍 응답 리스너
  useEffect(() => {
    const dispose = (window as any).api?.onClaudeStream?.((p: any) => {
      if (p.sessionId !== sessionId) return;
      const reqId: string | undefined = p.requestId;
      // requestId → historyId 매핑으로 어느 대화에 속하는 이벤트인지 판별
      const targetHistoryId = reqId ? requestToHistoryRef.current.get(reqId) : null;
      if (!targetHistoryId) return; // 추적 불가 이벤트 무시
      const streamAgent = (reqId ? requestToAgentRef.current.get(reqId) : null) || currentAgentRef.current;
      const msg = p.message;
      const isActive = targetHistoryId === activeHistoryIdRef.current;
      // 비활성 대화의 stream — chatHistory 만 직접 갱신 (사용자가 돌아왔을 때 메시지 + streaming 상태 보존)
      if (!isActive) {
        setChatHistory(hList => hList.map(h => {
          if (h.id !== targetHistoryId) return h;
          let newMsgs = h.messages;
          let newStreaming = h.streaming;
          let newSessId = h.claudeSessionId;
          let newTimeline: ToolTimelineItem[] = h.toolTimeline ? [...h.toolTimeline] : [];
          let newUsage = h.usage ? { ...h.usage } : { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalCostUsd: 0, turns: 0, lastTurnInput: 0, lastTurnOutput: 0, lastTurnFreshInput: 0, lastTurnCacheRead: 0, lastTurnCacheCreate: 0, model: '' };
          if (msg.session_id && !newSessId) newSessId = msg.session_id;
          if (msg.type === 'assistant' && msg.message?.content) {
            const msgId = msg.message.id || `asst-${Date.now()}`;
            const texts = msg.message.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
            const toolUses = msg.message.content.filter((c: any) => c.type === 'tool_use');
            if (texts) {
              const ex = newMsgs.find(m => m.id === msgId);
              newMsgs = ex ? newMsgs.map(m => m.id === msgId ? { ...m, content: texts } : m)
                           : [...newMsgs, { role: 'assistant', content: texts, id: msgId, seq: nextSeq(), agent: streamAgent }];
            }
            for (const t of toolUses) {
              if (newTimeline.find(x => x.id === t.id)) continue;
              const args = JSON.stringify(t.input).slice(0, 120);
              newTimeline.push({ id: t.id, label: `🔧 ${t.name}(${args}${args.length >= 120 ? '…' : ''})`, status: 'running', seq: nextSeq() });
            }
            const u = (msg.message as any).usage;
            if (u) {
              newUsage = {
                ...newUsage,
                inputTokens: newUsage.inputTokens + (u.input_tokens || 0),
                outputTokens: newUsage.outputTokens + (u.output_tokens || 0),
                cacheCreationTokens: newUsage.cacheCreationTokens + (u.cache_creation_input_tokens || 0),
                cacheReadTokens: newUsage.cacheReadTokens + (u.cache_read_input_tokens || 0),
                lastTurnInput: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
                lastTurnOutput: u.output_tokens || 0,
                lastTurnFreshInput: u.input_tokens || 0,
                lastTurnCacheRead: u.cache_read_input_tokens || 0,
                lastTurnCacheCreate: u.cache_creation_input_tokens || 0,
                model: (msg.message as any).model || newUsage.model,
              };
            }
          } else if (msg.type === 'user' && msg.message?.content) {
            const results = Array.isArray(msg.message.content) ? msg.message.content.filter((c: any) => c.type === 'tool_result') : [];
            if (results.length > 0) {
              newTimeline = newTimeline.map(t => {
                const match = results.find((r: any) => r.tool_use_id === t.id);
                if (!match) return t;
                const content = typeof match.content === 'string' ? match.content : JSON.stringify(match.content);
                const preview = content.slice(0, 1500).replace(/\n/g, ' ');
                return { ...t, status: match.is_error ? 'error' : 'done', resultPreview: preview };
              });
            }
          } else if (msg.type === 'result' || msg.type === 'done') {
            newStreaming = false;
          } else if (msg.type === 'error') {
            newMsgs = [...newMsgs, { role: 'assistant', content: `❌ ${msg.text}`, id: `err-${Date.now()}`, seq: nextSeq(), agent: streamAgent }];
            newStreaming = false;
          }
          if (msg.type === 'result' || msg.type === 'done') {
            const cost = (msg as any).total_cost_usd ?? (msg as any).cost_usd ?? 0;
            newUsage = { ...newUsage, totalCostUsd: newUsage.totalCostUsd + (typeof cost === 'number' ? cost : 0), turns: newUsage.turns + 1, model: (msg as any).model || newUsage.model };
          }
          const done = (msg.type === 'result' || msg.type === 'done' || msg.type === 'error');
          return { ...h, messages: newMsgs, toolTimeline: newTimeline, usage: newUsage, streaming: newStreaming, pendingRequestId: done ? null : h.pendingRequestId, claudeSessionId: newSessId, updatedAt: Date.now() };
        }));
        if (msg.type === 'result' || msg.type === 'done' || msg.type === 'error') {
          if (reqId) {
            requestToHistoryRef.current.delete(reqId);
            requestToAgentRef.current.delete(reqId);
          }
        }
        return;
      }
      // Claude CLI session_id 캡처 (첫 init 또는 아무 메시지에서)
      if (msg.session_id && !claudeSessionIdRef.current) {
        claudeSessionIdRef.current = msg.session_id;
        console.log('[ClaudeChat] captured claude session_id:', msg.session_id);
      }
      if (msg.type === 'assistant' && msg.message?.content) {
        const msgId = msg.message.id || `asst-${Date.now()}`;
        const texts = msg.message.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
        const toolUses = msg.message.content.filter((c: any) => c.type === 'tool_use');
        const thinkings = msg.message.content.filter((c: any) => c.type === 'thinking');
        // 각 assistant 메시지의 usage 누적 (result 이벤트 못 받아도 실시간 반영)
        try {
          const u = (msg.message as any).usage;
          if (u) {
            setUsage(prev => ({
              ...prev,
              inputTokens: prev.inputTokens + (u.input_tokens || 0),
              outputTokens: prev.outputTokens + (u.output_tokens || 0),
              cacheCreationTokens: prev.cacheCreationTokens + (u.cache_creation_input_tokens || 0),
              cacheReadTokens: prev.cacheReadTokens + (u.cache_read_input_tokens || 0),
              lastTurnInput: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
              lastTurnOutput: u.output_tokens || 0,
              lastTurnFreshInput: u.input_tokens || 0,
              lastTurnCacheRead: u.cache_read_input_tokens || 0,
              lastTurnCacheCreate: u.cache_creation_input_tokens || 0,
              model: (msg.message as any).model || prev.model,
            }));
          }
        } catch {}

        // 툴 호출을 타임라인에 추가 (각 tool_use id 별)
        if (toolUses.length > 0) {
          setToolTimeline(prev => {
            const next = [...prev];
            for (const t of toolUses) {
              if (next.find(x => x.id === t.id)) continue;
              const args = JSON.stringify(t.input).slice(0, 120);
              next.push({ id: t.id, label: `🔧 ${t.name}(${args}${args.length >= 120 ? '…' : ''})`, status: 'running', seq: nextSeq() });
            }
            return next;
          });
          setActivity(`🔧 ${toolUses[toolUses.length - 1].name}`);
          // ExitPlanMode 감지 → 승인 다이얼로그 표시
          const exitPlan = toolUses.find((t: any) => t.name === 'ExitPlanMode');
          if (exitPlan && exitPlan.input?.plan) {
            setPendingPlan(String(exitPlan.input.plan));
          }
        }

        // 텍스트가 있으면 메시지로 표시
        if (texts) {
          setMessages(prev => {
            const existing = prev.find(m => m.id === msgId);
            if (existing) {
              return prev.map(m => m.id === msgId ? { ...m, content: texts } : m);
            }
            currentAsstIdRef.current = msgId;
            return [...prev, { role: 'assistant', content: texts, id: msgId, seq: nextSeq(), agent: streamAgent }];
          });
        } else if (thinkings.length > 0 && toolUses.length === 0) {
          setActivity(tt('thinking'));
        }
      } else if (msg.type === 'user' && msg.message?.content) {
        // tool_result 수신 → 타임라인 업데이트
        const results = Array.isArray(msg.message.content) ? msg.message.content.filter((c: any) => c.type === 'tool_result') : [];
        if (results.length > 0) {
          setToolTimeline(prev => prev.map(t => {
            const match = results.find((r: any) => r.tool_use_id === t.id);
            if (!match) return t;
            const content = typeof match.content === 'string' ? match.content : JSON.stringify(match.content);
            const preview = content.slice(0, 80).replace(/\n/g, ' ');
            return { ...t, status: match.is_error ? 'error' : 'done', resultPreview: preview };
          }));
          setActivity('');
        }
      } else if (msg.type === 'result' || msg.type === 'done') {
        // result 이벤트는 cost / turn 카운트만 (토큰은 assistant 이벤트에서 이미 누적)
        try {
          const cost = (msg as any).total_cost_usd ?? (msg as any).cost_usd ?? 0;
          setUsage(prev => ({
            ...prev,
            totalCostUsd: prev.totalCostUsd + (typeof cost === 'number' ? cost : 0),
            turns: prev.turns + 1,
            model: (msg as any).model || prev.model,
          }));
        } catch {}
        setStreaming(false);
        setActivity('');
        currentAsstIdRef.current = null;
        activeRequestIdRef.current = null;
        if (reqId) {
          requestToHistoryRef.current.delete(reqId);
          requestToAgentRef.current.delete(reqId);
        }
        // history 의 streaming/pendingRequestId 정리
        const aid = activeHistoryIdRef.current;
        if (aid) {
          setChatHistory(hList => hList.map(h => h.id === aid ? { ...h, streaming: false, pendingRequestId: null } : h));
        }
      } else if (msg.type === 'error') {
        setMessages(prev => [...prev, { role: 'assistant', content: `❌ ${msg.text}`, id: `err-${Date.now()}`, seq: nextSeq(), agent: streamAgent }]);
        setStreaming(false);
        activeRequestIdRef.current = null;
        if (reqId) {
          requestToHistoryRef.current.delete(reqId);
          requestToAgentRef.current.delete(reqId);
        }
        const aid = activeHistoryIdRef.current;
        if (aid) {
          setChatHistory(hList => hList.map(h => h.id === aid ? { ...h, streaming: false, pendingRequestId: null } : h));
        }
      } else if (msg.type === 'text' && msg.text) {
        setMessages(prev => {
          const asstId = currentAsstIdRef.current;
          if (asstId) return prev.map(m => m.id === asstId ? { ...m, content: m.content + msg.text } : m);
          const newId = `asst-${Date.now()}`;
          currentAsstIdRef.current = newId;
          return [...prev, { role: 'assistant', content: msg.text, id: newId, seq: nextSeq(), agent: streamAgent }];
        });
      }
    });
    return () => { if (dispose) dispose(); };
  }, [sessionId]);

  // Git 상태 자동 갱신 — 활성 SSH 세션 우선, 아니면 로컬 cwd. 메시지 변경 / 세션 전환 시 폴링.
  useEffect(() => {
    let cancelled = false;
    const fetchGit = async () => {
      try {
        const termId = activeSshSession?.termId;
        const params: any = termId ? { mode: 'remote', termId } : { mode: 'local' };
        const r: any = await (window as any).api?.gitStatus?.(params);
        if (cancelled) return;
        if (r?.ok) setGitStatus({ ok: true, branch: r.branch, additions: r.additions, deletions: r.deletions });
        else setGitStatus(null);
      } catch { if (!cancelled) setGitStatus(null); }
    };
    fetchGit();
    const t = setInterval(fetchGit, 15000); // 15s polling
    return () => { cancelled = true; clearInterval(t); };
  }, [activeSshSession?.termId, messages.length]);

  // 자동 스크롤 — 메시지 변경 시 + agent 전환 후 messages 영역이 재마운트될 때
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);
  // installed 가 true 가 되어 chat view 로 돌아왔을 때, scrollRef 가 새로 mount 되므로 즉시 bottom 으로 이동
  useEffect(() => {
    if (installed && messages.length > 0) {
      // mount 직후엔 scrollHeight 가 계산 안 됐을 수 있어 약간의 지연 + 비-smooth 스크롤
      scrollChatToBottom();
      scrollChatToBottom(50);
    }
  }, [installed, scrollChatToBottom]);

  useEffect(() => {
    if (!activeHistoryId || messages.length === 0) return;
    scrollChatToBottom();
    scrollChatToBottom(80);
  }, [activeHistoryId, messages.length, scrollChatToBottom]);

  // Mermaid 다이어그램 렌더링 — messages 변경 / pendingPlan 시 미렌더 mermaid 코드블록을 SVG 로 변환
  useEffect(() => {
    // 메시지 영역 + plan 모달 본문 모두 스캔
    const roots: HTMLElement[] = [];
    if (scrollRef.current) roots.push(scrollRef.current);
    document.querySelectorAll<HTMLElement>('.claude-chat-plan-body').forEach(el => roots.push(el));
    const codeBlocks: HTMLElement[] = [];
    for (const r of roots) {
      r.querySelectorAll<HTMLElement>('pre > code:not([data-mermaid-rendered])').forEach(el => {
        const source = (el.textContent || '').trim();
        if (el.classList.contains('language-mermaid') || MERMAID_START_RE.test(source)) {
          codeBlocks.push(el);
        }
      });
    }
    if (codeBlocks.length === 0) return;
    // body 직속 stale mermaid element 청소 (이전 렌더 실패가 남긴 것)
    try {
      document.querySelectorAll('body > [id^="mermaid-"], body > [id^="dmermaid-"]').forEach(el => {
        if (el.parentElement === document.body) el.remove();
      });
    } catch {}
    (async () => {
      for (let i = 0; i < codeBlocks.length; i++) {
        const codeEl = codeBlocks[i];
        const pre = codeEl.parentElement; // <pre>
        const source = codeEl.textContent || '';
        const id = `mermaid-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`;
        try {
          const { svg } = await mermaid.render(id, source);
          const wrap = document.createElement('div');
          wrap.className = 'claude-chat-mermaid';
          wrap.setAttribute('data-mermaid-rendered', '1');
          // 액션 툴바
          const toolbar = document.createElement('div');
          toolbar.className = 'claude-chat-mermaid-toolbar';
          const mkBtn = (label: string, title: string, onClick: () => void) => {
            const b = document.createElement('button');
            b.className = 'claude-chat-mermaid-btn';
            b.textContent = label;
            b.title = title;
            b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); onClick(); };
            return b;
          };
          const svgHolder = document.createElement('div');
          svgHolder.className = 'claude-chat-mermaid-svg';
          svgHolder.innerHTML = svg;
          // helper: SVG → PNG Blob (data URL 사용 — Electron CSP/blob 이슈 회피)
          const svgToPngBlob = async (scale = 2): Promise<Blob> => {
            const svgEl = svgHolder.querySelector('svg') as SVGSVGElement | null;
            if (!svgEl) throw new Error('svg not found');
            const cloned = svgEl.cloneNode(true) as SVGSVGElement;
            // 크기 결정: viewBox > width/height attr > clientWidth/Height > getBBox > default
            const vb = svgEl.viewBox && svgEl.viewBox.baseVal;
            let w = (vb && vb.width) || 0;
            let h = (vb && vb.height) || 0;
            if (!w || !h) {
              const wAttr = parseFloat(svgEl.getAttribute('width') || '0');
              const hAttr = parseFloat(svgEl.getAttribute('height') || '0');
              if (wAttr) w = wAttr;
              if (hAttr) h = hAttr;
            }
            if (!w || !h) {
              w = svgEl.clientWidth || 0;
              h = svgEl.clientHeight || 0;
            }
            if (!w || !h) {
              try { const bb = svgEl.getBBox(); w = bb.width || 800; h = bb.height || 600; } catch { w = 800; h = 600; }
            }
            cloned.setAttribute('width', String(w));
            cloned.setAttribute('height', String(h));
            if (!cloned.getAttribute('xmlns')) cloned.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
            if (!cloned.getAttribute('xmlns:xlink')) cloned.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
            const xml = new XMLSerializer().serializeToString(cloned);
            // base64 data URL 로 변환 — blob URL 대비 CSP 친화적
            const b64 = btoa(unescape(encodeURIComponent(xml)));
            const dataUrl = `data:image/svg+xml;base64,${b64}`;
            const img = new Image();
            // CORS 회피
            img.crossOrigin = 'anonymous';
            await new Promise<void>((resolve, reject) => {
              img.onload = () => resolve();
              img.onerror = (ev) => reject(new Error('SVG → Image 변환 실패: ' + String(ev)));
              img.src = dataUrl;
            });
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(w * scale));
            canvas.height = Math.max(1, Math.round(h * scale));
            const ctx = canvas.getContext('2d');
            if (!ctx) throw new Error('canvas 2d context 생성 실패');
            ctx.fillStyle = '#0d1320';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            return await new Promise<Blob>((resolve, reject) => {
              canvas.toBlob(b => b ? resolve(b) : reject(new Error('canvas → PNG blob 실패')), 'image/png');
            });
          };
          const downloadBlob = (blob: Blob, filename: string) => {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          };
          const flash = (btn: HTMLButtonElement, text: string) => {
            const orig = btn.textContent;
            btn.textContent = text;
            setTimeout(() => { btn.textContent = orig; }, 1200);
          };
          const ts = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const copySvgBtn = mkBtn('📋 SVG', tt('mermaid.copySvgTitle'), async () => {
            try { await navigator.clipboard.writeText(svg); flash(copySvgBtn, tt('mermaid.copied')); } catch {}
          });
          const copyPngBtn = mkBtn('📋 PNG', tt('mermaid.copyPngTitle'), async () => {
            try {
              const blob = await svgToPngBlob(2);
              // 1차: Electron native clipboard (가장 신뢰성 있음)
              try {
                const dataUrl: string = await new Promise((resolve, reject) => {
                  const r = new FileReader();
                  r.onload = () => resolve(String(r.result));
                  r.onerror = () => reject(r.error);
                  r.readAsDataURL(blob);
                });
                const ipcRes: any = await (window as any).api?.clipboardWriteImage?.(dataUrl);
                if (ipcRes?.success) { flash(copyPngBtn, tt('mermaid.copied')); return; }
              } catch (e) { console.warn('[mermaid] ipc clipboard failed', e); }
              // 2차: Web Clipboard API
              try {
                await (navigator.clipboard as any).write([new (window as any).ClipboardItem({ 'image/png': blob })]);
                flash(copyPngBtn, tt('mermaid.copied'));
                return;
              } catch (e) { console.warn('[mermaid] web clipboard failed', e); }
              flash(copyPngBtn, tt('mermaid.failed'));
            } catch (e) { flash(copyPngBtn, tt('mermaid.failed')); console.error('[mermaid] copy png error', e); }
          });
          const saveSvgBtn = mkBtn('💾 SVG', tt('mermaid.saveSvgTitle'), () => {
            downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), `diagram-${ts()}.svg`);
          });
          const savePngBtn = mkBtn('💾 PNG', tt('mermaid.savePngTitle'), async () => {
            try {
              const blob = await svgToPngBlob(2);
              downloadBlob(blob, `diagram-${ts()}.png`);
            } catch (e) { flash(savePngBtn, tt('mermaid.failed')); console.error(e); }
          });
          toolbar.appendChild(copySvgBtn);
          toolbar.appendChild(copyPngBtn);
          toolbar.appendChild(saveSvgBtn);
          toolbar.appendChild(savePngBtn);
          wrap.appendChild(toolbar);
          wrap.appendChild(svgHolder);
          // 우클릭 컨텍스트 메뉴
          wrap.oncontextmenu = (e) => {
            e.preventDefault();
            e.stopPropagation();
            // 기존 떠있는 메뉴 제거
            document.querySelectorAll('.claude-chat-mermaid-ctx-menu').forEach(m => m.remove());
            const menu = document.createElement('div');
            menu.className = 'claude-chat-mermaid-ctx-menu';
            menu.style.left = `${(e as MouseEvent).clientX}px`;
            menu.style.top = `${(e as MouseEvent).clientY}px`;
            const mkItem = (label: string, onClick: () => void) => {
              const it = document.createElement('div');
              it.className = 'claude-chat-mermaid-ctx-item';
              it.textContent = label;
              it.onclick = (ev) => { ev.stopPropagation(); menu.remove(); onClick(); };
              return it;
            };
            menu.appendChild(mkItem(tt('mermaid.ctxCopyPng'), () => copyPngBtn.click()));
            menu.appendChild(mkItem(tt('mermaid.ctxCopySvg'), () => copySvgBtn.click()));
            menu.appendChild(mkItem(tt('mermaid.ctxSavePng'), () => savePngBtn.click()));
            menu.appendChild(mkItem(tt('mermaid.ctxSaveSvg'), () => saveSvgBtn.click()));
            const closeMenu = () => { menu.remove(); document.removeEventListener('click', closeMenu); document.removeEventListener('contextmenu', closeMenu); };
            setTimeout(() => {
              document.addEventListener('click', closeMenu);
              document.addEventListener('contextmenu', closeMenu);
            }, 0);
            document.body.appendChild(menu);
          };
          if (pre && pre.parentElement) {
            pre.parentElement.replaceChild(wrap, pre);
          }
        } catch (err) {
          codeEl.setAttribute('data-mermaid-rendered', 'error');
          const err1 = document.createElement('div');
          err1.className = 'claude-chat-mermaid-error';
          err1.textContent = tt('mermaid.renderFailed', { msg: String(err).slice(0, 200) });
          if (pre && pre.parentElement) pre.parentElement.insertBefore(err1, pre);
          // mermaid 가 body 에 남긴 에러 SVG/임시 element 정리 (id 기반)
          try {
            const stale = document.getElementById(id);
            stale?.parentElement?.removeChild(stale);
            // 추가 안전장치: 'd' + id 형태의 임시 element 도 mermaid 가 사용
            const stale2 = document.getElementById('d' + id);
            stale2?.parentElement?.removeChild(stale2);
          } catch {}
        }
      }
    })();
  }, [messages, toolTimeline, pendingPlan, currentAgent, activeHistoryId, installed]);

  // 메시지/세션ID 변경 시 활성 이력 항목에 동기화
  // 단, 활성 이력이 막 전환되었을 때(loadHistory 직후) 의 첫 실행은 스킵 — 그렇지 않으면
  // 이전 messages 값이 새 active 항목으로 흘러들어가 이력 내용을 덮어씀
  const lastSyncedHistoryIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeHistoryId) {
      lastSyncedHistoryIdRef.current = null;
      return;
    }
    if (lastSyncedHistoryIdRef.current !== activeHistoryId) {
      // 전환 직후 — 이번 effect 는 sync 스킵, 다음 messages 변경부터 실제 동기화
      lastSyncedHistoryIdRef.current = activeHistoryId;
      return;
    }
    setChatHistory(h => h.map(x => x.id === activeHistoryId
      ? { ...x, messages, toolTimeline, usage, lastRejectedPlan, updatedAt: Date.now(), claudeSessionId: claudeSessionIdRef.current ?? x.claudeSessionId }
      : x));
  }, [messages, toolTimeline, usage, lastRejectedPlan, activeHistoryId]);

  const send = useCallback(async (text: string, contextItems: FileContextItem[]) => {
    if (!text.trim() || streaming) return;
    // 이번 send 의 대화 세대 기록 — 이후 도착하는 stream 이벤트가 이 세대에 속한 경우만 처리
    activeGenRef.current = conversationGenRef.current;
    // 이번 send 의 고유 requestId
    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    activeRequestIdRef.current = requestId;
    let prompt = text;
    let attachBadge = '';
    const addDirsSet = new Set<string>();
    const contextLines: string[] = [];

    // 0.A) 포크/이력 후속 질문이면 작업 대상을 prompt 최상단 + user text 에 직접 명시
    let forkOriginalRequest: string | null = null;
    let forkTargetPath: string | null = null;
    if (!claudeSessionIdRef.current && messages.length > 0) {
      const firstUserMsg = messages.find(m => m.role === 'user');
      if (firstUserMsg) {
        const cleaned = firstUserMsg.content
          .split('\n')
          .filter(l => !/^(🔗|📂|📎|📁)\s/.test(l) && l.trim() !== '')
          .join('\n')
          .trim();
        if (cleaned) {
          forkOriginalRequest = cleaned;
          // Unix 절대경로(/foo/bar)나 Windows UNC 패턴 추출 — 가장 그럴듯한 작업 대상 path
          const pathMatch = cleaned.match(/(\/[A-Za-z0-9_\-./]+|\\\\127\.0\.0\.1@\d+\\DavWWWRoot\\[^\s"')]+)/);
          if (pathMatch) forkTargetPath = pathMatch[0];
          contextLines.push(
            `# ⚠ 이번 질문의 작업 대상 (반드시 준수)`,
            `사용자는 이전 대화의 연속으로 후속 질문을 합니다. 이전 대화의 **첫 요청**은:`,
            ``,
            `> ${cleaned.replace(/\n/g, '\n> ')}`,
            ``,
            forkTargetPath ? `**작업 대상 절대 경로: \`${forkTargetPath}\`** (모든 파일 탐색/읽기는 이 경로 하위로 한정)` : '',
            `**이번 후속 질문은 위 요청에서 다룬 그 코드/시스템에 대한 것입니다.**`,
            `다른 프로젝트(특히 Claude 의 cwd, 사용자 home 의 다른 프로젝트, 무관한 디렉토리)를 절대 분석/탐색하지 마세요.`,
            `\`ls\` / \`find\` / \`pwd\` 등으로 cwd 나 home 을 탐색하지 마세요. 작업 대상은 이미 위에 명시되었습니다.`,
            ``,
          );
        }
      }
    }

    // 0) 활성 SSH 세션: 전체 파일시스템이 WebDAV 에 마운트됨 — 자동 context 주입
    if (activeMount) {
      addDirsSet.add(activeMount.mountRoot);

      // 사용자 메시지에서 Unix 절대 경로 추출 → UNC 번역 매핑 생성
      const unixPathRegex = /\/[A-Za-z0-9_\-./]+/g;
      const matches = Array.from(new Set(text.match(unixPathRegex) || []));
      const pathMappings = matches
        .filter(p => p.length > 2 && !p.startsWith('//'))
        .map(p => {
          const uncRel = p.replace(/^\/+/, '').replace(/\//g, '\\');
          return { unix: p, unc: `${activeMount.mountRoot}\\${uncRel}` };
        });

      contextLines.push(
        `# 중요: 원격 SSH 파일 접근 규칙`,
        ``,
        `현재 SSH 세션: **${activeMount.label}**`,
        `이 세션의 원격 Linux 파일시스템 전체가 로컬 WebDAV 에 마운트되어 있습니다.`,
        ``,
        `## 경로 매핑 규칙`,
        `- 원격 Unix 루트 \`/\` ↔ 로컬 UNC \`${activeMount.mountRoot}\\\``,
        `- 원격 \`/a/b/c.txt\` ↔ 로컬 \`${activeMount.mountRoot}\\a\\b\\c.txt\``,
        ``,
        `## 도구 사용 규칙 (반드시 준수)`,
        `❌ **로컬 Bash 툴을 쓰지 마세요** — 이 시스템은 Windows 이며 Unix 경로 \`/view/...\` 를 Bash 로 접근할 수 없습니다.`,
        `✅ **파일 읽기/탐색**: Read / Glob / Grep / LS 툴을 UNC 경로로 호출`,
        `✅ **파일 편집/작성**: Edit / Write 툴을 UNC 경로로 호출 (실제 원격 SSH 서버에 실시간 반영됨)`,
        `✅ **원격 명령 실행 (cleartool, ctco, make, git 등)**: \`mcp__pepe_ssh__ssh_exec\` 툴 사용 — command 만 원격 Unix 경로로 전달 (UNC 변환 NO). 예: \`ssh_exec(command="ctco /view/.../file.c")\``,
        `✅ 파일 경로가 언급되면: 파일 I/O 는 UNC 변환, 쉘 명령 argument 는 Unix 경로 그대로`,
        ``,
      );

      if (pathMappings.length > 0) {
        contextLines.push(`## 이번 질문에서 감지된 경로 (미리 번역됨)`);
        for (const m of pathMappings) {
          contextLines.push(`- 원격: \`${m.unix}\` → 로컬 UNC: \`${m.unc}\``);
        }
        contextLines.push('');
      }

      contextLines.push(`분석 결과를 말할 때는 **원격 Unix 경로 기준**으로 설명해주세요 (사용자가 이해하기 쉽게).`);
    }

    // 0.5) 사용자 메시지에서 Windows 로컬 절대 경로 자동 감지 → --add-dir 추가
    // 예: C:\IPAGEON, D:\Work\file.txt → 부모 디렉토리까지 포함
    const winPathRegex = /[A-Za-z]:[\\/][^\s"'<>|?*\n]+/g;
    const newWinPaths = Array.from(new Set((text.match(winPathRegex) || []).map(p => p.replace(/[/]/g, '\\'))));
    // 이번 메시지에서 발견된 경로를 누적 저장. --add-dir 는 디렉토리만 허용하므로
    // 항상 부모 디렉토리를 저장 (파일이 대상이어도 Claude 는 부모 dir 안에서 접근 가능)
    for (const p of newWinPaths) {
      const parent = p.replace(/\\[^\\]+$/, '');
      // 최상위 드라이브(C:\)만 있으면 그대로
      if (/^[A-Za-z]:\\?$/.test(p)) {
        recentLocalPathsRef.current.add(p.replace(/\\?$/, '\\'));
        continue;
      }
      if (parent && /^[A-Za-z]:\\/.test(parent)) {
        recentLocalPathsRef.current.add(parent);
      }
    }
    // 누적된 모든 로컬 경로를 --add-dir 에 추가
    const winPaths = Array.from(recentLocalPathsRef.current);
    if (winPaths.length > 0) {
      for (const lp of winPaths) addDirsSet.add(lp);
      const localPathLines = winPaths.slice(0, 10).map(p => `- \`${p}\``);
      contextLines.push(
        `[로컬 경로 접근 허용]`,
        `다음 로컬 경로들이 작업 범위에 포함되어 있습니다:`,
        ...localPathLines,
        `이 경로에 대해 Read/Write/Edit/LS/Bash 툴을 정상 사용할 수 있습니다. 대화 중 언급된 이전 경로들도 계속 유효합니다.`,
        ``,
      );
    }

    // 0.9) 다이어그램/플로우차트는 반드시 Mermaid 코드 블록으로 — ASCII 박스 드로잉 금지
    contextLines.push(
      `# 다이어그램 출력 규칙 (반드시 준수)`,
      `다이어그램(DFD, 플로우차트, 시퀀스, 클래스 등)을 그릴 때는 **반드시 \`\`\`mermaid 코드 블록**으로 출력하세요.`,
      `**절대 금지**: ASCII 박스 드로잉(─│┌┐└┘╔╗╚╝═║▶◀ 등) 으로 그리지 마세요.`,
      `이유: 사용자 환경은 Mermaid 를 자동으로 SVG 로 렌더링합니다. ASCII 아트는 한글-라틴 혼합 시 정렬이 깨져 보입니다.`,
      `예시: 플로우차트 → \`\`\`mermaid\\nflowchart TB\\n  A[Application] --> B[UEnc Library]\\n\`\`\``,
      ``,
    );

    // 1) 개별 WebDAV 마운트 첨부 (파일/폴더 우클릭 → Claude 첨부)
    if (mountEntries.length > 0) {
      for (const m of mountEntries) addDirsSet.add(m.uncPath);
      const pathMap = mountEntries.map(m =>
        `- \`${m.remotePath}\`${m.isDir ? '/' : ''} ← \`${m.uncPath}\``
      ).join('\n');
      contextLines.push('', '[명시적으로 첨부된 파일/폴더]', pathMap);
      attachBadge = `📂 첨부 ${mountEntries.length}개:\n${mountEntries.slice(0, 5).map(m => `• ${m.remotePath}${m.isDir ? '/' : ''}`).join('\n')}${mountEntries.length > 5 ? `\n외 ${mountEntries.length - 5}개` : ''}\n\n`;
    } else if (activeMount) {
      attachBadge = `🔗 활성 SSH: ${activeMount.label}\n\n`;
    }

    // 0.7) 포크/리로드된 대화 — 이전 메시지가 있으면 컨텍스트로 inject.
    // Claude: --resume 없이 새 세션이면 주입. Gemini/Codex: 항상 주입 (세션 개념 없음).
    if (messages.length > 0) {
      // 메시지와 툴 호출을 seq 순으로 인터리브
      type TItem = { seq: number; kind: 'msg'; m: Message } | { seq: number; kind: 'tool'; t: ToolTimelineItem };
      const items: TItem[] = [
        ...messages.map((m, i) => ({ seq: m.seq ?? i * 2, kind: 'msg' as const, m })),
        ...toolTimeline.map((t, i) => ({ seq: t.seq ?? (messages.length * 2 + i * 2 + 1), kind: 'tool' as const, t })),
      ];
      items.sort((a, b) => a.seq - b.seq);
      // 오래된 transcript 안의 UNC mountRoot 는 현재 세션과 다를 수 있음 (포트/termId 매 세션 변경).
      // 현재 active mountRoot 가 있으면 모든 옛 \\127.0.0.1@PORT\DavWWWRoot\term-XXX 패턴을 현재 것으로 치환.
      const sanitizeUNC = (s: string): string => {
        if (!activeMount) return s;
        const oldUncRe = /\\\\127\.0\.0\.1@\d+\\DavWWWRoot\\term-[^\\\s"')]+/g;
        return s.replace(oldUncRe, activeMount.mountRoot);
      };
      const transcriptLines: string[] = [];
      for (const it of items) {
        if (it.kind === 'msg') {
          const who = it.m.role === 'user' ? '사용자' : it.m.agent === 'gemini' ? 'Gemini' : it.m.agent === 'codex' ? 'Codex' : 'Claude';
          transcriptLines.push(`### ${who}`, sanitizeUNC(it.m.content), '');
        } else {
          const status = it.t.status === 'done' ? '✓' : it.t.status === 'error' ? '✕' : '⏳';
          transcriptLines.push(`### [툴 호출 ${status}] ${sanitizeUNC(it.t.label)}`);
          if (it.t.resultPreview) transcriptLines.push(`결과: ${sanitizeUNC(it.t.resultPreview)}`);
          transcriptLines.push('');
        }
      }
      contextLines.push(
        `# 이전 대화 내역 (포크/이어쓰기 — 매우 중요)`,
        `당신(${currentAgentRef.current === 'gemini' ? 'Gemini' : currentAgentRef.current === 'codex' ? 'Codex' : 'Claude'})은 새 CLI 세션에서 시작했지만, 사용자는 아래 대화의 연속으로 이번 질문을 합니다.`,
        `**핵심 지침:**`,
        `- 이번 질문의 작업/분석 **대상은 아래 transcript 에서 사용자가 다루던 그 코드/시스템**입니다 (transcript 의 ${currentAgentRef.current === 'gemini' ? 'Gemini' : currentAgentRef.current === 'codex' ? 'Codex' : 'Claude'} 답변 안에 명시된 경로/모듈/구조).`,
        `- 절대로 다른 프로젝트(특히 ${currentAgentRef.current === 'gemini' ? 'Gemini' : currentAgentRef.current === 'codex' ? 'Codex' : 'Claude'} 프로세스의 cwd 인 Electron 앱)를 분석/탐색하지 마세요.`,
        `- 이전에 분석/탐색한 내용은 이미 알고 있는 것으로 간주하고 그 결과를 활용하세요.`,
        `- 동일한 파일/디렉토리를 다시 읽거나 탐색하지 마세요. 필요하면 이전 결과를 참조하세요.`,
        `- 사용자에게 "이전 대화를 다시 알려주세요" 같은 요청을 하지 마세요.`,
        `- **AskUserQuestion 같은 명료화 도구를 절대 사용하지 마세요.** 정보가 부족하면 transcript 에서 가장 합리적인 가정을 세우고 그 가정을 명시한 채 답변을 진행하세요.`,
        `- 사용자가 짧은 후속 질문을 했다면(예: "DFD 그려줘", "정리해줘", "구조 보여줘") 그것은 transcript 에서 다룬 시스템에 대한 추가 작업입니다.`,
        `- 이번 질문은 위 분석/대화의 연장입니다.`,
        ``,
        ...transcriptLines,
        `---`,
        ``,
      );
    }

    if (contextLines.length > 0) {
      // 포크 후속 질문이면 user text 자체에 작업 대상을 prepend (system context 외에도 user msg 단에서 명시)
      const userTextWithTarget = forkTargetPath
        ? `[이전 대화에서 다룬 작업 대상: ${forkTargetPath}\n원래 요청: "${forkOriginalRequest?.replace(/\n/g, ' ').slice(0, 200)}"]\n\n위 작업의 후속 질문:\n${text}`
        : text;
      prompt = `${contextLines.join('\n')}\n\n---\n\n${userTextWithTarget}`;
    }

    // 2) 인라인 파일 컨텍스트 (FileEditor Claude 버튼용 - 레거시)
    if (contextItems.length > 0) {
      const fileBlocks = contextItems.map(c => `파일 \`${c.remotePath}\`:\n\`\`\`\n${c.content}\n\`\`\``).join('\n\n');
      prompt = `${fileBlocks}\n\n${prompt}`;
      attachBadge += `📎 인라인 ${contextItems.length}개 파일\n\n`;
    }

    // 3) 로컬 PC 파일 첨부
    if (localFileAttachments.length > 0) {
      const fileBlocks = localFileAttachments.map(c => `로컬 파일 \`${c.name}\`:\n\`\`\`\n${c.content}\n\`\`\``).join('\n\n');
      prompt = `${fileBlocks}\n\n${prompt}`;
      attachBadge += `📁 로컬 ${localFileAttachments.length}개 파일\n\n`;
    }

    const userMsg: Message = { role: 'user', content: attachBadge + text, id: `user-${Date.now()}`, seq: nextSeq() };
    // 활성 이력 없으면 새 이력 생성 (setMessages updater 밖에서 — strict mode 중복 방지)
    // 클로저 stale 방지 — 현재 활성 history 는 ref 에서 읽기 (포크/이력전환 직후 send 시점 보정)
    let targetHid = activeHistoryIdRef.current;
    if (!targetHid) {
      const newId = `hist-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const newHist: ChatHistoryEntry = {
        id: newId,
        claudeSessionId: claudeSessionIdRef.current,
        title: text.slice(0, 60).replace(/\n/g, ' '),
        pinned: false,
        updatedAt: Date.now(),
        messages: [userMsg],
        pendingRequestId: requestId,
        streaming: true,
      };
      setChatHistory(h => [newHist, ...h]);
      setActiveHist(newId);
      targetHid = newId;
    } else {
      // 기존 이력에 진행 상태 마킹
      setChatHistory(h => h.map(x => x.id === targetHid ? { ...x, pendingRequestId: requestId, streaming: true } : x));
    }
    // requestId → historyId 매핑 등록 (활성 전환 후에도 stream 이 정확한 history 에 도달하도록)
    requestToHistoryRef.current.set(requestId, targetHid);
    requestToAgentRef.current.set(requestId, currentAgentRef.current);
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setStreaming(true);
    setActivity(tt('started'));
    setToolTimeline([]);
    currentAsstIdRef.current = null;

    const addDirs = addDirsSet.size > 0 ? Array.from(addDirsSet) : undefined;
    // 활성 SSH 세션이 선택되어 있으면 Bash 금지 + MCP ssh_exec 툴 제공
    // (activeMount 가 아직 준비 전이라도 MCP 는 사용 가능해야 함)
    const sshTermId = activeSshSession?.termId || activeMount?.termId;
    // 전송 후 로컬 파일 첨부는 해제
    setLocalFileAttachments([]);
    try {
      if (currentAgentRef.current === 'gemini') {
        await (window as any).api?.geminiSend?.(sessionId, prompt, requestId, model, geminiYolo);
      } else if (currentAgentRef.current === 'codex') {
        await (window as any).api?.codexSend?.(sessionId, prompt, requestId, model, codexApprovalPolicy, effort);
      } else {
        const disallowBash = !!sshTermId;
        const resumeSessionId = claudeSessionIdRef.current;
        // 비대화형 모드(-p)에서는 'default' 권한이 항상 거부됨 → 대신 'plan' 모드로 변환
        const approveKeywords = ['실행', '진행', '좋아', 'yes', 'ok', '승인', 'approve', '해줘', 'go ahead', '네'];
        const isApproval = approveKeywords.some(k => text.toLowerCase().includes(k.toLowerCase()));
        let effectivePermMode: string = permissionMode;
        if (permissionMode === 'default') {
          effectivePermMode = (isApproval && claudeSessionIdRef.current) ? 'bypassPermissions' : 'plan';
        }
        // Plan 모드에서는 Claude 에게 ExitPlanMode 툴 사용을 명확히 지시
        if (effectivePermMode === 'plan') {
          contextLines.push(
            `# Plan 모드 지침 (반드시 준수)`,
            `- 당신은 현재 Plan 모드로 실행되고 있습니다. 이것은 비대화형 모드이므로 사용자가 "/plan" 토글이나 모드 전환을 할 수 없습니다.`,
            `- 파일 수정/생성/명령 실행이 필요하면 **반드시 ExitPlanMode 툴을 호출**해서 plan 파라미터에 계획을 담아 제시하세요.`,
            `- ExitPlanMode 툴이 호출되면 외부 UI 에서 사용자에게 승인 모달이 표시되고, 승인 시 다음 턴에 실제로 실행됩니다.`,
            `- 사용자에게 "/plan 을 입력하세요" / "Plan 모드를 종료하세요" 같은 안내를 하지 마세요. 당신이 직접 ExitPlanMode 를 호출해야 합니다.`,
            `- 변경이 필요 없으면 ExitPlanMode 없이 정보만 응답하세요.`,
            ``,
          );
        }
        await (window as any).api?.claudeSend?.(sessionId, prompt, addDirs, disallowBash, sshTermId, resumeSessionId, effectivePermMode, model, perToolApproval, requestId, effort);
      }
    } catch (err: any) {
      setMessages(prev => [...prev, { role: 'assistant', content: `❌ ${err}`, id: `err-${Date.now()}`, seq: nextSeq() }]);
      setStreaming(false);
    }
  }, [sessionId, streaming, mountEntries, activeMount, localFileAttachments, permissionMode, model, perToolApproval, messages, toolTimeline]);

  // 외부에서 컨텍스트 전달되면 추가 (기존 첨부에 append, 중복 제거)
  useEffect(() => {
    if (pendingContext && pendingContext.length > 0) {
      setAttachments(prev => {
        const map = new Map(prev.map(p => [p.remotePath, p]));
        for (const c of pendingContext) map.set(c.remotePath, c);
        return Array.from(map.values());
      });
      if (!input.trim()) setInput(tt('analyzeFilePrompt'));
      onContextConsumed();
    }
  }, [pendingContext, onContextConsumed]);

  const handleSend = () => {
    send(input, attachments);
    setAttachments([]);
  };

  const removeAttachment = (path: string) => {
    setAttachments(prev => prev.filter(a => a.remotePath !== path));
  };
  const clearAllAttachments = () => setAttachments([]);

  const stop = () => {
    // 명시적 중단 — 활성 대화의 프로세스만 죽임
    const reqId = activeRequestIdRef.current;
    const reqAgent = (reqId ? requestToAgentRef.current.get(reqId) : null) || currentAgentRef.current;
    try {
      if (reqAgent === 'gemini') {
        (window as any).api?.geminiStop?.(sessionId, reqId || undefined);
      } else if (reqAgent === 'codex') {
        (window as any).api?.codexStop?.(sessionId, reqId || undefined);
      } else {
        (window as any).api?.claudeStop?.(sessionId, reqId || undefined);
      }
    } catch {}
    if (reqId) {
      requestToHistoryRef.current.delete(reqId);
      requestToAgentRef.current.delete(reqId);
    }
    activeRequestIdRef.current = null;
    setStreaming(false);
    setActivity('');
    currentAsstIdRef.current = null;
    if (activeHistoryId) {
      setChatHistory(h => h.map(x => x.id === activeHistoryId ? { ...x, streaming: false, pendingRequestId: null } : x));
    }
  };

  const clear = () => {
    // 새 대화 시작 — 진행 중 백그라운드 프로세스는 살려두고 (그 history 에서 계속 응답 받도록) UI 만 리셋
    activeRequestIdRef.current = null;
    setMessages([]);
    setToolTimeline([]);
    setActivity('');
    setPendingPlan(null);
    setStreaming(false);
    claudeSessionIdRef.current = null;
    recentLocalPathsRef.current.clear();
    currentAsstIdRef.current = null;
    setActiveHist(null);
    setUsage({ inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalCostUsd: 0, turns: 0, lastTurnInput: 0, lastTurnOutput: 0, lastTurnFreshInput: 0, lastTurnCacheRead: 0, lastTurnCacheCreate: 0, model: '' });
    setLastRejectedPlan(null);
  };
  const startNewConversation = () => {
    clear();
    setShowHistoryPanel(false);
  };
  const loadHistory = (h: ChatHistoryEntry) => {
    // 동일 대화 재선택 — 진행 중 상태 그대로 유지하고 패널만 닫는다
    if (activeHistoryId === h.id) {
      setShowHistoryPanel(false);
      return;
    }
    // 다른 대화로 전환 — 백그라운드 프로세스는 죽이지 않고 진행 상태 복원
    setMessages(h.messages);
    bumpSeqFor(h.messages, h.toolTimeline || []);
    // 옛 Claude CLI session_id 는 만료되었을 수 있어 --resume 실패함.
    // null 로 두면 send() 가 transcript 를 inject 해 새 세션으로 안전하게 진행. 첫 send 후 새 session_id 자동 캡처.
    claudeSessionIdRef.current = null;
    // 이전 대화에서 누적된 로컬 경로 — 다른 대화로 전환 시 클리어
    recentLocalPathsRef.current.clear();
    setActiveHist(h.id);
    setToolTimeline(h.toolTimeline || []);
    setLastRejectedPlan(h.lastRejectedPlan || null);
    // 사용량 복원 (없으면 0 으로 초기화)
    setUsage(h.usage || { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalCostUsd: 0, turns: 0, lastTurnInput: 0, lastTurnOutput: 0, lastTurnFreshInput: 0, lastTurnCacheRead: 0, lastTurnCacheCreate: 0, model: '' });
    // h.streaming 이 true 라도 실제 진행 중 프로세스 매핑(requestToHistoryRef) 에 없으면 stale → 입력 잠김 방지
    const reallyStreaming = !!(h.streaming && h.pendingRequestId && requestToHistoryRef.current.get(h.pendingRequestId) === h.id);
    setStreaming(reallyStreaming);
    setActivity(reallyStreaming ? tt('thinking') : '');
    setPendingPlan(null);
    activeRequestIdRef.current = reallyStreaming ? (h.pendingRequestId ?? null) : null;
    // stale streaming 이면 history 도 정리
    if (h.streaming && !reallyStreaming) {
      setChatHistory(hList => hList.map(x => x.id === h.id ? { ...x, streaming: false, pendingRequestId: null } : x));
    }
    currentAsstIdRef.current = null;
    setShowHistoryPanel(false);
  };
  const deleteHistory = (id: string) => {
    // 삭제 대상 history 의 진행 중 프로세스 종료 + 매핑 정리
    for (const [reqId, hid] of Array.from(requestToHistoryRef.current.entries())) {
      if (hid === id) {
        const reqAgent = requestToAgentRef.current.get(reqId) || currentAgentRef.current;
        try {
          if (reqAgent === 'gemini') {
            (window as any).api?.geminiStop?.(sessionId, reqId);
          } else if (reqAgent === 'codex') {
            (window as any).api?.codexStop?.(sessionId, reqId);
          } else {
            (window as any).api?.claudeStop?.(sessionId, reqId);
          }
        } catch {}
        requestToHistoryRef.current.delete(reqId);
        requestToAgentRef.current.delete(reqId);
      }
    }
    setChatHistory(h => h.filter(x => x.id !== id));
    if (activeHistoryId === id) clear();
  };
  const togglePinHistory = (id: string) => {
    setChatHistory(h => h.map(x => x.id === id ? { ...x, pinned: !x.pinned } : x));
  };
  const renameHistory = (id: string, newTitle: string) => {
    setChatHistory(h => h.map(x => x.id === id ? { ...x, title: newTitle } : x));
  };

  // 계획 승인 — "진행해줘" 메시지로 bypass 모드 send 자동 실행
  // streaming 상태 race 방지용 — 승인 시점에 streaming 이 아직 true 면 끝나기를 기다렸다 send
  const pendingApprovalSendRef = useRef<string | null>(null);
  const approvePlan = () => {
    // 편집 모드면 수정된 계획 내용으로 진행. 원본과 동일하면 기본 메시지.
    const edited = planEditing ? planEditedText.trim() : '';
    const original = (pendingPlan || '').trim();
    const extra = planExtraNote.trim();
    setPendingPlan(null);
    setPlanEditing(false);
    setPlanEditedText('');
    setPlanExtraNote('');
    setLastRejectedPlan(null);
    let text = (edited && edited !== original)
      ? `다음 계획대로 진행해줘:\n\n${edited}`
      : '위 계획대로 진행해줘';
    if (extra) text += `\n\n[추가 요구사항]\n${extra}`;
    console.log('[ClaudeChat] approvePlan, streaming=', streaming);
    if (streaming) {
      pendingApprovalSendRef.current = text;
      const reqId = activeRequestIdRef.current;
      const reqAgent = (reqId ? requestToAgentRef.current.get(reqId) : null) || currentAgentRef.current;
      if (reqId) {
        try {
          if (reqAgent === 'gemini') {
            (window as any).api?.geminiStop?.(sessionId, reqId);
          } else if (reqAgent === 'codex') {
            (window as any).api?.codexStop?.(sessionId, reqId);
          } else {
            (window as any).api?.claudeStop?.(sessionId, reqId);
          }
        } catch {}
      }
    } else {
      send(text, []);
    }
  };
  // streaming 이 false 가 되면 큐잉된 승인 메시지 자동 전송
  useEffect(() => {
    if (!streaming && pendingApprovalSendRef.current) {
      const pendingTxt = pendingApprovalSendRef.current;
      pendingApprovalSendRef.current = null;
      // 다음 tick 에 send (현재 render cycle 영향 회피)
      setTimeout(() => send(pendingTxt, []), 0);
    }
  }, [streaming, send]);
  const rejectPlan = () => {
    setPlanEditing(false);
    setPlanEditedText('');
    setPlanExtraNote('');
    setPendingPlan(prev => { if (prev) setLastRejectedPlan(prev); return null; });
    setMessages(prev => [...prev, { role: 'assistant', content: tt('planRejected'), id: `reject-${Date.now()}` }]);
  };

  // 툴 단위 승인/거부
  const approveTool = () => {
    if (!pendingToolApproval) return;
    (window as any).api?.claudeHookRespond?.(pendingToolApproval.approvalId, 'allow');
    setPendingToolApproval(null);
  };
  const denyTool = () => {
    if (!pendingToolApproval) return;
    (window as any).api?.claudeHookRespond?.(pendingToolApproval.approvalId, 'deny', tt('userDenied'));
    setPendingToolApproval(null);
  };

  // 로컬 PC 파일/폴더 업로드 → 인라인 첨부
  const BINARY_LOCAL_EXT = new Set(['png','jpg','jpeg','gif','bmp','ico','webp','zip','gz','tar','bz2','7z','rar','exe','dll','so','dylib','bin','pdf','mp3','mp4','avi','mkv','wav','flac','ogg','class','o','a','obj','lib','pyc','woff','woff2','ttf','otf','eot']);
  const EXCLUDE_FOLDER_DIR = new Set(['node_modules','.git','.svn','dist','build','__pycache__','.venv','venv','.next','target','coverage','.cache','.idea','.vscode']);

  const onFilePicked = async (files: FileList | null, opts: { fromFolder?: boolean; maxFiles?: number; maxPerFileKB?: number; maxTotalMB?: number } = {}) => {
    if (!files || files.length === 0) return;
    const { fromFolder = false, maxFiles = fromFolder ? 50 : 20, maxPerFileKB = 500, maxTotalMB = 5 } = opts;
    const added: { name: string; content: string }[] = [];
    const skipped: string[] = [];
    let totalBytes = 0;
    for (const f of Array.from(files)) {
      if (added.length >= maxFiles) { skipped.push(`${(f as any).webkitRelativePath || f.name} (개수 제한 ${maxFiles})`); continue; }
      if (totalBytes > maxTotalMB * 1024 * 1024) { skipped.push(`${f.name} (총 크기 제한)`); continue; }
      const relPath = (f as any).webkitRelativePath || f.name;
      // 폴더 업로드 시 제외 디렉토리 스킵
      if (fromFolder) {
        const parts = relPath.split(/[\\/]/);
        if (parts.some((p: string) => EXCLUDE_FOLDER_DIR.has(p))) { skipped.push(`${relPath} (제외 폴더)`); continue; }
      }
      const ext = f.name.split('.').pop()?.toLowerCase() || '';
      if (BINARY_LOCAL_EXT.has(ext)) { skipped.push(`${relPath} (바이너리)`); continue; }
      if (f.size > maxPerFileKB * 1024) { skipped.push(`${relPath} (${(f.size / 1024).toFixed(0)}KB > ${maxPerFileKB}KB)`); continue; }
      try {
        const text = await f.text();
        added.push({ name: relPath, content: text });
        totalBytes += f.size;
      } catch (err: any) {
        skipped.push(`${relPath} (읽기 실패)`);
      }
    }
    if (added.length > 0) setLocalFileAttachments(prev => [...prev, ...added]);
    if (skipped.length > 0) console.log(`[local-attach] 제외 ${skipped.length}개:`, skipped);
    if (added.length === 0 && skipped.length > 0) {
      setMessages(prev => [...prev, { role: 'assistant', content: tt('errorNoTextFiles', { count: skipped.length }), id: `err-${Date.now()}`, seq: nextSeq() }]);
    }
  };

  // 슬래시 명령 프리셋
  const commandPresets: { label: string; insert: string; desc: string }[] = [
    { label: '/explain', insert: tt('slashCmd.explainInsert'), desc: tt('slashCmd.explainDesc') },
    { label: '/refactor', insert: tt('slashCmd.refactorInsert'), desc: tt('slashCmd.refactorDesc') },
    { label: '/fix', insert: tt('slashCmd.fixInsert'), desc: tt('slashCmd.fixDesc') },
    { label: '/test', insert: tt('slashCmd.testInsert'), desc: tt('slashCmd.testDesc') },
    { label: '/review', insert: tt('slashCmd.reviewInsert'), desc: tt('slashCmd.reviewDesc') },
    { label: '/doc', insert: tt('slashCmd.docInsert'), desc: tt('slashCmd.docDesc') },
    { label: '/trace', insert: tt('slashCmd.traceInsert'), desc: tt('slashCmd.traceDesc') },
    { label: '/analyze', insert: tt('slashCmd.analyzeInsert'), desc: tt('slashCmd.analyzeDesc') },
    { label: '/optimize', insert: tt('slashCmd.optimizeInsert'), desc: tt('slashCmd.optimizeDesc') },
    { label: '/security', insert: tt('slashCmd.securityInsert'), desc: tt('slashCmd.securityDesc') },
  ];

  // 명령 팔레트 전체 액션 (섹션별)
  type PaletteAction = { id: string; section: string; label: string; desc?: string; shortcut?: string; icon?: React.ReactNode; run: () => void };

  // 에이전트별 Model 섹션
  const paletteModelActions: PaletteAction[] = currentAgent === 'codex'
    ? [
        { id: 'model-gpt55',    section: 'Model', label: 'Model: GPT-5.5 (기본)',  desc: '🚀',  run: () => setModel('gpt-5.5') },
        { id: 'model-gpt54',    section: 'Model', label: 'Model: GPT-5.4',        desc: '🔵',  run: () => setModel('gpt-5.4') },
        { id: 'model-gpt54m',   section: 'Model', label: 'Model: GPT-5.4 Mini',   desc: '⚡',  run: () => setModel('gpt-5.4-mini') },
        { id: 'model-gpt53c',   section: 'Model', label: 'Model: GPT-5.3 Codex',  desc: '🧠',  run: () => setModel('gpt-5.3-codex') },
        { id: 'model-gpt52',    section: 'Model', label: 'Model: GPT-5.2',        desc: '🟣',  run: () => setModel('gpt-5.2') },
        { id: 'model-codexmini',section: 'Model', label: 'Model: Codex Mini (API키 전용)', desc: '🧠', run: () => setModel('codex-mini-latest') },
        { id: 'model-o4mini',   section: 'Model', label: 'Model: o4-mini (API키 전용)',    desc: '⚡', run: () => setModel('o4-mini') },
        { id: 'model-o3',       section: 'Model', label: 'Model: o3 (API키 전용)',         desc: '🔵', run: () => setModel('o3') },
        { id: 'model-gpt4o',    section: 'Model', label: 'Model: GPT-4o (API키 전용)',     desc: '🟢', run: () => setModel('gpt-4o') },
      ]
    : currentAgent === 'gemini'
    ? [
        { id: 'model-g31pro',   section: 'Model', label: 'Model: Gemini 3.1 Pro',            desc: '✨', run: () => setModel('gemini-3.1-pro') },
        { id: 'model-g31prev',  section: 'Model', label: 'Model: Gemini 3.1 Pro Preview',     desc: '✨', run: () => setModel('gemini-3.1-pro-preview') },
        { id: 'model-g31fl',    section: 'Model', label: 'Model: Gemini 3.1 Flash Lite',      desc: '⚡', run: () => setModel('gemini-3.1-flash-lite-preview') },
        { id: 'model-g3pro',    section: 'Model', label: 'Model: Gemini 3 Pro',               desc: '✨', run: () => setModel('gemini-3-pro') },
        { id: 'model-g3fl',     section: 'Model', label: 'Model: Gemini 3 Flash',             desc: '⚡', run: () => setModel('gemini-3-flash-preview') },
        { id: 'model-g25pro',   section: 'Model', label: 'Model: Gemini 2.5 Pro',             desc: '🔵', run: () => setModel('gemini-2.5-pro') },
        { id: 'model-g25fl',    section: 'Model', label: 'Model: Gemini 2.5 Flash',           desc: '⚡', run: () => setModel('gemini-2.5-flash') },
        { id: 'model-g25fll',   section: 'Model', label: 'Model: Gemini 2.5 Flash Lite',      desc: '⚡', run: () => setModel('gemini-2.5-flash-lite') },
      ]
    // Claude — Anthropic /v1/models 결과로 동적 생성, 없으면 fallback
    : availableModels.length > 0
      ? (() => {
          const tier = (id: string) => /opus/i.test(id) ? 0 : /sonnet/i.test(id) ? 1 : /haiku/i.test(id) ? 2 : 3;
          const sorted = [...availableModels].sort((a, b) => {
            const t = tier(a.id) - tier(b.id);
            return t !== 0 ? t : b.id.localeCompare(a.id);
          });
          const acts: PaletteAction[] = [];
          for (const m of sorted) {
            const has1M = (m.max_input_tokens || 0) >= 1_000_000;
            const shortAlias = /opus-4-7/i.test(m.id) ? 'opus' : /sonnet-4-6/i.test(m.id) ? 'sonnet' : /haiku-4-5/i.test(m.id) ? 'haiku' : m.id;
            if (has1M) {
              acts.push({ id: `model-${m.id}-200k`, section: 'Model', label: `Model: ${m.display_name}`, desc: '200k context', run: () => setModel(shortAlias) });
              acts.push({ id: `model-${m.id}-1m`,   section: 'Model', label: `Model: ${m.display_name} 1M`, desc: '1M context', run: () => setModel(`${shortAlias}[1m]`) });
            } else {
              acts.push({ id: `model-${m.id}`, section: 'Model', label: `Model: ${m.display_name}`, run: () => setModel(shortAlias) });
            }
          }
          return acts;
        })()
      : [
          { id: 'model-opus',       section: 'Model', label: 'Model: Opus 4.7',      run: () => setModel('opus') },
          { id: 'model-opus-1m',    section: 'Model', label: 'Model: Opus 4.7 1M',   run: () => setModel('opus[1m]') },
          { id: 'model-sonnet',     section: 'Model', label: 'Model: Sonnet 4.6',    run: () => setModel('sonnet') },
          { id: 'model-haiku',      section: 'Model', label: 'Model: Haiku 4.5',     run: () => setModel('haiku') },
        ];

  const paletteActions: PaletteAction[] = [
    // Context — 공통
    { id: 'attach-file',   section: 'Context', label: 'Attach file...',       desc: tt('palette.attachFileDesc'),   run: () => fileUploadRef.current?.click() },
    { id: 'attach-folder', section: 'Context', label: 'Attach folder...',     desc: tt('palette.attachFolderDesc'), run: () => folderUploadRef.current?.click() },
    { id: 'clear',         section: 'Context', label: 'Clear conversation',   desc: tt('palette.clearDesc'),        run: () => clear() },
    // Model — 에이전트별
    ...paletteModelActions,
    // Effort — Claude / Codex 사용 (Gemini 제외), 에이전트별 레이블
    ...(currentAgent === 'codex' ? [
      { id: 'effort-low',    section: 'Effort', label: '추론 강도: 낮음',     run: () => setEffort('low') },
      { id: 'effort-medium', section: 'Effort', label: '추론 강도: 중간',     run: () => setEffort('medium') },
      { id: 'effort-high',   section: 'Effort', label: '추론 강도: 높음',     run: () => setEffort('high') },
      { id: 'effort-max',    section: 'Effort', label: '추론 강도: 매우높음', run: () => setEffort('max') },
    ] : currentAgent === 'claude' ? [
      { id: 'effort-low',    section: 'Effort', label: tt('palette.effortLow'),    run: () => setEffort('low') },
      { id: 'effort-medium', section: 'Effort', label: tt('palette.effortMedium'), run: () => setEffort('medium') },
      { id: 'effort-high',   section: 'Effort', label: tt('palette.effortHigh'),   run: () => setEffort('high') },
      { id: 'effort-max',    section: 'Effort', label: tt('palette.effortMax'),    run: () => setEffort('max') },
    ] : []),
    // Permission — Claude 전용 / Codex 는 Approval Policy
    ...(currentAgent === 'claude' ? [
      { id: 'perm-default', section: 'Permission', label: tt('perm.default'),      run: () => setPermissionMode('default') },
      { id: 'perm-accept',  section: 'Permission', label: tt('perm.acceptEdits'),  run: () => setPermissionMode('acceptEdits') },
      { id: 'perm-plan',    section: 'Permission', label: tt('perm.plan'),         run: () => setPermissionMode('plan') },
    ] : currentAgent === 'codex' ? CODEX_APPROVAL_ITEMS.map(item => ({
      id: `codex-approval-${item.value}`,
      section: 'Permission',
      label: item.label,
      icon: <CodexApprovalIcon value={item.value} />,
      run: () => setCodexApprovalPolicy(item.value),
    })) : []),
    // Slash Commands — 공통
    ...commandPresets.map(p => ({
      id: `slash-${p.label}`,
      section: 'Slash Commands',
      label: p.label,
      desc: p.desc,
      run: () => {
        setInput(prev => {
          const trimmed = prev.trim();
          const startsWithPreset = commandPresets.some(pp => trimmed.startsWith(pp.insert.trim()));
          if (!trimmed || startsWithPreset) return p.insert;
          return p.insert + trimmed;
        });
      },
    })),
  ];

  // 필터링된 액션 리스트
  const filteredPalette = (() => {
    const q = commandFilter.trim().toLowerCase();
    if (!q) return paletteActions;
    return paletteActions.filter(a =>
      a.label.toLowerCase().includes(q) ||
      (a.desc || '').toLowerCase().includes(q) ||
      a.section.toLowerCase().includes(q)
    );
  })();

  const runPaletteAction = (a: PaletteAction) => {
    a.run();
    setCommandMenuOpen(false);
  };

  const selectedCodexApproval = CODEX_APPROVAL_ITEMS.find(item => item.value === codexApprovalPolicy) || CODEX_APPROVAL_ITEMS[2];
  const setCodexApproval = (next: CodexApprovalPolicy) => {
    setCodexApprovalPolicy(next);
    setPerToolApproval(next === 'suggest');
    setCodexApprovalMenuOpen(false);
  };

  if (installed === null) {
    return (
      <div className="claude-chat-container">
        <div className="claude-chat-header">
          <div className="claude-chat-agent-switcher">
            <button className={`claude-chat-agent-btn ${currentAgent === 'claude' ? 'active' : ''}`} title="Claude Code" onClick={() => switchAgent('claude')}><ClaudeTabIcon /></button>
            <button className={`claude-chat-agent-btn ${currentAgent === 'gemini' ? 'active' : ''}`} title="Gemini" onClick={() => switchAgent('gemini')}><GeminiTabIcon /></button>
            <button className={`claude-chat-agent-btn ${currentAgent === 'codex' ? 'active' : ''}`} title="Codex" onClick={() => switchAgent('codex')}><CodexTabIcon /></button>
          </div>
          {onClose && <button className="claude-chat-close" onClick={onClose}>×</button>}
        </div>
        <div className="claude-chat-loading">{currentAgent === 'gemini' ? tt('loadingGemini') : currentAgent === 'codex' ? tt('loadingCodex') : tt('loading')}</div>
      </div>
    );
  }
  if (!installed) {
    const notInstalledMsg = currentAgent === 'gemini' ? tt('notInstalledGemini') : currentAgent === 'codex' ? tt('notInstalledCodex') : tt('notInstalled');
    return (
      <div className="claude-chat-container">
        <div className="claude-chat-header">
          <div className="claude-chat-agent-switcher">
            <button
              className={`claude-chat-agent-btn ${currentAgent === 'claude' ? 'active' : ''}`}
              title="Claude Code"
              onClick={() => switchAgent('claude')}
            ><ClaudeTabIcon /></button>
            <button
              className={`claude-chat-agent-btn ${currentAgent === 'gemini' ? 'active' : ''}`}
              title="Gemini"
              onClick={() => switchAgent('gemini')}
            ><GeminiTabIcon /></button>
            <button
              className={`claude-chat-agent-btn ${currentAgent === 'codex' ? 'active' : ''}`}
              title="Codex"
              onClick={() => switchAgent('codex')}
            ><CodexTabIcon /></button>
          </div>
          {onClose && <button className="claude-chat-close" onClick={onClose}>×</button>}
        </div>
        <div className="claude-chat-notinstalled">
          <p>{notInstalledMsg}</p>
          {currentAgent === 'gemini' ? (
            <>
              <p>{tt('installCmd')} <code>npm install -g @google/gemini-cli</code></p>
              <p>{tt('loginHint', { cmd: 'gemini' })}</p>
            </>
          ) : currentAgent === 'codex' ? (
            <>
              <p>{tt('installCmd')} <code>npm install -g @openai/codex</code></p>
              <p>{tt('loginHint', { cmd: 'codex' })}</p>
            </>
          ) : (
            <>
              <p>{tt('installCmd')} <code>npm install -g @anthropic-ai/claude-code</code></p>
              <p>{tt('loginHint', { cmd: 'claude' })}</p>
            </>
          )}
        </div>
      </div>
    );
  }

  const totalAttachSize = attachments.reduce((a, c) => a + c.content.length, 0);

  return (
    <div className="claude-chat-container">
      <div className="claude-chat-header">
        <div className="claude-chat-agent-switcher">
          <button
            className={`claude-chat-agent-btn ${currentAgent === 'claude' ? 'active' : ''}`}
            title="Claude Code"
            onClick={() => switchAgent('claude')}
          ><ClaudeTabIcon /></button>
          <button
            className={`claude-chat-agent-btn ${currentAgent === 'gemini' ? 'active' : ''}`}
            title="Gemini"
            onClick={() => switchAgent('gemini')}
          ><GeminiTabIcon /></button>
          <button
            className={`claude-chat-agent-btn ${currentAgent === 'codex' ? 'active' : ''}`}
            title="Codex"
            onClick={() => switchAgent('codex')}
          ><CodexTabIcon /></button>
        </div>
        {version && <span className="claude-chat-version" style={{ marginLeft: 4, color: '#666', fontSize: 11 }}>{version}</span>}
        <div className="claude-chat-header-actions">
          <button onClick={startNewConversation} title={tt('newConversation')}>＋</button>
          <button onClick={() => setShowHistoryPanel(v => !v)} title={tt('historyToggle')} className={showHistoryPanel ? 'active' : ''}>≡</button>
          {onTogglePin && (
            <button
              className={`claude-chat-pin ${pinned ? 'pinned' : ''}`}
              onClick={onTogglePin}
              title={pinned ? tt('unpin') : tt('pin')}
            >📌</button>
          )}
          <button onClick={clear} title={tt('clear')}>🗑</button>
          {onClose && <button className="claude-chat-close" onClick={onClose} title={tt('close')}>×</button>}
        </div>
      </div>
      {showUsagePanel && (
        <div className="claude-chat-usage-panel claude-chat-usage-popup"
          style={usagePopupPos ? { left: usagePopupPos.left, bottom: usagePopupPos.bottom, right: 'auto' } : undefined}
          onMouseEnter={showUsage}
          onMouseLeave={hideUsageDelayed}
        >
          {/* 컨텍스트 분해 — 마지막 turn 시점의 누적 컨텍스트 구성 */}
          {(() => {
            // 사용자가 선택한 모델 기준으로 max 결정
            const is1M = /\[1m\]/i.test(model) || /1m/i.test(usage.model);
            const maxCtx = is1M ? 1_000_000 : 200_000;
            // 마지막 turn 의 누적 컨텍스트 = fresh + cache_read + cache_create
            const used = usage.lastTurnInput;
            const cacheHit = usage.lastTurnCacheRead;
            const cacheCreate = usage.lastTurnCacheCreate;
            const messages = usage.lastTurnFreshInput;
            const free = Math.max(0, maxCtx - used);
            const fmt = (n: number) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
            const pct = (n: number) => ((n / maxCtx) * 100).toFixed(1) + '%';
            const Bar: React.FC<{ color: string; label: string; n: number }> = ({ color, label, n }) => (
              <div className="claude-chat-usage-row">
                <span className="claude-chat-usage-label">
                  <span style={{ display: 'inline-block', width: 10, height: 10, background: color, marginRight: 6, borderRadius: 2, verticalAlign: 'middle' }} />
                  {label}
                </span>
                <span className="claude-chat-usage-val">{fmt(n)}  {pct(n)}</span>
              </div>
            );
            return (
              <>
                <div className="claude-chat-usage-divider" />
                <div className="claude-chat-usage-row" style={{ color: '#9cc' }}>
                  <span className="claude-chat-usage-label">{tt('usageContextBreakdown')}</span>
                  <span className="claude-chat-usage-val">{fmt(used)} / {fmt(maxCtx)} ({Math.round((used/maxCtx)*100)}%)</span>
                </div>
                <Bar color="#3a8bc8" label={tt('newInput')} n={messages} />
                <Bar color="#7a8fa8" label={tt('cacheHit')} n={cacheHit} />
                <Bar color="#9b7ac8" label={tt('cacheCreate')} n={cacheCreate} />
                <Bar color="#3a3a3a" label={tt('free')} n={free} />
              </>
            );
          })()}
          {subLimits && (
            <>
              <div className="claude-chat-usage-divider" />
              <div className="claude-chat-usage-row" style={{ color: '#9cc' }}>
                <span className="claude-chat-usage-label">━ Claude /usage API</span>
                <span className="claude-chat-usage-val">{subLimits.modelLabel || ''}</span>
              </div>
              {subLimits.fiveHourPct && (
                <div className="claude-chat-usage-row">
                  <span className="claude-chat-usage-label">{tt('limit5h')}</span>
                  <span className="claude-chat-usage-val">{subLimits.fiveHourPct}{subLimits.fiveHourReset ? ` · ${subLimits.fiveHourReset}` : ''}</span>
                </div>
              )}
              {subLimits.weeklyAllPct && (
                <div className="claude-chat-usage-row">
                  <span className="claude-chat-usage-label">{tt('weeklyAll')}</span>
                  <span className="claude-chat-usage-val">{subLimits.weeklyAllPct}{subLimits.weeklyAllReset ? ` · ${subLimits.weeklyAllReset}` : ''}</span>
                </div>
              )}
              {subLimits.weeklyDesignPct && (
                <div className="claude-chat-usage-row">
                  <span className="claude-chat-usage-label">{tt('weeklyClaudeDesign')}</span>
                  <span className="claude-chat-usage-val">{subLimits.weeklyDesignPct}</span>
                </div>
              )}
              {subLimits.sonnetOnlyPct && (
                <div className="claude-chat-usage-row">
                  <span className="claude-chat-usage-label">{tt('sonnetOnly')}</span>
                  <span className="claude-chat-usage-val">{subLimits.sonnetOnlyPct}{subLimits.sonnetOnlyReset ? ` · ${subLimits.sonnetOnlyReset}` : ''}</span>
                </div>
              )}
            </>
          )}
          <div className="claude-chat-usage-divider" />
          <div className="claude-chat-usage-row">
            <button
              className="claude-chat-usage-probe-btn"
              disabled={usageProbeLoading}
              onClick={async () => {
                setUsageProbeLoading(true);
                setUsageProbe(null);
                try {
                  const r: any = await (window as any).api?.claudeProbeUsage?.();
                  if (r?.success) {
                    const fmt = (n: number) => n.toLocaleString();
                    let out = `📊 전체 누적 (~/.claude/projects 스캔)\n`;
                    out += `─────────────────────────\n`;
                    out += `세션 수    : ${r.sessionCount}\n`;
                    out += `메시지 수  : ${r.msgCount}\n`;
                    out += `입력 토큰  : ${fmt(r.totalIn)}\n`;
                    out += `출력 토큰  : ${fmt(r.totalOut)}\n`;
                    out += `캐시 생성  : ${fmt(r.totalCacheCreate)}\n`;
                    out += `캐시 읽기  : ${fmt(r.totalCacheRead)}\n`;
                    out += `─────────────────────────\n`;
                    out += `📁 프로젝트별 Top ${r.projects?.length || 0}\n`;
                    for (const p of r.projects || []) {
                      out += `  ${p.project.slice(0, 60)}\n    in ${fmt(p.in)} / out ${fmt(p.out)} / cache ${fmt(p.cacheRead)} (${p.sessions} 세션)\n`;
                    }
                    setUsageProbe(out);
                  } else {
                    setUsageProbe(tt('apiFailed', { error: r?.error || tt('failed') }));
                  }
                } catch (e: any) {
                  setUsageProbe(`❌ ${e?.message || e}`);
                }
                setUsageProbeLoading(false);
              }}
              title={tt('scanProjectsTitle')}
            >{usageProbeLoading ? tt('scanLoading') : tt('scanProject')}</button>
            {false && (<button
              className="claude-chat-usage-probe-btn"
              style={{ marginLeft: 8, display: 'none' }}
              disabled={usageProbeLoading}
              onClick={async () => {
                setUsageProbeLoading(true);
                setUsageProbe(tt('tuiLoading'));
                try {
                  const r: any = await (window as any).api?.claudeProbeUsageTui?.();
                  if (r?.success && r.raw) {
                    const raw: string = r.raw;
                    // ANSI/box-drawing 제거 + 공백 정규화
                    const cleaned = raw.replace(/[│┃║┊┆╎├─━┯┴┐┌┘└┤▓░▒█▏▎▍▌▋▊▉◐◑●○✔]+/g, ' ').replace(/\s+/g, ' ');
                    const lim: typeof subLimits = {};
                    // Total cost: $X
                    const costMatch = cleaned.match(/Total\s*cost\s*[:：]\s*\$\s*([\d.]+)/i);
                    // Usage: A input, B output, C cache read, D cache write
                    const tokenMatch = cleaned.match(/Usage\s*[:：]?\s*(\d+(?:\.\d+)?[kKmM]?)\s*input\s*,?\s*(\d+(?:\.\d+)?[kKmM]?)\s*output\s*,?\s*(\d+(?:\.\d+)?[kKmM]?)\s*cache\s*read\s*,?\s*(\d+(?:\.\d+)?[kKmM]?)\s*cache\s*write/i);
                    const toNum = (s: string) => {
                      const m = s.match(/^([\d.]+)([kKmM]?)$/);
                      if (!m) return 0;
                      const v = parseFloat(m[1]);
                      const u = m[2]?.toLowerCase();
                      return Math.round(v * (u === 'm' ? 1_000_000 : u === 'k' ? 1_000 : 1));
                    };
                    void toNum;
                    // TUI Session 값들은 별도 표시 (우리 채팅 세션과 다름)
                    if (costMatch) lim.tuiCost = '$' + costMatch[1];
                    if (tokenMatch) {
                      lim.tuiInput = tokenMatch[1];
                      lim.tuiOutput = tokenMatch[2];
                      lim.tuiCacheRead = tokenMatch[3];
                      lim.tuiCacheWrite = tokenMatch[4];
                    }
                    // Current session XX% used Resets ...
                    const sessionMatch = cleaned.match(/Current\s*session[^%]*?(\d+(?:\.\d+)?)\s*%\s*used\s*Rese[a-z]*\s*([^E]*?(?:am|pm|\(Asia[^)]+\)|\(UTC[^)]+\)))/i);
                    if (sessionMatch) { lim.fiveHourPct = sessionMatch[1] + '%'; lim.fiveHourReset = sessionMatch[2].trim(); }
                    // Current week (all models)
                    const weekAllMatch = cleaned.match(/Current\s*week\s*\(?all\s*models\)?[^%]*?(\d+(?:\.\d+)?)\s*%\s*used\s*Rese[a-z]*\s*([^E]*?(?:am|pm|\(Asia[^)]+\)|\(UTC[^)]+\)))/i);
                    if (weekAllMatch) { lim.weeklyAllPct = weekAllMatch[1] + '%'; lim.weeklyAllReset = weekAllMatch[2].trim(); }
                    // Sonnet only (글자 손실 대응 — "Curnt week(Sonnetonly)" 등)
                    const sonnetMatch = cleaned.match(/Sonnet\s*only[^%]*?(\d+(?:\.\d+)?)\s*%\s*used\s*Rese[a-z]*\s*([^E]*?(?:am|pm|\(Asia[^)]+\)|\(UTC[^)]+\)))/i);
                    if (sonnetMatch) { lim.sonnetOnlyPct = sonnetMatch[1] + '%'; lim.sonnetOnlyReset = sonnetMatch[2].trim(); }
                    // Context display — "X / Y (Z%)" 형식
                    const ctxMatch = cleaned.match(/(\d+(?:\.\d+)?)\s*([kKmM])\s*\/\s*(\d+(?:\.\d+)?)\s*([kKmM])\s*\(\s*(\d+)\s*%\s*\)/);
                    if (ctxMatch) {
                      lim.contextUsed = ctxMatch[1] + ctxMatch[2].toLowerCase();
                      lim.contextMax = ctxMatch[3] + ctxMatch[4].toLowerCase();
                      lim.contextPct = ctxMatch[5] + '%';
                    }
                    // 모델 레이블 — "Opus 4.7 (1M context)" 처럼 버전+괄호 형식만 허용
                    const modelMatch = cleaned.match(/(Opus|Sonnet|Haiku)\s*\d+(?:\.\d+)?\s*\((1M\s*context|200k|400k)\)/i);
                    if (modelMatch) lim.modelLabel = modelMatch[0].replace(/\s+/g, ' ').trim();
                    setSubLimits(Object.keys(lim).length ? lim : null);
                    // 키워드 라인 요약
                    const wanted: string[] = [];
                    for (const ln of raw.split(/\r?\n/)) {
                      const t = ln.replace(/[│┃║┊┆╎├─━┯┴┐┌┘└┤▓░▒█▏▎▍▌▋▊▉◐◑●○]+/g, ' ').replace(/\s{2,}/g, '  ').trim();
                      if (!t || t.length < 4 || t.length > 200) continue;
                      if (/(컨텍스트|context|플랜|plan|5시간|5-?hour|주간|weekly|sonnet|opus|haiku|초기화|reset|tokens?|\d+%)/i.test(t)) wanted.push(t);
                    }
                    const summary = wanted.length > 0 ? [...new Set(wanted)].join('\n') : '(/usage 출력 파싱 실패 — raw 참고)';
                    setUsageProbe(`📊 /usage TUI 결과\n─────────────────────\n${summary}\n\n──── RAW (디버그, 마지막 4000자) ────\n${raw.slice(-4000)}`);
                  } else {
                    setUsageProbe(`${tt('apiFailed', { error: r?.error || tt('failed') })}\n\n${(r?.raw || '').slice(0, 1000)}`);
                  }
                } catch (e: any) {
                  setUsageProbe(`❌ ${e?.message || e}`);
                }
                setUsageProbeLoading(false);
              }}
              title={tt('tuiQuotaTitle')}
            >{usageProbeLoading ? tt('tuiLoadingShort') : tt('tuiQuotaBtn')}</button>)}
          </div>
          {usageProbe && (
            <>
              <button
                className="claude-chat-usage-probe-toggle"
                onClick={() => setUsageProbeExpanded(v => !v)}
                style={{ marginTop: 6, background: 'transparent', border: '1px solid #3a475a', color: '#aaa', padding: '2px 8px', borderRadius: 3, cursor: 'pointer', fontSize: 11 }}
              >{usageProbeExpanded ? tt('collapseResult') : tt('expandResult')}</button>
              {usageProbeExpanded && (
                <pre className="claude-chat-usage-probe-output">{usageProbe}</pre>
              )}
            </>
          )}
        </div>
      )}
      <div className="claude-chat-active-session">
        {tt('sshContext')}
        <select
          className="claude-chat-session-select"
          value={selectedSshTermId || ''}
          onChange={e => setSelectedSshTermId(e.target.value || null)}
        >
          <option value="">{tt('sessionNone')}</option>
          {connectedSessions.map(s => (
            <option key={s.termId} value={s.termId}>{s.label}</option>
          ))}
        </select>
        {activeMount ? (
          <span className="claude-chat-active-session-hint" title={`WebDAV mount: ${activeMount.mountRoot}`}>{tt('mounted')}</span>
        ) : selectedSshTermId ? (
          <span className="claude-chat-active-session-hint" style={{ color: '#fa6' }}>{tt('mounting')}</span>
        ) : connectedSessions.length === 0 ? (
          <span className="claude-chat-active-session-hint" style={{ color: '#a66' }}>{tt('noActiveSession')}</span>
        ) : (
          <span className="claude-chat-active-session-hint">{tt('selectSessionHint')}</span>
        )}
      </div>
      {showHistoryPanel && (() => {
        const pinnedHist = chatHistory.filter(h => h.pinned).sort((a, b) => b.updatedAt - a.updatedAt);
        const recentHist = chatHistory.filter(h => !h.pinned).sort((a, b) => b.updatedAt - a.updatedAt);
        const renderItem = (h: ChatHistoryEntry) => (
          <div
            key={h.id}
            className={`claude-chat-history-item ${activeHistoryId === h.id ? 'active' : ''}`}
            onClick={() => loadHistory(h)}
          >
            <span className="claude-chat-history-title" title={h.title}>○ {h.title || tt('noTitle')}</span>
            <div className="claude-chat-history-actions">
              <button title={h.pinned ? tt('unpinTitle') : tt('pinnedTitle')} onClick={e => { e.stopPropagation(); togglePinHistory(h.id); }}>
                {h.pinned ? '📍' : '📌'}
              </button>
              <button title={tt('renameTitle')} onClick={e => {
                e.stopPropagation();
                const v = prompt(tt('renamePrompt'), h.title);
                if (v && v.trim()) renameHistory(h.id, v.trim());
              }}>✎</button>
              <button title={tt('deleteTitle')} onClick={e => {
                e.stopPropagation();
                setDeleteHistoryConfirm({ id: h.id, title: h.title || tt('noTitle') });
              }}>×</button>
            </div>
          </div>
        );
        return (
          <div className="claude-chat-history-panel">
            <div className="claude-chat-history-section-title">{tt('pinnedSection')}</div>
            {pinnedHist.length === 0 ? <div className="claude-chat-history-empty">{tt('noPinnedHistory')}</div> : pinnedHist.map(renderItem)}
            <div className="claude-chat-history-section-title">{tt('recentsSection')}</div>
            {recentHist.length === 0 ? <div className="claude-chat-history-empty">{tt('noRecentHistory')}</div> : recentHist.map(renderItem)}
          </div>
        );
      })()}
      <div className="claude-chat-messages" ref={scrollRef} style={showHistoryPanel ? { display: 'none' } : undefined}>
        {pendingToolApproval && (
          <div className="claude-chat-plan-overlay">
            <div className="claude-chat-plan-modal">
              <div className="claude-chat-plan-title">{tt('approveToolPrompt', { toolName: pendingToolApproval.toolName })}</div>
              <div className="claude-chat-plan-body">
                <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
{JSON.stringify(pendingToolApproval.toolInput, null, 2).slice(0, 2000)}
                </pre>
              </div>
              <div className="claude-chat-plan-actions">
                <button className="claude-chat-plan-btn reject" onClick={denyTool}>{tt('deny')}</button>
                <button className="claude-chat-plan-btn approve" onClick={approveTool} autoFocus>{tt('approveOnce')}</button>
              </div>
            </div>
          </div>
        )}
        {pendingPlan && (
          <div className="claude-chat-plan-overlay" onClick={rejectPlan}>
            <div className="claude-chat-plan-modal" onClick={e => e.stopPropagation()}
              onKeyDown={e => { if (!planEditing && e.key === 'Enter') approvePlan(); else if (e.key === 'Escape') rejectPlan(); }}
              tabIndex={0}
            >
              <div className="claude-chat-plan-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>{tt('planApprovalTitle')}</span>
                <button
                  style={{ background: 'transparent', border: '1px solid #3a5075', color: '#9cf', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontSize: 12 }}
                  onClick={() => {
                    if (!planEditing) { setPlanEditedText(pendingPlan); setPlanEditing(true); }
                    else { setPlanEditing(false); }
                  }}
                  title={planEditing ? '미리보기로 전환' : '편집 모드'}
                >
                  {planEditing ? '👁 미리보기' : '✎ 편집'}
                </button>
              </div>
              {planEditing ? (
                <textarea
                  className="claude-chat-plan-body"
                  value={planEditedText}
                  onChange={e => setPlanEditedText(e.target.value)}
                  style={{ resize: 'none', background: '#0a0f1a', color: '#cde', border: 'none', outline: 'none', fontFamily: 'inherit', fontSize: 13, lineHeight: 1.55, padding: '12px 16px', width: '100%', boxSizing: 'border-box', flex: 1, minHeight: 200, display: 'block' }}
                  autoFocus
                />
              ) : (
                <div className="claude-chat-plan-body"
                  dangerouslySetInnerHTML={{ __html: renderMd(pendingPlan) }}
                />
              )}
              <div style={{ padding: '8px 16px', borderTop: '1px solid #2a3a50', background: '#0f1318' }}>
                <div style={{ fontSize: 11, color: '#8aa', marginBottom: 4 }}>➕ 추가 요구사항 (선택)</div>
                <textarea
                  value={planExtraNote}
                  onChange={e => setPlanExtraNote(e.target.value)}
                  placeholder="예: 테스트 코드도 추가해줘 / 주석 한글로 써줘 / dry-run 으로 먼저 보여줘 ..."
                  rows={2}
                  style={{ resize: 'vertical', background: '#0a0f1a', color: '#cde', border: '1px solid #2a3a50', outline: 'none', fontFamily: 'inherit', fontSize: 12, lineHeight: 1.5, padding: '6px 10px', width: '100%', boxSizing: 'border-box', borderRadius: 4 }}
                  onKeyDown={e => {
                    // textarea 안에서 Enter 는 줄바꿈이어야 하므로 부모로 전파 차단
                    e.stopPropagation();
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); approvePlan(); }
                  }}
                />
              </div>
              <div className="claude-chat-plan-actions">
                <button className="claude-chat-plan-btn reject" onClick={rejectPlan}>{tt('planDeny')}</button>
                <button className="claude-chat-plan-btn approve" onClick={approvePlan} autoFocus={!planEditing}>{tt('planProceed')}</button>
              </div>
            </div>
          </div>
        )}
        {messages.length === 0 && (
          <div className="claude-chat-empty">
            <p>{currentAgent === 'gemini' ? tt('askPlaceholderGemini') : currentAgent === 'codex' ? tt('askPlaceholderCodex') : tt('askPlaceholder')}</p>
            <p>{currentAgent === 'gemini' ? tt('askEditorHintGemini') : currentAgent === 'codex' ? tt('askEditorHintCodex') : tt('askEditorHint')}</p>
          </div>
        )}
        {(() => {
          // 메시지 + 툴 호출을 발생 순서(seq) 로 인터리브
          type Item = { kind: 'msg'; m: Message; seq: number } | { kind: 'tool'; t: ToolTimelineItem; seq: number };
          const items: Item[] = [
            ...messages.map((m, i) => ({ kind: 'msg' as const, m, seq: m.seq ?? i * 2 })),
            ...toolTimeline.map((t, i) => ({ kind: 'tool' as const, t, seq: t.seq ?? (messages.length * 2 + i * 2 + 1) })),
          ];
          items.sort((a, b) => a.seq - b.seq);
          // 연속된 tool 항목들을 그룹으로 묶기
          type Group = { kind: 'msg'; m: Message; key: string } | { kind: 'tools'; tools: ToolTimelineItem[]; key: string };
          const groups: Group[] = [];
          for (const item of items) {
            if (item.kind === 'msg') {
              groups.push({ kind: 'msg', m: item.m, key: `m-${item.m.id}` });
            } else {
              const last = groups[groups.length - 1];
              if (last && last.kind === 'tools') last.tools.push(item.t);
              else groups.push({ kind: 'tools', tools: [item.t], key: `tg-${item.t.id}` });
            }
          }
          return groups.map(g => g.kind === 'msg' ? (
            <div
              key={g.key}
              className={`claude-chat-msg ${g.m.role}`}
              onContextMenu={e => {
                const t = e.target as HTMLElement | null;
                if (t && t.closest && t.closest('.claude-chat-mermaid')) return;
                e.preventDefault();
                e.stopPropagation();
                setMsgCtxMenu({ x: e.clientX, y: e.clientY, msgId: g.m.id, content: g.m.content });
              }}
              onMouseDown={e => {
                if (e.button === 2) {
                  const t = e.target as HTMLElement | null;
                  if (t && t.closest && t.closest('.claude-chat-mermaid')) return;
                  e.preventDefault();
                  e.stopPropagation();
                  setMsgCtxMenu({ x: e.clientX, y: e.clientY, msgId: g.m.id, content: g.m.content });
                }
              }}
            >
              <div className="claude-chat-msg-role">{g.m.role === 'user' ? '👤 You' : (g.m.agent || currentAgent) === 'gemini' ? '✨ Gemini' : (g.m.agent || currentAgent) === 'codex' ? '🧠 Codex' : '🤖 Claude'}</div>
              <div
                className="claude-chat-msg-content"
                dangerouslySetInnerHTML={{ __html: renderMd(g.m.content) }}
              />
            </div>
          ) : (() => {
            const groupKey = g.key;
            // 실행 중인 도구가 있으면 자동 펼침 (사용자가 보고 있을 수 있는 진행 상황)
            const anyRunningInGroup = g.tools.some(t => t.status === 'running');
            const expanded = expandedToolGroups.has(groupKey) || anyRunningInGroup;
            const summary = (() => {
              // 툴 이름별 카운트로 요약 — "검색함 Read 2개, Bash 1개" 식
              const counts: Record<string, number> = {};
              for (const t of g.tools) {
                const m = (t.label || '').match(/^([A-Za-z_][A-Za-z0-9_]*)/);
                const name = m ? m[1] : tt('tool');
                counts[name] = (counts[name] || 0) + 1;
              }
              return Object.entries(counts).map(([k, v]) => `${k} ${tt('toolCount', { count: v })}`).join(', ');
            })();
            const anyError = g.tools.some(t => t.status === 'error');
            const headerIcon = anyRunningInGroup ? '⏳' : anyError ? '✕' : '✓';
            return (
              <div key={g.key} className={`claude-chat-tool-group ${expanded ? 'expanded' : 'collapsed'}`}>
                <button className="claude-chat-tool-group-header" onClick={() => toggleToolGroup(groupKey)} title={expanded ? tt('collapse') : tt('expand')}>
                  <span className="claude-chat-tool-group-caret">{expanded ? '⌄' : '›'}</span>
                  <span className="claude-chat-tool-group-icon">{headerIcon}</span>
                  <span className="claude-chat-tool-group-summary">{summary}</span>
                </button>
                {expanded && (
                  <div className="claude-chat-tool-group-body">
                    {g.tools.map(t => {
                      // 실행 중인 도구는 자동 펼침 (진행 상황 보이도록)
                      const isOpen = expandedToolItems.has(t.id) || t.status === 'running';
                      const labelShort = t.label.length > 80 ? t.label.slice(0, 80) + '…' : t.label;
                      return (
                        <div key={`t-${t.id}`} className={`claude-chat-timeline-item ${t.status} ${isOpen ? 'open' : 'closed'}`}>
                          <button className="claude-chat-timeline-row" onClick={() => toggleToolItem(t.id)} title={isOpen ? tt('collapse') : tt('expand')}>
                            <span className="claude-chat-timeline-caret">{isOpen ? '⌄' : '›'}</span>
                            <span className="claude-chat-timeline-status">
                              {t.status === 'running' ? '⏳' : t.status === 'done' ? '✓' : '✕'}
                            </span>
                            <span className="claude-chat-timeline-label">{isOpen ? t.label : labelShort}</span>
                          </button>
                          {isOpen && t.resultPreview && (
                            <pre className="claude-chat-timeline-detail">{t.resultPreview}</pre>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })());
        })()}
      </div>
      {streaming && !showHistoryPanel && (
        <div className="claude-chat-streaming">
          <span className="claude-chat-streaming-dots">●●●</span>
          <span className="claude-chat-streaming-activity">{activity || tt('thinking')}</span>
          <button className="claude-chat-streaming-stop" onClick={stop} title={tt('stop')}>{tt('stopShort')}</button>
        </div>
      )}
      <div className="claude-chat-input-area" style={showHistoryPanel ? { display: 'none' } : undefined}>
        {(() => {
          if (!gitStatus?.ok || !gitStatus.branch) return null;
          // 엄격한 git 키워드 — 모호한 일반 단어 (push, fetch, diff, merge 등) 제외
          // 명시적 git 관련 표현만 인정
          const gitRe = /\bgit\s|\bgit$|`git\b|\bPR\b|\bpull request\b|\bgithub\b|\bgitlab\b|\bcommit\s|`commit`|\bbranch\s.*\b(main|master|dev|feature|release)\b|\bcheckout -b|\bgit\.exe/i;
          const toolHits = toolTimeline.filter(t => /\bgit[\s.]/i.test(t.label)).map(t => t.label);
          const msgHitsDetailed = messages
            .map((m, idx) => {
              const c = typeof m.content === 'string' ? m.content : '';
              const match = c.match(gitRe);
              return match ? { idx, role: m.role, matched: match[0], snippet: c.slice(Math.max(0, (match.index || 0) - 20), (match.index || 0) + 60) } : null;
            })
            .filter(Boolean);
          const toolMatch = toolHits.length > 0;
          const msgMatch = msgHitsDetailed.length > 0;
          console.log('[GITBAR] check', {
            branch: gitStatus.branch,
            msgCount: messages.length,
            toolMatch, toolHits,
            msgMatch, msgHits: msgHitsDetailed,
          });
          if (!toolMatch && !msgMatch) return null;
          return (
          <div className="claude-chat-git-bar" title={activeSshSession ? `원격 SSH (${activeSshSession.label})` : '로컬'}>
            <span className="claude-chat-git-branch">
              <span style={{ opacity: 0.7 }}>⎇</span> {gitStatus.branch}
            </span>
            {(gitStatus.additions || gitStatus.deletions) ? (
              <span className="claude-chat-git-diff">
                <span style={{ color: '#5cd97a' }}>+{(gitStatus.additions || 0).toLocaleString()}</span>
                {' '}
                <span style={{ color: '#ff7a7a' }}>−{(gitStatus.deletions || 0).toLocaleString()}</span>
              </span>
            ) : (
              <span className="claude-chat-git-diff" style={{ opacity: 0.5 }}>변경 없음</span>
            )}
            <button
              className="claude-chat-git-pr-btn"
              title="현재 변경사항으로 PR 생성을 AI 에게 요청"
              onClick={() => {
                // AI 에게 PR 생성 요청 메시지 자동 전송
                const branch = gitStatus.branch || 'HEAD';
                const stat = `+${gitStatus.additions || 0} -${gitStatus.deletions || 0}`;
                const text = `현재 변경사항으로 PR 을 생성해줘.\n- branch: \`${branch}\`\n- diff: ${stat}\n\n변경 요약과 함께 \`gh pr create\` 명령어로 PR 을 만들어 줘.`;
                send(text, []);
              }}
            >PR 생성</button>
          </div>
          );
        })()}
        {lastRejectedPlan && !pendingPlan && (
          <div className="claude-chat-rejected-plan-bar">
            <button
              className="claude-chat-rejected-plan-btn"
              onClick={() => { setPendingPlan(lastRejectedPlan); }}
              title={tt('showRejectedPlanTitle')}
            >{tt('showRejectedPlan')}</button>
            <button
              className="claude-chat-rejected-plan-dismiss"
              onClick={() => setLastRejectedPlan(null)}
              title={tt('removeRejectedPlan')}
            >✕</button>
          </div>
        )}
        {mountEntries.length > 0 && (
          <div className="claude-chat-attachments staged">
            <div className="claude-chat-attachments-header">
              <span>{tt('attachWebdavTitle', { count: mountEntries.length })}</span>
              {onClearMounted && <button className="claude-chat-attachments-clear" onClick={onClearMounted} title={tt('removeAttachment')}>{tt('removeAll')}</button>}
            </div>
            <div className="claude-chat-attachments-list">
              {mountEntries.map(m => (
                <div key={`${m.termId}:${m.remotePath}`} className="claude-chat-attachment">
                  {m.isDir ? '📁' : '📄'}
                  <span className="claude-chat-attachment-path" title={`${m.remotePath}\n↓ UNC:\n${m.uncPath}`}>{m.remotePath}</span>
                  {onRemoveMountedEntry && <button className="claude-chat-attachment-remove" onClick={() => onRemoveMountedEntry(m.remotePath, m.termId)} title={tt('remove')}>×</button>}
                </div>
              ))}
            </div>
          </div>
        )}
        {attachments.length > 0 && (
          <div className="claude-chat-attachments">
            <div className="claude-chat-attachments-header">
              <span>{tt('attachInline', { count: attachments.length, size: (totalAttachSize / 1024).toFixed(1) })}</span>
              <button className="claude-chat-attachments-clear" onClick={clearAllAttachments} title={tt('removeAll')}>{tt('removeAll')}</button>
            </div>
            <div className="claude-chat-attachments-list">
              {attachments.map(a => (
                <div key={a.remotePath} className="claude-chat-attachment">
                  📄 <span className="claude-chat-attachment-path" title={a.remotePath}>{a.remotePath}</span>
                  <button className="claude-chat-attachment-remove" onClick={() => removeAttachment(a.remotePath)} title={tt('remove')}>×</button>
                </div>
              ))}
            </div>
          </div>
        )}
        {localFileAttachments.length > 0 && (
          <div className="claude-chat-attachments">
            <div className="claude-chat-attachments-header">
              <span>{tt('attachLocalCount', { count: localFileAttachments.length })}</span>
              <button className="claude-chat-attachments-clear" onClick={() => setLocalFileAttachments([])}>{tt('removeAll')}</button>
            </div>
            <div className="claude-chat-attachments-list">
              {localFileAttachments.map((f, i) => (
                <div key={`${f.name}-${i}`} className="claude-chat-attachment">
                  📄 <span className="claude-chat-attachment-path">{f.name}</span>
                  <span style={{ color: '#888', fontSize: 10 }}>{(f.content.length / 1024).toFixed(1)}KB</span>
                  <button className="claude-chat-attachment-remove" onClick={() => setLocalFileAttachments(prev => prev.filter((_, x) => x !== i))}>×</button>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="claude-chat-toolbar">
          <button
            className="claude-chat-tool-btn"
            title={tt('attachLocalFile')}
            onClick={() => fileUploadRef.current?.click()}
          >📄+</button>
          <input
            ref={fileUploadRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={e => { onFilePicked(e.target.files, { fromFolder: false }); if (fileUploadRef.current) fileUploadRef.current.value = ''; }}
          />
          <button
            className="claude-chat-tool-btn"
            title={tt('attachLocalFolder')}
            onClick={() => folderUploadRef.current?.click()}
          >📁+</button>
          <input
            ref={folderUploadRef}
            type="file"
            multiple
            // @ts-ignore — webkitdirectory 는 Chromium/Electron 에서 지원
            webkitdirectory=""
            directory=""
            style={{ display: 'none' }}
            onChange={e => { onFilePicked(e.target.files, { fromFolder: true }); if (folderUploadRef.current) folderUploadRef.current.value = ''; }}
          />
          <div className="claude-chat-cmd-wrap">
            <button
              className="claude-chat-tool-btn"
              title={tt('slashMenu')}
              onClick={e => { e.stopPropagation(); setCommandMenuOpen(v => !v); }}
            >/</button>
            {commandMenuOpen && (
              <div className="claude-chat-cmd-menu" onClick={e => e.stopPropagation()}>
                <input
                  ref={commandFilterRef}
                  className="claude-chat-cmd-filter"
                  placeholder="Filter actions..."
                  value={commandFilter}
                  onChange={e => { setCommandFilter(e.target.value); setCommandHighlight(0); }}
                  onKeyDown={e => {
                    if (e.key === 'Escape') { setCommandMenuOpen(false); }
                    else if (e.key === 'ArrowDown') { e.preventDefault(); setCommandHighlight(h => Math.min(h + 1, filteredPalette.length - 1)); }
                    else if (e.key === 'ArrowUp') { e.preventDefault(); setCommandHighlight(h => Math.max(h - 1, 0)); }
                    else if (e.key === 'Enter') {
                      e.preventDefault();
                      const a = filteredPalette[commandHighlight];
                      if (a) runPaletteAction(a);
                    }
                  }}
                />
                <div className="claude-chat-cmd-list">
                  {filteredPalette.length === 0 && (
                    <div className="claude-chat-cmd-empty">{tt('noMatch')}</div>
                  )}
                  {(() => {
                    const rows: React.ReactNode[] = [];
                    let lastSection = '';
                    filteredPalette.forEach((a, idx) => {
                      if (a.section !== lastSection) {
                        rows.push(<div key={`sec-${a.section}`} className="claude-chat-cmd-section">{a.section}</div>);
                        lastSection = a.section;
                      }
                      rows.push(
                        <div
                          key={a.id}
                          className={`claude-chat-cmd-item ${idx === commandHighlight ? 'highlight' : ''}`}
                          onMouseEnter={() => setCommandHighlight(idx)}
                          onClick={() => runPaletteAction(a)}
                        >
                          <span className="claude-chat-cmd-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            {a.icon && <span style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>{a.icon}</span>}
                            {a.label}
                          </span>
                          {a.desc && <span className="claude-chat-cmd-desc">{a.desc}</span>}
                        </div>
                      );
                    });
                    return rows;
                  })()}
                </div>
              </div>
            )}
          </div>
          {currentAgent === 'gemini' ? (
            <>
              <select
                className="claude-chat-perm-select"
                value={model}
                onChange={e => setModel(e.target.value)}
                title={tt('geminiModelSelect')}
              >
                <option value="gemini-3.1-pro">✨ Gemini 3.1 Pro</option>
                <option value="gemini-3.1-pro-preview">✨ Gemini 3.1 Pro Preview</option>
                <option value="gemini-3.1-flash-lite-preview">⚡ Gemini 3.1 Flash Lite</option>
                <option value="gemini-3-pro">✨ Gemini 3 Pro</option>
                <option value="gemini-3-flash-preview">⚡ Gemini 3 Flash</option>
                <option value="gemini-2.5-pro">🔵 Gemini 2.5 Pro</option>
                <option value="gemini-2.5-flash">⚡ Gemini 2.5 Flash</option>
                <option value="gemini-2.5-flash-lite">⚡ Gemini 2.5 Flash Lite</option>
              </select>
              <label className="claude-chat-tool-approval-label" title={tt('geminiAutoApproveTitle')}>
                <input type="checkbox" checked={geminiYolo} onChange={e => setGeminiYolo(e.target.checked)} />
                {tt('geminiAutoApprove')}
              </label>
            </>
          ) : currentAgent === 'codex' ? (
            <>
              <select
                className="claude-chat-perm-select"
                value={model}
                onChange={e => setModel(e.target.value)}
                title={tt('codexModelSelect')}
              >
                <option value="gpt-5.5">🚀 GPT-5.5 (기본)</option>
                <option value="gpt-5.4">🔵 GPT-5.4</option>
                <option value="gpt-5.4-mini">⚡ GPT-5.4 Mini</option>
                <option value="gpt-5.3-codex">🧠 GPT-5.3 Codex</option>
                <option value="gpt-5.2">🟣 GPT-5.2</option>
                <option value="codex-mini-latest">🧠 Codex Mini (API키 전용)</option>
                <option value="o4-mini">⚡ o4-mini (API키 전용)</option>
                <option value="o3">🔵 o3 (API키 전용)</option>
                <option value="gpt-4o">🟢 GPT-4o (API키 전용)</option>
              </select>
              <select
                className="claude-chat-perm-select"
                value={effort}
                onChange={e => setEffort(e.target.value)}
                title="추론 강도"
              >
                <option value="low">낮음</option>
                <option value="medium">중간</option>
                <option value="high">높음</option>
                <option value="max">매우 높음</option>
              </select>
              <label className="claude-chat-tool-approval-label" title="도구 실행마다 승인 요청">
                <input
                  type="checkbox"
                  checked={codexApprovalPolicy === 'suggest'}
                  onChange={e => {
                    setCodexApproval(e.target.checked ? 'suggest' : 'full-auto');
                  }}
                />
                툴별 승인
              </label>
              <div
                className="codex-approval-menu-wrap"
                onBlur={e => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                    setCodexApprovalMenuOpen(false);
                  }
                }}
              >
                <button
                  type="button"
                  className={`codex-approval-menu-btn ${codexApprovalPolicy}`}
                  onClick={() => setCodexApprovalMenuOpen(open => !open)}
                  title={tt('codexApprovalTitle')}
                  aria-haspopup="listbox"
                  aria-expanded={codexApprovalMenuOpen}
                >
                  <CodexApprovalIcon value={selectedCodexApproval.value} />
                  <span>{selectedCodexApproval.label}</span>
                  <span className="codex-approval-caret">▾</span>
                </button>
                {codexApprovalMenuOpen && (
                  <div className="codex-approval-menu" role="listbox">
                    {CODEX_APPROVAL_ITEMS.map(item => (
                      <button
                        key={item.value}
                        type="button"
                        className={`codex-approval-menu-item ${item.value === codexApprovalPolicy ? 'active' : ''}`}
                        onMouseDown={e => e.preventDefault()}
                        onClick={() => setCodexApproval(item.value)}
                        role="option"
                        aria-selected={item.value === codexApprovalPolicy}
                      >
                        <CodexApprovalIcon value={item.value} />
                        <span>{item.label}</span>
                        {item.value === codexApprovalPolicy && <span className="codex-approval-check">✓</span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <select
                className="claude-chat-perm-select"
                value={model}
                onChange={e => setModel(e.target.value)}
                title={tt('modelSelect')}
              >
                {availableModels.length > 0 ? (() => {
                  const tier = (id: string) => /opus/i.test(id) ? 0 : /sonnet/i.test(id) ? 1 : /haiku/i.test(id) ? 2 : 3;
                  const sorted = [...availableModels].sort((a, b) => {
                    const t = tier(a.id) - tier(b.id);
                    if (t !== 0) return t;
                    return (b.id.localeCompare(a.id));
                  });
                  const opts: JSX.Element[] = [];
                  for (const m of sorted) {
                    const icon = /opus/i.test(m.id) ? '🟣' : /sonnet/i.test(m.id) ? '🔵' : /haiku/i.test(m.id) ? '⚡' : '🤖';
                    const has1M = (m.max_input_tokens || 0) >= 1_000_000;
                    const shortAlias = /opus-4-7/i.test(m.id) ? 'opus' : /sonnet-4-6/i.test(m.id) ? 'sonnet' : /haiku-4-5/i.test(m.id) ? 'haiku' : m.id;
                    if (has1M) {
                      opts.push(<option key={m.id + '-200k'} value={shortAlias}>{icon} {m.display_name} (200k)</option>);
                      opts.push(<option key={m.id + '-1m'} value={`${shortAlias}[1m]`}>{icon} {m.display_name} 1M</option>);
                    } else {
                      opts.push(<option key={m.id} value={shortAlias}>{icon} {m.display_name}</option>);
                    }
                  }
                  return opts;
                })() : (
                  <>
                    <option value="opus">🟣 Opus 4.7</option>
                    <option value="opus[1m]">🟣 Opus 4.7 1M</option>
                    <option value="sonnet">🔵 Sonnet 4.6</option>
                    <option value="haiku">⚡ Haiku 4.5</option>
                    <option value="claude-opus-4-6">🕘 Opus 4.6 레거시</option>
                  </>
                )}
              </select>
              <select
                className="claude-chat-perm-select"
                value={effort}
                onChange={e => setEffort(e.target.value)}
                title={tt('effortTitle')}
              >
                {(() => {
                  const supported = availableModels[0]?.capabilities?.effort;
                  const labels: Record<string, string> = { low: tt('effort.low'), medium: tt('effort.medium'), high: tt('effort.high'), max: tt('effort.max') };
                  const all = ['low', 'medium', 'high', 'max'];
                  const enabled = supported ? all.filter(k => supported[k]?.supported) : all;
                  return enabled.map(v => <option key={v} value={v}>{labels[v]}</option>);
                })()}
              </select>
              <label className="claude-chat-tool-approval-label" title={tt('toolApprovalTitle')}>
                <input type="checkbox" checked={perToolApproval} onChange={e => setPerToolApproval(e.target.checked)} />
                {tt('toolApprovalLabel')}
              </label>
              <select
                className="claude-chat-perm-select"
                value={permissionMode}
                onChange={e => setPermissionMode(e.target.value as any)}
                title={tt('permissionTitle')}
              >
                <option value="default">{tt('perm.default')}</option>
                <option value="acceptEdits">{tt('perm.acceptEdits')}</option>
                <option value="plan">{tt('perm.plan')}</option>
              </select>
            </>
          )}
        </div>
        <textarea
          className="claude-chat-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder={tt('inputPlaceholder')}
          rows={3}
          disabled={streaming}
        />
        <div className="claude-chat-input-actions">
          <div
            ref={usageTriggerRef}
            className="claude-chat-usage-trigger-wrap"
            onMouseEnter={() => { setShowUsageTooltip(true); fetchUsageApi(); /* 캐시 hit 면 호출 안 함 */ }}
            onMouseLeave={() => setShowUsageTooltip(false)}
            onClick={() => { showUsage(); fetchUsageApi(); }}
          >
            <span className="claude-chat-usage-trigger" title={tt('usageTriggerTitle')}>
              {(() => {
                const label = model === 'opus[1m]' ? 'Opus 4.7 1M' : model === 'opus' ? 'Opus 4.7' : model === 'sonnet[1m]' ? 'Sonnet 4.6 1M' : model === 'sonnet' ? 'Sonnet 4.6' : model === 'haiku' ? 'Haiku 4.5' : model === 'opusplan' ? 'Opus Plan' : model;
                return `📊 ${label}`;
              })()}
            </span>
            {showUsageTooltip && !showUsagePanel && (() => {
              const is1M = /\[1m\]/i.test(model) || /1m/i.test(usage.model);
              const maxCtx = is1M ? 1_000_000 : 200_000;
              const fmt = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
              const ctxPct = Math.round((usage.lastTurnInput / maxCtx) * 100);
              const planPct = subLimits?.fiveHourPct;
              return (
                <div className="claude-chat-usage-tooltip">
                  <div><b>Context</b> {fmt(usage.lastTurnInput)} / {fmt(maxCtx)} ({ctxPct}%){planPct ? ` · Plan ${planPct}` : ''}</div>
                </div>
              );
            })()}
          </div>
          {streaming ? (
            <button className="claude-chat-btn stop" onClick={stop}>{tt('stopShort')}</button>
          ) : (
            <button className="claude-chat-btn send" onClick={handleSend} disabled={!input.trim()}>{tt('send')}</button>
          )}
        </div>
      </div>
      {msgCtxMenu && (() => {
        const idx = messages.findIndex(m => m.id === msgCtxMenu.msgId);
        const copyPlain = () => {
          // marked 로 HTML 변환 후 텍스트만 추출
          try {
            const html = marked.parse(msgCtxMenu.content, { breaks: true }) as string;
            const tmp = document.createElement('div');
            tmp.innerHTML = html;
            const text = tmp.textContent || tmp.innerText || msgCtxMenu.content;
            navigator.clipboard.writeText(text);
          } catch {
            navigator.clipboard.writeText(msgCtxMenu.content);
          }
          setMsgCtxMenu(null);
        };
        const copyMarkdown = () => {
          navigator.clipboard.writeText(msgCtxMenu.content);
          setMsgCtxMenu(null);
        };
        const attachAsContext = () => {
          const block = `이전 메시지 컨텍스트:\n\n${msgCtxMenu.content}\n\n---\n\n`;
          setInput(prev => block + prev);
          setMsgCtxMenu(null);
        };
        const forkHere = () => {
          if (idx < 0) { setMsgCtxMenu(null); return; }
          const upTo = messages.slice(0, idx + 1);
          // 우클릭한 메시지의 seq 까지의 toolTimeline 도 복사 — 시각적 연속성 유지
          const cutSeq = messages[idx].seq ?? Number.MAX_SAFE_INTEGER;
          const upToTools = toolTimeline.filter(t => (t.seq ?? Number.MAX_SAFE_INTEGER) <= cutSeq);
          const newId = `hist-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const sourceTitle = chatHistory.find(h => h.id === activeHistoryId)?.title || '대화';
          const newHist: ChatHistoryEntry = {
            id: newId,
            claudeSessionId: null, // 새 fork — Claude resume 끊고 새 컨텍스트 (대화 분기)
            title: `🍴 ${sourceTitle}`,
            pinned: false,
            updatedAt: Date.now(),
            messages: upTo,
            toolTimeline: upToTools,
          };
          setChatHistory(h => [newHist, ...h]);
          // 새 fork 로 전환
          setMessages(upTo);
          bumpSeqFor(upTo, upToTools);
          claudeSessionIdRef.current = null;
          // 누적된 로컬 Windows 경로 클리어 — 원격 SSH 작업 시 로컬 경로 우선시되는 것 방지
          recentLocalPathsRef.current.clear();
          setActiveHist(newId);
          setToolTimeline(upToTools);
          setStreaming(false);
          setActivity('');
          setPendingPlan(null);
          activeRequestIdRef.current = null;
          currentAsstIdRef.current = null;
          setMsgCtxMenu(null);
        };
        return (
          <div
            className="claude-chat-msg-ctx-menu"
            style={{ left: msgCtxMenu.x, top: msgCtxMenu.y }}
            onContextMenu={e => e.preventDefault()}
            onClick={e => e.stopPropagation()}
          >
            <div className="claude-chat-msg-ctx-item" onClick={copyPlain}>{tt('msgCtx.copy')}</div>
            <div className="claude-chat-msg-ctx-item" onClick={copyMarkdown}>{tt('msgCtx.copyMarkdown')}</div>
            <div className="claude-chat-msg-ctx-item" onClick={attachAsContext}>{tt('msgCtx.attachAsContext')}</div>
            <div className="claude-chat-msg-ctx-sep" />
            <div className="claude-chat-msg-ctx-item" onClick={forkHere}>{tt('msgCtx.forkHere')}</div>
          </div>
        );
      })()}
      {/* 대화 이력 삭제 확인 모달 */}
      {deleteHistoryConfirm && createPortal(
        <div className="rn-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setDeleteHistoryConfirm(null); }}>
          <div className="rn-dialog" onMouseDown={e => e.stopPropagation()}>
            <div className="rn-title">삭제 확인</div>
            <div className="rn-body" style={{ maxWidth: 480 }}>
              <div style={{ fontSize: 12, lineHeight: '1.5em' }}>
                <b>1개</b> 대화를 삭제하시겠습니까?
              </div>
              <div style={{ fontSize: 11, color: '#aaa', marginTop: 6, wordBreak: 'break-all' }}>
                {deleteHistoryConfirm.title}
              </div>
            </div>
            <div className="rn-actions">
              <button
                className="rn-btn rn-btn-primary"
                ref={el => { if (el) setTimeout(() => el.focus(), 0); }}
                onClick={() => { deleteHistory(deleteHistoryConfirm.id); setDeleteHistoryConfirm(null); }}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); deleteHistory(deleteHistoryConfirm.id); setDeleteHistoryConfirm(null); }
                  else if (e.key === 'Escape') { e.preventDefault(); setDeleteHistoryConfirm(null); }
                }}
              >삭제</button>
              <button className="rn-btn" onClick={() => setDeleteHistoryConfirm(null)}>취소</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
};
