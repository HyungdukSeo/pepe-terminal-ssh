// src/components/Layout.tsx
import React, { useState, useRef, useEffect } from 'react';
import type { LayoutNode, ContainerNode } from '../utils/layoutUtils';
import { TerminalPanel, refitAllTerms, setSuppressPtyResize } from './TerminalPanel';

type CommonHandlers = {
  selectedPanelId?: string | null;
  onSplit: (nodeId: string, dir: 'row' | 'column') => void;
  onClose: (nodeId: string) => void;
  onSelectPanel?: (nodeId: string) => void;
  onMovePanel?: (fromPanelId: string, toPanelId: string | null, position?: 'before' | 'after' | 'inside') => void;
  onSwitchSession?: (nodeId: string, idx: number) => void;
  onCloseSession?: (nodeId: string, termId: string) => void;
  onMoveSession?: (fromNodeId: string, termId: string, toNodeId: string) => void;
  onSplitMoveSession?: (fromNodeId: string, termId: string, toNodeId: string, zone: 'left' | 'right' | 'top' | 'bottom') => void;
  onReorderSession?: (nodeId: string, fromIdx: number, toIdx: number) => void;
  onAddSession?: (nodeId: string, shellName?: string, shellPath?: string) => void;
  availableShells?: { name: string; path: string; icon?: string }[];
  onRenameSession?: (nodeId: string, termId: string, name: string) => void;
  onConnectDrop?: (nodeId: string, sessionId: string) => void;
  onDuplicateSession?: (nodeId: string, termId: string) => void;
  treeWidth?: number;
  onTreeWidthChange?: (w: number) => void;
  onOpenRemoteFile?: (termId: string, remotePath: string, fileName: string) => void;
  onAttachToClaude?: (termId: string, remotePath: string, fileName: string, isDir: boolean) => void;
  floatingPanelId?: string | null;
  fullscreenTermId?: string | null;
  onToggleFloat?: (nodeId: string) => void;
  onSplitWithPicker?: (nodeId: string, dir: 'row' | 'column') => void;
  workspaceList?: { id: string; title: string }[];
  currentWorkspaceId?: string;
  onMoveSessionToWorkspace?: (fromNodeId: string, termId: string, targetTabId: string) => void;
  // 컨테이너 노드의 자식 분할 비율 변경 알림 — 사용자가 drag 로 조절 시
  onContainerResize?: (containerNodeId: string, sizes: number[]) => void;
};

type Props = CommonHandlers & { root: LayoutNode };
type NodeProps = CommonHandlers & { node: LayoutNode };
type CProps = CommonHandlers & { node: ContainerNode };

export const Layout: React.FC<Props> = ({ root, ...h }) => (
  <div className="layout-root">
    {/* key={root.id} — 워크스페이스 전환 시 트리 완전 재구성 → 각 워크스페이스 독립된 상태 보장 */}
    <NodeView key={root.id} node={root} {...h} />
  </div>
);

const NodeView: React.FC<NodeProps> = ({ node, ...h }) => {
  if (node.type === 'leaf') {
    const handleDrop = (e: React.DragEvent) => {
      // text/mini-session is handled by TerminalPanel (with stopPropagation)
      const from = e.dataTransfer?.getData('text/panel-id');
      if (from && h.onMovePanel) h.onMovePanel(from, node.id, 'inside');
    };
    const activeTermId = node.panel.sessions[node.panel.activeIdx]?.termId || '';
    const isFloating = h.floatingPanelId === node.id;
    // fullscreenTermId 가 이 패널의 어느 세션이든 포함되면 fs-visible (active 미니탭이 바뀌어도 패널 자체는 표시 유지)
    const isFsVisible = !!(h.fullscreenTermId && node.panel.sessions.some(s => s.termId === h.fullscreenTermId));
    return (
      <div className={`layout-leaf ${isFloating ? 'floating' : ''} ${isFsVisible ? 'fs-visible' : ''}`} data-active-term={activeTermId}>
        <div className={`layout-leaf-inner ${h.selectedPanelId === node.id ? 'selected' : ''}`}
          onDragOver={e => e.preventDefault()} onDrop={handleDrop}
        >
          <TerminalPanel
            nodeId={node.id} panel={node.panel}
            onSplit={h.onSplit} onClose={h.onClose} onSelect={h.onSelectPanel}
            onSwitchSession={h.onSwitchSession} onCloseSession={h.onCloseSession}
            onMoveSession={h.onMoveSession} onSplitMoveSession={h.onSplitMoveSession}
            onReorderSession={h.onReorderSession} onAddSession={h.onAddSession}
            onRenameSession={h.onRenameSession} onConnectDrop={h.onConnectDrop}
            onDuplicateSession={h.onDuplicateSession} availableShells={h.availableShells}
            treeWidth={h.treeWidth} onTreeWidthChange={h.onTreeWidthChange}
            onOpenRemoteFile={h.onOpenRemoteFile} onAttachToClaude={h.onAttachToClaude}
            isFloating={isFloating} onToggleFloat={h.onToggleFloat}
            isSelected={h.selectedPanelId === node.id}
            onSplitWithPicker={h.onSplitWithPicker}
            workspaceList={h.workspaceList}
            currentWorkspaceId={h.currentWorkspaceId}
            onMoveSessionToWorkspace={h.onMoveSessionToWorkspace}
          />
        </div>
      </div>
    );
  }
  return <ContainerNodeView node={node} {...h} />;
};

