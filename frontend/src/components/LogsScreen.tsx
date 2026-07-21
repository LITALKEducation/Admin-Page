import { useEffect, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { useStudents } from '../hooks/useStudents';
import { useSharedStudentSelection } from '../hooks/useSharedStudentSelection';
import { useEditingLog } from '../hooks/useEditingLog';
import { useToast } from '../ui/ToastContext';
import StudentPicker, { StudentIndicator } from '../ui/StudentPicker';
import MarkdownField from '../ui/MarkdownField';
import { makeTokenGetter, createStudyLog, updateStudyLog } from '../api/client';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function LogsScreen() {
  const { getAccessTokenSilently } = useAuth0();
  const { students, failed: studentsFailed } = useStudents();
  const [selectedId, setSelectedId] = useSharedStudentSelection();
  const [editingLog, setEditingLog] = useEditingLog();
  const showToast = useToast();

  const [date, setDate] = useState(today());
  const [video, setVideo] = useState('');
  const [feedback, setFeedback] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (editingLog) {
      setDate(editingLog.date || '');
      setVideo(editingLog.video || '');
      setFeedback(editingLog.feedback || '');
    }
  }, [editingLog]);

  const selected = students.find((s) => s.id === selectedId) || null;

  const cancelEdit = () => {
    setEditingLog(null);
    setFeedback('');
    setVideo('');
  };

  const submit = async () => {
    if (!selectedId) {
      showToast('กรุณาเลือกนักเรียนจากรายชื่อด้านบน', undefined, 'error');
      return;
    }
    if (!feedback.trim()) {
      showToast('กรุณากรอกฟีดแบ็กการเรียน', undefined, 'error');
      return;
    }
    const payload = { studentId: selectedId, date, feedback, video };
    setSaving(true);
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      const result = editingLog ? await updateStudyLog(getToken, editingLog.id, payload) : await createStudyLog(getToken, payload);
      showToast('บันทึกสำเร็จ', result.message, 'success');
      setFeedback('');
      setVideo('');
      setEditingLog(null);
    } catch (error) {
      showToast('เกิดข้อผิดพลาดจากระบบ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
    setSaving(false);
  };

  return (
    <div id="screen-logs" className="tab-content active">
      <div className="screen-header">
        <h1>บันทึกการเรียน</h1>
        <p>บันทึกฟีดแบ็กและวิดีโอย้อนหลังหลังจบคลาส</p>
      </div>

      <div className="sticky-picker">
        <StudentPicker students={students} loadFailed={studentsFailed} value={selectedId} onChange={setSelectedId} />
        <StudentIndicator student={selected} verb="กำลังบันทึกให้" />
      </div>

      <div className={`form-cards-wrapper${selectedId ? '' : ' disabled'}`}>
        <div className="admin-card">
          <div className="card-title-bar">
            <span className="card-icon">
              <i className="fas fa-book"></i>
            </span>
            <div>
              <h3>ข้อมูลคลาสเรียน</h3>
              <p>กรอกข้อมูลหลังจบคลาส ระบบบันทึกให้อัตโนมัติ</p>
            </div>
          </div>
          <div className="form-body">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div className="form-group">
                <label>
                  <i className="fas fa-calendar-day"></i> วันที่เรียน
                </label>
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
              <div className="form-group">
                <label>
                  <i className="fas fa-video"></i> ลิงก์วิดีโอย้อนหลัง
                </label>
                <input
                  type="url"
                  placeholder="https://drive.google.com/..."
                  value={video}
                  onChange={(e) => setVideo(e.target.value)}
                />
              </div>
            </div>
            <div className="form-group">
              <label>
                <i className="far fa-comment-alt"></i> ฟีดแบ็กการเรียน
              </label>
              <MarkdownField value={feedback} onChange={setFeedback} placeholder="วันนี้เรียนเรื่อง..." />
              <div className="form-hint">
                สรุปสิ่งที่เรียน จุดแข็ง และสิ่งที่ควรฝึกเพิ่ม · รองรับ Markdown เช่น **ตัวหนา**, *เอียง*, - รายการ
              </div>
            </div>

            {editingLog && (
              <div className="info-notice" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>
                  <i className="fas fa-pen"></i> กำลังแก้ไขบันทึกการเรียนเดิม
                </span>
                <button className="btn btn-secondary" style={{ padding: '4px 10px' }} onClick={cancelEdit}>
                  ยกเลิกการแก้ไข
                </button>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn btn-primary" onClick={submit} disabled={saving}>
                <i className="fas fa-save"></i> {editingLog ? 'บันทึกการแก้ไข' : 'บันทึกข้อมูลการเรียน'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
