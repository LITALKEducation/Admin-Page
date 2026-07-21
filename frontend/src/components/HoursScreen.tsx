import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { useMe } from '../hooks/useMe';
import { useToast } from '../ui/ToastContext';
import { useConfirm, usePrompt } from '../ui/ConfirmContext';
import { formatBaht, formatClassTimeLocal, formatShortThaiDate } from '../utils/format';
import { buildParentSummaryMessage } from '../utils/parentSummary';
import {
  makeTokenGetter,
  fetchSchedules,
  fetchAmendments,
  submitAmendmentApi,
  approveAmendmentApi,
  rejectAmendmentApi,
  cancelAmendmentApi,
  type ScheduleRow,
  type ScheduleSessionRow,
  type AmendmentRow,
} from '../api/client';

const SLOTS = ['09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00'];

const AMENDMENT_STATUS_LABEL: Record<string, string> = {
  pending: 'รออนุมัติ',
  awaiting_payment: 'รอชำระเงิน',
  applied: 'เรียบร้อยแล้ว',
  rejected: 'ถูกปฏิเสธ',
  cancelled: 'ยกเลิกแล้ว',
};

function statusColor(status: string): string {
  if (status === 'applied') return 'var(--accent-success)';
  if (status === 'rejected' || status === 'cancelled') return 'var(--accent-danger)';
  return 'var(--text-muted)';
}

async function copyText(text: string, showToast: (t: string, m?: string, ty?: 'success' | 'error' | 'info') => void) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('คัดลอกแล้ว', undefined, 'success');
  } catch {
    showToast('คัดลอกอัตโนมัติไม่สำเร็จ', text, 'error');
  }
}