function ContainerNodeView({ node, ...h }: CProps) {
  const isRow = node.type === 'row';
  // 노드에 저장된 sizes 가 있으면 그걸 사용, 아니면 균등 분할로 초기화
  const initialSizes = () => {
    if (Array.isArray(node.sizes) && node.sizes.length === node.children.length && node.sizes.every(n => typeof n === 'number' && n > 0)) {
      return [...node.sizes];
    }
    return node.children.map(() => 1);
  };
  const [sizes, setSizes] = useState<number[]>(initialSizes);
  // sizes 의 최신 값을 ref 로 유지 — window event listener 의 stale closure 회피
  const sizesRef = useRef<number[]>(sizes);
  sizesRef.current = sizes;
  const prevCountRef = useRef(node.children.length);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef<{ index: number; start: number; sizes: number[] } | null>(null);

  // 워크스페이스 전환은 부모의 key={root.id} 가 처리 (컴포넌트 remount → useState 재초기화)
  // 같은 노드에서 children 개수 변경 시 sizes 재분배 (아래 useEffect)

  useEffect(() => {
    const prev = prevCountRef.current, cur = node.children.length;
    if (prev !== cur) {
      const ns = new Array(cur).fill(1);
      for (let i = 0; i < Math.min(prev, cur); i++) ns[i] = sizes[i];
      const ps = sizes.reduce((a, b) => a + b, 0) || 1;
      const s = ns.reduce((a, b) => a + b, 0) || 1;
      for (let i = 0; i < ns.length; i++) ns[i] = (ns[i] / s) * ps;
      setSizes(ns); prevCountRef.current = cur;
    }
  }, [node.children.length]);

  // 외부에서 node.sizes 가 변경된 경우(예: '패널 비율 균등 정렬' 리셋) 로컬 sizes 와 동기화 + refit.
  // 드래그 중에는 onContainerResize 가 종료 시점에만 호출되어 local sizes 와 node.sizes 가
  // 잠시 다를 수 있는데, 이 effect 는 둘이 같으면 no-op 이라 무한 루프 안 걸림.
  useEffect(() => {
    const fromProp: number[] = Array.isArray(node.sizes) && node.sizes.length === node.children.length && node.sizes.every(n => typeof n === 'number' && n > 0)
      ? [...node.sizes]
      : node.children.map(() => 1);
    if (fromProp.length === sizes.length && fromProp.every((v, i) => v === sizes[i])) return;
    setSizes(fromProp);
    setTimeout(() => { window.dispatchEvent(new Event('resize')); refitAllTerms(); }, 80);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(node.sizes)]);

  const onMouseDown = (e: React.MouseEvent, index: number) => {
    e.preventDefault();
    dragging.current = { index, start: isRow ? e.clientX : e.clientY, sizes: [...sizes] };
    setSuppressPtyResize(true);
    window.addEventListener('mousemove', onMouseMove); window.addEventListener('mouseup', onMouseUp);
  };
  const onMouseMove = (ev: MouseEvent) => {
    if (!dragging.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const { index, start, sizes: ps } = dragging.current;
    const delta = (isRow ? ev.clientX : ev.clientY) - start;
    const total = isRow ? rect.width : rect.height;
    if (total <= 0) return;
    const pSum = ps.reduce((a, b) => a + b, 0);
    let nL = (ps[index] / pSum) * total + delta, nR = (ps[index + 1] / pSum) * total - delta;
    const min = 40, comb = (ps[index] / pSum + ps[index + 1] / pSum) * total;
    if (nL < min) { nL = min; nR = comb - min; } if (nR < min) { nR = min; nL = comb - min; }
    const ns = [...ps]; ns[index] = (nL / total) * pSum; ns[index + 1] = (nR / total) * pSum; setSizes(ns);
  };
  const onMouseUp = () => {
    const wasDragging = !!dragging.current;
    dragging.current = null;
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    setSuppressPtyResize(false);
    // 드래그 종료 시점 — sizes 의 최신값을 ref 로 읽어 영속화
    if (wasDragging && h.onContainerResize) {
      h.onContainerResize(node.id, [...sizesRef.current]);
    }
    // 드래그 종료 후 단 한 번만 PTY에 최종 cols/rows 전달
    setTimeout(() => { window.dispatchEvent(new Event('resize')); refitAllTerms(); }, 80);
  };

  return (
    <div ref={containerRef} className="layout-container" style={{ flexDirection: isRow ? 'row' : 'column' }}>
      {node.children.map((child: LayoutNode, i: number) => (
        <React.Fragment key={child.id}>
          <div className="layout-child" style={{ flex: sizes[i] }}>
            <NodeView node={child} {...h} />
          </div>
          {i < node.children.length - 1 && (
            <div className={`layout-divider ${isRow ? 'row' : 'column'}`} onMouseDown={e => onMouseDown(e, i)}>
              <div className="layout-divider-line" />
            </div>
          )}
        </React.Fragment>
      ))}
    </div>
  );
}
