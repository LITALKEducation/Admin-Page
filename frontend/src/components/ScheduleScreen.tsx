import { useCallback, useEffect, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { useStudents } from '../hooks/useStudents';
import { useMe } from '../hooks/useMe';
import { useSharedStudentSelection } from '../hooks/useSharedStudentSelection';
import { useToast } from '../ui/ToastContext';
import { useConfirm, usePrompt } from '../ui/ConfirmContext';
import StudentPicker, { StudentIndicator } from '../ui/StudentPicker';
import { formatBaht, formatClassTimeLocal, formatShortThaiDate } from '../utils/format';
import { buildParentSummaryMessage } from '../utils/parentSummary';
import {
  makeTokenGetter,
  fetchSchedules,
  createSchedule,
  updateSchedule,
  approveScheduleApi,
  rejectScheduleApi,
  reviseScheduleApi,
  cancelScheduleApi,
  type ScheduleRow,
  type ScheduleSessionRow,
} from '../api/client';

const SLOTS = ['09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00'];

const SCHEDULE_STATUS_LABEL: Record<string, string> = {
  pending: 'รออนุมัติ',
  approved: 'อนุมัติแล้ว - รอชำระเงิน',
  active: 'กำลังใช้งาน',
  rejected: 'ถูกปฏิเสธ',
  cancelled: 'ยกเลิกแล้ว',
  revise: 'ขอให้ปรับปรุง',
};

function statusColor(status: string): string {
  if (status === 'active') return 'var(--accent-success)';
  if (status === 'rejected' || status === 'cancelled' || status === 'revise') return 'var(--accent-danger)';
  return 'var(--text-muted)';
}

function monthRange(month: string): { min: string; max: string } | null {
  if (!/^\d{4}-\d{2}$/.test(month)) return null;
  const [y, m] = month.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  return { min: `${month}-01`, max: `${month}-${String(lastDay).padStart(2, '0')}` };
}

async function copyText(text: string, showToast: (t: string, m?: string, ty?: 'success' | 'error' | 'info') => void) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('คัดลอกแล้ว', undefined, 'success');
  } catch {
    showToast('คัดลอกอัตโนมัติไม่สำเร็จ', text, 'error');
  }
}

