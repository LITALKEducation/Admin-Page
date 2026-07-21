import { useCallback, useEffect, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { useStudents } from '../hooks/useStudents';
import { useSharedStudentSelection } from '../hooks/useSharedStudentSelection';
import { useToast } from '../ui/ToastContext';
import StudentPicker, { StudentIndicator } from '../ui/StudentPicker';
import { makeTokenGetter, fetchStudentCredits, adjustStudentCredit, type CreditEntry } from '../api/client';

export default function CreditsScreen() {
  const { getAccessTokenSilently } = useAuth0();
  const { students, failed: studentsFailed } = useStudents();
  const [selectedId, setSelectedId] = useSharedStudentSelection();
  const showToast = useToast();

  const [balance, setBalance] = useState(0);
  const [entries, setEntries] = useState<CreditEntry[] | null>(null);
  const [hours, setHours] = useState('');
  const [reason, setReason] = useState('');

  const selected = students.find((s) => s.id === selectedId) || null;

  const load = useCallback(async () => {
    if (!selectedId) {
      setBalance(0);
      setEntries(null);
      return;
    }
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      const result = await fetchStudentCredits(getToken, selectedId);
      setBalance(result.balance || 0);
      setEntries(result.entries || []);
    } catch (error) {
      console.error('loadStudentCredits:', error);
      setEntries(null);
    }
  }, [getAccessTokenSilently, selectedId]);

  useEffect(() => {
    load();
  }, [load]);

  const submit = async () => {
    if (!selectedId) {
      showToast('กรุณาเลือกนักเรียนจากรายชื่อด้านบน', undefined, 'error');
      return;
    }
    const hoursNum = Number(hours);
    if (!hoursNum) {
      showToast('กรุณากรอกจำนวนชั่วโมงที่ไม่เป็นศูนย์', undefined, 'error');
      return;
    }
    if (!reason.trim()) {
      showToast('กรุณาระบุเหตุผลการปรับเครดิต', undefined, 'error');
      return;
    }
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      const result = await adjustStudentCredit(getToken, selectedId, hoursNum, reason.trim());
      showToast('ปรับเครดิตสำเร็จ', result.message, 'success');
      setHours('');
      setReason('');
      load();
    } catch (error) {
      showToast('ปรับเครดิตไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  return (
    <div id="screen-credits" className="tab-content active">
      <div className="screen-header">
        <h1>แก้ไขเครดิต</h1>
        <p>ปรับยอดเครดิตชั่วโมงเรียนของนักเรียนโดยตรง (สำหรับแอดมินเท่านั้น) — ใช้สำหรับชดเชยชั่วโมง แก้ไขข้อผิดพลาด หรือกรณีพิเศษอื่น ๆ</p>
      </div>

      <div className="sticky-picker">
        <StudentPicker students={students} loadFailed={studentsFailed} value={selectedId} onChange={setSelectedId} />
        <StudentIndicator student={selected} verb="กำลังบันทึกให้" />
      </div>

      <div className={`form-cards-wrapper${selectedId ? '' : ' disabled'}`}>
        <div className="admin-card">
          <div className="card-title-bar">
            <span className="card-icon">
              <i className="fas fa-coins"></i>
            </span>
            <div>
              <h3>ยอดเครดิตปัจจุบัน</h3>
              <p>รวมจากประวัติทุกรายการ (ตารางเรียน คำร้อง และการปรับด้วยมือ)</p>
            </div>
          </div>
          <div className="stat-card" style={{ maxWidth: 220 }}>
            <div className="stat-card-top">
              <span className="stat-card-label">เครดิตคงเหลือ</span>
              <i className="fas fa-piggy-bank"></i>
            </div>
            <div className="stat-card-value">{balance}</div>
            <div className="stat-card-sub">ชั่วโมง</div>
          </div>
        </div>

        <div className="admin-card">
          <div className="card-title-bar">
            <span className="card-icon">
              <i className="fas fa-sliders"></i>
            </span>
            <div>
              <h3>ปรับเครดิต</h3>
              <p>ใส่จำนวนติดลบเพื่อหักเครดิต หรือบวกเพื่อเพิ่มเครดิต</p>
            </div>
          </div>
          <div className="form-body">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 16 }}>
              <div className="form-group">
                <label>
                  <i className="fas fa-clock"></i> จำนวนชั่วโมง
                </label>
                <input type="number" placeholder="เช่น 2 หรือ -1" step={0.5} inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} />
                <div className="form-hint">บวก = เพิ่มเครดิต · ลบ = หักเครดิต</div>
              </div>
              <div className="form-group">
                <label>
                  <i className="fas fa-sticky-note"></i> เหตุผล
                </label>
                <input
                  type="text"
                  placeholder="เช่น ชดเชยคลาสที่ครูยกเลิกกะทันหัน"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn btn-primary" onClick={submit}>
                <i className="fas fa-save"></i> บันทึกการปรับเครดิต
              </button>
            </div>
          </div>
        </div>

        <div className="admin-card">
          <div className="card-title-bar">
            <span className="card-icon">
              <i className="fas fa-clock-rotate-left"></i>
            </span>
            <div>
              <h3>ประวัติเครดิต</h3>
              <p>รายการล่าสุด 50 รายการ</p>
            </div>
          </div>
          <div className="row-list">
            {!selectedId ? (
              <div className="form-hint">กรุณาเลือกนักเรียนเพื่อดูประวัติ</div>
            ) : entries === null ? (
              <div className="form-hint">โหลดประวัติเครดิตไม่สำเร็จ</div>
            ) : !entries.length ? (
              <div className="form-hint">ยังไม่มีประวัติเครดิต</div>
            ) : (
              entries.map((e, i) => {
                const positive = e.hours > 0;
                return (
                  <div className="alert-row" key={i}>
                    <i
                      className={`fas ${positive ? 'fa-plus-circle' : 'fa-minus-circle'}`}
                      style={{ color: positive ? 'var(--accent-success)' : 'var(--accent-danger)' }}
                    ></i>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="alert-text">
                        <strong style={{ color: positive ? 'var(--accent-success)' : 'var(--accent-danger)' }}>
                          {positive ? '+' : ''}
                          {e.hours} ชม.
                        </strong>{' '}
                        — {e.reason || '-'}
                      </div>
                      <div className="alert-text" style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                        {new Date(e.createdAt).toLocaleString('th-TH')} · โดย {e.createdByName || e.createdBy || '-'}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
