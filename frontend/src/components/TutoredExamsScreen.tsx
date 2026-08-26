import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { useStudents } from '../hooks/useStudents';
import { useToast } from '../ui/ToastContext';
import { useConfirm } from '../ui/ConfirmContext';
import {
  apiJson,
  createQuiz,
  deleteQuizApi,
  fetchQuiz,
  fetchQuizAttempts,
  makeTokenGetter,
  updateQuiz,
  type QuizQuestion,
  type QuizAttemptRow,
} from '../api/client';

type QuestionType = 'single' | 'multiple' | 'truefalse' | 'short';

type TutoredExam = {
  id: number;
  title: string;
  titleTh?: string | null;
  descriptionTh?: string | null;
  studentId: string;
  studentName?: string | null;
  studentNickname?: string | null;
  status: 'draft' | 'published' | 'archived';
  timeLimitMin?: number | null;
  passScore: number;
  allowRetake: number;
  showAnswers: number;
  availableFrom?: string | null;
  dueAt?: string | null;
  questionCount: number;
  attemptCount: number;
  updatedAt?: string;
};

const blankQuestion = (type: QuestionType = 'single'): QuizQuestion => {
  const base = { type, prompt: '', explanation: '', points: 1 };
  if (type === 'single') return { ...base, options: ['', ''], answer: 0 };
  if (type === 'multiple') return { ...base, options: ['', ''], answer: [] };
  if (type === 'truefalse') return { ...base, options: [], answer: true };
  return { ...base, options: [], answer: [''] };
};

const toLocal = (iso?: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
};

