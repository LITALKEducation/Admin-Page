import { useCallback, useEffect, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { useStudents } from '../hooks/useStudents';
import { useSharedStudentSelection } from '../hooks/useSharedStudentSelection';
import { useMe } from '../hooks/useMe';
import { useToast } from '../ui/ToastContext';
import { useConfirm } from '../ui/ConfirmContext';
import StudentPicker, { StudentIndicator } from '../ui/StudentPicker';
import FileUpload06 from './file-upload-06';
import {
  makeTokenGetter,
  fetchStudentFiles,
  uploadStudentFile,
  deleteStudentFile,
  fetchPublicFileLink,
  apiFetchBlob,
  downloadBlob,
  type StudentFile,
} from '../api/client';

export default function FilesScreen() {
  const { getAccessTokenSilently } = useAuth0();
  const { students, failed: studentsFailed } = useStudents();
  const [selectedId, setSelectedId] = useSharedStudentSelection();
  const { isAdmin } = useMe();
  const showToast = useToast();
  const confirmDialog = useConfirm();

  const [docType, setDocType] = useState('Homework');
  const [files, setFiles] = useState<StudentFile[] | null>(null);
  const [loading, setLoading] = useState(false);

  const selected = students.find((s) => s.id === selectedId) || null;

  const load = useCallback(async () => {
    if (!selectedId) {
      setFiles(null);
      return;
    }
    setLoading(true);
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      setFiles(await fetchStudentFiles(getToken, selectedId));
    } catch (error) {
      console.error('Error loading files:', error);
      setFiles(null);
    }
    setLoading(false);
  }, [getAccessTokenSilently, selectedId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleFileUpload = async (file: File, signal: AbortSignal) => {
    if (!selectedId) {
      throw new Error('กรุณาเลือกนักเรียนจากรายชื่อด้านบนก่อนอัปโหลด');
    }
    await uploadStudentFile(makeTokenGetter(getAccessTokenSilently), selectedId, docType, file, signal);
    showToast('อัปโหลดสำเร็จ', `บันทึกไฟล์ "${file.name}" เรียบร้อยแล้ว`, 'success');
    load();
  };

  const doDownload = async (f: StudentFile) => {
    try {
      const blob = await apiFetchBlob(makeTokenGetter(getAccessTokenSilently), `/files/${f.id}`);
      downloadBlob(blob, f.filename);
    } catch (error) {
      showToast('ดาวน์โหลดไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const doCopyPublicLink = async (f: StudentFile) => {
    try {
      const result = await fetchPublicFileLink(makeTokenGetter(getAccessTokenSilently), f.id);
      await navigator.clipboard.writeText(result.url).catch(() => {});
      showToast('คัดลอกลิงก์สาธารณะแล้ว', 'ใครก็ตามที่มีลิงก์นี้จะเปิดไฟล์ได้:\n' + result.url, 'success');
    } catch (error) {
      showToast('คัดลอกลิงก์ไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const doDelete = async (f: StudentFile) => {
    if (!(await confirmDialog(`ยืนยันการลบไฟล์ "${f.filename}"?`, { title: 'ลบไฟล์', danger: true, okLabel: 'ลบไฟล์' })))
      return;
    try {
      await deleteStudentFile(makeTokenGetter(getAccessTokenSilently), f.id);
      showToast('ลบไฟล์สำเร็จ', undefined, 'success');
      load();
    } catch (error) {
      showToast('ลบไฟล์ไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  return (
    <div id="screen-files" className="tab-content active">
      <div className="screen-header">
        <h1>ไฟล์นักเรียน</h1>
        <p>แนบการบ้าน ใบงาน หรือเอกสารอื่น ๆ ให้กับนักเรียน</p>
      </div>

      <div className="sticky-picker">
        <StudentPicker students={students} loadFailed={studentsFailed} value={selectedId} onChange={setSelectedId} />
        <StudentIndicator student={selected} verb="กำลังจัดการไฟล์ของ" />
      </div>

      <div className="admin-card">
        <div className="card-title-bar">
          <span className="card-icon">
            <i className="fas fa-upload"></i>
          </span>
          <div>
            <h3>อัปโหลดไฟล์นักเรียน</h3>
            <p>ไฟล์จะถูกเก็บในระบบคลาวด์และบันทึกประวัติการใช้งานอัตโนมัติ</p>
          </div>
        </div>

        <div className="info-notice">
          <i className="fas fa-info-circle"></i>
          <div>{isAdmin ? 'สิทธิ์ปัจจุบัน: Admin — อัปโหลด ดาวน์โหลด และลบไฟล์ได้' : 'สิทธิ์ปัจจุบัน: Teacher — อัปโหลดและดาวน์โหลดได้ แต่ลบไฟล์ไม่ได้'}</div>
        </div>

        <div className="form-body">
          <div className="form-group">
            <label>
              <i className="fas fa-tag"></i> ประเภทเอกสาร
            </label>
            <div className="select-wrapper">
              <select value={docType} onChange={(e) => setDocType(e.target.value)}>
                <option value="Homework">การบ้าน (Homework)</option>
                <option value="Worksheet">ใบงาน (Worksheet)</option>
                <option value="Exam">ข้อสอบ (Exam)</option>
                <option value="Attendance">การเข้าเรียน (Attendance)</option>
                <option value="Certificate">ใบรับรอง (Certificate)</option>
                <option value="Portfolio">ผลงาน (Portfolio)</option>
                <option value="Other">อื่น ๆ (Other)</option>
              </select>
            </div>
          </div>
          <FileUpload06
            accept="application/pdf,image/*,.doc,.docx,.xls,.xlsx"
            helperText="รองรับไฟล์ PDF, รูปภาพ และเอกสารทั่วไป"
            disabled={!selectedId}
            disabledText="กรุณาเลือกนักเรียนจากรายชื่อด้านบนก่อนอัปโหลด"
            onUpload={handleFileUpload}
          />
        </div>
      </div>

      <div className="admin-card" style={{ marginTop: 18 }}>
        <div className="card-title-bar">
          <span className="card-icon">
            <i className="fas fa-folder-open"></i>
          </span>
          <div>
            <h3>ไฟล์ทั้งหมด</h3>
            <p>รายการไฟล์ของนักเรียนที่เลือก</p>
          </div>
        </div>
        {!selectedId ? (
          <div className="form-hint">กรุณาเลือกนักเรียนเพื่อดูรายการไฟล์</div>
        ) : loading ? (
          <div className="form-hint">กำลังโหลดรายการไฟล์...</div>
        ) : !files ? (
          <div className="form-hint">โหลดรายการไฟล์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง</div>
        ) : !files.length ? (
          <div className="form-hint">ยังไม่มีไฟล์สำหรับนักเรียนคนนี้</div>
        ) : (
          <div className="files-table">
            <div className="files-table-head">
              <span>ไฟล์</span>
              <span>ประเภท</span>
              <span>อัปโหลดเมื่อ</span>
              <span>โดย</span>
              <span></span>
            </div>
            <div>
              {files.map((f) => (
                <div className="files-table-row" key={f.id}>
                  <span className="filename">
                    <i className="fas fa-file-lines"></i>
                    {f.filename}
                  </span>
                  <span className="file-type">{f.file_type}</span>
                  <span className="uploaded-at">{f.uploaded_at ? new Date(f.uploaded_at).toLocaleString('th-TH') : '-'}</span>
                  <span className="uploaded-by">{f.uploaded_by || '-'}</span>
                  <span className="file-actions">
                    <button className="icon-btn" title="ดาวน์โหลด" onClick={() => doDownload(f)}>
                      <i className="fas fa-download"></i>
                    </button>
                    <button className="icon-btn" title="คัดลอกลิงก์สาธารณะ" onClick={() => doCopyPublicLink(f)}>
                      <i className="fas fa-link"></i>
                    </button>
                    {isAdmin && (
                      <button className="icon-btn icon-btn-danger" title="ลบไฟล์" onClick={() => doDelete(f)}>
                        <i className="fas fa-trash"></i>
                      </button>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
