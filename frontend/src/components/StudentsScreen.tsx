import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth0 } from '@auth0/auth0-react';
import { useStudents } from '../hooks/useStudents';
import { useMe } from '../hooks/useMe';
import { useSharedStudentSelection } from '../hooks/useSharedStudentSelection';
import { useToast } from '../ui/ToastContext';
import { useConfirm } from '../ui/ConfirmContext';
import Pagination from '../ui/Pagination';
import { downloadCsv, studentInitials } from '../utils/csv';
import { legacyLink, appLink } from '../utils/legacyLink';
import { makeTokenGetter, deleteStudent, type Student } from '../api/client';

const PAGE_SIZE = 10;

type SortKey = 'name' | 'course' | null;

const INTERNAL_SCREENS: Record<string, string> = {
  check: '/check',
  logs: '/logs',
  payments: '/payments',
  booking: '/booking',
  files: '/files',
};

function bangkokTodayLocal(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function StudentsScreen() {
  const { getAccessTokenSilently } = useAuth0();
  const { students, loading, failed, reload } = useStudents();
  const { isAdmin } = useMe();
  const showToast = useToast();
  const confirmDialog = useConfirm();
  const navigate = useNavigate();
  const [, setSelectedStudent] = useSharedStudentSelection();

  const goToStudentAndScreen = (studentId: string, screen: string) => {
    setOpenMenuId(null);
    const route = INTERNAL_SCREENS[screen];
    if (route) {
      setSelectedStudent(studentId);
      navigate(route);
    } else {
      window.location.href = legacyLink(screen, studentId);
    }
  };

  const [search, setSearch] = useState('');
  const [courseFilter, setCourseFilter] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.row-actions')) setOpenMenuId(null);
    };
    document.addEventListener('click', onClickOutside);
    return () => document.removeEventListener('click', onClickOutside);
  }, []);

  const courses = useMemo(
    () => [...new Set(students.map((s) => s.course).filter(Boolean))].sort() as string[],
    [students],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = students.filter((s) => {
      if (courseFilter && (s.course || '') !== courseFilter) return false;
      if (!q) return true;
      return [s.name, s.nickname, s.id, s.email, s.phone].some((v) => String(v || '').toLowerCase().includes(q));
    });
    if (sortKey) {
      const dir = sortDir === 'asc' ? 1 : -1;
      rows = [...rows].sort((a, b) => String(a[sortKey] || '').localeCompare(String(b[sortKey] || ''), 'th') * dir);
    }
    return rows;
  }, [students, search, courseFilter, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * PAGE_SIZE;
  const pageRows = filtered.slice(start, start + PAGE_SIZE);

  const setSort = (key: 'name' | 'course') => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const toggleSelected = (id: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const toggleSelectAll = (checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      filtered.forEach((s) => (checked ? next.add(s.id) : next.delete(s.id)));
      return next;
    });
  };

  const exportCsv = (onlySelected: boolean) => {
    const rows = onlySelected ? filtered.filter((s) => selected.has(s.id)) : filtered;
    if (!rows.length) {
      showToast('ไม่มีข้อมูลให้ส่งออก', onlySelected ? 'กรุณาเลือกนักเรียนอย่างน้อย 1 คน' : '', 'info');
      return;
    }
    const header = ['รหัสนักเรียน', 'ชื่อ', 'ชื่อเล่น', 'คอร์สเรียน', 'เบอร์โทร', 'อีเมล'];
    const body = rows.map((s) => [s.id, s.name, s.nickname || '', s.course || '', s.phone || '', s.email || '']);
    downloadCsv(`litalk-students-${bangkokTodayLocal()}.csv`, [header, ...body]);
    showToast('ส่งออกสำเร็จ', `บันทึก ${rows.length} รายการเป็นไฟล์ CSV แล้ว`, 'success');
  };

  const deleteOne = async (student: Student) => {
    setOpenMenuId(null);
    if (
      !(await confirmDialog(
        `ยืนยันการลบ ${student.name} ออกจากระบบ?\n\nประวัติการเรียนและการชำระเงินจะยังถูกเก็บไว้ และบัญชีเข้าสู่ระบบของนักเรียนจะไม่ถูกลบ`,
        { title: 'ลบนักเรียนออกจากระบบ', danger: true, okLabel: 'ลบนักเรียน' },
      ))
    )
      return;
    const getToken = makeTokenGetter(getAccessTokenSilently);
    const result = await deleteStudent(getToken, student.id);
    if (result.ok) {
      await reload();
      showToast('ลบนักเรียนสำเร็จ', `ลบ ${student.name} ออกจากระบบแล้ว`, 'success');
    } else {
      showToast('ลบนักเรียนไม่สำเร็จ', result.error || 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const bulkDelete = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    if (
      !(await confirmDialog(
        `ยืนยันการลบนักเรียน ${ids.length} คนออกจากระบบ?\n\nประวัติการเรียนและการชำระเงินจะยังถูกเก็บไว้ และบัญชีเข้าสู่ระบบของนักเรียนจะไม่ถูกลบ`,
        { title: 'ลบนักเรียนออกจากระบบ', danger: true, okLabel: 'ลบนักเรียน' },
      ))
    )
      return;
    const getToken = makeTokenGetter(getAccessTokenSilently);
    let okCount = 0;
    let failCount = 0;
    for (const id of ids) {
      const result = await deleteStudent(getToken, id);
      if (result.ok) okCount++;
      else failCount++;
    }
    setSelected(new Set());
    await reload();
    if (failCount === 0) {
      showToast('ลบนักเรียนสำเร็จ', `ลบนักเรียน ${okCount} คนออกจากระบบแล้ว`, 'success');
    } else {
      showToast('ลบนักเรียนบางส่วนไม่สำเร็จ', `ลบสำเร็จ ${okCount} คน, ไม่สำเร็จ ${failCount} คน`, 'error');
    }
  };

  const copyStudyLogLink = async (studentId: string) => {
    setOpenMenuId(null);
    const url = appLink('logs', studentId);
    try {
      await navigator.clipboard.writeText(url);
      showToast('คัดลอกลิงก์แล้ว', undefined, 'success');
    } catch {
      showToast('คัดลอกอัตโนมัติไม่สำเร็จ', url, 'error');
    }
  };

  const countLabel =
    search || courseFilter
      ? `แสดง ${filtered.length} จากทั้งหมด ${students.length} คน`
      : `นักเรียนทั้งหมด ${students.length} คน`;

  const sortIcon = (key: 'name' | 'course') =>
    sortKey === key ? (sortDir === 'asc' ? 'fas fa-sort-up' : 'fas fa-sort-down') : 'fas fa-sort';

  return (
    <div id="screen-students" className="tab-content active" ref={containerRef}>
      <div className="dashboard-top">
        <div className="screen-header">
          <h1>รายชื่อนักเรียน</h1>
          <p>{countLabel}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" onClick={() => exportCsv(false)}>
            <i className="fas fa-file-export"></i> Export
          </button>
          {isAdmin && (
            <a className="btn btn-primary" href={legacyLink('create')}>
              <i className="fas fa-plus"></i> เพิ่มนักเรียน
            </a>
          )}
        </div>
      </div>

      <div className="table-toolbar">
        <div className="search-box">
          <i className="fas fa-magnifying-glass"></i>
          <input
            type="text"
            placeholder="ค้นหาชื่อ ชื่อเล่น หรือรหัสนักเรียน..."
            value={search}
            onChange={(e) => {
              setPage(1);
              setSearch(e.target.value);
            }}
          />
        </div>
        <div className="select-wrapper" style={{ width: 'auto' }}>
          <select
            value={courseFilter}
            onChange={(e) => {
              setPage(1);
              setCourseFilter(e.target.value);
            }}
          >
            <option value="">คอร์สทั้งหมด</option>
            {courses.map((c) => (
              <option value={c} key={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </div>

      {selected.size > 0 && (
        <div className="bulk-action-bar">
          <span>{selected.size} รายการที่เลือก</span>
          <span className="bulk-action-spacer"></span>
          <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={() => exportCsv(true)}>
            <i className="fas fa-file-export"></i> ส่งออกที่เลือก
          </button>
          {isAdmin && (
            <button className="btn btn-danger" style={{ padding: '6px 12px' }} onClick={bulkDelete}>
              <i className="fas fa-user-slash"></i> ลบที่เลือก
            </button>
          )}
          <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={() => setSelected(new Set())}>
            <i className="fas fa-xmark"></i> ยกเลิก
          </button>
        </div>
      )}

      <div className="students-table-card">
        <div className="table-scroll" style={{ overflow: 'visible' }}>
          <table className="students-table">
            <thead>
              <tr>
                <th style={{ width: 36 }}>
                  <input
                    type="checkbox"
                    checked={pageRows.length > 0 && pageRows.every((s) => selected.has(s.id))}
                    onChange={(e) => toggleSelectAll(e.target.checked)}
                  />
                </th>
                <th>
                  <button className={`th-sort-btn${sortKey === 'name' ? ' active' : ''}`} onClick={() => setSort('name')}>
                    นักเรียน
                    <i className={sortIcon('name')}></i>
                  </button>
                </th>
                <th>
                  <button
                    className={`th-sort-btn${sortKey === 'course' ? ' active' : ''}`}
                    onClick={() => setSort('course')}
                  >
                    คอร์สเรียน
                    <i className={sortIcon('course')}></i>
                  </button>
                </th>
                <th>ติดต่อ</th>
                <th style={{ textAlign: 'right' }}></th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((s) => {
                const checked = selected.has(s.id);
                return (
                  <tr
                    key={s.id}
                    className={checked ? 'row-selected' : ''}
                    onClick={() => {
                      setSelectedStudent(s.id);
                      navigate('/check');
                    }}
                  >
                    <td onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => toggleSelected(s.id, e.target.checked)}
                      />
                    </td>
                    <td>
                      <div className="student-cell">
                        <span className="avatar">{studentInitials(s.name)}</span>
                        <div style={{ minWidth: 0 }}>
                          <div className="s-name">
                            {s.name}
                            {s.nickname && (
                              <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> ({s.nickname})</span>
                            )}
                          </div>
                          <div className="s-id">{s.id}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      {s.course ? (
                        <span className="badge-soft">{s.course}</span>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>-</span>
                      )}
                    </td>
                    <td style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
                      {[s.phone, s.email].filter(Boolean).join(' · ') || (
                        <span style={{ color: 'var(--text-muted)' }}>-</span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                      <div className={`row-actions${openMenuId === s.id ? ' open' : ''}`}>
                        <button
                          className="row-actions-btn"
                          aria-haspopup="menu"
                          onClick={() => setOpenMenuId(openMenuId === s.id ? null : s.id)}
                        >
                          จัดการ <i className="fas fa-chevron-down" style={{ fontSize: 10 }}></i>
                        </button>
                        <div className="row-actions-menu" role="menu">
                          <button
                            className="row-actions-item"
                            onClick={() => goToStudentAndScreen(s.id, 'check')}
                          >
                            <i className="fas fa-id-card"></i> ดูโปรไฟล์
                          </button>
                          <div className="row-actions-divider"></div>
                          <button className="row-actions-item" onClick={() => goToStudentAndScreen(s.id, 'logs')}>
                            <i className="fas fa-pen"></i> บันทึกการเรียน
                          </button>
                          <button className="row-actions-item" onClick={() => goToStudentAndScreen(s.id, 'booking')}>
                            <i className="fas fa-calendar-check"></i> จองเวลาเรียน
                          </button>
                          <a className="row-actions-item" href={legacyLink('schedule', s.id)}>
                            <i className="fas fa-calendar-days"></i> ตารางเรียนรายเดือน
                          </a>
                          <button className="row-actions-item" onClick={() => goToStudentAndScreen(s.id, 'payments')}>
                            <i className="fas fa-money-bill-wave"></i> บันทึกการชำระเงิน
                          </button>
                          <button className="row-actions-item" onClick={() => goToStudentAndScreen(s.id, 'files')}>
                            <i className="fas fa-folder-open"></i> ไฟล์นักเรียน
                          </button>
                          <div className="row-actions-divider"></div>
                          <button className="row-actions-item" onClick={() => copyStudyLogLink(s.id)}>
                            <i className="fas fa-link"></i> คัดลอกลิงก์ Study Log
                          </button>
                          {isAdmin && (
                            <button className="row-actions-item danger" onClick={() => deleteOne(s)}>
                              <i className="fas fa-user-slash"></i> ลบนักเรียน
                            </button>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {!filtered.length && (
          <div>
            {failed ? (
              <div className="empty-state">
                <i className="fas fa-triangle-exclamation"></i>
                <div className="empty-title">โหลดรายชื่อไม่สำเร็จ</div>
                <div className="empty-sub">กรุณารีเฟรชหน้าเว็บแล้วลองใหม่อีกครั้ง</div>
              </div>
            ) : students.length ? (
              <div className="empty-state">
                <i className="fas fa-magnifying-glass"></i>
                <div className="empty-title">ไม่พบนักเรียนที่ค้นหา</div>
                <div className="empty-sub">ลองปรับคำค้นหาหรือตัวกรองคอร์สเรียน</div>
              </div>
            ) : loading ? (
              <div className="empty-state">
                <i className="fas fa-spinner fa-spin"></i>
                <div className="empty-title">กำลังโหลดรายชื่อนักเรียน...</div>
              </div>
            ) : (
              <div className="empty-state">
                <i className="fas fa-user-graduate"></i>
                <div className="empty-title">ยังไม่มีนักเรียนในระบบ</div>
                <div className="empty-sub">เพิ่มนักเรียนใหม่ได้จากปุ่ม "เพิ่มนักเรียน" ด้านบน</div>
              </div>
            )}
          </div>
        )}

        {totalPages > 1 && (
          <div className="table-pagination">
            <Pagination
              page={safePage}
              totalPages={totalPages}
              totalItems={filtered.length}
              start={start}
              pageCount={pageRows.length}
              onGoToPage={setPage}
            />
          </div>
        )}
      </div>
    </div>
  );
}
