import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { useToast } from '../ui/ToastContext';
import AvatarImage from '../ui/AvatarImage';
import {
  makeTokenGetter,
  fetchStaff,
  createStaffAccount,
  updateStaff,
  uploadStaffAvatarApi,
  sendStaffPasswordTicket,
  sendStaffPasskeyTicket,
  type StaffRow,
} from '../api/client';

const STAFF_ROLE_LABEL: Record<string, string> = { admin: 'แอดมิน', teacher: 'ครู', staff: 'พนักงาน' };

function StaffRowCard({ row, onChanged }: { row: StaffRow; onChanged: () => void }) {
  const { getAccessTokenSilently } = useAuth0();
  const showToast = useToast();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(row.name || '');
  const [title, setTitle] = useState(row.title || '');
  const [phone, setPhone] = useState(row.phone || '');
  const [avatarVersion, setAvatarVersion] = useState(0);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  const roleLabel = STAFF_ROLE_LABEL[row.role] || (row.isAdmin ? 'แอดมิน' : '-');
  const metaBits = [row.title, row.phone, row.identity].filter(Boolean).join(' · ');

  const save = async () => {
    if (!name.trim()) {
      showToast('กรุณากรอกชื่อ', undefined, 'error');
      return;
    }
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      const result = await updateStaff(getToken, row.identity, { name: name.trim(), title: title.trim(), phone: phone.trim() });
      showToast('บันทึกสำเร็จ', result.message, 'success');
      setEditing(false);
      onChanged();
    } catch (error) {
      showToast('บันทึกไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const uploadAvatar = async () => {
    const file = avatarInputRef.current?.files?.[0];
    if (!file) return;
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      const result = await uploadStaffAvatarApi(getToken, row.identity, file);
      if (avatarInputRef.current) avatarInputRef.current.value = '';
      showToast('อัปโหลดรูปสำเร็จ', result.message, 'success');
      setAvatarVersion((v) => v + 1);
    } catch (error) {
      showToast('อัปโหลดรูปไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const sendPasswordTicket = async () => {
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      const result = await sendStaffPasswordTicket(getToken, row.identity);
      await navigator.clipboard.writeText(result.url).catch(() => {});
      showToast('คัดลอกลิงก์แล้ว', 'ส่งลิงก์นี้ให้ผู้ใช้เพื่อตั้งรหัสผ่านใหม่ด้วยตนเอง (ลิงก์นี้ใช้ได้ 7 วัน)', 'success');
    } catch (error) {
      showToast('สร้างลิงก์ไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const sendPasskeyTicket = async () => {
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      const result = await sendStaffPasskeyTicket(getToken, row.identity);
      await navigator.clipboard.writeText(result.url).catch(() => {});
      showToast('คัดลอกลิงก์แล้ว', 'ส่งลิงก์นี้ให้ผู้ใช้เพื่อลงทะเบียน Passkey บนอุปกรณ์ของตนเอง', 'success');
    } catch (error) {
      showToast('สร้างลิงก์ไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  return (
    <div className="admin-card" style={{ marginTop: 12 }}>
      <div className="card-title-bar">
        <span className="card-icon profile-avatar" key={avatarVersion}>
          <AvatarImage path={`/staff/${encodeURIComponent(row.identity)}/avatar`} name={row.name || row.identity} />
        </span>
        <div>
          <h3>
            {row.name || row.identity} <span className="badge-soft">{roleLabel}</span>
          </h3>
          <p>{metaBits}</p>
        </div>
      </div>
      <div className="form-body">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input type="file" accept="image/*" ref={avatarInputRef} style={{ display: 'none' }} onChange={uploadAvatar} />
          <button className="btn btn-secondary" onClick={() => avatarInputRef.current?.click()}>
            <i className="fas fa-camera"></i> เปลี่ยนรูปโปรไฟล์
          </button>
          <button className="btn btn-secondary" onClick={() => setEditing((e) => !e)}>
            <i className="fas fa-user-pen"></i> แก้ไขข้อมูล
          </button>
          <button className="btn btn-secondary" onClick={sendPasswordTicket}>
            <i className="fas fa-key"></i> เปลี่ยนรหัสผ่าน
          </button>
          <button className="btn btn-secondary" onClick={sendPasskeyTicket}>
            <i className="fas fa-fingerprint"></i> ลงทะเบียน Passkey
          </button>
        </div>
        {editing && (
          <div style={{ marginTop: 8 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div className="form-group">
                <label>
                  <i className="fas fa-user"></i> ชื่อ-นามสกุล
                </label>
                <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="form-group">
                <label>
                  <i className="fas fa-id-badge"></i> ตำแหน่ง
                </label>
                <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
              </div>
              <div className="form-group">
                <label>
                  <i className="fas fa-phone"></i> เบอร์โทรศัพท์
                </label>
                <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn btn-secondary" onClick={() => setEditing(false)}>
                ยกเลิก
              </button>
              <button className="btn btn-primary" onClick={save}>
                <i className="fas fa-save"></i> บันทึก
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function StaffScreen() {
  const { getAccessTokenSilently } = useAuth0();
  const showToast = useToast();
  const [rows, setRows] = useState<StaffRow[] | null>(null);
  const [form, setForm] = useState({ name: '', email: '', role: 'teacher' as const, title: '', phone: '' });

  const load = useCallback(async () => {
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      setRows(await fetchStaff(getToken));
    } catch (error) {
      console.error('loadStaffScreen:', error);
      setRows(null);
    }
  }, [getAccessTokenSilently]);

  useEffect(() => {
    load();
  }, [load]);

  const submit = async () => {
    if (!form.name.trim()) {
      showToast('กรุณากรอกชื่อ', undefined, 'error');
      return;
    }
    if (!form.email.trim()) {
      showToast('กรุณากรอกอีเมล', undefined, 'error');
      return;
    }
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      const result = await createStaffAccount(getToken, {
        name: form.name.trim(),
        email: form.email.trim(),
        role: form.role,
        title: form.title.trim(),
        phone: form.phone.trim(),
      });
      showToast('สร้างบัญชีสำเร็จ', result.message, 'success', 12000);
      setForm({ name: '', email: '', role: 'teacher', title: '', phone: '' });
      load();
    } catch (error) {
      showToast('สร้างบัญชีไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  return (
    <div id="screen-staff" className="tab-content active">
      <div className="screen-header">
        <h1>ครูและพนักงาน</h1>
        <p>สร้างบัญชีเข้าสู่ระบบให้ครูและพนักงาน แก้ไขข้อมูล อัปโหลดรูปโปรไฟล์ และส่งลิงก์เปลี่ยนรหัสผ่าน/ลงทะเบียน Passkey</p>
      </div>

      <div className="admin-card">
        <div className="card-title-bar">
          <span className="card-icon">
            <i className="fas fa-user-plus"></i>
          </span>
          <div>
            <h3>สร้างบัญชีใหม่</h3>
            <p>ระบบจะสร้างบัญชีเข้าสู่ระบบใน Auth0 พร้อมรหัสผ่านชั่วคราว (แสดงครั้งเดียว)</p>
          </div>
        </div>
        <div className="form-body">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div className="form-group">
              <label>
                <i className="fas fa-user"></i> ชื่อ-นามสกุล
              </label>
              <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="form-group">
              <label>
                <i className="fas fa-envelope"></i> อีเมล (ใช้เข้าสู่ระบบ)
              </label>
              <input
                type="email"
                placeholder="teacher@example.com"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label>
                <i className="fas fa-user-tag"></i> บทบาท
              </label>
              <div className="select-wrapper">
                <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as typeof form.role })}>
                  <option value="teacher">ครู (Teacher)</option>
                  <option value="staff">พนักงาน (Staff)</option>
                  <option value="admin">แอดมิน (Admin)</option>
                </select>
              </div>
            </div>
            <div className="form-group">
              <label>
                <i className="fas fa-id-badge"></i> ตำแหน่ง (ถ้ามี)
              </label>
              <input
                type="text"
                placeholder="เช่น หัวหน้าครู, ธุรการ"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label>
                <i className="fas fa-phone"></i> เบอร์โทรศัพท์ (ถ้ามี)
              </label>
              <input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn btn-primary" onClick={submit}>
              <i className="fas fa-user-plus"></i> สร้างบัญชี
            </button>
          </div>
        </div>
      </div>

      <div className="admin-card" style={{ marginTop: 24 }}>
        <div className="card-title-bar">
          <span className="card-icon">
            <i className="fas fa-users-gear"></i>
          </span>
          <div>
            <h3>รายชื่อครูและพนักงาน</h3>
            <p>บัญชีที่ระบบเคยเห็น (เข้าสู่ระบบแล้ว หรือสร้างจากหน้านี้)</p>
          </div>
        </div>
        <div className="row-list">
          {rows === null ? (
            <div className="form-hint">โหลดรายชื่อไม่สำเร็จ (ต้องเป็นแอดมินเท่านั้น)</div>
          ) : !rows.length ? (
            <div className="form-hint">ยังไม่มีข้อมูลบุคลากร</div>
          ) : (
            rows.map((r) => <StaffRowCard row={r} key={r.identity} onChanged={load} />)
          )}
        </div>
      </div>
    </div>
  );
}
