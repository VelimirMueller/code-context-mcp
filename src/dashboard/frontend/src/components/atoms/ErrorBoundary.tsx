import React from 'react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, errorInfo);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            minHeight: 260,
            gap: 16,
            padding: 32,
            textAlign: 'center',
          }}
        >
          {/* Error icon */}
          <svg
            width="48"
            height="48"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--text3)"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>

          <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text)' }}>
            Something went wrong
          </div>

          <div style={{ fontSize: 13, color: 'var(--text3)', maxWidth: 360 }}>
            Something went wrong. Click to retry.
          </div>

          <button
            onClick={this.handleRetry}
            style={{
              marginTop: 8,
              padding: '8px 20px',
              fontSize: 13,
              fontWeight: 500,
              fontFamily: 'var(--font)',
              color: 'var(--text)',
              background: 'var(--surface2)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              cursor: 'pointer',
              transition: 'background 0.15s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--surface3)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--surface2)';
            }}
          >
            Retry
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
