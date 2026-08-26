import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { useMe } from '../hooks/useMe';
import { useToast } from '../ui/ToastContext';
import { useConfirm } from '../ui/ConfirmContext';
import {
  makeTokenGetter,
  fetchQuizzes,
  fetchQuiz,
  createQuiz,
  updateQuiz,
  setQuizStatusApi,
  deleteQuizApi,
  fetchQuizAttempts,
  uploadQuizVideo,
  deleteQuizVideo,
  uploadQuizSlides,
  deleteQuizSlides,
  type QuizSummary,
  type QuizVideoFile,
  type QuizSlideFile,
  type QuizQuestion,
  type QuizStatus,
  type QuestionType,
  type QuizAudience,
  type QuizAttemptRow,
} from '../api/client';
import { formatFileSize } from '../utils/format';
import { quizCsvTemplate, questionsToCsv, csvToQuestions, multiQuizCsvTemplate, csvToQuizzes } from '../utils/quizCsv';

const AUDIENCE_LABEL: Record<QuizAudience, string> = {
  on_demand: 'เรียน On Demand',
  tutored: 'เรียนตัวต่อตัวกับครู',
};

const STATUS_LABEL: Record<QuizStatus, string> = {
  draft: 'ฉบับร่าง',
  published: 'เผยแพร่แล้ว',
  archived: 'เก็บถาวร',
};

const TYPE_LABEL: Record<QuestionType, string> = {
  single: 'เลือกตอบข้อเดียว',
  multiple: 'เลือกตอบหลายข้อ',
  truefalse: 'จริง / เท็จ',
  short: 'เติมคำตอบสั้น',
};

