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
import type { QuizQuestion, QuestionType } from '../api/client';

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

// Parse a CSV file into editor-shaped questions. Invalid rows are collected in
// `errors` (with 1-based line numbers) and skipped, so a good file still
// imports even if a few rows are malformed.
export function csvToQuestions(text: string): CsvImportResult {
  const rows = parseCsv(text).filter((r) => r.some((c) => c.trim() !== '')); // drop blank lines
  const errors: string[] = [];
  if (rows.length < 2) {
    return { questions: [], errors: ['ไฟล์ว่างหรือมีแต่หัวตาราง — ต้องมีอย่างน้อย 1 คำถาม'] };
  }

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const iType = col('type');
  const iPrompt = col('prompt');
  const iAnswer = col('answer');
  const iPoints = col('points');
  const iExplain = col('explanation');
  // option columns, in numeric order (option1, option2, …).
  const optionCols = header
    .map((h, idx) => ({ idx, m: /^option\s*(\d+)$/.exec(h) }))
    .filter((x) => x.m)
    .sort((a, b) => Number(a.m![1]) - Number(b.m![1]))
    .map((x) => x.idx);

  if (iType < 0 || iPrompt < 0 || iAnswer < 0) {
    return { questions: [], errors: ['หัวตารางไม่ถูกต้อง — ต้องมีคอลัมน์ type, prompt และ answer (ใช้ไฟล์ Template เป็นตัวอย่าง)'] };
  }

  const questions: QuizQuestion[] = [];
  for (let r = 1; r < rows.length; r++) {
    const line = r + 1; // 1-based line number in the file
    const cells = rows[r];
    const get = (i: number) => (i >= 0 && i < cells.length ? cells[i] : '').trim();

    const type = get(iType).toLowerCase() as QuestionType;
    const prompt = get(iPrompt);
    const answerRaw = get(iAnswer);
    const pointsNum = parseInt(get(iPoints), 10);
    const points = Number.isFinite(pointsNum) && pointsNum > 0 ? pointsNum : 1;
    const explanation = iExplain >= 0 ? get(iExplain) : '';

    if (!TYPES.includes(type)) {
      errors.push(`บรรทัด ${line}: ประเภทคำถาม "${get(iType)}" ไม่ถูกต้อง (ใช้ single, multiple, truefalse หรือ short)`);
      continue;
    }
    if (!prompt) {
      errors.push(`บรรทัด ${line}: ไม่มีข้อความคำถาม (prompt)`);
      continue;
    }

    const base = { type, prompt, explanation, points };

    if (type === 'single' || type === 'multiple') {
      const options = optionCols.map((i) => get(i)).filter((o) => o !== '');
      if (options.length < 2) {
        errors.push(`บรรทัด ${line}: ต้องมีตัวเลือกอย่างน้อย 2 ข้อ (option1, option2, …)`);
        continue;
      }
      const tokens = answerRaw.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
      if (tokens.length === 0) {
        errors.push(`บรรทัด ${line}: ไม่ได้ระบุคำตอบที่ถูกต้อง (answer)`);
        continue;
      }
      const indexes = tokens.map((tk) => resolveOptionIndex(tk, options));
      const bad = tokens.filter((_, k) => indexes[k] < 0);
      if (bad.length) {
        errors.push(`บรรทัด ${line}: คำตอบ "${bad.join(', ')}" ไม่ตรงกับตัวเลือกใด`);
        continue;
      }
      const uniq = Array.from(new Set(indexes)).sort((a, b) => a - b);
      if (type === 'single') {
        questions.push({ ...base, options, answer: uniq[0] });
      } else {
        questions.push({ ...base, options, answer: uniq });
      }
      continue;
    }

    if (type === 'truefalse') {
      if (TRUE_RE.test(answerRaw)) questions.push({ ...base, options: [], answer: true });
      else if (FALSE_RE.test(answerRaw)) questions.push({ ...base, options: [], answer: false });
      else errors.push(`บรรทัด ${line}: คำตอบถูก/ผิดต้องเป็น TRUE หรือ FALSE`);
      continue;
    }

    // short — accepted answers separated by ";" (kept as-is; matched case-insensitively at grading)
    const accepted = answerRaw.split(';').map((s) => s.trim()).filter(Boolean);
    if (accepted.length === 0) {
      errors.push(`บรรทัด ${line}: ไม่ได้ระบุคำตอบที่ยอมรับได้ (answer)`);
      continue;
    }
    questions.push({ ...base, options: [], answer: accepted });
  }

  return { questions, errors };
}
