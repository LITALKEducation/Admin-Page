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

const MAINTENANCE = 'maintenance' as ServicePreset;

const PRESETS: Array<{ id: ServicePreset; label: string; blurb: string; blocks: boolean }> = [
  { id: MAINTENANCE, label: 'ปิดปรับปรุงระบบ', blurb: 'ประกาศและปิดบริการเพื่อการบำรุงรักษาหรืออัปเดตระบบ', blocks: true },
  { id: 'opening_soon', label: 'กำลังจะเปิดเร็ว ๆ นี้', blurb: 'ประกาศว่าส่วนนี้ยังไม่เปิดให้บริการ', blocks: true },
  { id: 'trial_opening_soon', label: 'กำลังจะเปิดให้ทดลองเร็ว ๆ นี้', blurb: 'แจ้งล่วงหน้าก่อนเปิดให้ทดลองใช้', blocks: true },
  { id: 'closing_soon', label: 'กำลังจะปิดเร็ว ๆ นี้', blurb: 'แจ้งล่วงหน้าก่อนปิด แล้วบล็อกตามเวลาที่ตั้ง', blocks: true },
  { id: 'trial_closing_soon', label: 'กำลังปิดทดลองใช้งานเร็ว ๆ นี้', blurb: 'แจ้งว่าช่วงทดลองใช้งานกำลังจะสิ้นสุด', blocks: true },
  { id: 'custom', label: 'ประกาศสถานะ / ข้อความกำหนดเอง', blurb: 'ใช้บอกว่าเกิดอะไรขึ้น โดยไม่จำเป็นต้องปิดระบบ', blocks: false },
];

const SURFACES: Array<{ id: ServiceSurface; label: string; hint: string }> = [
  { id: 'website', label: 'เว็บไซต์หลัก', hint: 'หน้าแรก หลักสูตร About และ Blog' },
  { id: 'ask', label: 'Ask LITALK', hint: 'AI workspace ที่ /ask' },
  { id: 'chat_site', label: 'AI Chat บนเว็บไซต์', hint: 'แชท AI บนหน้าเว็บสาธารณะ' },
  { id: 'portal', label: 'Student Portal', hint: 'บัญชีนักเรียน ตารางเรียน และการชำระเงิน' },
  { id: 'chat_portal', label: 'AI Chat ใน Portal', hint: 'ผู้ช่วย AI ภายในพอร์ทัล' },
  { id: 'checkin', label: 'Check-in', hint: 'ระบบเช็คอินและสแกน QR' },
  { id: 'booking', label: 'Booking', hint: 'ระบบจองเวลาเรียน' },
  { id: 'learning', label: 'Online Learning', hint: 'คอร์ส บทเรียน และแบบทดสอบ' },
  { id: 'admin', label: 'Admin Panel', hint: 'ผู้ใช้ Admin ยังเข้าได้เสมอ' },
];

const ALL_SURFACES = SURFACES.map((s) => s.id);
const EMPTY: ServiceNoticeDraft = {
  enabled: true,
  preset: 'custom',
  surfaces: ['website'],
  titleTh: '',
  titleEn: '',
  bodyTh: '',
  bodyEn: '',
  announceFrom: null,
  startsAt: null,
  endsAt: null,
  dismissible: true,
};

