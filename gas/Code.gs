// =================================================================
// การตั้งค่าระบบ LITALK Education (ระบบ Username + Calendar + Google Meet)
// =================================================================
const SHEET_ID = '1wAM2cquRrsszu5cuxeRfIz3wYce-aFNn0CTPT0JH3E8';
const AUTH0_DOMAIN = 'litalkeducation.us.auth0.com';
const AUTH0_M2M_CLIENT_ID = 'F4lQlSTEt649AhP1U8XuLulWLX0wtxok';
const AUTH0_M2M_CLIENT_SECRET = '6koRwaaMXP_BVCdruDtD2m4UVSCpJR38sZ57udUzIizyXGJ_IhoaFK3imOz-zRgm';
const AUTH0_CONNECTION_NAME = 'LITALK-Student';
const CALENDAR_ID = '7575ba4eb2683d383effa9266bbe39b769ee7a70fc42bf129e44886fb53e8e4b@group.calendar.google.com'; // ⚠️ อย่าลืมใส่รหัสปฏิทินของคุณ
// =================================================================

function doGet(e) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const infoSheet = ss.getSheetByName('LITALK Education - LITALK Education - Info') || ss.getSheetByName('LITALK Education - Info') || ss.getSheetByName('Info');

  if (e.parameter.action === 'getAllStudents') {
    const infoData = infoSheet ? infoSheet.getDataRange().getDisplayValues() : [];
    let students = [];
    for (let i = 1; i < infoData.length; i++) {
      if (infoData[i][1]) {
        students.push({ name: infoData[i][0], id: infoData[i][1] });
      }
    }
    return ContentService.createTextOutput(JSON.stringify({ status: "success", data: students }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  if (e.parameter.action === 'getDashboard') {
    const data = buildDashboardData(ss, e.parameter.range || 'today');
    return ContentService.createTextOutput(JSON.stringify({ status: "success", data: data }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const studentId = e.parameter.studentId;
  if (!studentId) {
    return ContentService.createTextOutput(JSON.stringify({status: "error", message: "ไม่พบรหัสนักเรียนในการร้องขอ"}))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const paymentSheet = ss.getSheetByName('LITALK Education - LITALK Education - Payment Info') || ss.getSheetByName('Payment Info');
  const studyLogSheet = ss.getSheetByName('LITALK Education - LITALK Education - Study Log') || ss.getSheetByName('Study Log');

  const infoData = infoSheet ? infoSheet.getDataRange().getDisplayValues() : [];
  const paymentData = paymentSheet ? paymentSheet.getDataRange().getDisplayValues() : [];
  const studyLogData = studyLogSheet ? studyLogSheet.getDataRange().getDisplayValues() : [];

  let studentInfo = null;
  for (let i = 1; i < infoData.length; i++) {
    if (infoData[i][1].trim() === studentId.trim()) {
      studentInfo = {
        name: infoData[i][0],
        studentId: infoData[i][1],
        course: infoData[i][2],
        lastPaid: infoData[i][3],
        // Columns E/F/G are additive (appended after the original A-D info
        // columns) so older rows without them simply read as blank.
        nickname: infoData[i][4] || '',
        phone: infoData[i][5] || '',
        contactEmail: infoData[i][6] || ''
      };
      break;
    }
  }

  if (!studentInfo) {
    return ContentService.createTextOutput(JSON.stringify({status: "not_found", message: "ไม่พบข้อมูลนักเรียน"}))
      .setMimeType(ContentService.MimeType.JSON);
  }

  let payments = [], studyLogs = [];
  for (let i = 1; i < paymentData.length; i++) {
    if (paymentData[i][1].trim() === studentId.trim()) {
      payments.push({
        timestamp: paymentData[i][0],
        method: paymentData[i][2],
        proof: paymentData[i][3],
        total: paymentData[i][4],
        // Column F: the class-was-paid-for date entered in the admin form,
        // distinct from the submission timestamp in column A.
        paymentDate: paymentData[i][5] || ''
      });
    }
  }
  for (let i = 1; i < studyLogData.length; i++) {
    if (studyLogData[i][1].trim() === studentId.trim()) {
      studyLogs.push({
        timestamp: studyLogData[i][0],
        feedback: studyLogData[i][2],
        video: studyLogData[i][3],
        // Column E: the class date entered in the admin form, distinct from
        // the submission timestamp in column A.
        classDate: studyLogData[i][4] || ''
      });
    }
  }

  return ContentService.createTextOutput(JSON.stringify({
    status: "success",
    data: { info: studentInfo, payments: payments, studyLogs: studyLogs }
  })).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  const ss = SpreadsheetApp.openById(SHEET_ID);

  if (typeof e !== 'undefined' && e.postData === undefined) {
    return ContentService.createTextOutput(JSON.stringify({ status: "success" })).setMimeType(ContentService.MimeType.JSON);
  }

  try {
    const postData = JSON.parse(e.postData.contents);
    const action = postData.action;
    const adminEmail = postData.adminEmail;

    if (!adminEmail) {
      return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "คุณยังไม่ได้เข้าสู่ระบบ (Unauthorized)" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const timestamp = Utilities.formatDate(new Date(), "GMT+7", "dd/MM/yyyy HH:mm:ss");

    if (action === "createStudent") {
      const infoSheet = ss.getSheetByName('LITALK Education - LITALK Education - Info') || ss.getSheetByName('Info');
      const { name, course, nickname, phone, email } = postData.payload;

      const randomId = generateRandomId();
      const loginEmail = `${randomId}@litalkeducation.com`;
      const tempPassword = `Ltk@${Math.floor(10000 + Math.random() * 90000)}!`;

      createAuth0User(loginEmail, tempPassword, name, randomId, { nickname: nickname || '', phone: phone || '', contactEmail: email || '' });
      // Columns E/F/G (nickname/phone/contact email) are additive -- appended
      // after the original A-D columns so existing rows/formulas are unaffected.
      infoSheet.appendRow([name, randomId, course, "-", nickname || '', phone || '', email || '']);

      return ContentService.createTextOutput(JSON.stringify({
        status: "success",
        message: `✅ สร้างบัญชีสำเร็จ!\n\nรหัสนักเรียน (Username): ${randomId}\nอีเมลเข้าใช้งาน: ${loginEmail}\nรหัสผ่านชั่วคราว: ${tempPassword}\n\n*โปรดคัดลอกข้อมูลส่งให้นักเรียน`
      })).setMimeType(ContentService.MimeType.JSON);

    } else if (action === "addStudyLog") {
      const studyLogSheet = ss.getSheetByName('LITALK Education - LITALK Education - Study Log') || ss.getSheetByName('Study Log');
      const { studentId, feedback, video, date } = postData.payload;
      // Column E (class date) is additive -- appended after the original
      // A-D columns so existing rows/formulas are unaffected.
      studyLogSheet.appendRow([timestamp, studentId, feedback, video, date || '']);

    } else if (action === "addPayment") {
      const paymentSheet = ss.getSheetByName('LITALK Education - LITALK Education - Payment Info') || ss.getSheetByName('Payment Info');
      const infoSheet = ss.getSheetByName('LITALK Education - LITALK Education - Info') || ss.getSheetByName('Info');

      const { studentId, method, proof, total, date } = postData.payload;
      // Column F (payment date) is additive -- appended after the original
      // A-E columns so existing rows/formulas are unaffected.
      paymentSheet.appendRow([timestamp, studentId, method, proof, total, date || '']);

      const infoData = infoSheet.getDataRange().getDisplayValues();
      for (let i = 1; i < infoData.length; i++) {
        if (infoData[i][1].trim() === studentId.trim()) {
          infoSheet.getRange(i + 1, 4).setValue(timestamp);
          break;
        }
      }

    // 🌟 ระบบจองคิวเรียนออนไลน์ พร้อมออกลิงก์ Google Meet อัตโนมัติ
    } else if (action === "createBooking") {
      const { studentId, studentName, bookingDate, bookingTime, notes } = postData.payload;

      if (!studentId || !bookingDate || !bookingTime) {
        return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "ข้อมูลไม่ครบถ้วน" })).setMimeType(ContentService.MimeType.JSON);
      }

      // คำนวณเวลาเริ่มต้น-สิ้นสุด (รอบละ 1 ชั่วโมง)
      const timeParts = bookingTime.split(":");
      const startHour = parseInt(timeParts[0], 10);
      const startMinute = parseInt(timeParts[1], 10);

      const startTime = new Date(bookingDate);
      startTime.setHours(startHour, startMinute, 0, 0);

      const endTime = new Date(startTime.getTime() + (60 * 60 * 1000));

      // ตรวจสอบคิวว่างเพื่อป้องกันการจองเวลาซ้อนกัน
      const checkCalendar = CalendarApp.getCalendarById(CALENDAR_ID);
      if (!checkCalendar) {
        return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "ไม่พบปฏิทินที่กำหนดในระบบ กรุณาตรวจสอบ CALENDAR_ID" })).setMimeType(ContentService.MimeType.JSON);
      }
      const conflicts = checkCalendar.getEvents(startTime, endTime);
      if (conflicts.length > 0) {
        return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "❌ ช่วงเวลานี้มีคิวจองแล้ว กรุณาเลือกเวลาใหม่" })).setMimeType(ContentService.MimeType.JSON);
      }

      // 🚀 ตั้งค่า Payload สร้างกิจกรรมผ่าน Advanced Calendar Service เพื่อเปิดใช้งาน Google Meet
      const eventTitle = `[LITALK] เรียนกับ ${studentName} (${studentId})`;
      const eventDescription = `รายละเอียดเพิ่มเติม: ${notes || '-'}\nบันทึกเมื่อ: ${timestamp}`;

      const calendarEventResource = {
        summary: eventTitle,
        description: eventDescription,
        start: { dateTime: startTime.toISOString() },
        end: { dateTime: endTime.toISOString() },
        conferenceData: {
          createRequest: {
            requestId: "meet_" + new Date().getTime() + "_" + Math.floor(Math.random() * 1000),
            conferenceSolutionKey: { type: "hangoutsMeet" }
          }
        }
      };

      // ยิงคำสั่งสร้าง Event และห้อง Meet ไปยัง Google Calendar API
      const createdEvent = Calendar.Events.insert(calendarEventResource, CALENDAR_ID, { conferenceDataVersion: 1 });
      const meetLink = createdEvent.hangoutLink || "ไม่สามารถเจนลิงก์ Meet ได้";

      // บันทึกรายละเอียดทั้งหมดและลิงก์ห้องประชุมลง Google Sheets
      const bookingSheet = ss.getSheetByName('LITALK Education - Booking') || ss.getSheetByName('Booking');
      if (bookingSheet) {
        bookingSheet.appendRow([timestamp, studentId, studentName, `${bookingDate} ${bookingTime}`, notes, meetLink]);
      }

      // ส่งข้อมูลสรุปทั้งหมด พร้อมแนบตัวแปร meetLink กลับไปให้หน้าบ้านใช้งานต่อ
      return ContentService.createTextOutput(JSON.stringify({
        status: "success",
        message: `🎉 จองคิวเรียนสำเร็จ!\n\nวันที่เรียน: ${bookingDate}\nเวลาเรียน: ${bookingTime} - ${startHour+1}:${startMinute === 0 ? '00' : startMinute} น.\n\n🔗 ลิงก์เข้าห้องเรียน Google Meet:\n${meetLink}`,
        data: {
          studentId: studentId,
          studentName: studentName,
          date: bookingDate,
          time: bookingTime,
          meetLink: meetLink,
          timestamp: timestamp
        }
      })).setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService.createTextOutput(JSON.stringify({ status: "success", message: "บันทึกข้อมูลสำเร็จ" }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: error.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// =================================================================
// Dashboard aggregation (action=getDashboard&range=today|week|month)
//
// Reads Info / Payment Info / Study Log / Booking directly -- there's no
// separate "classes taught" record, so a booking IS a class. Business
// rules baked in here (documented so they're easy to tune):
//   - "คลาสเรียน" (classes)   = bookings whose class date falls in range.
//   - "การจองล่วงหน้า" (booked) = of those, the ones still in the future.
//   - "รายรับ" (revenue)      = sum of payments whose date falls in range.
//   - "ค้างชำระ" (unpaid)     = active students (booked within the last/next
//     45 days) whose last payment is missing or >30 days old. Independent
//     of the range selector, same as the original design mock.
//   - "คลาสวันนี้" (today's classes) and "การแจ้งเตือน" (alerts) are always
//     "today" / "recent", regardless of the range selector.
//   - Missing-log alerts look back 3 days for bookings with no matching
//     study log (by studentId + class date).
// =================================================================

function buildDashboardData(ss, range) {
  const infoSheet = ss.getSheetByName('LITALK Education - LITALK Education - Info') || ss.getSheetByName('LITALK Education - Info') || ss.getSheetByName('Info');
  const paymentSheet = ss.getSheetByName('LITALK Education - LITALK Education - Payment Info') || ss.getSheetByName('Payment Info');
  const studyLogSheet = ss.getSheetByName('LITALK Education - LITALK Education - Study Log') || ss.getSheetByName('Study Log');
  const bookingSheet = ss.getSheetByName('LITALK Education - Booking') || ss.getSheetByName('Booking');

  const infoData = infoSheet ? infoSheet.getDataRange().getValues() : [];
  const paymentData = paymentSheet ? paymentSheet.getDataRange().getValues() : [];
  const studyLogData = studyLogSheet ? studyLogSheet.getDataRange().getValues() : [];
  const bookingData = bookingSheet ? bookingSheet.getDataRange().getValues() : [];

  const studentsById = {};
  for (let i = 1; i < infoData.length; i++) {
    const id = String(infoData[i][1] || '').trim();
    if (!id) continue;
    studentsById[id] = { name: infoData[i][0], course: infoData[i][2], lastPaidRaw: infoData[i][3] };
  }

  const today = todayYMD();
  const nowHM = Utilities.formatDate(new Date(), 'GMT+7', 'HH:mm');
  const dowM0 = dayOfWeekMonday0(today.y, today.m, today.d);
  const weekStartD = addDays(today.y, today.m, today.d, -dowM0);
  const weekEndD = addDays(today.y, today.m, today.d, 6 - dowM0);
  const lastDayOfMonth = new Date(today.y, today.m, 0).getDate();
  const periods = {
    today: { start: today.str, end: today.str, label: 'วันนี้' },
    week: { start: ymd(weekStartD.y, weekStartD.m, weekStartD.d), end: ymd(weekEndD.y, weekEndD.m, weekEndD.d), label: 'สัปดาห์นี้' },
    month: { start: ymd(today.y, today.m, 1), end: ymd(today.y, today.m, lastDayOfMonth), label: 'เดือนนี้' }
  };
  const period = periods[range] || periods.today;

  // ----- Bookings within the selected range -----
  let classesCount = 0;
  let bookedCount = 0;
  const bookingsByDate = {}; // ymd -> [{studentId, studentName, time}]
  for (let i = 1; i < bookingData.length; i++) {
    const row = bookingData[i];
    const dateYMD = cellToYMD(row[3]);
    if (!dateYMD) continue;
    const timeHM = cellToHM(row[3]);
    (bookingsByDate[dateYMD] = bookingsByDate[dateYMD] || []).push({
      studentId: String(row[1] || '').trim(),
      studentName: row[2],
      time: timeHM
    });
    if (dateYMD >= period.start && dateYMD <= period.end) {
      classesCount++;
      if (dateYMD > today.str || (dateYMD === today.str && timeHM >= nowHM)) bookedCount++;
    }
  }

  // ----- Study logs: studentId+classDate -> true, for "done" lookups -----
  const logKeySet = {};
  for (let i = 1; i < studyLogData.length; i++) {
    const row = studyLogData[i];
    const sid = String(row[1] || '').trim();
    if (!sid) continue;
    const classDateYMD = cellToYMD(row[4]) || cellToYMD(row[0]);
    if (classDateYMD) logKeySet[sid + '|' + classDateYMD] = true;
  }

  // ----- Revenue within range + recent payments feed (always latest, any range) -----
  let revenueTotal = 0;
  let revenueCount = 0;
  const recentPayments = [];
  for (let i = 1; i < paymentData.length; i++) {
    const row = paymentData[i];
    const sid = String(row[1] || '').trim();
    if (!sid) continue;
    const total = parseFloat(String(row[4]).replace(/[^0-9.\-]/g, '')) || 0;
    const dateYMD = cellToYMD(row[5]) || cellToYMD(row[0]);
    const student = studentsById[sid];
    recentPayments.push({ studentId: sid, name: student ? student.name : sid, method: row[2], total: total, dateYMD: dateYMD || '' });
    if (dateYMD && dateYMD >= period.start && dateYMD <= period.end) {
      revenueTotal += total;
      revenueCount++;
    }
  }
  recentPayments.reverse(); // sheet rows are append-ordered oldest -> newest
  const recentPaymentsTop = recentPayments.slice(0, 5);

  // ----- Today's classes -----
  const todayClasses = (bookingsByDate[today.str] || []).map(b => ({
    time: b.time,
    studentId: b.studentId,
    name: b.studentName || (studentsById[b.studentId] ? studentsById[b.studentId].name : b.studentId),
    course: studentsById[b.studentId] ? studentsById[b.studentId].course : '',
    done: !!logKeySet[b.studentId + '|' + today.str]
  })).sort((a, b) => a.time.localeCompare(b.time));

  // ----- Alerts: unpaid (active students only) + missing logs (last 3 days) -----
  const alerts = [];

  const activePast = addDays(today.y, today.m, today.d, -45);
  const activeFuture = addDays(today.y, today.m, today.d, 45);
  const activePastStr = ymd(activePast.y, activePast.m, activePast.d);
  const activeFutureStr = ymd(activeFuture.y, activeFuture.m, activeFuture.d);
  const activeStudentIds = {};
  Object.keys(bookingsByDate).forEach(dateYMD => {
    if (dateYMD >= activePastStr && dateYMD <= activeFutureStr) {
      bookingsByDate[dateYMD].forEach(b => { activeStudentIds[b.studentId] = true; });
    }
  });

  const unpaidCutoff = addDays(today.y, today.m, today.d, -30);
  const unpaidCutoffStr = ymd(unpaidCutoff.y, unpaidCutoff.m, unpaidCutoff.d);
  let unpaidCount = 0;
  Object.keys(studentsById).forEach(id => {
    if (!activeStudentIds[id]) return;
    const lastPaidYMD = cellToYMD(studentsById[id].lastPaidRaw);
    if (lastPaidYMD && lastPaidYMD >= unpaidCutoffStr) return;
    unpaidCount++;
    if (alerts.length < 6) {
      alerts.push({
        type: 'unpaid',
        studentId: id,
        text: (studentsById[id].name || id) + (lastPaidYMD ? ' ค้างชำระค่าเรียน (ชำระล่าสุด ' + lastPaidYMD + ')' : ' ค้างชำระค่าเรียน (ยังไม่เคยชำระ)'),
        actionLabel: 'บันทึกการชำระเงิน',
        screen: 'payments'
      });
    }
  });

  for (let d = 1; d <= 3 && alerts.length < 9; d++) {
    const dd = addDays(today.y, today.m, today.d, -d);
    const ddStr = ymd(dd.y, dd.m, dd.d);
    (bookingsByDate[ddStr] || []).forEach(b => {
      if (alerts.length >= 9) return;
      if (logKeySet[b.studentId + '|' + ddStr]) return;
      alerts.push({
        type: 'missing_log',
        studentId: b.studentId,
        text: 'คลาสของ ' + (b.studentName || b.studentId) + ' เมื่อวันที่ ' + ddStr + ' ยังไม่มีบันทึกการเรียน',
        actionLabel: 'บันทึกการเรียน',
        screen: 'logs'
      });
    });
  }

  return {
    range: range,
    stats: {
      classes: classesCount,
      booked: bookedCount,
      revenue: revenueTotal,
      revenueLabel: 'จาก ' + revenueCount + ' รายการ' + period.label,
      unpaid: unpaidCount
    },
    revenueSub: 'รวม ฿' + revenueTotal.toLocaleString('en-US'),
    todayClasses: todayClasses,
    alerts: alerts,
    recentPayments: recentPaymentsTop
  };
}

// ----- Date helpers (all in GMT+7, compared as yyyy-MM-dd strings to avoid
// server-timezone drift when doing calendar math) -----

function todayYMD() {
  const s = Utilities.formatDate(new Date(), 'GMT+7', 'yyyy-MM-dd');
  const parts = s.split('-').map(Number);
  return { y: parts[0], m: parts[1], d: parts[2], str: s };
}

function ymd(y, m, d) {
  return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

function addDays(y, m, d, delta) {
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  return { y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate() };
}

function dayOfWeekMonday0(y, m, d) {
  const dow = new Date(y, m - 1, d).getDay(); // 0=Sun..6=Sat
  return (dow + 6) % 7; // 0=Mon..6=Sun
}

// Accepts either a real Date (Sheets may auto-convert date-shaped text) or a
// string in "dd/MM/yyyy ..." (timestamp columns) / "yyyy-MM-dd ..." (booking
// date column) format. Returns "yyyy-MM-dd" or null.
function cellToYMD(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, 'GMT+7', 'yyyy-MM-dd');
  }
  const s = String(value || '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return m[3] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[1]).padStart(2, '0');
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
  return null;
}

// Same input shapes as cellToYMD; returns "HH:mm" or ''.
function cellToHM(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, 'GMT+7', 'HH:mm');
  }
  const s = String(value || '').trim();
  const m = s.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*$/);
  return m ? String(m[1]).padStart(2, '0') + ':' + m[2] : '';
}

