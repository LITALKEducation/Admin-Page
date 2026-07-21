import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth0 } from '@auth0/auth0-react';
import { makeTokenGetter, fetchDashboard, type DashboardResponse, type DashboardRange } from '../api/client';
import { formatBaht, formatClassTimeLocal, formatShortThaiDate } from '../utils/format';
import { legacyLink } from '../utils/legacyLink';
import { useSharedStudentSelection } from '../hooks/useSharedStudentSelection';

const INTERNAL_SCREENS: Record<string, string> = {
  logs: '/logs',
  payments: '/payments',
  booking: '/booking',
  check: '/check',
  files: '/files',
};

const TIMEFRAMES: { id: DashboardRange; label: string }[] = [
  { id: 'today', label: 'วันนี้' },
  { id: 'week', label: 'สัปดาห์นี้' },
  { id: 'month', label: 'เดือนนี้' },
  { id: 'year', label: 'ปีนี้' },
];

const DOW = ['จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส', 'อา'];

export default function DashboardScreen() {
  const { getAccessTokenSilently } = useAuth0();
  const navigate = useNavigate();
  const [, setSelectedStudent] = useSharedStudentSelection();
  const [range, setRange] = useState<DashboardRange>('today');
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  // Screens still on the legacy admin panel link out with a deep link;
  // migrated screens use the shared selection + client-side route instead.
  const goToStudentAndScreen = (studentId: string | null, screen: string) => {
    const route = INTERNAL_SCREENS[screen];
    if (route) {
      if (studentId) setSelectedStudent(studentId);
      navigate(route);
    } else {
      window.location.href = legacyLink(screen, studentId);
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      const result = await fetchDashboard(getToken, range);
      setData(result);
    } catch (error) {
      console.error('Error loading dashboard:', error);
      setData(null);
      setFailed(true);
    }
    setLoading(false);
  }, [getAccessTokenSilently, range]);

  useEffect(() => {
    load();
  }, [load]);

  const todayLabel = new Date().toLocaleDateString('th-TH', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  const statCards = data
    ? [
        { label: 'คลาสเรียน', icon: 'fa-chalkboard-teacher', value: String(data.stats.classes || 0), sub: 'คลาสที่สอนในช่วงนี้' },
        { label: 'การจองล่วงหน้า', icon: 'fa-calendar-check', value: String(data.stats.booked || 0), sub: 'คลาสที่จองไว้แล้ว' },
        { label: 'รายรับ', icon: 'fa-money-bill-wave', value: formatBaht(data.stats.revenue), sub: data.stats.revenueLabel || '' },
        { label: 'ค้างชำระ', icon: 'fa-triangle-exclamation', value: String(data.stats.unpaid || 0), sub: 'นักเรียนที่ต้องติดตาม' },
      ]
    : [];

  const week = data?.weekClasses || [];
  const weekStart = data?.weekStart;
  const weekBase = weekStart ? new Date(weekStart + 'T00:00:00') : new Date();
  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekBase.getTime() + i * 86400000);
    const ymd = d.toISOString().slice(0, 10);
    const items = week.filter((w) => w.date === ymd).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    return { label: DOW[i], date: d, items };
  });

  return (
    <div id="screen-dashboard" className="tab-content active">
      <div className="dashboard-top">
        <div className="screen-header">
          <h1>Dashboard</h1>
          <p>
            <i className="fas fa-calendar-day" style={{ marginRight: 6 }}></i>
            <span>{todayLabel}</span>
          </p>
        </div>
        <div className="tab-menu" role="tablist">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf.id}
              className="tab-btn"
              role="tab"
              aria-selected={range === tf.id}
              onClick={() => setRange(tf.id)}
            >
              {tf.label}
            </button>
          ))}
        </div>
      </div>

      <div className="stat-grid">
        {loading || failed
          ? Array.from({ length: 4 }, (_, i) => (
              <div className="stat-card" key={i}>
                {failed ? (
                  <div className="form-hint">โหลดข้อมูลแดชบอร์ดไม่สำเร็จ ลองสลับแท็บช่วงเวลาหรือรีเฟรชหน้าอีกครั้ง</div>
                ) : (
                  <>
                    <div className="skeleton skeleton-line" style={{ width: '60%' }}></div>
                    <div className="skeleton skeleton-line" style={{ width: '40%', height: 24 }}></div>
                    <div className="skeleton skeleton-line" style={{ width: '75%' }}></div>
                  </>
                )}
              </div>
            ))
          : statCards.map((c) => (
              <div className="stat-card" key={c.label}>
                <div className="stat-card-top">
                  <span className="stat-card-label">{c.label}</span>
                  <i className={`fas ${c.icon}`}></i>
                </div>
                <div className="stat-card-value">{c.value}</div>
                <div className="stat-card-sub">{c.sub}</div>
              </div>
            ))}
      </div>

      <div className="admin-card" style={{ marginBottom: 20 }}>
        <div className="card-title-bar">
          <span className="card-icon">
            <i className="fas fa-calendar-week"></i>
          </span>
          <div>
            <h3>ตารางสอนสัปดาห์นี้</h3>
            <p>
              {week.length ? `${week.length} คาบเรียนในสัปดาห์นี้` : 'ยังไม่มีคาบเรียนที่จองไว้ในสัปดาห์นี้'} (เวลาแสดงตามอุปกรณ์ของคุณ)
            </p>
          </div>
        </div>
        <div className="week-grid">
          {weekDays.map((day, i) => (
            <div className="week-day" key={i}>
              <div className="week-day-head">
                {day.label} <span>{day.date.getDate()}/{day.date.getMonth() + 1}</span>
              </div>
              <div className="week-day-body">
                {day.items.length ? (
                  day.items.map((it, j) => (
                    <div className="week-slot" key={j}>
                      <b>{formatClassTimeLocal(it.date, it.time)}</b> {it.name}
                    </div>
                  ))
                ) : (
                  <div className="week-empty">—</div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="dashboard-grid">
        <div className="admin-card">
          <div className="card-title-bar">
            <span className="card-icon">
              <i className="fas fa-clock"></i>
            </span>
            <div>
              <h3>คลาสวันนี้</h3>
              <p>ตารางเรียนและสถานะการบันทึกผล (เวลาแสดงตามอุปกรณ์ของคุณ)</p>
            </div>
          </div>
          <div className="row-list">
            {!data || !data.todayClasses.length ? (
              <div className="form-hint">{failed ? 'โหลดข้อมูลไม่สำเร็จ' : 'ไม่มีคลาสเรียนวันนี้'}</div>
            ) : (
              data.todayClasses.map((row, i) => (
                <div className="class-row" key={i}>
                  <div className="class-time">{formatClassTimeLocal(data.today, row.time)}</div>
                  <div className="class-info">
                    <div className="name">{row.name}</div>
                    <div className="course">{row.course || ''}</div>
                  </div>
                  <span className={`class-status ${row.done ? 'done' : 'pending'}`}>
                    <i className={row.done ? 'fas fa-check-circle' : 'far fa-clock'}></i>{' '}
                    {row.done ? 'บันทึกแล้ว' : 'รอบันทึกผล'}
                  </span>
                  {row.meetLink && (
                    <a href={row.meetLink} target="_blank" rel="noopener" className="class-log-btn">
                      <i className="fas fa-video"></i> Meet
                    </a>
                  )}
                  <button className="class-log-btn" onClick={() => goToStudentAndScreen(row.studentId, 'logs')}>
                    <i className="fas fa-pen"></i> บันทึกผล
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="dashboard-col">
          <div className="admin-card">
            <div className="card-title-bar">
              <span className="card-icon">
                <i className="fas fa-bolt"></i>
              </span>
              <div>
                <h3>ทางลัด</h3>
                <p>เริ่มงานที่ทำบ่อย</p>
              </div>
            </div>
            <div className="form-body">
              <Link className="btn btn-primary" style={{ width: '100%' }} to="/logs">
                <i className="fas fa-book-open"></i> บันทึกการเรียน
              </Link>
              <Link className="btn btn-secondary" style={{ width: '100%' }} to="/students">
                <i className="fas fa-users"></i> รายชื่อนักเรียน
              </Link>
              <Link className="btn btn-secondary" style={{ width: '100%' }} to="/payments">
                <i className="fas fa-money-bill-wave"></i> บันทึกการชำระเงิน
              </Link>
              <Link className="btn btn-secondary" style={{ width: '100%' }} to="/booking">
                <i className="fas fa-calendar-check"></i> จองเวลาเรียน
              </Link>
            </div>
          </div>

          {!!data?.alerts.length && (
            <div className="admin-card">
              <div className="card-title-bar">
                <span className="card-icon">
                  <i className="fas fa-bell"></i>
                </span>
                <div>
                  <h3>การแจ้งเตือน</h3>
                  <p>รายการที่ต้องติดตาม</p>
                </div>
              </div>
              <div className="row-list">
                {data.alerts.map((a, i) => (
                  <div className="alert-row" key={i}>
                    <i
                      className={a.type === 'unpaid' ? 'fas fa-triangle-exclamation' : 'far fa-sticky-note'}
                      style={{ color: a.type === 'unpaid' ? 'var(--accent-danger)' : 'var(--text-muted)' }}
                    ></i>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="alert-text">{a.text}</div>
                      <button className="alert-action" onClick={() => goToStudentAndScreen(a.studentId, a.screen || 'dashboard')}>
                        {a.actionLabel} <i className="fas fa-arrow-right" style={{ fontSize: 10 }}></i>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="admin-card">
            <div className="card-title-bar">
              <span className="card-icon">
                <i className="fas fa-money-bill-wave"></i>
              </span>
              <div>
                <h3>การชำระเงินล่าสุด</h3>
                <p>{data ? data.revenueSub || `รวม ${formatBaht(data.stats.revenue)}` : '-'}</p>
              </div>
            </div>
            <div className="row-list tight">
              {!data || !data.recentPayments.length ? (
                <div className="form-hint">{failed ? 'โหลดข้อมูลไม่สำเร็จ' : 'ยังไม่มีรายการชำระเงิน'}</div>
              ) : (
                data.recentPayments.map((p, i) => (
                  <div className="payment-row" key={i}>
                    <div className="payment-info">
                      <div className="name">{p.name}</div>
                      <div className="meta">
                        {p.method || '-'} · {formatShortThaiDate(p.dateYMD)}
                      </div>
                    </div>
                    <div className="amount">{formatBaht(p.total)}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
