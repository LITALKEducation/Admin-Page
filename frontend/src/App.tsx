import { useAuth0 } from '@auth0/auth0-react';
import Login from './components/Login';
import Sidebar from './components/Sidebar';
import Topbar from './components/Topbar';
import DashboardScreen from './components/DashboardScreen';
import { useTheme } from './hooks/useTheme';
import { useMe } from './hooks/useMe';

export default function App() {
  const { isLoading, isAuthenticated, user, logout } = useAuth0();
  const { theme, toggleTheme } = useTheme();
  const { isAdmin } = useMe();

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

  return (
    <div className="admin-dashboard" style={{ display: 'flex' }}>
      <Sidebar
        isAdmin={isAdmin}
        email={email}
        theme={theme}
        onLogout={() => logout({ logoutParams: { returnTo: window.location.origin + window.location.pathname } })}
      />
      <main className="app-main">
        <Topbar onToggleTheme={toggleTheme} />
        <div className="dashboard-content">
          <DashboardScreen />
        </div>
      </main>
    </div>
  );
}
