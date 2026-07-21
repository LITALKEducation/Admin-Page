import { useEffect, useRef, useState } from 'react';
import type { Student } from '../api/client';

// Shared searchable student dropdown, used by every screen that scopes its
// data to one student (logs/payments/files/booking/check/schedule/credits) —
// mirrors the legacy custom-dropdown markup/behavior.
export default function StudentPicker({
  students,
  loadFailed,
  value,
  onChange,
}: {
  students: Student[];
  loadFailed?: boolean;
  value: string;
  onChange: (studentId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', onClickOutside);
    return () => document.removeEventListener('click', onClickOutside);
  }, [open]);

  const selected = students.find((s) => s.id === value) || null;
  const filtered = query
    ? students.filter(
        (s) => s.name.toLowerCase().includes(query.toLowerCase()) || s.id.toLowerCase().includes(query.toLowerCase()),
      )
    : students;

  const triggerText = selected
    ? `[${selected.id}] ${selected.name}`
    : students.length
      ? '-- ค้นหาหรือเลือกนักเรียน --'
      : loadFailed
        ? 'โหลดรายชื่อนักเรียนไม่สำเร็จ — กรุณารีเฟรชหน้า'
        : '-- ยังไม่มีรายชื่อนักเรียนในระบบ --';

  return (
    <div className="form-group">
      <div className={`custom-dropdown${open ? ' active' : ''}`} ref={containerRef}>
        <div
          className="dropdown-trigger"
          onClick={() => {
            setOpen((o) => !o);
            setQuery('');
          }}
        >
          <span>{triggerText}</span>
          <div className="dropdown-actions">
            {value && (
              <i
                className="fas fa-times clear-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onChange('');
                  setOpen(false);
                }}
              ></i>
            )}
            <i className="fas fa-chevron-down arrow-icon"></i>
          </div>
        </div>
        <div className="dropdown-menu-panel">
          <div className="dropdown-search-box">
            <i className="fas fa-search search-icon"></i>
            <input
              type="text"
              placeholder="พิมพ์เพื่อค้นหาชื่อหรือรหัส..."
              value={query}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="dropdown-options-list">
            {filtered.length ? (
              filtered.map((s) => (
                <div
                  key={s.id}
                  className={`dropdown-option${s.id === value ? ' selected' : ''}`}
                  onClick={() => {
                    onChange(s.id);
                    setOpen(false);
                  }}
                >
                  <i className="far fa-user"></i> <span>[{s.id}] {s.name}</span>
                </div>
              ))
            ) : (
              <div className="dropdown-no-results">ไม่พบรายชื่อนักเรียน</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Shared "please pick a student first" / "recording for: X" banner shown
// under the picker on logs/payments/schedule/credits/files.
export function StudentIndicator({ student, verb }: { student: Student | null; verb: string }) {
  if (!student) {
    return (
      <div className="student-indicator empty">
        <i className="fas fa-info-circle"></i> <span>กรุณาเลือกนักเรียนจากรายชื่อด้านบนก่อนเริ่มบันทึกข้อมูล</span>
      </div>
    );
  }
  return (
    <div className="student-indicator selected">
      <i className="fas fa-user-check"></i>{' '}
      <span>
        {verb}: <strong>{student.name}</strong> ({student.id})
      </span>
    </div>
  );
}
