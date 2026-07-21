import { lazy, Suspense, useState } from 'react';

// ai-05.tsx pulls in @tabler/icons-react + the ai-elements/Tailwind stack,
// so it's kept out of the main bundle until someone actually opens the
// chat — matching how every admin screen is already code-split.
const Ai05 = lazy(() => import('./ai-05'));

// Reuses the legacy admin panel's .ai-chat-fab styling (brand-colored
// floating button, already themed and already hidden on mobile via the
// existing <=900px rule in legacy.css — chat there was meant to live in
// the bottom nav instead), but anchored to the right instead of the left:
// the desktop sidebar's footer (email + logout button) sits bottom-left,
// so the legacy left:24/bottom:24 position would float right on top of it.
export default function AiChatWidget() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      {isOpen && (
        <div
          className="fixed bottom-[88px] right-6 z-[501] h-[560px] w-[400px] max-w-[calc(100vw-32px)]"
          style={{ maxHeight: 'calc(100vh - 140px)' }}
        >
          <Suspense
            fallback={
              <div className="flex h-full w-full items-center justify-center rounded-2xl border border-border bg-card shadow-lg">
                <div className="loader"></div>
              </div>
            }
          >
            <Ai05 />
          </Suspense>
        </div>
      )}
      <button
        className="ai-chat-fab"
        style={{ left: 'auto', right: 24 }}
        onClick={() => setIsOpen((open) => !open)}
        aria-label="น้องลิลลี่"
        title="น้องลิลลี่"
      >
        <i className={`fas ${isOpen ? 'fa-xmark' : 'fa-robot'}`}></i>
      </button>
    </>
  );
}
