import { useCallback, useEffect, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { makeTokenGetter, fetchCampusCheckins, type CampusCheckin } from '../api/client';

const CHECKIN_METHOD_ICON: Record<string, string> = { qr: 'fa-qrcode', barcode: 'fa-barcode', nfc: 'fa-wifi' };
const CHECKIN_METHOD_LABEL: Record<string, string> = { qr: 'QR', barcode: 'บาร์โค้ด', nfc: 'NFC' };

function formatCheckinTime(iso?: string): string {
  if (!iso) return '-';
  const d = new Date(String(iso).replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? '-' : d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
}

export default function CheckinsScreen() {
  const { getAccessTokenSilently } = useAuth0();
  const [rows, setRows] = useState<CampusCheckin[] | null>(null);

  const load = useCallback(async () => {
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      setRows(await fetchCampusCheckins(getToken));
    } catch (error) {
      console.error('loadCampusCheckins:', error);
      setRows(null);
    }
  }, [getAccessTokenSilently]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div id="screen-checkins" className="tab-content active">
      <div className="screen-header">
        <h1>บันทึกเข้า-ออก</h1>
        <p>ประวัติการเช็คชื่อเข้า-ออกวันนี้จากจุดสแกนหน้างาน (scan.html) — ทั้งนักเรียนและเจ้าหน้าที่</p>
      </div>

      <div className="admin-card">
        <div className="card-title-bar">
          <span className="card-icon">
            <i className="fas fa-right-left"></i>
          </span>
          <div>
            <h3>รายการวันนี้</h3>
            <p>{rows ? `${rows.length} รายการวันนี้` : 'ล่าสุด 200 รายการ'}</p>
          </div>
          <button type="button" className="btn btn-secondary" style={{ marginLeft: 'auto' }} title="รีเฟรช" onClick={load}>
            <i className="fas fa-rotate"></i>
          </button>
        </div>
        {rows === null ? (
          <div className="form-hint">โหลดรายการไม่สำเร็จ (ต้องเป็นแอดมินเท่านั้น)</div>
        ) : !rows.length ? (
          <div className="empty-state">
            <i className="far fa-folder-open"></i>
            <p>ยังไม่มีการเช็คชื่อเข้า-ออกวันนี้</p>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>ชื่อ</th>
                  <th>ประเภท</th>
                  <th>เข้า</th>
                  <th>ออก</th>
                  <th>วิธี</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td>
                      {r.personName} <span className="form-hint" style={{ margin: 0 }}>({r.personId})</span>
                    </td>
                    <td>{r.personType === 'staff' ? 'ครู/พนักงาน' : 'นักเรียน'}</td>
                    <td>
                      {formatCheckinTime(r.checkedInAt)} <span className="form-hint" style={{ margin: 0 }}>{r.checkedInBy || '-'}</span>
                    </td>
                    <td>
                      {r.checkedOutAt ? (
                        <>
                          {formatCheckinTime(r.checkedOutAt)} <span className="form-hint" style={{ margin: 0 }}>{r.checkedOutBy || '-'}</span>
                        </>
                      ) : (
                        <span className="badge-soft" style={{ color: 'var(--accent-success)' }}>
                          ยังอยู่ในสถานที่
                        </span>
                      )}
                    </td>
                    <td>
                      <i className={`fas ${CHECKIN_METHOD_ICON[r.scanMethod] || 'fa-qrcode'}`} title={CHECKIN_METHOD_LABEL[r.scanMethod] || r.scanMethod}></i>
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
