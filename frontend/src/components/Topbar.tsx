export default function Topbar({ title, onToggleTheme }: { title: string; onToggleTheme: () => void }) {
  return (
    <div className="topbar">
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <span className="breadcrumb-current">{title}</span>
      </nav>
      <span className="topbar-spacer"></span>
      <button className="topbar-icon-btn" aria-label="สลับธีม" title="สลับธีม" onClick={onToggleTheme}>
        <i className="fas fa-circle-half-stroke"></i>
      </button>
    </div>
  );
}
