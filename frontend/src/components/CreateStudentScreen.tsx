import { useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { useStudents } from '../hooks/useStudents';
import { useToast } from '../ui/ToastContext';
import { COURSES } from '../utils/courses';
import { makeTokenGetter, createStudent } from '../api/client';

const EMPTY = { name: '', nickname: '', email: '', phone: '', course: '' };

export default function CreateStudentScreen() {
  const { getAccessTokenSilently } = useAuth0();
  const { reload } = useStudents();
  const showToast = useToast();
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!form.name.trim()) {
      showToast('กรุณากรอกชื่อและนามสกุล', undefined, 'error');
      return;
    }
    if (!form.course) {
      showToast('กรุณาเลือกคอร์สเรียน', undefined, 'error');
      return;
    }
    setSaving(true);
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      const result = await createStudent(getToken, form);
      showToast('สร้างบัญชีสำเร็จ', result.message, 'success', 12000);
      setForm(EMPTY);
      reload();
    } catch (error) {
      showToast('เกิดข้อผิดพลาดจากระบบ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
    setSaving(false);
  };

  return (
    <div id="screen-create" className="tab-content active">
      <div className="screen-header">
        <h1>สร้างบัญชีนักเรียน</h1>
        <p>เพิ่มนักเรียนใหม่เข้าสู่ระบบ</p>
      </div>

      <div className="admin-card">
        <div className="card-title-bar">
          <span className="card-icon">
            <i className="fas fa-user"></i>
          </span>
          <div>
            <h3>ข้อมูลนักเรียนใหม่</h3>
            <p>กรอกข้อมูลให้ครบทุกช่อง</p>
          </div>
        </div>

        <div className="info-notice">
          <i className="fas fa-info-circle"></i>
          <div>
            <strong>ระบบดำเนินการอัตโนมัติ:</strong> สร้างบัญชีเข้าสู่ระบบพร้อมรหัสผ่านชั่วคราว
            และบันทึกข้อมูลนักเรียนให้ทันทีหลังกดบันทึก
          </div>
        </div>

        <div className="form-body">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div className="form-group">
              <label>
                <i className="fas fa-user"></i> ชื่อ-นามสกุล
              </label>
              <input
                type="text"
                placeholder="เช่น สมชาย ดีเด่น"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label>
                <i className="fas fa-tag"></i> ชื่อเล่น
              </label>
              <input
                type="text"
                placeholder="เช่น น้องมายด์"
                value={form.nickname}
                onChange={(e) => setForm({ ...form, nickname: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label>
                <i className="fas fa-envelope"></i> อีเมล
              </label>
              <input
                type="email"
                placeholder="student@email.com"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
              <div className="form-hint">อีเมลติดต่อจริง (ระบบจะสร้างอีเมลผู้ใช้งานสำหรับเข้าสู่ระบบแยกต่างหากให้อัตโนมัติ)</div>
            </div>
            <div className="form-group">
              <label>
                <i className="fas fa-phone"></i> เบอร์โทรศัพท์
              </label>
              <input
                type="tel"
                placeholder="08x-xxx-xxxx"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
              />
            </div>
          </div>
          <div className="form-group">
            <label>
              <i className="fas fa-graduation-cap"></i> คอร์สเรียน
            </label>
            <div className="select-wrapper">
              <select value={form.course} onChange={(e) => setForm({ ...form, course: e.target.value })}>
                <option value="">-- เลือกคอร์สเรียน --</option>
                {COURSES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn btn-primary" onClick={submit} disabled={saving}>
              <i className="fas fa-user-plus"></i> สร้างบัญชีนักเรียน
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
