import NotificationBell from './NotificationBell';

export default function Topbar({
  title,
  onToggleTheme,
  onOpenSearch,
  onOpenIdCard,
}: {
  title: string;
  onToggleTheme: () => void;
  onOpenSearch: () => void;
  onOpenIdCard: () => void;
}) {
  return (
    <div className="topbar">
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <span className="breadcrumb-current">{title}</span>
      </nav>
      <span className="topbar-spacer"></span>
      <button className="topbar-search-btn" aria-label="ค้นหา (Ctrl+K)" title="ค้นหา (Ctrl+K)" onClick={onOpenSearch}>
        <i className="fas fa-magnifying-glass"></i>
        <span className="topbar-search-label">ค้นหา...</span>
        <span className="topbar-search-kbd">⌘K</span>
      </button>
      <NotificationBell />
      <button
        className="topbar-icon-btn"
        aria-label="บัตรประจำตัวดิจิทัล"
        title="บัตรประจำตัวดิจิทัล"
        onClick={onOpenIdCard}
      >
        <i className="fas fa-id-card"></i>
      </button>
      <button className="topbar-icon-btn" aria-label="สลับธีม" title="สลับธีม" onClick={onToggleTheme}>
        <i className="fas fa-circle-half-stroke"></i>
      </button>
    </div>
  );
}