export default function TutoredExamsScreen() {
  const { getAccessTokenSilently } = useAuth0();
  const { students, loading: studentsLoading } = useStudents();
  const showToast = useToast();
  const confirmDialog = useConfirm();
  const [exams, setExams] = useState<TutoredExam[] | null>(null);
  const [selectedStudent, setSelectedStudent] = useState('');
  const [search, setSearch] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [timeLimit, setTimeLimit] = useState('');
  const [passScore, setPassScore] = useState('70');
  const [allowRetake, setAllowRetake] = useState(false);
  const [showAnswers, setShowAnswers] = useState(true);
  const [availableFrom, setAvailableFrom] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [questions, setQuestions] = useState<QuizQuestion[]>([blankQuestion()]);
  const [saving, setSaving] = useState(false);
  const [resultsFor, setResultsFor] = useState<TutoredExam | null>(null);
  const [attempts, setAttempts] = useState<QuizAttemptRow[] | null>(null);

  const getToken = useMemo(() => makeTokenGetter(getAccessTokenSilently), [getAccessTokenSilently]);

  const load = useCallback(async () => {
    try {
      const res = await apiJson<{ exams: TutoredExam[] }>(getToken, '/tutored-exams');
      setExams(res.exams ?? []);
    } catch (error) {
      console.error(error);
      setExams([]);
      showToast('โหลดแบบทดสอบไม่สำเร็จ', error instanceof Error ? error.message : undefined, 'error');
    }
  }, [getToken, showToast]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (exams ?? []).filter((e) => {
      if (selectedStudent && e.studentId !== selectedStudent) return false;
      if (!term) return true;
      return `${e.titleTh || e.title} ${e.studentName || ''} ${e.studentNickname || ''} ${e.studentId}`.toLowerCase().includes(term);
    });
  }, [exams, search, selectedStudent]);

  const resetEditor = () => {
    setEditingId(null);
    setTitle('');
    setDescription('');
    setTimeLimit('');
    setPassScore('70');
    setAllowRetake(false);
    setShowAnswers(true);
    setAvailableFrom('');
    setDueAt('');
    setQuestions([blankQuestion()]);
  };

  const openNew = () => {
    if (!selectedStudent) {
      showToast('เลือกนักเรียนก่อน', 'แบบทดสอบ 1 ต่อ 1 ต้องระบุนักเรียนที่จะได้รับข้อสอบ', 'error');
      return;
    }
    resetEditor();
    setEditorOpen(true);
  };

  const openEdit = async (exam: TutoredExam) => {
    try {
      const res = await fetchQuiz(getToken, exam.id);
      setEditingId(exam.id);
      setSelectedStudent(exam.studentId);
      setTitle(res.quiz.titleTh || res.quiz.title || '');
      setDescription(res.quiz.descriptionTh || res.quiz.description || '');
      setTimeLimit(res.quiz.timeLimitMin == null ? '' : String(res.quiz.timeLimitMin));
      setPassScore(String(res.quiz.passScore ?? 70));
      setAllowRetake(!!res.quiz.allowRetake);
      setShowAnswers(!!res.quiz.showAnswers);
      setAvailableFrom(toLocal(exam.availableFrom));
      setDueAt(toLocal(exam.dueAt));
      setQuestions(res.questions.length ? res.questions : [blankQuestion()]);
      setEditorOpen(true);
    } catch (error) {
      showToast('เปิดแบบทดสอบไม่สำเร็จ', error instanceof Error ? error.message : undefined, 'error');
    }
  };

  const validate = () => {
    if (!selectedStudent) return 'กรุณาเลือกนักเรียน';
    if (!title.trim()) return 'กรุณากรอกชื่อแบบทดสอบ';
    if (!questions.length) return 'กรุณาเพิ่มคำถามอย่างน้อย 1 ข้อ';
    for (let i = 0; i < questions.length; i += 1) {
      const q = questions[i];
      if (!q.prompt.trim()) return `ข้อ ${i + 1}: กรุณากรอกคำถาม`;
      if ((q.type === 'single' || q.type === 'multiple') && (q.options ?? []).filter((v) => v.trim()).length < 2) return `ข้อ ${i + 1}: ต้องมีอย่างน้อย 2 ตัวเลือก`;
    }
    if (availableFrom && dueAt && new Date(dueAt).getTime() <= new Date(availableFrom).getTime()) return 'วันสิ้นสุดต้องอยู่หลังวันเปิดทำ';
    return null;
  };

  const save = async (publish: boolean) => {
    const invalid = validate();
    if (invalid) { showToast('ตรวจสอบข้อมูล', invalid, 'error'); return; }
    setSaving(true);
    try {
      const payload = {
        title: title.trim(), titleTh: title.trim(), descriptionTh: description.trim() || undefined,
        audience: 'tutored' as const,
        timeLimitMin: timeLimit.trim() ? Number(timeLimit) : null,
        passScore: Math.max(0, Math.min(100, Number(passScore) || 0)),
        allowRetake, showAnswers, questions,
      };
      let id = editingId;
      if (id) await updateQuiz(getToken, id, payload);
      else id = (await createQuiz(getToken, payload)).id;
      await apiJson(getToken, `/tutored-exams/${id}/assignment`, {
        method: 'PUT',
        body: JSON.stringify({
          studentId: selectedStudent,
          availableFrom: availableFrom ? new Date(availableFrom).toISOString() : null,
          dueAt: dueAt ? new Date(dueAt).toISOString() : null,
          publish,
        }),
      });
      showToast(publish ? 'ออกข้อสอบให้นักเรียนแล้ว' : 'บันทึกฉบับร่างแล้ว', undefined, 'success');
      setEditorOpen(false);
      resetEditor();
      await load();
    } catch (error) {
      showToast('บันทึกไม่สำเร็จ', error instanceof Error ? error.message : undefined, 'error');
    } finally { setSaving(false); }
  };

  const remove = async (exam: TutoredExam) => {
    if (!(await confirmDialog(`ลบแบบทดสอบ “${exam.titleTh || exam.title}” ของ ${exam.studentNickname || exam.studentName || exam.studentId}?`, { title: 'ลบแบบทดสอบ', danger: true, okLabel: 'ลบ' }))) return;
    try {
      await deleteQuizApi(getToken, exam.id);
      showToast('ลบแบบทดสอบแล้ว', undefined, 'success');
      load();
    } catch (error) { showToast('ลบไม่สำเร็จ', error instanceof Error ? error.message : undefined, 'error'); }
  };

  const showResults = async (exam: TutoredExam) => {
    setResultsFor(exam); setAttempts(null);
    try { setAttempts((await fetchQuizAttempts(getToken, exam.id)).attempts); }
    catch (error) { setAttempts([]); showToast('โหลดผลไม่สำเร็จ', error instanceof Error ? error.message : undefined, 'error'); }
  };

  return <>
    <div className="screen-header tutored-exam-header">
      <h1>แบบทดสอบออนไลน์ 1 ต่อ 1</h1>
      <p>ออกข้อสอบให้นักเรียนรายบุคคล เลือกนักเรียนที่รับผิดชอบ กำหนดช่วงเวลา เกณฑ์ผ่าน และติดตามผลการทำข้อสอบได้จากหน้าเดียว</p>
    </div>

    <div className="admin-card tutored-exam-student-card">
      <div className="card-title-bar">
        <span className="card-icon"><i className="fas fa-user-graduate" /></span>
        <div><h3>1. เลือกนักเรียน</h3><p>ครูจะเห็นเฉพาะนักเรียนที่ได้รับมอบหมายจากระบบสิทธิ์การมองเห็น</p></div>
      </div>
      <div className="form-body tutored-exam-student-row">
        <select value={selectedStudent} onChange={(e) => setSelectedStudent(e.target.value)} disabled={studentsLoading}>
          <option value="">{studentsLoading ? 'กำลังโหลดนักเรียน...' : 'เลือกนักเรียน'}</option>
          {students.map((s) => <option key={s.id} value={s.id}>{s.nickname || s.name} · {s.id}</option>)}
        </select>
        <button className="btn btn-primary" type="button" onClick={openNew} disabled={!selectedStudent}><i className="fas fa-file-circle-plus" /> ออกข้อสอบใหม่</button>
      </div>
    </div>

    {editorOpen && <div className="admin-card tutored-exam-editor">
      <div className="card-title-bar">
        <span className="card-icon"><i className="fas fa-pen-to-square" /></span>
        <div style={{ flex: 1 }}><h3>{editingId ? 'แก้ไขข้อสอบ' : 'สร้างข้อสอบใหม่'}</h3><p>ข้อสอบนี้จะมองเห็นได้เฉพาะนักเรียนที่เลือกไว้</p></div>
        <button className="btn btn-secondary" onClick={() => setEditorOpen(false)} type="button"><i className="fas fa-xmark" /> ปิด</button>
      </div>
      <div className="form-body">
        <div className="tutored-exam-grid">
          <div className="form-group tutored-span-2"><label>ชื่อแบบทดสอบ</label><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="เช่น Unit 3 Progress Test" /></div>
          <div className="form-group tutored-span-2"><label>คำชี้แจง / รายละเอียด</label><textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="คำแนะนำก่อนเริ่มทำข้อสอบ" /></div>
          <div className="form-group"><label>เปิดทำตั้งแต่</label><input type="datetime-local" value={availableFrom} onChange={(e) => setAvailableFrom(e.target.value)} /></div>
          <div className="form-group"><label>สิ้นสุด / กำหนดส่ง</label><input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} /></div>
          <div className="form-group"><label>เวลาจำกัด (นาที)</label><input type="number" min="0" max="600" value={timeLimit} onChange={(e) => setTimeLimit(e.target.value)} placeholder="ไม่จำกัด" /></div>
          <div className="form-group"><label>เกณฑ์ผ่าน (%)</label><input type="number" min="0" max="100" value={passScore} onChange={(e) => setPassScore(e.target.value)} /></div>
        </div>
        <div className="tutored-exam-options">
          <label><input type="checkbox" checked={allowRetake} onChange={(e) => setAllowRetake(e.target.checked)} /> อนุญาตให้ทำซ้ำ</label>
          <label><input type="checkbox" checked={showAnswers} onChange={(e) => setShowAnswers(e.target.checked)} /> เปิดเฉลยละเอียดสำหรับผู้มีสิทธิ์ LITALK+</label>
        </div>
        <div className="tutored-question-head"><div><h3>2. สร้างข้อสอบ</h3><p>{questions.length} ข้อ · รองรับเลือกตอบ หลายคำตอบ จริง/เท็จ และคำตอบสั้น</p></div><button type="button" className="btn btn-secondary" onClick={() => setQuestions([...questions, blankQuestion()])}><i className="fas fa-plus" /> เพิ่มข้อ</button></div>
        <div className="tutored-question-list">
          {questions.map((q, i) => <QuestionCard key={i} q={q} index={i} onChange={(next) => setQuestions(questions.map((item, idx) => idx === i ? next : item))} onRemove={() => setQuestions(questions.filter((_, idx) => idx !== i))} />)}
        </div>
        <div className="tutored-exam-actions">
          <button type="button" className="btn btn-secondary" onClick={() => save(false)} disabled={saving}><i className="fas fa-floppy-disk" /> บันทึกร่าง</button>
          <button type="button" className="btn btn-success" onClick={() => save(true)} disabled={saving}><i className="fas fa-paper-plane" /> {saving ? 'กำลังบันทึก...' : 'ออกข้อสอบให้นักเรียน'}</button>
        </div>
      </div>
    </div>}

    <div className="admin-card tutored-exam-list-card">
      <div className="card-title-bar"><span className="card-icon"><i className="fas fa-file-signature" /></span><div><h3>ข้อสอบที่ออกแล้ว</h3><p>ติดตามฉบับร่าง ข้อสอบที่เปิดทำ และผลการทำของนักเรียน</p></div></div>
      <div className="form-body">
        <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ค้นหาชื่อข้อสอบหรือนักเรียน..." />
        {exams === null ? <div className="empty-state">กำลังโหลด...</div> : filtered.length === 0 ? <div className="empty-state">ยังไม่มีแบบทดสอบสำหรับตัวกรองนี้</div> : <div className="table-container"><table><thead><tr><th>นักเรียน</th><th>แบบทดสอบ</th><th>สถานะ</th><th>ช่วงเวลา</th><th>ผล</th><th></th></tr></thead><tbody>{filtered.map((exam) => <tr key={exam.id}><td><strong>{exam.studentNickname || exam.studentName || exam.studentId}</strong><div className="form-hint">{exam.studentId}</div></td><td><strong>{exam.titleTh || exam.title}</strong><div className="form-hint">{exam.questionCount} ข้อ</div></td><td><span className={`status-badge ${exam.status === 'published' ? 'status-active' : ''}`}>{exam.status === 'published' ? 'ออกข้อสอบแล้ว' : 'ฉบับร่าง'}</span></td><td><small>{exam.availableFrom ? new Date(exam.availableFrom).toLocaleString('th-TH') : 'เปิดทันที'}<br />{exam.dueAt ? `ถึง ${new Date(exam.dueAt).toLocaleString('th-TH')}` : 'ไม่กำหนดสิ้นสุด'}</small></td><td><button type="button" className="btn btn-secondary" onClick={() => showResults(exam)}>{exam.attemptCount} ครั้ง</button></td><td><div className="table-actions"><button type="button" className="btn btn-secondary" onClick={() => openEdit(exam)}><i className="fas fa-pen" /></button><button type="button" className="btn btn-danger" onClick={() => remove(exam)}><i className="fas fa-trash" /></button></div></td></tr>)}</tbody></table></div>}
      </div>
    </div>

    {resultsFor && <div className="modal-overlay active" onMouseDown={(e) => { if (e.target === e.currentTarget) setResultsFor(null); }}><div className="modal-content tutored-results-modal"><div className="modal-header"><h3>ผลข้อสอบ · {resultsFor.titleTh || resultsFor.title}</h3><button type="button" className="btn btn-secondary" onClick={() => setResultsFor(null)}><i className="fas fa-xmark" /></button></div><div className="modal-body">{attempts === null ? <div className="empty-state">กำลังโหลด...</div> : attempts.length === 0 ? <div className="empty-state">นักเรียนยังไม่ได้ทำข้อสอบนี้</div> : attempts.map((a) => <div className="tutored-attempt" key={a.id}><div><strong>{a.score}/{a.maxScore}</strong> · {a.passed ? 'ผ่าน' : 'ยังไม่ผ่าน'}</div><small>{new Date(a.submittedAt).toLocaleString('th-TH')}</small></div>)}</div></div></div>}
  </>;
}

