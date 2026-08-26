import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import logo from '../assets/img/LITALK-Black.png';
import { SCREEN_ROUTES } from '../utils/screenRoutes';
import { DASHBOARD_ITEM, NAV_SECTIONS as SECTIONS } from '../utils/navSections';

const COLLAPSE_KEY = 'litalk_sidebar_collapsed';

export default function Sidebar({
  isAdmin,
  email,
  onLogout,
}: {
  isAdmin: boolean;
  email: string;
  onLogout: () => void;
}) {
  const [iconCollapsed, setIconCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === '1');
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());

  const toggleCollapsed = () => {
    setIconCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      return next;
    });
  };

  const toggleSection = (key: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <aside className={`sidebar${iconCollapsed ? ' icon-collapsed' : ''}`} id="app-sidebar">
      <div className="sidebar-header">
        <img src={logo} alt="LITALK Logo" className="logo-img theme-logo sidebar-wordmark" style={{ height: 22 }} />
        <button
          className="sidebar-collapse-btn"
          onClick={toggleCollapsed}
          title={iconCollapsed ? 'ขยายเมนู' : 'ย่อเมนู'}
          aria-label={iconCollapsed ? 'ขยายเมนู' : 'ย่อเมนู'}
        >
          <i className="fas fa-angles-left"></i>
        </button>
      </div>

      <nav className="sidebar-nav" aria-label="เมนูผู้ดูแลระบบ">
        <div className="sidebar-primary-nav">
          <NavLink
            to="/"
            end
            className={({ isActive }) => `sidebar-nav-item sidebar-dashboard-item${isActive ? ' active' : ''}`}
            title={DASHBOARD_ITEM.label}
          >
            <i className={`fas ${DASHBOARD_ITEM.icon}`}></i>
            <span className="sidebar-label">{DASHBOARD_ITEM.label}</span>
          </NavLink>
        </div>

        <div className="sidebar-section-list">
          {SECTIONS.filter((section) => !section.adminOnly || isAdmin).map((section) => (
            <div
              className={`sidebar-nav-section${collapsedSections.has(section.key) ? ' collapsed' : ''}`}
              key={section.key}
            >
              <button
                type="button"
                className="sidebar-nav-heading"
                onClick={() => toggleSection(section.key)}
                aria-expanded={!collapsedSections.has(section.key)}
              >
                <span className="sidebar-label">{section.label}</span>
                <i className="fas fa-chevron-down section-chevron sidebar-label"></i>
              </button>
              <div className="sidebar-nav-section-items">
                <div className="nav-items-inner">
                  {section.items
                    .filter((item) => !item.adminOnly || isAdmin)
                    .map((item) => (
                      <NavLink
                        key={item.screen}
                        to={SCREEN_ROUTES[item.screen]}
                        className={({ isActive }) => `sidebar-nav-item${isActive ? ' active' : ''}`}
                        title={item.label}
                      >
                        <i className={`fas ${item.icon}`}></i>
                        <span className="sidebar-label">{item.label}</span>
                      </NavLink>
                    ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </nav>

      <div className="sidebar-footer">
        <div className="sidebar-footer-row">
          <div className="sidebar-account-icon" aria-hidden="true">
            <i className="fas fa-circle-user"></i>
          </div>
          <span className="sidebar-email sidebar-label">{email}</span>
        </div>
        <button className="btn btn-secondary sidebar-logout-btn" title="ออกจากระบบ" onClick={onLogout}>
          <i className="fas fa-sign-out-alt"></i>
          <span className="sidebar-label">ออกจากระบบ</span>
        </button>
      </div>
    </aside>
  );
}
