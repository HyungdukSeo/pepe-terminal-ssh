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

// gemini 모델 목록. pro=true 는 유료 요금제(Code Assist Standard 이상)에서만 사용 가능 →
// free-tier 계정에서는 '지원안함' 으로 표시. tier 는 gemini:modelInfo(loadCodeAssist) 로 조회.
const GEMINI_MODELS: { v: string; l: string; icon: string; pro?: boolean }[] = [
  { v: 'gemini-3-flash-preview', l: 'Gemini 3 Flash', icon: '⚡' },
  { v: 'gemini-3.1-flash-lite-preview', l: 'Gemini 3.1 Flash Lite', icon: '⚡' },
  { v: 'gemini-2.5-flash', l: 'Gemini 2.5 Flash', icon: '⚡' },
  { v: 'gemini-2.5-flash-lite', l: 'Gemini 2.5 Flash Lite', icon: '⚡' },
  { v: 'gemini-3-pro', l: 'Gemini 3 Pro', icon: '✨', pro: true },
  { v: 'gemini-2.5-pro', l: 'Gemini 2.5 Pro', icon: '✨', pro: true },
];
const isValidGeminiModel = (m: string) => GEMINI_MODELS.some(x => x.v === m);
// 요금제(isPaid)에 따라 해당 모델을 실제 사용할 수 있는지
const isGeminiModelUsable = (m: string, isPaid: boolean) => {
  const def = GEMINI_MODELS.find(x => x.v === m);
  return !!def && (!def.pro || isPaid);
};

