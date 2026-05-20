import { Component } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('PageMon component error:', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        height: '100%', gap: '1rem', padding: '2rem', textAlign: 'center',
      }}>
        <AlertTriangle size={32} style={{ color: 'var(--accent-amber)' }} />
        <div>
          <div style={{ fontWeight: 700, color: 'var(--text-1)', marginBottom: '0.4rem' }}>
            Something went wrong in {this.props.name || 'this panel'}
          </div>
          <div style={{ fontFamily: 'monospace', fontSize: '0.78rem', color: 'var(--accent-red)',
            background: 'color-mix(in srgb, var(--accent-red) 8%, transparent)',
            border: '1px solid color-mix(in srgb, var(--accent-red) 25%, transparent)',
            borderRadius: '0.4rem', padding: '0.5rem 0.75rem', maxWidth: '480px',
            wordBreak: 'break-word', textAlign: 'left' }}>
            {this.state.error.message}
          </div>
        </div>
        <button
          onClick={() => this.setState({ error: null })}
          style={{
            display: 'flex', alignItems: 'center', gap: '0.4rem',
            padding: '0.4rem 1rem', borderRadius: '0.5rem', cursor: 'pointer',
            background: 'color-mix(in srgb, var(--accent-green) 12%, transparent)',
            border: '1px solid color-mix(in srgb, var(--accent-green) 30%, transparent)',
            color: 'var(--accent-green)', fontSize: '0.85rem', fontWeight: 500,
          }}>
          <RefreshCw size={14} /> Try again
        </button>
      </div>
    );
  }
}
