import { useState, useEffect, useRef } from 'react'
import { getLastFocusedTermId } from './TerminalPanel'

// 터미널 사용에 필요한 특수키들. iPad 가상 키보드에 없거나 누르기 번거로운 것들.
type Key =
  | { kind: 'send'; label: string; data: string }
  | { kind: 'char'; label: string; ch: string } // Ctrl modifier 와 결합 가능
  | { kind: 'mod'; label: string; mod: 'ctrl' | 'alt' | 'shift' }

// Ctrl + 알파벳 = control code (ASCII 0x01..0x1A)
const ctrlCode = (c: string) => String.fromCharCode(c.toLowerCase().charCodeAt(0) - 96)

const KEYS: Key[] = [
  { kind: 'send', label: 'ESC', data: '\x1b' },
  { kind: 'send', label: 'Tab', data: '\t' },
  // 자주 쓰는 Ctrl 조합 — iOS 가상키보드와는 modifier 결합 불가능하므로 직접 버튼.
  { kind: 'send', label: '^C', data: ctrlCode('c') },
  { kind: 'send', label: '^D', data: ctrlCode('d') },
  { kind: 'send', label: '^Z', data: ctrlCode('z') },
  { kind: 'send', label: '^L', data: ctrlCode('l') },
  { kind: 'send', label: '^R', data: ctrlCode('r') },
  { kind: 'send', label: '^U', data: ctrlCode('u') },
  { kind: 'send', label: '^W', data: ctrlCode('w') },
  { kind: 'mod', label: 'Ctrl', mod: 'ctrl' },
  { kind: 'mod', label: 'Alt', mod: 'alt' },
  { kind: 'send', label: '↑', data: '\x1b[A' },
  { kind: 'send', label: '↓', data: '\x1b[B' },
  { kind: 'send', label: '←', data: '\x1b[D' },
  { kind: 'send', label: '→', data: '\x1b[C' },
  { kind: 'send', label: 'Home', data: '\x1b[H' },
  { kind: 'send', label: 'End', data: '\x1b[F' },
  { kind: 'send', label: 'PgUp', data: '\x1b[5~' },
  { kind: 'send', label: 'PgDn', data: '\x1b[6~' },
  { kind: 'char', label: '|', ch: '|' },
  { kind: 'char', label: '~', ch: '~' },
  { kind: 'char', label: '/', ch: '/' },
  { kind: 'char', label: '\\', ch: '\\' },
  { kind: 'char', label: '-', ch: '-' },
  { kind: 'char', label: '_', ch: '_' },
  { kind: 'send', label: 'F1', data: '\x1bOP' },
  { kind: 'send', label: 'F2', data: '\x1bOQ' },
  { kind: 'send', label: 'F3', data: '\x1bOR' },
  { kind: 'send', label: 'F4', data: '\x1bOS' },
  { kind: 'send', label: 'F5', data: '\x1b[15~' },
  { kind: 'send', label: 'F6', data: '\x1b[17~' },
  { kind: 'send', label: 'F7', data: '\x1b[18~' },
  { kind: 'send', label: 'F8', data: '\x1b[19~' },
  { kind: 'send', label: 'F9', data: '\x1b[20~' },
  { kind: 'send', label: 'F10', data: '\x1b[21~' },
  { kind: 'send', label: 'F11', data: '\x1b[23~' },
  { kind: 'send', label: 'F12', data: '\x1b[24~' },
]

interface Props {
  activePanelId: string | null
}

export function TerminalKeybar({ activePanelId }: Props) {
  const [ctrl, setCtrl] = useState(false)
  const [alt, setAlt] = useState(false)
  // 모드 토글 상태가 컴포넌트 리렌더 사이에 유지되는 동안 sendKey 가 최신 값을 보도록 ref 도 같이.
  const ctrlRef = useRef(false)
  const altRef = useRef(false)

  useEffect(() => { ctrlRef.current = ctrl }, [ctrl])
  useEffect(() => { altRef.current = alt }, [alt])

  const sendKey = (key: Key) => {
    // selectedPanelId 는 leaf id 라 termId 와 다를 수 있음. 마지막으로
    // 포커스받은 termId 를 우선 사용, fallback 으로 activePanelId.
    const targetId = getLastFocusedTermId() || activePanelId
    if (!targetId) return
    const api = (window as any).api
    if (!api?.sendSSHInput) return

    if (key.kind === 'mod') {
      if (key.mod === 'ctrl') setCtrl(v => !v)
      if (key.mod === 'alt') setAlt(v => !v)
      return
    }

    let payload: string
    if (key.kind === 'send') {
      payload = key.data
      if (altRef.current) {
        // Alt + special: prepend ESC (xterm convention)
        payload = '\x1b' + payload
      }
    } else {
      // 'char' — Ctrl 결합 시 control 코드로 변환 (a→0x01, b→0x02, ...)
      if (ctrlRef.current && /^[a-zA-Z]$/.test(key.ch)) {
        const code = key.ch.toLowerCase().charCodeAt(0) - 96
        payload = String.fromCharCode(code)
      } else if (ctrlRef.current) {
        // Ctrl + 비알파벳: 일반 char 그대로 + Ctrl 해제
        payload = key.ch
      } else if (altRef.current) {
        payload = '\x1b' + key.ch
      } else {
        payload = key.ch
      }
    }

    api.sendSSHInput(targetId, payload)
    // 한 번 누르면 modifier 자동 해제 (sticky 아님)
    if (ctrlRef.current) setCtrl(false)
    if (altRef.current) setAlt(false)
  }

  return (
    <div className="terminal-keybar">
      <div className="terminal-keybar-scroll">
        {KEYS.map((k, i) => {
          const isMod = k.kind === 'mod'
          const active = isMod && ((k as any).mod === 'ctrl' ? ctrl : alt)
          return (
            <button
              key={i}
              className={`tk-btn${active ? ' tk-btn-active' : ''}${isMod ? ' tk-btn-mod' : ''}`}
              // onPointerDown 단일 이벤트 — 터치/마우스 통합. preventDefault 로
              // 포커스 이동(=iOS 키보드 다시 뜨기) 방지, stopPropagation 으로 부모 캐치 방지.
              onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); sendKey(k) }}
            >
              {k.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
