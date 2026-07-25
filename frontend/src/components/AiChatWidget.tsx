import { lazy, Suspense, useState } from 'react';

// ai-05.tsx pulls in @tabler/icons-react + the ai-elements/Tailwind stack,
// so it's kept out of the main bundle until someone actually opens the
// chat — matching how every admin screen is already code-split.
const Ai05 = lazy(() => import('./ai-05'));

// Reuses the legacy admin panel's .ai-chat-fab styling (brand-colored
// floating button, already themed and already hidden on mobile via the
// existing <=900px rule in legacy.css — chat there was meant to live in
// the bottom nav instead), but repositioned: the legacy left:24/bottom:24
// spot now sits under the floating sidebar, and bottom-right is taken by
// the quick-create FAB, so this stacks directly above that FAB (which is
// 52px tall at bottom:24) with the panel opening above them both.
const FAB_BOTTOM = 88;
const PANEL_BOTTOM = FAB_BOTTOM + 64;
export default function AiChatWidget() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      {isOpen && (
        <div
          className="fixed right-6 z-[501] h-[560px] w-[400px] max-w-[calc(100vw-32px)]"
          style={{ bottom: PANEL_BOTTOM, maxHeight: `calc(100vh - ${PANEL_BOTTOM + 40}px)` }}
        >
          <Suspense
            fallback={
              <div className="flex h-full w-full items-center justify-center rounded-2xl border border-border bg-card shadow-lg">
                <div className="loader"></div>
              </div>
            }
          >
            <Ai05 onClose={() => setIsOpen(false)} />
          </Suspense>
        </div>
      )}
      <button
        className="ai-chat-fab"
        style={{ left: 'auto', right: 24, bottom: FAB_BOTTOM }}
        onClick={() => setIsOpen((open) => !open)}
        aria-label="น้องลิลลี่"
        title="น้องลิลลี่"
      >
        <i className={`fas ${isOpen ? 'fa-xmark' : 'fa-robot'}`}></i>
      </button>
    </>
  );
}
