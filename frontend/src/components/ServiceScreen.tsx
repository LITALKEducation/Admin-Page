import { useCallback, useEffect, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { useToast } from '../ui/ToastContext';
import { useConfirm } from '../ui/ConfirmContext';
import {
  makeTokenGetter,
  fetchServiceNotices,
  createServiceNotice,
  updateServiceNotice,
  deleteServiceNotice,
  rotateServiceBypassToken,
  type ServiceNotice,
  type ServiceNoticeDraft,
  type ServicePreset,
  type ServiceSurface,
} from '../api/client';

// Each notice covers a whole event: a heads-up first, then the block, then it
// expires on its own. That is why one row carries three times rather than an
// admin having to create "closing soon" and "closed" as separate items.
const PRESETS: Array<{ id: ServicePreset; label: string; blurb: string; blocks: boolean }> = [
  {
    id: 'opening_soon',
    label: 'กำลังจะเปิดเร็ว ๆ นี้',
    blurb: 'ประกาศว่าส่วนนี้ยังไม่เปิด — ใช้คู่กับการปิดไว้จนถึงเวลาเปิด',
    blocks: true,
  },
  {
    id: 'trial_opening_soon',
    label: 'กำลังจะเปิดให้ทดลองเร็ว ๆ นี้',
    blurb: 'บอกล่วงหน้าว่ากำลังจะเปิดให้ทดลองใช้',
    blocks: true,
  },
  {
    id: 'closing_soon',
    label: 'กำลังจะปิดเร็ว ๆ นี้',
    blurb: 'แจ้งล่วงหน้าก่อนปิดปรับปรุง แล้วปิดจริงตามเวลาที่ตั้ง',
    blocks: true,
  },
  {
    id: 'trial_closing_soon',
    label: 'กำลังปิดทดลองใช้งานเร็ว ๆ นี้',
    blurb: 'แจ้งว่าช่วงทดลองใช้งานกำลังจะสิ้นสุด',
    blocks: true,
  },
  { id: 'custom', label: 'ข้อความกำหนดเอง', blurb: 'เขียนหัวข้อและเนื้อหาเองทั้งหมด', blocks: false },
];

const SURFACES: Array<{ id: ServiceSurface; label: string; hint: string }> = [
  { id: 'website', label: 'เว็บไซต์หลัก', hint: 'หน้าแรก หลักสูตร เกี่ยวกับเรา บทความ' },
  { id: 'chat_site', label: 'แชท AI บนเว็บไซต์', hint: 'ปุ่มแชทลอยในหน้าเว็บสาธารณะ' },
  { id: 'ask', label: 'Ask LITALK (/ask)', hint: 'หน้าถามคำศัพท์ทั้งหน้า' },
  { id: 'portal', label: 'พอร์ทัลนักเรียน', hint: 'เข้าสู่ระบบนักเรียน ตารางเรียน การชำระเงิน' },
  { id: 'chat_portal', label: 'แชท AI ในพอร์ทัล', hint: 'เฉพาะผู้ช่วย AI ไม่กระทบส่วนอื่นของพอร์ทัล' },
  { id: 'checkin', label: 'หน้าเช็คอิน QR', hint: 'หน้าสแกนเข้าเรียน' },
  { id: 'booking', label: 'หน้าจองเรียน', hint: 'หน้าจองเวลาเรียนสาธารณะ' },
];

const EMPTY: ServiceNoticeDraft = {
  enabled: true,
  preset: 'closing_soon',
  surfaces: [],
  titleTh: '',
  titleEn: '',
  bodyTh: '',
  bodyEn: '',
  announceFrom: null,
  startsAt: null,
  endsAt: null,
  dismissible: true,
};

// <input type="datetime-local"> speaks local wall-clock time with no zone;
// the API stores UTC. These two convert at the boundary so an admin in
// Bangkok types 22:00 and gets 22:00 Bangkok, not 22:00 UTC.
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// Mirrors phaseFor() in worker/src/serviceNotices.ts so the list shows what
// visitors are seeing right now, not just what was scheduled.
function phaseOf(n: ServiceNotice, now: number): 'expired' | 'blocking' | 'announcing' | 'scheduled' | 'off' {
  if (!n.enabled) return 'off';
  const at = (v: string | null) => (v ? Date.parse(v) : NaN);
  const ends = at(n.endsAt);
  if (!Number.isNaN(ends) && now >= ends) return 'expired';
  const starts = at(n.startsAt);
  if (!Number.isNaN(starts) && now >= starts) return 'blocking';
  const announce = at(n.announceFrom);
  if (Number.isNaN(announce) || now >= announce) return 'announcing';
  return 'scheduled';
}

const PHASE_LABEL: Record<string, { text: string; cls: string }> = {
  blocking: { text: 'กำลังปิดอยู่', cls: 'is-off' },
  announcing: { text: 'กำลังประกาศ', cls: '' },
  scheduled: { text: 'รอตามเวลา', cls: '' },
  expired: { text: 'หมดเวลาแล้ว', cls: '' },
  off: { text: 'ปิดใช้งาน', cls: '' },
};

export default function ServiceScreen() {
  const { getAccessTokenSilently } = useAuth0();
  const showToast = useToast();
  const confirmDialog = useConfirm();

  const [notices, setNotices] = useState<ServiceNotice[] | null>(null);
  const [bypassToken, setBypassToken] = useState('');
  const [failed, setFailed] = useState(false);
  const [editingId, setEditingId] = useState<number | 'new' | null>(null);
  const [draft, setDraft] = useState<ServiceNoticeDraft>(EMPTY);
  const [saving, setSaving] = useState(false);
  const now = Date.now();

  const load = useCallback(async () => {
    try {
      const result = await fetchServiceNotices(makeTokenGetter(getAccessTokenSilently));
      setNotices(result.notices);
      setBypassToken(result.bypassToken);
      setFailed(false);
    } catch (error) {
      console.error('fetchServiceNotices:', error);
      setFailed(true);
    }
  }, [getAccessTokenSilently]);

  useEffect(() => {
    load();
  }, [load]);

  const openNew = () => {
    setDraft(EMPTY);
    setEditingId('new');
  };

  const openEdit = (n: ServiceNotice) => {
    const { id, updatedAt, updatedBy, ...rest } = n;
    void id;
    void updatedAt;
    void updatedBy;
    setDraft(rest);
    setEditingId(n.id);
  };

  const patch = (changes: Partial<ServiceNoticeDraft>) => setDraft((d) => ({ ...d, ...changes }));

  const toggleSurface = (surface: ServiceSurface) =>
    setDraft((d) => ({
      ...d,
      surfaces: d.surfaces.includes(surface) ? d.surfaces.filter((s) => s !== surface) : [...d.surfaces, surface],
    }));

  const save = async () => {
    if (!draft.surfaces.length) {
      showToast('เลือกส่วนที่ต้องการก่อน', 'ประกาศที่ไม่ได้เลือกส่วนใดเลยจะไม่แสดงที่ไหน', 'error');
      return;
    }
    if (draft.preset === 'custom' && !draft.titleTh.trim() && !draft.titleEn.trim()) {
      showToast('กรอกหัวข้อก่อน', 'ข้อความกำหนดเองไม่มีข้อความสำเร็จรูปให้ใช้แทน', 'error');
      return;
    }
    setSaving(true);
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      if (editingId === 'new') await createServiceNotice(getToken, draft);
      else if (typeof editingId === 'number') await updateServiceNotice(getToken, editingId, draft);
      showToast('บันทึกแล้ว', 'มีผลกับผู้ใช้ในครั้งถัดไปที่โหลดหน้า', 'success');
      setEditingId(null);
      load();
    } catch (error) {
      showToast('บันทึกไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (n: ServiceNotice) => {
    const ok = await confirmDialog(
      'ลบประกาศนี้? ผู้ใช้จะไม่เห็นประกาศนี้อีก และส่วนที่ถูกปิดไว้จะกลับมาใช้งานได้ทันที',
      { danger: true, okLabel: 'ลบประกาศ' },
    );
    if (!ok) return;
    try {
      await deleteServiceNotice(makeTokenGetter(getAccessTokenSilently), n.id);
      showToast('ลบแล้ว', undefined, 'success');
      load();
    } catch (error) {
      showToast('ลบไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const rotate = async () => {
    const ok = await confirmDialog('สร้างลิงก์พรีวิวใหม่? ลิงก์เดิมที่เคยแชร์ไว้จะใช้ไม่ได้ทันที', {
      okLabel: 'สร้างใหม่',
    });
    if (!ok) return;
    try {
      const result = await rotateServiceBypassToken(makeTokenGetter(getAccessTokenSilently));
      setBypassToken(result.bypassToken);
      showToast('สร้างลิงก์ใหม่แล้ว', undefined, 'success');
    } catch (error) {
      showToast('ไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const preset = PRESETS.find((p) => p.id === draft.preset);
  const previewUrl = `https://litalkeducation.com/?bypass=${bypassToken}`;

  return (
    <div id="screen-service" className="tab-content active">
      <div className="screen-header">
        <h1>ควบคุมการเปิด-ปิดระบบ</h1>
        <p>
          ตั้งเวลาแจ้งล่วงหน้าและปิดให้บริการเป็นส่วน ๆ ได้ — ประกาศจะขึ้นเป็น popup ให้ผู้ใช้เห็น
          และเมื่อถึงเวลาปิด ระบบจะปฏิเสธคำขอจริงด้วย ไม่ใช่แค่ขึ้นข้อความ
        </p>
      </div>

      <div className="info-notice" style={{ marginBottom: 20 }}>
        <i className="fas fa-shield-halved"></i>
        <div>
          <strong>แผงแอดมินไม่อยู่ในรายการที่ปิดได้</strong> — เพื่อให้คนที่สั่งปิดยังกลับมาเปิดคืนได้เสมอ
          และหน้าข้อกำหนด/ความเป็นส่วนตัวก็ปิดไม่ได้เช่นกัน เพราะผู้ใช้ต้องอ่านได้ตลอดเวลา
        </div>
      </div>

      {failed && (
        <div className="admin-card">
          <div className="info-notice">
            <i className="fas fa-triangle-exclamation" style={{ color: 'var(--accent-danger)' }}></i>
            <div>
              โหลดรายการไม่สำเร็จ —{' '}
              <button className="btn btn-secondary" style={{ marginLeft: 8 }} onClick={load}>
                ลองใหม่
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---- list ---- */}
      <div className="admin-card">
        <div className="card-title-bar">
          <span className="card-icon">
            <i className="fas fa-tower-broadcast"></i>
          </span>
          <div>
            <h3>ประกาศทั้งหมด</h3>
            <p>เรียงตามเวลาที่ตั้งไว้ ล่าสุดอยู่บนสุด</p>
          </div>
        </div>

        {notices === null && !failed && <div className="skeleton skeleton-line" style={{ width: '60%' }}></div>}

        {notices && !notices.length && (
          <div className="empty-state">
            <i className="fas fa-tower-broadcast"></i>
            <div className="empty-title">ยังไม่มีประกาศ</div>
            <div className="empty-sub">ทุกส่วนเปิดให้บริการตามปกติ</div>
          </div>
        )}

        {notices && notices.length > 0 && (
          <div className="row-list">
            {notices.map((n) => {
              const phase = phaseOf(n, now);
              const label = PHASE_LABEL[phase];
              return (
                <div className="alert-row" style={{ alignItems: 'flex-start' }} key={n.id}>
                  <i
                    className={`fas ${phase === 'blocking' ? 'fa-circle-pause' : 'fa-bullhorn'}`}
                    style={{ marginTop: 3, color: phase === 'blocking' ? 'var(--accent-danger)' : 'var(--text-muted)' }}
                  ></i>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="alert-text">
                      <strong>{n.titleTh || PRESETS.find((p) => p.id === n.preset)?.label || n.preset}</strong>
                    </div>
                    <div className="ai-status-strip" style={{ marginTop: 6 }}>
                      <span className={`ai-status-pill ${label.cls}`}>
                        <i className="fas fa-circle-dot"></i>
                        {label.text}
                      </span>
                      <span className="ai-status-pill">
                        <i className="fas fa-layer-group"></i>
                        {n.surfaces.length
                          ? n.surfaces.map((s) => SURFACES.find((x) => x.id === s)?.label || s).join(', ')
                          : 'ยังไม่ได้เลือกส่วน'}
                      </span>
                    </div>
                    <div className="alert-text" style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 6 }}>
                      แจ้งล่วงหน้า {formatWhen(n.announceFrom)} · ปิด {formatWhen(n.startsAt)} · กลับมา{' '}
                      {formatWhen(n.endsAt)}
                      {!n.endsAt && n.startsAt ? ' (ไม่มีกำหนด)' : ''}
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                      <button className="btn btn-secondary" style={{ padding: '6px 10px' }} onClick={() => openEdit(n)}>
                        <i className="fas fa-pen"></i> แก้ไข
                      </button>
                      <button className="btn btn-danger" style={{ padding: '6px 10px' }} onClick={() => remove(n)}>
                        <i className="fas fa-trash"></i> ลบ
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {editingId === null && (
          <div className="form-body">
            <button className="btn btn-primary" onClick={openNew}>
              <i className="fas fa-plus"></i> สร้างประกาศใหม่
            </button>
          </div>
        )}
      </div>

      {/* ---- editor ---- */}
      {editingId !== null && (
        <div className="admin-card">
          <div className="card-title-bar">
            <span className="card-icon">
              <i className="fas fa-pen-to-square"></i>
            </span>
            <div>
              <h3>{editingId === 'new' ? 'ประกาศใหม่' : 'แก้ไขประกาศ'}</h3>
              <p>เลือกรูปแบบ ส่วนที่กระทบ และเวลา</p>
            </div>
          </div>

          <div className="form-body">
            <div className="form-group">
              <label htmlFor="svc-preset">
                <i className="fas fa-bullhorn"></i> รูปแบบประกาศ
              </label>
              <select
                id="svc-preset"
                value={draft.preset}
                onChange={(e) => patch({ preset: e.target.value as ServicePreset })}
              >
                {PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
              <div className="form-hint">{preset?.blurb}</div>
            </div>

            <div className="form-group">
              <label>
                <i className="fas fa-layer-group"></i> ปิด/ประกาศส่วนใดบ้าง
              </label>
              <div className="form-hint" style={{ marginBottom: 8 }}>
                เลือกได้หลายส่วน — แต่ละส่วนจะเห็น popup เดียวกัน
              </div>
              {SURFACES.map((s) => (
                <label className="ai-toggle-row" key={s.id}>
                  <span className="ai-switch">
                    <input
                      type="checkbox"
                      checked={draft.surfaces.includes(s.id)}
                      onChange={() => toggleSurface(s.id)}
                    />
                    <span className="ai-switch-track"></span>
                  </span>
                  <span className="ai-toggle-text">
                    <span className="ai-toggle-title">{s.label}</span>
                    <span className="ai-toggle-hint">{s.hint}</span>
                  </span>
                </label>
              ))}
            </div>

            <div className="ai-option-grid">
              <div className="form-group">
                <label htmlFor="svc-announce">
                  <i className="fas fa-clock"></i> เริ่มแจ้งล่วงหน้า
                </label>
                <input
                  id="svc-announce"
                  type="datetime-local"
                  value={toLocalInput(draft.announceFrom)}
                  onChange={(e) => patch({ announceFrom: fromLocalInput(e.target.value) })}
                />
                <div className="form-hint">ว่างไว้ = แสดงทันทีที่เปิดใช้งาน</div>
              </div>

              <div className="form-group">
                <label htmlFor="svc-start">
                  <i className="fas fa-circle-pause"></i> เวลาปิดจริง
                </label>
                <input
                  id="svc-start"
                  type="datetime-local"
                  value={toLocalInput(draft.startsAt)}
                  onChange={(e) => patch({ startsAt: fromLocalInput(e.target.value) })}
                />
                <div className="form-hint">ว่างไว้ = ประกาศอย่างเดียว ไม่ปิดระบบ</div>
              </div>

              <div className="form-group">
                <label htmlFor="svc-end">
                  <i className="fas fa-circle-play"></i> เวลากลับมาเปิด
                </label>
                <input
                  id="svc-end"
                  type="datetime-local"
                  value={toLocalInput(draft.endsAt)}
                  onChange={(e) => patch({ endsAt: fromLocalInput(e.target.value) })}
                />
                <div className="form-hint">
                  ว่างไว้ = ปิดไม่มีกำหนด ต้องมาปิดประกาศเอง
                  {draft.startsAt && !draft.endsAt ? ' — แนะนำให้ใส่เวลาไว้เสมอ' : ''}
                </div>
              </div>
            </div>

            {draft.startsAt && !draft.endsAt && (
              <div className="info-notice">
                <i className="fas fa-triangle-exclamation" style={{ color: 'var(--accent-danger)' }}></i>
                <div>
                  ประกาศนี้จะปิดระบบไปเรื่อย ๆ จนกว่าจะมีคนมาแก้ — ถ้าลืม ระบบจะปิดค้างไว้
                  ใส่เวลากลับมาเปิดไว้ก่อนจะปลอดภัยกว่า
                </div>
              </div>
            )}

            <div className="form-group">
              <label htmlFor="svc-title-th">
                <i className="fas fa-heading"></i> หัวข้อ (ไทย)
              </label>
              <input
                id="svc-title-th"
                type="text"
                placeholder={draft.preset === 'custom' ? 'จำเป็นต้องกรอก' : 'ว่างไว้ = ใช้ข้อความสำเร็จรูป'}
                value={draft.titleTh}
                onChange={(e) => patch({ titleTh: e.target.value })}
              />
            </div>

            <div className="form-group">
              <label htmlFor="svc-body-th">
                <i className="fas fa-align-left"></i> รายละเอียด (ไทย)
              </label>
              <textarea
                id="svc-body-th"
                rows={3}
                value={draft.bodyTh}
                onChange={(e) => patch({ bodyTh: e.target.value })}
              />
            </div>

            <div className="ai-option-grid">
              <div className="form-group">
                <label htmlFor="svc-title-en">หัวข้อ (อังกฤษ)</label>
                <input
                  id="svc-title-en"
                  type="text"
                  value={draft.titleEn}
                  onChange={(e) => patch({ titleEn: e.target.value })}
                />
                <div className="form-hint">เว็บไซต์มีสองภาษา — ว่างไว้จะใช้ข้อความสำเร็จรูปภาษาอังกฤษแทน</div>
              </div>
              <div className="form-group">
                <label htmlFor="svc-body-en">รายละเอียด (อังกฤษ)</label>
                <textarea
                  id="svc-body-en"
                  rows={3}
                  value={draft.bodyEn}
                  onChange={(e) => patch({ bodyEn: e.target.value })}
                />
              </div>
            </div>

            <label className="ai-toggle-row">
              <span className="ai-switch">
                <input
                  type="checkbox"
                  checked={draft.dismissible}
                  onChange={(e) => patch({ dismissible: e.target.checked })}
                />
                <span className="ai-switch-track"></span>
              </span>
              <span className="ai-toggle-text">
                <span className="ai-toggle-title">ให้ผู้ใช้ปิด popup ได้ (ช่วงแจ้งล่วงหน้า)</span>
                <span className="ai-toggle-hint">
                  ช่วงที่ปิดระบบจริงจะปิด popup ไม่ได้เสมอ เพราะไม่มีอะไรให้ใช้อยู่ข้างหลัง
                </span>
              </span>
            </label>

            <label className="ai-toggle-row">
              <span className="ai-switch">
                <input type="checkbox" checked={draft.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
                <span className="ai-switch-track"></span>
              </span>
              <span className="ai-toggle-text">
                <span className="ai-toggle-title">เปิดใช้งานประกาศนี้</span>
                <span className="ai-toggle-hint">ปิดไว้เพื่อร่างไว้ก่อนโดยยังไม่มีผลกับผู้ใช้</span>
              </span>
            </label>
          </div>

          <div className="ai-save-bar">
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              <i className="fas fa-floppy-disk"></i> {saving ? 'กำลังบันทึก...' : 'บันทึกประกาศ'}
            </button>
            <button className="btn btn-secondary" onClick={() => setEditingId(null)} disabled={saving}>
              ยกเลิก
            </button>
          </div>
        </div>
      )}

      {/* ---- preview link ---- */}
      <div className="admin-card">
        <div className="card-title-bar">
          <span className="card-icon">
            <i className="fas fa-key"></i>
          </span>
          <div>
            <h3>ลิงก์พรีวิวสำหรับแอดมิน</h3>
            <p>เปิดหน้าที่ถูกปิดอยู่เพื่อตรวจสอบได้ โดยผู้ใช้ทั่วไปยังเห็นประกาศตามปกติ</p>
          </div>
        </div>
        <div className="form-body">
          <div className="info-notice">
            <i className="fas fa-circle-info"></i>
            <div>
              เว็บไซต์หลักไม่มีระบบ login จึงไม่มีตัวตนให้ยกเว้นแบบฝั่ง API — ลิงก์นี้ทำหน้าที่แทน
              เปิดครั้งเดียวแล้วเบราว์เซอร์นั้นจะข้ามประกาศไปตลอด session
            </div>
          </div>
          <div className="form-group">
            <label>
              <i className="fas fa-link"></i> ลิงก์พรีวิว
            </label>
            <input type="text" readOnly value={previewUrl} onFocus={(e) => e.currentTarget.select()} />
            <div className="form-hint">ใช้ต่อท้ายหน้าไหนก็ได้ เช่น /ask?bypass=... — อย่าแชร์ให้คนนอก</div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              className="btn btn-secondary"
              onClick={() => {
                navigator.clipboard.writeText(previewUrl);
                showToast('คัดลอกแล้ว', undefined, 'success');
              }}
            >
              <i className="fas fa-copy"></i> คัดลอกลิงก์
            </button>
            <button className="btn btn-secondary" onClick={rotate}>
              <i className="fas fa-rotate"></i> สร้างลิงก์ใหม่
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
