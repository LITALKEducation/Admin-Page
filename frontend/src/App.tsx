import { useAuth0 } from '@auth0/auth0-react';
import { Route, Routes, useLocation } from 'react-router-dom';
import Login from './components/Login';
import Sidebar from './components/Sidebar';
import Topbar from './components/Topbar';
import DashboardScreen from './components/DashboardScreen';
import StudentsScreen from './components/StudentsScreen';
import { useTheme } from './hooks/useTheme';
import { useMe } from './hooks/useMe';
import { ToastProvider } from './ui/ToastContext';
import { ConfirmProvider } from './ui/ConfirmContext';

const TITLES: Record<string, string> = {
  '/': 'Dashboard',
  '/students': 'รายชื่อนักเรียน',
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
        <div className="admin-dashboard" style={{ display: 'flex' }}>
          <Sidebar
            isAdmin={isAdmin}
            email={email}
            theme={theme}
            onLogout={() =>
              logout({ logoutParams: { returnTo: `${window.location.origin}/app/` } })
            }
          />
          <main className="app-main">
            <Topbar title={title} onToggleTheme={toggleTheme} />
            <div className="dashboard-content">
              <Routes>
                <Route path="/" element={<DashboardScreen />} />
                <Route path="/students" element={<StudentsScreen />} />
              </Routes>
            </div>
          </main>
        </div>
      </ConfirmProvider>
    </ToastProvider>
  );
}
