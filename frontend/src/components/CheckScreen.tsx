import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { useNavigate } from 'react-router-dom';
import { useStudents } from '../hooks/useStudents';
import { useMe } from '../hooks/useMe';
import { useSharedStudentSelection } from '../hooks/useSharedStudentSelection';
import { useEditingLog } from '../hooks/useEditingLog';
import { useToast } from '../ui/ToastContext';
import { useConfirm, usePrompt } from '../ui/ConfirmContext';
import StudentPicker from '../ui/StudentPicker';
import AvatarImage from '../ui/AvatarImage';
import { formatBaht, formatClassTimeLocal, formatShortThaiDate } from '../utils/format';
import { appLink } from '../utils/deepLink';
import { COURSES } from '../utils/courses';
import {
  makeTokenGetter,
  fetchStudentCheck,
  updatePayment,
  updateStudent,
  deleteStudent,
  fetchStudentFiles,
  uploadStudentFile,
  fetchPublicFileLink,
  uploadStudentAvatar,
  apiFetchBlob,
  downloadBlob,
  type StudentCheckResponse,
  type StudentFile,
} from '../api/client';

const SCHEDULE_STATUS_LABEL: Record<string, string> = {
  pending: 'รออนุมัติ',
  approved: 'อนุมัติแล้ว - รอชำระเงิน',
  active: 'กำลังใช้งาน',
  rejected: 'ถูกปฏิเสธ',
  cancelled: 'ยกเลิกแล้ว',
  revise: 'ขอให้ปรับปรุง',
};

type Tab = 'overview' | 'classes' | 'files' | 'logs';

function generateClientPassword(): string {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghjkmnpqrstuvwxyz', '23456789', '!@#$%'];
  const all = sets.join('');
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const chars = sets.map((s, i) => s[bytes[i] % s.length]);
  for (let i = sets.length; i < bytes.length; i++) chars.push(all[bytes[i] % all.length]);
  return chars.sort(() => Math.random() - 0.5).join('');
}