function toLocalInput(iso: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInput(value: string) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function formatWhen(iso: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
}
function phaseOf(n: ServiceNotice, now: number): 'off' | 'scheduled' | 'announcing' | 'blocking' | 'expired' {
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
  blocking: 'ปิดให้บริการอยู่', announcing: 'กำลังแสดงประกาศ', scheduled: 'ตั้งเวลาแล้ว', expired: 'สิ้นสุดแล้ว', off: 'ปิดประกาศ',
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
  const now = Date.now();

  const load = useCallback(async () => {
    try {
      const result = await fetchServiceNotices(makeTokenGetter(getAccessTokenSilently));
      setNotices(result.notices);
      setBypassToken(result.bypassToken);
      setFailed(false);
    } catch (error) {
      console.error(error);
      setFailed(true);
    }
  }, [getAccessTokenSilently]);
  useEffect(() => { load(); }, [load]);

  const blockingSurfaces = useMemo(() => new Set(
    (notices ?? []).filter((n) => phaseOf(n, now) === 'blocking').flatMap((n) => n.surfaces),
  ), [notices, now]);
  const everythingDown = ALL_SURFACES.every((s) => blockingSurfaces.has(s));
  const somethingDown = blockingSurfaces.size > 0;

  const patch = (p: Partial<ServiceNoticeDraft>) => setDraft((d) => ({ ...d, ...p }));
  const toggleSurface = (surface: ServiceSurface) => setDraft((d) => ({
    ...d,
    surfaces: d.surfaces.includes(surface) ? d.surfaces.filter((s) => s !== surface) : [...d.surfaces, surface],
  }));

  const openStatusUpdate = () => {
    setDraft({ ...EMPTY, preset: 'custom', surfaces: ['website'], dismissible: true });
    setEditingId('new');
  };
  const openMaintenance = () => {
    setDraft({ ...EMPTY, preset: MAINTENANCE, surfaces: ALL_SURFACES, startsAt: new Date(Date.now() - 1000).toISOString(), dismissible: false });
    setEditingId('new');
  };
  const openEdit = (n: ServiceNotice) => {
    const { id, updatedAt, updatedBy, ...rest } = n;
    void updatedAt; void updatedBy;
    setDraft(rest);
    setEditingId(id);
  };

  const save = async () => {
    if (!draft.surfaces.length) return toast('เลือกบริการก่อน', 'ต้องมีอย่างน้อย 1 บริการ', 'error');
    if (!draft.titleTh.trim() && !draft.titleEn.trim() && draft.preset === 'custom') {
      return toast('กรอกหัวข้อก่อน', 'Status update ต้องบอกผู้ใช้ว่าเกิดอะไรขึ้น', 'error');
    }
    setSaving(true);
    try {
      const token = makeTokenGetter(getAccessTokenSilently);
      if (editingId === 'new') await createServiceNotice(token, draft);
      else if (typeof editingId === 'number') await updateServiceNotice(token, editingId, draft);
      setEditingId(null);
      toast('เผยแพร่แล้ว', 'หน้า Status และบริการที่เลือกจะอัปเดตในการโหลดครั้งถัดไป', 'success');
      await load();
    } catch (error) {
      toast('บันทึกไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    } finally { setSaving(false); }
  };

  const remove = async (n: ServiceNotice) => {
    if (!await confirm('ลบรายการนี้? รายการจะหายจากหน้า Status และถ้ากำลังบล็อกบริการ บริการนั้นจะเปิดทันที', { danger: true, okLabel: 'ลบ' })) return;
    await deleteServiceNotice(makeTokenGetter(getAccessTokenSilently), n.id);
    toast('ลบแล้ว', undefined, 'success');
    load();
  };

  const shutDownEverything = async () => {
    const until = fromLocalInput(shutdownUntil);
    if (!await confirm(until ? `ปิดปรับปรุงทั้งระบบจนถึง ${formatWhen(until)}?` : 'ปิดปรับปรุงทั้งระบบแบบไม่มีกำหนด?', { danger: true, okLabel: 'ปิดปรับปรุงระบบ' })) return;
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
      toast('ปิดปรับปรุงระบบแล้ว', 'บัญชี Admin ยังเข้าแผงควบคุมได้', 'success');
      load();
    } finally { setSwitching(false); }
  };
  const restoreEverything = async () => {
    if (!await confirm('เปิดบริการทั้งหมดกลับมาใช้งานตอนนี้?', { okLabel: 'เปิดระบบคืน' })) return;
    setSwitching(true);
    try {
      const result = await restoreService(makeTokenGetter(getAccessTokenSilently));
      toast('เปิดระบบคืนแล้ว', `ยุติรายการที่กำลังบล็อก ${result.restored} รายการ`, 'success');
      load();
    } finally { setSwitching(false); }
  };
  const rotate = async () => {
    if (!await confirm('สร้าง bypass token ใหม่? ลิงก์พรีวิวเดิมจะใช้ไม่ได้ทันที', { okLabel: 'สร้างใหม่' })) return;
    const result = await rotateServiceBypassToken(makeTokenGetter(getAccessTokenSilently));
    setBypassToken(result.bypassToken);
    toast('สร้าง token ใหม่แล้ว', undefined, 'success');
  };

  const previewUrl = `https://litalkeducation.com/?bypass=${bypassToken}`;

  return <div id="screen-service" className="tab-content active">
    <div className="screen-header">
      <h1>Service & Status</h1>
      <p>ควบคุมการเปิด–ปิดบริการ และเผยแพร่สถานะว่าเกิดอะไรขึ้นให้ผู้ใช้เห็นบนหน้า LITALK Status</p>
    </div>

    <div className="info-notice"><i className="fas fa-circle-info"></i><div><strong>หลักการทำงาน:</strong> Status update ใช้สำหรับสื่อสารเหตุการณ์โดยไม่จำเป็นต้องปิดระบบ ส่วน Maintenance สามารถบล็อกบริการจริงเมื่อถึงเวลาที่กำหนด หน้า <strong>/status</strong> จะแสดงข้อมูลจากแหล่งเดียวกัน</div></div>

    <div className="admin-card">
      <div className="card-title-bar"><span className="card-icon"><i className="fas fa-gauge-high"></i></span><div><h3>ภาพรวมระบบ</h3><p>สถานะปัจจุบันจากประกาศที่กำลังมีผล</p></div></div>
      <div className="form-body">
        <div className="row-list">
          {SURFACES.map((s) => <div className="alert-row" key={s.id}><i className={`fas ${blockingSurfaces.has(s.id) ? 'fa-circle-xmark' : 'fa-circle-check'}`} style={{color:blockingSurfaces.has(s.id)?'var(--accent-danger)':'var(--accent-success)'}}></i><div style={{flex:1}}><div className="alert-text"><strong>{s.label}</strong></div><div className="form-hint">{s.hint}</div></div><span className={`ai-status-pill ${blockingSurfaces.has(s.id)?'is-off':''}`}>{blockingSurfaces.has(s.id)?'ไม่พร้อมใช้งาน':'ปกติ'}</span></div>)}
        </div>
      </div>
    </div>

    <div className="admin-card">
      <div className="card-title-bar"><span className="card-icon"><i className="fas fa-bullhorn"></i></span><div><h3>เผยแพร่ Status update</h3><p>บอกผู้ใช้ว่าเกิดอะไรขึ้น กำลังตรวจสอบอะไร หรือแก้ไขแล้วอย่างไร</p></div></div>
      <div className="form-body" style={{display:'flex',gap:8,flexWrap:'wrap'}}>
        <button className="btn btn-primary" onClick={openStatusUpdate}><i className="fas fa-plus"></i> เพิ่ม Status update</button>
        <button className="btn btn-secondary" onClick={openMaintenance}><i className="fas fa-screwdriver-wrench"></i> สร้าง Maintenance แบบกำหนดเอง</button>
        <a className="btn btn-secondary" href="https://litalkeducation.com/status" target="_blank" rel="noreferrer"><i className="fas fa-arrow-up-right-from-square"></i> เปิดหน้า Status</a>
      </div>
    </div>

    <div className="admin-card">
      <div className="card-title-bar"><span className="card-icon"><i className="fas fa-power-off"></i></span><div><h3>ปิดปรับปรุงทั้งระบบ</h3><p>ใช้เมื่อจำเป็นต้องหยุดทุกบริการพร้อมกัน</p></div></div>
      <div className="form-body">
        {somethingDown && <div className="info-notice"><i className="fas fa-circle-pause"></i><div><strong>{everythingDown?'ขณะนี้ปิดทั้งระบบอยู่':'ขณะนี้มีบางบริการถูกปิด'}</strong>{!everythingDown && ` — ${ALL_SURFACES.filter(s=>blockingSurfaces.has(s)).map(s=>SURFACES.find(x=>x.id===s)?.label).join(', ')}`}</div></div>}
        {!everythingDown && <div className="form-group"><label htmlFor="svc-until">กำหนดเวลาเปิดคืนอัตโนมัติ (ไม่บังคับ)</label><input id="svc-until" type="datetime-local" value={shutdownUntil} onChange={e=>setShutdownUntil(e.target.value)}/><div className="form-hint">หากกำหนดเวลา ระบบจะหยุดบล็อกโดยอัตโนมัติเมื่อถึงเวลานั้น</div></div>}
        <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>{!everythingDown && <button className="btn btn-danger" disabled={switching} onClick={shutDownEverything}><i className="fas fa-power-off"></i> {somethingDown?'ปิดส่วนที่เหลือ':'ปิดปรับปรุงระบบ'}</button>}{somethingDown && <button className="btn btn-primary" disabled={switching} onClick={restoreEverything}><i className="fas fa-circle-play"></i> เปิดระบบคืนทั้งหมด</button>}</div>
      </div>
    </div>

    {editingId && <div className="admin-card">
      <div className="card-title-bar"><span className="card-icon"><i className="fas fa-pen"></i></span><div><h3>{editingId==='new'?'สร้างรายการใหม่':'แก้ไขรายการ'}</h3><p>ข้อความไทยและอังกฤษจะแสดงตามภาษาของผู้ใช้</p></div></div>
      <div className="form-body">
        <div className="form-group"><label>ประเภท</label><select value={draft.preset} onChange={e=>patch({preset:e.target.value as ServicePreset})}>{PRESETS.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}</select><div className="form-hint">{PRESETS.find(p=>p.id===draft.preset)?.blurb}</div></div>
        <div className="form-group"><label>บริการที่ได้รับผลกระทบ</label><div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))',gap:8}}>{SURFACES.map(s=><label key={s.id} className="alert-row" style={{cursor:'pointer'}}><input type="checkbox" checked={draft.surfaces.includes(s.id)} onChange={()=>toggleSurface(s.id)}/><span><strong>{s.label}</strong><div className="form-hint">{s.hint}</div></span></label>)}</div></div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(260px,1fr))',gap:12}}><div className="form-group"><label>หัวข้อภาษาไทย</label><input value={draft.titleTh} onChange={e=>patch({titleTh:e.target.value})} placeholder="เช่น พบปัญหาการเข้าใช้งาน Ask LITALK"/></div><div className="form-group"><label>Title in English</label><input value={draft.titleEn} onChange={e=>patch({titleEn:e.target.value})} placeholder="e.g. Ask LITALK login issue"/></div></div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(260px,1fr))',gap:12}}><div className="form-group"><label>เกิดอะไรขึ้น / รายละเอียดภาษาไทย</label><textarea rows={5} value={draft.bodyTh} onChange={e=>patch({bodyTh:e.target.value})} placeholder="อธิบายผลกระทบ สิ่งที่ทีมกำลังทำ และสิ่งที่ผู้ใช้ควรทราบ"/></div><div className="form-group"><label>What happened / English details</label><textarea rows={5} value={draft.bodyEn} onChange={e=>patch({bodyEn:e.target.value})} placeholder="Describe the impact, investigation, and what users should know"/></div></div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(210px,1fr))',gap:12}}><div className="form-group"><label>เริ่มแสดงประกาศ</label><input type="datetime-local" value={toLocalInput(draft.announceFrom)} onChange={e=>patch({announceFrom:fromLocalInput(e.target.value)})}/><div className="form-hint">เว้นว่าง = แสดงทันที</div></div><div className="form-group"><label>เริ่มปิดบริการ</label><input type="datetime-local" value={toLocalInput(draft.startsAt)} onChange={e=>patch({startsAt:fromLocalInput(e.target.value)})}/><div className="form-hint">เว้นว่าง = เป็นประกาศอย่างเดียว ไม่บล็อก</div></div><div className="form-group"><label>สิ้นสุด / เปิดคืน</label><input type="datetime-local" value={toLocalInput(draft.endsAt)} onChange={e=>patch({endsAt:fromLocalInput(e.target.value)})}/></div></div>
        <label style={{display:'flex',gap:8,alignItems:'center',marginBottom:16}}><input type="checkbox" checked={draft.dismissible} onChange={e=>patch({dismissible:e.target.checked})}/> ผู้ใช้ปิด popup ประกาศได้ (ไม่มีผลเมื่ออยู่ในช่วง block)</label>
        <div style={{display:'flex',gap:8}}><button className="btn btn-primary" onClick={save} disabled={saving}><i className="fas fa-floppy-disk"></i> {saving?'กำลังบันทึก...':'เผยแพร่'}</button><button className="btn btn-secondary" onClick={()=>setEditingId(null)}>ยกเลิก</button></div>
      </div>
    </div>}

    <div className="admin-card">
      <div className="card-title-bar"><span className="card-icon"><i className="fas fa-clock-rotate-left"></i></span><div><h3>ประกาศและสถานะทั้งหมด</h3><p>รายการนี้เป็นแหล่งข้อมูลเดียวกับหน้า Status และระบบเปิด–ปิดบริการ</p></div></div>
      {failed && <div className="info-notice"><i className="fas fa-triangle-exclamation"></i><div>โหลดข้อมูลไม่สำเร็จ <button className="btn btn-secondary" onClick={load}>ลองใหม่</button></div></div>}
      {notices===null && !failed && <div className="skeleton skeleton-line" style={{width:'60%'}}/>}
      {notices && notices.length===0 && <div className="empty-state"><i className="fas fa-circle-check"></i><div className="empty-title">ยังไม่มีประกาศ</div><div className="empty-sub">ทุกบริการทำงานตามปกติ</div></div>}
      {notices && notices.length>0 && <div className="row-list">{notices.map(n=>{const phase=phaseOf(n,now);return <div className="alert-row" key={n.id} style={{alignItems:'flex-start'}}><i className={`fas ${phase==='blocking'?'fa-circle-pause':'fa-bullhorn'}`} style={{marginTop:4,color:phase==='blocking'?'var(--accent-danger)':'var(--text-muted)'}}></i><div style={{flex:1,minWidth:0}}><div className="alert-text"><strong>{n.titleTh || PRESETS.find(p=>p.id===n.preset)?.label || n.preset}</strong> <span className={`ai-status-pill ${phase==='blocking'?'is-off':''}`} style={{marginLeft:6}}>{PHASE_LABEL[phase]}</span></div>{n.bodyTh && <div className="form-hint" style={{marginTop:4}}>{n.bodyTh}</div>}<div className="form-hint" style={{marginTop:5}}>{n.surfaces.map(s=>SURFACES.find(x=>x.id===s)?.label||s).join(' · ')}{n.endsAt?` • ถึง ${formatWhen(n.endsAt)}`:''}</div></div><div style={{display:'flex',gap:6}}><button className="btn btn-secondary" onClick={()=>openEdit(n)}><i className="fas fa-pen"></i></button><button className="btn btn-secondary" onClick={()=>remove(n)}><i className="fas fa-trash"></i></button></div></div>})}</div>}
    </div>

    <div className="admin-card">
      <div className="card-title-bar"><span className="card-icon"><i className="fas fa-key"></i></span><div><h3>Maintenance preview</h3><p>ใช้ตรวจหน้าเว็บขณะที่ผู้ใช้ทั่วไปถูก block</p></div></div>
      <div className="form-body"><div className="form-group"><label>Preview URL</label><input readOnly value={bypassToken?previewUrl:'กำลังโหลด…'}/></div><div style={{display:'flex',gap:8,flexWrap:'wrap'}}><button className="btn btn-secondary" onClick={()=>navigator.clipboard?.writeText(previewUrl)} disabled={!bypassToken}><i className="fas fa-copy"></i> คัดลอก</button><button className="btn btn-secondary" onClick={rotate}><i className="fas fa-rotate"></i> สร้าง token ใหม่</button></div></div>
    </div>
  </div>;
}
