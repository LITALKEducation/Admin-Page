// CSV import/export for quiz questions.
//
// Lets staff author or bulk-update a quiz's questions in a spreadsheet and
// import the file into the editor (the questions then save through the normal
// editor flow — this module only parses/serialises, it never talks to the API).
//
// Columns (header row, case-insensitive):
//   type        single | multiple | truefalse | short
//   prompt      the question text
//   option1..N  answer choices (single/multiple only; leave blank otherwise).
//               Extra columns option6, option7, … are picked up automatically.
//   answer      single    -> the correct option's number (1-based) or its text
//               multiple  -> several option numbers/text, separated by ; or ,
//               truefalse -> TRUE / FALSE  (จริง/เท็จ, ถูก/ผิด, 1/0 also work)
//               short     -> accepted answers, separated by ;  (case-insensitive)
//   points      points for the question (default 1)
//   explanation optional feedback shown after grading
import type { QuizQuestion, QuestionType, QuizAudience } from '../api/client';

const TYPES: QuestionType[] = ['single', 'multiple', 'truefalse', 'short'];

/* ----------------------------- CSV primitives ----------------------------- */

// Quote a field only when it needs it (comma, quote, or newline), doubling any
// embedded quote — the standard CSV escaping Excel/Sheets expect.
function csvField(value: string): string {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map(csvField).join(',')).join('\r\n');
}

// A small state-machine CSV parser: handles quoted fields, escaped quotes (""),
// and commas / newlines inside quotes. Accepts \n, \r\n and bare \r line ends.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip BOM

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  // Flush the trailing field/row when the file doesn't end in a newline.
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/* ------------------------------- Template -------------------------------- */

const TEMPLATE_HEADER = ['type', 'prompt', 'option1', 'option2', 'option3', 'option4', 'option5', 'answer', 'points', 'explanation'];

const TEMPLATE_ROWS: string[][] = [
  ['single', 'ข้อใดคือเมืองหลวงของประเทศไทย', 'กรุงเทพมหานคร', 'เชียงใหม่', 'ภูเก็ต', 'ขอนแก่น', '', '1', '1', 'กรุงเทพมหานครเป็นเมืองหลวงของไทย'],
  ['multiple', 'ข้อใดเป็นผลไม้ (เลือกได้มากกว่า 1 ข้อ)', 'แอปเปิล', 'แครอท', 'กล้วย', 'มันฝรั่ง', '', '1;3', '2', 'แอปเปิลและกล้วยเป็นผลไม้'],
  ['truefalse', 'ประเทศไทยตั้งอยู่ในทวีปเอเชีย', '', '', '', '', '', 'TRUE', '1', ''],
  ['short', 'เมืองหลวงของประเทศญี่ปุ่นคือเมืองใด', '', '', '', '', '', 'โตเกียว;tokyo', '1', 'ตอบเป็นภาษาไทยหรืออังกฤษก็ได้'],
];

// A ready-to-fill sample file (header + one example of each question type).
export function quizCsvTemplate(): string {
  return toCsv([TEMPLATE_HEADER, ...TEMPLATE_ROWS]);
}

// Serialise a quiz's current questions back to the same CSV shape, so staff can
// export → edit in a spreadsheet → re-import.
export function questionsToCsv(questions: QuizQuestion[]): string {
  const maxOptions = questions.reduce((m, q) => Math.max(m, (q.options ?? []).length), 0);
  const optionCount = Math.max(4, maxOptions); // keep at least option1..4 for editing headroom
  const header = ['type', 'prompt', ...Array.from({ length: optionCount }, (_, i) => `option${i + 1}`), 'answer', 'points', 'explanation'];
  const rows = questions.map((q) => {
    const opts = q.options ?? [];
    const optionCells = Array.from({ length: optionCount }, (_, i) => opts[i] ?? '');
    return [q.type, q.prompt ?? '', ...optionCells, answerToCsv(q), String(q.points ?? 1), q.explanation ?? ''];
  });
  return toCsv([header, ...rows]);
}