export default function ScheduleScreen() {
  const { getAccessTokenSilently } = useAuth0();
  const { students, failed: studentsFailed } = useStudents();
  const [selectedId, setSelectedId] = useSharedStudentSelection();
  const { isAdmin, me } = useMe();
  const showToast = useToast();
  const confirmDialog = useConfirm();
  const promptDialog = usePrompt();

  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [rate, setRate] = useState('');
  const [note, setNote] = useState('');
  const [sessions, setSessions] = useState<ScheduleSessionRow[]>([{ date: '', time: '09:00' }]);
  const [editingId, setEditingId] = useState<number | null>(null);

  const [schedules, setSchedules] = useState<ScheduleRow[] | null>(null);

  const selected = students.find((s) => s.id === selectedId) || null;
  const range = monthRange(month);

  const load = useCallback(async () => {
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      setSchedules(await fetchSchedules(getToken));
    } catch (error) {
      console.error('loadSchedules:', error);
      setSchedules(null);
    }
  }, [getAccessTokenSilently]);

  useEffect(() => {
    load();
  }, [load]);

  const addSession = () => {
    const lastTime = sessions.length ? sessions[sessions.length - 1].time : '09:00';
    setSessions([...sessions, { date: '', time: lastTime }]);
  };

  const copySession = (index: number) => {
    const src = sessions[index];
    if (!src) return;
    const next = [...sessions];
    next.splice(index + 1, 0, { date: '', time: src.time });
    setSessions(next);
  };

  const removeSession = (index: number) => {
    setSessions(sessions.filter((_, i) => i !== index));
  };

  const updateSession = (index: number, patch: Partial<ScheduleSessionRow>) => {
    setSessions(sessions.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  };

  const resetForm = () => {
    setEditingId(null);
    setSessions([{ date: '', time: '09:00' }]);
    setRate('');
    setNote('');
  };

  const editSchedule = (r: ScheduleRow) => {
    setEditingId(r.id);
    setSelectedId(r.studentId);
    setMonth(r.month);
    setRate(String(r.rate));
    setNote(r.note || '');
    setSessions(r.sessions?.length ? r.sessions.map((s) => ({ date: s.date, time: s.time })) : [{ date: '', time: '09:00' }]);
    document.getElementById('screen-schedule')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const rateNum = Number(rate) || 0;
  const validCount = sessions.filter((s) => s.date).length;

  const submit = async () => {
    if (!selectedId) {
      showToast('กรุณาเลือกนักเรียนจากรายชื่อด้านบน', undefined, 'error');
      return;
    }
    if (!range) {
      showToast('กรุณาเลือกเดือน', undefined, 'error');
      return;
    }
    if (!rateNum || rateNum <= 0) {
      showToast('กรุณากรอกราคาต่อคาบ', undefined, 'error');
      return;
    }
    const valid = sessions.filter((s) => s.date && s.time);
    if (!valid.length) {
      showToast('ยังไม่มีคาบเรียน', 'กรุณาเพิ่มคาบเรียนอย่างน้อย 1 คาบ และเลือกวันที่ให้ครบ', 'error');
      return;
    }
    if (valid.some((s) => !s.date.startsWith(month))) {
      showToast('วันที่ไม่ตรงเดือน', `ทุกคาบเรียนต้องอยู่ในเดือน ${month}`, 'error');
      return;
    }
    const payload = { studentId: selectedId, month, ratePerSession: rateNum, note, sessions: valid };
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      const result = editingId ? await updateSchedule(getToken, editingId, payload) : await createSchedule(getToken, payload);
      showToast(editingId ? 'บันทึกตารางเรียนสำเร็จ' : 'ส่งตารางเรียนสำเร็จ', result.message, 'success');
      resetForm();
      load();
    } catch (error) {
      showToast('ส่งตารางเรียนไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const approve = async (r: ScheduleRow) => {
    if (
      !(await confirmDialog(
        'อนุมัติตารางเรียนนี้? ระบบจะสร้างลิงก์ชำระเงินสำหรับส่งให้ผู้ปกครอง และตารางจะเริ่มทำงานทันทีเมื่อชำระสำเร็จ',
        { title: 'อนุมัติตารางเรียน', okLabel: 'อนุมัติ' },
      ))
    )
      return;
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      const result = await approveScheduleApi(getToken, r.id);
      if (result.paymentUrl) {
        await copyText(
          buildParentSummaryMessage({
            studentName: r.studentName,
            month: r.month,
            course: r.course,
            note: r.note,
            sessions: r.sessions,
            amount: r.total,
            creditsApplied: r.creditsApplied,
            paymentUrl: result.paymentUrl,
            isExtra: false,
          }),
          () => {},
        );
        showToast('อนุมัติแล้ว', `${result.message}\n\nคัดลอกข้อความสรุปการสอนพร้อมลิงก์ชำระเงินสำหรับส่งผู้ปกครองไว้ให้แล้ว`, 'success');
      } else {
        showToast('อนุมัติแล้ว', result.message, 'success');
      }
      load();
    } catch (error) {
      showToast('อนุมัติไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const reject = async (id: number) => {
    const reason = await promptDialog('เหตุผลที่ปฏิเสธ (ครูจะเห็นข้อความนี้):', { title: 'ปฏิเสธตารางเรียน' });
    if (reason === null) return;
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      const result = await rejectScheduleApi(getToken, id, reason);
      showToast('ปฏิเสธแล้ว', result.message, 'success');
      load();
    } catch (error) {
      showToast('ปฏิเสธไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const revise = async (id: number) => {
    const note = await promptDialog('ข้อความถึงครู (บอกว่าต้องปรับปรุงอะไร):', { title: 'ขอให้ปรับปรุงตารางเรียน' });
    if (note === null) return;
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      const result = await reviseScheduleApi(getToken, id, note);
      showToast('ส่งกลับให้ปรับปรุงแล้ว', result.message, 'success');
      load();
    } catch (error) {
      showToast('ทำรายการไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const cancel = async (id: number) => {
    if (!(await confirmDialog('ยกเลิกตารางเรียนนี้หรือไม่?', { title: 'ยกเลิกตารางเรียน', danger: true, okLabel: 'ยกเลิกตาราง' }))) return;
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      await cancelScheduleApi(getToken, id);
      load();
    } catch (error) {
      showToast('ยกเลิกไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const myEmail = (me?.email || '').toLowerCase();

  return (
    <div id="screen-schedule" className="tab-content active">
      <div className="screen-header">
        <h1>ตารางเรียนรายเดือน</h1>
        <p>วางแผนคาบเรียนของนักเรียนทั้งเดือนเพื่อคำนวณค่าเรียน ส่งให้แอดมินอนุมัติ และเริ่มทำงานอัตโนมัติเมื่อชำระเงินสำเร็จ</p>
      </div>

      <div className="sticky-picker">
        <StudentPicker students={students} loadFailed={studentsFailed} value={selectedId} onChange={setSelectedId} />
        <StudentIndicator student={selected} verb="กำลังบันทึกให้" />
      </div>

      <div className={`form-cards-wrapper${selectedId ? '' : ' disabled'}`}>
        <div className="admin-card">
          <div className="card-title-bar">
            <span className="card-icon">
              <i className="fas fa-calendar-plus"></i>
            </span>
            <div>
              <h3>สร้างตารางเรียนประจำเดือน</h3>
              <p>ระบบคำนวณค่าเรียนจากจำนวนคาบ × ราคาต่อคาบ แล้วส่งให้แอดมินอนุมัติ</p>
            </div>
          </div>
          <div className="form-body">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div className="form-group">
                <label>
                  <i className="fas fa-calendar"></i> เดือน
                </label>
                <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
              </div>
              <div className="form-group">
                <label>
                  <i className="fas fa-baht-sign"></i> ราคาต่อคาบ (บาท)
                </label>
                <input type="number" placeholder="0.00" min={1} inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
              </div>
            </div>
            <div className="form-group">
              <label>
                <i className="fas fa-clock"></i> คาบเรียนในเดือนนี้
              </label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {sessions.map((s, i) => (
                  <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 120px 40px 40px', gap: 8, alignItems: 'center' }}>
                    <input
                      type="date"
                      value={s.date}
                      min={range?.min}
                      max={range?.max}
                      onChange={(e) => updateSession(i, { date: e.target.value })}
                    />
                    <div className="select-wrapper">
                      <select value={s.time} onChange={(e) => updateSession(i, { time: e.target.value })}>
                        {SLOTS.map((t) => (
                          <option value={t} key={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </div>
                    <button className="btn btn-secondary" style={{ padding: '8px 10px' }} title="คัดลอกเวลานี้เป็นคาบใหม่" onClick={() => copySession(i)}>
                      <i className="fas fa-copy"></i>
                    </button>
                    <button className="btn btn-danger" style={{ padding: '8px 10px' }} title="ลบคาบนี้" onClick={() => removeSession(i)}>
                      <i className="fas fa-trash"></i>
                    </button>
                  </div>
                ))}
              </div>
              <button className="btn btn-secondary" style={{ marginTop: 8 }} onClick={addSession}>
                <i className="fas fa-plus"></i> เพิ่มคาบเรียน
              </button>
            </div>
            <div className="form-group">
              <label>
                <i className="fas fa-sticky-note"></i> หมายเหตุถึงแอดมิน (ไม่บังคับ)
              </label>
              <input type="text" placeholder="เช่น ขอเลื่อนได้ถ้าติดสอบ" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <div className="info-notice">
              <i className="fas fa-calculator"></i>
              <div>
                <strong>ยอดรวมค่าเรียน:</strong> {formatBaht(rateNum * validCount)} ({validCount} ครั้ง × {formatBaht(rateNum)})
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              {editingId && (
                <button className="btn btn-secondary" onClick={resetForm}>
                  <i className="fas fa-xmark"></i> ยกเลิกการแก้ไข
                </button>
              )}
              <button className="btn btn-primary" onClick={submit}>
                <i className="fas fa-paper-plane"></i> {editingId ? 'บันทึกและส่งอนุมัติอีกครั้ง' : 'ส่งให้แอดมินอนุมัติ'}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="admin-card" style={{ marginTop: 24 }}>
        <div className="card-title-bar">
          <span className="card-icon">
            <i className="fas fa-list-check"></i>
          </span>
          <div>
            <h3>รายการตารางเรียน</h3>
            <p>สถานะ: รออนุมัติ → อนุมัติแล้ว (รอชำระเงิน) → กำลังใช้งาน (เวลาแสดงตามอุปกรณ์ของคุณ)</p>
          </div>
        </div>
        <div className="row-list">
          {schedules === null ? (
            <div className="form-hint">โหลดรายการตารางเรียนไม่สำเร็จ</div>
          ) : !schedules.length ? (
            <div className="form-hint">ยังไม่มีตารางเรียนรายเดือน</div>
          ) : (
            schedules.map((r) => {
              const mine = (r.createdBy || '').toLowerCase() === myEmail;
              const sessionsText = (r.sessions || []).map((s) => `${formatShortThaiDate(s.date)} ${formatClassTimeLocal(s.date, s.time)}`).join(' · ');
              return (
                <div className="alert-row" style={{ alignItems: 'flex-start' }} key={r.id}>
                  <i className="fas fa-calendar-days" style={{ color: statusColor(r.status), marginTop: 3 }}></i>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="alert-text">
                      <strong>{r.studentName}</strong> · เดือน {r.month} · {r.sessionCount} ครั้ง × {formatBaht(r.rate)} = <strong>{formatBaht(r.total)}</strong>
                      {!!r.creditsApplied && r.creditsApplied > 0 && (
                        <span style={{ color: 'var(--accent-success)' }}> (ใช้เครดิต {r.creditsApplied} ชม.)</span>
                      )}
                      <span style={{ color: statusColor(r.status) }}> — {SCHEDULE_STATUS_LABEL[r.status] || r.status}</span>
                    </div>
                    <div className="alert-text" style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                      {sessionsText}
                    </div>
                    {r.note && (
                      <div className="alert-text" style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                        หมายเหตุ: {r.note}
                      </div>
                    )}
                    {r.reviseNote && (
                      <div className="alert-text" style={{ color: 'var(--accent-danger)', fontSize: 12 }}>
                        แอดมินขอให้ปรับปรุง: {r.reviseNote}
                      </div>
                    )}
                    {r.rejectReason && (
                      <div className="alert-text" style={{ color: 'var(--accent-danger)', fontSize: 12 }}>
                        เหตุผลที่ปฏิเสธ: {r.rejectReason}
                      </div>
                    )}
                    <div className="alert-text" style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                      ส่งโดย {r.createdByName || r.createdBy || '-'}
                      {r.approvedBy ? ` · ตรวจโดย ${r.approvedBy}` : ''}
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                      {isAdmin && r.status === 'pending' && (
                        <>
                          <button className="btn btn-success" style={{ padding: '6px 10px' }} onClick={() => approve(r)}>
                            <i className="fas fa-check"></i> อนุมัติ
                          </button>
                          <button className="btn btn-secondary" style={{ padding: '6px 10px' }} onClick={() => revise(r.id)}>
                            <i className="fas fa-rotate-left"></i> ขอให้ปรับปรุง
                          </button>
                          <button className="btn btn-danger" style={{ padding: '6px 10px' }} onClick={() => reject(r.id)}>
                            <i className="fas fa-xmark"></i> ปฏิเสธ
                          </button>
                        </>
                      )}
                      {(isAdmin || mine) && ['pending', 'rejected', 'revise'].includes(r.status) && (
                        <button className="btn btn-secondary" style={{ padding: '6px 10px' }} onClick={() => editSchedule(r)}>
                          <i className="fas fa-pen"></i> แก้ไข/ส่งใหม่
                        </button>
                      )}
                      {isAdmin && ['approved', 'active'].includes(r.status) && (
                        <button className="btn btn-secondary" style={{ padding: '6px 10px' }} onClick={() => editSchedule(r)}>
                          <i className="fas fa-pen"></i> แก้ไขตาราง
                        </button>
                      )}
                      {(isAdmin || mine) && ['pending', 'rejected', 'revise'].includes(r.status) && (
                        <button className="btn btn-secondary" style={{ padding: '6px 10px' }} onClick={() => cancel(r.id)}>
                          <i className="fas fa-ban"></i> ยกเลิก
                        </button>
                      )}
                      {isAdmin && r.status === 'approved' && (
                        <button className="btn btn-secondary" style={{ padding: '6px 10px' }} onClick={() => cancel(r.id)}>
                          <i className="fas fa-ban"></i> ยกเลิก
                        </button>
                      )}
                      {r.paymentUrl && r.status === 'approved' && (
                        <>
                          <button
                            className="btn btn-secondary"
                            style={{ padding: '6px 10px' }}
                            title="คัดลอกลิงก์ชำระเงินสำหรับผู้ปกครอง"
                            onClick={() => copyText(r.paymentShortUrl || r.paymentUrl || '', showToast)}
                          >
                            <i className="fas fa-copy"></i> ลิงก์ชำระเงิน
                          </button>
                          <button
                            className="btn btn-secondary"
                            style={{ padding: '6px 10px' }}
                            title="คัดลอกข้อความสรุปการสอนและค่าใช้จ่ายพร้อมลิงก์ชำระเงิน"
                            onClick={() =>
                              copyText(
                                buildParentSummaryMessage({
                                  studentName: r.studentName,
                                  month: r.month,
                                  course: r.course,
                                  note: r.note,
                                  sessions: r.sessions,
                                  amount: r.total,
                                  creditsApplied: r.creditsApplied,
                                  paymentUrl: r.paymentShortUrl || r.paymentUrl,
                                  isExtra: false,
                                }),
                                showToast,
                              )
                            }
                          >
                            <i className="fas fa-file-lines"></i> ข้อความแจ้งผู้ปกครอง
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
