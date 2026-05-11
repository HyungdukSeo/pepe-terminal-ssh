import React from 'react';

interface Props {
  children: React.ReactNode;
  label?: string;
}
interface State {
  error: Error | null;
}

// 자식 컴포넌트 크래시가 전체 앱을 죽이지 않도록 격리.
// SqlToolWorkspace 등 헤비한 컴포넌트 주변에 둘러 사용.
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', this.props.label || '', error, info);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 20, color: '#fcc', background: '#2a1a1a', display: 'flex', flexDirection: 'column', gap: 10, height: '100%', overflow: 'auto' }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#ff8888' }}>⚠ 컴포넌트 오류 — {this.props.label || ''}</div>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, color: '#fcc', background: '#1a1010', padding: 10, borderRadius: 4, maxHeight: 300, overflow: 'auto' }}>
            {String(this.state.error?.stack || this.state.error?.message || this.state.error)}
          </pre>
          <button onClick={this.reset} style={{ alignSelf: 'flex-start', background: '#0e639c', color: '#fff', border: 0, padding: '6px 16px', borderRadius: 3, cursor: 'pointer' }}>다시 시도</button>
        </div>
      );
    }
    return this.props.children;
  }
}