function answerToCsv(q: QuizQuestion): string {
  switch (q.type) {
    case 'single':
      return typeof q.answer === 'number' ? String(q.answer + 1) : '';
    case 'multiple':
      return Array.isArray(q.answer) ? q.answer.map((n) => Number(n) + 1).join(';') : '';
    case 'truefalse':
      return q.answer ? 'TRUE' : 'FALSE';
    case 'short':
      return Array.isArray(q.answer) ? q.answer.join(';') : '';
    default:
      return '';
  }
}

/* --------------------------------- Import -------------------------------- */

export interface CsvImportResult {
  questions: QuizQuestion[];
  errors: string[];
}

const TRUE_RE = /^(true|t|yes|y|1|จริง|ถูก|ใช่)$/i;
const FALSE_RE = /^(false|f|no|n|0|เท็จ|ผิด|ไม่ใช่)$/i;

// Resolve one answer token to an option index: a 1-based number, or the option
// text itself (case-insensitive). Returns -1 when it matches nothing.
function resolveOptionIndex(token: string, options: string[]): number {
  const t = token.trim();
  if (!t) return -1;
  if (/^\d+$/.test(t)) {
    const n = parseInt(t, 10) - 1;
    return n >= 0 && n < options.length ? n : -1;
  }
  return options.findIndex((o) => o.trim().toLowerCase() === t.toLowerCase());
}

// The question-column layout of a header row, resolved once and reused per row.
interface QuestionCols {
  type: number;
  prompt: number;
  answer: number;
  points: number;
  explain: number;
  optionCols: number[];
}

function questionCols(header: string[]): QuestionCols {
  const col = (name: string) => header.indexOf(name);
  const optionCols = header
    .map((h, idx) => ({ idx, m: /^option\s*(\d+)$/.exec(h) }))
    .filter((x) => x.m)
    .sort((a, b) => Number(a.m![1]) - Number(b.m![1]))
    .map((x) => x.idx);
  return { type: col('type'), prompt: col('prompt'), answer: col('answer'), points: col('points'), explain: col('explanation'), optionCols };
}

// Turn one CSV data row into an editor-shaped question, or push a line-numbered
// error and return null. Shared by the single-quiz and multi-quiz importers.
function parseQuestionRow(cells: string[], cm: QuestionCols, line: number, errors: string[]): QuizQuestion | null {
  const get = (i: number) => (i >= 0 && i < cells.length ? cells[i] : '').trim();
  const type = get(cm.type).toLowerCase() as QuestionType;
  const prompt = get(cm.prompt);
  const answerRaw = get(cm.answer);
  const pointsNum = parseInt(get(cm.points), 10);
  const points = Number.isFinite(pointsNum) && pointsNum > 0 ? pointsNum : 1;
  const explanation = cm.explain >= 0 ? get(cm.explain) : '';

  if (!TYPES.includes(type)) {
    errors.push(`บรรทัด ${line}: ประเภทคำถาม "${get(cm.type)}" ไม่ถูกต้อง (ใช้ single, multiple, truefalse หรือ short)`);
    return null;
  }
  if (!prompt) {
    errors.push(`บรรทัด ${line}: ไม่มีข้อความคำถาม (prompt)`);
    return null;
  }

  const base = { type, prompt, explanation, points };

  if (type === 'single' || type === 'multiple') {
    const options = cm.optionCols.map((i) => get(i)).filter((o) => o !== '');
    if (options.length < 2) {
      errors.push(`บรรทัด ${line}: ต้องมีตัวเลือกอย่างน้อย 2 ข้อ (option1, option2, …)`);
      return null;
    }
    const tokens = answerRaw.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
    if (tokens.length === 0) {
      errors.push(`บรรทัด ${line}: ไม่ได้ระบุคำตอบที่ถูกต้อง (answer)`);
      return null;
    }
    const indexes = tokens.map((tk) => resolveOptionIndex(tk, options));
    const bad = tokens.filter((_, k) => indexes[k] < 0);
    if (bad.length) {
      errors.push(`บรรทัด ${line}: คำตอบ "${bad.join(', ')}" ไม่ตรงกับตัวเลือกใด`);
      return null;
    }
    const uniq = Array.from(new Set(indexes)).sort((a, b) => a - b);
    return type === 'single' ? { ...base, options, answer: uniq[0] } : { ...base, options, answer: uniq };
  }

  if (type === 'truefalse') {
    if (TRUE_RE.test(answerRaw)) return { ...base, options: [], answer: true };
    if (FALSE_RE.test(answerRaw)) return { ...base, options: [], answer: false };
    errors.push(`บรรทัด ${line}: คำตอบถูก/ผิดต้องเป็น TRUE หรือ FALSE`);
    return null;
  }

  // short — accepted answers separated by ";" (matched case-insensitively at grading)
  const accepted = answerRaw.split(';').map((s) => s.trim()).filter(Boolean);
  if (accepted.length === 0) {
    errors.push(`บรรทัด ${line}: ไม่ได้ระบุคำตอบที่ยอมรับได้ (answer)`);
    return null;
  }
  return { ...base, options: [], answer: accepted };
}

