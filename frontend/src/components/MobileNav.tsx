import { useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import logoBlack from '../assets/img/LITALK-Black.png';
import logoWhite from '../assets/img/LITALK-White.png';
import { SCREEN_ROUTES } from '../utils/screenRoutes';
import { DASHBOARD_ITEM, NAV_SECTIONS } from '../utils/navSections';

// Below 900px the desktop .sidebar is hidden entirely (see legacy.css) —
// this renders the phone-sized replacement: a slim top bar with a
// hamburger drawer holding the full nav tree, plus a thumb-reachable
// bottom bar for the 4 highest-frequency screens.
const BOTTOM_NAV_ITEMS = [
  { screen: 'dashboard', label: 'ภาพรวม', icon: 'fa-gauge-high' },
  { screen: 'students', label: 'นักเรียน', icon: 'fa-users' },
  { screen: 'logs', label: 'บันทึกผล', icon: 'fa-book-open' },
  { screen: 'payments', label: 'ชำระเงิน', icon: 'fa-money-bill-wave' },
];

export default function MobileNav({
  isAdmin,
  email,
  theme,
  onToggleTheme,
  onLogout,
}: {
  isAdmin: boolean;
  email: string;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onLogout: () => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  // A tap on any drawer link should also close the drawer, and a browser
  // back/forward that changes screen shouldn't leave it open behind it.
  useEffect(() => {
    setIsOpen(false);
  }, [location.pathname]);

  return (
    <>
      <div className="mobile-topbar">
        <div className="sidebar-header">
          <img
            src={theme === 'dark' ? logoWhite : logoBlack}
            alt="LITALK Logo"
            className="logo-img theme-logo"
            style={{ height: 20 }}
          />
          <span className="admin-badge-text">ADMIN</span>
        </div>
        <button className="hamburger-btn" onClick={() => setIsOpen(true)} aria-label="Open Menu">
          <i className="fas fa-bars"></i>
        </button>
      </div>

      <div
        className={`mobile-menu-overlay${isOpen ? ' active' : ''}`}
        onClick={() => setIsOpen(false)}
      >
        <div className="mobile-menu-panel" onClick={(e) => e.stopPropagation()}>
          <div className="mobile-menu-header">
            <span>เมนู</span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button className="topbar-icon-btn" aria-label="สลับธีม" title="สลับธีม" onClick={onToggleTheme}>
                <i className="fas fa-circle-half-stroke"></i>
              </button>
              <button className="mobile-menu-close" onClick={() => setIsOpen(false)} aria-label="Close Menu">
                <i className="fas fa-times"></i>
              </button>
            </div>
          </div>

          <nav className="mobile-menu-nav">
            <NavLink
              to="/"
              end
              className={({ isActive }) => (isActive ? 'active' : '')}
            >
              <i className={`fas ${DASHBOARD_ITEM.icon}`}></i> {DASHBOARD_ITEM.label}
            </NavLink>

            {NAV_SECTIONS.filter((section) => !section.adminOnly || isAdmin).map((section) => (
              <div key={section.key}>
                <div className="sidebar-nav-heading" style={{ marginTop: 10 }}>
                  {section.label}
                </div>
                {section.items
                  .filter((item) => !item.adminOnly || isAdmin)
                  .map((item) => (
                    <NavLink
                      key={item.screen}
                      to={SCREEN_ROUTES[item.screen]}
                      className={({ isActive }) => (isActive ? 'active' : '')}
                    >
                      <i className={`fas ${item.icon}`}></i> {item.label}
                    </NavLink>
                  ))}
              </div>
            ))}
          </nav>

          <div className="mobile-menu-footer">
            <div className="mobile-menu-email">{email}</div>
            <button className="btn btn-secondary" onClick={onLogout}>
              <i className="fas fa-sign-out-alt"></i> ออกจากระบบ
            </button>
          </div>
        </div>
      </div>

      <nav className="admin-bottom-nav" aria-label="เมนูหลัก">
        {BOTTOM_NAV_ITEMS.map((item) => {
          const route = SCREEN_ROUTES[item.screen];
          const active = route === '/' ? location.pathname === '/' : location.pathname.startsWith(route);
          return (
            <button
              key={item.screen}
              className={active ? 'active' : ''}
              onClick={() => navigate(route)}
            >
              <i className={`fas ${item.icon}`}></i>
              <span>{item.label}</span>
            </button>
          );
        })}
        <button onClick={() => setIsOpen(true)}>
          <i className="fas fa-ellipsis"></i>
          <span>เพิ่มเติม</span>
        </button>
      </nav>
    </>
  );
}
