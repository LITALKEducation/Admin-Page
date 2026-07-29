import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import {
  makeTokenGetter,
  fetchAllEnrollments,
  fetchAllQuizAttempts,
  type EnrollmentRow,
  type QuizAttemptOverviewRow,
} from '../api/client';

type Tab = 'enroll' | 'attempts';

function accountBadge(accountType: string | null) {
  const onDemand = accountType === 'on_demand';
  return (
    <span
      style={{
        fontSize: 11,
        padding: '2px 7px',
        borderRadius: 999,
        marginLeft: 6,
        background: onDemand ? 'rgba(16,185,129,.12)' : 'rgba(99,102,241,.12)',
        color: onDemand ? '#059669' : '#4f46e5',
        whiteSpace: 'nowrap',
      }}
    >
      {onDemand ? 'On Demand' : 'ตัวต่อตัว'}
    </span>
  );
}

function fmtDate(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
}

export default function LearnersScreen() {
  const { getAccessTokenSilently } = useAuth0();

  const [tab, setTab] = useState<Tab>('enroll');
  const [search, setSearch] = useState('');
  const [enrollments, setEnrollments] = useState<EnrollmentRow[] | null>(null);
  const [attempts, setAttempts] = useState<QuizAttemptOverviewRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  const loadEnroll = useCallback(async () => {
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      const res = await fetchAllEnrollments(getToken);
      setEnrollments(res.enrollments);
      setFailed(false);
    } catch (error) {
      console.error('loadEnrollments:', error);
      setFailed(true);
    }
  }, [getAccessTokenSilently]);

  const loadAttempts = useCallback(async () => {
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      const res = await fetchAllQuizAttempts(getToken);
      setAttempts(res.attempts);
      setFailed(false);
    } catch (error) {
      console.error('loadAttempts:', error);
      setFailed(true);
    }
  }, [getAccessTokenSilently]);

  useEffect(() => {
    if (tab === 'enroll' && enrollments === null) loadEnroll();
    if (tab === 'attempts' && attempts === null) loadAttempts();
  }, [tab, enrollments, attempts, loadEnroll, loadAttempts]);

  const term = search.trim().toLowerCase();

  const filteredEnroll = useMemo(() => {
    if (!enrollments) return [];
    if (!term) return enrollments;
    return enrollments.filter((e) =>
      `${e.studentName ?? ''} ${e.studentNickname ?? ''} ${e.studentId} ${e.studentEmail ?? ''} ${e.courseTitleTh ?? ''} ${e.courseTitle}`
        .toLowerCase()
        .includes(term),
    );
  }, [enrollments, term]);

  const filteredAttempts = useMemo(() => {
    if (!attempts) return [];
    if (!term) return attempts;
    return attempts.filter((a) =>
      `${a.studentName ?? ''} ${a.studentNickname ?? ''} ${a.studentId} ${a.quizTitleTh ?? ''} ${a.quizTitle}`
        .toLowerCase()
        .includes(term),
    );
  }, [attempts, term]);

  const revenue = useMemo(
    () => filteredEnroll.reduce((sum, e) => sum + (Number(e.amount) || 0), 0),
    [filteredEnroll],
  );
  const passCount = useMemo(() => filteredAttempts.filter((a) => a.passed === 1).length, [filteredAttempts]);

  const cell: React.CSSProperties = { padding: '10px 12px', borderBottom: '1px solid var(--border-color, #eee)', verticalAlign: 'top' };
  const headCell: React.CSSProperties = { ...cell, textAlign: 'left', fontSize: 12.5, color: 'var(--text-secondary, #888)', fontWeight: 600 };

  return (
    <>
      <div className="screen-header">
        <h1>ผู้เรียนออนไลน์</h1>
        <p>ดูรายชื่อผู้ลงทะเบียนคอร์สและผู้ทำแบบทดสอบทั้งระบบในที่เดียว — ค้นหาตามชื่อ รหัส อีเมล คอร์ส หรือแบบทดสอบ</p>
      </div>

      <div className="admin-card">
        <div className="card-title-bar">
          <span className="card-icon">
            <i className="fas fa-user-check"></i>
          </span>
          <div style={{ flex: 1 }}>
            <h3>{tab === 'enroll' ? 'ผู้ลงทะเบียนคอร์ส' : 'ผู้ทำแบบทดสอบ'}</h3>
            <p>
              {tab === 'enroll'
                ? `${filteredEnroll.length} รายการ · ยอดรวม ฿${revenue.toLocaleString('en-US')}`
                : `${filteredAttempts.length} รายการ · ผ่าน ${passCount} ครั้ง`}
            </p>
          </div>
        </div>

        <div className="form-body">
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14, alignItems: 'center' }}>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                type="button"
                className={`btn ${tab === 'enroll' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setTab('enroll')}
              >
                <i className="fas fa-user-plus"></i> ผู้ลงทะเบียน
              </button>
              <button
                type="button"
                className={`btn ${tab === 'attempts' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setTab('attempts')}
              >
                <i className="fas fa-clipboard-check"></i> ผู้สอบ
              </button>
            </div>
            <input
              type="search"
              value={search}
              placeholder="ค้นหาชื่อ / รหัส / อีเมล / คอร์ส / แบบทดสอบ..."
              style={{ flex: '1 1 240px' }}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          {failed && <div className="form-hint">โหลดข้อมูลไม่สำเร็จ กรุณาลองใหม่อีกครั้ง</div>}

          {tab === 'enroll' && (
            <>
              {enrollments === null && !failed && <div className="loader"></div>}
              {enrollments && filteredEnroll.length === 0 && (
                <div className="empty-state">
                  <div className="empty-title">ยังไม่มีผู้ลงทะเบียน</div>
                  <div className="empty-sub">เมื่อมีนักเรียนลงทะเบียนคอร์ส รายชื่อจะแสดงที่นี่</div>
                </div>
              )}
              {enrollments && filteredEnroll.length > 0 && (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 620 }}>
                    <thead>
                      <tr>
                        <th style={headCell}>นักเรียน</th>
                        <th style={headCell}>คอร์ส</th>
                        <th style={{ ...headCell, textAlign: 'right' }}>ยอดชำระ</th>
                        <th style={headCell}>วันที่ลงทะเบียน</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredEnroll.map((e) => (
                        <tr key={e.id}>
                          <td style={cell}>
                            <div style={{ fontWeight: 600 }}>
                              {e.studentNickname || e.studentName || e.studentId}
                              {accountBadge(e.accountType)}
                            </div>
                            <div className="form-hint">{e.studentEmail || e.studentId}</div>
                          </td>
                          <td style={cell}>{e.courseTitleTh || e.courseTitle}</td>
                          <td style={{ ...cell, textAlign: 'right', fontWeight: 700, whiteSpace: 'nowrap' }}>
                            {Number(e.amount) > 0 ? `฿${Number(e.amount).toLocaleString('en-US')}` : 'ฟรี'}
                          </td>
                          <td style={{ ...cell, whiteSpace: 'nowrap' }} className="form-hint">
                            {fmtDate(e.enrolledAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {tab === 'attempts' && (
            <>
              {attempts === null && !failed && <div className="loader"></div>}
              {attempts && filteredAttempts.length === 0 && (
                <div className="empty-state">
                  <div className="empty-title">ยังไม่มีผู้ทำแบบทดสอบ</div>
                  <div className="empty-sub">เมื่อมีนักเรียนทำแบบทดสอบ ผลคะแนนจะแสดงที่นี่</div>
                </div>
              )}
              {attempts && filteredAttempts.length > 0 && (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
                    <thead>
                      <tr>
                        <th style={headCell}>นักเรียน</th>
                        <th style={headCell}>แบบทดสอบ</th>
                        <th style={{ ...headCell, textAlign: 'right' }}>คะแนน</th>
                        <th style={{ ...headCell, textAlign: 'center' }}>ผล</th>
                        <th style={headCell}>วันที่ทำ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredAttempts.map((a) => {
                        const pct = a.maxScore > 0 ? Math.round((a.score / a.maxScore) * 100) : 0;
                        return (
                          <tr key={a.id}>
                            <td style={cell}>
                              <div style={{ fontWeight: 600 }}>
                                {a.studentNickname || a.studentName || a.studentId}
                                {accountBadge(a.accountType)}
                              </div>
                              <div className="form-hint">{a.studentId}</div>
                            </td>
                            <td style={cell}>{a.quizTitleTh || a.quizTitle}</td>
                            <td style={{ ...cell, textAlign: 'right', fontWeight: 700, whiteSpace: 'nowrap' }}>
                              {a.score}/{a.maxScore} ({pct}%)
                            </td>
                            <td style={{ ...cell, textAlign: 'center' }}>
                              <span style={{ fontWeight: 700, color: a.passed ? '#16a34a' : '#dc2626' }}>
                                {a.passed ? 'ผ่าน' : 'ไม่ผ่าน'}
                              </span>
                            </td>
                            <td style={{ ...cell, whiteSpace: 'nowrap' }} className="form-hint">
                              {fmtDate(a.submittedAt)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
