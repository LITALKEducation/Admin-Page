import { useCallback, useEffect, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { useStudents } from '../hooks/useStudents';
import { useConfirm } from '../ui/ConfirmContext';
import { useToast } from '../ui/ToastContext';
import { makeTokenGetter, fetchNfcCards, registerNfcCardApi, deleteNfcCardApi, fetchStaff, type NfcCard } from '../api/client';

export default function NfcScreen() {
  const { getAccessTokenSilently } = useAuth0();
  const { students } = useStudents();
  const confirmDialog = useConfirm();
  const showToast = useToast();

  const [cards, setCards] = useState<NfcCard[] | null>(null);
  const [uid, setUid] = useState('');
  const [personType, setPersonType] = useState<'student' | 'staff'>('student');
  const [personId, setPersonId] = useState('');
  const [error, setError] = useState('');
  const [staffOptions, setStaffOptions] = useState<{ identity: string; name?: string }[]>([]);

  const load = useCallback(async () => {
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      setCards(await fetchNfcCards(getToken));
    } catch (error) {
      console.error('loadNfcCards:', error);
      setCards(null);
    }
  }, [getAccessTokenSilently]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (personType !== 'staff') return;
    (async () => {
      try {
        const getToken = makeTokenGetter(getAccessTokenSilently);
        setStaffOptions(await fetchStaff(getToken));
      } catch {
        setStaffOptions([]);
      }
    })();
  }, [personType, getAccessTokenSilently]);

  const personOptions = personType === 'staff' ? staffOptions.map((r) => ({ value: r.identity, label: r.name || r.identity })) : students.map((s) => ({ value: s.id, label: s.name || s.id }));

  const scanNfc = async () => {
    if (!('NDEFReader' in window)) {
      showToast('ไม่รองรับ NFC', 'อุปกรณ์นี้ไม่รองรับการอ่าน NFC ผ่านเว็บ (ใช้ได้เฉพาะ Chrome บน Android) กรอก UID เองแทนได้', 'error');
      return;
    }
    try {
      // @ts-expect-error Web NFC is not in the standard TS DOM lib yet.
      const reader = new NDEFReader();
      await reader.scan();
      showToast('พร้อมอ่านบัตร', 'แตะบัตร NFC ที่ต้องการลงทะเบียนที่ด้านหลังอุปกรณ์นี้ได้เลย', 'info');
      reader.onreading = (event: { serialNumber?: string }) => {
        if (!event.serialNumber) return;
        setUid(event.serialNumber.replace(/:/g, '').toUpperCase());
      };
    } catch (err) {
      showToast('เปิดการอ่าน NFC ไม่สำเร็จ', err instanceof Error ? err.message : 'กรุณาอนุญาตสิทธิ์ NFC แล้วลองใหม่', 'error');
    }
  };

  const register = async () => {
    setError('');
    if (!uid.trim() || !personId.trim()) {
      setError('กรุณากรอก UID และเลือกเจ้าของบัตร');
      return;
    }
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      await registerNfcCardApi(getToken, uid.trim(), personType, personId.trim());
      setUid('');
      setPersonId('');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'บันทึกไม่สำเร็จ');
    }
  };

  const remove = async (cardUid: string) => {
    if (
      !(await confirmDialog(`ลบบัตร NFC (UID: ${cardUid}) ออกจากระบบ? นักเรียน/เจ้าหน้าที่คนนี้จะแตะบัตรนี้เพื่อเช็คชื่อไม่ได้อีก`, {
        title: 'ลบบัตร NFC',
        danger: true,
      }))
    )
      return;
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      await deleteNfcCardApi(getToken, cardUid);
      load();
    } catch (err) {
      showToast('ลบไม่สำเร็จ', err instanceof Error ? err.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  return (
    <div id="screen-nfc" className="tab-content active">
      <div className="screen-header">
        <h1>บัตร NFC</h1>
        <p>ลงทะเบียนบัตร NFC จริงที่แจกให้นักเรียนหรือเจ้าหน้าที่ — แตะบัตรที่เครื่องสแกนหน้างาน (scan.html) เพื่อเช็คชื่อเข้า-ออก เช่นเดียวกับ QR บนบัตรดิจิทัล</p>
      </div>

      <div className="admin-card">
        <div className="card-title-bar">
          <span className="card-icon">
            <i className="fas fa-wifi"></i>
          </span>
          <div>
            <h3>ลงทะเบียนบัตรใหม่</h3>
            <p>แตะบัตรที่อุปกรณ์นี้เพื่ออ่าน UID อัตโนมัติ (รองรับเฉพาะ Chrome บน Android) หรือกรอก UID เองก็ได้</p>
          </div>
        </div>
        <div className="form-body">
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 2fr', gap: 12 }}>
            <div className="form-group">
              <label>
                <i className="fas fa-wifi"></i> UID บัตร
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input type="text" placeholder="แตะบัตร หรือพิมพ์เอง" style={{ flex: 1 }} value={uid} onChange={(e) => setUid(e.target.value)} />
                <button type="button" className="btn btn-secondary" title="อ่าน UID จากบัตรด้วย NFC" onClick={scanNfc}>
                  <i className="fas fa-wifi"></i>
                </button>
              </div>
            </div>
            <div className="form-group">
              <label>
                <i className="fas fa-user-tag"></i> ประเภท
              </label>
              <select
                value={personType}
                onChange={(e) => {
                  setPersonType(e.target.value as 'student' | 'staff');
                  setPersonId('');
                }}
              >
                <option value="student">นักเรียน</option>
                <option value="staff">ครู/พนักงาน</option>
              </select>
            </div>
            <div className="form-group">
              <label>
                <i className="fas fa-id-badge"></i> เจ้าของบัตร
              </label>
              <input type="text" list="nfc-person-datalist" placeholder="รหัสนักเรียนหรืออีเมลเจ้าหน้าที่" value={personId} onChange={(e) => setPersonId(e.target.value)} />
              <datalist id="nfc-person-datalist">
                {personOptions.map((o) => (
                  <option value={o.value} key={o.value}>
                    {o.label}
                  </option>
                ))}
              </datalist>
            </div>
          </div>
          <div className="form-hint" style={{ color: 'var(--accent-danger)', minHeight: 18 }}>
            {error}
          </div>
          <button type="button" className="btn btn-primary" onClick={register}>
            <i className="fas fa-floppy-disk"></i> บันทึก
          </button>
        </div>
      </div>

      <div className="admin-card">
        <div className="card-title-bar">
          <span className="card-icon">
            <i className="fas fa-list"></i>
          </span>
          <div>
            <h3>บัตรที่ลงทะเบียนแล้ว</h3>
            <p>ล่าสุด 500 ใบ</p>
          </div>
        </div>
        {cards === null ? (
          <div className="form-hint">โหลดรายการไม่สำเร็จ (ต้องเป็นแอดมินเท่านั้น)</div>
        ) : !cards.length ? (
          <div className="empty-state">
            <i className="far fa-folder-open"></i>
            <p>ยังไม่มีบัตร NFC ที่ลงทะเบียน</p>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>UID</th>
                  <th>ประเภท</th>
                  <th>เจ้าของบัตร</th>
                  <th>ลงทะเบียนโดย</th>
                  <th>วันที่</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {cards.map((r) => (
                  <tr key={r.uid}>
                    <td>
                      <code>{r.uid}</code>
                    </td>
                    <td>{r.personType === 'staff' ? 'ครู/พนักงาน' : 'นักเรียน'}</td>
                    <td>{r.personId}</td>
                    <td>{r.registeredBy || '-'}</td>
                    <td>
                      {new Date(String(r.registeredAt).replace(' ', 'T') + 'Z').toLocaleDateString('th-TH', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </td>
                    <td>
                      <button className="icon-btn icon-btn-danger" title="ลบบัตรนี้" onClick={() => remove(r.uid)}>
                        <i className="fas fa-trash"></i>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
