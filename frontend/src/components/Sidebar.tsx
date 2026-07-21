import { NavLink } from 'react-router-dom';
import logoBlack from '../assets/img/LITALK-Black.png';
import logoWhite from '../assets/img/LITALK-White.png';
import { legacyLink } from '../utils/legacyLink';

interface NavItem {
  screen: string;
  label: string;
  icon: string;
  adminOnly?: boolean;
  route?: string; // set once the screen has been migrated to React
}

interface NavSection {
  key: string;
  label: string;
  adminOnly?: boolean;
  items: NavItem[];
}

const SECTIONS: NavSection[] = [
  {
    key: 'students',
    label: 'นักเรียน',
    items: [
      { screen: 'students', label: 'รายชื่อนักเรียน', icon: 'fa-users', route: '/students' },
      { screen: 'check', label: 'โปรไฟล์นักเรียน', icon: 'fa-id-card', route: '/check' },
      { screen: 'files', label: 'ไฟล์นักเรียน', icon: 'fa-folder-open', route: '/files' },
      { screen: 'create', label: 'สร้างบัญชีนักเรียน', icon: 'fa-user-plus', adminOnly: true, route: '/create' },
    ],
  },
  {
    key: 'teaching',
    label: 'การเรียนการสอน',
    items: [
      { screen: 'booking', label: 'จองเวลาเรียน', icon: 'fa-calendar-check', route: '/booking' },
      { screen: 'schedule', label: 'ตารางเรียนรายเดือน', icon: 'fa-calendar-days' },
      { screen: 'hours', label: 'ปรับชั่วโมงเรียน', icon: 'fa-arrows-up-down' },
      { screen: 'logs', label: 'บันทึกการเรียน', icon: 'fa-book-open', route: '/logs' },
    ],
  },
  {
    key: 'finance',
    label: 'การเงิน',
    items: [
      { screen: 'payments', label: 'บันทึกการชำระเงิน', icon: 'fa-money-bill-wave', route: '/payments' },
      { screen: 'finance', label: 'สรุปการเงิน', icon: 'fa-chart-line', adminOnly: true },
    ],
  },
  {
    key: 'website',
    label: 'เว็บไซต์',
    items: [
      { screen: 'blog', label: 'บทความเว็บไซต์', icon: 'fa-newspaper' },
      { screen: 'links', label: 'ลิงก์ย่อ', icon: 'fa-link' },
    ],
  },
  {
    key: 'admin',
    label: 'ผู้ดูแลระบบ',
    adminOnly: true,
    items: [
      { screen: 'staff', label: 'ครูและพนักงาน', icon: 'fa-users-gear' },
      { screen: 'access', label: 'สิทธิ์การมองเห็น', icon: 'fa-user-shield' },
      { screen: 'credits', label: 'แก้ไขเครดิต', icon: 'fa-coins' },
      { screen: 'nfc', label: 'บัตร NFC', icon: 'fa-wifi' },
      { screen: 'checkins', label: 'บันทึกเข้า-ออก', icon: 'fa-right-left' },
    ],
  },
];

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
                  .map((item) =>
                    item.route ? (
                      <NavLink
                        key={item.screen}
                        to={item.route}
                        className={({ isActive }) => `sidebar-nav-item${isActive ? ' active' : ''}`}
                        title={item.label}
                      >
                        <i className={`fas ${item.icon}`}></i> <span className="sidebar-label">{item.label}</span>
                      </NavLink>
                    ) : (
                      <a
                        key={item.screen}
                        className="sidebar-nav-item"
                        href={legacyLink(item.screen)}
                        title={item.label}
                      >
                        <i className={`fas ${item.icon}`}></i> <span className="sidebar-label">{item.label}</span>
                      </a>
                    ),
                  )}
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