// Parse a CSV file into editor-shaped questions for a single quiz. Invalid rows
// are collected in `errors` (with 1-based line numbers) and skipped, so a good
// file still imports even if a few rows are malformed.
export function csvToQuestions(text: string): CsvImportResult {
  const rows = parseCsv(text).filter((r) => r.some((c) => c.trim() !== '')); // drop blank lines
  const errors: string[] = [];
  if (rows.length < 2) {
    return { questions: [], errors: ['ไฟล์ว่างหรือมีแต่หัวตาราง — ต้องมีอย่างน้อย 1 คำถาม'] };
  }
  const cm = questionCols(rows[0].map((h) => h.trim().toLowerCase()));
  if (cm.type < 0 || cm.prompt < 0 || cm.answer < 0) {
    return { questions: [], errors: ['หัวตารางไม่ถูกต้อง — ต้องมีคอลัมน์ type, prompt และ answer (ใช้ไฟล์ Template เป็นตัวอย่าง)'] };
  }

  const questions: QuizQuestion[] = [];
  for (let r = 1; r < rows.length; r++) {
    const q = parseQuestionRow(rows[r], cm, r + 1, errors);
    if (q) questions.push(q);
  }
  return { questions, errors };
}

/* --------------------- Multi-quiz import (bulk create) --------------------- */

// One quiz assembled from a group of CSV rows sharing the same `quiz` value.
// Shaped to drop straight into createQuiz (title required; the rest optional).
export interface ImportedQuiz {
  title: string;
  titleTh?: string;
  category?: string;
  audience?: QuizAudience;
  passScore?: number;
  questions: QuizQuestion[];
}

export interface MultiCsvImportResult {
  quizzes: ImportedQuiz[];
  errors: string[];
}

const MULTI_HEADER = ['quiz', 'quiz_th', 'category', 'audience', 'pass_score', 'type', 'prompt', 'option1', 'option2', 'option3', 'option4', 'answer', 'points', 'explanation'];

const MULTI_ROWS: string[][] = [
  ['Present Simple', 'Present Simple Tense', 'Grammar', 'on_demand', '70', 'single', 'She ___ to school every day.', 'go', 'goes', 'going', 'gone', '2', '1', 'บุรุษที่ 3 เอกพจน์ เติม -s'],
  ['Present Simple', '', '', '', '', 'truefalse', '"He plays football" เป็น present simple', '', '', '', '', 'TRUE', '1', ''],
  ['Present Simple', '', '', '', '', 'short', 'รูปช่องที่ 1 ของ "went" คือ', '', '', '', '', 'go', '1', ''],
  ['Vocabulary A1', 'คำศัพท์ระดับ A1', 'Vocabulary', 'on_demand', '60', 'single', 'สถานที่ที่เรายืมหนังสือได้', 'library', 'hospital', 'market', '', '1', '1', ''],
  ['Vocabulary A1', '', '', '', '', 'multiple', 'ข้อใดเป็นสี (เลือกได้หลายข้อ)', 'red', 'run', 'blue', 'eat', '1;3', '2', ''],
];

