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
        <div className="flex h-full min-h-[260px] flex-col items-center justify-center gap-4 p-8 text-center">
          {/* Error icon */}
          <svg
            width="48"
            height="48"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--color-fg-3)"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>

          <div className="text-16 font-semibold text-fg">Something went wrong</div>

          <div className="max-w-[360px] text-13 text-fg-3">
            Something went wrong. Click to retry.
          </div>

          <button
            onClick={this.handleRetry}
            className="mt-2 cursor-pointer rounded-[6px] border border-line bg-surface-2 px-5 py-2 font-body text-13 font-medium text-fg [transition:background_0.15s] hover:bg-surface-3"
          >
            Retry
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