// flowchart 노드 라벨에 () / :: / # 등 특수문자가 unquoted 로 들어가면 mermaid 파서가 깨짐.
// (예: E[new TraceJob(datas)] → Parse error). 라벨을 "..." 로 감싸 안전하게 만든다.
// codex 가 생성하는 다이어그램이 특히 함수명/스코프 연산자를 라벨에 자주 넣음.
function sanitizeMermaidLabels(src: string): string {
  let out = src;

  // 모델이 지정한 테마/init 디렉티브 제거 → 앱 전역 dark 테마로 통일.
  // (Claude 가 종종 %%{init: {theme}}%% 나 frontmatter 로 라이트 테마를 넣어 배경이 하얗게 나옴)
  out = out.replace(/%%\{\s*init\s*:[\s\S]*?\}\s*%%[ \t]*\r?\n?/gi, '');
  out = out.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/, fm =>
    fm.replace(/^[ \t]*theme[ \t]*:.*\r?\n/gim, ''));

  if (/^\s*sequenceDiagram\b/im.test(out)) {
    // Gemini가 줄바꿈 없이 붙여 내는 sequence 구문을 렌더 직전에 복구한다.
    out = out.replace(/([^\n])\s*(Note\s+(?:over|right of|left of)\b)/g, '$1\n    $2');
    out = out.replace(/(\b(?:alt|opt|loop|par|and|else)\b[^\n]*?)\s*(Note\s+(?:over|right of|left of)\b)/g, '$1\n    $2');

    // Mermaid sequenceDiagram에서 create/destroy 같은 키워드는 actor id로 쓰면 파서가 오해한다.
    const reserved = new Set(['actor', 'participant', 'create', 'destroy', 'note', 'alt', 'else', 'opt', 'loop', 'par', 'and', 'rect', 'end']);
    const renames = new Map<string, string>();
    out = out.replace(/(^|\n)(\s*(?:participant|actor)\s+)([A-Za-z_][A-Za-z0-9_]*)(\b)/g, (m, nl, prefix, id, suffix) => {
      if (!reserved.has(String(id).toLowerCase())) return m;
      const safe = `P_${id}`;
      renames.set(id, safe);
      return `${nl}${prefix}${safe}${suffix}`;
    });
    for (const [from, to] of renames) {
      out = out.replace(new RegExp(`\\b${from}\\b`, 'g'), to);
    }
    // Claude 가 단계 구분용으로 넣는 'rect rgb(...)' 의 밝은 파스텔 색은 dark 배경에서
    // 흰 박스처럼 보임 → 밝은 색만 저투명(rgba 0.13) 톤으로 변환해 dark 배경이 비치게 한다.
    out = out.replace(/(^|\n)([ \t]*)rect[ \t]+rgba?\(([^)]+)\)/gi, (m, nl, indent, args) => {
      const nums = String(args).split(',').map(s => parseFloat(s.trim()));
      const [r, g, b] = nums;
      if ([r, g, b].some(n => isNaN(n))) return m;
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      if (lum < 0.5) return m; // 이미 어두우면 그대로 유지
      return `${nl}${indent}rect rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, 0.13)`;
    });
    // 라벨/메시지 텍스트의 부등호 처리. HTML 엔티티(&lt; &gt;)는 끝의 ';' 가
    // mermaid 의 문장 구분자로 오인되어 파싱이 깨지고, 원시 < > 는 HTML 태그로
    // 오인됨 → 둘 다 특수의미가 없는 전각 부등호(＜ ＞)로 치환한다. <br/> 는 보존.
    {
      const escAngles = (t: string): string =>
        t.split(/(<br\s*\/?>)/i)
          .map((seg, i) => i % 2 === 1 ? '<br/>' : seg
            .replace(/&lt;/gi, '＜')
            .replace(/&gt;/gi, '＞')
            .replace(/&amp;/gi, '&')
            .replace(/&quot;/gi, '"')
            .replace(/&#0*39;|&apos;/gi, "'")
            .replace(/</g, '＜')
            .replace(/>/g, '＞'))
          .join('');
      out = out.split('\n').map(line => {
        const pm = line.match(/^(\s*(?:participant|actor)\s+[A-Za-z_]\w*\s+as\s+)(.+)$/i);
        if (pm) return pm[1] + escAngles(pm[2]);
        const cm = line.match(/^([^:\n]*:)(.*)$/);
        if (cm && /(-{1,2}>>?|-{1,2}x|-{1,2}\)|^\s*Note\b)/i.test(cm[1])) {
          return cm[1] + escAngles(cm[2]);
        }
        return line;
      }).join('\n');
    }
    return out;
  }

  // classDiagram 의 'class' 선언에서 ASCII/Unicode 도형 문자가 클래스 이름으로 사용된 경우
  // → 안전한 영문 alias 로 치환. 원본은 라벨 형태로 표시(주석으로 처리).
  if (/^\s*classDiagram\b/im.test(out)) {
    const badChars = /[─│┌┐└┘├┤┬┴┼╔╗╚╝═║╠╣╦╩╬│┃━┏┓┗┛△▲▽▼□■◆◇●○◯◎◉★☆▶◀▷◁]/;
    const aliasMap = new Map<string, string>();
    let cCtr = 0;
    out = out.split('\n').map(line => {
      // 'class IDENT {' 또는 'class IDENT' 형태
      const m = line.match(/^(\s*class\s+)(\S+?)(\s*\{?\s*)$/);
      if (m && badChars.test(m[2])) {
        const original = m[2];
        if (!aliasMap.has(original)) aliasMap.set(original, `C${++cCtr}`);
        const alias = aliasMap.get(original)!;
        return `${m[1]}${alias}${m[3]}`;
      }
      return line;
    }).join('\n');
    // 알리아스된 이름이 다른 줄(상속 등)에 참조될 수 있어 같이 교체
    if (aliasMap.size > 0) {
      out = out.split('\n').map(line => {
        for (const [from, to] of aliasMap) {
          const escFrom = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          line = line.replace(new RegExp(escFrom, 'g'), to);
        }
        return line;
      }).join('\n');
    }
    return out;
  }
  if (!/^\s*(flowchart|graph)\b/im.test(out)) return out;
  // mermaid v11 의 'ID@{ shape: X, label: "Y" }' 새 문법을 전통적 노드 모양으로 변환.
  // 새 문법이 일부 환경/설정(htmlLabels:false 등)에서 SVG 가 비어서 그려지는 케이스 대응.
  // shape 별로 가까운 전통 모양에 매핑, 매핑 없으면 사각형으로 fallback. 라벨은 따옴표로 감쌈.
  {
    const shapePair: Record<string, [string, string]> = {
      rect: ['[', ']'], 'rounded-rect': ['(', ')'], roundrect: ['(', ')'], 'round-rect': ['(', ')'],
      stadium: ['([', '])'], pill: ['([', '])'],
      circle: ['((', '))'], circ: ['((', '))'],
      'double-circle': ['(((', ')))'], 'dbl-circ': ['(((', ')))'],
      diamond: ['{', '}'], rhombus: ['{', '}'], decision: ['{', '}'],
      hex: ['{{', '}}'], hexagon: ['{{', '}}'],
      cyl: ['[(', ')]'], cylinder: ['[(', ')]'], db: ['[(', ')]'], database: ['[(', ')]'],
      subroutine: ['[[', ']]'], framed: ['[[', ']]'], procs: ['[[', ']]'],
      parallelogram: ['[/', '/]'], 'parallelogram-alt': ['[\\', '\\]'],
      trapezoid: ['[/', '\\]'], 'trap-b': ['[\\', '/]'], 'inv-trap': ['[\\', '/]'],
      flag: ['>', ']'], asym: ['>', ']'],
      // tri/triangle 은 mermaid v11 가 네이티브 지원 — 변환하지 않고 원본 그대로 두어
      // 사다리꼴이 아닌 진짜 삼각형으로 렌더되도록 함.
    };
    out = out.replace(
      /([A-Za-z_][A-Za-z0-9_]*)@\{[^{}\n]*?\}/g,
      (m, id) => {
        const shapeM = m.match(/shape\s*:\s*["']?([\w-]+)["']?/i);
        const labelM = m.match(/label\s*:\s*(["'])((?:\\.|(?!\1).)*)\1/);
        const shape = (shapeM?.[1] || 'rect').toLowerCase();
        // tri/triangle 은 mermaid v11 네이티브 처리에 맡김 (변환 X)
        if (shape === 'tri' || shape === 'triangle') return m;
        const label = labelM?.[2] ?? id;
        const pair = shapePair[shape] || ['[', ']'];
        const safeLabel = label.replace(/"/g, '#quot;');
        return `${id}${pair[0]}"${safeLabel}"${pair[1]}`;
      }
    );
  }
  out = out.replace(/(^|\n)(\s*)style([A-Za-z_][A-Za-z0-9_-]*)(\s+)/g, '$1$2style $3$4');
  const quote = (label: string): string | null => {
    const t = label.trim();
    if (!t || t.startsWith('"')) return null; // 이미 따옴표 / 빈 값 → 그대로
    // 특수문자 없으면 굳이 감싸지 않음 (단순 라벨은 원형 유지)
    if (!/[()#:;<>&]/.test(t)) return null;
    return `"${t.replace(/"/g, '&quot;')}"`;
  };
  // id[label]  ([[ / [( 같은 더블/복합 모양은 제외 — 안쪽에 [] 없을 때만)
  out = out.replace(/([A-Za-z0-9_]+)\[([^\[\]\n]+)\]/g, (m, id, label) => {
    const q = quote(label);
    return q ? `${id}[${q}]` : m;
  });
  // id{label}
  out = out.replace(/([A-Za-z0-9_]+)\{([^{}\n]+)\}/g, (m, id, label) => {
    const q = quote(label);
    return q ? `${id}{${q}}` : m;
  });

  // 한글 등 non-ASCII ID 가 노드 shape ([], (), {}, ([]), {{}}, [(...)] 등) 와 함께 쓰인 경우
  // mermaid 파서가 ID 로 인식 못해 실패함. 안전한 영문 alias (_n1, _n2 ...) 로 변환.
  // edges 에서 같은 ID 가 참조되면 함께 교체. 라벨(따옴표/괄호 안)은 영향 받지 않도록 보호.
  {
    const aliasMap = new Map<string, string>();
    let aliasCtr = 0;
    // 1단계: shape 와 결합된 non-ASCII ID 발견 → alias 생성
    // 매치 패턴: 줄 처음/공백/세미콜론/->/-->/=>/etc. 다음의 비-ASCII 시작 ID + shape opener
    const idCharClass = `[^\\s\\[\\](){}<>\\-,;|\\.\\/&%@*+!?:=\"'\`#]`;
    const collectRe = new RegExp(`(^|[\\s;]|--+>?|==+>?|-\\.-+|<--|<==)(${idCharClass}+)\\s*([\\[({])`, 'gu');
    out.replace(collectRe, (_m, _prefix, id) => {
      // 영문/숫자/언더스코어로만 된 ID 는 안전 — 스킵
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) return _m;
      if (!aliasMap.has(id)) aliasMap.set(id, `n${++aliasCtr}`);
      return _m;
    });
    // 2단계: 같은 ID 가 edges 등에서 참조되어도 함께 alias 로 치환되도록 추가 수집 — 첫 단계만으로도 일단 충분
    if (aliasMap.size > 0) {
      // 라벨/따옴표 영역은 보호 — 따옴표 안의 같은 단어가 같이 치환되면 안 됨.
      // 줄 단위로 처리하되 each line: '"' 안과 밖을 구분.
      const replaceOutsideQuotes = (line: string, fromRaw: string, to: string): string => {
        const escRaw = fromRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // 줄을 따옴표 기준으로 split — 짝수 인덱스만 따옴표 밖
        const parts = line.split(/("[^"\n]*"|'[^'\n]*')/);
        for (let i = 0; i < parts.length; i++) {
          if (i % 2 === 1) continue; // 따옴표 안 — 보호
          parts[i] = parts[i].replace(
            new RegExp(`(^|[\\s;,\\[\\](){}<>]|--+>?|==+>?|-\\.-+|<--|<==)${escRaw}(?=$|[\\s;,\\[\\](){}<>]|--+>?|==+>?|-\\.-+|<==|<--)`, 'g'),
            (_mm, pre) => `${pre}${to}`
          );
        }
        return parts.join('');
      };
      out = out.split('\n').map(line => {
        for (const [from, to] of aliasMap) line = replaceOutsideQuotes(line, from, to);
        return line;
      }).join('\n');
    }
  }

  // 'subgraph "Title"' 또는 'subgraph 한글타이틀' 등 안전하지 않은 형태 → 'subgraph _sgN["Title"]' 로 변환.
  // - 따옴표 형태 OR
  // - ID 가 비-ASCII(한글 등) 로 시작하는 경우 — 그 자체로 ID 가 안 되어 파서 오류
  {
    let sgCtr = 0;
    out = out.replace(
      /(^|\n)(\s*)subgraph\s+("([^"\n]+)"|'([^'\n]+)'|([^\s\[\n"'][^\[\n"']*?))(\s*)$/gm,
      (m, nl, indent, _quoted, dq, sq, bare) => {
        // 안전한 영문 ID 가 이미 있고 뒤에 shape/title 이 따로 없으면 그대로 둠
        if (bare && /^[A-Za-z_][A-Za-z0-9_]*$/.test(bare.trim())) return m;
        sgCtr++;
        const title = (dq || sq || bare || '').trim().replace(/"/g, '#quot;');
        return `${nl}${indent}subgraph sg${sgCtr}["${title}"]`;
      }
    );
    // CRLF/CR → LF 정규화 (다른 OS 줄바꿈 혼합 시 정규식 실패 회피)
    out = out.replace(/\r\n?/g, '\n');
    // 'subgraph ID [title]' (ID와 '[' 사이 공백) → 'subgraph ID[title]' (공백 제거)
    // ID 부분은 '[' 도 공백도 아닌 문자들 — \S+ 는 '[' 도 포함해 greedy 매치되어 잘못 잡힘.
    out = out.replace(/^([ \t]*subgraph[ \t]+[^\[\s]+)[ \t]+(\[)/gm, '$1$2');
    // 'subgraph ID[bare title]' (따옴표 없는 한글/특수문자 title) → 'subgraph ID["title"]'
    // mermaid 가 unquoted title 의 비-ASCII 문자를 일관성 있게 처리하지 못해 파싱 깨짐.
    out = out.replace(/^([ \t]*subgraph[ \t]+[^\[\s]+\[)([^\n\]"']+?)(\])/gm, (_m, pre, title, close) => {
      const t = String(title).trim();
      if (!t) return _m;
      return `${pre}"${t}"${close}`;
    });
    // 공백/빈 title bracket 통째 제거 — '[" "]', '[\'\']', '[ ]' 등은 mermaid 가 거부.
    out = out.replace(/^([ \t]*subgraph[ \t]+[^\[\s]+)\[\s*(?:"[\s]*"|'[\s]*'|)\s*\][ \t]*$/gm, '$1');
    // 'direction TB|LR|...' 내부 지시는 일부 환경에서 subgraph header 와 충돌 → 제거.
    out = out.replace(/^[ \t]*direction[ \t]+(TB|TD|BT|LR|RL)[ \t]*$/gm, '');
    // 노드 label 의 따옴표 안 leading/trailing 공백 trim — 일부 mermaid 버전이 STR 토큰
    // 시작/끝 공백을 허용 안 함. 예: `["  네모  "]` → `["네모"]`
    // ⚠ trim 결과가 빈 문자열이면 mermaid 가 거부하므로 원본 유지 (예: T{" "} 처럼 의도적 공백 라벨)
    out = out.replace(/([\[(){][\[(]?)\s*"([^"\n]+?)"\s*([\])}]?[\])}])/g, (_m, open, content, close) => {
      const trimmed = content.trim();
      if (!trimmed) return _m;
      return `${open}"${trimmed}"${close}`;
    });
    // 빈 줄(공백만 있는 줄 포함) 을 단일 newline 으로 축약.
    while (/\n[ \t]*\n/.test(out)) out = out.replace(/\n[ \t]*\n/g, '\n');
  }

  // 댓글(%%...) 라인은 alias 처리에서 제외 — 주석 안의 한글이 식별자로 오인되지 않도록.
  // placeholder 로 잠시 치환했다가 마지막에 원본 복원.
  const _commentPH: string[] = [];
  out = out.split('\n').map(line => {
    const m = line.match(/^([ \t]*)(%%.*)$/);
    if (m) {
      const idx = _commentPH.length;
      _commentPH.push(m[2]);
      return `${m[1]}MERMAID_CMT_${idx}_PH`;
    }
    return line;
  }).join('\n');

  // bare 노드 토큰(shape 없이 단독으로 쓰인 한글 식별자) 도 alias 로 치환.
  // 위 'shape 가 함께 쓰인 경우' alias 와 같은 컨테이너에서 동시에 처리하기 어려워 한 번 더 패스.
  // 예: subgraph 안의 '세모' 한 줄.
  // ⚠ 따옴표 안과 shape brackets([], (), {}, [[]], (()), [(...)], {{}} 등) 안의 라벨은 보호 — 그곳 한글은 라벨이지 식별자가 아님.
  {
    // 라벨 영역(따옴표 + 모든 mermaid shape + 엣지 라벨) 을 한 번에 매치해 split 의 보호 캡처로 사용.
    // 순서: 가장 긴 멀티문자 형태부터 (그래야 [[]] 가 [] 보다 먼저 매치)
    // 엣지 라벨 형태: --|label|--, --label--> (공백 포함), == label ==>, -.label.->
    // asymmetric/flag shape '>label]' (워드 문자가 앞에 와야 함 — '-->A' 같은 화살표와 구분)
    const labelProtectRe = /("[^"\n]*"|'[^'\n]*'|\[\[[^\]\n]*\]\]|\(\([^)\n]*\)\)|\{\{[^}\n]*\}\}|\[\([^)\n]*\)\]|\[\/[^\]\n]*\\\]|\[\\[^\]\n]*\/\]|\[\/[^\]\n]*\/\]|\[\\[^\]\n]*\\\]|\[[^\]\n]*\]|\([^)\n]*\)|\{[^}\n]*\}|(?<=[A-Za-z0-9_가-힯ㄱ-ㆎ])>[^>\n\]]*\]|\|[^|\n]*\||--+\s+[^-\n|]+\s+--+>?|==+\s+[^=\n|]+\s+==+>?|-\.+\s+[^\n|]+?\s+\.+-+>?)/g;
    const aliasMap = new Map<string, string>();
    let ctr = 0;
    // 토큰 정의: 한글 시작 + (한글/영문/숫자/_)*
    const koTokenRe = /[가-힯ㄱ-ㆎ][가-힯ㄱ-ㆎ\w]*/g;
    out.split('\n').forEach(line => {
      // 라벨 영역 외부에서만 한글 토큰 수집
      const parts = line.split(labelProtectRe);
      for (let i = 0; i < parts.length; i += 2) {
        let m;
        koTokenRe.lastIndex = 0;
        while ((m = koTokenRe.exec(parts[i])) !== null) {
          const tok = m[0];
          if (!aliasMap.has(tok)) aliasMap.set(tok, `n${++ctr}`);
        }
      }
    });
    if (aliasMap.size > 0) {
      out = out.split('\n').map(line => {
        const parts = line.split(labelProtectRe);
        for (let i = 0; i < parts.length; i += 2) {
          for (const [from, to] of aliasMap) {
            const escFrom = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            parts[i] = parts[i].replace(
              new RegExp(`(^|[^\\uAC00-\\uD7AF\\u3131-\\u318E\\w])${escFrom}(?=$|[^\\uAC00-\\uD7AF\\u3131-\\u318E\\w])`, 'g'),
              (_mm, pre) => `${pre}${to}`
            );
          }
        }
        return parts.join('');
      }).join('\n');
      // alias 된 노드의 라벨이 사라지므로 각 alias 의 첫 등장 줄에 `_nX[원본]` 형태로 라벨 부여
      // (이미 [...]/{...}/(...) shape 가 붙은 경우는 그쪽 라벨이 살아있어 추가 안 함)
      const lines = out.split('\n');
      for (const [from, to] of aliasMap) {
        let labeled = false;
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].includes(to)) continue;
          // 그 줄에 _nX 뒤에 이미 shape 가 있으면 라벨 보존됨
          const reShape = new RegExp(`${to}\\s*[\\[({]`);
          if (reShape.test(lines[i])) { labeled = true; break; }
        }
        if (labeled) continue;
        // shape 가 없는 bare 사용 — 첫 등장에 `[원본]` 추가
        for (let i = 0; i < lines.length; i++) {
          // 토큰 경계로 매치한 첫 위치만 라벨링
          const re = new RegExp(`(^|[^\\w])${to}(?=$|[^\\w])`);
          if (re.test(lines[i])) {
            lines[i] = lines[i].replace(re, (_mm, pre) => `${pre}${to}["${from}"]`);
            break;
          }
        }
      }
      out = lines.join('\n');
    }
  }
  // 댓글 placeholder 복원
  if (_commentPH.length > 0) {
    out = out.replace(/MERMAID_CMT_(\d+)_PH/g, (_m, n) => _commentPH[Number(n)] ?? _m);
  }
  return out;
}
function adjustMermaidNodeLabelContrast(root: HTMLElement) {
  const parseColor = (value: string | null): [number, number, number] | null => {
    if (!value) return null;
    const v = value.trim();
    if (!v || v === 'none' || v === 'transparent' || v === 'currentColor') return null;
    const hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hex) {
      const h = hex[1].length === 3
        ? hex[1].split('').map(ch => ch + ch).join('')
        : hex[1];
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    const rgb = v.match(/^rgba?\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)/i);
    if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    return null;
  };
  const luminance = ([r, g, b]: [number, number, number]) => {
    const toLinear = (c: number) => {
      const v = Math.max(0, Math.min(255, c)) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  };

  root.querySelectorAll<SVGGElement>('svg g.node').forEach(node => {
    const shape = node.querySelector<SVGElement>('rect, polygon, path, circle, ellipse');
    const fill = parseColor(shape?.getAttribute('fill') || shape?.style.fill || (shape ? getComputedStyle(shape).fill : null));
    if (!fill) return;
    const textColor = luminance(fill) > 0.45 ? '#111827' : '#f8fafc';
    node.querySelectorAll<SVGElement>('text').forEach(el => {
      el.style.setProperty('fill', textColor, 'important');
      el.style.setProperty('stroke', 'none', 'important');
      el.style.setProperty('text-shadow', 'none', 'important');
    });
    node.querySelectorAll<SVGElement>('.nodeLabel, .nodeLabel *').forEach(el => {
      el.style.setProperty('color', textColor, 'important');
      el.style.setProperty('fill', textColor, 'important');
      el.style.setProperty('stroke', 'none', 'important');
      el.style.setProperty('text-shadow', 'none', 'important');
    });
  });
}

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


function closeDanglingMermaidFences(md: string): string {
  md = md.replace(/([^\n])```\s*mermaid\b/gi, '$1\n```mermaid');
  const lines = md.split('\n');
  const out: string[] = [];
  let inMermaid = false;
  let mermaidBodyLines = 0;
  let mermaidIsFlowchart = false;
  let skipNextOrphanFence = false;
  const isMermaidSyntax = (line: string): boolean => {
    const t = line.trim();
    if (!t) return true;
    if (/^```/.test(t)) return true;
    if (/^%%/.test(t)) return true;
    if (MERMAID_START_RE.test(t)) return true;
    if (/^(subgraph|end|direction|classDef|class|style\s+|style[A-Za-z_][A-Za-z0-9_-]*\s+|linkStyle\s+)/.test(t)) return true;
    if (/^(click|accTitle|accDescr)\b/.test(t)) return true;
    // 한글 등 Unicode 시작 식별자도 mermaid 노드 ID 로 인정 (sanitizer 가 alias 처리)
    // shape opener 에 '>' (asymmetric/flag), '@{' (mermaid v11 shape node) 도 포함
    if (/^[A-Za-z_가-힯ㄱ-ㆎ][A-Za-z0-9_가-힯ㄱ-ㆎ]*\s*(\[|\{|\(|>|@\{|--|---|==|-.|:::|-->)/.test(t)) return true;
    if (/^[A-Za-z_가-힯ㄱ-ㆎ][A-Za-z0-9_가-힯ㄱ-ㆎ]*\s*$/.test(t)) return true;
    return false;
  };

  for (const line of lines) {
    const t = line.trim();
    if (!inMermaid && /^```\s*mermaid\b/i.test(t)) {
      inMermaid = true;
      mermaidBodyLines = 0;
      mermaidIsFlowchart = false;
      skipNextOrphanFence = false;
      out.push(line);
      continue;
    }
    if (!inMermaid && skipNextOrphanFence && /^```\s*$/.test(t)) {
      skipNextOrphanFence = false;
      continue;
    }
    if (inMermaid) {
      if (/^```/.test(t)) {
        inMermaid = false;
        mermaidBodyLines = 0;
        out.push(line);
        continue;
      }
      // 첫 본문 라인에서 다이어그램 타입 판별
      if (mermaidBodyLines === 0 && t) {
        mermaidIsFlowchart = /^(flowchart|graph)\b/.test(t);
      }
      // 미완성 fence 휴리스틱은 flowchart/graph 에서만 적용.
      // isMermaidSyntax 가 flowchart 문법만 인식 → sequence/class/state 등은
      // participant·메시지 라인을 prose 로 오인해 fence 를 중간에 잘라버림.
      if (mermaidIsFlowchart && mermaidBodyLines > 0 && !isMermaidSyntax(line)) {
        out.push('```');
        inMermaid = false;
        mermaidBodyLines = 0;
        skipNextOrphanFence = true;
        out.push(line);
        continue;
      }
      out.push(line);
      if (t) mermaidBodyLines++;
      continue;
    }
    out.push(line);
  }
  if (inMermaid) out.push('```');
  return out.join('\n');
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
  return marked.parse(autoConvertTablesInMd(autoFenceMermaid(closeDanglingMermaidFences(neutralizeSetextHeadings(content)))), { breaks: true }) as string;
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
  // 이 대화를 처음 만든 에이전트 (공유 OFF 모드에서 이력 필터링용)
  originAgent?: 'claude' | 'gemini' | 'codex';
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
    {
      const m = saved?.model ?? defaultModelFor(aiAgent);
      setModelRaw(aiAgent === 'gemini' && !isValidGeminiModel(m) ? defaultModelFor('gemini') : m);
    }
    setEffort(saved?.effort ?? 'medium');
    setPermissionMode(saved?.permissionMode ?? 'default');
    setPerToolApproval(saved?.perToolApproval ?? true);
    setGeminiYolo(saved?.geminiYolo ?? false);
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
  // pending/rejected plan 의 소속 에이전트 — 공유 OFF 시 다른 에이전트 view 에서 숨김
  const [pendingPlanAgent, setPendingPlanAgent] = useState<string | null>(null);
  const [lastRejectedPlanAgent, setLastRejectedPlanAgent] = useState<string | null>(null);
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
  // codex 전용 — 컨텍스트 윈도우 크기 + 요금 한도(rate_limits) (codex 세션 rollout 파일에서 추출)
  type CodexRateWindow = { used_percent: number; window_minutes: number; resets_at: number };
  const [codexInfo, setCodexInfo] = useState<{ contextWindow: number | null; primary: CodexRateWindow | null; secondary: CodexRateWindow | null; planType: string | null } | null>(null);
  // gemini 요금제(tier) — 모델 가용성('지원안함') 판별용. null=미조회
  const [geminiTier, setGeminiTier] = useState<{ tierId: string; tierName: string; isPaid: boolean } | null>(null);
  // gemini 모델별 잔여 한도 (retrieveUserQuota) — remainingFraction 0~1
  const [geminiQuota, setGeminiQuota] = useState<{ modelId: string; remainingFraction: number | null; resetTime: string | null }[] | null>(null);
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
  // 에이전트 간 컨텍스트 공유 — 켜져있으면 send 시 이전 transcript(다른 에이전트 답변 포함) 를 inject.
  // UIPrefs 에 영속화. 기본값 true (기존 동작 유지).
  const [shareContext, setShareContext] = useState<boolean>(true);
  const shareContextRef = useRef(true);
  const shareContextLoadedRef = useRef(false);
  useEffect(() => { shareContextRef.current = shareContext; }, [shareContext]);
  // 공유 토글 시점 — 기존 Claude 세션은 토글 전 모드(공유 ON 또는 OFF)에서 만들어진 것이라
  // 그 세션에 이미 다른 에이전트 컨텍스트가 주입되어 있을 수 있음. --resume 시 옛 메모리를
  // 그대로 가져오면 공유 OFF 가 무력화됨 → 토글 시점에 폐기해 다음 Claude send 에서 새 세션 생성.
  // (첫 toggle 직후의 mount-effect 무한 폐기 방지를 위해 ref 로 첫 실행 스킵)
  const shareContextInitRef = useRef(false);
  useEffect(() => {
    if (!shareContextInitRef.current) { shareContextInitRef.current = true; return; }
    claudeSessionIdRef.current = null;
  }, [shareContext]);
  useEffect(() => {
    (async () => {
      try {
        const prefs = await (window as any).api?.getUIPrefs?.();
        if (typeof prefs?.aiShareContext === 'boolean') setShareContext(prefs.aiShareContext);
      } catch {}
      shareContextLoadedRef.current = true;
    })();
  }, []);
  useEffect(() => {
    if (!shareContextLoadedRef.current) return;
    try { (window as any).api?.setUIPrefs?.({ aiShareContext: shareContext }); } catch {}
  }, [shareContext]);

  // 공유 OFF 모드에서 에이전트별로 streaming 상태를 추적 — 한 에이전트 응답 대기 중에
  // 다른 에이전트로 프롬프트 전송이 가능하도록.
  const [streamingAgents, setStreamingAgents] = useState<Set<string>>(new Set());
  const addStreamingAgent = (a: string) => setStreamingAgents(prev => { const s = new Set(prev); s.add(a); return s; });
  const removeStreamingAgent = (a: string) => setStreamingAgents(prev => { const s = new Set(prev); s.delete(a); return s; });

  // 검색: 현재 대화 메시지 본문 안에서 찾기
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchHitCount, setSearchHitCount] = useState(0);
  const [searchCurrent, setSearchCurrent] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchHitsRef = useRef<HTMLElement[]>([]);
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
  // codex/gemini 계획(plan) 단계로 전송된 requestId 집합 — 응답 수신 시 계획 모달 표시 판별용
  const codexPlanRequestsRef = useRef<Set<string>>(new Set());
  const geminiPlanRequestsRef = useRef<Set<string>>(new Set());
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
  // Gemini: --yolo 온/오프 (기본 false — 수동 승인)
  const [geminiYolo, setGeminiYolo] = useState<boolean>(false);
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
  // gemini 탭 진입 시 요금제(tier) 조회 → 모델 가용성('지원안함') 갱신
  useEffect(() => {
    if (currentAgent !== 'gemini') return;
    let cancelled = false;
    (async () => {
      try {
        const r: any = await (window as any).api?.geminiModelInfo?.();
        if (!cancelled && r?.success) {
          setGeminiTier({ tierId: r.tierId, tierName: r.tierName, isPaid: !!r.isPaid });
          if (Array.isArray(r.quotaBuckets)) setGeminiQuota(r.quotaBuckets);
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [currentAgent]);
  // codex 탭 진입 시 요금 한도 조회 → 대화 없이도 남은 한도 표시 (최근 rollout 파일 기반)
  useEffect(() => {
    if (currentAgent !== 'codex') return;
    let cancelled = false;
    (async () => {
      try {
        const r: any = await (window as any).api?.codexRateLimits?.();
        if (!cancelled && r?.success && r.rateLimits) {
          setCodexInfo({
            contextWindow: r.info?.model_context_window || null,
            primary: r.rateLimits.primary || null,
            secondary: r.rateLimits.secondary || null,
            planType: r.rateLimits.plan_type || null,
          });
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [currentAgent]);
  // 요금제 확인 후 현재 선택 모델이 못 쓰는 모델이면 기본 모델로 자동 전환
  useEffect(() => {
    if (currentAgent === 'gemini' && geminiTier && !isGeminiModelUsable(model, geminiTier.isPaid)) {
      setModel('gemini-2.5-flash');
    }
  }, [geminiTier, currentAgent]);
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
    {
      const m = saved?.model ?? defaultModelFor(a);
      setModelRaw(a === 'gemini' && !isValidGeminiModel(m) ? defaultModelFor('gemini') : m);
    }
    setEffort(saved?.effort ?? 'medium');
    setPermissionMode(saved?.permissionMode ?? 'default');
    setPerToolApproval(saved?.perToolApproval ?? true);
    setGeminiYolo(saved?.geminiYolo ?? false);
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

  // ── 메시지 검색 ──────────────────────────────────────────────────────────
  // 기존 <mark.claude-search-hit> 모두 제거하고 원래 텍스트 노드로 복원
  const clearSearchHighlights = useCallback((root: HTMLElement | null) => {
    if (!root) return;
    const marks = root.querySelectorAll('mark.claude-search-hit');
    marks.forEach(m => {
      const parent = m.parentNode;
      if (!parent) return;
      const txt = document.createTextNode(m.textContent || '');
      parent.replaceChild(txt, m);
    });
    // 인접 텍스트 노드 정리 (재검색 시 매치 안정성)
    root.normalize();
  }, []);

  // 메시지 컨테이너 내 텍스트 노드 중 q 와 일치하는 부분을 <mark> 로 감싸 매치 element 배열 반환
  const applySearchHighlights = useCallback((root: HTMLElement | null, q: string): HTMLElement[] => {
    if (!root || !q) return [];
    const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(esc, 'gi');
    const hits: HTMLElement[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const targets: Text[] = [];
    let n: Node | null;
    while ((n = walker.nextNode())) {
      const t = n as Text;
      if (!t.nodeValue) continue;
      const p = t.parentElement;
      if (!p) continue;
      // 검색바 자체 / 이미 마크된 것 / script style 제외
      if (p.closest('.claude-chat-search-bar, mark.claude-search-hit, script, style')) continue;
      if (re.test(t.nodeValue)) targets.push(t);
      re.lastIndex = 0;
    }
    for (const node of targets) {
      const text = node.nodeValue!;
      const parent = node.parentNode!;
      const frag = document.createDocumentFragment();
      let lastIdx = 0;
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (m.index > lastIdx) frag.appendChild(document.createTextNode(text.slice(lastIdx, m.index)));
        const mark = document.createElement('mark');
        mark.className = 'claude-search-hit';
        mark.textContent = m[0];
        frag.appendChild(mark);
        hits.push(mark);
        lastIdx = m.index + m[0].length;
        if (m[0].length === 0) re.lastIndex++; // 무한 루프 방지
      }
      if (lastIdx < text.length) frag.appendChild(document.createTextNode(text.slice(lastIdx)));
      parent.replaceChild(frag, node);
    }
    return hits;
  }, []);

  // 검색 쿼리/메시지 변경 시 하이라이트 재적용
  useEffect(() => {
    const root = scrollRef.current;
    clearSearchHighlights(root);
    if (!showSearch || !searchQuery.trim()) {
      searchHitsRef.current = [];
      setSearchHitCount(0);
      setSearchCurrent(0);
      return;
    }
    const hits = applySearchHighlights(root, searchQuery);
    searchHitsRef.current = hits;
    setSearchHitCount(hits.length);
    // 현재 인덱스 범위 보정 + 그 hit 으로 스크롤
    setSearchCurrent(prev => {
      if (hits.length === 0) return 0;
      const idx = Math.min(prev, hits.length - 1);
      return idx;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSearch, searchQuery, messages, toolTimeline, applySearchHighlights, clearSearchHighlights]);

  // 현재 hit 하이라이트 (current 클래스) + 스크롤
  useEffect(() => {
    const hits = searchHitsRef.current;
    hits.forEach((el, i) => el.classList.toggle('current', i === searchCurrent));
    const cur = hits[searchCurrent];
    if (cur) cur.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [searchCurrent, searchHitCount]);

  const nextSearchHit = useCallback(() => {
    setSearchCurrent(prev => {
      const n = searchHitsRef.current.length;
      if (n === 0) return 0;
      return (prev + 1) % n;
    });
  }, []);
  const prevSearchHit = useCallback(() => {
    setSearchCurrent(prev => {
      const n = searchHitsRef.current.length;
      if (n === 0) return 0;
      return (prev - 1 + n) % n;
    });
  }, []);
  const closeSearch = useCallback(() => {
    setShowSearch(false);
    setSearchQuery('');
  }, []);
  // 검색 토글 시 입력 자동 포커스
  useEffect(() => {
    if (showSearch) {
      requestAnimationFrame(() => searchInputRef.current?.focus());
    }
  }, [showSearch]);
  // ────────────────────────────────────────────────────────────────────────

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
          // 비활성 대화의 stream 이 끝났을 때도 streamingAgents set 에서 해당 에이전트 제거
          // (이게 빠지면 다른 탭으로 전환한 채 응답이 끝나도 그 에이전트가 'streaming' 상태로 영영 남음)
          removeStreamingAgent(streamAgent);
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
            setPendingPlanAgent(streamAgent);
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
        removeStreamingAgent(streamAgent);
        setActivity('');
        currentAsstIdRef.current = null;
        activeRequestIdRef.current = null;
        // codex/gemini 계획 단계 응답 — [CODEX_PLAN]/[GEMINI_PLAN] 마커가 있으면 계획 승인 모달 표시
        if (reqId && (codexPlanRequestsRef.current.has(reqId) || geminiPlanRequestsRef.current.has(reqId))) {
          codexPlanRequestsRef.current.delete(reqId);
          geminiPlanRequestsRef.current.delete(reqId);
          setMessages(prev => {
            let idx = -1;
            for (let i = prev.length - 1; i >= 0; i--) { if (prev[i].role === 'assistant') { idx = i; break; } }
            if (idx >= 0) {
              const mt = prev[idx].content.match(/^\s*\[(?:CODEX|GEMINI)_PLAN\]\s*\n?([\s\S]*)$/);
              if (mt) {
                const planText = mt[1].trim();
                setTimeout(() => { setPendingPlan(planText); setPendingPlanAgent(streamAgent); }, 0);
                // 계획은 모달로만 표시 — 채팅 메시지에서는 제거 (모달+채팅 중복 방지)
                return prev.filter((_, i) => i !== idx);
              }
            }
            return prev;
          });
        }
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
        removeStreamingAgent(streamAgent);
        activeRequestIdRef.current = null;
        if (reqId) {
          codexPlanRequestsRef.current.delete(reqId);
          geminiPlanRequestsRef.current.delete(reqId);
          requestToHistoryRef.current.delete(reqId);
          requestToAgentRef.current.delete(reqId);
        }
        const aid = activeHistoryIdRef.current;
        if (aid) {
          setChatHistory(hList => hList.map(h => h.id === aid ? { ...h, streaming: false, pendingRequestId: null } : h));
        }
      } else if (msg.type === 'codex_usage') {
        // codex 토큰 사용량 + 요금 한도 → usage / codexInfo 상태 반영 (rollout 파일 기반)
        const info = msg.info;
        const last = info?.last_token_usage;
        const total = info?.total_token_usage || last;
        if (last) {
          const inT = last.input_tokens || 0;
          const cachedT = last.cached_input_tokens || 0;
          const outT = (last.output_tokens || 0) + (last.reasoning_output_tokens || 0);
          const totIn = total?.input_tokens || inT;
          const totOut = (total?.output_tokens || 0) + (total?.reasoning_output_tokens || 0);
          const totCached = total?.cached_input_tokens || cachedT;
          setUsage(prev => ({
            ...prev,
            inputTokens: prev.inputTokens + totIn,
            outputTokens: prev.outputTokens + totOut,
            cacheReadTokens: prev.cacheReadTokens + totCached,
            lastTurnInput: inT,
            lastTurnOutput: outT,
            lastTurnFreshInput: Math.max(0, inT - cachedT),
            lastTurnCacheRead: cachedT,
            lastTurnCacheCreate: 0,
            turns: prev.turns + 1,
            model: prev.model || model,
          }));
        }
        const rl = msg.rateLimits;
        if (info?.model_context_window || rl) {
          setCodexInfo({
            contextWindow: info?.model_context_window || null,
            primary: rl?.primary || null,
            secondary: rl?.secondary || null,
            planType: rl?.plan_type || null,
          });
        }
      } else if (msg.type === 'gemini_usage' && msg.stats) {
        // gemini result.stats → usage 상태 (컨텍스트 토큰)
        const st = msg.stats;
        const inT = st.input_tokens || 0;
        const outT = st.output_tokens || 0;
        const cachedT = st.cached || 0;
        setUsage(prev => ({
          ...prev,
          inputTokens: prev.inputTokens + inT,
          outputTokens: prev.outputTokens + outT,
          cacheReadTokens: prev.cacheReadTokens + cachedT,
          lastTurnInput: inT,
          lastTurnOutput: outT,
          lastTurnFreshInput: typeof st.input === 'number' ? st.input : Math.max(0, inT - cachedT),
          lastTurnCacheRead: cachedT,
          lastTurnCacheCreate: 0,
          turns: prev.turns + 1,
          model: prev.model || model,
        }));
      } else if (msg.type === 'text' && msg.text) {
        // ⚠ updater 는 반드시 순수해야 함 — React StrictMode 가 updater 를 2번 호출함.
        // asstId 결정 + ref 변경 + nextSeq() 는 updater 밖에서 1회만 수행하고,
        // updater 안에서는 prev + 고정값만 사용 (codex/gemini 응답 누락 버그 수정).
        const txt = msg.text;
        let asstId = currentAsstIdRef.current;
        if (!asstId) {
          asstId = `asst-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          currentAsstIdRef.current = asstId;
        }
        const fixedAsstId = asstId;
        const newSeq = nextSeq();
        setMessages(prev => {
          if (prev.some(m => m.id === fixedAsstId)) {
            return prev.map(m => m.id === fixedAsstId ? { ...m, content: m.content + txt } : m);
          }
          return [...prev, { role: 'assistant', content: txt, id: fixedAsstId, seq: newSeq, agent: streamAgent }];
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
    // 스트리밍 중엔 messages 가 빠르게 변함 → 디바운스로 마지막 변경 후 1회만 렌더.
    // (미완성 mermaid 블록을 렌더 시도하다 에러 div 가 남는 문제 방지)
    const __mermaidTimer = setTimeout(() => {
    // 메시지 영역 + plan 모달 본문 모두 스캔
    const roots: HTMLElement[] = [];
    if (scrollRef.current) roots.push(scrollRef.current);
    document.querySelectorAll<HTMLElement>('.claude-chat-plan-body').forEach(el => roots.push(el));
    const codeBlocks: HTMLElement[] = [];
    for (const r of roots) {
      // :not([data-mermaid-rendered="1"]) — 성공 렌더된 것만 skip
      // error로 마크된 것도 내용이 바뀌었으면(스트리밍 완료 후) 재시도 허용
      r.querySelectorAll<HTMLElement>('pre > code').forEach(el => {
        const rendered = el.getAttribute('data-mermaid-rendered');
        if (rendered === '1') return; // 성공 렌더 → skip
        const source = (el.textContent || '').trim();
        // error 마크됐지만 내용이 달라지면 재시도 (스트리밍 중 partial → 완성)
        if (rendered === 'error' && el.getAttribute('data-mermaid-src') === source) return;
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
        const source = (codeEl.textContent || '').trim();
        const id = `mermaid-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`;
        // 인코딩 깨짐 감지: Korean Compatibility Jamo(U+3130-U+318F)는 diagram에
        // 거의 등장하지 않으며 이 범위 문자가 있으면 mermaid parser가 무한루프에 빠짐
        const sourceAgent = codeEl.closest<HTMLElement>('.claude-chat-msg')?.dataset.agent || currentAgentRef.current;
        if (sourceAgent !== 'gemini' && /[㄰-㆏]/.test(source)) {
          codeEl.setAttribute('data-mermaid-rendered', 'error');
          codeEl.setAttribute('data-mermaid-src', source);
          const errDiv = document.createElement('div');
          errDiv.className = 'claude-chat-mermaid-error';
          errDiv.textContent = '⚠ 다이어그램 인코딩 오류 (Codex 한글 인코딩 문제)';
          if (pre && pre.parentElement) pre.parentElement.insertBefore(errDiv, pre);
          continue;
        }
        // 처리 시작 전 src 기록 (에러 시 재시도 방지)
        codeEl.setAttribute('data-mermaid-src', source);
        // 특수문자 라벨을 따옴표로 감싸 mermaid 파서 에러 방지 (codex 다이어그램 대응)
        const renderSrc = sanitizeMermaidLabels(source);
        try {
          (window as any).api?.debugDump?.('pepe-mermaid-src.txt',
            `=====SOURCE=====\n${source}\n\n=====SANITIZED=====\n${renderSrc}\n`);
        } catch {}
        try {
          const { svg } = await Promise.race([
            mermaid.render(id, renderSrc),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('mermaid render timeout (8s)')), 8000)
            ),
          ]);
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
          // 'subgraph 별 ...' 같이 title 에 '★' / '⬟' 가 포함된 cluster 의 사각형을
          // SVG 별 모양 polygon 으로 교체 — mermaid 자체는 별-shape subgraph 를 지원 안 함.
          try {
            const renderedSvg2 = svgHolder.querySelector('svg');
            if (renderedSvg2) {
              const clusters = renderedSvg2.querySelectorAll('g.cluster, g.clusters > g');
              clusters.forEach(cluster => {
                const title = cluster.querySelector('text, .cluster-label, .nodeLabel');
                const titleText = title?.textContent || '';
                let shapeKind: 'star' | 'pentagon' | 'triangle' | 'diamond' | 'hexagon' | null = null;
                if (/★|☆|⭐/.test(titleText)) shapeKind = 'star';
                else if (/⬠|⬟/.test(titleText)) shapeKind = 'pentagon';
                else if (/△|▲|▽|▼/.test(titleText)) shapeKind = 'triangle';
                else if (/◆|◇|♦|♢/.test(titleText)) shapeKind = 'diamond';
                else if (/⬢|⬣|⎔/.test(titleText)) shapeKind = 'hexagon';
                if (!shapeKind) return;
                const rect = cluster.querySelector(':scope > rect');
                if (!rect) return;
                const x = parseFloat(rect.getAttribute('x') || '0');
                const y = parseFloat(rect.getAttribute('y') || '0');
                const w = parseFloat(rect.getAttribute('width') || '0');
                const h = parseFloat(rect.getAttribute('height') || '0');
                if (!w || !h) return;
                const cx = x + w / 2, cy = y + h / 2;
                const outerR = Math.min(w, h) / 2 - 2;
                const pts: string[] = [];
                if (shapeKind === 'star') {
                  // 10 vertex (5 outer + 5 inner) 별. 내접 비율 ~ 0.38.
                  const innerR = outerR * 0.38;
                  for (let i = 0; i < 10; i++) {
                    const r = i % 2 === 0 ? outerR : innerR;
                    const ang = -Math.PI / 2 + i * (Math.PI / 5);
                    pts.push(`${(cx + r * Math.cos(ang)).toFixed(1)},${(cy + r * Math.sin(ang)).toFixed(1)}`);
                  }
                  // 별 모양은 좁아서 안에 자식이 안 들어가므로 가로/세로 1.4 배 확장
                  // → 별 꼭지점이 rect 영역 밖으로 나가지만 viewBox 가 자동 조정되거나
                  //   별이 더 큼직하게 보임. 내부 자식 위치는 mermaid 의 기존 좌표 그대로.
                } else if (shapeKind === 'pentagon') {
                  for (let i = 0; i < 5; i++) {
                    const ang = -Math.PI / 2 + i * (2 * Math.PI / 5);
                    pts.push(`${(cx + outerR * Math.cos(ang)).toFixed(1)},${(cy + outerR * Math.sin(ang)).toFixed(1)}`);
                  }
                } else if (shapeKind === 'triangle') {
                  // 정삼각형 (꼭지 위) — rect 영역에 내접. 3개 꼭지점.
                  // 내용물이 안에 들어가야 하므로 폭/높이를 살짝 확장 (1.15배)
                  const tw = w / 2 * 1.15;
                  const th = h / 2 * 1.05;
                  pts.push(`${cx.toFixed(1)},${(cy - th).toFixed(1)}`);
                  pts.push(`${(cx + tw).toFixed(1)},${(cy + th).toFixed(1)}`);
                  pts.push(`${(cx - tw).toFixed(1)},${(cy + th).toFixed(1)}`);
                } else if (shapeKind === 'diamond') {
                  // 마름모/다이아몬드 — 4개 꼭지점, 90도 회전
                  const dw = w / 2;
                  const dh = h / 2;
                  pts.push(`${cx.toFixed(1)},${(cy - dh).toFixed(1)}`);
                  pts.push(`${(cx + dw).toFixed(1)},${cy.toFixed(1)}`);
                  pts.push(`${cx.toFixed(1)},${(cy + dh).toFixed(1)}`);
                  pts.push(`${(cx - dw).toFixed(1)},${cy.toFixed(1)}`);
                } else if (shapeKind === 'hexagon') {
                  // 정육각형, 평면 위 (납작한 면이 위/아래). 6개 꼭지점.
                  for (let i = 0; i < 6; i++) {
                    const ang = i * (Math.PI / 3);
                    pts.push(`${(cx + outerR * Math.cos(ang)).toFixed(1)},${(cy + outerR * Math.sin(ang)).toFixed(1)}`);
                  }
                }
                const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
                poly.setAttribute('points', pts.join(' '));
                poly.setAttribute('fill', rect.getAttribute('fill') || 'none');
                poly.setAttribute('stroke', rect.getAttribute('stroke') || '#bbb');
                poly.setAttribute('stroke-width', rect.getAttribute('stroke-width') || '1.5');
                // rect 의 클래스/스타일 정보 유지
                const cls = rect.getAttribute('class');
                if (cls) poly.setAttribute('class', cls);
                rect.replaceWith(poly);
              });
            }
          } catch {}
          // 모델이 라이트 테마 디렉티브를 넣어 SVG 배경이 하얗게 나오는 경우 방어 —
          // SVG 인라인 배경 및 전체 캔버스 배경 rect 를 투명화해 앱 dark 배경이 비치게 한다.
          try {
            const renderedSvg = svgHolder.querySelector('svg') as SVGSVGElement | null;
            if (renderedSvg) {
              renderedSvg.style.backgroundColor = 'transparent';
              const isLight = (c: string) => {
                const v = c.trim().toLowerCase();
                return v === '#fff' || v === '#ffffff' || v === 'white' ||
                  v === 'rgb(255, 255, 255)' || v === 'rgb(255,255,255)' ||
                  /^#(f{3}|f{6})$/.test(v) || /^#(e|f)[0-9a-f]/.test(v);
              };
              // 임베드된 <style> 의 background-color 선언 제거
              renderedSvg.querySelectorAll('style').forEach(st => {
                if (st.textContent && /background(-color)?\s*:/i.test(st.textContent)) {
                  st.textContent = st.textContent.replace(/background(-color)?\s*:[^;}]+;?/gi, '');
                }
              });
              // 전체 캔버스를 덮는 밝은 배경 rect 만 투명화 (개별 노드/박스는 건드리지 않음)
              renderedSvg.querySelectorAll('rect').forEach(r => {
                const cls = r.getAttribute('class') || '';
                const fill = (r.getAttribute('fill') || r.style.fill || '').toString();
                if (!fill || !isLight(fill)) return;
                const isBg = /background/i.test(cls) || (!cls && (!r.previousElementSibling));
                if (isBg) { r.setAttribute('fill', 'transparent'); r.style.fill = 'transparent'; }
              });
            }
          } catch {}
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
            adjustMermaidNodeLabelContrast(wrap);
            requestAnimationFrame(() => adjustMermaidNodeLabelContrast(wrap));
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
    }, 250);
    return () => clearTimeout(__mermaidTimer);
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

  // 현재 에이전트 view 에 적용할 streaming — 공유 OFF 시 다른 에이전트 stream 은 제외
  const currentAgentStreaming = shareContext ? streaming : streamingAgents.has(currentAgent);
  const send = useCallback(async (text: string, contextItems: FileContextItem[]) => {
    if (!text.trim()) return;
    // 공유 OFF: 현재 에이전트만 busy 이면 차단, 다른 에이전트 stream 은 신경 안 씀
    const guardBusy = shareContextRef.current ? streaming : streamingAgents.has(currentAgentRef.current);
    if (guardBusy) return;
    addStreamingAgent(currentAgentRef.current);
    // 이번 send 의 대화 세대 기록 — 이후 도착하는 stream 이벤트가 이 세대에 속한 경우만 처리
    activeGenRef.current = conversationGenRef.current;
    // 이번 send 의 고유 requestId
    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    activeRequestIdRef.current = requestId;
    let prompt = text;
    let attachBadge = '';
    const addDirsSet = new Set<string>();
    const contextLines: string[] = [];

    // 0.A) 포크/이력 후속 질문이면 작업 대상을 prompt 최상단 + user text 에 직접 명시.
    // 공유 OFF 시에는 다른 에이전트한테 했던 첫 user 메시지를 inject 하면 정보가 누설되므로,
    // 현재 에이전트의 스레드(자기가 응답했던 user 메시지) 중 첫 번째만 사용.
    let forkOriginalRequest: string | null = null;
    let forkTargetPath: string | null = null;
    if (!claudeSessionIdRef.current && messages.length > 0) {
      const curAgent = currentAgentRef.current;
      // user 메시지의 타겟 에이전트 추정 — 그 다음에 응답한 assistant 의 agent
      const userTargetForFork = (userIdx: number): string => {
        for (let j = userIdx + 1; j < messages.length; j++) {
          const mm = messages[j];
          if (mm.role === 'assistant') return mm.agent || 'claude';
          if (mm.role === 'user') break;
        }
        return curAgent;
      };
      const firstUserMsg = shareContextRef.current
        ? messages.find(m => m.role === 'user')
        : messages.find((m, idx) => m.role === 'user' && userTargetForFork(idx) === curAgent);
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

      if (currentAgentRef.current === 'gemini') {
        // Gemini 는 WebDAV UNC 워크스페이스를 못 씀 → pepe_ssh MCP 도구로만 원격 접근
        contextLines.push(
          `# 중요: 원격 SSH 접근 규칙 (필수)`,
          ``,
          `현재 SSH 세션: **${activeMount.label}** — 원격 Linux 호스트입니다.`,
          `원격 파일/명령은 반드시 **pepe_ssh MCP 도구**로 접근하세요.`,
          ``,
          `## 도구 사용 규칙 (반드시 준수)`,
          `❌ Read / Write / Edit / Glob / LS / Bash 등 로컬 파일·셸 도구를 원격 경로에 쓰지 마세요 — 원격 파일은 이 PC 에 없습니다.`,
          `✅ **원격 파일 읽기**: \`ssh_read_file(path="/원격/유닉스/절대경로")\``,
          `✅ **원격 파일 쓰기/수정**: \`ssh_write_file(path="...", content="...")\` — 수정 시 먼저 ssh_read_file 로 읽고 수정된 전체 내용을 다시 씁니다`,
          `✅ **원격 명령 실행**: \`ssh_exec(command="...")\` — cleartool, ctco, git, make, grep, find, ls 등`,
          `✅ 모든 경로는 **원격 Unix 절대경로 그대로** 사용 (예: \`/view/ghj_view/vobs/...\`). Windows/UNC 경로 변환 불필요.`,
          ``,
        );
      } else {
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
      }

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

    // 0.9) 다이어그램/플로우차트는 반드시 Mermaid 코드 블록으로
    contextLines.push(
      `# 다이어그램 출력 가이드`,
      `다이어그램(DFD, 플로우차트, 시퀀스, 클래스 등)은 **\`\`\`mermaid 코드 블록**으로 출력합니다. 사용자 환경이 자동 SVG 렌더링합니다.`,
      `**라벨에는 한글/이모지 자유롭게 사용 가능합니다** — 라벨은 시각적으로 표시되는 텍스트이고, 식별자는 영문 그대로 두면 됩니다.`,
      `**식별자(ID)는 영문/숫자/언더스코어**: 예) \`A\`, \`Node1\`, \`Circle\`. 한글이나 도형 기호(△▲□ 등)를 ID 로 쓰면 파서가 깨집니다.`,
      `**도형 모양별 문법**:`,
      `  - 사각형 (네모): \`A[네모]\`  또는 \`A["네모 라벨"]\``,
      `  - 원 (동그라미): \`B((동그라미))\``,
      `  - 마름모: \`C{마름모}\``,
      `  - 삼각형 (세모): **반드시 \`D@{ shape: tri, label: "세모" }\`** 형태로 (mermaid v11 네이티브 삼각형). \`[/세모\\\\]\` 는 사다리꼴이라 X.`,
      `  - 라운드 사각형: \`E(라운드)\`  육각형: \`F{{육각}}\`  원통: \`G[(원통)]\``,
      `**subgraph (중첩 그룹)**: \`subgraph X[제목]\`...\`end\` — 제목에 한글 OK, ID 는 영문.`,
      `**subgraph 를 원형으로 만들기**: \`style X rx:200,ry:200\` — 모서리 반지름을 매우 크게 주면 시각적으로 원/타원처럼 보임. "subgraph 는 항상 사각형이라 원형 못 만든다" 같은 말은 잘못된 것입니다 — rx/ry 트릭으로 충분히 원형이 됩니다.`,
      `**subgraph 의 모양(컨테이너 박스)을 다양하게 만들기** — title 에 모양 기호를 포함하면 사용자 환경의 SVG 후처리가 사각형을 자동으로 해당 모양 polygon 으로 교체합니다. "subgraph 는 사각형뿐이라 못 만든다"는 잘못된 인식입니다:`,
      `  - ★ ☆ ⭐ : 별 모양 컨테이너 (예: \`subgraph S["★ 별 영역"]\`)`,
      `  - △ ▲ ▽ ▼ : **삼각형 모양 컨테이너** — 안에 다른 도형/노드 중첩 가능 (예: \`subgraph T["△ 세모 영역"]\` 안에 동그라미 노드 배치)`,
      `  - ◆ ◇ ♦ : 마름모 모양 컨테이너`,
      `  - ⬠ ⬟ : 오각형  /  ⬢ ⬣ : 육각형`,
      `이 컨벤션 덕에 "삼각형 안에 동그라미" 같은 중첩도 가능합니다 — subgraph 의 title 에 △ 를 넣으세요.`,
      `**다크 테마 주의**: 사용자 환경은 mermaid dark 테마라 배경이 어둡습니다. **style 에서 색상은 지정하지 마세요 (fill/stroke 생략)** — 테마가 자동으로 밝게 처리합니다. 굳이 색을 줘야 하면 stroke 는 \`#aaa\` 이상의 밝은 색을 쓰세요. \`stroke:#333\` 같은 어두운 색은 거의 안 보입니다.`,
      `**빈 라벨 / 빈 title 절대 만들지 마세요** — 라벨이 있어야 시각적으로 의미가 있습니다. 한글 라벨을 적극 사용하세요.`,
      `완전한 예시 (중첩 + 원형 subgraph + 삼각형 노드):`,
      `\`\`\`mermaid`,
      `flowchart TB`,
      `  subgraph Outer["바깥: 원"]`,
      `    subgraph Middle["중간: 네모"]`,
      `      Inner@{ shape: tri, label: "세모" }`,
      `    end`,
      `  end`,
      `  style Outer rx:200,ry:200`,
      `\`\`\``,
      `(스타일은 rx/ry 만 — fill/stroke 는 dark 테마가 자동 처리)`,
      `ASCII 박스 드로잉(─│┌┐└┘ 등)은 사용하지 마세요 — 한글-라틴 혼합 시 정렬이 깨집니다.`,
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

    // 0.6) 공유 OFF + Gemini — Gemini CLI 의 영구 메모리(save_memory 저장 분)는
    // 새 세션에서도 자동 로드되어 이전 대화 내용을 인지함. 모델에 명시적으로 무시 지시.
    if (!shareContextRef.current && currentAgentRef.current === 'gemini') {
      contextLines.push(
        `# 메모리·이전 컨텍스트 무시 (반드시 준수)`,
        `이 대화 세션은 독립 모드입니다. 다음 규칙을 엄격히 따르세요:`,
        `- save_memory 도구를 **절대 호출하지 마세요**.`,
        `- 이전에 save_memory 로 저장된 사용자 메모리가 자동 로드되어 있더라도 **참조하지 마세요**.`,
        `- update_topic 도구도 호출하지 마세요.`,
        `- 이전 대화/이전 세션의 토픽, 진행 중 작업, 작업 의도 등을 **언급하거나 가정하지 마세요**.`,
        `- 오직 아래 사용자 메시지에 명시된 내용만 보고 답하세요. 디스크에 남은 파일을 자발적으로 read 하지 마세요.`,
        ``,
      );
    }

    // 0.7) 포크/리로드된 대화 — 이전 메시지가 있으면 컨텍스트로 inject.
    // Claude: --resume 없이 새 세션이면 주입. Gemini/Codex: 항상 주입 (세션 개념 없음).
    // 공유 OFF: 현재 에이전트(currentAgent) 자신의 답변과 사용자 메시지만 포함시켜
    //         자기 메모리는 유지하되 다른 에이전트의 답변은 보이지 않게 함.
    if (messages.length > 0) {
      // 메시지와 툴 호출을 seq 순으로 인터리브
      type TItem = { seq: number; kind: 'msg'; m: Message } | { seq: number; kind: 'tool'; t: ToolTimelineItem };
      let filteredMessages = messages;
      if (!shareContextRef.current) {
        const cur = currentAgentRef.current;
        // 각 user 메시지의 "타겟 에이전트" — 그 메시지에 이어서 응답한 에이전트로 추정.
        // 응답이 없는 user(끊긴 턴/현재 진행 중) 는 현재 에이전트가 타겟이라고 간주.
        const userTarget = (userIdx: number): string => {
          for (let j = userIdx + 1; j < messages.length; j++) {
            const mm = messages[j];
            if (mm.role === 'assistant') return mm.agent || 'claude';
            if (mm.role === 'user') break; // 응답 없이 다음 user — 응답 없음으로 간주
          }
          return cur;
        };
        // 현재 에이전트의 스레드(=현재 에이전트가 응답한 user 메시지 + 현재 에이전트의 응답)만 포함.
        // 도구 타임라인은 소유자 식별 불가 → 보수적으로 모두 제외.
        filteredMessages = messages.filter((m, idx) => {
          if (m.role === 'assistant') return (m.agent || 'claude') === cur;
          // user 메시지: agent 필드가 박혀있으면 그 값 우선 (보낸 대상 에이전트). 없으면 next-assistant 추정.
          if (m.agent) return m.agent === cur;
          return userTarget(idx) === cur;
        });
      }
      const items: TItem[] = [
        ...filteredMessages.map((m, i) => ({ seq: m.seq ?? i * 2, kind: 'msg' as const, m })),
        ...(shareContextRef.current
          ? toolTimeline.map((t, i) => ({ seq: t.seq ?? (filteredMessages.length * 2 + i * 2 + 1), kind: 'tool' as const, t }))
          : []),
      ];
      items.sort((a, b) => a.seq - b.seq);
      // 필터링 후 비어있으면 inject 생략
      if (filteredMessages.length === 0) { items.length = 0; }
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
      // 필터링 결과 transcript 가 비어있으면 inject 통째 생략 (예: 공유 OFF + 이 에이전트로는 처음 보내는 경우)
      if (transcriptLines.length === 0) {
        // skip
      } else
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

    // user 메시지에도 agent (보낸 대상 에이전트) 를 박아 공유 OFF 시 다른 에이전트 view 로 누설 방지
    const userMsg: Message = { role: 'user', content: attachBadge + text, id: `user-${Date.now()}`, seq: nextSeq(), agent: currentAgentRef.current as AgentType };
    // 활성 이력 없으면 새 이력 생성 (setMessages updater 밖에서 — strict mode 중복 방지)
    // 클로저 stale 방지 — 현재 활성 history 는 ref 에서 읽기 (포크/이력전환 직후 send 시점 보정)
    let targetHid = activeHistoryIdRef.current;
    // 공유 OFF 시 — 활성 history 의 originAgent 가 현재 에이전트와 다르면 새 이력 생성.
    // (Claude 에서 만든 대화에 그대로 머문 채 Gemini 탭으로 전환 후 메시지 보내면
    //  Claude 의 대화 안에 Gemini 메시지가 섞이지 않고 별도 항목으로 분리됨.)
    if (!shareContextRef.current && targetHid) {
      const cur = chatHistory.find(x => x.id === targetHid);
      const curOrigin = cur?.originAgent
        || cur?.messages.find(m => m.role === 'assistant' && m.agent)?.agent
        || 'claude';
      if (curOrigin !== currentAgentRef.current) {
        targetHid = null; // 신규 생성 분기로 전환
        setActiveHist(null);
        // 옛 대화 messages 도 클리어 — 안 그러면 sync effect 가 옛 메시지를 새 history 에 흘려넣어
        // 사이드바 아이콘이 옛 에이전트도 함께 표시됨.
        setMessages([]);
        setToolTimeline([]);
        setActivity('');
        setPendingPlan(null);
        setPendingPlanAgent(null);
        setLastRejectedPlan(null);
        setLastRejectedPlanAgent(null);
        claudeSessionIdRef.current = null;
        recentLocalPathsRef.current.clear();
        currentAsstIdRef.current = null;
      }
    }
    if (!targetHid) {
      const newId = `hist-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const newHist: ChatHistoryEntry = {
        id: newId,
        claudeSessionId: claudeSessionIdRef.current,
        title: text.slice(0, 60).replace(/\n/g, ' '),
        pinned: false,
        updatedAt: Date.now(),
        originAgent: currentAgentRef.current,
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
        // 요금제에서 못 쓰는 모델(또는 미등록 모델)이면 안전한 기본 모델로 대체
        const geminiModel = isGeminiModelUsable(model, geminiTier?.isPaid === true) ? model : 'gemini-2.5-flash';
        // 자동 승인(geminiYolo) OFF + 승인성 발화 아님 → "계획 먼저 보여주고 승인" 단계
        const approveKeywords = ['실행', '진행', '좋아', 'yes', 'ok', '승인', 'approve', '해줘', 'go ahead', '네'];
        const isApproval = approveKeywords.some(k => text.toLowerCase().includes(k.toLowerCase()));
        const geminiPlanPhase = !geminiYolo && !isApproval;
        let geminiPrompt = prompt;
        if (geminiPlanPhase) {
          geminiPrompt += '\n\n' + [
            `# 계획 모드 (반드시 준수)`,
            `- 지금은 "계획(plan) 단계"입니다. 파일 쓰기/수정, ClearCase 체크아웃(ctco / cleartool co / ci 등), 빌드·설치 등 변경성 작업을 실제로 실행하지 마세요. (파일 읽기·grep·탐색·분석은 허용)`,
            `- 요청 수행에 **파일 생성/수정 또는 ClearCase·변경성 명령이 필요한 경우에만** 단계별 실행 계획을 작성하세요.`,
            `- 계획을 작성하는 경우: 응답의 **맨 첫 줄에 정확히 \`[GEMINI_PLAN]\`** 만 단독으로 출력하고, 다음 줄부터 마크다운 번호 목록으로 계획을 작성하세요.`,
            `- 요청이 단순 정보성(설명·분석·다이어그램·질문 답변 등 — 파일 변경/ClearCase 불필요)이면 \`[GEMINI_PLAN]\` 마커 없이 평소대로 바로 답하세요.`,
            `- 계획을 제시하면 사용자가 승인한 뒤 다음 턴에 실제로 실행됩니다.`,
          ].join('\n');
          geminiPlanRequestsRef.current.add(requestId);
        }
        // sshTermId 전달 → gemini 에 SSH MCP(pepe_ssh) 제공 (원격 파일/명령)
        await (window as any).api?.geminiSend?.(sessionId, geminiPrompt, requestId, geminiModel, geminiYolo, addDirs, sshTermId);
      } else if (currentAgentRef.current === 'codex') {
        // codex 는 비대화형(exec)이라 실행 중 승인이 불가 → claude 처럼 "계획 먼저 보여주고 승인" 2단계로 처리.
        // plan 모드(또는 default + 승인성 발화 아님)면 계획 단계로 전송.
        const approveKeywords = ['실행', '진행', '좋아', 'yes', 'ok', '승인', 'approve', '해줘', 'go ahead', '네'];
        const isApproval = approveKeywords.some(k => text.toLowerCase().includes(k.toLowerCase()));
        const codexPlanPhase = permissionMode === 'plan' || (permissionMode === 'default' && !isApproval);
        let codexPrompt = prompt;
        if (codexPlanPhase) {
          codexPrompt += '\n\n' + [
            `# 계획 모드 (반드시 준수)`,
            `- 지금은 "계획(plan) 단계"입니다. 실제로 파일을 수정하거나 변경성 명령(쓰기/삭제/빌드/설치 등)을 실행하지 마세요. (파일 읽기/탐색은 허용)`,
            `- 이 요청을 수행하는 데 **파일 생성/수정 또는 변경성 명령 실행이 필요한 경우에만** 단계별 실행 계획을 작성하세요.`,
            `- 계획을 작성하는 경우: 응답의 **맨 첫 줄에 정확히 \`[CODEX_PLAN]\`** 만 단독으로 출력하고, 다음 줄부터 마크다운 번호 목록으로 계획을 작성하세요.`,
            `- 요청이 단순 정보성(설명, 다이어그램, 분석, 질문 답변 등 — 파일 변경/명령 실행 불필요)이면 \`[CODEX_PLAN]\` 마커 없이 평소대로 바로 답하세요.`,
            `- 계획을 제시하면 사용자가 승인한 뒤 다음 턴에 실제로 실행됩니다.`,
          ].join('\n');
          codexPlanRequestsRef.current.add(requestId);
        }
        await (window as any).api?.codexSend?.(sessionId, codexPrompt, requestId, model, codexApprovalPolicy, effort);
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
      removeStreamingAgent(currentAgentRef.current);
    }
  }, [sessionId, streaming, streamingAgents, mountEntries, activeMount, localFileAttachments, permissionMode, model, perToolApproval, messages, toolTimeline, geminiTier, geminiYolo]);

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
    removeStreamingAgent(reqAgent);
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
    setPendingPlanAgent(null);
    setStreaming(false);
    claudeSessionIdRef.current = null;
    recentLocalPathsRef.current.clear();
    currentAsstIdRef.current = null;
    setActiveHist(null);
    setUsage({ inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalCostUsd: 0, turns: 0, lastTurnInput: 0, lastTurnOutput: 0, lastTurnFreshInput: 0, lastTurnCacheRead: 0, lastTurnCacheCreate: 0, model: '' });
    setLastRejectedPlan(null);
    setLastRejectedPlanAgent(null);
  };
  const startNewConversation = () => {
    clear();
    setShowHistoryPanel(false);
  };
  // 🗑 버튼 — 대화 history 항목은 유지하고 내용(messages/toolTimeline/usage)만 비움.
  // 진행 중인 백그라운드 프로세스는 종료. UI 도 함께 리셋.
  const trashCurrentConversation = () => {
    const aid = activeHistoryId;
    if (aid) {
      // 진행 중 프로세스 종료 + 매핑 정리
      for (const [reqId, hid] of Array.from(requestToHistoryRef.current.entries())) {
        if (hid === aid) {
          const reqAgent = requestToAgentRef.current.get(reqId) || currentAgentRef.current;
          try {
            if (reqAgent === 'gemini') (window as any).api?.geminiStop?.(sessionId, reqId);
            else if (reqAgent === 'codex') (window as any).api?.codexStop?.(sessionId, reqId);
            else (window as any).api?.claudeStop?.(sessionId, reqId);
          } catch {}
          requestToHistoryRef.current.delete(reqId);
          requestToAgentRef.current.delete(reqId);
        }
      }
      // history 항목은 남기되 내용만 비움 (title/pinned/agent 등 메타는 유지)
      setChatHistory(h => h.map(x => x.id === aid ? {
        ...x,
        messages: [],
        toolTimeline: [],
        usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalCostUsd: 0, turns: 0, lastTurnInput: 0, lastTurnOutput: 0, lastTurnFreshInput: 0, lastTurnCacheRead: 0, lastTurnCacheCreate: 0, model: '' },
        lastRejectedPlan: null,
        streaming: false,
        pendingRequestId: null,
        claudeSessionId: null,
        updatedAt: Date.now(),
      } : x));
    }
    clear();
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
    setLastRejectedPlanAgent(null); // history 에 plan agent 는 저장 안 됨 — 다시 명시될 때까지 비활성
    setPendingPlanAgent(null);
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

  // 가장 최근 대화 자동 선택 — 초기 마운트 / 에이전트 전환 / 공유모드 전환 시 트리거.
  // 현재 view 의 이력이 비어있으면 새 대화 상태 유지 (공유 OFF + 그 에이전트 첫 사용 시 등).
  const autoSelectViewRef = useRef<string | null>(null);
  useEffect(() => {
    if (!chatHistoryLoadedRef.current) return;
    const viewKey = `${currentAgent}_${shareContext}`;
    if (autoSelectViewRef.current === viewKey) return; // 이 view 에선 이미 자동선택 처리됨
    autoSelectViewRef.current = viewKey;
    // 현재 view 에서 보이는 이력 목록 계산
    const visible = shareContext
      ? chatHistory
      : chatHistory.filter(h => {
          const set = new Set<string>();
          if (h.originAgent) set.add(h.originAgent);
          for (const m of h.messages) { if (m.agent) set.add(m.agent); }
          if (set.size === 0) set.add('claude');
          return set.has(currentAgent);
        });
    // 활성 history 가 새 view 에서도 보이면 그대로 유지
    const activeStillVisible = activeHistoryIdRef.current && visible.some(h => h.id === activeHistoryIdRef.current);
    if (activeStillVisible) return;
    if (visible.length > 0) {
      // 가장 최근 (updatedAt 기준) 항목 자동 로드
      const latest = [...visible].sort((a, b) => b.updatedAt - a.updatedAt)[0];
      loadHistory(latest);
    } else {
      // 현재 view 에 이력 없음 → 새 대화 (UI 만 리셋, 백그라운드 프로세스는 살림)
      activeRequestIdRef.current = null;
      setMessages([]);
      setToolTimeline([]);
      setActivity('');
      setPendingPlan(null);
      setPendingPlanAgent(null);
      setStreaming(false);
      claudeSessionIdRef.current = null;
      recentLocalPathsRef.current.clear();
      currentAsstIdRef.current = null;
      setActiveHist(null);
      setLastRejectedPlan(null);
      setLastRejectedPlanAgent(null);
    }
  }, [currentAgent, shareContext, chatHistory.length]);

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
    // 계획 본문을 항상 메시지에 포함 — codex 는 세션 메모리가 없어 계획을 다시 전달해야 함
    // (계획은 모달에서만 보였고 채팅 메시지로는 남지 않으므로, 승인 메시지에 계획 전문을 담음)
    const planToUse = (edited && edited !== original) ? edited : original;
    let text = planToUse
      ? `아래 계획대로 정확히 진행해줘:\n\n${planToUse}`
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
    setPendingPlan(prev => {
      if (prev) {
        setLastRejectedPlan(prev);
        setLastRejectedPlanAgent(pendingPlanAgent);
      }
      setPendingPlanAgent(null);
      return null;
    });
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
    ? GEMINI_MODELS.map(m => {
        const usable = !m.pro || geminiTier?.isPaid === true;
        return {
          id: `model-${m.v}`, section: 'Model',
          label: `Model: ${m.l}${usable ? '' : ' (지원안함)'}`,
          desc: usable ? m.icon : '🚫', run: () => { if (usable) setModel(m.v); },
        };
      })
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
          <div className="claude-chat-header-left">
            <div className="claude-chat-agent-switcher">
              <button className={`claude-chat-agent-btn ${currentAgent === 'claude' ? 'active' : ''}`} title="Claude Code" onClick={() => switchAgent('claude')}><ClaudeTabIcon /></button>
              <button className={`claude-chat-agent-btn ${currentAgent === 'gemini' ? 'active' : ''}`} title="Gemini" onClick={() => switchAgent('gemini')}><GeminiTabIcon /></button>
              <button className={`claude-chat-agent-btn ${currentAgent === 'codex' ? 'active' : ''}`} title="Codex" onClick={() => switchAgent('codex')}><CodexTabIcon /></button>
            </div>
          </div>
          <div className="claude-chat-header-center" />
          <div className="claude-chat-header-actions">
            {onClose && <button className="claude-chat-close" onClick={onClose}>×</button>}
          </div>
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
          <div className="claude-chat-header-left">
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
          </div>
          <div className="claude-chat-header-center" />
          <div className="claude-chat-header-actions">
            {onClose && <button className="claude-chat-close" onClick={onClose}>×</button>}
          </div>
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
        <div className="claude-chat-header-left">
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
          {version && <span className="claude-chat-version">{version}</span>}
        </div>
        <div className="claude-chat-header-center">
          {onTogglePin && (
            <button
              className={`claude-chat-pin ${pinned ? 'pinned' : ''}`}
              onClick={onTogglePin}
              title={pinned ? tt('unpin') : tt('pin')}
            >📌</button>
          )}
          <button onClick={() => setShowSearch(v => !v)} title={tt('search') || '검색'} className={showSearch ? 'active' : ''}>🔍</button>
          <button
            onClick={() => setShareContext(v => !v)}
            title={shareContext ? '에이전트 간 컨텍스트 공유 켜짐 — 클릭하여 끄기' : '에이전트 간 컨텍스트 공유 꺼짐 — 클릭하여 켜기'}
            className={`claude-chat-share-toggle ${shareContext ? 'on' : 'off'}`}
          >🔗</button>
        </div>
        <div className="claude-chat-header-actions">
          <button onClick={startNewConversation} title={tt('newConversation')}>＋</button>
          <button onClick={() => setShowHistoryPanel(v => !v)} title={tt('historyToggle')} className={showHistoryPanel ? 'active' : ''}>≡</button>
          <button onClick={trashCurrentConversation} title={tt('clear')}>🗑</button>
          {onClose && <button className="claude-chat-close" onClick={onClose} title={tt('close')}>×</button>}
        </div>
      </div>
      {showUsagePanel && (
        <div className="claude-chat-usage-panel claude-chat-usage-popup"
          style={usagePopupPos ? { left: usagePopupPos.left, bottom: usagePopupPos.bottom, right: 'auto' } : undefined}
          onMouseEnter={showUsage}
          onMouseLeave={hideUsageDelayed}
        >
          {/* codex: 컨텍스트 사용량 + 요금 한도 (rate_limits) */}
          {currentAgent === 'codex' && (() => {
            const fmt = (n: number) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
            const fmtReset = (unixSec: number, withDate: boolean): string => {
              const d = new Date(unixSec * 1000);
              if (withDate) return `${d.getMonth() + 1}월 ${d.getDate()}일`;
              const h = d.getHours(); const m = d.getMinutes();
              const ap = h < 12 ? '오전' : '오후';
              const h12 = h % 12 === 0 ? 12 : h % 12;
              return `${ap} ${h12}:${String(m).padStart(2, '0')}`;
            };
            const Row: React.FC<{ label: string; val: string }> = ({ label, val }) => (
              <div className="claude-chat-usage-row">
                <span className="claude-chat-usage-label">{label}</span>
                <span className="claude-chat-usage-val">{val}</span>
              </div>
            );
            const maxCtx = codexInfo?.contextWindow || 256_000;
            const used = usage.lastTurnInput;
            const ctxPct = Math.round((used / maxCtx) * 100);
            const p = codexInfo?.primary;
            const s = codexInfo?.secondary;
            return (
              <>
                <div className="claude-chat-usage-divider" />
                <div className="claude-chat-usage-row" style={{ color: '#9cc' }}>
                  <span className="claude-chat-usage-label">━ Codex 컨텍스트</span>
                  <span className="claude-chat-usage-val">{fmt(used)} / {fmt(maxCtx)} ({ctxPct}%)</span>
                </div>
                <Row label="캐시 적중" val={fmt(usage.lastTurnCacheRead)} />
                <Row label="새 입력" val={fmt(usage.lastTurnFreshInput)} />
                <Row label="출력(+추론)" val={fmt(usage.lastTurnOutput)} />
                {(p || s) && (() => {
                  // rollout 스냅샷이 오래돼 resets_at 이 이미 지났으면 그 창은 리셋됨 → ~100% 남음
                  const winVal = (w: CodexRateWindow, withDate: boolean): string => {
                    if (w.resets_at * 1000 < Date.now()) return `~100% 남음 (창 리셋됨 · codex 실행 시 갱신)`;
                    return `${Math.max(0, 100 - w.used_percent)}% 남음 · ${fmtReset(w.resets_at, withDate)} 리셋`;
                  };
                  return (
                    <>
                      <div className="claude-chat-usage-divider" />
                      <div className="claude-chat-usage-row" style={{ color: '#9cc' }}>
                        <span className="claude-chat-usage-label">━ 남은 요금 한도</span>
                        <span className="claude-chat-usage-val">{codexInfo?.planType || ''}</span>
                      </div>
                      {p && <Row label="5시간" val={winVal(p, false)} />}
                      {s && <Row label="1주" val={winVal(s, true)} />}
                    </>
                  );
                })()}
              </>
            );
          })()}
          {/* gemini: 컨텍스트 + 모델별 사용량 (retrieveUserQuota) */}
          {currentAgent === 'gemini' && (() => {
            const fmt = (n: number) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
            // resetTime(ISO) → "오전 11:15 (19시간 후)". epoch(1970)면 빈 문자열.
            const fmtReset = (iso: string | null): string => {
              if (!iso) return '';
              try {
                const d = new Date(iso);
                if (d.getFullYear() < 2000) return '';
                const h = d.getHours(), mi = d.getMinutes();
                const ap = h < 12 ? '오전' : '오후'; const h12 = h % 12 === 0 ? 12 : h % 12;
                const diff = d.getTime() - Date.now();
                let rel = '';
                if (diff > 0) {
                  const hrs = Math.floor(diff / 3600000), mins = Math.floor((diff % 3600000) / 60000);
                  rel = hrs > 0 ? ` (${hrs}시간 후)` : ` (${mins}분 후)`;
                }
                return `${ap} ${h12}:${String(mi).padStart(2, '0')}${rel}`;
              } catch { return ''; }
            };
            const Row: React.FC<{ label: string; val: string }> = ({ label, val }) => (
              <div className="claude-chat-usage-row">
                <span className="claude-chat-usage-label">{label}</span>
                <span className="claude-chat-usage-val">{val}</span>
              </div>
            );
            const maxCtx = 1_048_576;
            const used = usage.lastTurnInput;
            const ctxPct = Math.round((used / maxCtx) * 100);
            return (
              <>
                <div className="claude-chat-usage-divider" />
                <div className="claude-chat-usage-row" style={{ color: '#9cc' }}>
                  <span className="claude-chat-usage-label">━ Gemini 컨텍스트</span>
                  <span className="claude-chat-usage-val">{fmt(used)} / 1M ({ctxPct}%)</span>
                </div>
                <Row label="캐시 적중" val={fmt(usage.lastTurnCacheRead)} />
                <Row label="새 입력" val={fmt(usage.lastTurnFreshInput)} />
                <Row label="출력" val={fmt(usage.lastTurnOutput)} />
                {geminiQuota && geminiQuota.length > 0 && (
                  <>
                    <div className="claude-chat-usage-divider" />
                    <div className="claude-chat-usage-row" style={{ color: '#9cc' }}>
                      <span className="claude-chat-usage-label">━ 모델별 사용량</span>
                      <span className="claude-chat-usage-val">{geminiTier?.tierName || ''}</span>
                    </div>
                    {geminiQuota.map(b => {
                      const usedPct = b.remainingFraction != null ? Math.round((1 - b.remainingFraction) * 100) : null;
                      const reset = fmtReset(b.resetTime);
                      return (
                        <Row key={b.modelId} label={b.modelId}
                          val={`${usedPct != null ? usedPct + '% 사용' : '?'}${reset ? ' · ' + reset + ' 리셋' : ''}`} />
                      );
                    })}
                  </>
                )}
              </>
            );
          })()}
          {/* 컨텍스트 분해 — 마지막 turn 시점의 누적 컨텍스트 구성 (Claude) */}
          {currentAgent === 'claude' && (() => {
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
          {currentAgent === 'claude' && subLimits && (
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
        // 공유 OFF 시 — 현재 에이전트가 "참여한" 대화는 모두 그 에이전트 view 에 표시.
        // (originAgent 만으로 필터하면 처음 시작한 에이전트의 사이드바에만 보임 → 다른 에이전트로
        //  이어서 대화한 경우 그쪽 사이드바에 안 보이는 문제 회피).
        const histAgents = (h: ChatHistoryEntry): Set<string> => {
          const set = new Set<string>();
          if (h.originAgent) set.add(h.originAgent);
          for (const m of h.messages) {
            if (m.role === 'assistant' && m.agent) set.add(m.agent);
            if (m.role === 'user' && m.agent) set.add(m.agent);
          }
          if (set.size === 0) set.add('claude');
          return set;
        };
        const visibleHist = shareContext
          ? chatHistory
          : chatHistory.filter(h => histAgents(h).has(currentAgent));
        const pinnedHist = visibleHist.filter(h => h.pinned).sort((a, b) => b.updatedAt - a.updatedAt);
        const recentHist = visibleHist.filter(h => !h.pinned).sort((a, b) => b.updatedAt - a.updatedAt);
        const renderItem = (h: ChatHistoryEntry) => {
          // 대화에서 사용된 에이전트들을 첫 등장 순서로 수집 (assistant 메시지 기준).
          // assistant 메시지가 하나도 없으면 originAgent 또는 'claude' 로 표시.
          const seen: string[] = [];
          for (const m of h.messages) {
            if (m.role !== 'assistant') continue;
            const ag = (m.agent || '').toLowerCase();
            if (!ag) continue;
            if (!seen.includes(ag)) seen.push(ag);
          }
          if (seen.length === 0) seen.push(h.originAgent || 'claude');
          const iconFor = (a: string) => a === 'gemini' ? GeminiTabIcon : a === 'codex' ? CodexTabIcon : ClaudeTabIcon;
          const labelFor = (a: string) => a === 'gemini' ? 'Gemini' : a === 'codex' ? 'Codex' : 'Claude';
          const groupTitle = seen.length > 1 ? seen.map(labelFor).join(' → ') : labelFor(seen[0]);
          return (
          <div
            key={h.id}
            className={`claude-chat-history-item ${activeHistoryId === h.id ? 'active' : ''}`}
            onClick={() => loadHistory(h)}
          >
            <span className="claude-chat-history-agent" title={groupTitle}>
              {seen.map((a, i) => {
                const Ic = iconFor(a);
                return <Ic key={`${a}-${i}`} />;
              })}
            </span>
            <span className="claude-chat-history-title" title={h.title}>{h.title || tt('noTitle')}</span>
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
        };
        return (
          <div className="claude-chat-history-panel">
            <div className="claude-chat-history-section-title">{tt('pinnedSection')}</div>
            {pinnedHist.length === 0 ? <div className="claude-chat-history-empty">{tt('noPinnedHistory')}</div> : pinnedHist.map(renderItem)}
            <div className="claude-chat-history-section-title">{tt('recentsSection')}</div>
            {recentHist.length === 0 ? <div className="claude-chat-history-empty">{tt('noRecentHistory')}</div> : recentHist.map(renderItem)}
          </div>
        );
      })()}
      {showSearch && !showHistoryPanel && (
        <div className="claude-chat-search-bar">
          <span className="claude-chat-search-icon">🔍</span>
          <input
            ref={searchInputRef}
            className="claude-chat-search-input"
            value={searchQuery}
            placeholder={tt('searchPlaceholder') || '메시지 검색...'}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
              else if (e.key === 'Enter') {
                e.preventDefault();
                if (e.shiftKey) prevSearchHit(); else nextSearchHit();
              }
            }}
          />
          <span className="claude-chat-search-count">
            {searchQuery.trim() ? (searchHitCount > 0 ? `${searchCurrent + 1}/${searchHitCount}` : '0/0') : ''}
          </span>
          <button className="claude-chat-search-btn" onClick={prevSearchHit} disabled={searchHitCount === 0} title="이전">↑</button>
          <button className="claude-chat-search-btn" onClick={nextSearchHit} disabled={searchHitCount === 0} title="다음">↓</button>
          <button className="claude-chat-search-btn" onClick={closeSearch} title="닫기 (Esc)">×</button>
        </div>
      )}
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
        {pendingPlan && (shareContext || !pendingPlanAgent || pendingPlanAgent === currentAgent) && (
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
        {(() => {
          // 공유 OFF 면 현재 에이전트의 스레드(자기 응답 + 자기한테 향한 user 메시지)만 카운트.
          // 단 mixed-agent (공유 ON 시 만들어진) 대화는 필터 안 함 → 메시지가 있으면 무조건 비어있지 않음.
          let hasVisible = messages.length > 0;
          if (!shareContext) {
            const respondedAgents = new Set<string>();
            for (const m of messages) {
              if (m.role === 'assistant' && m.agent) respondedAgents.add(m.agent);
            }
            const isSharedConv = respondedAgents.size > 1;
            if (!isSharedConv) {
              const cur = currentAgent;
              const userTargetView = (userIdx: number): string => {
                for (let j = userIdx + 1; j < messages.length; j++) {
                  const mm = messages[j];
                  if (mm.role === 'assistant') return mm.agent || 'claude';
                  if (mm.role === 'user') break;
                }
                return cur;
              };
              hasVisible = messages.some((m, idx) => {
                if (m.role === 'assistant') return (m.agent || 'claude') === cur;
                if (m.agent) return m.agent === cur;
                return userTargetView(idx) === cur;
              });
            }
          }
          if (hasVisible) return null;
          return (
            <div className="claude-chat-empty">
              <p>{currentAgent === 'gemini' ? tt('askPlaceholderGemini') : currentAgent === 'codex' ? tt('askPlaceholderCodex') : tt('askPlaceholder')}</p>
              <p>{currentAgent === 'gemini' ? tt('askEditorHintGemini') : currentAgent === 'codex' ? tt('askEditorHintCodex') : tt('askEditorHint')}</p>
            </div>
          );
        })()}
        {(() => {
          // 컨텍스트 공유 OFF 시 — 현재 에이전트의 스레드만 보여주도록 메시지/툴 필터링.
          // 단 이전에 공유 ON 모드에서 만들어진 '여러 에이전트가 섞인 대화' 는 그대로 두고
          // 필터링하지 않음 (히스토리 무결성 보존, 옛 대화의 흐름 유지).
          let viewMessages = messages;
          let viewToolTimeline = toolTimeline;
          if (!shareContext) {
            // 한 conversation 안에서 응답한 assistant 의 agent 종류를 세어 본다.
            const respondedAgents = new Set<string>();
            for (const m of messages) {
              if (m.role === 'assistant' && m.agent) respondedAgents.add(m.agent);
            }
            const isSharedConv = respondedAgents.size > 1;
            if (!isSharedConv) {
              const cur = currentAgent;
              const userTargetView = (userIdx: number): string => {
                for (let j = userIdx + 1; j < messages.length; j++) {
                  const mm = messages[j];
                  if (mm.role === 'assistant') return mm.agent || 'claude';
                  if (mm.role === 'user') break;
                }
                return cur;
              };
              viewMessages = messages.filter((m, idx) => {
                if (m.role === 'assistant') return (m.agent || 'claude') === cur;
                if (m.agent) return m.agent === cur;
                return userTargetView(idx) === cur;
              });
              // 도구 타임라인은 소유 에이전트 식별이 어려워 보수적으로 모두 숨김
              viewToolTimeline = [];
            }
          }
          // 메시지 + 툴 호출을 발생 순서(seq) 로 인터리브
          type Item = { kind: 'msg'; m: Message; seq: number } | { kind: 'tool'; t: ToolTimelineItem; seq: number };
          const items: Item[] = [
            ...viewMessages.map((m, i) => ({ kind: 'msg' as const, m, seq: m.seq ?? i * 2 })),
            ...viewToolTimeline.map((t, i) => ({ kind: 'tool' as const, t, seq: t.seq ?? (viewMessages.length * 2 + i * 2 + 1) })),
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
              data-agent={g.m.role === 'assistant' ? (g.m.agent || currentAgent) : 'user'}
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
              <div className="claude-chat-msg-role">{
                g.m.role === 'user'
                  ? <>👤 You</>
                  : (g.m.agent || currentAgent) === 'gemini'
                    ? <><GeminiTabIcon /> Gemini</>
                    : (g.m.agent || currentAgent) === 'codex'
                      ? <><CodexTabIcon /> Codex</>
                      : <><ClaudeTabIcon /> Claude</>
              }</div>
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
      {currentAgentStreaming && !showHistoryPanel && (
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
        {lastRejectedPlan && !pendingPlan && (shareContext || !lastRejectedPlanAgent || lastRejectedPlanAgent === currentAgent) && (
          <div className="claude-chat-rejected-plan-bar">
            <button
              className="claude-chat-rejected-plan-btn"
              onClick={() => { setPendingPlan(lastRejectedPlan); setPendingPlanAgent(lastRejectedPlanAgent); }}
              title={tt('showRejectedPlanTitle')}
            >{tt('showRejectedPlan')}</button>
            <button
              className="claude-chat-rejected-plan-dismiss"
              onClick={() => { setLastRejectedPlan(null); setLastRejectedPlanAgent(null); }}
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
                value={isGeminiModelUsable(model, geminiTier?.isPaid === true) ? model : 'gemini-2.5-flash'}
                onChange={e => setModel(e.target.value)}
                title={geminiTier ? `${tt('geminiModelSelect')} · ${geminiTier.tierName}` : tt('geminiModelSelect')}
              >
                {GEMINI_MODELS.map(m => {
                  const usable = !m.pro || geminiTier?.isPaid === true;
                  return (
                    <option key={m.v} value={m.v} disabled={!usable}>
                      {m.icon} {m.l}{!usable ? ' — 지원안함' : ''}
                    </option>
                  );
                })}
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
          disabled={currentAgentStreaming}
        />
        <div className="claude-chat-input-actions">
          <div
            ref={usageTriggerRef}
            className="claude-chat-usage-trigger-wrap"
            onMouseEnter={() => { setShowUsageTooltip(true); if (currentAgent === 'claude') fetchUsageApi(); /* 캐시 hit 면 호출 안 함 */ }}
            onMouseLeave={() => setShowUsageTooltip(false)}
            onClick={() => { showUsage(); if (currentAgent === 'claude') fetchUsageApi(); }}
          >
            <span className="claude-chat-usage-trigger" title={tt('usageTriggerTitle')}>
              {(() => {
                const label = model === 'opus[1m]' ? 'Opus 4.7 1M' : model === 'opus' ? 'Opus 4.7' : model === 'sonnet[1m]' ? 'Sonnet 4.6 1M' : model === 'sonnet' ? 'Sonnet 4.6' : model === 'haiku' ? 'Haiku 4.5' : model === 'opusplan' ? 'Opus Plan' : model;
                return `📊 ${label}`;
              })()}
            </span>
            {showUsageTooltip && !showUsagePanel && (() => {
              const fmt = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
              if (currentAgent === 'codex') {
                const maxCtx = codexInfo?.contextWindow || 256_000;
                const ctxPct = Math.round((usage.lastTurnInput / maxCtx) * 100);
                const p = codexInfo?.primary;
                const s = codexInfo?.secondary;
                // resets_at 이 지난 창은 리셋됨 → ~100%
                const winPct = (w: CodexRateWindow) => w.resets_at * 1000 < Date.now() ? '~100%' : `${Math.max(0, 100 - w.used_percent)}%`;
                return (
                  <div className="claude-chat-usage-tooltip">
                    <div><b>Context</b> {fmt(usage.lastTurnInput)} / {fmt(maxCtx)} ({ctxPct}%)</div>
                    {(p || s) && (
                      <div>{p ? `5시간 ${winPct(p)}` : ''}{p && s ? ' · ' : ''}{s ? `1주 ${winPct(s)}` : ''}</div>
                    )}
                  </div>
                );
              }
              if (currentAgent === 'gemini') {
                const maxCtx = 1_048_576; // gemini 모델 컨텍스트 윈도우 (~1M)
                const ctxPct = Math.round((usage.lastTurnInput / maxCtx) * 100);
                const cur = geminiQuota?.find(b => b.modelId === model);
                const curUsed = cur && cur.remainingFraction != null ? Math.round((1 - cur.remainingFraction) * 100) : null;
                return (
                  <div className="claude-chat-usage-tooltip">
                    <div><b>Context</b> {fmt(usage.lastTurnInput)} / 1M ({ctxPct}%)</div>
                    {curUsed != null && <div>현재 모델 사용량 {curUsed}%</div>}
                  </div>
                );
              }
              const is1M = /\[1m\]/i.test(model) || /1m/i.test(usage.model);
              const maxCtx = is1M ? 1_000_000 : 200_000;
              const ctxPct = Math.round((usage.lastTurnInput / maxCtx) * 100);
              const planPct = subLimits?.fiveHourPct;
              return (
                <div className="claude-chat-usage-tooltip">
                  <div><b>Context</b> {fmt(usage.lastTurnInput)} / {fmt(maxCtx)} ({ctxPct}%){planPct ? ` · Plan ${planPct}` : ''}</div>
                </div>
              );
            })()}
          </div>
          {currentAgentStreaming ? (
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
          const sourceHist = chatHistory.find(h => h.id === activeHistoryId);
          const newHist: ChatHistoryEntry = {
            id: newId,
            claudeSessionId: null, // 새 fork — Claude resume 끊고 새 컨텍스트 (대화 분기)
            title: `🍴 ${sourceTitle}`,
            pinned: false,
            updatedAt: Date.now(),
            originAgent: sourceHist?.originAgent || currentAgentRef.current,
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
