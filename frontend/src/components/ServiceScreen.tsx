import { useCallback, useEffect, useMemo, useState } from 'react';
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
  restoreService,
  type ServiceNotice,
  type ServiceNoticeDraft,
  type ServicePreset,
  type ServiceSurface,
} from '../api/client';
import './ServiceScreen.css';

const MAINTENANCE = 'maintenance' as ServicePreset;

const PRESETS: Array<{ id: ServicePreset; label: string; blurb: string; blocks: boolean }> = [
  { id: 'custom', label: 'Status update', blurb: 'แจ้งเหตุการณ์หรือความคืบหน้า โดยไม่จำเป็นต้องปิดบริการ', blocks: false },
  { id: MAINTENANCE, label: 'ปิดปรับปรุงระบบ', blurb: 'ประกาศ maintenance และกำหนดช่วงเวลาที่บริการจะใช้งานไม่ได้', blocks: true },
  { id: 'opening_soon', label: 'กำลังจะเปิดเร็ว ๆ นี้', blurb: 'แจ้งว่าส่วนนี้กำลังเตรียมเปิดให้บริการ', blocks: true },
  { id: 'trial_opening_soon', label: 'กำลังจะเปิดให้ทดลอง', blurb: 'แจ้งล่วงหน้าก่อนเปิดทดลองใช้', blocks: true },
  { id: 'closing_soon', label: 'กำลังจะปิดเร็ว ๆ นี้', blurb: 'แจ้งล่วงหน้าก่อนปิด แล้วบล็อกเมื่อถึงเวลา', blocks: true },
  { id: 'trial_closing_soon', label: 'กำลังปิดช่วงทดลอง', blurb: 'แจ้งว่าช่วงทดลองใช้งานกำลังจะสิ้นสุด', blocks: true },
];

const SURFACES: Array<{ id: ServiceSurface; label: string; hint: string; icon: string }> = [
  { id: 'website', label: 'Website', hint: 'เว็บไซต์หลักและ Blog', icon: 'fa-globe' },
  { id: 'ask', label: 'Ask LITALK', hint: 'AI workspace ที่ /ask', icon: 'fa-sparkles' },
  { id: 'chat_site', label: 'Website AI Chat', hint: 'แชท AI บนเว็บไซต์', icon: 'fa-comments' },
  { id: 'portal', label: 'Student Portal', hint: 'บัญชี ตารางเรียน และข้อมูลนักเรียน', icon: 'fa-user-graduate' },
  { id: 'chat_portal', label: 'Portal AI Chat', hint: 'ผู้ช่วย AI ใน Portal', icon: 'fa-message' },
  { id: 'checkin', label: 'Check-in', hint: 'เช็คอินและ QR', icon: 'fa-qrcode' },
  { id: 'booking', label: 'Booking', hint: 'ระบบจองเวลาเรียน', icon: 'fa-calendar-check' },
  { id: 'learning', label: 'Online Learning', hint: 'คอร์ส บทเรียน และแบบทดสอบ', icon: 'fa-graduation-cap' },
  { id: 'admin', label: 'Admin Panel', hint: 'Admin ยังเข้าได้เสมอ', icon: 'fa-shield-halved' },
];

const ALL_SURFACES = SURFACES.map((s) => s.id);
const EMPTY: ServiceNoticeDraft = {
  enabled: true,
  preset: 'custom',
  surfaces: ['website'],
  titleTh: '', titleEn: '', bodyTh: '', bodyEn: '',
  announceFrom: null, startsAt: null, endsAt: null,
  dismissible: true,
};

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
  if (!iso) return 'ไม่กำหนด';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'ไม่กำหนด' : d.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
}
function phaseOf(n: ServiceNotice, now = Date.now()): 'off' | 'scheduled' | 'announcing' | 'blocking' | 'expired' {
  if (!n.enabled) return 'off';
  const end = n.endsAt ? Date.parse(n.endsAt) : NaN;
  if (!Number.isNaN(end) && now >= end) return 'expired';
  const start = n.startsAt ? Date.parse(n.startsAt) : NaN;
  if (!Number.isNaN(start) && now >= start) return 'blocking';
  const announce = n.announceFrom ? Date.parse(n.announceFrom) : NaN;
  if (Number.isNaN(announce) || now >= announce) return 'announcing';
  return 'scheduled';
}
const PHASE_LABEL: Record<string, string> = {
  blocking: 'ไม่พร้อมใช้งาน', announcing: 'กำลังประกาศ', scheduled: 'ตั้งเวลาแล้ว', expired: 'สิ้นสุดแล้ว', off: 'ปิดอยู่',
};