function QuestionCard({ q, index, onChange, onRemove }: { q: QuizQuestion; index: number; onChange: (q: QuizQuestion) => void; onRemove: () => void }) {
  const type = q.type as QuestionType;
  const options = q.options ?? [];
  const setType = (next: QuestionType) => onChange(blankQuestion(next));
  return <div className="admin-card tutored-question-card"><div className="card-title-bar"><strong>ข้อ {index + 1}</strong><div style={{ flex: 1 }} /><select value={type} onChange={(e) => setType(e.target.value as QuestionType)}><option value="single">เลือกตอบข้อเดียว</option><option value="multiple">เลือกได้หลายข้อ</option><option value="truefalse">จริง / เท็จ</option><option value="short">คำตอบสั้น</option></select><button type="button" className="btn btn-danger" onClick={onRemove}><i className="fas fa-trash" /></button></div><div className="form-body"><div className="form-group"><label>คำถาม</label><textarea rows={2} value={q.prompt} onChange={(e) => onChange({ ...q, prompt: e.target.value })} /></div>{(type === 'single' || type === 'multiple') && <div className="tutored-options-list">{options.map((opt, oi) => <div className="tutored-option-row" key={oi}>{type === 'single' ? <input type="radio" name={`answer-${index}`} checked={Number(q.answer) === oi} onChange={() => onChange({ ...q, answer: oi })} /> : <input type="checkbox" checked={(Array.isArray(q.answer) ? q.answer : []).map(Number).includes(oi)} onChange={() => { const set = new Set((Array.isArray(q.answer) ? q.answer : []).map(Number)); set.has(oi) ? set.delete(oi) : set.add(oi); onChange({ ...q, answer: [...set] }); }} />}<input value={opt} onChange={(e) => { const next = [...options]; next[oi] = e.target.value; onChange({ ...q, options: next }); }} placeholder={`ตัวเลือก ${oi + 1}`} /><button type="button" className="btn btn-secondary" onClick={() => onChange({ ...q, options: options.filter((_, i) => i !== oi) })}><i className="fas fa-minus" /></button></div>)}<button type="button" className="btn btn-secondary" onClick={() => onChange({ ...q, options: [...options, ''] })}><i className="fas fa-plus" /> เพิ่มตัวเลือก</button></div>}{type === 'truefalse' && <div className="form-group"><label>คำตอบที่ถูก</label><select value={String(q.answer)} onChange={(e) => onChange({ ...q, answer: e.target.value === 'true' })}><option value="true">จริง</option><option value="false">เท็จ</option></select></div>}{type === 'short' && <div className="form-group"><label>คำตอบที่ยอมรับได้ (1 คำตอบต่อบรรทัด)</label><textarea rows={3} value={(Array.isArray(q.answer) ? q.answer : []).join('\n')} onChange={(e) => onChange({ ...q, answer: e.target.value.split('\n') })} /></div>}<div className="tutored-question-meta"><div className="form-group"><label>คะแนน</label><input type="number" min="1" max="100" value={q.points} onChange={(e) => onChange({ ...q, points: Math.max(1, Number(e.target.value) || 1) })} /></div><div className="form-group"><label>คำอธิบายเฉลย</label><input value={q.explanation || ''} onChange={(e) => onChange({ ...q, explanation: e.target.value })} /></div></div></div></div>;
}
