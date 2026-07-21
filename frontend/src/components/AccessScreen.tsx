import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { useStudents } from '../hooks/useStudents';
import { useMe } from '../hooks/useMe';
import { useToast } from '../ui/ToastContext';
import {
  makeTokenGetter,
  fetchStaffIdentities,
  fetchTeacherAssignments,
  saveTeacherAssignments,
  type StaffIdentity,
  type TeacherAssignment,
} from '../api/client';

export default function AccessScreen() {
  const { getAccessTokenSilently } = useAuth0();
  const { students } = useStudents();
  const { me } = useMe();
  const showToast = useToast();

  const [identities, setIdentities] = useState<StaffIdentity[]>([]);
  const [assignments, setAssignments] = useState<TeacherAssignment[] | null>(null);
  const [teacherEmail, setTeacherEmail] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    const getToken = makeTokenGetter(getAccessTokenSilently);
    try {
      const rows = await fetchTeacherAssignments(getToken);
      setAssignments(rows);
    } catch (error) {
      console.error('loadTeacherAssignments:', error);
      setAssignments(null);
    }
    try {
      setIdentities(await fetchStaffIdentities(getToken));
    } catch (error) {
      console.error('loadAccessDiagnostics:', error);
      setIdentities([]);
    }
  }, [getAccessTokenSilently]);

  useEffect(() => {
    load();
  }, [load]);

  // Seed the selection whenever the typed/chosen teacher email changes.
  useEffect(() => {
    const email = teacherEmail.trim().toLowerCase();
    const existing = assignments?.find((t) => t.teacher.toLowerCase() === email);
    setSelected(new Set(existing ? existing.studentIds : []));
  }, [teacherEmail, assignments]);

  const filteredStudents = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return students;
    return students.filter((s) => [s.name, s.nickname, s.id].some((v) => String(v || '').toLowerCase().includes(q)));
  }, [students, search]);

  const toggleStudent = (id: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const submit = async () => {
    const email = teacherEmail.trim().toLowerCase();
    if (email.length < 3 || /\s/.test(email) || (!email.includes('@') && !email.includes('|'))) {
      showToast('กรุณากรอกอีเมลครู หรือเลือกบัญชีจากรายการ', undefined, 'error');
      return;
    }
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      const result = await saveTeacherAssignments(getToken, email, [...selected]);
      showToast('บันทึกสิทธิ์สำเร็จ', result.message, 'success');
      load();
    } catch (error) {
      showToast('บันทึกสิทธิ์ไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const myIdentity = me?.email || '';
  const looksLikeEmail = myIdentity.includes('@');

  return (
    <div id="screen-access" className="tab-content active">
      <div className="screen-header">
        <h1>สิทธิ์การมองเห็นนักเรียน</h1>
        <p>กำหนดว่าครูแต่ละคนเห็นนักเรียนคนไหนได้บ้าง เพื่อความเป็นส่วนตัวของนักเรียนและการคำนวณรายได้ของครูที่แม่นยำ</p>
      </div>

      <div className="admin-card">
        <div className="card-title-bar">
          <span className="card-icon">
            <i className="fas fa-user-shield"></i>
          </span>
          <div>
            <h3>กำหนดนักเรียนให้ครู</h3>
            <p>ครูที่ไม่ถูกจำกัดสิทธิ์จะเห็นนักเรียนทุกคน (ค่าเริ่มต้น)</p>
          </div>
        </div>
        {myIdentity && (
          <div className="info-notice">
            {looksLikeEmail ? (
              <>
                <i className="fas fa-circle-info"></i>
                <div>
                  บัญชีของคุณ: <strong>{myIdentity}</strong>
                </div>
              </>
            ) : (
              <>
                <i className="fas fa-triangle-exclamation" style={{ color: 'var(--accent-danger)' }}></i>
                <div>
                  ระบบยังไม่รู้จักอีเมลของบัญชีนี้ (เห็นเป็น <strong>{myIdentity}</strong>) — เลือกบัญชีครูจากรายการด้านล่างแทนการพิมพ์อีเมล
                  หรือแจ้งผู้ดูแลระบบให้ตั้งค่าเพิ่มเติม
                </div>
              </>
            )}
          </div>
        )}
        <div className="form-body">
          <div className="form-group">
            <label>
              <i className="fas fa-envelope"></i> บัญชีครู (อีเมลที่ใช้เข้าสู่ระบบ)
            </label>
            <input
              type="text"
              list="access-teacher-datalist"
              placeholder="teacher@example.com"
              value={teacherEmail}
              onChange={(e) => setTeacherEmail(e.target.value)}
            />
            <datalist id="access-teacher-datalist">
              {assignments?.map((t) => <option value={t.teacher} key={t.teacher} />)}
            </datalist>
            <div className="form-hint">
              ต้องตรงกับตัวตนที่ระบบเห็นตอนครูเข้าสู่ระบบ — เลือกจาก "บัญชีที่ใช้งานระบบล่าสุด" ด้านล่างเพื่อความแม่นยำ
            </div>
            {!!identities.length && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                <div className="form-hint" style={{ width: '100%' }}>
                  บัญชีที่ใช้งานระบบล่าสุด (คลิกเพื่อเลือก):
                </div>
                {identities.map((r) => (
                  <button
                    key={r.identity}
                    className="btn btn-secondary"
                    style={{ padding: '4px 10px', fontSize: 12 }}
                    title={`${r.identity} · ใช้งานล่าสุด ${r.lastSeen || ''}`}
                    onClick={() => setTeacherEmail(r.identity)}
                  >
                    {r.name || r.identity}
                    {r.isAdmin ? ' (แอดมิน)' : ''}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="form-group">
            <label>
              <i className="fas fa-users"></i> นักเรียนที่ครูคนนี้เห็นได้
            </label>
            <div className="search-box" style={{ maxWidth: 320, marginBottom: 8 }}>
              <i className="fas fa-magnifying-glass"></i>
              <input type="text" placeholder="ค้นหาชื่อหรือรหัสนักเรียน..." value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <div className="access-student-grid">
              {!students.length ? (
                <div className="form-hint">ยังไม่มีนักเรียนในระบบ</div>
              ) : !filteredStudents.length ? (
                <div className="form-hint">ไม่พบนักเรียนที่ค้นหา</div>
              ) : (
                filteredStudents.map((s) => (
                  <label className="access-student-item" key={s.id}>
                    <input type="checkbox" checked={selected.has(s.id)} onChange={(e) => toggleStudent(s.id, e.target.checked)} />
                    <div style={{ minWidth: 0 }}>
                      <div className="a-name">
                        {s.name}
                        {s.nickname && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> ({s.nickname})</span>}
                      </div>
                      <div className="a-id">{s.id}</div>
                    </div>
                  </label>
                ))
              )}
            </div>
            <div className="form-hint">ไม่เลือกเลย = ครูคนนี้เห็นนักเรียนทุกคน · สิทธิ์มีผลเมื่อครูรีเฟรชหน้าเว็บหรือเข้าสู่ระบบใหม่</div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn btn-primary" onClick={submit}>
              <i className="fas fa-save"></i> บันทึกสิทธิ์
            </button>
          </div>
        </div>
      </div>

      <div className="admin-card" style={{ marginTop: 24 }}>
        <div className="card-title-bar">
          <span className="card-icon">
            <i className="fas fa-list"></i>
          </span>
          <div>
            <h3>สิทธิ์ที่กำหนดไว้แล้ว</h3>
            <p>ครูที่ถูกจำกัดสิทธิ์ในปัจจุบัน</p>
          </div>
        </div>
        <div className="row-list">
          {assignments === null ? (
            <div className="form-hint">โหลดข้อมูลไม่สำเร็จ (ต้องเป็นผู้ดูแลระบบเท่านั้น)</div>
          ) : !assignments.length ? (
            <div className="form-hint">ยังไม่มีการจำกัดสิทธิ์ — ครูที่ยังไม่ถูกกำหนดนักเรียนจะไม่เห็นเมนูใด ๆ</div>
          ) : (
            assignments.map((t) => (
              <div className="payment-row" key={t.teacher}>
                <div className="payment-info">
                  <div className="name">{t.teacherName || t.teacher}</div>
                  <div className="meta">
                    เห็นนักเรียน {t.studentIds.length} คน: {t.studentIds.slice(0, 6).join(', ')}
                    {t.studentIds.length > 6 ? '…' : ''}
                  </div>
                </div>
                <button className="btn btn-secondary" style={{ padding: '6px 10px' }} onClick={() => setTeacherEmail(t.teacher)}>
                  <i className="fas fa-pen"></i> แก้ไข
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