export default function CheckScreen() {
  const { getAccessTokenSilently } = useAuth0();
  const { students, failed: studentsFailed, reload: reloadStudents } = useStudents();
  const { isAdmin } = useMe();
  const [selectedId, setSelectedId] = useSharedStudentSelection();
  const [, setEditingLog] = useEditingLog();
  const showToast = useToast();
  const confirmDialog = useConfirm();
  const promptDialog = usePrompt();
  const navigate = useNavigate();

  const [tab, setTab] = useState<Tab>('overview');
  const [data, setData] = useState<StudentCheckResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({
    name: '',
    nickname: '',
    email: '',
    phone: '',
    course: '',
    username: '',
    password: '',
  });
  const [files, setFiles] = useState<StudentFile[]>([]);
  const [docType, setDocType] = useState('Homework');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [avatarVersion, setAvatarVersion] = useState(0);

  const load = useCallback(async () => {
    if (!selectedId) {
      setData(null);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      const result = await fetchStudentCheck(getToken, selectedId);
      setData(result);
      setEditing(false);
    } catch (error) {
      console.error('loadStudentCheck:', error);
      setData(null);
      setLoadError(error instanceof Error ? error.message : 'โหลดข้อมูลนักเรียนไม่สำเร็จ');
    }
    setLoading(false);
  }, [getAccessTokenSilently, selectedId]);

  const loadFiles = useCallback(async () => {
    if (!selectedId) {
      setFiles([]);
      return;
    }
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      setFiles(await fetchStudentFiles(getToken, selectedId));
    } catch (error) {
      console.error('loadCheckFiles:', error);
      setFiles([]);
    }
  }, [getAccessTokenSilently, selectedId]);

  useEffect(() => {
    load();
    loadFiles();
  }, [load, loadFiles]);

  const openEdit = () => {
    if (!data) return;
    setEditForm({
      name: data.student.name || '',
      nickname: data.student.nickname || '',
      email: data.student.email || '',
      phone: data.student.phone || '',
      course: data.student.course || '',
      username: '',
      password: '',
    });
    setEditing(true);
  };

  const saveEdit = async () => {
    if (!selectedId) return;
    if (!editForm.name.trim()) {
      showToast('กรุณากรอกชื่อ', undefined, 'error');
      return;
    }
    const getToken = makeTokenGetter(getAccessTokenSilently);
    const payload = {
      name: editForm.name.trim(),
      nickname: editForm.nickname.trim(),
      email: editForm.email.trim(),
      phone: editForm.phone.trim(),
      course: editForm.course,
      ...(editForm.username.trim() ? { username: editForm.username.trim() } : {}),
      ...(editForm.password.trim() ? { password: editForm.password.trim() } : {}),
    };
    try {
      const result = await updateStudent(getToken, selectedId, payload);
      if (result.credentials?.password) {
        showToast(
          'บันทึกข้อมูลสำเร็จ',
          `${result.message}\n\nรหัสผ่านใหม่: ${result.credentials.password}\n(กรุณาคัดลอกไว้ — จะไม่แสดงอีก)`,
          'success',
          12000,
        );
      } else {
        showToast('บันทึกข้อมูลสำเร็จ', result.message, 'success');
      }
      setEditing(false);
      load();
      reloadStudents();
    } catch (error) {
      showToast('บันทึกข้อมูลไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const doDelete = async () => {
    if (!data) return;
    if (
      !(await confirmDialog(
        `ยืนยันการลบนักเรียน ${data.student.name} (${data.student.id}) ออกจากระบบ?\n\nประวัติการเรียนและการชำระเงินจะยังถูกเก็บไว้ และบัญชีเข้าสู่ระบบของนักเรียนจะไม่ถูกลบ`,
        { title: 'ลบนักเรียนออกจากระบบ', danger: true, okLabel: 'ลบนักเรียน' },
      ))
    )
      return;
    const getToken = makeTokenGetter(getAccessTokenSilently);
    const result = await deleteStudent(getToken, data.student.id);
    if (result.ok) {
      showToast('ลบนักเรียนสำเร็จ', undefined, 'success');
      setSelectedId('');
      reloadStudents();
    } else {
      showToast('ลบนักเรียนไม่สำเร็จ', result.error || 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const editPaymentAmount = async () => {
    if (!data?.payment.last) return;
    const input = await promptDialog('แก้ไขจำนวนเงิน (บาท):', {
      title: 'แก้ไขจำนวนเงิน',
      defaultValue: String(data.payment.last.amount || ''),
    });
    if (input === null) return;
    const amount = Number(input);
    if (!amount || amount <= 0) {
      showToast('จำนวนเงินไม่ถูกต้อง', 'กรุณากรอกจำนวนเงินให้ถูกต้อง', 'error');
      return;
    }
    const getToken = makeTokenGetter(getAccessTokenSilently);
    try {
      const result = await updatePayment(getToken, data.payment.last.id, amount);
      showToast('แก้ไขสำเร็จ', result.message, 'success');
      load();
    } catch (error) {
      showToast('แก้ไขไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const copyStudyLogLink = async () => {
    if (!selectedId) return;
    const url = appLink('logs', selectedId);
    try {
      await navigator.clipboard.writeText(url);
      showToast('คัดลอกลิงก์แล้ว', undefined, 'success');
    } catch {
      showToast('คัดลอกอัตโนมัติไม่สำเร็จ', url, 'error');
    }
  };

  const doUploadFile = async () => {
    const file = fileInputRef.current?.files?.[0];
    if (!selectedId) {
      showToast('กรุณาเลือกนักเรียนจากรายชื่อด้านบน', undefined, 'error');
      return;
    }
    if (!file) {
      showToast('กรุณาเลือกไฟล์', undefined, 'error');
      return;
    }
    try {
      await uploadStudentFile(makeTokenGetter(getAccessTokenSilently), selectedId, docType, file);
      if (fileInputRef.current) fileInputRef.current.value = '';
      showToast('อัปโหลดสำเร็จ', 'บันทึกไฟล์เรียบร้อยแล้ว', 'success');
      loadFiles();
    } catch (error) {
      showToast('อัปโหลดล้มเหลว', error instanceof Error ? error.message : 'เกิดข้อผิดพลาดในการอัปโหลดไฟล์', 'error');
    }
  };

  const doDownloadFile = async (f: StudentFile) => {
    try {
      const blob = await apiFetchBlob(makeTokenGetter(getAccessTokenSilently), `/files/${f.id}`);
      downloadBlob(blob, f.filename);
    } catch (error) {
      showToast('ดาวน์โหลดไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const doCopyPublicLink = async (f: StudentFile) => {
    try {
      const result = await fetchPublicFileLink(makeTokenGetter(getAccessTokenSilently), f.id);
      await navigator.clipboard.writeText(result.url).catch(() => {});
      showToast('คัดลอกลิงก์สาธารณะแล้ว', 'ใครก็ตามที่มีลิงก์นี้จะเปิดไฟล์ได้:\n' + result.url, 'success');
    } catch (error) {
      showToast('คัดลอกลิงก์ไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const doUploadAvatar = async () => {
    const file = avatarInputRef.current?.files?.[0];
    if (!file || !selectedId) return;
    try {
      const result = await uploadStudentAvatar(makeTokenGetter(getAccessTokenSilently), selectedId, file);
      if (avatarInputRef.current) avatarInputRef.current.value = '';
      showToast('อัปโหลดรูปสำเร็จ', result.message, 'success');
      setAvatarVersion((v) => v + 1);
      reloadStudents();
    } catch (error) {
      showToast('อัปโหลดรูปไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const s = data?.student;
  const p = data?.payment;
  const monthLabel = data
    ? new Date(data.month + '-01T00:00:00').toLocaleDateString('th-TH', { month: 'long', year: 'numeric' })
    : '';

  return (
    <div id="screen-check" className="tab-content active">
      <div className="screen-header">
        <h1>โปรไฟล์นักเรียน</h1>
        <p>เช็กสถานะการชำระเงิน วันเรียน ไฟล์ และ Study Log ของนักเรียนได้จากที่เดียว</p>
      </div>

      <div className="sticky-picker">
        <StudentPicker students={students} loadFailed={studentsFailed} value={selectedId} onChange={setSelectedId} />
      </div>

      {!selectedId || !data ? (
        <div className="form-hint" style={{ marginBottom: 16 }}>
          {!selectedId
            ? 'กรุณาเลือกนักเรียนเพื่อตรวจสอบข้อมูล'
            : loading
              ? 'กำลังโหลดข้อมูลนักเรียน...'
              : loadError || 'โหลดข้อมูลนักเรียนไม่สำเร็จ'}
        </div>
      ) : (
        <div>
          <div className="profile-tabs" role="tablist">
            <button className={`profile-tab${tab === 'overview' ? ' active' : ''}`} onClick={() => setTab('overview')}>
              <i className="fas fa-id-card"></i> ภาพรวม
            </button>
            <button className={`profile-tab${tab === 'classes' ? ' active' : ''}`} onClick={() => setTab('classes')}>
              <i className="fas fa-calendar-day"></i> คลาส & ตารางเรียน
            </button>
            <button className={`profile-tab${tab === 'files' ? ' active' : ''}`} onClick={() => setTab('files')}>
              <i className="fas fa-folder-open"></i> ไฟล์
            </button>
            <button className={`profile-tab${tab === 'logs' ? ' active' : ''}`} onClick={() => setTab('logs')}>
              <i className="fas fa-book-open"></i> Study Log
            </button>
          </div>

          {tab === 'overview' && (
            <>
              <div className="admin-card">
                <div className="card-title-bar">
                  <span className="card-icon profile-avatar" key={avatarVersion}>
                    <AvatarImage path={`/students/${encodeURIComponent(s!.id)}/avatar`} name={s!.name} />
                  </span>
                  <div>
                    <h3>
                      {s!.name}
                      {s!.nickname ? ` (${s!.nickname})` : ''}
                    </h3>
                    <p>
                      [{s!.id}] · {s!.course || 'ไม่ระบุคอร์ส'}
                      {s!.phone ? ` · ${s!.phone}` : ''}
                      {s!.email ? ` · ${s!.email}` : ''}
                    </p>
                  </div>
                </div>
                <div className="form-body">
                  {p!.paidThisMonth ? (
                    <div className="student-indicator selected">
                      <i className="fas fa-check-circle"></i>{' '}
                      <span>
                        ชำระเงินแล้วในเดือน{monthLabel} รวม <strong>{formatBaht(p!.monthTotal)}</strong>
                      </span>
                    </div>
                  ) : (
                    <div className="student-indicator empty">
                      <i className="fas fa-triangle-exclamation"></i> <span>ยังไม่มีการชำระเงินในเดือน{monthLabel}</span>
                    </div>
                  )}
                  {!!data.creditBalance && data.creditBalance > 0 && (
                    <div className="student-indicator selected" style={{ marginTop: 8 }}>
                      <i className="fas fa-piggy-bank"></i>{' '}
                      <span>
                        เครดิตคงเหลือ <strong>{data.creditBalance}</strong> ชั่วโมง (จะถูกใช้ก่อนในตารางเรียนเดือนถัดไป)
                      </span>
                    </div>
                  )}

                  <div className="row-list tight">
                    {p!.last && (
                      <div className="payment-row">
                        <div className="payment-info">
                          <div className="name">ชำระล่าสุด</div>
                          <div className="meta">
                            {p!.last.method || '-'} · {formatShortThaiDate(p!.last.date)}
                          </div>
                          <div style={{ display: 'flex', gap: 12, marginTop: 2 }}>
                            {isAdmin && p!.last.proof && (
                              <a href={p!.last.proof} target="_blank" rel="noopener" className="alert-action">
                                ดูหลักฐาน <i className="fas fa-arrow-up-right-from-square" style={{ fontSize: 10 }}></i>
                              </a>
                            )}
                            {isAdmin && p!.last.source === 'stripe' && p!.last.stripeSessionId && (
                              <span className="form-hint" style={{ margin: 0 }}>
                                Payment ID: {p!.last.stripeSessionId}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="amount">{formatBaht(p!.last.amount)}</div>
                        {isAdmin && (
                          <button
                            className="btn btn-secondary"
                            style={{ marginLeft: 8, padding: '6px 10px' }}
                            title="แก้ไขจำนวนเงิน"
                            onClick={editPaymentAmount}
                          >
                            <i className="fas fa-pen"></i>
                          </button>
                        )}
                      </div>
                    )}
                    {(p!.pendingLinks || []).map((l, i) => (
                      <div className="payment-row" key={i}>
                        <div className="payment-info">
                          <div className="name">
                            <i className="fab fa-stripe-s"></i> ลิงก์รอชำระ
                          </div>
                          <div className="meta">{l.description || ''}</div>
                        </div>
                        <div className="amount">{formatBaht(l.amount)}</div>
                        <button
                          className="btn btn-secondary"
                          style={{ marginLeft: 8, padding: '6px 10px' }}
                          title="คัดลอกลิงก์"
                          onClick={() => navigator.clipboard.writeText(l.shortUrl || l.url)}
                        >
                          <i className="fas fa-copy"></i>
                        </button>
                      </div>
                    ))}
                    {!p!.last && !(p!.pendingLinks || []).length && (
                      <div className="form-hint">ยังไม่มีประวัติการชำระเงิน</div>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      className="btn btn-primary"
                      onClick={() => {
                        setEditingLog(null);
                        navigate('/logs');
                      }}
                    >
                      <i className="fas fa-pen"></i> เขียน Study Log
                    </button>
                    <button className="btn btn-secondary" onClick={copyStudyLogLink}>
                      <i className="fas fa-link"></i> คัดลอกลิงก์ Study Log
                    </button>
                    {isAdmin && (
                      <button className="btn btn-secondary" onClick={openEdit}>
                        <i className="fas fa-user-pen"></i> แก้ไขข้อมูลนักเรียน
                      </button>
                    )}
                    {isAdmin && (
                      <button className="btn btn-danger" onClick={doDelete}>
                        <i className="fas fa-user-slash"></i> ลบนักเรียนออกจากระบบ
                      </button>
                    )}
                  </div>
                  {isAdmin && (
                    <div className="form-hint">การลบนักเรียนจะลบเฉพาะข้อมูลในระบบนี้ ไม่ลบบัญชีเข้าสู่ระบบของนักเรียน</div>
                  )}
                </div>
              </div>

              {editing && (
                <div className="admin-card">
                  <div className="card-title-bar">
                    <span className="card-icon">
                      <i className="fas fa-user-pen"></i>
                    </span>
                    <div>
                      <h3>แก้ไขข้อมูลนักเรียน</h3>
                      <p>ชื่อ รูปโปรไฟล์ อีเมล เบอร์โทร คอร์สเรียน และบัญชีเข้าสู่ระบบ</p>
                    </div>
                  </div>
                  <div className="form-body">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                      <span className="card-icon profile-avatar avatar-xl" key={avatarVersion}>
                        <AvatarImage path={`/students/${encodeURIComponent(s!.id)}/avatar`} name={s!.name} />
                      </span>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <input
                          type="file"
                          accept="image/*"
                          ref={avatarInputRef}
                          style={{ display: 'none' }}
                          onChange={doUploadAvatar}
                        />
                        <button className="btn btn-secondary" type="button" onClick={() => avatarInputRef.current?.click()}>
                          <i className="fas fa-camera"></i> เปลี่ยนรูปโปรไฟล์
                        </button>
                        <span className="form-hint" style={{ margin: 0 }}>
                          ไฟล์รูปภาพ ขนาดไม่เกิน 5MB
                        </span>
                      </div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                      <div className="form-group">
                        <label>
                          <i className="fas fa-user"></i> ชื่อ-นามสกุล
                        </label>
                        <input
                          type="text"
                          value={editForm.name}
                          onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                        />
                      </div>
                      <div className="form-group">
                        <label>
                          <i className="fas fa-face-smile"></i> ชื่อเล่น
                        </label>
                        <input
                          type="text"
                          value={editForm.nickname}
                          onChange={(e) => setEditForm({ ...editForm, nickname: e.target.value })}
                        />
                      </div>
                      <div className="form-group">
                        <label>
                          <i className="fas fa-envelope"></i> อีเมลติดต่อ
                        </label>
                        <input
                          type="email"
                          value={editForm.email}
                          onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                        />
                      </div>
                      <div className="form-group">
                        <label>
                          <i className="fas fa-phone"></i> เบอร์โทรศัพท์
                        </label>
                        <input
                          type="tel"
                          value={editForm.phone}
                          onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
                        />
                      </div>
                      <div className="form-group">
                        <label>
                          <i className="fas fa-graduation-cap"></i> คอร์สเรียน
                        </label>
                        <div className="select-wrapper">
                          <select
                            value={editForm.course}
                            onChange={(e) => setEditForm({ ...editForm, course: e.target.value })}
                          >
                            <option value="">-- เลือกคอร์สเรียน --</option>
                            {COURSES.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <div className="form-group">
                        <label>
                          <i className="fas fa-id-badge"></i> Username (บัญชีเข้าสู่ระบบ)
                        </label>
                        <input
                          type="text"
                          placeholder="เว้นว่างไว้หากไม่ต้องการเปลี่ยน"
                          value={editForm.username}
                          onChange={(e) => setEditForm({ ...editForm, username: e.target.value })}
                        />
                      </div>
                    </div>
                    <div className="form-group">
                      <label>
                        <i className="fas fa-key"></i> ตั้งรหัสผ่านใหม่ (บัญชีเข้าสู่ระบบ)
                      </label>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <input
                          type="text"
                          placeholder="เว้นว่างไว้หากไม่ต้องการเปลี่ยนรหัสผ่าน"
                          style={{ flex: 1 }}
                          value={editForm.password}
                          onChange={(e) => setEditForm({ ...editForm, password: e.target.value })}
                        />
                        <button
                          className="btn btn-secondary"
                          type="button"
                          onClick={() => setEditForm({ ...editForm, password: generateClientPassword() })}
                        >
                          <i className="fas fa-dice"></i> สุ่มรหัสผ่าน
                        </button>
                      </div>
                      <div className="form-hint">
                        อีเมลเข้าสู่ระบบของนักเรียน (รูปแบบ &lt;รหัสนักเรียน&gt;@...) จะไม่ถูกเปลี่ยนโดยฟอร์มนี้
                      </div>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                      <button className="btn btn-secondary" type="button" onClick={() => setEditing(false)}>
                        ยกเลิก
                      </button>
                      <button className="btn btn-primary" type="button" onClick={saveEdit}>
                        <i className="fas fa-save"></i> บันทึกข้อมูล
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {tab === 'classes' && (
            <div className="admin-card">
              <div className="card-title-bar">
                <span className="card-icon">
                  <i className="fas fa-calendar-day"></i>
                </span>
                <div>
                  <h3>วันเรียนที่กำลังจะถึง</h3>
                  <p>คลาสที่จองไว้ และสถานะตารางเรียนรายเดือน (เวลาแสดงตามอุปกรณ์ของคุณ)</p>
                </div>
              </div>
              <div className="row-list">
                {data.upcomingClasses.length ? (
                  data.upcomingClasses.map((b, i) => (
                    <div className="class-row" key={i}>
                      <div className="class-time">{formatClassTimeLocal(b.date, b.time)}</div>
                      <div className="class-info">
                        <div className="name">
                          {new Date(b.date + 'T00:00:00').toLocaleDateString('th-TH', {
                            weekday: 'long',
                            day: 'numeric',
                            month: 'long',
                          })}
                        </div>
                        <div className="course">{b.notes || ''}</div>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="form-hint">ยังไม่มีคลาสที่จองไว้ล่วงหน้า</div>
                )}
              </div>
              <div className="row-list tight" style={{ marginTop: 8 }}>
                {data.schedules.map((m, i) => (
                  <div className="payment-row" style={{ alignItems: 'flex-start' }} key={i}>
                    <div className="payment-info">
                      <div className="name">
                        ตารางเรียนเดือน {m.month} ({m.sessionCount} ครั้ง)
                      </div>
                      <div className="meta">
                        {SCHEDULE_STATUS_LABEL[m.status] || m.status} · โดย {m.createdByName || m.createdBy || '-'}
                      </div>
                      {!!m.sessions?.length && (
                        <div className="table-scroll" style={{ marginTop: 8, maxHeight: 160, overflowY: 'auto' }}>
                          <table className="data-table">
                            <thead>
                              <tr>
                                <th>วันที่</th>
                                <th>เวลา</th>
                              </tr>
                            </thead>
                            <tbody>
                              {m.sessions.map((sess, j) => (
                                <tr key={j}>
                                  <td>{formatShortThaiDate(sess.date)}</td>
                                  <td>{formatClassTimeLocal(sess.date, sess.time)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                    <div className="amount">{formatBaht(m.total)}</div>
                    {m.paymentUrl && m.status === 'approved' && (
                      <button
                        className="btn btn-secondary"
                        style={{ marginLeft: 8, padding: '6px 10px' }}
                        title="คัดลอกลิงก์ชำระเงิน"
                        onClick={() => navigator.clipboard.writeText(m.paymentShortUrl || m.paymentUrl || '')}
                      >
                        <i className="fas fa-copy"></i>
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === 'files' && (
            <div className="admin-card">
              <div className="card-title-bar">
                <span className="card-icon">
                  <i className="fas fa-upload"></i>
                </span>
                <div>
                  <h3>อัปโหลดไฟล์ให้นักเรียน</h3>
                  <p>ไฟล์จะเข้าไปอยู่ในเมนู "ไฟล์นักเรียน" ให้อัตโนมัติ</p>
                </div>
              </div>
              <div className="form-body">
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                  <div className="form-group">
                    <label>
                      <i className="fas fa-tag"></i> ประเภทเอกสาร
                    </label>
                    <div className="select-wrapper">
                      <select value={docType} onChange={(e) => setDocType(e.target.value)}>
                        <option value="Homework">การบ้าน (Homework)</option>
                        <option value="Worksheet">ใบงาน (Worksheet)</option>
                        <option value="Exam">ข้อสอบ (Exam)</option>
                        <option value="Attendance">การเข้าเรียน (Attendance)</option>
                        <option value="Certificate">ใบรับรอง (Certificate)</option>
                        <option value="Portfolio">ผลงาน (Portfolio)</option>
                        <option value="Other">อื่น ๆ (Other)</option>
                      </select>
                    </div>
                  </div>
                  <div className="form-group">
                    <label>
                      <i className="fas fa-paperclip"></i> ไฟล์
                    </label>
                    <input type="file" ref={fileInputRef} />
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button className="btn btn-primary" onClick={doUploadFile}>
                    <i className="fas fa-upload"></i> อัปโหลดไฟล์
                  </button>
                </div>
                <div className="row-list tight">
                  {files.length ? (
                    files.slice(0, 8).map((f) => (
                      <div className="payment-row" key={f.id}>
                        <div className="payment-info">
                          <div className="name">
                            <i className="fas fa-file-lines"></i> {f.filename}
                          </div>
                          <div className="meta">
                            {f.file_type} · {f.uploaded_by || '-'}
                          </div>
                        </div>
                        <button
                          className="btn btn-secondary"
                          style={{ padding: '6px 10px' }}
                          title="ดาวน์โหลด"
                          onClick={() => doDownloadFile(f)}
                        >
                          <i className="fas fa-download"></i>
                        </button>
                        <button
                          className="btn btn-secondary"
                          style={{ marginLeft: 6, padding: '6px 10px' }}
                          title="คัดลอกลิงก์สาธารณะ"
                          onClick={() => doCopyPublicLink(f)}
                        >
                          <i className="fas fa-link"></i>
                        </button>
                      </div>
                    ))
                  ) : (
                    <div className="form-hint">ยังไม่มีไฟล์ของนักเรียนคนนี้</div>
                  )}
                </div>
              </div>
            </div>
          )}

          {tab === 'logs' && (
            <div className="admin-card">
              <div className="card-title-bar">
                <span className="card-icon">
                  <i className="fas fa-book-open"></i>
                </span>
                <div>
                  <h3>Study Log ล่าสุด</h3>
                  <p>บันทึกการเรียน 5 รายการล่าสุด</p>
                </div>
              </div>
              <div className="row-list">
                {data.recentLogs.length ? (
                  data.recentLogs.map((l) => (
                    <div className="alert-row" key={l.id}>
                      <i className="far fa-sticky-note" style={{ color: 'var(--text-muted)' }}></i>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="alert-text">
                          <strong>{formatShortThaiDate(l.date)}</strong> · {(l.feedback || '').slice(0, 120)}
                          {(l.feedback || '').length > 120 ? '…' : ''}
                        </div>
                        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 2 }}>
                          {l.video && (
                            <a href={l.video} target="_blank" rel="noopener" className="alert-action">
                              ดูวิดีโอย้อนหลัง <i className="fas fa-arrow-up-right-from-square" style={{ fontSize: 10 }}></i>
                            </a>
                          )}
                          <button
                            className="alert-action"
                            style={{ border: 'none', background: 'none', cursor: 'pointer' }}
                            onClick={() => {
                              setEditingLog({ id: l.id, date: l.date, video: l.video, feedback: l.feedback });
                              navigate('/logs');
                            }}
                          >
                            <i className="fas fa-pen" style={{ fontSize: 10 }}></i> แก้ไข
                          </button>
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="form-hint">ยังไม่มี Study Log</div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
