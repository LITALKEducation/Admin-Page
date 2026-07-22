import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import logoBlack from '../assets/img/LITALK-Black.png';
import logoWhite from '../assets/img/LITALK-White.png';
import { SCREEN_ROUTES } from '../utils/screenRoutes';
import { NAV_SECTIONS as SECTIONS } from '../utils/navSections';

const COLLAPSE_KEY = 'litalk_sidebar_collapsed';

// Desktop sidebar in the shadcn sidebar-03 style: a floating rounded card
// with an icon-collapsible rail and collapsible nav groups (chevron per
// section). The visual treatment lives in legacy.css (.sidebar / .icon-
// collapsed / .sidebar-nav-section.collapsed) — this wires the state to it.
// Hidden below 900px, where MobileNav takes over.
export default function Sidebar({
  isAdmin,
  email,
  theme,
  onLogout,
}: {
  isAdmin: boolean;
  email: string;
  theme: 'dark' | 'light';
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
        <img
          src={theme === 'dark' ? logoWhite : logoBlack}
          alt="LITALK Logo"
          className="logo-img theme-logo sidebar-wordmark"
          style={{ height: 22 }}
        />
        <span className="admin-badge-text sidebar-label">ADMIN</span>
        <button
          className="sidebar-collapse-btn"
          onClick={toggleCollapsed}
          title={iconCollapsed ? 'ขยายเมนู' : 'ย่อเมนู'}
          aria-label={iconCollapsed ? 'ขยายเมนู' : 'ย่อเมนู'}
        >
          <i className="fas fa-angles-left"></i>
        </button>
      </div>

      <nav className="sidebar-nav">
        <NavLink
          to="/"
          end
          className={({ isActive }) => `sidebar-nav-item${isActive ? ' active' : ''}`}
          title="Dashboard"
        >
          <i className="fas fa-gauge-high"></i> <span className="sidebar-label">Dashboard</span>
        </NavLink>

        {SECTIONS.filter((section) => !section.adminOnly || isAdmin).map((section) => (
          <div
            className={`sidebar-nav-section${collapsedSections.has(section.key) ? ' collapsed' : ''}`}
            key={section.key}
          >
            <button
              type="button"
              className="sidebar-nav-heading"
              style={{ marginTop: 12 }}
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
                      <i className={`fas ${item.icon}`}></i> <span className="sidebar-label">{item.label}</span>
                    </NavLink>
                  ))}
              </div>
            </div>
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
        <div className="sidebar-footer-row">
          <span className="sidebar-email sidebar-label">{email}</span>
        </div>
        <button className="btn btn-secondary" style={{ width: '100%' }} title="Logout" onClick={onLogout}>
          <i className="fas fa-sign-out-alt"></i> <span className="sidebar-label">Logout</span>
        </button>
      </div>
    </aside>
  );
}