export default function HoursScreen() {
  const { getAccessTokenSilently } = useAuth0();
  const { isAdmin, me } = useMe();
  const showToast = useToast();
  const confirmDialog = useConfirm();
  const promptDialog = usePrompt();

  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [amendments, setAmendments] = useState<AmendmentRow[] | null>(null);
  const [scheduleId, setScheduleId] = useState('');
  const [type, setType] = useState<'add' | 'remove'>('add');
  const [addSessions, setAddSessions] = useState<ScheduleSessionRow[]>([{ date: '', time: '09:00' }]);
  const [removeSet, setRemoveSet] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      const [sched, amend] = await Promise.all([fetchSchedules(getToken), fetchAmendments(getToken)]);
      setSchedules(sched);
      setAmendments(amend);
    } catch (error) {
      console.error('loadSchedules:', error);
      setAmendments(null);
    }
  }, [getAccessTokenSilently]);

  useEffect(() => {
    load();
  }, [load]);

  const eligible = useMemo(() => schedules.filter((r) => ['approved', 'active'].includes(r.status)), [schedules]);
  const selectedSchedule = schedules.find((r) => String(r.id) === scheduleId) || null;

  const monthMinMax = (() => {
    if (!selectedSchedule) return {};
    const [y, m] = selectedSchedule.month.split('-').map(Number);
    return { min: `${selectedSchedule.month}-01`, max: `${selectedSchedule.month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}` };
  })();

  const changeSchedule = (id: string) => {
    setScheduleId(id);
    setAddSessions([{ date: '', time: '09:00' }]);
    setRemoveSet(new Set());
  };

  const changeType = (t: 'add' | 'remove') => {
    setType(t);
    if (t === 'add' && !addSessions.length) setAddSessions([{ date: '', time: '09:00' }]);
  };

  const updateAddSession = (i: number, patch: Partial<ScheduleSessionRow>) => {
    setAddSessions(addSessions.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  };

  const toggleRemove = (date: string, time: string) => {
    const key = `${date}|${time}`;
    setRemoveSet((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const submit = async () => {
    if (!scheduleId) {
      showToast('กรุณาเลือกตารางเรียน', undefined, 'error');
      return;
    }
    let sessions: ScheduleSessionRow[];
    if (type === 'add') {
      sessions = addSessions.filter((s) => s.date && s.time);
      if (!sessions.length) {
        showToast('ยังไม่มีคาบเรียน', 'กรุณาเพิ่มคาบเรียนที่จะขอเพิ่มอย่างน้อย 1 คาบ', 'error');
        return;
      }
    } else {
      sessions = [...removeSet].map((key) => {
        const [date, time] = key.split('|');
        return { date, time };
      });
      if (!sessions.length) {
        showToast('ยังไม่ได้เลือกคาบเรียน', 'กรุณาเลือกคาบเรียนที่จะถอนอย่างน้อย 1 คาบ', 'error');
        return;
      }
    }
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      const result = await submitAmendmentApi(getToken, Number(scheduleId), { type, sessions, note });
      if (result.paymentUrl && selectedSchedule) {
        await copyText(
          buildParentSummaryMessage({
            studentName: selectedSchedule.studentName,
            month: selectedSchedule.month,
            course: selectedSchedule.course,
            note: note.trim(),
            sessions,
            amount: result.chargeAmount || 0,
            creditsApplied: result.creditsUsed,
            paymentUrl: result.paymentUrl,
            isExtra: true,
          }),
          () => {},
        );
        showToast('ส่งคำร้องสำเร็จ', `${result.message}\n\nคัดลอกข้อความสรุปพร้อมลิงก์ชำระเงินสำหรับส่งผู้ปกครองไว้ให้แล้ว`, 'success');
      } else {
        showToast('ส่งคำร้องสำเร็จ', result.message, 'success');
      }
      setAddSessions([{ date: '', time: '09:00' }]);
      setRemoveSet(new Set());
      setNote('');
      setScheduleId('');
      load();
    } catch (error) {
      showToast('ส่งคำร้องไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const approve = async (id: number, a: AmendmentRow) => {
    if (!(await confirmDialog('อนุมัติคำร้องนี้?', { title: 'อนุมัติคำร้อง', okLabel: 'อนุมัติ' }))) return;
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      const result = await approveAmendmentApi(getToken, id);
      if (result.paymentUrl) {
        await copyText(
          buildParentSummaryMessage({
            studentName: a.studentName,
            month: a.month,
            course: a.course,
            note: a.note,
            sessions: a.sessions,
            amount: result.chargeAmount || 0,
            creditsApplied: result.creditsUsed,
            paymentUrl: result.paymentUrl,
            isExtra: true,
          }),
          () => {},
        );
        showToast('อนุมัติแล้ว', `${result.message}\n\nคัดลอกข้อความสรุปพร้อมลิงก์ชำระเงินสำหรับส่งผู้ปกครองไว้ให้แล้ว`, 'success');
      } else {
        showToast('อนุมัติแล้ว', result.message, 'success');
      }
      load();
    } catch (error) {
      showToast('อนุมัติไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const reject = async (id: number) => {
    const reason = await promptDialog('เหตุผลที่ปฏิเสธ:', { title: 'ปฏิเสธคำร้อง' });
    if (reason === null) return;
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      const result = await rejectAmendmentApi(getToken, id, reason);
      showToast('ปฏิเสธแล้ว', result.message, 'success');
      load();
    } catch (error) {
      showToast('ปฏิเสธไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const cancel = async (id: number) => {
    if (!(await confirmDialog('ยกเลิกคำร้องนี้หรือไม่?', { title: 'ยกเลิกคำร้อง', danger: true, okLabel: 'ยกเลิกคำร้อง' }))) return;
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      await cancelAmendmentApi(getToken, id);
      load();
    } catch (error) {
      showToast('ยกเลิกไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const myEmail = (me?.email || '').toLowerCase();

  return (
    <div id="screen-hours" className="tab-content active">
      <div className="screen-header">
        <h1>ปรับชั่วโมงเรียน</h1>
        <p>ขอเพิ่มหรือถอนชั่วโมงเรียนจากตารางเรียนที่อนุมัติแล้ว — เพิ่มจะหักเครดิตก่อนแล้วจึงเก็บเงินส่วนที่เหลือ ถอนจะได้เครดิตคืนทันที</p>
      </div>

      <div className="admin-card">
        <div className="card-title-bar">
          <span className="card-icon">
            <i className="fas fa-arrows-up-down"></i>
          </span>
          <div>
            <h3>ขอเพิ่ม/ถอนชั่วโมงเรียน</h3>
            <p>ใช้กับตารางเรียนที่อนุมัติแล้วเท่านั้น</p>
          </div>
        </div>
        <div className="form-body">
          <div className="form-group">
            <label>
              <i className="fas fa-calendar-days"></i> ตารางเรียน
            </label>
            <div className="select-wrapper">
              <select value={scheduleId} onChange={(e) => changeSchedule(e.target.value)}>
                <option value="">-- เลือกตารางเรียนที่อนุมัติแล้ว --</option>
                {eligible.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.studentName} · เดือน {r.month} ({r.sessionCount} ครั้ง)
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="form-group">
            <label>
              <i className="fas fa-toggle-on"></i> ประเภทคำร้อง
            </label>
            <div className="t-tabs" role="tablist" style={{ display: 'inline-flex' }}>
              <button type="button" className={`t-tab${type === 'add' ? ' active' : ''}`} role="tab" onClick={() => changeType('add')}>
                เพิ่มชั่วโมง
              </button>
              <button type="button" className={`t-tab${type === 'remove' ? ' active' : ''}`} role="tab" onClick={() => changeType('remove')}>
                ถอนชั่วโมง
              </button>
            </div>
          </div>

          {type === 'add' ? (
            <div className="form-group">
              <label>
                <i className="fas fa-clock"></i> คาบเรียนที่จะเพิ่ม
              </label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {addSessions.map((s, i) => (
                  <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 120px 40px', gap: 8, alignItems: 'center' }}>
                    <input
                      type="date"
                      value={s.date}
                      min={monthMinMax.min}
                      max={monthMinMax.max}
                      onChange={(e) => updateAddSession(i, { date: e.target.value })}
                    />
                    <div className="select-wrapper">
                      <select value={s.time} onChange={(e) => updateAddSession(i, { time: e.target.value })}>
                        {SLOTS.map((t) => (
                          <option value={t} key={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </div>
                    <button
                      className="btn btn-danger"
                      style={{ padding: '8px 10px' }}
                      title="ลบแถวนี้"
                      onClick={() => setAddSessions(addSessions.filter((_, idx) => idx !== i))}
                    >
                      <i className="fas fa-trash"></i>
                    </button>
                  </div>
                ))}
              </div>
              <button className="btn btn-secondary" style={{ marginTop: 8 }} onClick={() => setAddSessions([...addSessions, { date: '', time: '09:00' }])}>
                <i className="fas fa-plus"></i> เพิ่มคาบเรียน
              </button>
            </div>
          ) : (
            <div className="form-group">
              <label>
                <i className="fas fa-clock"></i> เลือกคาบเรียนที่จะถอน
              </label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {!selectedSchedule?.sessions.length ? (
                  <div className="form-hint">เลือกตารางเรียนก่อน</div>
                ) : (
                  selectedSchedule.sessions.map((s, i) => (
                    <label key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-secondary)', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={removeSet.has(`${s.date}|${s.time}`)}
                        onChange={() => toggleRemove(s.date, s.time)}
                      />
                      {formatShortThaiDate(s.date)} {formatClassTimeLocal(s.date, s.time)}
                    </label>
                  ))
                )}
              </div>
            </div>
          )}

          <div className="form-group">
            <label>
              <i className="fas fa-sticky-note"></i> หมายเหตุ (ไม่บังคับ)
            </label>
            <input type="text" placeholder="เหตุผลของคำร้อง" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn btn-primary" onClick={submit}>
              <i className="fas fa-paper-plane"></i> ส่งคำร้อง
            </button>
          </div>
        </div>
      </div>

      <div className="admin-card" style={{ marginTop: 24 }}>
        <div className="card-title-bar">
          <span className="card-icon">
            <i className="fas fa-clipboard-list"></i>
          </span>
          <div>
            <h3>คำร้องเพิ่ม/ถอนชั่วโมงเรียน</h3>
            <p>รายการคำร้องล่าสุด (เวลาแสดงตามอุปกรณ์ของคุณ)</p>
          </div>
        </div>
        <div className="row-list">
          {amendments === null ? (
            <div className="form-hint">โหลดรายการคำร้องไม่สำเร็จ</div>
          ) : !amendments.length ? (
            <div className="form-hint">ยังไม่มีคำร้อง</div>
          ) : (
            amendments.map((r) => {
              const mine = (r.createdBy || '').toLowerCase() === myEmail;
              const sessionsText = (r.sessions || []).map((s) => `${formatShortThaiDate(s.date)} ${formatClassTimeLocal(s.date, s.time)}`).join(' · ');
              const typeLabel = r.type === 'add' ? 'ขอเพิ่ม' : 'ขอถอน';
              const amountNote =
                r.type === 'add'
                  ? r.chargeAmount > 0
                    ? ` · เก็บเพิ่ม ${formatBaht(r.chargeAmount)}`
                    : ' · ใช้เครดิตทั้งหมด'
                  : ` · ได้เครดิตคืน ${(r.sessions || []).length} ชม.`;
              return (
                <div className="alert-row" style={{ alignItems: 'flex-start' }} key={r.id}>
                  <i className="fas fa-arrows-up-down" style={{ color: statusColor(r.status), marginTop: 3 }}></i>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="alert-text">
                      <strong>{r.studentName}</strong> · {typeLabel}ชั่วโมงเดือน {r.month} ({(r.sessions || []).length} คาบ)
                      {amountNote}
                      <span style={{ color: statusColor(r.status) }}> — {AMENDMENT_STATUS_LABEL[r.status] || r.status}</span>
                    </div>
                    <div className="alert-text" style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                      {sessionsText}
                    </div>
                    {r.note && (
                      <div className="alert-text" style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                        หมายเหตุ: {r.note}
                      </div>
                    )}
                    {r.rejectReason && (
                      <div className="alert-text" style={{ color: 'var(--accent-danger)', fontSize: 12 }}>
                        เหตุผล: {r.rejectReason}
                      </div>
                    )}
                    <div className="alert-text" style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                      ส่งโดย {r.createdByName || r.createdBy || '-'}
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                      {isAdmin && r.status === 'pending' && (
                        <>
                          <button className="btn btn-success" style={{ padding: '6px 10px' }} onClick={() => approve(r.id, r)}>
                            <i className="fas fa-check"></i> อนุมัติ
                          </button>
                          <button className="btn btn-danger" style={{ padding: '6px 10px' }} onClick={() => reject(r.id)}>
                            <i className="fas fa-xmark"></i> ปฏิเสธ
                          </button>
                        </>
                      )}
                      {(isAdmin || mine) && ['pending', 'awaiting_payment'].includes(r.status) && (isAdmin || r.status === 'pending') && (
                        <button className="btn btn-secondary" style={{ padding: '6px 10px' }} onClick={() => cancel(r.id)}>
                          <i className="fas fa-ban"></i> ยกเลิก
                        </button>
                      )}
                      {r.paymentUrl && r.status === 'awaiting_payment' && (
                        <>
                          <button
                            className="btn btn-secondary"
                            style={{ padding: '6px 10px' }}
                            title="คัดลอกลิงก์ชำระเงิน"
                            onClick={() => copyText(r.paymentShortUrl || r.paymentUrl || '', showToast)}
                          >
                            <i className="fas fa-copy"></i> ลิงก์ชำระเงิน
                          </button>
                          <button
                            className="btn btn-secondary"
                            style={{ padding: '6px 10px' }}
                            title="คัดลอกข้อความสรุปชั่วโมงที่เพิ่มและค่าใช้จ่ายพร้อมลิงก์ชำระเงิน"
                            onClick={() =>
                              copyText(
                                buildParentSummaryMessage({
                                  studentName: r.studentName,
                                  month: r.month,
                                  course: r.course,
                                  note: r.note,
                                  sessions: r.sessions,
                                  amount: r.chargeAmount,
                                  creditsApplied: r.creditsUsed,
                                  paymentUrl: r.paymentShortUrl || r.paymentUrl,
                                  isExtra: true,
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
