import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SCREEN_ROUTES } from '../utils/screenRoutes';

const ITEMS = [
  { screen: 'create', label: 'นักเรียนใหม่', icon: 'fa-user-plus', adminOnly: true },
  { screen: 'booking', label: 'จองเวลาเรียน', icon: 'fa-calendar-check' },
  { screen: 'schedule', label: 'ตารางเรียนรายเดือน', icon: 'fa-calendar-days' },
  { screen: 'logs', label: 'บันทึกการเรียน', icon: 'fa-pen' },
  { screen: 'payments', label: 'บันทึกการชำระเงิน', icon: 'fa-money-bill-wave' },
];

// Floating "create something" shortcut, ported from the legacy panel's
// quick-create FAB. Positioned by .fab-wrap in legacy.css, which already
// lifts it clear of the mobile bottom nav.
export default function QuickCreateFab({ isAdmin }: { isAdmin: boolean }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={`fab-wrap${open ? ' open' : ''}`} ref={wrapRef}>
      <div className="fab-menu">
        {ITEMS.filter((item) => !item.adminOnly || isAdmin).map((item) => (
          <button
            className="fab-menu-item"
            key={item.screen}
            onClick={() => {
              setOpen(false);
              navigate(SCREEN_ROUTES[item.screen]);
            }}
          >
            <i className={`fas ${item.icon}`}></i> {item.label}
          </button>
        ))}
      </div>
      <button
        className="fab-btn"
        onClick={() => setOpen((o) => !o)}
        aria-label="สร้างรายการใหม่"
        aria-expanded={open}
        title="สร้างรายการใหม่"
      >
        <i className="fas fa-plus"></i>
      </button>
    </div>
  );
}
