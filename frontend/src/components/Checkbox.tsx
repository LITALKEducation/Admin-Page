import type { ReactNode } from 'react';

// The box fills, then the checkmark draws itself.
//
// Adapted from the transitions.dev "Checkbox check" recipe, which uses a
// <button role="checkbox">. Here the native <input type="checkbox"> is kept
// and hidden instead, with the state keyed off :checked rather than
// aria-checked — a real input brings keyboard handling, form participation
// and screen-reader semantics that a button would have to re-implement, and
// this panel has enough checkboxes that re-implementing them is not worth it.
//
// The stroke length is set from the path's own geometry (see --check-len in
// legacy.css): the two segments of M1 5.52 L3.92 9.17 L9.17 1 measure ~14.4,
// so 15 covers it without over-drawing.
export default function Checkbox({
  checked,
  onChange,
  children,
  disabled,
  id,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children?: ReactNode;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <label className="t-check-row">
      <span className="t-check">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="t-check-box" aria-hidden="true">
          <svg viewBox="0 0 10.1668 10.1668" focusable="false">
            <path d="M1 5.52L3.92 9.17L9.17 1" />
          </svg>
        </span>
      </span>
      {children != null && <span className="t-check-label">{children}</span>}
    </label>
  );
}
