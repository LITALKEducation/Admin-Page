// Single-series monthly bar chart as inline SVG — a simplified port of the
// legacy renderBarChart(): monochrome ink bars, baseline + midline grid,
// selective value labels (max + latest only), and an accessible <details>
// table. Native <title> tooltips replace the legacy's custom hover tooltip.
function thaiMonthShort(ym: string): string {
  const d = new Date(ym + '-01T00:00:00');
  return isNaN(d.getTime()) ? ym : d.toLocaleDateString('th-TH', { month: 'short' });
}

function formatThaiMonthYearShort(ym: string): string {
  const d = new Date(ym + '-01T00:00:00');
  if (isNaN(d.getTime())) return ym || '';
  return `${d.toLocaleDateString('th-TH', { month: 'long' })} ${String(d.getFullYear() + 543).slice(-2)}`;
}

export default function BarChart({
  months,
  values,
  format,
}: {
  months: string[];
  values: number[];
  format: (v: number) => string;
}) {
  const W = 520;
  const H = 170;
  const top = 22;
  const bottom = 24;
  const side = 8;
  const plotH = H - top - bottom;
  const max = Math.max(...values, 1);
  const slot = (W - side * 2) / months.length;
  const barW = Math.min(36, slot * 0.5);
  const maxIdx = values.indexOf(Math.max(...values));
  const lastIdx = values.length - 1;
  const midY = top + plotH / 2;

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="กราฟแท่งรายเดือน">
        <line x1={side} y1={midY} x2={W - side} y2={midY} style={{ stroke: 'var(--border-color)' }} strokeWidth={1} strokeDasharray="3 4" />
        <line x1={side} y1={top + plotH} x2={W - side} y2={top + plotH} style={{ stroke: 'var(--border-color)' }} strokeWidth={1} />
        {months.map((m, i) => {
          const v = values[i];
          const h = Math.round((v / max) * plotH);
          const x = side + i * slot + (slot - barW) / 2;
          const y = top + plotH - h;
          const r = Math.min(4, h);
          const barPath =
            h > 0
              ? `M ${x} ${top + plotH} L ${x} ${y + r} Q ${x} ${y} ${x + r} ${y} L ${x + barW - r} ${y} Q ${x + barW} ${y} ${x + barW} ${y + r} L ${x + barW} ${top + plotH} Z`
              : '';
          return (
            <g key={i}>
              {barPath && <path d={barPath} style={{ fill: 'var(--text-primary)' }} />}
              {(i === maxIdx && values[maxIdx] > 0) || i === lastIdx ? (
                <text x={x + barW / 2} y={y - 6} textAnchor="middle" fontSize={11} fontWeight={600} style={{ fill: 'var(--text-primary)' }}>
                  {format(v)}
                </text>
              ) : null}
              <text x={side + i * slot + slot / 2} y={H - 8} textAnchor="middle" fontSize={10.5} style={{ fill: 'var(--text-muted)' }}>
                {thaiMonthShort(m)}
              </text>
              <rect x={side + i * slot} y={top} width={slot} height={plotH} fill="transparent">
                <title>
                  {formatThaiMonthYearShort(m)}: {format(v)}
                </title>
              </rect>
            </g>
          );
        })}
      </svg>
      <details className="chart-table">
        <summary>ดูข้อมูลเป็นตาราง</summary>
        <table>
          <thead>
            <tr>
              <th>เดือน</th>
              <th>ค่า</th>
            </tr>
          </thead>
          <tbody>
            {months.map((m, i) => (
              <tr key={i}>
                <td>{formatThaiMonthYearShort(m)}</td>
                <td>{format(values[i])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
