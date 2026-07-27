import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { useNavigate } from 'react-router-dom';
import { makeTokenGetter, fetchNotifications, type NotificationItem } from '../api/client';
import { SCREEN_ROUTES } from '../utils/screenRoutes';
import { useSharedStudentSelection } from '../hooks/useSharedStudentSelection';

// Icon/colour per feed item type — mirrors the legacy NOTIF_STYLE map.
const STYLE: Record<string, { icon: string; color: string }> = {
  schedule_pending: { icon: 'fa-calendar-check', color: 'var(--accent-info)' },
  amendment_pending: { icon: 'fa-arrows-up-down', color: 'var(--accent-info)' },
  schedule_revise: { icon: 'fa-rotate-left', color: 'var(--accent-warning)' },
  schedule_rejected: { icon: 'fa-xmark', color: 'var(--accent-danger)' },
  unpaid: { icon: 'fa-triangle-exclamation', color: 'var(--accent-danger)' },
};

const SCREEN_TITLES: Record<string, string> = {
  schedule: 'ตารางเรียนรายเดือน',
  hours: 'ปรับชั่วโมงเรียน',
  payments: 'บันทึกการชำระเงิน',
  check: 'โปรไฟล์นักเรียน',
};

// Topbar bell over the server's "needs attention" feed. The feed is
// stateless — resolving an item on its screen removes it — so there's no
// read/unread state to track here, just a count and a jump link.
export default function NotificationBell() {
  const { getAccessTokenSilently } = useAuth0();
  const navigate = useNavigate();
  const [, setSelectedStudent] = useSharedStudentSelection();
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const result = await fetchNotifications(makeTokenGetter(getAccessTokenSilently));
      setItems(result.items || []);
    } catch (error) {
      console.error('loadNotifications:', error);
      setItems([]);
    }
  }, [getAccessTokenSilently]);

  useEffect(() => {
    load();
  }, [load]);

  // Close on outside click / Escape, matching the other dropdowns.
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

  const count = items?.length ?? 0;

  const handleClick = (item: NotificationItem) => {
    setOpen(false);
    if (item.studentId) setSelectedStudent(item.studentId);
    navigate(SCREEN_ROUTES[item.screen] || '/');
  };

  return (
    <div className={`notif-wrap${open ? ' open' : ''}`} ref={wrapRef}>
      <button
        className="topbar-icon-btn"
        aria-label="การแจ้งเตือน"
        title="การแจ้งเตือน"
        onClick={() => {
          // Refresh on open so the list reflects anything resolved elsewhere.
          if (!open) load();
          setOpen((o) => !o);
        }}
      >
        <i className="fas fa-bell"></i>
        {count > 0 && <span className="notif-badge">{count > 9 ? '9+' : count}</span>}
      </button>
      <div className="notif-panel">
        <div className="notif-panel-header">การแจ้งเตือน</div>
        <div className="notif-list">
          {items === null ? (
            <div className="empty-state" style={{ padding: '24px 16px' }}>
              <div className="skeleton skeleton-line" style={{ width: '80%' }}></div>
              <div className="skeleton skeleton-line" style={{ width: '60%' }}></div>
            </div>
          ) : !items.length ? (
            <div className="empty-state" style={{ padding: '24px 16px' }}>
              <i className="fas fa-check-circle"></i>
              <div className="empty-title">ไม่มีการแจ้งเตือน</div>
              <div className="empty-sub">คุณติดตามทุกอย่างเรียบร้อยแล้ว</div>
            </div>
          ) : (
            items.map((item, i) => {
              const style = STYLE[item.type] || { icon: 'fa-bell', color: 'var(--text-muted)' };
              return (
                <button className="notif-item" key={i} onClick={() => handleClick(item)}>
                  <i className={`fas ${style.icon}`} style={{ color: style.color }}></i>
                  <div className="notif-item-body">
                    <div className="notif-item-text">{item.text}</div>
                    <div className="notif-item-action">
                      {SCREEN_TITLES[item.screen] || item.screen}{' '}
                      <i className="fas fa-arrow-right" style={{ fontSize: 9 }}></i>
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
