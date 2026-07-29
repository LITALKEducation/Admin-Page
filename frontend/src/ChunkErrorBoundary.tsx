import { Component, type ReactNode } from 'react';

const RELOAD_FLAG = 'chunk-error-reload-attempted';
const BUST_PARAM = '_r';

function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /dynamically imported module|Failed to fetch|Importing a module script failed|error loading dynamically imported module/i.test(
    message,
  );
}

// Reload the page while forcing the browser/CDN to re-fetch a *fresh*
// index.html. A plain window.location.reload() can re-serve the cached HTML
// that still references the old chunk filenames — so the reload hits the exact
// same missing chunk and the screen stays stuck. A one-shot cache-buster query
// param bypasses that cache; HashRouter's route (in the URL hash) is preserved,
// so the reload lands back on the same screen.
function reloadFresh() {
  const url = new URL(window.location.href);
  url.searchParams.set(BUST_PARAM, Date.now().toString(36));
  window.location.replace(url.toString());
}

// Every screen is lazy-loaded (see App.tsx), and the GitHub Actions workflow
// re-hashes chunk filenames on every deploy. A tab left open across a deploy
// can try to fetch a screen chunk whose filename no longer exists on the
// server, which throws inside React.lazy with no automatic recovery — the
// screen just goes blank or spins. Catch that specific failure and reload once
// (busting the cache) to pick up the current build; anything else re-throws so
// a real bug still surfaces normally.
export default class ChunkErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  private clearFlagTimer?: ReturnType<typeof setTimeout>;

  static getDerivedStateFromError(error: unknown) {
    if (isChunkLoadError(error)) return { failed: true };
    throw error;
  }

  componentDidCatch() {
    // Auto-recover once. If the cache-busted reload still can't load the chunk
    // (guard already set), render() shows a manual retry instead of looping.
    if (sessionStorage.getItem(RELOAD_FLAG)) return;
    sessionStorage.setItem(RELOAD_FLAG, '1');
    reloadFresh();
  }

  componentDidMount() {
    // Tidy the cache-buster out of the address bar after a recovery reload.
    if (new URLSearchParams(window.location.search).has(BUST_PARAM)) {
      const url = new URL(window.location.href);
      url.searchParams.delete(BUST_PARAM);
      window.history.replaceState(null, '', url.toString());
    }
    // Only clear the guard once this load has been stable for a bit —
    // otherwise a genuinely broken chunk (not just a stale-deploy race) would
    // reload in a loop instead of surfacing the manual retry.
    this.clearFlagTimer = setTimeout(() => sessionStorage.removeItem(RELOAD_FLAG), 5000);
  }

  componentWillUnmount() {
    clearTimeout(this.clearFlagTimer);
  }

  render() {
    if (this.state.failed) {
      // The auto-reload is in flight (or was already attempted this session).
      // Show a clear status plus a manual button so the user is never stuck
      // staring at a spinner that never resolves.
      return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: 60, textAlign: 'center' }}>
          <div className="loader"></div>
          <p style={{ color: 'var(--text-secondary)', margin: 0 }}>กำลังอัปเดตเป็นเวอร์ชันล่าสุด…</p>
          <button type="button" className="btn btn-secondary" onClick={reloadFresh}>
            <i className="fas fa-rotate-right"></i> โหลดใหม่
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
