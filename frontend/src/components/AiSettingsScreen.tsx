import { useCallback, useEffect, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { useToast } from '../ui/ToastContext';
import AiChatLogs from './AiChatLogs';
import TabMenu from './TabMenu';
import {
  makeTokenGetter,
  fetchAiChatSettings,
  saveAiChatSettings,
  type AiChatOptions,
  type AiChatSettings,
  type AiSurface,
  type AiSurfaceSettings,
} from '../api/client';

// น้องลิลลี่ answers on four surfaces, each with its own audience and its
// own prompt. The admin-panel one is last because the panel it belongs to
// is being retired — it's kept configurable only while that panel is live.
const SURFACES: Array<{ id: AiSurface; label: string; blurb: string; icon: string }> = [
  {
    id: 'portal',
    label: 'นักเรียน',
    blurb: 'ผู้ช่วยในพอร์ทัลนักเรียน — ตอบคำถามของนักเรียนและผู้ปกครองเกี่ยวกับบัญชีของตัวเอง (ตารางเรียน ชั่วโมงคงเหลือ การชำระเงิน)',
    icon: 'fa-user-graduate',
  },
  {
    id: 'general',
    label: 'เว็บไซต์',
    blurb: 'ผู้ช่วยหน้าเว็บไซต์สาธารณะ — ตอบคำถามทั่วไปของผู้สนใจที่ยังไม่ได้เป็นนักเรียน (หลักสูตร วิธีเริ่มเรียน)',
    icon: 'fa-globe',
  },
  {
    id: 'vocab',
    label: 'ถามคำศัพท์ (/ask)',
    blurb: 'ผู้ช่วยสอนคำศัพท์ที่ litalkeducation.com/ask — อธิบายความหมาย ตัวอย่างประโยค และการใช้คำภาษาอังกฤษให้นักเรียน',
    icon: 'fa-book-open',
  },
  {
    id: 'staff',
    label: 'แผงแอดมิน (ระบบเดิม)',
    blurb: 'ผู้ช่วยในแผงแอดมินหน้าเดิม — ระบบใหม่ไม่มีแชทในตัวแล้ว การตั้งค่านี้จึงมีผลกับหน้าเดิมเท่านั้น',
    icon: 'fa-screwdriver-wrench',
  },
];

// The point-and-click controls. `publicOnly` options are meaningless for the
// internal staff assistant (staff don't need to be told to contact staff),
// so they're hidden on that tab rather than shown and ignored.
type OptionKey = keyof AiChatOptions;

// `fallback` is the value shown when the surface has never been configured,
// and must match what worker/src/aiSettings.ts does with an absent option —
// otherwise the screen claims a behaviour the assistant isn't following.
const CHOICES: Array<{
  key: Extract<OptionKey, 'tone' | 'length' | 'language' | 'unknown'>;
  label: string;
  hint: string;
  icon: string;
  fallback: string;
  options: Array<{ value: string; label: string }>;
}> = [
  {
    key: 'tone',
    label: 'โทนการตอบ',
    hint: 'บุคลิกของน้องลิลลี่เวลาคุยกับผู้ใช้',
    icon: 'fa-face-smile',
    fallback: 'friendly',
    options: [
      { value: 'friendly', label: 'เป็นกันเอง (ค่าเริ่มต้น)' },
      { value: 'formal', label: 'สุภาพทางการ — ใช้ครับ/ค่ะ' },
      { value: 'concise', label: 'ตรงประเด็น ไม่ทักทาย' },
    ],
  },
  {
    key: 'length',
    label: 'ความยาวคำตอบ',
    hint: 'คำตอบยาวขึ้นจะละเอียดขึ้นแต่ใช้เวลาอ่านนานขึ้น',
    icon: 'fa-align-left',
    fallback: 'medium',
    options: [
      { value: 'short', label: 'สั้นมาก — 1-2 ประโยค' },
      { value: 'medium', label: 'ปานกลาง (ค่าเริ่มต้น)' },
      { value: 'detailed', label: 'ละเอียด — มีคำอธิบายและตัวอย่าง' },
    ],
  },
  {
    key: 'language',
    label: 'ภาษาที่ตอบ',
    hint: 'ค่าเริ่มต้นคือตอบตามภาษาที่ผู้ใช้พิมพ์เข้ามา',
    icon: 'fa-language',
    fallback: 'auto',
    options: [
      { value: 'auto', label: 'ตามภาษาที่ผู้ใช้พิมพ์ (ค่าเริ่มต้น)' },
      { value: 'th', label: 'ตอบเป็นภาษาไทยเสมอ' },
      { value: 'en', label: 'ตอบเป็นภาษาอังกฤษเสมอ' },
    ],
  },
  {
    key: 'unknown',
    label: 'เมื่อไม่รู้คำตอบ',
    hint: 'ป้องกันไม่ให้ AI เดาคำตอบที่ไม่มีข้อมูลจริง',
    icon: 'fa-circle-question',
    fallback: 'admit',
    options: [
      { value: 'admit', label: 'บอกตรง ๆ ว่าไม่ทราบ (ค่าเริ่มต้น)' },
      { value: 'referStaff', label: 'บอกว่าไม่ทราบ และให้ติดต่อเจ้าหน้าที่ทาง LINE OA' },
    ],
  },
];

// Short form of the language choice for the at-a-glance status strip.
const LANGUAGE_PILL: Record<string, string> = {
  auto: 'ตอบตามภาษาผู้ใช้',
  th: 'ตอบไทยเสมอ',
  en: 'ตอบอังกฤษเสมอ',
};

const SWITCHES: Array<{
  key: Extract<OptionKey, 'emoji' | 'referContact' | 'noPricing'>;
  label: string;
  hint: string;
  publicOnly?: boolean;
}> = [
  { key: 'emoji', label: 'ใช้อีโมจิในคำตอบ', hint: 'ใส่อีโมจิเล็กน้อยให้ดูเป็นมิตรขึ้น' },
  {
    key: 'referContact',
    label: 'แนะนำช่องทางติดต่อเจ้าหน้าที่',
    hint: 'เมื่อเรื่องเกินขอบเขตที่ AI ทำได้ ให้แนะนำ LINE OA',
    publicOnly: true,
  },
  {
    key: 'noPricing',
    label: 'ห้ามระบุราคาและโปรโมชั่น',
    hint: 'ให้ส่งคำถามเรื่องราคาต่อให้เจ้าหน้าที่แทนการตอบเอง — กันข้อมูลราคาที่ไม่อัปเดต',
    publicOnly: true,
  },
];

// Mirrors composeGuidance()/styleLine() in worker/src/aiSettings.ts so the
// admin can see what their choices actually tell the model. Deliberately a
// summary in Thai rather than the literal English prompt: the point is to
// confirm the settings read the way they intended, not to expose the prompt.
function previewLines(settings: AiSurfaceSettings): string[] {
  const { options: o } = settings;
  const lines: string[] = [];

  const language =
    o.language === 'th' ? 'ตอบเป็นภาษาไทยเสมอ' : o.language === 'en' ? 'ตอบเป็นภาษาอังกฤษเสมอ' : 'ตอบตามภาษาที่ผู้ใช้พิมพ์';
  const length =
    o.length === 'short' ? 'ตอบสั้นมาก (1-2 ประโยค)' : o.length === 'detailed' ? 'ตอบละเอียดพร้อมตัวอย่าง' : 'ตอบความยาวปานกลาง';
  const tone = o.tone === 'formal' ? 'ใช้โทนสุภาพทางการ' : o.tone === 'concise' ? 'ใช้โทนตรงประเด็น' : 'ใช้โทนเป็นกันเอง';
  lines.push(`${language} · ${length} · ${tone}`);

  if (o.emoji === true) lines.push('ใส่อีโมจิได้เล็กน้อย');
  else if (o.emoji === false) lines.push('ไม่ใช้อีโมจิ');

  if (o.unknown === 'referStaff') lines.push('ถ้าไม่ทราบคำตอบ ให้บอกตรง ๆ และแนะนำให้ติดต่อเจ้าหน้าที่ทาง LINE OA');
  else lines.push('ถ้าไม่ทราบคำตอบ ให้บอกตรง ๆ ห้ามเดา');

  if (o.referContact) lines.push('แนะนำช่องทาง LINE OA เมื่อเรื่องเกินขอบเขตที่ตอบได้');
  if (o.noPricing) lines.push('ห้ามระบุราคา ส่วนลด หรือโปรโมชั่นเอง');

  const freeText = settings.instructions.trim();
  if (freeText) lines.push(`คำสั่งเพิ่มเติมที่เขียนเอง: ${freeText}`);
  return lines;
}

export default function AiSettingsScreen() {
  const { getAccessTokenSilently } = useAuth0();
  const showToast = useToast();

  const [settings, setSettings] = useState<AiChatSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [surface, setSurface] = useState<AiSurface>('portal');
  const [saving, setSaving] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // Tracks which surfaces have unsaved edits so the save button can say so,
  // and so switching tabs doesn't silently look like everything is saved.
  const [dirty, setDirty] = useState<Set<AiSurface>>(new Set());

  const load = useCallback(async () => {
    try {
      setSettings(await fetchAiChatSettings(makeTokenGetter(getAccessTokenSilently)));
      setFailed(false);
    } catch (error) {
      console.error('fetchAiChatSettings:', error);
      setFailed(true);
    }
  }, [getAccessTokenSilently]);

  useEffect(() => {
    load();
  }, [load]);

  const current = settings?.[surface] ?? null;

  const patch = (changes: Partial<AiSurfaceSettings>) => {
    setSettings((prev) => (prev ? { ...prev, [surface]: { ...prev[surface], ...changes } } : prev));
    setDirty((prev) => new Set(prev).add(surface));
  };

  const patchOption = (changes: AiChatOptions) => {
    if (!current) return;
    patch({ options: { ...current.options, ...changes } });
  };

  const save = async () => {
    if (!settings || !dirty.size) return;
    setSaving(true);
    try {
      // Send every edited surface, not just the visible one, so edits made
      // on another tab before switching aren't quietly dropped.
      const changed: Partial<AiChatSettings> = {};
      for (const id of dirty) changed[id] = settings[id];
      const saved = await saveAiChatSettings(makeTokenGetter(getAccessTokenSilently), changed);
      setSettings(saved);
      setDirty(new Set());
      showToast('บันทึกการตั้งค่าสำเร็จ', 'การเปลี่ยนแปลงมีผลกับข้อความถัดไปทันที', 'success');
    } catch (error) {
      showToast('บันทึกไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    } finally {
      setSaving(false);
    }
  };

  const meta = SURFACES.find((s) => s.id === surface)!;
  const isPublic = surface !== 'staff';

  return (
    <div id="screen-ai-settings" className="tab-content active">
      <div className="screen-header">
        <h1>ตั้งค่า AI Chat</h1>
        <p>
          ปรับวิธีตอบของผู้ช่วย AI "น้องลิลลี่" แยกตามแต่ละช่องทาง — เลือกจากตัวเลือกสำเร็จรูปได้เลย
          หรือเปิดการตั้งค่าขั้นสูงเพื่อกำหนดเอง
        </p>
      </div>

      <TabMenu
        items={SURFACES.map((s) => ({
          id: s.id,
          label: s.label,
          icon: s.icon,
          dot: dirty.has(s.id),
          dotTitle: 'มีการแก้ไขที่ยังไม่บันทึก',
        }))}
        active={surface}
        onChange={setSurface}
        ariaLabel="ส่วนของ AI Chat"
      />

      {failed && (
        <div className="admin-card">
          <div className="info-notice">
            <i className="fas fa-triangle-exclamation" style={{ color: 'var(--accent-danger)' }}></i>
            <div>
              โหลดการตั้งค่าไม่สำเร็จ —{' '}
              <button className="btn btn-secondary" style={{ marginLeft: 8 }} onClick={load}>
                ลองใหม่
              </button>
            </div>
          </div>
        </div>
      )}

      {!settings && !failed && (
        <div className="admin-card">
          <div className="skeleton skeleton-line" style={{ width: '40%', marginBottom: 12 }}></div>
          <div className="skeleton skeleton-line" style={{ width: '80%', marginBottom: 12 }}></div>
          <div className="skeleton skeleton-line" style={{ width: '65%' }}></div>
        </div>
      )}

      {current && (
        <>
          <div className="admin-card">
            <div className="card-title-bar">
              <span className="card-icon">
                <i className={`fas ${meta.icon}`}></i>
              </span>
              <div>
                <h3>{meta.label}</h3>
                <p>{meta.blurb}</p>
              </div>
            </div>

            <div className="ai-status-strip">
              <span className={`ai-status-pill ${current.enabled ? 'is-on' : 'is-off'}`}>
                <i className={`fas ${current.enabled ? 'fa-circle-check' : 'fa-circle-pause'}`}></i>
                {current.enabled ? 'เปิดใช้งานอยู่' : 'ปิดอยู่'}
              </span>
              <span className="ai-status-pill">
                <i className="fas fa-gauge-high"></i>
                {current.dailyLimit} ข้อความ/วัน
              </span>
              <span className="ai-status-pill">
                <i className="fas fa-language"></i>
                {LANGUAGE_PILL[current.options.language ?? 'auto']}
              </span>
            </div>

            {!current.enabled && (
              <div className="info-notice">
                <i className="fas fa-circle-pause"></i>
                <div>
                  ช่องทางนี้ถูกปิดอยู่ — ผู้ใช้จะเห็นข้อความว่าผู้ช่วย AI ปิดให้บริการ เปิดใหม่ได้ที่การตั้งค่าขั้นสูงด้านล่าง
                </div>
              </div>
            )}

            <div className="form-body">
              <div className="ai-option-grid">
                {CHOICES.map((choice) => (
                  <div className="form-group" key={choice.key}>
                    <label htmlFor={`ai-${choice.key}`}>
                      <i className={`fas ${choice.icon}`}></i> {choice.label}
                    </label>
                    <select
                      id={`ai-${choice.key}`}
                      value={current.options[choice.key] ?? choice.fallback}
                      onChange={(e) => patchOption({ [choice.key]: e.target.value } as AiChatOptions)}
                    >
                      {choice.options.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <div className="form-hint">{choice.hint}</div>
                  </div>
                ))}
              </div>

              <div style={{ marginTop: 4 }}>
                {SWITCHES.filter((s) => !s.publicOnly || isPublic).map((toggle) => (
                  <label className="ai-toggle-row" key={toggle.key}>
                    <span className="ai-switch">
                      <input
                        type="checkbox"
                        checked={current.options[toggle.key] === true}
                        onChange={(e) => patchOption({ [toggle.key]: e.target.checked } as AiChatOptions)}
                      />
                      <span className="ai-switch-track"></span>
                    </span>
                    <span className="ai-toggle-text">
                      <span className="ai-toggle-title">{toggle.label}</span>
                      <span className="ai-toggle-hint">{toggle.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </div>

          <div className="admin-card">
            <div className="card-title-bar">
              <span className="card-icon">
                <i className="fas fa-eye"></i>
              </span>
              <div>
                <h3>สรุปสิ่งที่ AI จะทำ</h3>
                <p>สรุปจากตัวเลือกด้านบน เพื่อตรวจก่อนบันทึก</p>
              </div>
            </div>
            <ul className="ai-preview-list">
              {previewLines(current).map((line, i) => (
                <li key={i}>
                  <i className="fas fa-check"></i>
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="admin-card">
            <button
              type="button"
              className="ai-advanced-toggle card-title-bar"
              onClick={() => setAdvancedOpen((open) => !open)}
              aria-expanded={advancedOpen}
            >
              <span className="card-icon">
                <i className="fas fa-sliders"></i>
              </span>
              <div>
                <h3>การตั้งค่าขั้นสูง</h3>
                <p>เปิด/ปิดช่องทาง จำกัดจำนวนข้อความต่อวัน และเขียนคำสั่งเพิ่มเติมเอง</p>
              </div>
              <i className="fas fa-chevron-down ai-advanced-chevron"></i>
            </button>

            {advancedOpen && (
              <div className="form-body">
                <label className="ai-toggle-row">
                  <span className="ai-switch">
                    <input type="checkbox" checked={current.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
                    <span className="ai-switch-track"></span>
                  </span>
                  <span className="ai-toggle-text">
                    <span className="ai-toggle-title">เปิดใช้งานผู้ช่วย AI ในช่องทางนี้</span>
                    <span className="ai-toggle-hint">
                      ปิดแล้วผู้ใช้จะยังเห็นกล่องแชท แต่ได้รับข้อความว่าผู้ช่วยปิดให้บริการ แทนที่จะเงียบไปเฉย ๆ
                    </span>
                  </span>
                </label>

                <div className="form-group">
                  <label htmlFor="ai-daily-limit">
                    <i className="fas fa-gauge-high"></i> จำกัดข้อความต่อวัน (ต่อผู้ใช้ 1 คน)
                  </label>
                  <input
                    id="ai-daily-limit"
                    type="number"
                    min={0}
                    max={1000}
                    value={current.dailyLimit}
                    onChange={(e) => patch({ dailyLimit: Number(e.target.value) })}
                  />
                  <div className="form-hint">
                    กันค่าใช้จ่ายบานปลายและการใช้งานผิดวัตถุประสงค์ ตั้งเป็น 0 คือไม่ให้ถามเลย
                    {isPublic ? ' — ช่องทางสาธารณะควรตั้งต่ำกว่าช่องทางภายใน' : ''}
                  </div>
                </div>

                <div className="form-group">
                  <label htmlFor="ai-instructions">
                    <i className="fas fa-pen-to-square"></i> คำสั่งเพิ่มเติม (เขียนเอง)
                  </label>
                  <textarea
                    id="ai-instructions"
                    rows={6}
                    maxLength={4000}
                    placeholder={'เช่น "ถ้าถูกถามเรื่องคอร์สติวสอบ ให้แนะนำคอร์ส IELTS ก่อน"'}
                    value={current.instructions}
                    onChange={(e) => patch({ instructions: e.target.value })}
                  />
                  <div className="form-hint">
                    ต่อท้ายคำสั่งจากตัวเลือกด้านบน ใช้สำหรับกรณีเฉพาะที่ตัวเลือกสำเร็จรูปครอบคลุมไม่ถึง —
                    คำสั่งนี้ไม่สามารถลบล้างกฎความปลอดภัยของระบบได้ (เช่น ห้ามเปิดเผยข้อมูลนักเรียนคนอื่น)
                    · {current.instructions.length}/4000
                  </div>
                </div>
              </div>
            )}
          </div>

          <AiChatLogs surface={surface} />

          <div className="ai-save-bar">
            <button className="btn btn-primary" onClick={save} disabled={saving || !dirty.size}>
              <i className="fas fa-floppy-disk"></i> {saving ? 'กำลังบันทึก...' : 'บันทึกการตั้งค่า'}
            </button>
            <span className="form-hint">
              {dirty.size
                ? `ยังไม่บันทึก: ${[...dirty].map((id) => SURFACES.find((s) => s.id === id)?.label).join(', ')}`
                : 'บันทึกไว้ทั้งหมดแล้ว'}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
