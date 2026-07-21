// Shared pagination control (prev/next + numbered pages with an ellipsis
// past 7 pages) — mirrors the legacy renderPaginationControls().
export default function Pagination({
  page,
  totalPages,
  totalItems,
  start,
  pageCount,
  onGoToPage,
}: {
  page: number;
  totalPages: number;
  totalItems: number;
  start: number;
  pageCount: number;
  onGoToPage: (page: number) => void;
}) {
  if (totalPages <= 1) return null;

  let pages: number[];
  if (totalPages <= 7) {
    pages = Array.from({ length: totalPages }, (_, i) => i + 1);
  } else {
    pages = [...new Set([1, 2, totalPages - 1, totalPages, page - 1, page, page + 1])]
      .filter((p) => p >= 1 && p <= totalPages)
      .sort((a, b) => a - b);
  }

  let lastPage = 0;
  const items: ReactChild[] = [];
  for (const p of pages) {
    if (p - lastPage > 1) items.push({ type: 'ellipsis', key: `e${p}` });
    items.push({ type: 'page', key: p, page: p });
    lastPage = p;
  }

  return (
    <>
      <span className="pagination-summary">
        แสดง {totalItems === 0 ? 0 : start + 1}-{start + pageCount} จาก {totalItems} รายการ
      </span>
      <div className="pagination-controls">
        <button
          className="page-btn"
          onClick={() => onGoToPage(page - 1)}
          disabled={page <= 1}
          aria-label="ก่อนหน้า"
        >
          <i className="fas fa-chevron-left"></i>
        </button>
        {items.map((item) =>
          item.type === 'ellipsis' ? (
            <span className="page-btn ellipsis" key={item.key}>
              …
            </span>
          ) : (
            <button
              key={item.key}
              className={`page-btn ${item.page === page ? 'active' : ''}`}
              onClick={() => onGoToPage(item.page!)}
            >
              {item.page}
            </button>
          ),
        )}
        <button
          className="page-btn"
          onClick={() => onGoToPage(page + 1)}
          disabled={page >= totalPages}
          aria-label="ถัดไป"
        >
          <i className="fas fa-chevron-right"></i>
        </button>
      </div>
    </>
  );
}

type ReactChild = { type: 'ellipsis'; key: string } | { type: 'page'; key: number; page: number };
