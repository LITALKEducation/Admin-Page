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
