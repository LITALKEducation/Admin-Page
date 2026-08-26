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

export const DASHBOARD_ITEM: NavItem = { screen: 'dashboard', label: 'ภาพรวม', icon: 'fa-gauge-high' };

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
    key: 'lessons',
    label: 'ชั้นเรียนและตาราง',
    items: [
      { screen: 'booking', label: 'จองเวลาเรียน', icon: 'fa-calendar-check' },
      { screen: 'schedule', label: 'ตารางเรียน', icon: 'fa-calendar-days' },
      { screen: 'logs', label: 'บันทึกการเรียน', icon: 'fa-book-open' },
      { screen: 'hours', label: 'ชั่วโมงเรียน', icon: 'fa-clock-rotate-left' },
    ],
  },
  {
    key: 'online-learning',
    label: 'การเรียนออนไลน์',
    items: [
      { screen: 'courses', label: 'คอร์สเรียน', icon: 'fa-graduation-cap' },
      { screen: 'learners', label: 'ผู้เรียนออนไลน์', icon: 'fa-user-check' },
      { screen: 'quizzes', label: 'แบบทดสอบ', icon: 'fa-clipboard-question' },
    ],
  },
  {
    key: 'finance',
    label: 'การเงิน',
    items: [
      { screen: 'payments', label: 'บันทึกการชำระเงิน', icon: 'fa-money-bill-wave' },
      { screen: 'finance', label: 'สรุปการเงิน', icon: 'fa-chart-line', adminOnly: true },
      { screen: 'credits', label: 'เครดิตนักเรียน', icon: 'fa-coins', adminOnly: true },
    ],
  },
  {
    key: 'content',
    label: 'เว็บไซต์และคอนเทนต์',
    items: [
      { screen: 'blog', label: 'บทความเว็บไซต์', icon: 'fa-newspaper' },
      { screen: 'links', label: 'ลิงก์ย่อ', icon: 'fa-link' },
      { screen: 'tcas-fortune', label: 'TCAS Fortune', icon: 'fa-wand-magic-sparkles', adminOnly: true },
    ],
  },
  {
    key: 'people',
    label: 'บุคลากรและการเข้าถึง',
    adminOnly: true,
    items: [
      { screen: 'staff', label: 'ครูและพนักงาน', icon: 'fa-users-gear' },
      { screen: 'access', label: 'สิทธิ์การมองเห็น', icon: 'fa-user-shield' },
      { screen: 'nfc', label: 'บัตร NFC', icon: 'fa-wifi' },
      { screen: 'checkins', label: 'บันทึกเข้า-ออก', icon: 'fa-right-left' },
    ],
  },
  {
    key: 'system',
    label: 'ระบบและการตั้งค่า',
    adminOnly: true,
    items: [
      { screen: 'ai-settings', label: 'ตั้งค่า AI Chat', icon: 'fa-message' },
      { screen: 'service', label: 'สถานะและการเปิด-ปิดระบบ', icon: 'fa-tower-broadcast' },
    ],
  },
];
