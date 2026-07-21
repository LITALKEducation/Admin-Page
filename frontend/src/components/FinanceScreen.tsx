import { useCallback, useEffect, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { formatBaht, formatShortThaiDate } from '../utils/format';
import BarChart from '../ui/BarChart';
import CourseBars from '../ui/CourseBars';
import { makeTokenGetter, fetchFinance, fetchAnalytics, type FinanceResponse, type AnalyticsResponse } from '../api/client';

const FINANCE_SOURCE_LABEL: Record<string, string> = { manual: 'บันทึกเอง', stripe: 'Stripe' };

export default function FinanceScreen() {
  const { getAccessTokenSilently } = useAuth0();
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [finance, setFinance] = useState<FinanceResponse | null>(null);
  const [financeFailed, setFinanceFailed] = useState(false);
  const [analytics, setAnalytics] = useState<AnalyticsResponse | null>(null);
  const [analyticsFailed, setAnalyticsFailed] = useState(false);

  const loadFinance = useCallback(async () => {
    setFinanceFailed(false);
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      setFinance(await fetchFinance(getToken, month));
    } catch (error) {
      console.error('loadFinance:', error);
      setFinance(null);
      setFinanceFailed(true);
    }
  }, [getAccessTokenSilently, month]);

  const loadAnalytics = useCallback(async () => {
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      setAnalytics(await fetchAnalytics(getToken));
    } catch (error) {
      console.error('loadAnalytics:', error);
      setAnalytics(null);
      setAnalyticsFailed(true);
    }
  }, [getAccessTokenSilently]);

  useEffect(() => {
    loadFinance();
  }, [loadFinance]);

  useEffect(() => {
    loadAnalytics();
  }, [loadAnalytics]);

  const money = (v: number) => formatBaht(v);
  const count = (v: number) => String(v);
  const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);

  return (
    <div id="screen-finance" className="tab-content active">
      <div className="dashboard-top">
        <div className="screen-header">
          <h1>สรุปการเงิน</h1>
          <p>ภาพรวมรายรับ ธุรกรรมทั้งหมด และรายได้ของครูแต่ละคน</p>
        </div>
        <div className="form-group" style={{ margin: 0, minWidth: 160 }}>
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </div>
      </div>

      <div className="stat-grid">
        {financeFailed || !finance ? (
          <div className="form-hint">โหลดข้อมูลการเงินไม่สำเร็จ (เฉพาะแอดมิน)</div>
        ) : (
          [
            { label: 'รายรับรวม', icon: 'fas fa-coins', value: formatBaht(finance.total), sub: `${finance.count} รายการ` },
            { label: 'บันทึกเอง', icon: 'fas fa-money-bill', value: formatBaht(finance.manualTotal), sub: 'เงินสด/โอน' },
            { label: 'ผ่าน Stripe', icon: 'fab fa-stripe-s', value: formatBaht(finance.stripeTotal), sub: 'ออนไลน์' },
            { label: 'ลิงก์รอชำระ', icon: 'fas fa-hourglass-half', value: formatBaht(finance.pendingLinks.total), sub: `${finance.pendingLinks.count} ลิงก์` },
            { label: 'ส่วนลดที่ให้ไป', icon: 'fas fa-tag', value: formatBaht(finance.discounts.total), sub: `${finance.discounts.count} รายการ` },
          ].map((c) => (
            <div className="stat-card" key={c.label}>
              <div className="stat-card-top">
                <span className="stat-card-label">{c.label}</span>
                <i className={c.icon}></i>
              </div>
              <div className="stat-card-value">{c.value}</div>
              <div className="stat-card-sub">{c.sub}</div>
            </div>
          ))
        )}
      </div>

      <div className="admin-card" style={{ marginTop: 20 }}>
        <div className="card-title-bar">
          <span className="card-icon">
            <i className="fas fa-chalkboard-user"></i>
          </span>
          <div>
            <h3>รายได้ตามครู</h3>
            <p>รายรับเดือนนี้จากนักเรียนที่ครูแต่ละคนรับผิดชอบ</p>
          </div>
        </div>
        <div className="row-list tight">
          {finance?.byTeacher?.length ? (
            finance.byTeacher.map((t, i) => (
              <div className="payment-row" key={i}>
                <div className="payment-info">
                  <div className="name">{t.teacherName || t.teacher}</div>
                  <div className="meta">
                    {t.students} นักเรียน · {t.count} รายการ
                  </div>
                </div>
                <div className="amount">{formatBaht(t.total)}</div>
              </div>
            ))
          ) : (
            <div className="form-hint">ยังไม่มีการกำหนดนักเรียนให้ครู</div>
          )}
        </div>
      </div>

      <div className="admin-card" style={{ marginTop: 20 }}>
        <div className="card-title-bar">
          <span className="card-icon">
            <i className="fas fa-user-pen"></i>
          </span>
          <div>
            <h3>รายได้ตามผู้บันทึก</h3>
            <p>ยอดที่แต่ละบัญชีเป็นผู้บันทึก/รับชำระ</p>
          </div>
        </div>
        <div className="row-list tight">
          {finance?.byRecorder?.length ? (
            finance.byRecorder.map((r, i) => (
              <div className="payment-row" key={i}>
                <div className="payment-info">
                  <div className="name">{r.name || r.identity}</div>
                  <div className="meta">{r.count} รายการ</div>
                </div>
                <div className="amount">{formatBaht(r.total)}</div>
              </div>
            ))
          ) : (
            <div className="form-hint">ไม่มีข้อมูล</div>
          )}
        </div>
      </div>

      <div className="admin-card" style={{ marginTop: 20 }}>
        <div className="card-title-bar">
          <span className="card-icon">
            <i className="fas fa-receipt"></i>
          </span>
          <div>
            <h3>ธุรกรรมทั้งหมด</h3>
            <p>รายการชำระเงินทุกรายการในเดือนนี้</p>
          </div>
        </div>
        <div className="table-scroll">
          {!finance?.transactions?.length ? (
            <div className="form-hint">ไม่มีธุรกรรมในเดือนนี้</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>วันที่</th>
                  <th>นักเรียน/ลูกค้า</th>
                  <th>ช่องทาง</th>
                  <th>ผู้บันทึก</th>
                  <th>หลักฐาน</th>
                  <th style={{ textAlign: 'right' }}>จำนวน</th>
                </tr>
              </thead>
              <tbody>
                {finance.transactions.map((t, i) => (
                  <tr key={i}>
                    <td>{formatShortThaiDate(t.date)}</td>
                    <td>{t.studentName}</td>
                    <td>{t.method || FINANCE_SOURCE_LABEL[t.source] || t.source}</td>
                    <td>{t.recordedBy || '-'}</td>
                    <td>
                      {t.source === 'stripe' ? (
                        t.stripeSessionId ? (
                          <span title="Payment ID">{t.stripeSessionId.slice(0, 18)}…</span>
                        ) : (
                          '-'
                        )
                      ) : t.proof ? (
                        <a href={t.proof} target="_blank" rel="noopener">
                          ดูหลักฐาน
                        </a>
                      ) : (
                        '-'
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {formatBaht(t.amount)}
                      {!!t.discountAmount && <div className="form-hint" style={{ margin: 0 }}>ลด {formatBaht(t.discountAmount)}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="admin-card" style={{ marginTop: 20 }}>
        <div className="card-title-bar">
          <span className="card-icon">
            <i className="fas fa-chart-column"></i>
          </span>
          <div>
            <h3>สถิติย้อนหลัง 6 เดือน</h3>
            <p>แนวโน้มรายรับ คลาสที่สอน และการเติบโตของนักเรียน (ไม่ขึ้นกับเดือนที่เลือกด้านบน)</p>
          </div>
        </div>
        {analyticsFailed || !analytics ? (
          <div className="form-hint">โหลดสถิติไม่สำเร็จ (เฉพาะแอดมิน)</div>
        ) : (
          <>
            <div className="stat-grid" style={{ marginBottom: 16 }}>
              {[
                {
                  label: 'นักเรียนเรียนต่อเนื่อง',
                  icon: 'fas fa-user-check',
                  value: analytics.retention.rate === null ? '—' : analytics.retention.rate + '%',
                  sub:
                    analytics.retention.rate === null
                      ? 'ยังไม่มีข้อมูลเดือนก่อน'
                      : `${analytics.retention.retained} จาก ${analytics.retention.lastMonthActive} คนของเดือนก่อนยังเรียนเดือนนี้`,
                },
                { label: 'รายรับรวม 6 เดือน', icon: 'fas fa-sack-dollar', value: formatBaht(sum(analytics.revenue)), sub: 'รวมทุกช่องทางชำระเงิน' },
                { label: 'คลาสรวม 6 เดือน', icon: 'fas fa-chalkboard-teacher', value: `${sum(analytics.classes)} คลาส`, sub: 'จากบันทึกการเรียนทั้งหมด' },
                { label: 'นักเรียนใหม่ 6 เดือน', icon: 'fas fa-user-plus', value: `${sum(analytics.newStudents)} คน`, sub: 'บัญชีที่สร้างใหม่ในระบบ' },
              ].map((c) => (
                <div className="stat-card" key={c.label}>
                  <div className="stat-card-top">
                    <span className="stat-card-label">{c.label}</span>
                    <i className={c.icon}></i>
                  </div>
                  <div className="stat-card-value">{c.value}</div>
                  <div className="stat-card-sub">{c.sub}</div>
                </div>
              ))}
            </div>
            <div className="analytics-grid">
              <div className="analytics-block">
                <h4>รายรับต่อเดือน</h4>
                <BarChart months={analytics.months} values={analytics.revenue} format={money} />
              </div>
              <div className="analytics-block">
                <h4>คลาสที่สอนต่อเดือน</h4>
                <BarChart months={analytics.months} values={analytics.classes} format={count} />
              </div>
              <div className="analytics-block">
                <h4>นักเรียนที่มาเรียนต่อเดือน</h4>
                <BarChart months={analytics.months} values={analytics.activeStudents} format={count} />
              </div>
              <div className="analytics-block">
                <h4>นักเรียนใหม่ต่อเดือน</h4>
                <BarChart months={analytics.months} values={analytics.newStudents} format={count} />
              </div>
            </div>
            <div className="analytics-block" style={{ marginTop: 16 }}>
              <h4>คอร์สยอดนิยม (นักเรียนปัจจุบัน)</h4>
              <CourseBars courses={analytics.courses || []} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
