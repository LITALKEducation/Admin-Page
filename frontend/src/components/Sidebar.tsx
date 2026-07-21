import { NavLink } from 'react-router-dom';
import logoBlack from '../assets/img/LITALK-Black.png';
import logoWhite from '../assets/img/LITALK-White.png';
import { SCREEN_ROUTES } from '../utils/screenRoutes';
import { NAV_SECTIONS as SECTIONS } from '../utils/navSections';

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
  return (
    <aside className="sidebar" id="app-sidebar">
      <div className="sidebar-header">
        <img
          src={theme === 'dark' ? logoWhite : logoBlack}
          alt="LITALK Logo"
          className="logo-img theme-logo sidebar-wordmark"
          style={{ height: 22 }}
        />
        <span className="admin-badge-text sidebar-label">ADMIN</span>
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
          <div className="sidebar-nav-section" key={section.key}>
            <div className="sidebar-nav-heading" style={{ marginTop: 12 }}>
              <span className="sidebar-label">{section.label}</span>
            </div>
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
