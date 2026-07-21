import { useCallback, useEffect, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { useMe } from '../hooks/useMe';
import { useToast } from '../ui/ToastContext';
import { useConfirm } from '../ui/ConfirmContext';
import {
  makeTokenGetter,
  fetchShortLinks,
  createShortLinkApi,
  disableShortLinkApi,
  enableShortLinkApi,
  deleteShortLinkApi,
  type ShortLink,
} from '../api/client';

export default function LinksScreen() {
  const { getAccessTokenSilently } = useAuth0();
  const { isAdmin, me } = useMe();
  const showToast = useToast();
  const confirmDialog = useConfirm();

  const [links, setLinks] = useState<ShortLink[] | null>(null);
  const [domain, setDomain] = useState<'go' | 'payment'>('go');
  const [target, setTarget] = useState('');
  const [slug, setSlug] = useState('');
  const [studentId, setStudentId] = useState('');
  const [title, setTitle] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      setLinks(await fetchShortLinks(getToken));
    } catch (error) {
      console.error('loadShortLinks:', error);
      setLinks(null);
    }
  }, [getAccessTokenSilently]);

  useEffect(() => {
    load();
  }, [load]);

  const submit = async () => {
    if (!target.trim()) {
      showToast('กรุณากรอกลิงก์เป้าหมาย', undefined, 'error');
      return;
    }
    setCreating(true);
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      const res = await createShortLinkApi(getToken, {
        domain,
        target: target.trim(),
        ...(slug.trim() ? { slug: slug.trim() } : {}),
        ...(studentId.trim() ? { studentId: studentId.trim() } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
      });
      setResult(res.url);
      setTarget('');
      setSlug('');
      setStudentId('');
      setTitle('');
      load();
    } catch (error) {
      showToast('สร้างลิงก์ไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
    setCreating(false);
  };

  const disable = async (id: number) => {
    if (
      !(await confirmDialog('ระงับลิงก์นี้? ลิงก์จะใช้ไม่ได้ทันทีจนกว่าจะเปิดใช้งานอีกครั้ง (ประวัติการคลิกยังอยู่)', {
        title: 'ระงับลิงก์',
        danger: true,
        okLabel: 'ระงับลิงก์',
      }))
    )
      return;
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      await disableShortLinkApi(getToken, id);
      load();
      showToast('ระงับลิงก์แล้ว', undefined, 'success');
    } catch (error) {
      showToast('ระงับลิงก์ไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const enable = async (id: number) => {
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      await enableShortLinkApi(getToken, id);
      load();
      showToast('เปิดใช้งานลิงก์แล้ว', undefined, 'success');
    } catch (error) {
      showToast('เปิดใช้งานลิงก์ไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const remove = async (id: number) => {
    if (!(await confirmDialog('ลบลิงก์นี้ถาวร? การลบไม่สามารถย้อนกลับได้', { danger: true, okLabel: 'ลบลิงก์' }))) return;
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      await deleteShortLinkApi(getToken, id);
      load();
      showToast('ลบลิงก์แล้ว', undefined, 'success');
    } catch (error) {
      showToast('ลบลิงก์ไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const myEmail = (me?.email || '').toLowerCase();

  return (
    <div id="screen-links" className="tab-content active">
      <div className="screen-header">
        <h1>ลิงก์ย่อ</h1>
        <p>
          สร้างลิงก์ย่อสำหรับ go.litalkeducation.com (ใช้งานทั่วไป) หรือ payment.litalkeducation.com (ลิงก์ชำระเงิน) — ลิงก์ชำระเงินที่ระบบสร้างให้ตอนอนุมัติตารางเรียน/สร้างลิงก์
          Stripe จะมีลิงก์ย่อให้อัตโนมัติอยู่แล้ว ไม่ต้องสร้างเอง
        </p>
      </div>

      <div className="admin-card" style={{ marginBottom: 20 }}>
        <div className="card-title-bar">
          <span className="card-icon">
            <i className="fas fa-plus"></i>
          </span>
          <div>
            <h3>สร้างลิงก์ย่อใหม่</h3>
            <p>ไม่กำหนดลิงก์ท้าย ระบบจะสุ่มให้อัตโนมัติ</p>
          </div>
        </div>
        <div className="form-body">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div className="form-group">
              <label>
                <i className="fas fa-globe"></i> โดเมน
              </label>
              <select value={domain} onChange={(e) => setDomain(e.target.value as 'go' | 'payment')}>
                <option value="go">go.litalkeducation.com (ใช้งานทั่วไป)</option>
                <option value="payment">payment.litalkeducation.com (ลิงก์ชำระเงิน)</option>
              </select>
            </div>
            <div className="form-group">
              <label>
                <i className="fas fa-link"></i> ลิงก์เป้าหมาย (URL)
              </label>
              <input type="url" placeholder="https://..." value={target} onChange={(e) => setTarget(e.target.value)} />
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div className="form-group">
              <label>
                <i className="fas fa-slash"></i> ลิงก์ท้าย (ไม่บังคับ)
              </label>
              <input type="text" placeholder="ไม่กำหนด = สุ่มอัตโนมัติ" maxLength={64} value={slug} onChange={(e) => setSlug(e.target.value)} />
            </div>
            {domain === 'payment' && (
              <div className="form-group">
                <label>
                  <i className="fas fa-id-card"></i> รหัสนักเรียน (ไม่บังคับ)
                </label>
                <input
                  type="text"
                  placeholder="เช่น LT-000123 — ใช้ตั้งชื่อลิงก์ท้ายอัตโนมัติเป็น {รหัสนักเรียน}-{สุ่ม}"
                  value={studentId}
                  onChange={(e) => setStudentId(e.target.value)}
                />
              </div>
            )}
          </div>
          <div className="form-group">
            <label>
              <i className="fas fa-tag"></i> ชื่อลิงก์ (ไม่บังคับ, ไว้จำในรายการ)
            </label>
            <input type="text" placeholder="เช่น ลิงก์โปรโมชันหน้าเว็บ" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn btn-primary" onClick={submit} disabled={creating}>
              <i className="fas fa-wand-magic-sparkles"></i> สร้างลิงก์ย่อ
            </button>
          </div>
          {result && (
            <div className="info-notice" style={{ marginTop: 16 }}>
              <i className="fas fa-check-circle"></i>
              <div style={{ minWidth: 0 }}>
                <strong>สร้างลิงก์สำเร็จ:</strong>{' '}
                <a href={result} target="_blank" rel="noopener" style={{ wordBreak: 'break-all' }}>
                  {result}
                </a>
                <button className="btn btn-secondary" style={{ marginLeft: 8, padding: '6px 10px' }} onClick={() => navigator.clipboard.writeText(result)}>
                  <i className="fas fa-copy"></i> คัดลอก
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="admin-card">
        <div className="card-title-bar">
          <span className="card-icon">
            <i className="fas fa-list"></i>
          </span>
          <div>
            <h3>ลิงก์ทั้งหมด</h3>
            <p>{isAdmin ? 'ลิงก์ย่อทั้งหมดในระบบ' : 'ลิงก์ย่อของคุณ'}</p>
          </div>
        </div>
        <div className="row-list">
          {links === null ? (
            <div className="form-hint">โหลดรายการลิงก์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง</div>
          ) : !links.length ? (
            <div className="form-hint">ยังไม่มีลิงก์ย่อ — กรอกฟอร์มด้านบนเพื่อสร้างลิงก์แรก</div>
          ) : (
            links.map((l) => {
              const mine = (l.createdBy || '').toLowerCase() === myEmail;
              const disabled = !!l.disabledAt;
              return (
                <div className="alert-row" style={{ alignItems: 'flex-start', opacity: disabled ? 0.6 : 1 }} key={l.id}>
                  <i className="fas fa-link" style={{ color: 'var(--text-muted)', marginTop: 3 }}></i>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="alert-text">
                      <strong>{l.url}</strong>
                      <span style={{ color: 'var(--text-muted)' }}> ({l.domain === 'payment' ? 'payment' : 'go'})</span>
                      {disabled && <span style={{ color: 'var(--accent-danger)' }}> · ระงับอยู่</span>}
                    </div>
                    <div className="alert-text" style={{ color: 'var(--text-muted)', fontSize: 12, wordBreak: 'break-all' }}>
                      {l.title ? `${l.title} — ` : ''}
                      {l.targetUrl}
                    </div>
                    <div className="alert-text" style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                      {l.studentId ? `นักเรียน ${l.studentId} · ` : ''}คลิก {l.clickCount || 0} ครั้ง · โดย {l.createdBy || '-'} · {(l.createdAt || '').slice(0, 16)}
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                      <button className="btn btn-secondary" style={{ padding: '6px 10px' }} title="คัดลอกลิงก์" onClick={() => navigator.clipboard.writeText(l.url)}>
                        <i className="fas fa-copy"></i>
                      </button>
                      {isAdmin &&
                        (disabled ? (
                          <button className="btn btn-success" style={{ padding: '6px 10px' }} onClick={() => enable(l.id)}>
                            <i className="fas fa-play"></i> เปิดใช้งาน
                          </button>
                        ) : (
                          <button className="btn btn-secondary" style={{ padding: '6px 10px' }} title="ระงับลิงก์นี้ชั่วคราว" onClick={() => disable(l.id)}>
                            <i className="fas fa-ban"></i> ระงับ
                          </button>
                        ))}
                      {(isAdmin || mine) && (
                        <button className="btn btn-danger" style={{ padding: '6px 10px' }} onClick={() => remove(l.id)}>
                          <i className="fas fa-trash"></i> ลบ
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
