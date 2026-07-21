import { useEffect } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import Login from './components/Login';
import Sidebar from './components/Sidebar';
import Topbar from './components/Topbar';
import DashboardScreen from './components/DashboardScreen';
import StudentsScreen from './components/StudentsScreen';
import CheckScreen from './components/CheckScreen';
import LogsScreen from './components/LogsScreen';
import PaymentsScreen from './components/PaymentsScreen';
import CreateStudentScreen from './components/CreateStudentScreen';
import FilesScreen from './components/FilesScreen';
import BookingScreen from './components/BookingScreen';
import ScheduleScreen from './components/ScheduleScreen';
import HoursScreen from './components/HoursScreen';
import FinanceScreen from './components/FinanceScreen';
import StaffScreen from './components/StaffScreen';
import AccessScreen from './components/AccessScreen';
import CreditsScreen from './components/CreditsScreen';
import NfcScreen from './components/NfcScreen';
import CheckinsScreen from './components/CheckinsScreen';
import BlogScreen from './components/BlogScreen';
import LinksScreen from './components/LinksScreen';
import { useTheme } from './hooks/useTheme';
import { useMe } from './hooks/useMe';
import { ToastProvider } from './ui/ToastContext';
import { ConfirmProvider } from './ui/ConfirmContext';
import { SharedStudentProvider, useSharedStudentSelection } from './hooks/useSharedStudentSelection';
import { EditingLogProvider } from './hooks/useEditingLog';

// Supports shareable links like /app/logs?student=litalk12345 (e.g. the
// "copy study log link" buttons) by seeding the shared selection once on
// load, then dropping the query string — mirrors the legacy applyDeepLink().
const DEEP_LINK_ROUTES: Record<string, string> = {
  logs: '/logs',
  payments: '/payments',
  check: '/check',
  files: '/files',
  booking: '/booking',
  schedule: '/schedule',
  hours: '/hours',
  credits: '/credits',
};

function DeepLinkHandler() {
  const navigate = useNavigate();
  const [, setSelectedStudent] = useSharedStudentSelection();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const student = params.get('student');
    const screen = params.get('screen');
    if (!student && !screen) return;
    if (student) setSelectedStudent(student);
    const route = screen ? DEEP_LINK_ROUTES[screen] : null;
    navigate(route || window.location.pathname, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

const TITLES: Record<string, string> = {
  '/': 'Dashboard',
  '/students': 'รายชื่อนักเรียน',
  '/check': 'โปรไฟล์นักเรียน',
  '/logs': 'บันทึกการเรียน',
  '/payments': 'บันทึกการชำระเงิน',
  '/create': 'สร้างบัญชีนักเรียน',
  '/files': 'ไฟล์นักเรียน',
  '/booking': 'จองเวลาเรียน',
  '/schedule': 'ตารางเรียนรายเดือน',
  '/hours': 'ปรับชั่วโมงเรียน',
  '/finance': 'สรุปการเงิน',
  '/staff': 'ครูและพนักงาน',
  '/access': 'สิทธิ์การมองเห็น',
  '/credits': 'แก้ไขเครดิต',
  '/nfc': 'บัตร NFC',
  '/checkins': 'บันทึกเข้า-ออก',
  '/blog': 'บทความเว็บไซต์',
  '/links': 'ลิงก์ย่อ',
};

export default function App() {
  const { isLoading, isAuthenticated, user, logout } = useAuth0();
  const { theme, toggleTheme } = useTheme();
  const { isAdmin } = useMe();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="modal-overlay" style={{ display: 'flex' }}>
        <i className="fas fa-spinner fa-spin" style={{ fontSize: 32 }}></i>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Login />;
  }

  const email = user?.email || user?.nickname || user?.name || 'Admin';
  const title = TITLES[location.pathname] || 'LITALK Control';

  return (
    <ToastProvider>
      <ConfirmProvider>
        <SharedStudentProvider>
          <EditingLogProvider>
            <DeepLinkHandler />
            <div className="admin-dashboard" style={{ display: 'flex' }}>
              <Sidebar
                isAdmin={isAdmin}
                email={email}
                theme={theme}
                onLogout={() => logout({ logoutParams: { returnTo: `${window.location.origin}/app/` } })}
              />
              <main className="app-main">
                <Topbar title={title} onToggleTheme={toggleTheme} />
                <div className="dashboard-content">
                  <Routes>
                    <Route path="/" element={<DashboardScreen />} />
                    <Route path="/students" element={<StudentsScreen />} />
                    <Route path="/check" element={<CheckScreen />} />
                    <Route path="/logs" element={<LogsScreen />} />
                    <Route path="/payments" element={<PaymentsScreen />} />
                    {isAdmin && <Route path="/create" element={<CreateStudentScreen />} />}
                    <Route path="/files" element={<FilesScreen />} />
                    <Route path="/booking" element={<BookingScreen />} />
                    <Route path="/schedule" element={<ScheduleScreen />} />
                    <Route path="/hours" element={<HoursScreen />} />
                    {isAdmin && <Route path="/finance" element={<FinanceScreen />} />}
                    {isAdmin && <Route path="/staff" element={<StaffScreen />} />}
                    {isAdmin && <Route path="/access" element={<AccessScreen />} />}
                    {isAdmin && <Route path="/credits" element={<CreditsScreen />} />}
                    {isAdmin && <Route path="/nfc" element={<NfcScreen />} />}
                    {isAdmin && <Route path="/checkins" element={<CheckinsScreen />} />}
                    <Route path="/blog" element={<BlogScreen />} />
                    <Route path="/links" element={<LinksScreen />} />
                  </Routes>
                </div>
              </main>
            </div>
          </EditingLogProvider>
        </SharedStudentProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}
