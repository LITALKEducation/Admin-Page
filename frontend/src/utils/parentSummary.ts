export interface SummarySession {
  date: string;
  time: string;
}

function formatThaiMonthYearShort(ym: string): string {
  const d = new Date(ym + '-01T00:00:00');
  if (isNaN(d.getTime())) return ym || '';
  return `${d.toLocaleDateString('th-TH', { month: 'long' })} ${String(d.getFullYear() + 543).slice(-2)}`;
}

// Sessions are one hour each (BOOKING_SLOTS are hourly), so the end time is
// always start + 1 hour.
function addOneHour(hm: string): string {
  const [h, m] = String(hm || '0:0').split(':').map(Number);
  return `${String((h + 1) % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Builds the LINE-ready message an admin forwards to a parent once a
// payment link exists: subject, session dates/times, hours, the amount
// charged, and the link itself.
export function buildParentSummaryMessage({
  studentName,
  month,
  course,
  note,
  sessions,
  amount,
  creditsApplied,
  paymentUrl,
  isExtra,
}: {
  studentName: string;
  month: string;
  course?: string;
  note?: string;
  sessions: SummarySession[];
  amount: number;
  creditsApplied?: number;
  paymentUrl?: string;
  isExtra: boolean;
}): string {
  const monthLabel = formatThaiMonthYearShort(month);
  const lines: string[] = [];
  lines.push(`สวัสดีครับคุณแม่ ขออนุญาตแจ้งรายละเอียด${isExtra ? 'การเรียนเพิ่มเติม' : 'การเรียนการสอน'}ของน้อง${studentName}ครับ เดือน ${monthLabel}`);
  lines.push('');
  if (course) lines.push(`📚เรียนวิชา${course}`);
  if (note) lines.push(`เนื้อหาการสอน: ${note}`);
  if (course || note) lines.push('');

  const sorted = [...(sessions || [])].sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  const byTime = new Map<string, number[]>();
  sorted.forEach((s) => {
    if (!byTime.has(s.time)) byTime.set(s.time, []);
    byTime.get(s.time)!.push(Number(s.date.slice(8, 10)));
  });
  const hourNote = `(1 ชั่วโมง/ครั้ง รวม ${sorted.length} ชั่วโมง)`;
  if (byTime.size === 1) {
    const [time, days] = [...byTime.entries()][0];
    lines.push(`📍เวลาเรียน: วันที่ ${days.join(', ')}`);
    lines.push(`เวลา ${time} น. - ${addOneHour(time)} น. ${hourNote}`);
  } else if (byTime.size > 1) {
    lines.push('📍เวลาเรียน:');
    byTime.forEach((days, time) => lines.push(`วันที่ ${days.join(', ')} เวลา ${time} น. - ${addOneHour(time)} น.`));
    lines.push(hourNote);
  }
  lines.push('ช่องทางการเรียน: เรียนผ่าน Google Meet');
  lines.push('');
  lines.push(`🧾ค่าใช้จ่ายในการเรียน${isExtra ? 'เพิ่มเติม' : ''}ครั้งนี้ ${Number(amount || 0).toLocaleString('en-US')} บาทครับ`);
  if (creditsApplied && creditsApplied > 0) lines.push(`(หักเครดิตคงเหลือ ${creditsApplied} ชั่วโมงให้แล้ว)`);
  if (paymentUrl) {
    lines.push('');
    lines.push('ร้าน ลิททอล์ก เอดดูเคชัน');
    lines.push('ขอแจ้งยอดที่คุณต้องชำระ');
    lines.push(`จำนวนเงิน ${Number(amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} บาท`);
    lines.push('');
    lines.push('กรุณาชำระเงินผ่านลิงก์นี้');
    lines.push(paymentUrl);
    lines.push('');
    lines.push('คุณแม่สามารถชำระเงินได้ไม่เกิน 24 ชั่วโมง หลังจากได้รับลิงก์ครับ');
  }
  lines.push('ขอบคุณครับคุณแม่🙏🏻💖');
  return lines.join('\n');
}