// Trigger a client-side download of a CSV string. The UTF-8 BOM makes Excel
// open Thai text correctly instead of as garbled bytes.
function downloadCsv(filename: string, text: string) {
  const blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

interface QuizForm {
  title: string;
  titleTh: string;
  description: string;
  descriptionTh: string;
  lesson: string;
  lessonTh: string;
  videoUrl: string;
  category: string;
  audience: QuizAudience;
  timeLimitMin: string;
  passScore: string;
  allowRetake: boolean;
  showAnswers: boolean;
}

const EMPTY_FORM: QuizForm = {
  title: '',
  titleTh: '',
  description: '',
  descriptionTh: '',
  lesson: '',
  lessonTh: '',
  videoUrl: '',
  category: '',
  audience: 'on_demand',
  timeLimitMin: '',
  passScore: '0',
  allowRetake: true,
  showAnswers: true,
};

// ----- On-device editor auto-save -----
// While a quiz is being authored, the whole editor (metadata + questions) is
// kept on THIS device only (localStorage). Nothing reaches the cloud until
// "บันทึก" is pressed, so a reload, an accidental navigation, or a closed tab
// never loses work-in-progress — and unsaved drafts never hit the server.
interface EditorDraft {
  form: QuizForm;
  questions: QuizQuestion[];
  savedAt: number;
}

function editorDraftKey(id: number | null): string {
  return `litalk_quiz_editor_${id ?? 'new'}`;
}

function readEditorDraft(id: number | null): EditorDraft | null {
  try {
    const raw = localStorage.getItem(editorDraftKey(id));
    return raw ? (JSON.parse(raw) as EditorDraft) : null;
  } catch {
    return null;
  }
}

function writeEditorDraft(id: number | null, draft: EditorDraft): void {
  try {
    localStorage.setItem(editorDraftKey(id), JSON.stringify(draft));
  } catch {
    /* quota / private mode — auto-save is best-effort */
  }
}

function clearEditorDraft(id: number | null): void {
  try {
    localStorage.removeItem(editorDraftKey(id));
  } catch {
    /* ignore */
  }
}

// A fresh question of a given type, pre-seeded so its `answer` already has a
// valid shape (the grading code and the server validator both expect it).
function blankQuestion(type: QuestionType = 'single'): QuizQuestion {
  const base = { type, prompt: '', explanation: '', points: 1 };
  switch (type) {
    case 'single':
      return { ...base, options: ['', ''], answer: 0 };
    case 'multiple':
      return { ...base, options: ['', ''], answer: [] };
    case 'truefalse':
      return { ...base, options: [], answer: true };
    case 'short':
      return { ...base, options: [], answer: [''] };
  }
}

// Converts a question loaded from the server (answer already in wire shape)
// into the editable shape — for `short` we keep the accepted answers as an
// array the textarea joins with newlines.
function toEditable(q: QuizQuestion): QuizQuestion {
  return {
    ...q,
    options: Array.isArray(q.options) ? q.options : [],
    explanation: q.explanation ?? '',
  };
}

function QuestionEditor({
  q,
  index,
  onChange,
  onRemove,
  onMove,
}: {
  q: QuizQuestion;
  index: number;
  onChange: (next: QuizQuestion) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const setType = (type: QuestionType) => onChange(blankQuestion(type));
  const options = q.options ?? [];

  const setOption = (i: number, value: string) => {
    const next = [...options];
    next[i] = value;
    onChange({ ...q, options: next });
  };
  const addOption = () => onChange({ ...q, options: [...options, ''] });
  const removeOption = (i: number) => {
    const next = options.filter((_, idx) => idx !== i);
    // Keep the marked-correct answer(s) pointing at the right rows.
    let answer = q.answer;
    if (q.type === 'single') {
      const cur = Number(q.answer);
      answer = cur === i ? 0 : cur > i ? cur - 1 : cur;
    } else if (q.type === 'multiple') {
      answer = (Array.isArray(q.answer) ? q.answer : [])
        .filter((n) => Number(n) !== i)
        .map((n) => (Number(n) > i ? Number(n) - 1 : Number(n)));
    }
    onChange({ ...q, options: next, answer });
  };

  const toggleMultiple = (i: number) => {
    const set = new Set((Array.isArray(q.answer) ? q.answer : []).map((n) => Number(n)));
    if (set.has(i)) set.delete(i);
    else set.add(i);
    onChange({ ...q, answer: [...set].sort((a, b) => a - b) });
  };

  return (
    <div className="admin-card" style={{ marginBottom: 14 }}>
      <div className="card-title-bar" style={{ alignItems: 'center' }}>
        <span className="card-icon">
          <i className="fas fa-circle-question"></i>
        </span>
        <div style={{ flex: 1 }}>
          <h3 style={{ margin: 0 }}>ข้อ {index + 1}</h3>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" className="btn btn-secondary" style={{ padding: '5px 9px' }} onClick={() => onMove(-1)} title="เลื่อนขึ้น">
            <i className="fas fa-arrow-up"></i>
          </button>
          <button type="button" className="btn btn-secondary" style={{ padding: '5px 9px' }} onClick={() => onMove(1)} title="เลื่อนลง">
            <i className="fas fa-arrow-down"></i>
          </button>
          <button type="button" className="btn btn-danger" style={{ padding: '5px 9px' }} onClick={onRemove} title="ลบคำถาม">
            <i className="fas fa-trash"></i>
          </button>
        </div>
      </div>

      <div className="form-body">
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div className="form-group" style={{ flex: '1 1 220px' }}>
            <label>
              <i className="fas fa-list-check"></i> ประเภทคำถาม
            </label>
            <select value={q.type} onChange={(e) => setType(e.target.value as QuestionType)}>
              {(Object.keys(TYPE_LABEL) as QuestionType[]).map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group" style={{ flex: '0 0 120px' }}>
            <label>
              <i className="fas fa-star"></i> คะแนน
            </label>
            <input
              type="number"
              min={1}
              max={100}
              value={q.points}
              onChange={(e) => onChange({ ...q, points: Math.max(1, Number(e.target.value) || 1) })}
            />
          </div>
        </div>

        <div className="form-group">
          <label>
            <i className="fas fa-align-left"></i> คำถาม
          </label>
          <textarea
            rows={2}
            value={q.prompt}
            placeholder="พิมพ์คำถามที่นี่..."
            onChange={(e) => onChange({ ...q, prompt: e.target.value })}
          />
        </div>

        {(q.type === 'single' || q.type === 'multiple') && (
          <div className="form-group">
            <label>
              <i className="fas fa-check-double"></i> ตัวเลือก{' '}
              <span className="form-hint" style={{ display: 'inline' }}>
                ({q.type === 'single' ? 'เลือกวงกลมหน้าคำตอบที่ถูก' : 'ติ๊กหน้าคำตอบที่ถูกได้หลายข้อ'})
              </span>
            </label>
            {options.map((opt, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                {q.type === 'single' ? (
                  <input
                    type="radio"
                    name={`correct-${index}`}
                    checked={Number(q.answer) === i}
                    onChange={() => onChange({ ...q, answer: i })}
                    title="ทำเครื่องหมายว่าเป็นคำตอบที่ถูก"
                  />
                ) : (
                  <input
                    type="checkbox"
                    checked={(Array.isArray(q.answer) ? q.answer : []).map(Number).includes(i)}
                    onChange={() => toggleMultiple(i)}
                  />
                )}
                <input
                  type="text"
                  value={opt}
                  placeholder={`ตัวเลือกที่ ${i + 1}`}
                  style={{ flex: 1 }}
                  onChange={(e) => setOption(i, e.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ padding: '5px 9px' }}
                  onClick={() => removeOption(i)}
                  disabled={options.length <= 2}
                  title="ลบตัวเลือก"
                >
                  <i className="fas fa-xmark"></i>
                </button>
              </div>
            ))}
            <button type="button" className="btn btn-secondary" style={{ padding: '5px 11px' }} onClick={addOption}>
              <i className="fas fa-plus"></i> เพิ่มตัวเลือก
            </button>
          </div>
        )}

        {q.type === 'truefalse' && (
          <div className="form-group">
            <label>
              <i className="fas fa-scale-balanced"></i> คำตอบที่ถูก
            </label>
            <div style={{ display: 'flex', gap: 18 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 400 }}>
                <input type="radio" name={`tf-${index}`} checked={q.answer === true} onChange={() => onChange({ ...q, answer: true })} />{' '}
                จริง (True)
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 400 }}>
                <input type="radio" name={`tf-${index}`} checked={q.answer === false} onChange={() => onChange({ ...q, answer: false })} />{' '}
                เท็จ (False)
              </label>
            </div>
          </div>
        )}

        {q.type === 'short' && (
          <div className="form-group">
            <label>
              <i className="fas fa-keyboard"></i> คำตอบที่ยอมรับ (บรรทัดละหนึ่งคำตอบ)
            </label>
            <textarea
              rows={2}
              value={(Array.isArray(q.answer) ? q.answer : []).join('\n')}
              placeholder={'คำตอบที่ถูก\nคำตอบสำรอง (ถ้ามี)'}
              onChange={(e) => onChange({ ...q, answer: e.target.value.split('\n') })}
            />
            <div className="form-hint">ระบบตรวจโดยไม่สนตัวพิมพ์เล็ก-ใหญ่ ใส่ได้หลายคำตอบที่ถือว่าถูก</div>
          </div>
        )}

        <div className="form-group">
          <label>
            <i className="fas fa-circle-info"></i> คำอธิบายเฉลย (ไม่บังคับ)
          </label>
          <textarea
            rows={2}
            value={q.explanation ?? ''}
            placeholder="อธิบายว่าทำไมคำตอบนี้ถึงถูก — แสดงให้นักเรียนหลังส่งคำตอบ"
            onChange={(e) => onChange({ ...q, explanation: e.target.value })}
          />
        </div>
      </div>
    </div>
  );
}

export default function QuizzesScreen() {
  const { getAccessTokenSilently } = useAuth0();
  const { isAdmin } = useMe();
  const showToast = useToast();
  const confirmDialog = useConfirm();

  const [quizzes, setQuizzes] = useState<QuizSummary[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [audienceFilter, setAudienceFilter] = useState('');

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<QuizForm>(EMPTY_FORM);
  const [questions, setQuestions] = useState<QuizQuestion[]>([]);
  const [saving, setSaving] = useState(false);
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null);

  // The lesson's uploaded video, kept apart from `form` because it is not part
  // of the save: it lands in R2 and in the row the moment the upload finishes,
  // so it is never in the on-device draft either.
  const [videoFile, setVideoFile] = useState<QuizVideoFile | null>(null);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const uploadAbort = useRef<AbortController | null>(null);

  // The lesson's slide deck. Same "not part of the save" reasoning as the
  // video above — it lands in R2 and in the row the moment it uploads.
  const [slideFile, setSlideFile] = useState<QuizSlideFile | null>(null);
  const [slidesBusy, setSlidesBusy] = useState(false);

  const [resultsFor, setResultsFor] = useState<QuizSummary | null>(null);
  const [attempts, setAttempts] = useState<QuizAttemptRow[] | null>(null);

  const load = useCallback(async () => {
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      const res = await fetchQuizzes(getToken);
      setQuizzes(res.quizzes);
      setLoadFailed(false);
    } catch (error) {
      console.error('loadQuizzes:', error);
      setLoadFailed(true);
      setQuizzes(null);
    }
  }, [getAccessTokenSilently]);

  useEffect(() => {
    load();
  }, [load]);

  // Persist the open editor to this device on every change. Runs on open too
  // (writing the initial snapshot) and on each keystroke — cheap, synchronous,
  // and never leaves the browser.
  useEffect(() => {
    if (!editorOpen) return;
    const savedAt = Date.now();
    writeEditorDraft(editingId, { form, questions, savedAt });
    setDraftSavedAt(savedAt);
  }, [editorOpen, editingId, form, questions]);

  const filtered = useMemo(() => {
    if (!quizzes) return [];
    const term = search.trim().toLowerCase();
    return quizzes.filter((q) => {
      if (statusFilter && q.status !== statusFilter) return false;
      if (audienceFilter && q.audience !== audienceFilter) return false;
      if (!term) return true;
      return `${q.title} ${q.titleTh ?? ''} ${q.category ?? ''}`.toLowerCase().includes(term);
    });
  }, [quizzes, search, statusFilter, audienceFilter]);

  const openNew = async () => {
    setVideoFile(null);
    setSlideFile(null);
    const draft = readEditorDraft(null);
    if (
      draft?.form &&
      (await confirmDialog('พบฉบับร่างที่บันทึกไว้บนอุปกรณ์นี้ (ยังไม่ได้บันทึกขึ้นคลาวด์) ต้องการกู้คืนหรือไม่?', {
        title: 'กู้คืนฉบับร่าง',
        okLabel: 'กู้คืนฉบับร่าง',
      }))
    ) {
      setEditingId(null);
      setForm(draft.form);
      setQuestions(draft.questions?.length ? draft.questions : [blankQuestion('single')]);
      setEditorOpen(true);
      return;
    }
    clearEditorDraft(null);
    setEditingId(null);
    setForm(EMPTY_FORM);
    setQuestions([blankQuestion('single')]);
    setEditorOpen(true);
  };

  const openEdit = async (id: number) => {
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      const { quiz, questions: qs } = await fetchQuiz(getToken, id);
      // Set before the draft branch below returns: the uploaded video belongs
      // to the saved quiz, not to whatever draft the device is holding.
      setVideoFile({ hasVideoFile: quiz.hasVideoFile ?? 0, videoName: quiz.videoName, videoSize: quiz.videoSize });
      setSlideFile({ hasSlides: quiz.hasSlides ?? 0, slideName: quiz.slideName, slideSize: quiz.slideSize });
      const draft = readEditorDraft(id);
      if (
        draft?.form &&
        (await confirmDialog('พบฉบับร่างของแบบทดสอบนี้ที่บันทึกไว้บนอุปกรณ์ (ยังไม่ได้บันทึกขึ้นคลาวด์) ต้องการกู้คืนหรือไม่?', {
          title: 'กู้คืนฉบับร่าง',
          okLabel: 'กู้คืนฉบับร่าง',
        }))
      ) {
        setEditingId(id);
        setForm(draft.form);
        setQuestions(draft.questions?.length ? draft.questions : [blankQuestion('single')]);
        setEditorOpen(true);
        return;
      }
      clearEditorDraft(id);
      setEditingId(id);
      setForm({
        title: quiz.title,
        titleTh: quiz.titleTh ?? '',
        description: quiz.description ?? '',
        descriptionTh: quiz.descriptionTh ?? '',
        lesson: quiz.lesson ?? '',
        lessonTh: quiz.lessonTh ?? '',
        videoUrl: quiz.videoUrl ?? '',
        category: quiz.category ?? '',
        audience: (quiz.audience as QuizAudience) ?? 'on_demand',
        timeLimitMin: quiz.timeLimitMin != null ? String(quiz.timeLimitMin) : '',
        passScore: String(quiz.passScore ?? 0),
        allowRetake: quiz.allowRetake === 1,
        showAnswers: quiz.showAnswers === 1,
      });
      setQuestions(qs.length ? qs.map(toEditable) : [blankQuestion('single')]);
      setEditorOpen(true);
    } catch (error) {
      showToast('เปิดแบบทดสอบไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const closeEditor = () => {
    uploadAbort.current?.abort();
    setUploadPct(null);
    setEditorOpen(false);
    setEditingId(null);
  };

  /* ----- Lesson video hosted in R2 (worker/src/video.ts) ----- */

  const pickVideo = async (file: File) => {
    if (!editingId) return;
    const controller = new AbortController();
    uploadAbort.current = controller;
    setUploadPct(0);
    try {
      const res = await uploadQuizVideo(
        makeTokenGetter(getAccessTokenSilently),
        editingId,
        file,
        setUploadPct,
        controller.signal,
      );
      setVideoFile({ hasVideoFile: 1, videoName: file.name, videoSize: res.size });
      showToast('อัปโหลดวีดีโอแล้ว', file.name, 'success');
    } catch (error) {
      if ((error as Error)?.name !== 'AbortError') {
        showToast('อัปโหลดวีดีโอไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
      }
    } finally {
      uploadAbort.current = null;
      setUploadPct(null);
    }
  };

  /* ----- Lesson slides, a LITALK+ benefit (worker/src/slides.ts) ----- */

  const pickSlides = async (file: File) => {
    if (!editingId) return;
    setSlidesBusy(true);
    try {
      const res = await uploadQuizSlides(makeTokenGetter(getAccessTokenSilently), editingId, file);
      setSlideFile({ hasSlides: 1, slideName: file.name, slideSize: res.size });
      showToast('อัปโหลดสไลด์แล้ว', file.name, 'success');
    } catch (error) {
      showToast('อัปโหลดสไลด์ไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    } finally {
      setSlidesBusy(false);
    }
  };

  const removeSlides = async () => {
    if (!editingId) return;
    if (!(await confirmDialog('ลบสไลด์ของบทเรียนนี้?', { title: 'ลบสไลด์', okLabel: 'ลบสไลด์', danger: true }))) return;
    try {
      await deleteQuizSlides(makeTokenGetter(getAccessTokenSilently), editingId);
      setSlideFile({ hasSlides: 0, slideName: null, slideSize: null });
      showToast('ลบสไลด์แล้ว', undefined, 'success');
    } catch (error) {
      showToast('ลบสไลด์ไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const removeVideo = async () => {
    if (!editingId) return;
    if (!(await confirmDialog('ลบวีดีโอการสอนของแบบทดสอบนี้?', { title: 'ลบวีดีโอ', okLabel: 'ลบวีดีโอ', danger: true }))) return;
    try {
      await deleteQuizVideo(makeTokenGetter(getAccessTokenSilently), editingId);
      setVideoFile({ hasVideoFile: 0, videoName: null, videoSize: null });
      showToast('ลบวีดีโอแล้ว', undefined, 'success');
    } catch (error) {
      showToast('ลบวีดีโอไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  // Turn the editor's questions into the wire shape, trimming empty option
  // rows and empty short-answer lines the same way the server validator will.
  const cleanQuestions = (): QuizQuestion[] =>
    questions.map((q) => {
      if (q.type === 'short') {
        return { ...q, answer: (Array.isArray(q.answer) ? q.answer : []).map((s) => String(s).trim()).filter(Boolean) };
      }
      return q;
    });

  const validate = (): string | null => {
    if (!form.title.trim() && !form.titleTh.trim()) return 'กรุณากรอกชื่อแบบทดสอบ';
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (!q.prompt.trim()) return `ข้อ ${i + 1}: กรุณากรอกคำถาม`;
      if (q.type === 'single' || q.type === 'multiple') {
        const opts = (q.options ?? []).map((o) => o.trim()).filter(Boolean);
        if (opts.length < 2) return `ข้อ ${i + 1}: ต้องมีตัวเลือกอย่างน้อย 2 ข้อ`;
        if (q.type === 'multiple' && (!Array.isArray(q.answer) || q.answer.length === 0))
          return `ข้อ ${i + 1}: กรุณาเลือกคำตอบที่ถูกอย่างน้อยหนึ่งข้อ`;
      }
      if (q.type === 'short' && (Array.isArray(q.answer) ? q.answer : []).every((s) => !String(s).trim()))
        return `ข้อ ${i + 1}: กรุณากรอกคำตอบที่ยอมรับได้`;
    }
    return null;
  };

  const save = async (publishAfter: boolean) => {
    const invalid = validate();
    if (invalid) {
      showToast('ตรวจสอบข้อมูล', invalid, 'error');
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
        lesson: form.lesson || undefined,
        lessonTh: form.lessonTh || undefined,
        videoUrl: form.videoUrl.trim() || undefined,
        category: form.category.trim() || undefined,
        audience: form.audience,
        timeLimitMin: form.timeLimitMin.trim() ? Number(form.timeLimitMin) : null,
        passScore: Number(form.passScore) || 0,
        allowRetake: form.allowRetake,
        showAnswers: form.showAnswers,
        questions: cleanQuestions(),
      };
      let id = editingId;
      if (editingId) {
        await updateQuiz(getToken, editingId, payload);
      } else {
        const res = await createQuiz(getToken, payload);
        id = res.id;
      }
      if (publishAfter && id && isAdmin) {
        await setQuizStatusApi(getToken, id, 'published');
      }
      // Uploaded to the cloud — the on-device draft is now redundant. Clear
      // it (using the key the draft was written under) before resetting state.
      clearEditorDraft(editingId);
      setDraftSavedAt(null);
      showToast(editingId ? 'บันทึกแบบทดสอบแล้ว' : 'สร้างแบบทดสอบแล้ว', undefined, 'success');
      closeEditor();
      load();
    } catch (error) {
      showToast('บันทึกไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
    setSaving(false);
  };

  // Bulk-load questions from a spreadsheet. Only touches the (unsaved) editor
  // state — the staff member reviews the imported questions and saves as usual.
  const onImportCsv = async (file: File | null) => {
    if (!file) return;
    let text = '';
    try {
      text = await file.text();
    } catch {
      showToast('อ่านไฟล์ไม่สำเร็จ', 'กรุณาลองใหม่อีกครั้ง', 'error');
      return;
    }
    const { questions: parsed, errors } = csvToQuestions(text);
    if (parsed.length === 0) {
      showToast('นำเข้าไม่สำเร็จ', errors[0] || 'ไม่พบคำถามในไฟล์', 'error');
      return;
    }

    // If the editor already holds real questions, ask whether to replace them
    // all or append. Nothing is saved to the cloud until "บันทึก", so either
    // choice is safely reversible by not saving.
    const hasExisting = questions.some((q) => q.prompt.trim() !== '');
    let mode: 'replace' | 'append' = 'replace';
    if (hasExisting) {
      const replace = await confirmDialog(
        `พบคำถามในไฟล์ ${parsed.length} ข้อ — ต้องการแทนที่คำถามเดิม ${questions.length} ข้อทั้งหมด หรือเพิ่มต่อท้าย?`,
        { title: 'นำเข้าคำถามจาก CSV', okLabel: 'แทนที่ทั้งหมด', cancelLabel: 'เพิ่มต่อท้าย' },
      );
      mode = replace ? 'replace' : 'append';
    }
    setQuestions(mode === 'replace' ? parsed : [...questions.filter((q) => q.prompt.trim() !== ''), ...parsed]);

    const skipped = errors.length ? ` · ข้าม ${errors.length} แถวที่ไม่ถูกต้อง` : '';
    showToast(`นำเข้า ${parsed.length} ข้อแล้ว${skipped}`, errors[0], errors.length ? 'error' : 'success');
  };

  const onExportCsv = () => {
    const clean = questions.filter((q) => q.prompt.trim() !== '');
    if (clean.length === 0) {
      showToast('ยังไม่มีคำถามให้ส่งออก', undefined, 'error');
      return;
    }
    const name = (form.titleTh || form.title || 'quiz').trim().replace(/[^\w฀-๿-]+/g, '_').slice(0, 40) || 'quiz';
    downloadCsv(`${name}.csv`, questionsToCsv(clean));
  };

  // Bulk-create several quizzes from one CSV (grouped by the `quiz` column).
  // Each becomes a new draft via the normal create API; the author then reviews
  // and publishes as usual.
  const onImportQuizzesCsv = async (file: File | null) => {
    if (!file) return;
    let text = '';
    try {
      text = await file.text();
    } catch {
      showToast('อ่านไฟล์ไม่สำเร็จ', 'กรุณาลองใหม่อีกครั้ง', 'error');
      return;
    }
    const { quizzes, errors } = csvToQuizzes(text);
    if (quizzes.length === 0) {
      showToast('นำเข้าไม่สำเร็จ', errors[0] || 'ไม่พบแบบทดสอบในไฟล์', 'error');
      return;
    }
    const totalQ = quizzes.reduce((n, q) => n + q.questions.length, 0);
    const skipped = errors.length ? `\n\n(มี ${errors.length} แถว/ชุดที่ข้าม: ${errors[0]})` : '';
    if (
      !(await confirmDialog(`จะสร้างแบบทดสอบใหม่ ${quizzes.length} ชุด (รวม ${totalQ} คำถาม) เป็นฉบับร่างหรือไม่?${skipped}`, {
        title: 'นำเข้าแบบทดสอบหลายชุด',
        okLabel: `สร้าง ${quizzes.length} ชุด`,
      }))
    )
      return;

    setSaving(true);
    const getToken = makeTokenGetter(getAccessTokenSilently);
    let ok = 0;
    const failed: string[] = [];
    for (const q of quizzes) {
      try {
        const res = await createQuiz(getToken, {
          title: q.title,
          titleTh: q.titleTh,
          category: q.category,
          audience: q.audience,
          passScore: q.passScore,
          questions: q.questions,
        });
        if (res.id) ok += 1;
        else failed.push(q.title);
      } catch {
        failed.push(q.title);
      }
    }
    setSaving(false);
    showToast(
      `สร้างแบบทดสอบแล้ว ${ok} ชุด${failed.length ? ` · ล้มเหลว ${failed.length}` : ''}`,
      failed.length ? `ล้มเหลว: ${failed.slice(0, 3).join(', ')}` : 'ทั้งหมดเป็นฉบับร่าง — ตรวจสอบและเผยแพร่ได้เลย',
      failed.length ? 'error' : 'success',
    );
    load();
  };

  const changeStatus = async (quiz: QuizSummary, status: QuizStatus) => {
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      await setQuizStatusApi(getToken, quiz.id, status);
      showToast(status === 'published' ? 'เผยแพร่แบบทดสอบแล้ว' : 'อัปเดตสถานะแล้ว', undefined, 'success');
      load();
    } catch (error) {
      showToast('อัปเดตสถานะไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const remove = async (quiz: QuizSummary) => {
    if (
      !(await confirmDialog(`ลบแบบทดสอบ "${quiz.titleTh || quiz.title}"? คำถามและผลการทำทั้งหมดจะถูกลบไปด้วย`, {
        title: 'ลบแบบทดสอบ',
        danger: true,
        okLabel: 'ลบ',
      }))
    )
      return;
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      await deleteQuizApi(getToken, quiz.id);
      showToast('ลบแบบทดสอบแล้ว', undefined, 'success');
      load();
    } catch (error) {
      showToast('ลบไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const openResults = async (quiz: QuizSummary) => {
    setResultsFor(quiz);
    setAttempts(null);
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      const res = await fetchQuizAttempts(getToken, quiz.id);
      setAttempts(res.attempts);
    } catch (error) {
      showToast('โหลดผลการทำไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
      setAttempts([]);
    }
  };

  const totalPoints = questions.reduce((s, q) => s + (Number(q.points) || 0), 0);

  return (
    <>
      <div className="screen-header">
        <h1>แบบทดสอบและบทเรียนออนไลน์</h1>
        <p>
          สร้างบทเรียนและแบบทดสอบให้นักเรียนเรียนรู้และทำข้อสอบผ่านเว็บไซต์ ระบบตรวจคะแนนอัตโนมัติและสรุปผลให้ทันที —
          แบบทดสอบจะแสดงบนพอร์ทัลนักเรียนหลังจากเผยแพร่{isAdmin ? '' : ' (รอแอดมินเผยแพร่)'}
        </p>
      </div>

      {editorOpen && (
        <div className="admin-card">
          <div className="card-title-bar">
            <span className="card-icon">
              <i className="fas fa-clipboard-question"></i>
            </span>
            <div style={{ flex: 1 }}>
              <h3>{editingId ? 'แก้ไขแบบทดสอบ' : 'สร้างแบบทดสอบใหม่'}</h3>
              <p>
                ใส่บทเรียน (ถ้ามี) แล้วเพิ่มคำถาม · คะแนนรวม {totalPoints} คะแนน
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
                  <i className="fas fa-heading"></i> ชื่อแบบทดสอบ (ภาษาไทย)
                </label>
                <input
                  type="text"
                  value={form.titleTh}
                  placeholder="เช่น แบบทดสอบคำศัพท์ บทที่ 1"
                  onChange={(e) => setForm({ ...form, titleTh: e.target.value })}
                />
              </div>
              <div className="form-group" style={{ flex: '1 1 260px' }}>
                <label>
                  <i className="fas fa-heading"></i> ชื่อ (English, ไม่บังคับ)
                </label>
                <input
                  type="text"
                  value={form.title}
                  placeholder="e.g. Vocabulary Quiz — Unit 1"
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                />
              </div>
            </div>

            <div className="form-group">
              <label>
                <i className="fas fa-align-left"></i> คำอธิบายสั้น (ภาษาไทย)
              </label>
              <input
                type="text"
                value={form.descriptionTh}
                placeholder="อธิบายสั้น ๆ ว่าแบบทดสอบนี้เกี่ยวกับอะไร"
                onChange={(e) => setForm({ ...form, descriptionTh: e.target.value })}
              />
            </div>

            <div className="form-group">
              <label>
                <i className="fas fa-user-group"></i> สำหรับผู้เรียน
              </label>
              <select value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value as QuizAudience })}>
                {(Object.keys(AUDIENCE_LABEL) as QuizAudience[]).map((a) => (
                  <option key={a} value={a}>
                    {AUDIENCE_LABEL[a]}
                  </option>
                ))}
              </select>
              <div className="form-hint">
                แยกแบบทดสอบสำหรับนักเรียนที่เรียนตัวต่อตัวกับครู ออกจากแบบทดสอบที่เปิดให้เรียนแบบ On Demand
              </div>
            </div>

            {/* Two ways to give a lesson its video. The uploaded file wins when
                both are set — see worker/migrations/0032 — so the upload block
                comes first and says so. */}
            <div className="form-group">
              <label>
                <i className="fas fa-film"></i> วีดีโอการสอน (อัปโหลดไฟล์ · ไม่บังคับ)
              </label>
              {!editingId ? (
                <div className="form-hint">
                  <i className="fas fa-circle-info"></i> บันทึกแบบทดสอบก่อน แล้วจึงอัปโหลดวีดีโอได้
                </div>
              ) : uploadPct != null ? (
                <div>
                  <div className="upload-progress">
                    <div className="upload-progress__fill" style={{ width: `${Math.round(uploadPct * 100)}%` }}></div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span className="form-hint" style={{ margin: 0 }}>
                      กำลังอัปโหลด {Math.round(uploadPct * 100)}% · อย่าปิดหน้านี้
                    </span>
                    <button type="button" className="btn btn-secondary" style={{ padding: '6px 10px' }} onClick={() => uploadAbort.current?.abort()}>
                      ยกเลิก
                    </button>
                  </div>
                </div>
              ) : videoFile?.hasVideoFile ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <span>
                    <i className="fas fa-circle-check" style={{ color: 'var(--accent-success)' }}></i>{' '}
                    {videoFile.videoName || 'วีดีโอการสอน'}
                    {videoFile.videoSize ? ` · ${formatFileSize(videoFile.videoSize)}` : ''}
                  </span>
                  <label className="btn btn-secondary" style={{ margin: 0, padding: '6px 10px' }}>
                    <i className="fas fa-arrows-rotate"></i> เปลี่ยนไฟล์
                    <input
                      type="file"
                      accept="video/mp4,video/webm,video/ogg,video/quicktime"
                      style={{ display: 'none' }}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        e.target.value = '';
                        if (f) pickVideo(f);
                      }}
                    />
                  </label>
                  <button type="button" className="btn btn-danger" style={{ padding: '6px 10px' }} onClick={removeVideo}>
                    <i className="fas fa-trash"></i> ลบวีดีโอ
                  </button>
                </div>
              ) : (
                <label className="btn btn-secondary" style={{ margin: 0, padding: '6px 10px' }}>
                  <i className="fas fa-upload"></i> เลือกไฟล์วีดีโอ
                  <input
                    type="file"
                    accept="video/mp4,video/webm,video/ogg,video/quicktime"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = '';
                      if (f) pickVideo(f);
                    }}
                  />
                </label>
              )}
              <div className="form-hint">
                MP4, WebM, OGG หรือ MOV · สูงสุด 2 GB · อัปโหลดแล้วเล่นจากเซิร์ฟเวอร์ของโรงเรียนเอง ไม่ผ่าน YouTube
              </div>
            </div>

            {/* A LITALK+ benefit: the server only hands this file to a member
                (worker/src/slides.ts). Uploaded here like any other lesson
                asset — one POST, because a PDF fits in a request body. */}
            <div className="form-group">
              <label>
                <i className="fas fa-file-pdf"></i> สไลด์บทเรียน (PDF · สิทธิ์สมาชิก LITALK+)
              </label>
              {!editingId ? (
                <div className="form-hint">
                  <i className="fas fa-circle-info"></i> บันทึกแบบทดสอบก่อน แล้วจึงอัปโหลดสไลด์ได้
                </div>
              ) : slidesBusy ? (
                <div className="form-hint">
                  <i className="fas fa-spinner fa-spin"></i> กำลังอัปโหลด...
                </div>
              ) : slideFile?.hasSlides ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <span>
                    <i className="fas fa-circle-check" style={{ color: 'var(--accent-success)' }}></i>{' '}
                    {slideFile.slideName || 'สไลด์บทเรียน'}
                    {slideFile.slideSize ? ` · ${formatFileSize(slideFile.slideSize)}` : ''}
                  </span>
                  <label className="btn btn-secondary" style={{ margin: 0, padding: '6px 10px' }}>
                    <i className="fas fa-arrows-rotate"></i> เปลี่ยนไฟล์
                    <input
                      type="file"
                      accept="application/pdf"
                      style={{ display: 'none' }}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        e.target.value = '';
                        if (f) pickSlides(f);
                      }}
                    />
                  </label>
                  <button type="button" className="btn btn-danger" style={{ padding: '6px 10px' }} onClick={removeSlides}>
                    <i className="fas fa-trash"></i> ลบสไลด์
                  </button>
                </div>
              ) : (
                <label className="btn btn-secondary" style={{ margin: 0, padding: '6px 10px' }}>
                  <i className="fas fa-upload"></i> เลือกไฟล์ PDF
                  <input
                    type="file"
                    accept="application/pdf"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = '';
                      if (f) pickSlides(f);
                    }}
                  />
                </label>
              )}
              <div className="form-hint">
                PDF เท่านั้น · สูงสุด 40 MB · เฉพาะสมาชิก LITALK+ ที่เข้าถึงบทเรียนนี้ได้จึงจะดาวน์โหลดได้
              </div>
            </div>

            <div className="form-group">
              <label>
                <i className="fas fa-video"></i> วีดีโอการสอน (ลิงก์ · ไม่บังคับ)
              </label>
              <input
                type="url"
                value={form.videoUrl}
                placeholder="เช่น https://youtu.be/xxxx หรือ https://vimeo.com/xxxx หรือลิงก์ไฟล์ .mp4"
                onChange={(e) => setForm({ ...form, videoUrl: e.target.value })}
              />
              <div className="form-hint">
                นักเรียนจะดูวีดีโอนี้ก่อนทำแบบทดสอบ · รองรับ YouTube, Vimeo และไฟล์วีดีโอโดยตรง
                {videoFile?.hasVideoFile ? ' · ขณะนี้ใช้ไฟล์ที่อัปโหลดไว้แทนลิงก์นี้' : ''}
              </div>
            </div>

            <div className="form-group">
              <label>
                <i className="fab fa-markdown"></i> บทเรียน (ภาษาไทย · Markdown · ไม่บังคับ)
              </label>
              <textarea
                rows={6}
                value={form.lessonTh}
                placeholder={'# หัวข้อบทเรียน\n\nเนื้อหาที่นักเรียนควรอ่านก่อนทำแบบทดสอบ...'}
                style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13 }}
                onChange={(e) => setForm({ ...form, lessonTh: e.target.value })}
              />
              <div className="form-hint">รองรับ Markdown · หัวข้อ <code># หัวข้อ</code> · ตัวหนา <code>**ข้อความ**</code> · ลิงก์ <code>[ชื่อ](url)</code></div>
            </div>

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <div className="form-group" style={{ flex: '1 1 160px' }}>
                <label>
                  <i className="fas fa-tag"></i> หมวดหมู่ (ไม่บังคับ)
                </label>
                <input type="text" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
              </div>
              <div className="form-group" style={{ flex: '0 0 150px' }}>
                <label>
                  <i className="fas fa-clock"></i> เวลาจำกัด (นาที)
                </label>
                <input
                  type="number"
                  min={0}
                  value={form.timeLimitMin}
                  placeholder="ไม่จำกัด"
                  onChange={(e) => setForm({ ...form, timeLimitMin: e.target.value })}
                />
              </div>
              <div className="form-group" style={{ flex: '0 0 150px' }}>
                <label>
                  <i className="fas fa-percent"></i> เกณฑ์ผ่าน (%)
                </label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={form.passScore}
                  onChange={(e) => setForm({ ...form, passScore: e.target.value })}
                />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 8 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 400 }}>
                <input type="checkbox" checked={form.allowRetake} onChange={(e) => setForm({ ...form, allowRetake: e.target.checked })} />{' '}
                ให้ทำซ้ำได้หลายครั้ง
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 400 }}>
                <input type="checkbox" checked={form.showAnswers} onChange={(e) => setForm({ ...form, showAnswers: e.target.checked })} />{' '}
                เฉลยคำตอบหลังส่ง
              </label>
            </div>

            <hr style={{ border: 'none', borderTop: '1px solid var(--border-color, #e5e7eb)', margin: '10px 0 18px' }} />

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', margin: '0 0 6px' }}>
              <h3 style={{ margin: 0, flex: '1 1 auto' }}>
                <i className="fas fa-list-ol"></i> คำถาม ({questions.length})
              </h3>
              <button type="button" className="btn btn-secondary" style={{ padding: '6px 11px' }} onClick={() => downloadCsv('litalk-quiz-template.csv', quizCsvTemplate())}>
                <i className="fas fa-file-arrow-down"></i> Template
              </button>
              <label className="btn btn-secondary" style={{ padding: '6px 11px', cursor: 'pointer', margin: 0 }}>
                <i className="fas fa-file-import"></i> นำเข้า CSV
                <input
                  type="file"
                  accept=".csv,text/csv"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    onImportCsv(e.target.files?.[0] || null);
                    e.target.value = '';
                  }}
                />
              </label>
              <button type="button" className="btn btn-secondary" style={{ padding: '6px 11px' }} onClick={onExportCsv}>
                <i className="fas fa-file-export"></i> ส่งออก
              </button>
            </div>
            <div className="form-hint" style={{ margin: '0 0 14px' }}>
              นำเข้า/แก้ไขคำถามจำนวนมากผ่านไฟล์ CSV ได้ — กด <strong>Template</strong> เพื่อดาวน์โหลดไฟล์ตัวอย่าง (เปิดด้วย Excel/Google Sheets),
              กรอกคำถาม แล้วกด <strong>นำเข้า CSV</strong> · ประเภท: single, multiple, truefalse, short · ช่อง answer สำหรับ single/multiple ใส่ลำดับตัวเลือก (เช่น 1 หรือ 1;3)
            </div>

            {questions.map((q, i) => (
              <QuestionEditor
                key={i}
                q={q}
                index={i}
                onChange={(next) => setQuestions(questions.map((item, idx) => (idx === i ? next : item)))}
                onRemove={() => setQuestions(questions.filter((_, idx) => idx !== i))}
                onMove={(dir) => {
                  const j = i + dir;
                  if (j < 0 || j >= questions.length) return;
                  const next = [...questions];
                  [next[i], next[j]] = [next[j], next[i]];
                  setQuestions(next);
                }}
              />
            ))}

            <button type="button" className="btn btn-secondary" onClick={() => setQuestions([...questions, blankQuestion('single')])}>
              <i className="fas fa-plus"></i> เพิ่มคำถาม
            </button>

            <div className="blog-wizard-nav" style={{ marginTop: 20, display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
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
            <i className="fas fa-clipboard-list"></i>
          </span>
          <div style={{ flex: 1 }}>
            <h3>แบบทดสอบทั้งหมด</h3>
            <p>จัดการบทเรียนและแบบทดสอบ ดูผลคะแนนของนักเรียน</p>
          </div>
          {!editorOpen && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-secondary" onClick={() => downloadCsv('litalk-quizzes-template.csv', multiQuizCsvTemplate())} title="ดาวน์โหลดไฟล์ตัวอย่างสำหรับสร้างหลายชุด">
                <i className="fas fa-file-arrow-down"></i> Template หลายชุด
              </button>
              <label className="btn btn-secondary" style={{ cursor: 'pointer', margin: 0 }}>
                <i className="fas fa-file-import"></i> นำเข้าหลายชุด
                <input
                  type="file"
                  accept=".csv,text/csv"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    onImportQuizzesCsv(e.target.files?.[0] || null);
                    e.target.value = '';
                  }}
                />
              </label>
              <button type="button" className="btn btn-primary" onClick={openNew}>
                <i className="fas fa-plus"></i> สร้างแบบทดสอบใหม่
              </button>
            </div>
          )}
        </div>

        <div className="form-body">
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
            <input
              type="search"
              value={search}
              placeholder="ค้นหาชื่อแบบทดสอบ..."
              style={{ flex: '1 1 220px' }}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select value={audienceFilter} onChange={(e) => setAudienceFilter(e.target.value)} aria-label="กรองตามผู้เรียน">
              <option value="">ทุกผู้เรียน</option>
              <option value="on_demand">{AUDIENCE_LABEL.on_demand}</option>
              <option value="tutored">{AUDIENCE_LABEL.tutored}</option>
            </select>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="กรองตามสถานะ">
              <option value="">ทุกสถานะ</option>
              <option value="draft">ฉบับร่าง</option>
              <option value="published">เผยแพร่แล้ว</option>
              <option value="archived">เก็บถาวร</option>
            </select>
          </div>

          {quizzes === null && !loadFailed && <div className="loader"></div>}
          {loadFailed && <div className="form-hint">โหลดรายการแบบทดสอบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง</div>}
          {quizzes && filtered.length === 0 && (
            <div className="empty-state">
              <div className="empty-title">ยังไม่มีแบบทดสอบ</div>
              <div className="empty-sub">กดปุ่ม "สร้างแบบทดสอบใหม่" เพื่อเริ่มต้น</div>
            </div>
          )}

          <div className="row-list">
            {filtered.map((quiz) => (
              <div key={quiz.id} className="quiz-row" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 4px', borderBottom: '1px solid var(--border-color, #eee)', flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 260px', minWidth: 0 }}>
                  <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {quiz.titleTh || quiz.title}
                    <span className={`badge badge-${quiz.status}`} style={{ fontSize: 12, padding: '2px 8px', borderRadius: 999, background: 'var(--bg-tertiary, #f1f5f9)' }}>
                      {STATUS_LABEL[quiz.status]}
                    </span>
                    <span
                      style={{
                        fontSize: 12,
                        padding: '2px 8px',
                        borderRadius: 999,
                        background: quiz.audience === 'tutored' ? 'rgba(99,102,241,.12)' : 'rgba(16,185,129,.12)',
                        color: quiz.audience === 'tutored' ? '#4f46e5' : '#059669',
                      }}
                    >
                      <i className={`fas ${quiz.audience === 'tutored' ? 'fa-chalkboard-user' : 'fa-globe'}`}></i>{' '}
                      {AUDIENCE_LABEL[quiz.audience ?? 'on_demand']}
                    </span>
                  </div>
                  <div className="form-hint" style={{ marginTop: 2 }}>
                    {quiz.questionCount} คำถาม · ทำแล้ว {quiz.attemptCount} ครั้ง
                    {quiz.category ? ` · ${quiz.category}` : ''}
                    {quiz.passScore ? ` · เกณฑ์ผ่าน ${quiz.passScore}%` : ''}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button type="button" className="btn btn-secondary" style={{ padding: '6px 11px' }} onClick={() => openResults(quiz)}>
                    <i className="fas fa-chart-simple"></i> ผลคะแนน
                  </button>
                  <button type="button" className="btn btn-secondary" style={{ padding: '6px 11px' }} onClick={() => openEdit(quiz.id)}>
                    <i className="fas fa-pen"></i> แก้ไข
                  </button>
                  {isAdmin && quiz.status !== 'published' && (
                    <button type="button" className="btn btn-success" style={{ padding: '6px 11px' }} onClick={() => changeStatus(quiz, 'published')}>
                      <i className="fas fa-cloud-arrow-up"></i> เผยแพร่
                    </button>
                  )}
                  {isAdmin && quiz.status === 'published' && (
                    <button type="button" className="btn btn-secondary" style={{ padding: '6px 11px' }} onClick={() => changeStatus(quiz, 'archived')}>
                      <i className="fas fa-box-archive"></i> เก็บถาวร
                    </button>
                  )}
                  <button type="button" className="btn btn-danger" style={{ padding: '6px 11px' }} onClick={() => remove(quiz)}>
                    <i className="fas fa-trash"></i>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {resultsFor && (
        <div className="modal-overlay active" onClick={() => setResultsFor(null)}>
          <div className="admin-card" style={{ maxWidth: 720, width: '92%', maxHeight: '82vh', overflow: 'auto' }} onClick={(e) => e.stopPropagation()}>
            <div className="card-title-bar">
              <span className="card-icon">
                <i className="fas fa-chart-simple"></i>
              </span>
              <div style={{ flex: 1 }}>
                <h3>ผลคะแนน — {resultsFor.titleTh || resultsFor.title}</h3>
                <p>รายชื่อนักเรียนที่ทำแบบทดสอบนี้</p>
              </div>
              <button type="button" className="btn btn-secondary" onClick={() => setResultsFor(null)}>
                <i className="fas fa-xmark"></i>
              </button>
            </div>
            <div className="form-body">
              {attempts === null && <div className="loader"></div>}
              {attempts && attempts.length === 0 && <div className="empty-state"><div className="empty-title">ยังไม่มีนักเรียนทำแบบทดสอบนี้</div></div>}
              {attempts && attempts.length > 0 && (
                <div className="row-list">
                  {attempts.map((a) => {
                    const percent = a.maxScore > 0 ? Math.round((a.score / a.maxScore) * 100) : 0;
                    return (
                      <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 4px', borderBottom: '1px solid var(--border-color, #eee)' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600 }}>{a.studentNickname || a.studentName || a.studentId}</div>
                          <div className="form-hint">{a.studentId} · {new Date(a.submittedAt).toLocaleString('th-TH')}</div>
                        </div>
                        <div style={{ fontWeight: 700 }}>{a.score}/{a.maxScore} ({percent}%)</div>
                        <span style={{ fontSize: 13, fontWeight: 600, color: a.passed ? '#16a34a' : '#dc2626' }}>
                          {a.passed ? 'ผ่าน' : 'ไม่ผ่าน'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
