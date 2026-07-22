export default function Topbar({
  title,
  onToggleTheme,
  onOpenSearch,
}: {
  title: string;
  onToggleTheme: () => void;
  onOpenSearch: () => void;
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
      <button className="topbar-icon-btn" aria-label="สลับธีม" title="สลับธีม" onClick={onToggleTheme}>
        <i className="fas fa-circle-half-stroke"></i>
      </button>
    </div>
  );
}
