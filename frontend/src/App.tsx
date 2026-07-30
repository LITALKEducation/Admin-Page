import { lazy, Suspense, useEffect, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import Login from './components/Login';
import Sidebar from './components/Sidebar';
import MobileNav from './components/MobileNav';
import QuickCreateFab from './components/QuickCreateFab';
import TeacherEmptyState from './components/TeacherEmptyState';
import ServiceClosed from './components/ServiceClosed';
import Topbar from './components/Topbar';
import { useTheme } from './hooks/useTheme';
import { useMe } from './hooks/useMe';
import { useStudents } from './hooks/useStudents';
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
const QuizzesScreen = lazy(() => import('./components/QuizzesScreen'));
const CoursesScreen = lazy(() => import('./components/CoursesScreen'));
const LearnersScreen = lazy(() => import('./components/LearnersScreen'));
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
const AiSettingsScreen = lazy(() => import('./components/AiSettingsScreen'));
const ServiceScreen = lazy(() => import('./components/ServiceScreen'));

// Code-split the palette: it drags in cmdk + the dialog primitive, and the
// Ctrl+K listener lives in App so nothing loads until the first open.
const CommandPalette = lazy(() => import('./components/CommandPalette'));
// Likewise the ID card, which pulls in the QR encoder.
const StaffIdCard = lazy(() => import('./components/StaffIdCard'));

// Supports shareable links like /app/?screen=logs&student=litalk12345
// (e.g. the "copy study log link" buttons) by seeding the shared
// selection once on load, then dropping the query string — mirrors the
// legacy applyDeepLink(). ?card=1 opens the digital ID card straight away,
// for a phone Shortcut / Action Button pinned to check-in.
function DeepLinkHandler({ onOpenIdCard }: { onOpenIdCard: () => void }) {
  const navigate = useNavigate();
  const [, setSelectedStudent] = useSharedStudentSelection();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const student = params.get('student');
    const screen = params.get('screen');
    const card = params.get('card');
    if (!student && !screen && !card) return;
    if (student) setSelectedStudent(student);
    if (card === '1') onOpenIdCard();
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
  '/quizzes': 'แบบทดสอบออนไลน์',
  '/courses': 'คอร์สเรียนออนไลน์',
  '/learners': 'ผู้เรียนออนไลน์',
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
  '/ai-settings': 'ตั้งค่า AI Chat',
  '/service': 'ควบคุมการเปิด-ปิดระบบ',
};

function ScreenFallback() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}>
      <div className="loader"></div>
    </div>
  );
}

export default function App() {
  const { isLoading, isAuthenticated, user, logout } = useAuth0();
  // Still called for its effect (it stamps data-theme / .dark on <html>);
  // the value itself is no longer read now that the logo recolors in CSS.
  const { toggleTheme } = useTheme();
  const { me, isAdmin, loading: meLoading } = useMe();
  const { students, loading: studentsLoading, failed: studentsFailed } = useStudents();
  const location = useLocation();
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Defer mounting the (lazy) palette until it's first needed so its cmdk +
  // dialog code stays out of the initial bundle.
  const [paletteMounted, setPaletteMounted] = useState(false);
  const openPalette = () => {
    setPaletteMounted(true);
    setPaletteOpen(true);
  };
  const [idCardOpen, setIdCardOpen] = useState(false);

  // Ctrl/Cmd+K lives here (not in the lazy palette) so the shortcut works
  // before the palette chunk has ever loaded.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteMounted(true);
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (isLoading) {
    return (
      <div className="modal-overlay active">
        <div className="loader"></div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Login />;
  }

  const email = user?.email || user?.nickname || user?.name || 'Admin';

  // The panel closed for maintenance. Checked before the teacher gate because
  // when the panel is shut, why it is shut is the more useful thing to say.
  // /me only ever reports this to a non-admin, so an admin never lands here.
  if (me?.serviceBlock) {
    return <ServiceClosed block={me.serviceBlock} isStaff={me.email || user?.email} />;
  }

  // A non-admin teacher with no assigned students gets no menus — just a
  // notice to contact staff (legacy applyRoleGating). Wait for both the
  // permission and student loads before deciding, so we never flash the
  // gate at an admin or a teacher whose students are still loading. A
  // failed student load is treated as "not gated" so a transient API
  // error doesn't lock a legitimate user out.
  if (!meLoading && !studentsLoading) {
    const gated = !isAdmin && !studentsFailed && students.length === 0;
    if (gated) {
      return <TeacherEmptyState identity={me?.email || user?.email || user?.name} />;
    }
  }
  const title = TITLES[location.pathname] || 'LITALK Control';
  const handleLogout = () => logout({ logoutParams: { returnTo: `${window.location.origin}/app/` } });

  return (
    <ToastProvider>
      <ConfirmProvider>
        <SharedStudentProvider>
          <EditingLogProvider>
            <DeepLinkHandler onOpenIdCard={() => setIdCardOpen(true)} />
            <QuickCreateFab isAdmin={isAdmin} />
            {/* These two are lazy like every screen, but they live OUTSIDE the
                Routes — so the ChunkErrorBoundary further down never covered
                them. A tab left open across a deploy asks for a chunk filename
                that no longer exists, React.lazy throws, and with no boundary
                above it the error reached the root and unmounted the whole app:
                tapping the ID card button blanked the entire page. Measured
                with the chunk 404ing — #root went from 3 children to 0.
                Wrapped here so a stale chunk gets the same one-shot
                cache-busted reload a stale screen already got. */}
            <ChunkErrorBoundary>
              {paletteMounted && (
                <Suspense fallback={null}>
                  <CommandPalette
                    isAdmin={isAdmin}
                    students={students}
                    open={paletteOpen}
                    onOpenChange={setPaletteOpen}
                  />
                </Suspense>
              )}
              {idCardOpen && (
                <Suspense fallback={null}>
                  <StaffIdCard me={me} isAdmin={isAdmin} onClose={() => setIdCardOpen(false)} />
                </Suspense>
              )}
            </ChunkErrorBoundary>
            <div className="admin-dashboard" id="admin-panel" style={{ display: 'flex' }}>
              <Sidebar isAdmin={isAdmin} email={email} onLogout={handleLogout} />
              <main className="app-main">
                <MobileNav
                  isAdmin={isAdmin}
                  email={email}
                  onToggleTheme={toggleTheme}
                  onLogout={handleLogout}
                  onOpenSearch={openPalette}
                  onOpenIdCard={() => setIdCardOpen(true)}
                />
                <Topbar
                  title={title}
                  onToggleTheme={toggleTheme}
                  onOpenSearch={openPalette}
                  onOpenIdCard={() => setIdCardOpen(true)}
                />
                <div className="dashboard-content">
                  <ChunkErrorBoundary>
                    <Suspense fallback={<ScreenFallback />}>
                      <Routes>
                        <Route path="/" element={<DashboardScreen />} />
                        <Route path="/students" element={<StudentsScreen />} />
                        <Route path="/check" element={<CheckScreen />} />
                        <Route path="/logs" element={<LogsScreen />} />
                        <Route path="/quizzes" element={<QuizzesScreen />} />
                        <Route path="/courses" element={<CoursesScreen />} />
                        <Route path="/learners" element={<LearnersScreen />} />
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
                        {isAdmin && <Route path="/ai-settings" element={<AiSettingsScreen />} />}
                        {isAdmin && <Route path="/service" element={<ServiceScreen />} />}
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
