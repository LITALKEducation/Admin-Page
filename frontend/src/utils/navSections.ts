// Single source of truth for the admin nav tree — used by both the
// desktop Sidebar and the mobile drawer/bottom nav so they can't drift.
export interface NavItem {
  screen: string;
  label: string;
  icon: string;
  adminOnly?: boolean;
}

export interface NavSection {
  key: string;
  label: string;
  adminOnly?: boolean;
  items: NavItem[];
}

export const DASHBOARD_ITEM: NavItem = { screen: 'dashboard', label: 'Dashboard', icon: 'fa-gauge-high' };

export const NAV_SECTIONS: NavSection[] = [
  {
    key: 'students',
    label: 'นักเรียน',
    items: [
      { screen: 'students', label: 'รายชื่อนักเรียน', icon: 'fa-users' },
      { screen: 'check', label: 'โปรไฟล์นักเรียน', icon: 'fa-id-card' },
      { screen: 'files', label: 'ไฟล์นักเรียน', icon: 'fa-folder-open' },
      { screen: 'create', label: 'สร้างบัญชีนักเรียน', icon: 'fa-user-plus', adminOnly: true },
    ],
  },
  {
    key: 'teaching',
    label: 'การเรียนการสอน',
    items: [
      { screen: 'booking', label: 'จองเวลาเรียน', icon: 'fa-calendar-check' },
      { screen: 'schedule', label: 'ตารางเรียนรายเดือน', icon: 'fa-calendar-days' },
      { screen: 'hours', label: 'ปรับชั่วโมงเรียน', icon: 'fa-arrows-up-down' },
      { screen: 'logs', label: 'บันทึกการเรียน', icon: 'fa-book-open' },
    ],
  },
  {
    key: 'finance',
    label: 'การเงิน',
    items: [
      { screen: 'payments', label: 'บันทึกการชำระเงิน', icon: 'fa-money-bill-wave' },
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
