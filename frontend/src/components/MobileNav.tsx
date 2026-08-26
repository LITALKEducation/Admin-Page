import { useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import logo from '../assets/img/LITALK-Black.png';
import { SCREEN_ROUTES } from '../utils/screenRoutes';
import { DASHBOARD_ITEM, NAV_SECTIONS } from '../utils/navSections';

// The bottom bar is intentionally limited to the four highest-frequency
// workflows. Everything else remains one tap away in the grouped drawer.
const BOTTOM_NAV_ITEMS = [
  { screen: 'dashboard', label: 'ภาพรวม', icon: 'fa-gauge-high' },
  { screen: 'students', label: 'นักเรียน', icon: 'fa-users' },
  { screen: 'schedule', label: 'ตารางเรียน', icon: 'fa-calendar-days' },
  { screen: 'payments', label: 'การเงิน', icon: 'fa-money-bill-wave' },
];

export default function MobileNav({
  isAdmin,
  email,
  onToggleTheme,
  onLogout,
  onOpenSearch,
  onOpenIdCard,
}: {
  isAdmin: boolean;
  email: string;
  onToggleTheme: () => void;
  onLogout: () => void;
  onOpenSearch: () => void;
  onOpenIdCard: () => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    setIsOpen(false);
  }, [location.pathname]);

  return (
    <>
      <div className="mobile-topbar">
        <div className="sidebar-header">
          <img src={logo} alt="LITALK Logo" className="logo-img theme-logo" style={{ height: 20 }} />
        </div>
        <div className="mobile-topbar-actions">
          <button className="hamburger-btn" onClick={onOpenSearch} aria-label="ค้นหา">
            <i className="fas fa-magnifying-glass"></i>
          </button>
          <button className="hamburger-btn" onClick={onOpenIdCard} aria-label="บัตรประจำตัวดิจิทัล" title="บัตรประจำตัวดิจิทัล">
            <i className="fas fa-id-card"></i>
          </button>
          <button className="hamburger-btn" onClick={() => setIsOpen(true)} aria-label="เปิดเมนูทั้งหมด">
            <i className="fas fa-bars"></i>
          </button>
        </div>
      </div>

      <div className={`mobile-menu-overlay${isOpen ? ' active' : ''}`} onClick={() => setIsOpen(false)}>
        <div className="mobile-menu-panel" onClick={(e) => e.stopPropagation()}>
          <div className="mobile-menu-header">
            <div>
              <span>เมนูทั้งหมด</span>
              <small>เลือกตามงานที่ต้องการจัดการ</small>
            </div>
            <div className="mobile-menu-header-actions">
              <button className="topbar-icon-btn" aria-label="สลับธีม" title="สลับธีม" onClick={onToggleTheme}>
                <i className="fas fa-circle-half-stroke"></i>
              </button>
              <button className="mobile-menu-close" onClick={() => setIsOpen(false)} aria-label="ปิดเมนู">
                <i className="fas fa-times"></i>
              </button>
            </div>
          </div>

          <nav className="mobile-menu-nav" aria-label="เมนูผู้ดูแลระบบบนมือถือ">
            <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>
              <i className={`fas ${DASHBOARD_ITEM.icon}`}></i>
              <span>{DASHBOARD_ITEM.label}</span>
            </NavLink>

            {NAV_SECTIONS.filter((section) => !section.adminOnly || isAdmin).map((section) => (
              <section className="mobile-nav-section" key={section.key}>
                <div className="mobile-nav-section-title">{section.label}</div>
                <div className="mobile-nav-section-items">
                  {section.items
                    .filter((item) => !item.adminOnly || isAdmin)
                    .map((item) => (
                      <NavLink
                        key={item.screen}
                        to={SCREEN_ROUTES[item.screen]}
                        className={({ isActive }) => (isActive ? 'active' : '')}
                      >
                        <i className={`fas ${item.icon}`}></i>
                        <span>{item.label}</span>
                      </NavLink>
                    ))}
                </div>
              </section>
            ))}
          </nav>

          <div className="mobile-menu-footer">
            <div className="mobile-menu-account">
              <i className="fas fa-circle-user"></i>
              <div className="mobile-menu-email">{email}</div>
            </div>
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
            <button key={item.screen} className={active ? 'active' : ''} onClick={() => navigate(route)}>
              <i className={`fas ${item.icon}`}></i>
              <span>{item.label}</span>
            </button>
          );
        })}
        <button className={isOpen ? 'active' : ''} onClick={() => setIsOpen(true)}>
          <i className="fas fa-ellipsis"></i>
          <span>เพิ่มเติม</span>
        </button>
      </nav>
    </>
  );
}
