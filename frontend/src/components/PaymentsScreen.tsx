import { useCallback, useEffect, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { useStudents } from '../hooks/useStudents';
import { useSharedStudentSelection } from '../hooks/useSharedStudentSelection';
import { useMe } from '../hooks/useMe';
import { useToast } from '../ui/ToastContext';
import { useConfirm } from '../ui/ConfirmContext';
import StudentPicker, { StudentIndicator } from '../ui/StudentPicker';
import { formatBaht, formatShortThaiDate } from '../utils/format';
import {
  makeTokenGetter,
  createPayment,
  fetchEarnings,
  fetchPromotionCodes,
  fetchPaymentLinks,
  createPaymentLinkApi,
  deactivatePaymentLinkApi,
  type EarningsResponse,
  type PromotionCode,
  type PaymentLink,
} from '../api/client';

const LINK_STATUS_LABEL: Record<string, string> = { active: 'รอชำระ', paid: 'ชำระแล้ว', deactivated: 'ยกเลิกแล้ว' };

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function PaymentsScreen() {
  const { getAccessTokenSilently } = useAuth0();
  const { students, failed: studentsFailed } = useStudents();
  const [selectedId, setSelectedId] = useSharedStudentSelection();
  const { isAdmin } = useMe();
  const showToast = useToast();
  const confirmDialog = useConfirm();

  const [total, setTotal] = useState('');
  const [method, setMethod] = useState('โอนผ่านบัญชีธนาคาร');
  const [date, setDate] = useState(today());
  const [proof, setProof] = useState('');

  const [earnings, setEarnings] = useState<EarningsResponse | null>(null);
  const [promoCodes, setPromoCodes] = useState<PromotionCode[]>([]);
  const [links, setLinks] = useState<PaymentLink[] | null>(null);
  const [linkAmount, setLinkAmount] = useState('');
  const [linkCustomer, setLinkCustomer] = useState('');
  const [linkDescription, setLinkDescription] = useState('');
  const [linkPromoCode, setLinkPromoCode] = useState('');
  const [linkResult, setLinkResult] = useState<string | null>(null);

  const selected = students.find((s) => s.id === selectedId) || null;

  const loadEarnings = useCallback(async () => {
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      setEarnings(await fetchEarnings(getToken));
    } catch {
      setEarnings(null);
    }
  }, [getAccessTokenSilently]);

  const loadLinks = useCallback(async () => {
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      setLinks(await fetchPaymentLinks(getToken));
    } catch {
      setLinks([]);
    }
  }, [getAccessTokenSilently]);

  useEffect(() => {
    loadEarnings();
    if (isAdmin) {
      loadLinks();
      fetchPromotionCodes(makeTokenGetter(getAccessTokenSilently))
        .then(setPromoCodes)
        .catch(() => {});
    }
  }, [loadEarnings, loadLinks, isAdmin, getAccessTokenSilently]);

  const submitPayment = async () => {
    if (!selectedId) {
      showToast('กรุณาเลือกนักเรียนจากรายชื่อด้านบน', undefined, 'error');
      return;
    }
    if (!total) {
      showToast('กรุณากรอกยอดเงิน', undefined, 'error');
      return;
    }
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      const result = await createPayment(getToken, { studentId: selectedId, method, total, date, proof });
      showToast('บันทึกสำเร็จ', result.message, 'success');
      setTotal('');
      setProof('');
      loadEarnings();
    } catch (error) {
      showToast('เกิดข้อผิดพลาดจากระบบ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const submitLink = async () => {
    const amount = Number(linkAmount);
    if (!amount || amount <= 0) {
      showToast('กรุณากรอกยอดเงิน', undefined, 'error');
      return;
    }
    if (!selectedId && !linkCustomer.trim()) {
      showToast('เลือกนักเรียนด้านบน หรือกรอกชื่อลูกค้า', undefined, 'error');
      return;
    }
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      const result = await createPaymentLinkApi(getToken, {
        amount,
        description: linkDescription.trim(),
        ...(linkCustomer.trim() ? { customerName: linkCustomer.trim() } : { studentId: selectedId }),
        ...(linkPromoCode.trim() ? { promoCode: linkPromoCode.trim() } : {}),
      });
      setLinkResult(result.shortUrl || result.url);
      setLinkAmount('');
      setLinkCustomer('');
      setLinkDescription('');
      setLinkPromoCode('');
      loadLinks();
      loadEarnings();
    } catch (error) {
      showToast('สร้างลิงก์ไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const deactivateLink = async (id: number) => {
    if (
      !(await confirmDialog('ยกเลิกลิงก์ชำระเงินนี้หรือไม่? ลูกค้าจะไม่สามารถใช้ลิงก์นี้ชำระเงินได้อีก', {
        title: 'ยกเลิกลิงก์ชำระเงิน',
        danger: true,
        okLabel: 'ยกเลิกลิงก์',
      }))
    )
      return;
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      await deactivatePaymentLinkApi(getToken, id);
      loadLinks();
      loadEarnings();
    } catch (error) {
      showToast('ยกเลิกลิงก์ไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const monthLabel = new Date().toLocaleDateString('th-TH', { month: 'long', year: 'numeric' });

  return (
    <div id="screen-payments" className="tab-content active">
      <div className="screen-header">
        <h1>บันทึกการชำระเงิน</h1>
        <p>บันทึกยอดชำระและหลักฐานการโอนของนักเรียน</p>
      </div>

      <div className="sticky-picker">
        <StudentPicker students={students} loadFailed={studentsFailed} value={selectedId} onChange={setSelectedId} />
        <StudentIndicator student={selected} verb="กำลังบันทึกให้" />
      </div>

      <div className={`form-cards-wrapper${selectedId ? '' : ' disabled'}`}>
        <div className="admin-card">
          <div className="card-title-bar">
            <span className="card-icon">
              <i className="fas fa-receipt"></i>
            </span>
            <div>
              <h3>ข้อมูลการชำระเงิน</h3>
              <p>ระบบบันทึกยอดชำระให้อัตโนมัติ</p>
            </div>
          </div>
          <div className="form-body">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div className="form-group">
                <label>
                  <i className="fas fa-baht-sign"></i> จำนวนเงิน (บาท)
                </label>
                <input type="number" placeholder="0.00" inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} />
              </div>
              <div className="form-group">
                <label>
                  <i className="fas fa-credit-card"></i> วิธีชำระเงิน
                </label>
                <div className="select-wrapper">
                  <select value={method} onChange={(e) => setMethod(e.target.value)}>
                    <option value="โอนผ่านบัญชีธนาคาร">โอนผ่านบัญชีธนาคาร</option>
                    <option value="พร้อมเพย์">พร้อมเพย์</option>
                    <option value="เงินสด">เงินสด</option>
                    <option value="บัตรเครดิต">บัตรเครดิต</option>
                  </select>
                </div>
              </div>
              <div className="form-group">
                <label>
                  <i className="fas fa-calendar-day"></i> วันที่ชำระ
                </label>
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
              <div className="form-group">
                <label>
                  <i className="fas fa-link"></i> ลิงก์หลักฐานการโอน
                </label>
                <input type="url" placeholder="https://drive.google.com/..." value={proof} onChange={(e) => setProof(e.target.value)} />
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn btn-primary" onClick={submitPayment}>
                <i className="fas fa-save"></i> บันทึกการชำระเงิน
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="admin-card" style={{ marginTop: 24 }}>
        <div className="card-title-bar">
          <span className="card-icon">
            <i className="fas fa-sack-dollar"></i>
          </span>
          <div>
            <h3>รายรับเดือนนี้</h3>
            <p>{monthLabel}</p>
          </div>
        </div>
        <div className="form-body">
          {!earnings ? (
            <div className="form-hint">โหลดข้อมูลรายรับไม่สำเร็จ</div>
          ) : earnings.restricted ? (
            <>
              <div className="payment-row">
                <div className="payment-info">
                  <div className="name">
                    <i className="fas fa-user-graduate"></i> รายได้รวมจากนักเรียนของฉัน
                  </div>
                  <div className="meta">
                    {earnings.assigned?.count} รายการ · {earnings.studentCount} คน
                  </div>
                </div>
                <div className="amount">{formatBaht(earnings.assigned?.total)}</div>
              </div>
              <div className="payment-row">
                <div className="payment-info">
                  <div className="name">
                    <i className="fas fa-user-check"></i> ที่ฉันบันทึกเอง
                  </div>
                  <div className="meta">{earnings.mine.count} รายการ</div>
                </div>
                <div className="amount">{formatBaht(earnings.mine.total)}</div>
              </div>
              <div className="form-hint" style={{ marginTop: 8 }}>
                ยอดนี้คือรายรับรวมของนักเรียนที่คุณรับผิดชอบในเดือนนี้
              </div>
            </>
          ) : (
            <>
              {[
                { icon: 'fas fa-coins', label: 'รวมทั้งหมด', value: formatBaht(earnings.total), meta: `${earnings.count} รายการ` },
                { icon: 'fas fa-user-check', label: 'บันทึกโดยฉัน', value: formatBaht(earnings.mine.total), meta: `${earnings.mine.count} รายการ` },
                { icon: 'fab fa-stripe-s', label: 'ผ่าน Stripe', value: formatBaht(earnings.stripeTotal), meta: `บันทึกเอง ${formatBaht(earnings.manualTotal)}` },
                {
                  icon: 'fas fa-hourglass-half',
                  label: 'รอชำระจากลิงก์ที่เปิดอยู่',
                  value: formatBaht(earnings.pendingLinks?.total),
                  meta: `${earnings.pendingLinks?.count} ลิงก์`,
                },
              ].map((r, i) => (
                <div className="payment-row" key={i}>
                  <div className="payment-info">
                    <div className="name">
                      <i className={r.icon}></i> {r.label}
                    </div>
                    <div className="meta">{r.meta}</div>
                  </div>
                  <div className="amount">{r.value}</div>
                </div>
              ))}
              {!!earnings.byUser?.length && earnings.byUser.length > 1 && (
                <>
                  <div className="form-hint" style={{ marginTop: 8 }}>
                    แยกตามผู้บันทึก
                  </div>
                  {earnings.byUser.map((u, i) => (
                    <div className="payment-row" key={i}>
                      <div className="payment-info">
                        <div className="name">{u.email}</div>
                        <div className="meta">{u.count} รายการ</div>
                      </div>
                      <div className="amount">{formatBaht(u.total)}</div>
                    </div>
                  ))}
                </>
              )}
            </>
          )}
        </div>
      </div>

      {isAdmin && (
        <div className="admin-card" style={{ marginTop: 24 }}>
          <div className="card-title-bar">
            <span className="card-icon">
              <i className="fab fa-stripe-s"></i>
            </span>
            <div>
              <h3>ลิงก์ชำระเงิน Stripe</h3>
              <p>สร้างลิงก์ให้นักเรียนหรือลูกค้าชำระเงินออนไลน์ ระบบบันทึกยอดให้อัตโนมัติเมื่อชำระสำเร็จ</p>
            </div>
          </div>
          <div className="form-body">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div className="form-group">
                <label>
                  <i className="fas fa-baht-sign"></i> จำนวนเงิน (บาท)
                </label>
                <input type="number" placeholder="0.00" min={1} inputMode="decimal" value={linkAmount} onChange={(e) => setLinkAmount(e.target.value)} />
              </div>
              <div className="form-group">
                <label>
                  <i className="fas fa-user"></i> ชื่อลูกค้า (กรณีไม่ใช่นักเรียน)
                </label>
                <input
                  type="text"
                  placeholder="เว้นว่างเพื่อใช้นักเรียนที่เลือกด้านบน"
                  value={linkCustomer}
                  onChange={(e) => setLinkCustomer(e.target.value)}
                />
              </div>
            </div>
            <div className="form-group">
              <label>
                <i className="fas fa-align-left"></i> รายละเอียด (แสดงบนหน้าชำระเงิน)
              </label>
              <input
                type="text"
                placeholder="เช่น ค่าเรียนคอร์ส IELTS Prep เดือนกรกฎาคม"
                value={linkDescription}
                onChange={(e) => setLinkDescription(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>
                <i className="fas fa-tag"></i> รหัสโปรโมชั่น (ถ้ามี)
              </label>
              <select value={linkPromoCode} onChange={(e) => setLinkPromoCode(e.target.value)}>
                <option value="">ไม่ใช้ — ลูกค้าใส่โค้ดเองที่หน้าชำระเงินได้เสมอ</option>
                {promoCodes.map((pc) => (
                  <option value={pc.code} key={pc.code}>
                    {pc.description ? `${pc.code} (${pc.description})` : pc.code}
                  </option>
                ))}
              </select>
              <div className="form-hint">
                รายการนี้ดึงจาก Promotion Code ที่ active ใน Stripe Dashboard (Product catalog → Coupons)
                ระบบจะกรอกโค้ดที่เลือกให้ล่วงหน้า ลูกค้ายังแก้ไขได้
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn btn-primary" onClick={submitLink}>
                <i className="fas fa-link"></i> สร้างลิงก์ชำระเงิน
              </button>
            </div>
            {linkResult && (
              <div className="info-notice" style={{ marginTop: 16 }}>
                <i className="fas fa-check-circle"></i>
                <div style={{ minWidth: 0 }}>
                  <strong>สร้างลิงก์สำเร็จ:</strong>{' '}
                  <a href={linkResult} target="_blank" rel="noopener" style={{ wordBreak: 'break-all' }}>
                    {linkResult}
                  </a>
                  <button
                    className="btn btn-secondary"
                    style={{ marginLeft: 8, padding: '6px 10px' }}
                    onClick={() => navigator.clipboard.writeText(linkResult)}
                  >
                    <i className="fas fa-copy"></i> คัดลอก
                  </button>
                </div>
              </div>
            )}
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>
                <i className="fas fa-list"></i> ลิงก์ล่าสุด
              </label>
              <div className="row-list tight">
                {links === null ? (
                  <div className="form-hint">กำลังโหลดข้อมูล...</div>
                ) : links.length ? (
                  links.map((l) => (
                    <div className="payment-row" key={l.id}>
                      <div className="payment-info">
                        <div className="name">{l.customerName || l.studentId || '-'}</div>
                        <div className="meta">
                          {LINK_STATUS_LABEL[l.status] || l.status} · {formatShortThaiDate((l.createdAt || '').slice(0, 10))} ·{' '}
                          {l.createdBy || ''}
                          {l.promoCode ? ` · โค้ด: ${l.promoCode}` : ''}
                          {l.discountAmount ? ` · ลดราคา ${formatBaht(l.discountAmount)}` : ''}
                        </div>
                      </div>
                      <div className="amount">{formatBaht(l.amount)}</div>
                      <button
                        className="btn btn-secondary"
                        style={{ marginLeft: 8, padding: '6px 10px' }}
                        title="คัดลอกลิงก์"
                        onClick={() => navigator.clipboard.writeText(l.shortUrl || l.url)}
                      >
                        <i className="fas fa-copy"></i>
                      </button>
                      {l.status === 'active' && (
                        <button
                          className="btn btn-secondary"
                          style={{ marginLeft: 8, padding: '6px 10px' }}
                          title="ยกเลิกลิงก์"
                          onClick={() => deactivateLink(l.id)}
                        >
                          <i className="fas fa-ban"></i>
                        </button>
                      )}
                    </div>
                  ))
                ) : (
                  <div className="form-hint">ยังไม่มีลิงก์ชำระเงิน</div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
