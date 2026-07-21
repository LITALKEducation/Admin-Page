import { lazy, Suspense, useEffect } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import Login from './components/Login';
import Sidebar from './components/Sidebar';
import MobileNav from './components/MobileNav';
import Topbar from './components/Topbar';
import { useTheme } from './hooks/useTheme';
import { useMe } from './hooks/useMe';
import { ToastProvider } from './ui/ToastContext';
import { ConfirmProvider } from './ui/ConfirmContext';
import { SharedStudentProvider, useSharedStudentSelection } from './hooks/useSharedStudentSelection';
import { EditingLogProvider } from './hooks/useEditingLog';
import { SCREEN_ROUTES } from './utils/screenRoutes';
import ChunkErrorBoundary from './ChunkErrorBoundary';

// Every screen past the dashboard is code-split — with 16+ admin screens
// there's no reason to ship the blog editor or NFC registration UI to
// someone who only ever opens the dashboard.
const DashboardScreen = lazy(() => import('./components/DashboardScreen'));
const StudentsScreen = lazy(() => import('./components/StudentsScreen'));
const CheckScreen = lazy(() => import('./components/CheckScreen'));
const LogsScreen = lazy(() => import('./components/LogsScreen'));
const PaymentsScreen = lazy(() => import('./components/PaymentsScreen'));
const CreateStudentScreen = lazy(() => import('./components/CreateStudentScreen'));
const FilesScreen = lazy(() => import('./components/FilesScreen'));
const BookingScreen = lazy(() => import('./components/BookingScreen'));
const ScheduleScreen = lazy(() => import('./components/ScheduleScreen'));
const HoursScreen = lazy(() => import('./components/HoursScreen'));
const FinanceScreen = lazy(() => import('./components/FinanceScreen'));
const StaffScreen = lazy(() => import('./components/StaffScreen'));
const AccessScreen = lazy(() => import('./components/AccessScreen'));
const CreditsScreen = lazy(() => import('./components/CreditsScreen'));
const NfcScreen = lazy(() => import('./components/NfcScreen'));
const CheckinsScreen = lazy(() => import('./components/CheckinsScreen'));
const BlogScreen = lazy(() => import('./components/BlogScreen'));
const LinksScreen = lazy(() => import('./components/LinksScreen'));

// Supports shareable links like /app/?screen=logs&student=litalk12345
// (e.g. the "copy study log link" buttons) by seeding the shared
// selection once on load, then dropping the query string — mirrors the
// legacy applyDeepLink().
function DeepLinkHandler() {
  const navigate = useNavigate();
  const [, setSelectedStudent] = useSharedStudentSelection();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const student = params.get('student');
    const screen = params.get('screen');
    if (!student && !screen) return;
    if (student) setSelectedStudent(student);
    const route = screen ? SCREEN_ROUTES[screen] : null;
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

function ScreenFallback() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}>
      <i className="fas fa-spinner fa-spin" style={{ fontSize: 28 }}></i>
    </div>
  );
}

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
  const handleLogout = () => logout({ logoutParams: { returnTo: `${window.location.origin}/app/` } });

  return (
    <ToastProvider>
      <ConfirmProvider>
        <SharedStudentProvider>
          <EditingLogProvider>
            <DeepLinkHandler />
            <div className="admin-dashboard" id="admin-panel" style={{ display: 'flex' }}>
              <Sidebar isAdmin={isAdmin} email={email} theme={theme} onLogout={handleLogout} />
              <main className="app-main">
                <MobileNav
                  isAdmin={isAdmin}
                  email={email}
                  theme={theme}
                  onToggleTheme={toggleTheme}
                  onLogout={handleLogout}
                />
                <Topbar title={title} onToggleTheme={toggleTheme} />
                <div className="dashboard-content">
                  <ChunkErrorBoundary>
                    <Suspense fallback={<ScreenFallback />}>
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
                    </Suspense>
                  </ChunkErrorBoundary>
                </div>
              </main>
            </div>
          </EditingLogProvider>
        </SharedStudentProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}
