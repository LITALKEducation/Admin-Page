import { Component, type ReactNode } from 'react';

const RELOAD_FLAG = 'chunk-error-reload-attempted';

function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /dynamically imported module|Failed to fetch|Importing a module script failed/i.test(message);
}

// Every screen is lazy-loaded (see App.tsx), and the GitHub Actions
// workflow re-hashes chunk filenames on every deploy. A tab left open
// across a deploy can try to fetch a screen chunk whose filename no
// longer exists on the server, which throws inside React.lazy with no
// automatic recovery — the screen just goes blank. Catch that specific
// failure and reload once to pick up the current build; anything else
// re-throws so a real bug still surfaces normally.
export default class ChunkErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  private clearFlagTimer?: ReturnType<typeof setTimeout>;

  static getDerivedStateFromError(error: unknown) {
    if (isChunkLoadError(error)) return { failed: true };
    throw error;
  }

  componentDidCatch() {
    if (sessionStorage.getItem(RELOAD_FLAG)) return;
    sessionStorage.setItem(RELOAD_FLAG, '1');
    window.location.reload();
  }

  componentDidMount() {
    // Only clear the guard once this load has been stable for a bit —
    // otherwise a genuinely broken chunk (not just a stale-deploy race)
    // would reload in an infinite loop instead of surfacing the error.
    this.clearFlagTimer = setTimeout(() => sessionStorage.removeItem(RELOAD_FLAG), 5000);
  }

  componentWillUnmount() {
    clearTimeout(this.clearFlagTimer);
  }

  render() {
    if (this.state.failed) {
      return (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}>
          <i className="fas fa-spinner fa-spin" style={{ fontSize: 28 }}></i>
        </div>
      );
    }
    return this.props.children;
  }
}
