import { useEffect, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { fetchTcasFortuneSettings, saveTcasFortuneSettings, type TcasFortuneSettings } from '../api/client';
import { makeTokenGetter } from '../api/client';
import { useToast } from '../ui/ToastContext';

export default function TcasFortuneScreen() {
  const { getAccessTokenSilently } = useAuth0();
  const toast = useToast();
  const getToken = makeTokenGetter(getAccessTokenSilently);
  const [value, setValue] = useState<TcasFortuneSettings | null>(null);
  const [categories, setCategories] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { fetchTcasFortuneSettings(getToken).then(r => { setValue(r.settings); setCategories(JSON.parse(r.settings.categoriesJson).join(', ')); }).catch(e => toast('โหลดไม่สำเร็จ', String(e), 'error')); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!value) return <div className="tab-content active"><div className="loader" /></div>;
  const patch = (p: Partial<TcasFortuneSettings>) => setValue(v => v ? {...v,...p} : v);
  const save = async () => { setSaving(true); try { await saveTcasFortuneSettings(getToken,{...value,categories:categories.split(',').map(x=>x.trim()).filter(Boolean)}); toast('บันทึกการตั้งค่าแล้ว', undefined, 'success'); } catch(e) { toast('บันทึกไม่สำเร็จ', String(e), 'error'); } finally { setSaving(false); } };
  return <div id="screen-tcas-fortune" className="tab-content active">
    <div className="page-header"><div><h1>TCAS Fortune</h1><p>ควบคุมการเปิดไพ่ดูดวง TCAS โดยไม่เปิดเผยกุญแจ AI</p></div><button className="btn btn-primary" disabled={saving} onClick={save}>{saving?'กำลังบันทึก…':'บันทึก'}</button></div>
    <div className="card"><h3>สถานะฟีเจอร์</h3><div className="form-grid">
      <label className="checkbox-label"><input type="checkbox" checked={!!value.enabled} onChange={e=>patch({enabled:e.target.checked?1:0})}/> เปิดใช้งาน</label>
      <label className="checkbox-label"><input type="checkbox" checked={!!value.maintenance} onChange={e=>patch({maintenance:e.target.checked?1:0})}/> โหมดบำรุงรักษา</label>
      <label className="checkbox-label"><input type="checkbox" checked={!!value.shareEnabled} onChange={e=>patch({shareEnabled:e.target.checked?1:0})}/> เปิดการแชร์</label>
      <label className="checkbox-label"><input type="checkbox" checked={!!value.askLitalkEnabled} onChange={e=>patch({askLitalkEnabled:e.target.checked?1:0})}/> เปิดส่งต่อ Ask LITALK</label>
    </div></div>
    <div className="card"><h3>ขีดจำกัดและโมเดล</h3><div className="form-grid">
      <label>จำนวนต่อวัน<input type="number" min="1" max="100" value={value.dailyLimit} onChange={e=>patch({dailyLimit:Number(e.target.value)})}/></label>
      <label>จำนวนต่อชั่วโมง<input type="number" min="1" max="20" value={value.burstLimit} onChange={e=>patch({burstLimit:Number(e.target.value)})}/></label>
      <label>Gemini model<input value={value.model} onChange={e=>patch({model:e.target.value})}/></label>
      <label>Max output tokens<input type="number" min="256" max="4096" value={value.maxOutputTokens} onChange={e=>patch({maxOutputTokens:Number(e.target.value)})}/></label>
    </div></div>
    <div className="card"><h3>คำถามและคำสั่งเพิ่มเติม</h3><label>Stable category IDs (คั่นด้วย comma)<input value={categories} onChange={e=>setCategories(e.target.value)}/></label><label>คำสั่งระบบเพิ่มเติม<textarea rows={6} maxLength={4000} value={value.promptAdditions} onChange={e=>patch({promptAdditions:e.target.value})}/></label><p className="text-muted">ไพ่ Major Arcana ทั้ง 22 ใบและข้อความ disclaimer เป็นข้อมูลมาตรฐานฝั่ง Worker และยังแก้ไขจากหน้านี้ไม่ได้</p></div>
  </div>;
}
