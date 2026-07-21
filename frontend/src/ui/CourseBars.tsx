// Course mix as labeled horizontal bars — few categories, long Thai labels
// read better than a pie chart would.
export default function CourseBars({ courses }: { courses: { course: string; n: number }[] }) {
  if (!courses.length) return <div className="form-hint">ยังไม่มีข้อมูลนักเรียน</div>;
  const max = Math.max(...courses.map((c) => c.n), 1);
  return (
    <>
      {courses.map((c) => (
        <div className="hbar-row" key={c.course}>
          <span className="hbar-label" title={c.course}>
            {c.course}
          </span>
          <div className="hbar-track">
            <div className="hbar-fill" style={{ width: `${Math.round((c.n / max) * 100)}%` }}></div>
          </div>
          <span className="hbar-value">{c.n} คน</span>
        </div>
      ))}
    </>
  );
}
