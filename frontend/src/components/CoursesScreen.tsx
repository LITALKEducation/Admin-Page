import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { useMe } from '../hooks/useMe';
import { useToast } from '../ui/ToastContext';
import { useConfirm } from '../ui/ConfirmContext';
import Checkbox from './Checkbox';
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
  uploadCourseCover,
  fetchCourseCoverBlob,
  type CourseSummary,
  type CourseStatus,
  type CourseItemKind,
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
  // Blank = no promotion. When set below the price it's an active sale.
  discountBaht: string;
  includedInPlus: boolean;
  // datetime-local value (local time). Blank = open immediately; a future
  // value puts the course in "coming soon" mode until then.
  availableAtLocal: string;
  items: { quizId: number; kind: CourseItemKind }[];
}

// Listed in the order a learner meets them, so the dropdown reads as the
// course path. The two exams are LITALK+ only and the Worker enforces that
// (courseGateForQuiz) — the label says so because an author picking a role
// here is deciding who can reach it.
const KIND_LABEL: Record<CourseItemKind, string> = {
  pretest: 'Pretest (แบบทดสอบก่อนเรียน)',
  lesson: 'บทเรียน',
  midterm: 'สอบกลางภาค (สมาชิก LITALK+)',
  posttest: 'Posttest (แบบทดสอบหลังเรียน)',
  final: 'สอบปลายภาค (สมาชิก LITALK+)',
};

// One of each per course. A second "final" would make "the final exam"
// ambiguous for the sequencing gate, which unlocks on exactly one.
const SINGLETON_KINDS: CourseItemKind[] = ['pretest', 'midterm', 'posttest', 'final'];