function generateRandomId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 6; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result;
}

function createAuth0User(email, password, name, username, extra) {
  const tokenUrl = `https://${AUTH0_DOMAIN}/oauth/token`;
  const tokenPayload = {
    client_id: AUTH0_M2M_CLIENT_ID,
    client_secret: AUTH0_M2M_CLIENT_SECRET,
    audience: `https://${AUTH0_DOMAIN}/api/v2/`,
    grant_type: 'client_credentials'
  };

  const tokenRes = UrlFetchApp.fetch(tokenUrl, { method: 'post', contentType: 'application/json', payload: JSON.stringify(tokenPayload) });
  const tokenData = JSON.parse(tokenRes.getContentText());

  const userUrl = `https://${AUTH0_DOMAIN}/api/v2/users`;
  const userPayload = {
    "email": email,
    "username": username,
    "password": password,
    "connection": AUTH0_CONNECTION_NAME,
    "name": name,
    "email_verified": true,
    // Optional extras collected by the "Create Student" form -- stored on
    // the Auth0 profile as metadata, not used for login.
    "user_metadata": {
      "nickname": (extra && extra.nickname) || '',
      "phone": (extra && extra.phone) || '',
      "contact_email": (extra && extra.contactEmail) || ''
    }
  };

  const userRes = UrlFetchApp.fetch(userUrl, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + tokenData.access_token },
    payload: JSON.stringify(userPayload),
    muteHttpExceptions: true
  });

  const responseText = userRes.getContentText();
  console.log("Auth0 API Response: " + responseText);

  if (userRes.getResponseCode() >= 400) {
    throw new Error("Auth0 Response Error: " + responseText);
  }
}