// A ready-to-fill sample file for bulk-creating several quizzes at once. Rows
// with the same `quiz` become one quiz; the per-quiz columns (quiz_th, category,
// audience, pass_score) are read from the first row of each group.
export function multiQuizCsvTemplate(): string {
  return toCsv([MULTI_HEADER, ...MULTI_ROWS]);
}

// Parse a CSV file into several quizzes, grouped by the `quiz` column. Rows that
// leave `quiz` blank inherit the previous row's quiz (so the name only has to be
// typed once per group). Invalid question rows are reported and skipped; a group
// left with no valid questions is dropped with a note.
export function csvToQuizzes(text: string): MultiCsvImportResult {
  const rows = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ''));
  const errors: string[] = [];
  if (rows.length < 2) {
    return { quizzes: [], errors: ['ไฟล์ว่างหรือมีแต่หัวตาราง — ต้องมีอย่างน้อย 1 คำถาม'] };
  }

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const cm = questionCols(header);
  const iQuiz = header.indexOf('quiz');
  const iQuizTh = header.indexOf('quiz_th');
  const iCategory = header.indexOf('category');
  const iAudience = header.indexOf('audience');
  const iPass = header.indexOf('pass_score');

  if (cm.type < 0 || cm.prompt < 0 || cm.answer < 0) {
    return { quizzes: [], errors: ['หัวตารางไม่ถูกต้อง — ต้องมีคอลัมน์ type, prompt และ answer (ใช้ไฟล์ Template หลายชุดเป็นตัวอย่าง)'] };
  }
  if (iQuiz < 0 && iQuizTh < 0) {
    return { quizzes: [], errors: ['หัวตารางต้องมีคอลัมน์ quiz (ชื่อแบบทดสอบ) เพื่อจัดกลุ่มคำถามเป็นแต่ละชุด'] };
  }

  const byKey = new Map<string, ImportedQuiz>();
  const order: string[] = [];
  let lastKey = '';

  for (let r = 1; r < rows.length; r++) {
    const line = r + 1;
    const cells = rows[r];
    const get = (i: number) => (i >= 0 && i < cells.length ? cells[i] : '').trim();
    const titleEn = get(iQuiz);
    const titleTh = get(iQuizTh);
    let key = (titleEn || titleTh).toLowerCase();
    if (!key) key = lastKey; // blank quiz cell → same group as the row above
    if (!key) {
      errors.push(`บรรทัด ${line}: ไม่ได้ระบุชื่อแบบทดสอบ (quiz)`);
      continue;
    }
    lastKey = key;

    let quiz = byKey.get(key);
    if (!quiz) {
      quiz = { title: titleEn || titleTh, titleTh: titleTh || undefined, questions: [] };
      byKey.set(key, quiz);
      order.push(key);
    }
    // Fill per-quiz metadata from the first row of the group that supplies it.
    if (titleTh && !quiz.titleTh) quiz.titleTh = titleTh;
    if (iCategory >= 0 && !quiz.category) {
      const c = get(iCategory);
      if (c) quiz.category = c;
    }
    if (iAudience >= 0 && !quiz.audience) {
      const a = get(iAudience).toLowerCase();
      if (a === 'tutored' || a === 'on_demand') quiz.audience = a;
    }
    if (iPass >= 0 && quiz.passScore == null) {
      const p = parseInt(get(iPass), 10);
      if (Number.isFinite(p)) quiz.passScore = Math.min(100, Math.max(0, p));
    }

    const q = parseQuestionRow(cells, cm, line, errors);
    if (q) quiz.questions.push(q);
  }

  const quizzes: ImportedQuiz[] = [];
  for (const key of order) {
    const quiz = byKey.get(key)!;
    if (quiz.questions.length > 0) quizzes.push(quiz);
    else errors.push(`แบบทดสอบ "${quiz.title}" ไม่มีคำถามที่ถูกต้อง — ข้าม`);
  }
  return { quizzes, errors };
}