const EMPTY_FORM: CourseForm = {
  title: '',
  titleTh: '',
  description: '',
  descriptionTh: '',
  overviewTh: '',
  category: '',
  priceBaht: '0',
  discountBaht: '',
  includedInPlus: false,
  availableAtLocal: '',
  items: [],
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

// A course is "coming soon" when its launch time is set and still in the future.
function isComingSoon(availableAt: string | null): boolean {
  if (!availableAt) return false;
  const t = new Date(availableAt).getTime();
  return !Number.isNaN(t) && t > Date.now();
}

// ISO (UTC) -> value for <input type="datetime-local"> (the admin's local time).
function isoToLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
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

  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [coverUploading, setCoverUploading] = useState(false);

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

  const loadCover = async (id: number, hasCover: boolean) => {
    if (!hasCover) {
      setCoverUrl(null);
      return;
    }
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      const blob = await fetchCourseCoverBlob(getToken, id);
      setCoverUrl(URL.createObjectURL(blob));
    } catch {
      setCoverUrl(null);
    }
  };

  const onPickCover = async (file: File | null) => {
    if (!file || !editingId) return;
    if (file.size > 4 * 1024 * 1024) {
      showToast('ตรวจสอบไฟล์', 'รูปภาพใหญ่เกินไป (สูงสุด 4 MB)', 'error');
      return;
    }
    setCoverUploading(true);
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      await uploadCourseCover(getToken, editingId, file);
      setCoverUrl(URL.createObjectURL(file));
      showToast('อัปโหลดภาพปกแล้ว', undefined, 'success');
      load();
    } catch (error) {
      showToast('อัปโหลดภาพปกไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
    setCoverUploading(false);
  };

  const openNew = async () => {
    setCoverUrl(null);
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
      await loadCover(id, !!course.hasCover);
      const cloudForm: CourseForm = {
        title: course.title,
        titleTh: course.titleTh ?? '',
        description: course.description ?? '',
        descriptionTh: course.descriptionTh ?? '',
        overviewTh: course.overviewTh ?? '',
        category: course.category ?? '',
        priceBaht: String((course.priceSatang ?? 0) / 100),
        discountBaht: course.discountSatang == null ? '' : String(course.discountSatang / 100),
        includedInPlus: !!course.includedInPlus,
        availableAtLocal: isoToLocalInput(course.availableAt),
        items: items.map((it) => ({ quizId: it.quizId, kind: it.kind })),
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
      items: f.items.some((it) => it.quizId === quizId)
        ? f.items.filter((it) => it.quizId !== quizId)
        : [...f.items, { quizId, kind: 'lesson' as CourseItemKind }],
    }));
  };

  const setItemKind = (quizId: number, kind: CourseItemKind) => {
    setForm((f) => ({
      ...f,
      // One pretest, one midterm, one posttest and one final per course —
      // assigning a role moves it off whoever held it before.
      items: f.items.map((it) => {
        if (it.quizId === quizId) return { ...it, kind };
        if (SINGLETON_KINDS.includes(kind) && it.kind === kind) return { ...it, kind: 'lesson' as CourseItemKind };
        return it;
      }),
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
    const hasDiscount = form.discountBaht.trim() !== '';
    const discountBaht = Number(form.discountBaht);
    if (hasDiscount && (!Number.isFinite(discountBaht) || discountBaht < 0)) {
      showToast('ตรวจสอบข้อมูล', 'ราคาโปรโมชันไม่ถูกต้อง', 'error');
      return;
    }
    if (hasDiscount && discountBaht >= priceBaht) {
      showToast('ตรวจสอบข้อมูล', 'ราคาโปรโมชันต้องน้อยกว่าราคาปกติ', 'error');
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
        discountSatang: hasDiscount ? Math.round(discountBaht * 100) : null,
        includedInPlus: form.includedInPlus ? 1 : 0,
        // Convert the local datetime to a UTC ISO string here (in the admin's
        // timezone) so the server stores the exact instant.
        availableAt: form.availableAtLocal.trim() ? new Date(form.availableAtLocal).toISOString() : null,
        currency: 'thb',
        items: form.items,
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
                <i className="fas fa-image"></i> ภาพปกคอร์ส
              </label>
              {editingId ? (
                <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                  <div
                    style={{
                      width: 160,
                      height: 90,
                      borderRadius: 10,
                      border: '1px solid var(--border-color, #e5e7eb)',
                      background: coverUrl ? `center/cover no-repeat url(${coverUrl})` : 'var(--bg-tertiary, #f1f3f7)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: 'var(--text-secondary, #999)',
                      flex: '0 0 auto',
                    }}
                  >
                    {!coverUrl && <i className="fas fa-image" style={{ fontSize: 22 }}></i>}
                  </div>
                  <div>
                    <label className="btn btn-secondary" style={{ cursor: 'pointer' }}>
                      <i className="fas fa-cloud-arrow-up"></i> {coverUploading ? 'กำลังอัปโหลด...' : coverUrl ? 'เปลี่ยนภาพปก' : 'อัปโหลดภาพปก'}
                      <input
                        type="file"
                        accept="image/*"
                        style={{ display: 'none' }}
                        disabled={coverUploading}
                        onChange={(e) => {
                          onPickCover(e.target.files?.[0] || null);
                          e.target.value = '';
                        }}
                      />
                    </label>
                    <div className="form-hint">JPG, PNG, WEBP · สูงสุด 4 MB · แนะนำอัตราส่วน 16:9</div>
                  </div>
                </div>
              ) : (
                <div className="form-hint">บันทึกคอร์สก่อน จึงจะเพิ่มภาพปกได้</div>
              )}
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
              <div className="form-group" style={{ flex: '0 0 160px' }}>
                <label>
                  <i className="fas fa-baht-sign"></i> ราคาปกติ (บาท)
                </label>
                <input
                  type="number"
                  min={0}
                  step="1"
                  value={form.priceBaht}
                  onChange={(e) => setForm({ ...form, priceBaht: e.target.value })}
                />
                <div className="form-hint">ใส่ 0 = คอร์สฟรี</div>
              </div>
              <div className="form-group" style={{ flex: '0 0 180px' }}>
                <label>
                  <i className="fas fa-tags"></i> ราคาโปรโมชัน (บาท)
                </label>
                <input
                  type="number"
                  min={0}
                  step="1"
                  value={form.discountBaht}
                  placeholder="เว้นว่าง = ไม่มีโปร"
                  onChange={(e) => setForm({ ...form, discountBaht: e.target.value })}
                />
                <div className="form-hint">
                  {form.discountBaht.trim() !== '' && Number(form.discountBaht) < Number(form.priceBaht)
                    ? `ลด ${Math.round((1 - Number(form.discountBaht) / Number(form.priceBaht)) * 100)}% · โปรโมทหน้าแรก`
                    : 'ต่ำกว่าราคาปกติ เพื่อดึงขึ้นโปรหน้าแรก'}
                </div>
              </div>
            </div>

            <div className="form-group">
              <Checkbox
                checked={form.includedInPlus}
                onChange={(v) => setForm({ ...form, includedInPlus: v })}
              >
                <span>
                  รวมอยู่ในแพ็กเกจ <strong>LITALK+</strong> (สมาชิกรายเดือน — เร็ว ๆ นี้)
                </span>
              </Checkbox>
              <div className="form-hint">เตรียมไว้สำหรับระบบสมัครสมาชิก LITALK+ ในอนาคต ยังไม่มีผลต่อการซื้อคอร์สตอนนี้</div>
            </div>

            <div className="form-group">
              <label>
                <i className="fas fa-clock"></i> เปิดให้ลงทะเบียนเมื่อ (โหมด "เร็ว ๆ นี้")
              </label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  type="datetime-local"
                  value={form.availableAtLocal}
                  style={{ maxWidth: 260 }}
                  onChange={(e) => setForm({ ...form, availableAtLocal: e.target.value })}
                />
                {form.availableAtLocal && (
                  <button type="button" className="btn btn-secondary" style={{ padding: '6px 11px' }} onClick={() => setForm({ ...form, availableAtLocal: '' })}>
                    <i className="fas fa-xmark"></i> ล้าง
                  </button>
                )}
              </div>
              <div className="form-hint">
                {form.availableAtLocal && new Date(form.availableAtLocal).getTime() > Date.now()
                  ? `คอร์สจะแสดงแบบ "เร็ว ๆ นี้" พร้อมนับถอยหลัง และจะเปิดให้ลงทะเบียนอัตโนมัติเมื่อ ${fmtDateTime(new Date(form.availableAtLocal).toISOString())}`
                  : 'เว้นว่าง = เปิดให้ลงทะเบียนทันทีที่เผยแพร่ · ตั้งวัน–เวลาในอนาคตเพื่อเปิดเป็นโหมดเร็ว ๆ นี้'}
              </div>
            </div>

            <div className="form-group">
              <label>
                <i className="fas fa-list-check"></i> บทเรียน/แบบทดสอบในคอร์ส ({form.items.length} รายการ)
              </label>
              <div className="form-hint" style={{ marginBottom: 8 }}>
                เลือกแบบทดสอบที่จะรวมในคอร์ส แล้วกำหนดบทบาท — นักเรียนต้องทำ <strong>Pretest</strong> ก่อน จากนั้นเรียน{' '}
                <strong>บทเรียน</strong> (ดูวีดีโอ + ทำแบบทดสอบ) ให้ครบ จึงจะทำ <strong>Posttest</strong> ได้
              </div>
              {availableQuizzes.length === 0 ? (
                <div className="form-hint">
                  ยังไม่มีแบบทดสอบที่เพิ่มได้ — สร้างและเผยแพร่แบบทดสอบก่อนที่หน้า "แบบทดสอบออนไลน์"
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 320, overflow: 'auto' }}>
                  {availableQuizzes.map((q) => {
                    const item = form.items.find((it) => it.quizId === q.id);
                    return (
                      <div
                        key={q.id}
                        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', border: '1px solid var(--border-color, #e5e7eb)', borderRadius: 8, flexWrap: 'wrap' }}
                      >
                        <Checkbox checked={!!item} onChange={() => toggleQuiz(q.id)}>
                          {q.titleTh || q.title}
                        </Checkbox>
                        {item && (
                          <select
                            value={item.kind}
                            style={{ maxWidth: 240 }}
                            onChange={(e) => setItemKind(q.id, e.target.value as CourseItemKind)}
                          >
                            {(Object.keys(KIND_LABEL) as CourseItemKind[]).map((k) => (
                              <option key={k} value={k}>
                                {KIND_LABEL[k]}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    );
                  })}
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
              <div key={course.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 4px', borderBottom: '1px solid var(--border-color, #eee)', flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 260px', minWidth: 0 }}>
                  <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {course.titleTh || course.title}
                    <span style={{ fontSize: 12, padding: '2px 8px', borderRadius: 999, background: 'var(--bg-tertiary, #f1f5f9)' }}>
                      {STATUS_LABEL[course.status]}
                    </span>
                    {course.discountSatang != null && course.discountSatang < course.priceSatang && (
                      <span style={{ fontSize: 12, padding: '2px 8px', borderRadius: 999, background: '#fde8e8', color: '#c81e1e' }}>
                        <i className="fas fa-tags"></i> ลดราคา
                      </span>
                    )}
                    {course.includedInPlus ? (
                      <span style={{ fontSize: 12, padding: '2px 8px', borderRadius: 999, background: '#fff4d6', color: '#a97400' }}>
                        LITALK+
                      </span>
                    ) : null}
                    {isComingSoon(course.availableAt) && (
                      <span style={{ fontSize: 12, padding: '2px 8px', borderRadius: 999, background: '#e0edff', color: '#1e40af' }}>
                        <i className="fas fa-clock"></i> เร็ว ๆ นี้ · {fmtDateTime(course.availableAt)}
                      </span>
                    )}
                  </div>
                  <div className="form-hint" style={{ marginTop: 2 }}>
                    {course.discountSatang != null && course.discountSatang < course.priceSatang ? (
                      <>
                        <span style={{ textDecoration: 'line-through', opacity: 0.6 }}>฿{formatBaht(course.priceSatang)}</span>{' '}
                        <strong>{course.discountSatang > 0 ? `฿${formatBaht(course.discountSatang)}` : 'ฟรี'}</strong>
                      </>
                    ) : course.priceSatang > 0 ? (
                      `฿${formatBaht(course.priceSatang)}`
                    ) : (
                      'ฟรี'
                    )}{' '}
                    · {course.itemCount} บทเรียน · ลงทะเบียน {course.enrollCount} คน
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
        <div className="modal-overlay active" onClick={() => setEnrollFor(null)}>
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
                    <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 4px', borderBottom: '1px solid var(--border-color, #eee)' }}>
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
