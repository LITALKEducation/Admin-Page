import { useCallback, useEffect, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import QRCode from 'qrcode';
import { useStudents } from '../hooks/useStudents';
import { useMe } from '../hooks/useMe';
import { useToast } from '../ui/ToastContext';
import { useConfirm, usePrompt } from '../ui/ConfirmContext';
import StudentPicker from '../ui/StudentPicker';
import { formatClassTimeLocal } from '../utils/format';
import {
  makeTokenGetter,
  createBooking,
  fetchBookings,
  updateBookingLink,
  cancelBookingApi,
  mintCheckinToken,
  type BookingRow,
} from '../api/client';

const SLOTS = ['09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00'];
const STEP_LABELS = [
  { n: 1, label: 'เลือกนักเรียน' },
  { n: 2, label: 'เลือกวันเวลา' },
  { n: 3, label: 'ยืนยัน' },
];

function formatCheckinTime(dt: string): string {
  const d = new Date(dt.replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? '' : d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
}

export default function BookingScreen() {
  const { getAccessTokenSilently } = useAuth0();
  const { students, failed: studentsFailed } = useStudents();
  const { isAdmin, me } = useMe();
  const showToast = useToast();
  const confirmDialog = useConfirm();
  const promptDialog = usePrompt();

  const [studentId, setStudentId] = useState('');
  const [step, setStep] = useState(1);
  const [date, setDate] = useState('');
  const [slot, setSlot] = useState<string | null>(null);

  const [bookings, setBookings] = useState<BookingRow[] | null>(null);
  const [qr, setQr] = useState<{ url: string; dataUrl: string; expiresAt: string } | null>(null);

  const student = students.find((s) => s.id === studentId) || null;
  const minDate = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  const loadBookings = useCallback(async () => {
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      setBookings(await fetchBookings(getToken));
    } catch (error) {
      console.error('loadBookingTable:', error);
      setBookings(null);
    }
  }, [getAccessTokenSilently]);

  useEffect(() => {
    loadBookings();
  }, [loadBookings]);

  const reset = () => {
    setStep(1);
    setDate('');
    setSlot(null);
    setStudentId('');
  };

  const submit = async () => {
    if (!student || !date || !slot) return;
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      const result = await createBooking(getToken, {
        studentId: student.id,
        studentName: student.name,
        bookingDate: date,
        bookingTime: slot,
        notes: '',
      });
      showToast('จองเวลาเรียนสำเร็จ', result.message, 'success');
      reset();
      loadBookings();
    } catch (error) {
      showToast('ไม่สามารถดำเนินการได้', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const editLink = async (b: BookingRow) => {
    const url = await promptDialog('วางลิงก์ห้องเรียนออนไลน์ (Google Meet, Zoom, Teams ฯลฯ) — เว้นว่างเพื่อลบลิงก์', {
      title: 'ลิงก์ห้องเรียน',
      defaultValue: b.meetLink || '',
      placeholder: 'https://meet.google.com/... หรือ https://zoom.us/...',
      okLabel: 'บันทึก',
    });
    if (url === null) return;
    const trimmed = url.trim();
    if (trimmed && !/^https?:\/\/\S+$/i.test(trimmed)) {
      showToast('ลิงก์ไม่ถูกต้อง', 'ลิงก์ต้องขึ้นต้นด้วย http:// หรือ https://', 'error');
      return;
    }
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      const result = await updateBookingLink(getToken, b.id, trimmed);
      showToast('บันทึกแล้ว', result.message || 'บันทึกลิงก์เรียนแล้ว', 'success');
      loadBookings();
    } catch (error) {
      showToast('บันทึกไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const cancelBooking = async (b: BookingRow) => {
    if (
      !(await confirmDialog(`ยกเลิกคลาสของ ${b.studentName || 'นักเรียน'} ใช่หรือไม่? คลาสจะถูกนำออกจากตารางของนักเรียนและปฏิทิน`, {
        danger: true,
        okLabel: 'ยกเลิกคลาส',
      }))
    )
      return;
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      const result = await cancelBookingApi(getToken, b.id);
      showToast('ยกเลิกแล้ว', result.message || 'ยกเลิกคลาสเรียบร้อยแล้ว', 'success');
      loadBookings();
    } catch (error) {
      showToast('ยกเลิกล้มเหลว', error instanceof Error ? error.message : 'ไม่สามารถยกเลิกคลาสได้', 'error');
    }
  };

  const openCheckinQr = async (b: BookingRow) => {
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      const result = await mintCheckinToken(getToken, b.id);
      const dataUrl = await QRCode.toDataURL(result.url, { width: 240, margin: 1 });
      setQr({ url: result.url, dataUrl, expiresAt: result.expiresAt });
    } catch (error) {
      showToast('เปิด QR เช็คชื่อไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const closeCheckinQr = () => {
    setQr(null);
    loadBookings();
  };

  const myEmail = (me?.email || '').toLowerCase();

  return (
    <div id="screen-booking" className="tab-content active">
      <div className="booking-wrap">
        <div className="screen-header">
          <h1>จองเวลาเรียน</h1>
          <p>จองคลาสให้นักเรียนทีละขั้นตอน</p>
        </div>

        <div className="step-indicator">
          {STEP_LABELS.map((d) => (
            <div className="step-item" key={d.n}>
              <span className={`step-circle${step >= d.n ? ' active' : ''}`}>
                {step > d.n ? <i className="fas fa-check" style={{ fontSize: 10 }}></i> : d.n}
              </span>
              <span className={`step-label${step === d.n ? ' active' : ''}`}>{d.label}</span>
              {d.n < 3 && <span className="step-line"></span>}
            </div>
          ))}
        </div>

        {step === 1 && (
          <div className="admin-card">
            <div className="card-title-bar">
              <span className="card-icon">
                <i className="fas fa-user"></i>
              </span>
              <div>
                <h3>เลือกนักเรียน</h3>
                <p>ค้นหาด้วยชื่อหรือรหัสนักเรียน</p>
              </div>
            </div>
            <div className="form-body">
              <StudentPicker students={students} loadFailed={studentsFailed} value={studentId} onChange={setStudentId} />
              {student ? (
                <div className="student-indicator selected">
                  <i className="fas fa-user-check"></i>{' '}
                  <span>
                    เลือกแล้ว: <strong>{student.name}</strong>
                  </span>
                </div>
              ) : (
                <div className="student-indicator empty">
                  <i className="fas fa-info-circle"></i> <span>กรุณาเลือกนักเรียนก่อนไปขั้นตอนถัดไป</span>
                </div>
              )}
              <div className="wizard-footer end">
                <button className="btn btn-primary" disabled={!student} onClick={() => setStep(2)}>
                  ถัดไป <i className="fas fa-arrow-right"></i>
                </button>
              </div>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="admin-card">
            <div className="card-title-bar">
              <span className="card-icon">
                <i className="fas fa-calendar-day"></i>
              </span>
              <div>
                <h3>เลือกวันและเวลา</h3>
                <p>ระบบจะตรวจสอบคิวว่างอีกครั้งเมื่อกดยืนยัน</p>
              </div>
            </div>
            <div className="form-body">
              <div className="form-group">
                <label>
                  <i className="fas fa-calendar-day"></i> วันที่เรียน
                </label>
                <input type="date" min={minDate} value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
              <div className="form-group">
                <label>
                  <i className="fas fa-clock"></i> ช่วงเวลาเรียน
                </label>
                <div className="slot-grid">
                  {SLOTS.map((t) => {
                    const h = Number(t.split(':')[0]);
                    const end = String(h + 1).padStart(2, '0') + ':00';
                    return (
                      <button
                        key={t}
                        className={`slot-btn${slot === t ? ' selected' : ''}`}
                        onClick={() => setSlot(t)}
                      >
                        {t} - {end}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="wizard-footer">
                <button className="btn btn-secondary" onClick={() => setStep(1)}>
                  <i className="fas fa-arrow-left"></i> ย้อนกลับ
                </button>
                <button className="btn btn-primary" disabled={!date || !slot} onClick={() => setStep(3)}>
                  ถัดไป <i className="fas fa-arrow-right"></i>
                </button>
              </div>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="admin-card">
            <div className="card-title-bar">
              <span className="card-icon">
                <i className="fas fa-check-circle"></i>
              </span>
              <div>
                <h3>ยืนยันการจอง</h3>
                <p>ตรวจสอบข้อมูลก่อนกดยืนยัน</p>
              </div>
            </div>
            <div className="form-body">
              <div className="summary-list">
                {[
                  { icon: 'fas fa-user', label: 'นักเรียน', value: student?.name || '-' },
                  {
                    icon: 'fas fa-calendar-day',
                    label: 'วันที่เรียน',
                    value: date
                      ? new Date(date + 'T00:00:00').toLocaleDateString('th-TH', {
                          weekday: 'long',
                          day: 'numeric',
                          month: 'long',
                          year: 'numeric',
                        })
                      : '-',
                  },
                  {
                    icon: 'fas fa-clock',
                    label: 'เวลา',
                    value: slot ? `${slot} - ${String(Number(slot.split(':')[0]) + 1).padStart(2, '0')}:00 น.` : '-',
                  },
                ].map((r) => (
                  <div className="summary-row" key={r.label}>
                    <span className="label">
                      <i className={r.icon}></i>
                      {r.label}
                    </span>
                    <span className="value">{r.value}</span>
                  </div>
                ))}
              </div>
              <div className="wizard-footer">
                <button className="btn btn-secondary" onClick={() => setStep(2)}>
                  <i className="fas fa-arrow-left"></i> ย้อนกลับ
                </button>
                <button className="btn btn-primary" onClick={submit}>
                  <i className="fas fa-calendar-check"></i> ยืนยันการจอง
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="admin-card" style={{ marginTop: 24 }}>
          <div className="card-title-bar">
            <span className="card-icon">
              <i className="fas fa-table-list"></i>
            </span>
            <div>
              <h3>ตารางการจองที่กำลังจะถึง</h3>
              <p>รายการวันและเวลาที่จองเรียนไว้</p>
            </div>
          </div>
          <div className="table-scroll">
            {bookings === null ? (
              <div className="form-hint">โหลดตารางการจองไม่สำเร็จ</div>
            ) : !bookings.length ? (
              <div className="form-hint">ยังไม่มีการจองเวลาเรียนที่กำลังจะถึง</div>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>วันที่</th>
                    <th>เวลา (ตามอุปกรณ์ของคุณ)</th>
                    <th>นักเรียน</th>
                    <th>คอร์ส</th>
                    <th>ลิงก์เรียน</th>
                    <th>เช็คชื่อ</th>
                    <th>จัดการ</th>
                  </tr>
                </thead>
                <tbody>
                  {bookings.map((b) => {
                    const canManage = isAdmin || (!!b.createdBy && b.createdBy.toLowerCase() === myEmail);
                    return (
                      <tr key={b.id}>
                        <td>
                          {new Date(b.date + 'T00:00:00').toLocaleDateString('th-TH', {
                            weekday: 'short',
                            day: 'numeric',
                            month: 'short',
                          })}
                        </td>
                        <td>{formatClassTimeLocal(b.date, b.time)}</td>
                        <td>{b.studentName}</td>
                        <td>{b.course || '-'}</td>
                        <td>
                          {b.meetLink ? (
                            <a href={b.meetLink} target="_blank" rel="noopener" className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }}>
                              <i className="fas fa-video"></i> เข้าร่วม
                            </a>
                          ) : (
                            <span className="form-hint" style={{ margin: 0 }}>
                              -
                            </span>
                          )}
                        </td>
                        <td>
                          {b.checkedInAt ? (
                            <span className="checkin-badge">
                              <i className="fas fa-circle-check"></i> {formatCheckinTime(b.checkedInAt)}
                            </span>
                          ) : (
                            <button className="icon-btn" title="เปิด QR ให้นักเรียนสแกนเช็คชื่อ" onClick={() => openCheckinQr(b)}>
                              <i className="fas fa-qrcode"></i> QR
                            </button>
                          )}
                        </td>
                        <td>
                          <span className="row-actions">
                            {canManage ? (
                              <>
                                <button className="icon-btn" title={b.meetLink ? 'แก้ลิงก์เรียน' : 'เพิ่มลิงก์ Google Meet / Zoom'} onClick={() => editLink(b)}>
                                  <i className="fas fa-link"></i>
                                </button>
                                <button className="icon-btn icon-btn-danger" title="ยกเลิกคลาส" onClick={() => cancelBooking(b)}>
                                  <i className="fas fa-trash"></i>
                                </button>
                              </>
                            ) : (
                              <span className="form-hint" title="แก้ไขได้เฉพาะผู้ที่สร้างรายการ หรือแอดมิน" style={{ margin: 0 }}>
                                <i className="fas fa-lock"></i>
                              </span>
                            )}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {qr && (
        <div className="modal-overlay active">
          <div className="modal-box">
            <h3 className="modal-title">QR เช็คชื่อ</h3>
            <img src={qr.dataUrl} alt="QR check-in" style={{ display: 'block', margin: '0 auto' }} />
            <div className="form-hint" style={{ textAlign: 'center', marginBottom: 12 }}>
              ใช้ได้ถึง {new Date(qr.expiresAt).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })} น. —
              เปิดใหม่เพื่อออก QR ใหม่ (อันเก่าจะใช้ไม่ได้ทันที)
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => navigator.clipboard.writeText(qr.url)}>
                <i className="fas fa-copy"></i> คัดลอกลิงก์
              </button>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={closeCheckinQr}>
                ปิด
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
