import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { useMe } from '../hooks/useMe';
import { useToast } from '../ui/ToastContext';
import { useConfirm } from '../ui/ConfirmContext';
import {
  makeTokenGetter,
  fetchCourses,
  fetchCourse,
  fetchCourseAvailableQuizzes,
  createCourse,
  updateCourse,
  setCourseStatusApi,
  deleteCourseApi,
  fetchCourseEnrollments,
  type CourseSummary,
  type CourseStatus,
  type CourseAvailableQuiz,
  type CourseEnrollmentRow,
} from '../api/client';

const STATUS_LABEL: Record<CourseStatus, string> = {
  draft: 'ฉบับร่าง',
  published: 'เผยแพร่แล้ว',
  archived: 'เก็บถาวร',
};

interface CourseForm {
  title: string;
  titleTh: string;
  description: string;
  descriptionTh: string;
  overviewTh: string;
  category: string;
  priceBaht: string;
  quizIds: number[];
}

const EMPTY_FORM: CourseForm = {
  title: '',
  titleTh: '',
  description: '',
  descriptionTh: '',
  overviewTh: '',
  category: '',
  priceBaht: '0',
  quizIds: [],
};

// ----- On-device editor auto-save (same model as the quiz editor) -----
interface CourseDraft {
  form: CourseForm;
  savedAt: number;
}
const draftKey = (id: number | null) => `litalk_course_editor_${id ?? 'new'}`;
function readDraft(id: number | null): CourseDraft | null {
  try {
    const raw = localStorage.getItem(draftKey(id));
    return raw ? (JSON.parse(raw) as CourseDraft) : null;
  } catch {
    return null;
  }
}
function writeDraft(id: number | null, draft: CourseDraft) {
  try {
    localStorage.setItem(draftKey(id), JSON.stringify(draft));
  } catch {
    /* best-effort */
  }
}
function clearDraft(id: number | null) {
  try {
    localStorage.removeItem(draftKey(id));
  } catch {
    /* ignore */
  }
}