export default function ServiceScreen() {
  const { getAccessTokenSilently } = useAuth0();
  const toast = useToast();
  const confirm = useConfirm();
  const [notices, setNotices] = useState<ServiceNotice[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [bypassToken, setBypassToken] = useState('');
  const [draft, setDraft] = useState<ServiceNoticeDraft>(EMPTY);
  const [editingId, setEditingId] = useState<number | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [shutdownUntil, setShutdownUntil] = useState('');

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

  useEffect(() => { void load(); }, [load]);

  const blockingSurfaces = useMemo(() => new Set(
    (notices ?? []).filter((n) => phaseOf(n) === 'blocking').flatMap((n) => n.surfaces),
  ), [notices]);
  const activeNotices = useMemo(() => (notices ?? []).filter((n) => ['blocking', 'announcing', 'scheduled'].includes(phaseOf(n))), [notices]);
  const everythingDown = ALL_SURFACES.every((s) => blockingSurfaces.has(s));
  const somethingDown = blockingSurfaces.size > 0;
  const operationalCount = ALL_SURFACES.length - blockingSurfaces.size;

  const patch = (value: Partial<ServiceNoticeDraft>) => setDraft((d) => ({ ...d, ...value }));
  const toggleSurface = (surface: ServiceSurface) => setDraft((d) => ({
    ...d,
    surfaces: d.surfaces.includes(surface) ? d.surfaces.filter((s) => s !== surface) : [...d.surfaces, surface],
  }));

  const openStatusUpdate = () => {
    setDraft({ ...EMPTY });
    setEditingId('new');
  };
  const openMaintenance = () => {
    // Do not pre-start blocking. The admin must explicitly choose a start time.
    setDraft({ ...EMPTY, preset: MAINTENANCE, surfaces: ['website'], dismissible: false });
    setEditingId('new');
  };
  const openEdit = (n: ServiceNotice) => {
    const { id, updatedAt, updatedBy, ...rest } = n;
    void updatedAt; void updatedBy;
    setDraft(rest);
    setEditingId(id);
  };

  const save = async () => {
    if (!draft.surfaces.length) return toast('เลือกบริการก่อน', 'ต้องเลือกอย่างน้อย 1 บริการที่ได้รับผลกระทบ', 'error');
    if (!draft.titleTh.trim() && !draft.titleEn.trim()) return toast('กรอกหัวข้อก่อน', 'ควรมีหัวข้ออย่างน้อยหนึ่งภาษา', 'error');
    if (draft.endsAt && draft.startsAt && Date.parse(draft.endsAt) <= Date.parse(draft.startsAt)) {
      return toast('เวลาสิ้นสุดไม่ถูกต้อง', 'เวลาเปิดคืนต้องอยู่หลังเวลาเริ่มปิดบริการ', 'error');
    }
    if (draft.startsAt && draft.announceFrom && Date.parse(draft.announceFrom) > Date.parse(draft.startsAt)) {
      return toast('เวลาแจ้งล่วงหน้าไม่ถูกต้อง', 'เวลาเริ่มประกาศต้องไม่อยู่หลังเวลาเริ่มปิดบริการ', 'error');
    }
    setSaving(true);
    try {
      const token = makeTokenGetter(getAccessTokenSilently);
      if (editingId === 'new') await createServiceNotice(token, draft);
      else if (typeof editingId === 'number') await updateServiceNotice(token, editingId, draft);
      setEditingId(null);
      toast('บันทึกเรียบร้อย', 'Status และบริการที่เลือกจะอัปเดตในการโหลดครั้งถัดไป', 'success');
      await load();
    } catch (error) {
      toast('บันทึกไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    } finally { setSaving(false); }
  };

  const remove = async (n: ServiceNotice) => {
    if (!await confirm('ลบรายการนี้? หากรายการกำลังบล็อกบริการ บริการนั้นจะเปิดกลับทันที', { danger: true, okLabel: 'ลบรายการ' })) return;
    try {
      await deleteServiceNotice(makeTokenGetter(getAccessTokenSilently), n.id);
      toast('ลบแล้ว', undefined, 'success');
      await load();
    } catch (error) {
      toast('ลบไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const shutDownEverything = async () => {
    const until = fromLocalInput(shutdownUntil);
    if (until && Date.parse(until) <= Date.now()) return toast('เวลาเปิดคืนไม่ถูกต้อง', 'กรุณาเลือกเวลาในอนาคต', 'error');
    const message = until ? `ปิดปรับปรุงทุกบริการจนถึง ${formatWhen(until)}?` : 'ปิดปรับปรุงทุกบริการแบบไม่มีกำหนด?';
    if (!await confirm(message, { danger: true, okLabel: 'ปิดปรับปรุงระบบ' })) return;
    setSwitching(true);
    try {
      await createServiceNotice(makeTokenGetter(getAccessTokenSilently), {
        enabled: true, preset: MAINTENANCE, surfaces: ALL_SURFACES,
        titleTh: 'ปิดปรับปรุงระบบ', titleEn: 'System maintenance',
        bodyTh: 'LITALK ปิดให้บริการชั่วคราวเพื่อปรับปรุงระบบ กรุณากลับมาใหม่ภายหลัง',
        bodyEn: 'LITALK is temporarily unavailable while we perform system maintenance. Please check back later.',
        announceFrom: null, startsAt: new Date(Date.now() - 1000).toISOString(), endsAt: until, dismissible: false,
      });
      setShutdownUntil('');
      toast('ปิดปรับปรุงระบบแล้ว', 'Admin ยังเข้าแผงควบคุมเพื่อเปิดระบบคืนได้', 'success');
      await load();
    } catch (error) {
      toast('ปิดระบบไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    } finally { setSwitching(false); }
  };

  const restoreEverything = async () => {
    if (!await confirm('เปิดบริการทั้งหมดกลับมาใช้งานตอนนี้?', { okLabel: 'เปิดระบบคืน' })) return;
    setSwitching(true);
    try {
      const result = await restoreService(makeTokenGetter(getAccessTokenSilently));
      toast('เปิดระบบคืนแล้ว', `ยุติรายการที่กำลังบล็อก ${result.restored} รายการ`, 'success');
      await load();
    } catch (error) {
      toast('เปิดระบบคืนไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    } finally { setSwitching(false); }
  };

  const rotate = async () => {
    if (!await confirm('สร้าง bypass token ใหม่? ลิงก์พรีวิวเดิมจะใช้ไม่ได้ทันที', { okLabel: 'สร้าง token ใหม่' })) return;
    try {
      const result = await rotateServiceBypassToken(makeTokenGetter(getAccessTokenSilently));
      setBypassToken(result.bypassToken);
      toast('สร้าง token ใหม่แล้ว', undefined, 'success');
    } catch (error) {
      toast('สร้าง token ไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const copyPreview = async () => {
    if (!bypassToken) return;
    try {
      await navigator.clipboard.writeText(`https://litalkeducation.com/?bypass=${bypassToken}`);
      toast('คัดลอกลิงก์แล้ว', undefined, 'success');
    } catch {
      toast('คัดลอกไม่สำเร็จ', 'เบราว์เซอร์ไม่อนุญาตให้เข้าถึง Clipboard', 'error');
    }
  };

  return <div id="screen-service" className="tab-content active service-screen">
    <div className="service-hero">
      <div>
        <div className="service-kicker"><i className="fas fa-signal"></i> LITALK Operations</div>
        <h1>Service & Status</h1>
        <p>จัดการสถานะบริการ ประกาศเหตุการณ์ และ maintenance จากหน้าจอเดียว</p>
      </div>
      <div className="service-hero-actions">
        <a className="btn btn-secondary" href="https://litalkeducation.com/status" target="_blank" rel="noreferrer"><i className="fas fa-arrow-up-right-from-square"></i> เปิดหน้า Status</a>
        <button className="btn btn-primary" onClick={openStatusUpdate}><i className="fas fa-plus"></i> New update</button>
      </div>
    </div>

    {failed && <div className="service-banner is-danger"><i className="fas fa-triangle-exclamation"></i><div><strong>โหลดสถานะไม่สำเร็จ</strong><span>ข้อมูลบนหน้านี้อาจไม่เป็นปัจจุบัน</span></div><button className="btn btn-secondary" onClick={() => void load()}>ลองใหม่</button></div>}

    <section className="service-metrics" aria-label="Service overview">
      <div className={`service-metric ${somethingDown ? 'is-danger' : 'is-good'}`}><span className="service-metric-icon"><i className={`fas ${somethingDown ? 'fa-triangle-exclamation' : 'fa-circle-check'}`}></i></span><div><small>Overall status</small><strong>{everythingDown ? 'System maintenance' : somethingDown ? 'Partial outage' : 'Operational'}</strong></div></div>
      <div className="service-metric"><span className="service-metric-icon"><i className="fas fa-server"></i></span><div><small>Services online</small><strong>{operationalCount} / {ALL_SURFACES.length}</strong></div></div>
      <div className="service-metric"><span className="service-metric-icon"><i className="fas fa-bullhorn"></i></span><div><small>Active / scheduled</small><strong>{activeNotices.length}</strong></div></div>
      <div className="service-metric"><span className="service-metric-icon"><i className="fas fa-circle-pause"></i></span><div><small>Unavailable</small><strong>{blockingSurfaces.size}</strong></div></div>
    </section>

    <div className="service-grid-main">
      <section className="service-panel service-panel-services">
        <div className="service-panel-head"><div><h2>Services</h2><p>สถานะล่าสุดของแต่ละส่วน</p></div><button className="service-icon-button" onClick={() => void load()} aria-label="Refresh"><i className="fas fa-rotate"></i></button></div>
        <div className="service-list">
          {SURFACES.map((s) => {
            const down = blockingSurfaces.has(s.id);
            return <div className="service-row" key={s.id}><span className="service-row-icon"><i className={`fas ${s.icon}`}></i></span><div className="service-row-copy"><strong>{s.label}</strong><small>{s.hint}</small></div><span className={`service-state ${down ? 'is-down' : 'is-up'}`}><i className="fas fa-circle"></i>{down ? 'Unavailable' : 'Operational'}</span></div>;
          })}
        </div>
      </section>

      <aside className="service-side-stack">
        <section className="service-panel service-quick-panel">
          <div className="service-panel-head"><div><h2>Publish</h2><p>สื่อสารกับผู้ใช้</p></div></div>
          <button className="service-action-card" onClick={openStatusUpdate}><span><i className="fas fa-bullhorn"></i></span><div><strong>Status update</strong><small>แจ้งปัญหา ความคืบหน้า หรือการแก้ไข</small></div><i className="fas fa-chevron-right"></i></button>
          <button className="service-action-card" onClick={openMaintenance}><span><i className="fas fa-screwdriver-wrench"></i></span><div><strong>Schedule maintenance</strong><small>เลือกบริการและกำหนดเวลาเอง</small></div><i className="fas fa-chevron-right"></i></button>
        </section>

        <section className={`service-panel service-emergency ${somethingDown ? 'is-active' : ''}`}>
          <div className="service-panel-head"><div><h2>Emergency control</h2><p>ใช้เฉพาะเมื่อจำเป็นต้องหยุดบริการ</p></div></div>
          {somethingDown && <div className="service-current-outage"><i className="fas fa-circle-pause"></i><div><strong>{everythingDown ? 'ปิดทั้งระบบอยู่' : 'มีบางบริการถูกปิด'}</strong><small>{everythingDown ? 'ผู้ใช้ไม่สามารถเข้าบริการที่กำหนดได้' : `${blockingSurfaces.size} บริการไม่พร้อมใช้งาน`}</small></div></div>}
          {!everythingDown && <label className="service-field"><span>เปิดคืนอัตโนมัติ</span><input type="datetime-local" value={shutdownUntil} onChange={(e) => setShutdownUntil(e.target.value)} /><small>เว้นว่างเพื่อปิดแบบไม่มีกำหนด</small></label>}
          <div className="service-emergency-actions">
            {!everythingDown && <button className="btn btn-danger" disabled={switching || notices === null} onClick={shutDownEverything}><i className="fas fa-power-off"></i>{switching ? 'กำลังดำเนินการ…' : somethingDown ? 'ปิดส่วนที่เหลือ' : 'ปิดปรับปรุงทั้งระบบ'}</button>}
            {somethingDown && <button className="btn btn-primary" disabled={switching} onClick={restoreEverything}><i className="fas fa-circle-play"></i>เปิดระบบคืนทั้งหมด</button>}
          </div>
        </section>
      </aside>
    </div>

    {editingId && <section className="service-panel service-editor">
      <div className="service-panel-head"><div><div className="service-kicker">{editingId === 'new' ? 'New publication' : 'Editing publication'}</div><h2>{draft.preset === MAINTENANCE ? 'Maintenance' : 'Status update'}</h2><p>ข้อมูลนี้จะแสดงตามภาษาของผู้ใช้และบริการที่เลือก</p></div><button className="service-icon-button" onClick={() => setEditingId(null)} aria-label="Close editor"><i className="fas fa-xmark"></i></button></div>

      <div className="service-editor-grid">
        <label className="service-field"><span>ประเภท</span><select value={draft.preset} onChange={(e) => patch({ preset: e.target.value as ServicePreset })}>{PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select><small>{PRESETS.find((p) => p.id === draft.preset)?.blurb}</small></label>
        <label className="service-field service-toggle-field"><span>เปิดใช้งานรายการนี้</span><input type="checkbox" checked={draft.enabled} onChange={(e) => patch({ enabled: e.target.checked })} /></label>
      </div>

      <div className="service-field"><span>บริการที่ได้รับผลกระทบ</span><div className="service-surface-grid">{SURFACES.map((s) => <label key={s.id} className={`service-surface-option ${draft.surfaces.includes(s.id) ? 'is-selected' : ''}`}><input type="checkbox" checked={draft.surfaces.includes(s.id)} onChange={() => toggleSurface(s.id)} /><span className="service-row-icon"><i className={`fas ${s.icon}`}></i></span><span><strong>{s.label}</strong><small>{s.hint}</small></span></label>)}</div><div className="service-selection-actions"><button type="button" className="service-text-button" onClick={() => patch({ surfaces: ALL_SURFACES })}>เลือกทั้งหมด</button><button type="button" className="service-text-button" onClick={() => patch({ surfaces: [] })}>ล้างทั้งหมด</button></div></div>

      <div className="service-two-col">
        <label className="service-field"><span>หัวข้อภาษาไทย</span><input value={draft.titleTh} onChange={(e) => patch({ titleTh: e.target.value })} placeholder="เช่น พบปัญหาการเข้าใช้งาน Ask LITALK" /></label>
        <label className="service-field"><span>Title in English</span><input value={draft.titleEn} onChange={(e) => patch({ titleEn: e.target.value })} placeholder="e.g. Ask LITALK login issue" /></label>
        <label className="service-field"><span>รายละเอียดภาษาไทย</span><textarea rows={5} value={draft.bodyTh} onChange={(e) => patch({ bodyTh: e.target.value })} placeholder="เกิดอะไรขึ้น กระทบอย่างไร และทีมกำลังทำอะไร" /></label>
        <label className="service-field"><span>English details</span><textarea rows={5} value={draft.bodyEn} onChange={(e) => patch({ bodyEn: e.target.value })} placeholder="What happened, impact, and what the team is doing" /></label>
      </div>

      <div className="service-time-grid">
        <label className="service-field"><span>เริ่มแสดงประกาศ</span><input type="datetime-local" value={toLocalInput(draft.announceFrom)} onChange={(e) => patch({ announceFrom: fromLocalInput(e.target.value) })} /><small>เว้นว่าง = แสดงทันที</small></label>
        <label className="service-field"><span>เริ่มปิดบริการ</span><input type="datetime-local" value={toLocalInput(draft.startsAt)} onChange={(e) => patch({ startsAt: fromLocalInput(e.target.value) })} /><small>เว้นว่าง = ไม่บล็อกบริการ</small></label>
        <label className="service-field"><span>สิ้นสุด / เปิดคืน</span><input type="datetime-local" value={toLocalInput(draft.endsAt)} onChange={(e) => patch({ endsAt: fromLocalInput(e.target.value) })} /><small>เว้นว่าง = ไม่มีกำหนด</small></label>
      </div>

      <label className="service-check"><input type="checkbox" checked={draft.dismissible} onChange={(e) => patch({ dismissible: e.target.checked })} /><span><strong>ผู้ใช้ปิดประกาศได้</strong><small>เมื่อเข้าสู่ช่วง blocking ผู้ใช้จะปิดหน้าปิดบริการไม่ได้อยู่แล้ว</small></span></label>

      <div className="service-editor-footer"><button className="btn btn-secondary" onClick={() => setEditingId(null)}>ยกเลิก</button><button className="btn btn-primary" disabled={saving} onClick={save}><i className="fas fa-paper-plane"></i>{saving ? 'กำลังบันทึก…' : editingId === 'new' ? 'เผยแพร่' : 'บันทึกการแก้ไข'}</button></div>
    </section>}

    <section className="service-panel service-activity">
      <div className="service-panel-head"><div><h2>Updates & history</h2><p>รายการล่าสุดและสถานะการเผยแพร่</p></div><span className="service-count">{notices?.length ?? 0}</span></div>
      {notices === null && !failed && <div className="service-empty"><i className="fas fa-spinner fa-spin"></i><span>กำลังโหลด…</span></div>}
      {notices && notices.length === 0 && <div className="service-empty"><i className="fas fa-circle-check"></i><strong>ไม่มีประกาศ</strong><span>ทุกบริการเปิดใช้งานตามปกติ</span></div>}
      <div className="service-activity-list">{notices?.map((n) => {
        const phase = phaseOf(n);
        const title = n.titleTh || n.titleEn || PRESETS.find((p) => p.id === n.preset)?.label || n.preset;
        return <article className="service-activity-row" key={n.id}><span className={`service-activity-dot is-${phase}`}></span><div className="service-activity-copy"><div className="service-activity-title"><strong>{title}</strong><span className={`service-phase is-${phase}`}>{PHASE_LABEL[phase]}</span></div><p>{n.bodyTh || n.bodyEn || 'ไม่มีรายละเอียดเพิ่มเติม'}</p><small>{n.surfaces.map((id) => SURFACES.find((s) => s.id === id)?.label || id).join(' · ')}{n.endsAt ? ` • สิ้นสุด ${formatWhen(n.endsAt)}` : ''}</small></div><div className="service-row-actions"><button className="service-icon-button" onClick={() => openEdit(n)} title="แก้ไข"><i className="fas fa-pen"></i></button><button className="service-icon-button is-danger" onClick={() => void remove(n)} title="ลบ"><i className="fas fa-trash"></i></button></div></article>;
      })}</div>
    </section>

    <section className="service-panel service-preview-panel">
      <div className="service-panel-head"><div><h2>Maintenance preview</h2><p>ลิงก์สำหรับ Admin ใช้ตรวจหน้าที่ถูกปิด โดยไม่เปิดให้ผู้ใช้ทั่วไปเข้า</p></div></div>
      <div className="service-preview-row"><div className="service-preview-url"><i className="fas fa-link"></i><span>{bypassToken ? `https://litalkeducation.com/?bypass=${bypassToken}` : 'กำลังโหลด token…'}</span></div><button className="btn btn-secondary" onClick={copyPreview} disabled={!bypassToken}><i className="fas fa-copy"></i>คัดลอก</button><button className="btn btn-secondary" onClick={() => void rotate()}><i className="fas fa-rotate"></i>เปลี่ยน token</button></div>
    </section>
  </div>;
}
