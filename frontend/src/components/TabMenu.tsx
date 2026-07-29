import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

export interface TabMenuItem {
  id: string;
  label: string;
  /** Font Awesome class, e.g. "fa-comments". */
  icon?: string;
  /** Small dot on the tab, for "unsaved changes" and the like. */
  dot?: boolean;
  dotTitle?: string;
}

// The segmented control with the pill that slides between options.
//
// legacy.css has carried .tab-menu-pill since the tabs transition was first
// installed, but no screen ever rendered the element — so the pill was dead
// CSS and the tabs only changed text colour. This component renders it and
// owns the measurement, so every tab bar gets the same behaviour rather than
// each screen re-implementing it.
//
// CSS owns the tween; JS only writes the active tab's measured position and
// width onto the pill.
export default function TabMenu<T extends string>({
  items,
  active,
  onChange,
  style,
  ariaLabel,
}: {
  items: ReadonlyArray<TabMenuItem & { id: T }>;
  active: T;
  onChange: (id: T) => void;
  style?: React.CSSProperties;
  ariaLabel?: string;
}) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const pillRef = useRef<HTMLSpanElement | null>(null);

  const move = useCallback((animate: boolean) => {
    const bar = barRef.current;
    const pill = pillRef.current;
    if (!bar || !pill) return;
    const tab = bar.querySelector<HTMLButtonElement>('.tab-btn[aria-selected="true"]');
    if (!tab) return;

    const write = () => {
      pill.style.transform = `translateX(${tab.offsetLeft - bar.clientLeft}px)`;
      pill.style.width = `${tab.offsetWidth}px`;
    };

    if (animate) {
      write();
      return;
    }
    // First paint and resize: land in place without tweening, or the pill
    // animates in from translateX(0)/width:0 every time the screen mounts.
    const prev = pill.style.transition;
    pill.style.transition = 'none';
    write();
    void pill.offsetWidth;
    pill.style.transition = prev;
  }, []);

  // Layout effect so the pill is positioned before the browser paints.
  useLayoutEffect(() => {
    move(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Animate on every later change of the active tab.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    move(true);
  }, [active, move]);

  // Labels are bilingual and the sidebar collapses, so the bar's own width
  // changes for reasons other than the window resizing.
  //
  // The width check is not an optimisation. A ResizeObserver also fires on the
  // layout pass that follows a tab change, and re-snapping there runs the
  // no-transition path straight over the tween that just started, so the pill
  // teleports. Measured: 2 distinct positions across the move when it
  // re-snapped unconditionally, 13 once it only reacts to a width that really
  // changed.
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    let lastWidth = bar.getBoundingClientRect().width;
    const resnap = () => {
      const w = bar.getBoundingClientRect().width;
      if (Math.abs(w - lastWidth) < 0.5) return;
      lastWidth = w;
      move(false);
    };
    window.addEventListener('resize', resnap);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resnap) : null;
    ro?.observe(bar);
    return () => {
      window.removeEventListener('resize', resnap);
      ro?.disconnect();
    };
  }, [move]);

  return (
    <div className="tab-menu" role="tablist" aria-label={ariaLabel} ref={barRef} style={style}>
      <span className="tab-menu-pill" aria-hidden="true" ref={pillRef}></span>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="tab-btn"
          role="tab"
          aria-selected={active === item.id}
          onClick={() => onChange(item.id)}
        >
          {item.icon && <i className={`fas ${item.icon}`}></i>}
          {item.label}
          {item.dot && <span className="ai-dirty-dot" title={item.dotTitle}></span>}
        </button>
      ))}
    </div>
  );
}