function formatBaht(satang: number): string {
  return (satang / 100).toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

export default function CoursesScreen() {
  const { getAccessTokenSilently } = useAuth0();
  const { isAdmin } = useMe();
  const showToast = useToast();
  const confirmDialog = useConfirm();

  const [courses, setCourses] = useState<CourseSummary[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [search, setSearch] = useState('');

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<CourseForm>(EMPTY_FORM);
  const [availableQuizzes, setAvailableQuizzes] = useState<CourseAvailableQuiz[]>([]);
  const [saving, setSaving] = useState(false);
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null);

  const [enrollFor, setEnrollFor] = useState<CourseSummary | null>(null);
  const [enrollments, setEnrollments] = useState<CourseEnrollmentRow[] | null>(null);

  const load = useCallback(async () => {
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      const res = await fetchCourses(getToken);
      setCourses(res.courses);
      setLoadFailed(false);
    } catch (error) {
      console.error('loadCourses:', error);
      setLoadFailed(true);
      setCourses(null);
    }
  }, [getAccessTokenSilently]);

  useEffect(() => {
    load();
  }, [load]);

  // Persist the open editor to this device on every change (uploaded to the
  // cloud only on Save).
  useEffect(() => {
    if (!editorOpen) return;
    const savedAt = Date.now();
    writeDraft(editingId, { form, savedAt });
    setDraftSavedAt(savedAt);
  }, [editorOpen, editingId, form]);

  const filtered = useMemo(() => {
    if (!courses) return [];
    const term = search.trim().toLowerCase();
    if (!term) return courses;
    return courses.filter((c) => `${c.title} ${c.titleTh ?? ''} ${c.category ?? ''}`.toLowerCase().includes(term));
  }, [courses, search]);

  const loadAvailableQuizzes = async (id: number) => {
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      const res = await fetchCourseAvailableQuizzes(getToken, id);
      setAvailableQuizzes(res.quizzes);
    } catch (error) {
      console.error('loadAvailableQuizzes:', error);
      setAvailableQuizzes([]);
    }
  };

  const openNew = async () => {
    const draft = readDraft(null);
    await loadAvailableQuizzes(0);
    if (
      draft?.form &&
      (await confirmDialog('พบฉบับร่างที่บันทึกไว้บนอุปกรณ์นี้ (ยังไม่ได้บันทึกขึ้นคลาวด์) ต้องการกู้คืนหรือไม่?', {
        title: 'กู้คืนฉบับร่าง',
        okLabel: 'กู้คืนฉบับร่าง',
      }))
    ) {
      setEditingId(null);
      setForm(draft.form);
      setEditorOpen(true);
      return;
    }
    clearDraft(null);
    setEditingId(null);
    setForm(EMPTY_FORM);
    setEditorOpen(true);
  };

  const openEdit = async (id: number) => {
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      const { course, items } = await fetchCourse(getToken, id);
      await loadAvailableQuizzes(id);
      const cloudForm: CourseForm = {
        title: course.title,
        titleTh: course.titleTh ?? '',
        description: course.description ?? '',
        descriptionTh: course.descriptionTh ?? '',
        overviewTh: course.overviewTh ?? '',
        category: course.category ?? '',
        priceBaht: String((course.priceSatang ?? 0) / 100),
        quizIds: items.map((it) => it.quizId),
      };
      const draft = readDraft(id);
      if (
        draft?.form &&
        (await confirmDialog('พบฉบับร่างของคอร์สนี้ที่บันทึกไว้บนอุปกรณ์ (ยังไม่ได้บันทึกขึ้นคลาวด์) ต้องการกู้คืนหรือไม่?', {
          title: 'กู้คืนฉบับร่าง',
          okLabel: 'กู้คืนฉบับร่าง',
        }))
      ) {
        setEditingId(id);
        setForm(draft.form);
        setEditorOpen(true);
        return;
      }
      clearDraft(id);
      setEditingId(id);
      setForm(cloudForm);
      setEditorOpen(true);
    } catch (error) {
      showToast('เปิดคอร์สไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const closeEditor = () => {
    setEditorOpen(false);
    setEditingId(null);
  };

  const toggleQuiz = (quizId: number) => {
    setForm((f) => ({
      ...f,
      quizIds: f.quizIds.includes(quizId) ? f.quizIds.filter((x) => x !== quizId) : [...f.quizIds, quizId],
    }));
  };

  const save = async (publishAfter: boolean) => {
    if (!form.title.trim() && !form.titleTh.trim()) {
      showToast('ตรวจสอบข้อมูล', 'กรุณากรอกชื่อคอร์ส', 'error');
      return;
    }
    const priceBaht = Number(form.priceBaht);
    if (!Number.isFinite(priceBaht) || priceBaht < 0) {
      showToast('ตรวจสอบข้อมูล', 'ราคาไม่ถูกต้อง', 'error');
      return;
    }
    setSaving(true);
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      const payload = {
        title: (form.title || form.titleTh).trim(),
        titleTh: form.titleTh.trim() || undefined,
        description: form.description.trim() || undefined,
        descriptionTh: form.descriptionTh.trim() || undefined,
        overviewTh: form.overviewTh || undefined,
        category: form.category.trim() || undefined,
        priceSatang: Math.round(priceBaht * 100),
        currency: 'thb',
        quizIds: form.quizIds,
      };
      let id = editingId;
      if (editingId) {
        await updateCourse(getToken, editingId, payload);
      } else {
        const res = await createCourse(getToken, payload);
        id = res.id;
      }
      if (publishAfter && id && isAdmin) {
        await setCourseStatusApi(getToken, id, 'published');
      }
      clearDraft(editingId);
      setDraftSavedAt(null);
      showToast(editingId ? 'บันทึกคอร์สแล้ว' : 'สร้างคอร์สแล้ว', undefined, 'success');
      closeEditor();
      load();
    } catch (error) {
      showToast('บันทึกไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
    setSaving(false);
  };

  const changeStatus = async (course: CourseSummary, status: CourseStatus) => {
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      await setCourseStatusApi(getToken, course.id, status);
      showToast(status === 'published' ? 'เผยแพร่คอร์สแล้ว' : 'อัปเดตสถานะแล้ว', undefined, 'success');
      load();
    } catch (error) {
      showToast('อัปเดตสถานะไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const remove = async (course: CourseSummary) => {
    if (
      !(await confirmDialog(`ลบคอร์ส "${course.titleTh || course.title}"? การลงทะเบียนทั้งหมดจะถูกลบไปด้วย`, {
        title: 'ลบคอร์ส',
        danger: true,
        okLabel: 'ลบ',
      }))
    )
      return;
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      await deleteCourseApi(getToken, course.id);
      showToast('ลบคอร์สแล้ว', undefined, 'success');
      load();
    } catch (error) {
      showToast('ลบไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const openEnrollments = async (course: CourseSummary) => {
    setEnrollFor(course);
    setEnrollments(null);
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      const res = await fetchCourseEnrollments(getToken, course.id);
      setEnrollments(res.enrollments);
    } catch (error) {
      showToast('โหลดผู้ลงทะเบียนไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
      setEnrollments([]);
    }
  };

  return (
    <>
      <div className="screen-header">
        <h1>คอร์สเรียนออนไลน์</h1>
        <p>
          รวมบทเรียนและแบบทดสอบเป็นคอร์สแบบเสียเงิน นักเรียนชำระเงินผ่าน Stripe แล้วจะปลดล็อกเข้าเรียนได้ทันที —
          บทเรียนที่ยังไม่ได้อยู่ในคอร์สจะยังเรียนได้ฟรีตามปกติ{isAdmin ? '' : ' (รอแอดมินเผยแพร่)'}
        </p>
      </div>

      {editorOpen && (
        <div className="admin-card">
          <div className="card-title-bar">
            <span className="card-icon">
              <i className="fas fa-graduation-cap"></i>
            </span>
            <div style={{ flex: 1 }}>
              <h3>{editingId ? 'แก้ไขคอร์ส' : 'สร้างคอร์สใหม่'}</h3>
              <p>
                เลือกบทเรียน/แบบทดสอบที่จะรวมในคอร์ส แล้วตั้งราคา
                {draftSavedAt && (
                  <span style={{ marginLeft: 10, color: 'var(--text-secondary, #888)' }}>
                    <i className="fas fa-floppy-disk"></i> บันทึกร่างบนอุปกรณ์แล้ว{' '}
                    {new Date(draftSavedAt).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                )}
              </p>
            </div>
            <button type="button" className="btn btn-secondary" onClick={closeEditor}>
              <i className="fas fa-xmark"></i> ปิด
            </button>
          </div>

          <div className="form-body">
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <div className="form-group" style={{ flex: '1 1 260px' }}>
                <label>
                  <i className="fas fa-heading"></i> ชื่อคอร์ส (ภาษาไทย)
                </label>
                <input
                  type="text"
                  value={form.titleTh}
                  placeholder="เช่น คอร์สภาษาอังกฤษเพื่อการสอบ TOEIC"
                  onChange={(e) => setForm({ ...form, titleTh: e.target.value })}
                />
              </div>
              <div className="form-group" style={{ flex: '1 1 260px' }}>
                <label>
                  <i className="fas fa-heading"></i> ชื่อ (English, ไม่บังคับ)
                </label>
                <input type="text" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
              </div>
            </div>

            <div className="form-group">
              <label>
                <i className="fas fa-align-left"></i> คำอธิบายสั้น (ภาษาไทย)
              </label>
              <input
                type="text"
                value={form.descriptionTh}
                placeholder="อธิบายสั้น ๆ ว่าคอร์สนี้เกี่ยวกับอะไร"
                onChange={(e) => setForm({ ...form, descriptionTh: e.target.value })}
              />
            </div>

            <div className="form-group">
              <label>
                <i className="fab fa-markdown"></i> รายละเอียดคอร์ส (Markdown · ไม่บังคับ)
              </label>
              <textarea
                rows={5}
                value={form.overviewTh}
                placeholder={'# สิ่งที่คุณจะได้เรียน\n\n- ...'}
                style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13 }}
                onChange={(e) => setForm({ ...form, overviewTh: e.target.value })}
              />
            </div>

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <div className="form-group" style={{ flex: '1 1 160px' }}>
                <label>
                  <i className="fas fa-tag"></i> หมวดหมู่ (ไม่บังคับ)
                </label>
                <input type="text" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
              </div>
              <div className="form-group" style={{ flex: '0 0 200px' }}>
                <label>
                  <i className="fas fa-baht-sign"></i> ราคา (บาท)
                </label>
                <input
                  type="number"
                  min={0}
                  step="1"
                  value={form.priceBaht}
                  onChange={(e) => setForm({ ...form, priceBaht: e.target.value })}
                />
                <div className="form-hint">ใส่ 0 = คอร์สฟรี (ลงทะเบียนได้ทันทีโดยไม่ต้องชำระเงิน)</div>
              </div>
            </div>

            <div className="form-group">
              <label>
                <i className="fas fa-list-check"></i> บทเรียน/แบบทดสอบในคอร์ส ({form.quizIds.length} รายการ)
              </label>
              <div className="form-hint" style={{ marginBottom: 8 }}>
                เลือกจากแบบทดสอบที่เผยแพร่แล้วและยังไม่ได้อยู่ในคอร์สอื่น — เมื่ออยู่ในคอร์สแล้วจะเข้าเรียนได้เฉพาะผู้ที่ลงทะเบียน
              </div>
              {availableQuizzes.length === 0 ? (
                <div className="form-hint">
                  ยังไม่มีแบบทดสอบที่เพิ่มได้ — สร้างและเผยแพร่แบบทดสอบก่อนที่หน้า "แบบทดสอบออนไลน์"
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 260, overflow: 'auto' }}>
                  {availableQuizzes.map((q) => (
                    <label
                      key={q.id}
                      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', border: '1px solid var(--border, #e5e7eb)', borderRadius: 8, fontWeight: 400 }}
                    >
                      <input type="checkbox" checked={form.quizIds.includes(q.id)} onChange={() => toggleQuiz(q.id)} />
                      <span>{q.titleTh || q.title}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            <div style={{ marginTop: 20, display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-secondary" onClick={closeEditor} disabled={saving}>
                ยกเลิก
              </button>
              <button type="button" className="btn btn-primary" onClick={() => save(false)} disabled={saving}>
                <i className="fas fa-save"></i> {saving ? 'กำลังบันทึก...' : 'บันทึกฉบับร่าง'}
              </button>
              {isAdmin && (
                <button type="button" className="btn btn-success" onClick={() => save(true)} disabled={saving}>
                  <i className="fas fa-cloud-arrow-up"></i> บันทึกและเผยแพร่
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="admin-card">
        <div className="card-title-bar">
          <span className="card-icon">
            <i className="fas fa-layer-group"></i>
          </span>
          <div style={{ flex: 1 }}>
            <h3>คอร์สทั้งหมด</h3>
            <p>จัดการคอร์สเรียน ราคา และดูผู้ที่ลงทะเบียน</p>
          </div>
          {!editorOpen && (
            <button type="button" className="btn btn-primary" onClick={openNew}>
              <i className="fas fa-plus"></i> สร้างคอร์สใหม่
            </button>
          )}
        </div>

        <div className="form-body">
          <div style={{ marginBottom: 14 }}>
            <input
              type="search"
              value={search}
              placeholder="ค้นหาชื่อคอร์ส..."
              style={{ width: '100%' }}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          {courses === null && !loadFailed && <div className="loader"></div>}
          {loadFailed && <div className="form-hint">โหลดรายการคอร์สไม่สำเร็จ กรุณาลองใหม่อีกครั้ง</div>}
          {courses && filtered.length === 0 && (
            <div className="empty-state">
              <div className="empty-title">ยังไม่มีคอร์ส</div>
              <div className="empty-sub">กดปุ่ม "สร้างคอร์สใหม่" เพื่อเริ่มต้น</div>
            </div>
          )}

          <div className="row-list">
            {filtered.map((course) => (
              <div key={course.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 4px', borderBottom: '1px solid var(--border, #eee)', flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 260px', minWidth: 0 }}>
                  <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {course.titleTh || course.title}
                    <span style={{ fontSize: 12, padding: '2px 8px', borderRadius: 999, background: 'var(--surface-2, #f1f5f9)' }}>
                      {STATUS_LABEL[course.status]}
                    </span>
                  </div>
                  <div className="form-hint" style={{ marginTop: 2 }}>
                    {course.priceSatang > 0 ? `฿${formatBaht(course.priceSatang)}` : 'ฟรี'} · {course.itemCount} บทเรียน · ลงทะเบียน {course.enrollCount} คน
                    {course.category ? ` · ${course.category}` : ''}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button type="button" className="btn btn-secondary" style={{ padding: '6px 11px' }} onClick={() => openEnrollments(course)}>
                    <i className="fas fa-users"></i> ผู้ลงทะเบียน
                  </button>
                  <button type="button" className="btn btn-secondary" style={{ padding: '6px 11px' }} onClick={() => openEdit(course.id)}>
                    <i className="fas fa-pen"></i> แก้ไข
                  </button>
                  {isAdmin && course.status !== 'published' && (
                    <button type="button" className="btn btn-success" style={{ padding: '6px 11px' }} onClick={() => changeStatus(course, 'published')}>
                      <i className="fas fa-cloud-arrow-up"></i> เผยแพร่
                    </button>
                  )}
                  {isAdmin && course.status === 'published' && (
                    <button type="button" className="btn btn-secondary" style={{ padding: '6px 11px' }} onClick={() => changeStatus(course, 'archived')}>
                      <i className="fas fa-box-archive"></i> เก็บถาวร
                    </button>
                  )}
                  <button type="button" className="btn btn-danger" style={{ padding: '6px 11px' }} onClick={() => remove(course)}>
                    <i className="fas fa-trash"></i>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {enrollFor && (
        <div className="modal-overlay" style={{ display: 'flex' }} onClick={() => setEnrollFor(null)}>
          <div className="admin-card" style={{ maxWidth: 720, width: '92%', maxHeight: '82vh', overflow: 'auto' }} onClick={(e) => e.stopPropagation()}>
            <div className="card-title-bar">
              <span className="card-icon">
                <i className="fas fa-users"></i>
              </span>
              <div style={{ flex: 1 }}>
                <h3>ผู้ลงทะเบียน — {enrollFor.titleTh || enrollFor.title}</h3>
                <p>นักเรียนที่ชำระเงินและเข้าเรียนคอร์สนี้ได้</p>
              </div>
              <button type="button" className="btn btn-secondary" onClick={() => setEnrollFor(null)}>
                <i className="fas fa-xmark"></i>
              </button>
            </div>
            <div className="form-body">
              {enrollments === null && <div className="loader"></div>}
              {enrollments && enrollments.length === 0 && (
                <div className="empty-state">
                  <div className="empty-title">ยังไม่มีผู้ลงทะเบียน</div>
                </div>
              )}
              {enrollments && enrollments.length > 0 && (
                <div className="row-list">
                  {enrollments.map((e) => (
                    <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 4px', borderBottom: '1px solid var(--border, #eee)' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600 }}>{e.studentNickname || e.studentName || e.studentId}</div>
                        <div className="form-hint">{e.studentId} · {new Date(e.enrolledAt).toLocaleString('th-TH')}</div>
                      </div>
                      <div style={{ fontWeight: 700 }}>{e.amount > 0 ? `฿${e.amount.toLocaleString('th-TH')}` : 'ฟรี'}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
