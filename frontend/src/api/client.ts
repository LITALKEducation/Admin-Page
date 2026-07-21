import { FILES_API_AUDIENCE, FILES_API_URL } from '../config';

export type GetTokenFn = () => Promise<string>;

// Mirrors the legacy apiFetch() in index.html: authenticated fetch against
// the Cloudflare Worker (D1-backed) API, JSON in/out.
export async function apiFetch(getAccessTokenSilently: GetTokenFn, path: string, options: RequestInit = {}) {
  const token = await getAccessTokenSilently();
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(FILES_API_URL + path, { ...options, headers });
}

export function makeTokenGetter(getAccessTokenSilently: (opts: object) => Promise<string>): GetTokenFn {
  return () => getAccessTokenSilently({ authorizationParams: { audience: FILES_API_AUDIENCE } });
}

// Generic authenticated JSON call: throws with the server's error message
// (or a bare status code) whenever the response isn't ok.
export async function apiJson<T = unknown>(getToken: GetTokenFn, path: string, options: RequestInit = {}): Promise<T> {
  const response = await apiFetch(getToken, path, options);
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((result as { error?: string })?.error || `HTTP ${response.status}`);
  return result as T;
}

export async function apiFetchBlob(getToken: GetTokenFn, path: string): Promise<Blob> {
  const response = await apiFetch(getToken, path);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.blob();
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export interface MeResponse {
  email?: string;
  name?: string;
  permissions: string[];
}

export interface DashboardStats {
  classes: number;
  booked: number;
  revenue: number;
  revenueLabel: string;
  unpaid: number;
}

export interface DashboardClassRow {
  time: string;
  name: string;
  course?: string;
  studentId: string;
  meetLink?: string;
  done: boolean;
}

export interface DashboardAlert {
  type: string;
  studentId: string;
  text: string;
  actionLabel: string;
  screen?: string;
}

export interface DashboardPaymentRow {
  name: string;
  method?: string;
  dateYMD: string;
  total: number;
  studentId: string | null;
}

export interface DashboardWeekRow {
  date: string;
  time: string;
  name: string;
  course?: string;
  studentId: string;
}

export interface DashboardResponse {
  stats: DashboardStats;
  todayClasses: DashboardClassRow[];
  today: string;
  weekClasses: DashboardWeekRow[];
  weekStart: string;
  weekEnd: string;
  alerts: DashboardAlert[];
  revenueSub?: string;
  recentPayments: DashboardPaymentRow[];
}

export type DashboardRange = 'today' | 'week' | 'month' | 'year';

export async function fetchMe(getToken: GetTokenFn): Promise<MeResponse> {
  const token = await getToken();
  const response = await fetch(`${FILES_API_URL}/me`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function fetchDashboard(getToken: GetTokenFn, range: DashboardRange): Promise<DashboardResponse> {
  const response = await apiFetch(getToken, `/dashboard?range=${encodeURIComponent(range)}`);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

export interface Student {
  id: string;
  name: string;
  nickname?: string;
  email?: string;
  phone?: string;
  course?: string;
}

export async function fetchStudents(getToken: GetTokenFn): Promise<Student[]> {
  const response = await apiFetch(getToken, '/students');
  const result = await response.json();
  if (!response.ok || !Array.isArray(result)) throw new Error(result?.error || `HTTP ${response.status}`);
  return result;
}

export async function deleteStudent(getToken: GetTokenFn, id: string): Promise<{ ok: boolean; error?: string }> {
  const response = await apiFetch(getToken, `/students/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const result = await response.json();
  return { ok: response.ok && result.ok, error: result?.error };
}

export interface StudentEditPayload {
  name: string;
  nickname: string;
  email: string;
  phone: string;
  course: string;
  username?: string;
  password?: string;
}

export async function updateStudent(getToken: GetTokenFn, id: string, payload: StudentEditPayload) {
  return apiJson<{ ok: boolean; message: string; credentials?: { password?: string } }>(
    getToken,
    `/students/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: JSON.stringify(payload) },
  );
}

export interface PaymentDetail {
  id: number;
  amount: number;
  method?: string;
  date: string;
  proof?: string;
  source?: string;
  stripeSessionId?: string;
}

export interface PendingLink {
  amount: number;
  description?: string;
  shortUrl?: string;
  url: string;
}

export interface UpcomingClass {
  date: string;
  time: string;
  notes?: string;
}

export interface ScheduleSession {
  date: string;
  time: string;
}

export interface ScheduleMonth {
  month: string;
  status: string;
  sessionCount: number;
  sessions?: ScheduleSession[];
  total: number;
  createdBy?: string;
  createdByName?: string;
  paymentUrl?: string;
  paymentShortUrl?: string;
}

export interface RecentLog {
  id: number;
  date: string;
  feedback?: string;
  video?: string;
}

export interface StudentCheckResponse {
  student: Student;
  month: string;
  creditBalance?: number;
  payment: {
    paidThisMonth: boolean;
    monthTotal: number;
    last?: PaymentDetail;
    pendingLinks?: PendingLink[];
  };
  upcomingClasses: UpcomingClass[];
  schedules: ScheduleMonth[];
  recentLogs: RecentLog[];
}

export async function fetchStudentCheck(getToken: GetTokenFn, studentId: string) {
  return apiJson<StudentCheckResponse>(getToken, `/student-check/${encodeURIComponent(studentId)}`);
}

export async function updatePayment(getToken: GetTokenFn, paymentId: number, total: number) {
  return apiJson<{ ok: boolean; message: string }>(getToken, `/payments/${paymentId}`, {
    method: 'PATCH',
    body: JSON.stringify({ total }),
  });
}

export interface StudentFile {
  id: number;
  filename: string;
  file_type: string;
  uploaded_by?: string;
  uploaded_at?: string;
}

export async function fetchStudentFiles(getToken: GetTokenFn, studentId: string) {
  return apiJson<StudentFile[]>(getToken, `/students/${encodeURIComponent(studentId)}/files`);
}

export async function uploadStudentFile(getToken: GetTokenFn, studentId: string, fileType: string, file: File) {
  const formData = new FormData();
  formData.append('student_id', studentId);
  formData.append('file_type', fileType);
  formData.append('file', file);
  return apiJson<{ ok: boolean; error?: string }>(getToken, '/upload', { method: 'POST', body: formData });
}

export async function deleteStudentFile(getToken: GetTokenFn, fileId: number) {
  return apiJson<{ ok: boolean; error?: string }>(getToken, `/files/${fileId}`, { method: 'DELETE' });
}

export async function fetchPublicFileLink(getToken: GetTokenFn, fileId: number) {
  return apiJson<{ ok: boolean; url: string }>(getToken, `/files/${fileId}/public-link`, { method: 'POST' });
}

export async function uploadStudentAvatar(getToken: GetTokenFn, studentId: string, file: File) {
  const formData = new FormData();
  formData.append('file', file);
  return apiJson<{ ok: boolean; message: string; error?: string }>(
    getToken,
    `/students/${encodeURIComponent(studentId)}/avatar`,
    { method: 'POST', body: formData },
  );
}

export interface StudyLogPayload {
  studentId: string;
  date: string;
  feedback: string;
  video: string;
}

export async function createStudyLog(getToken: GetTokenFn, payload: StudyLogPayload) {
  return apiJson<{ ok: boolean; message: string; error?: string }>(getToken, '/study-logs', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function updateStudyLog(getToken: GetTokenFn, logId: number, payload: StudyLogPayload) {
  return apiJson<{ ok: boolean; message: string; error?: string }>(getToken, `/study-logs/${logId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export interface PaymentPayload {
  studentId: string;
  method: string;
  total: string;
  date: string;
  proof: string;
}

export async function createPayment(getToken: GetTokenFn, payload: PaymentPayload) {
  return apiJson<{ ok: boolean; message: string; error?: string }>(getToken, '/payments', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export interface EarningsRow {
  email: string;
  count: number;
  total: number;
}

export interface EarningsResponse {
  restricted?: boolean;
  assigned?: { total: number; count: number };
  studentCount?: number;
  mine: { total: number; count: number };
  total?: number;
  count?: number;
  stripeTotal?: number;
  manualTotal?: number;
  pendingLinks?: { total: number; count: number };
  byUser?: EarningsRow[];
}

export async function fetchEarnings(getToken: GetTokenFn) {
  return apiJson<EarningsResponse>(getToken, '/earnings');
}

export interface PromotionCode {
  code: string;
  description?: string;
}

export async function fetchPromotionCodes(getToken: GetTokenFn) {
  return apiJson<PromotionCode[]>(getToken, '/payment-links/promotion-codes');
}

export interface PaymentLink {
  id: number;
  amount: number;
  customerName?: string;
  studentId?: string;
  status: 'active' | 'paid' | 'deactivated';
  createdAt: string;
  createdBy?: string;
  promoCode?: string;
  discountAmount?: number;
  shortUrl?: string;
  url: string;
}

export async function fetchPaymentLinks(getToken: GetTokenFn) {
  return apiJson<PaymentLink[]>(getToken, '/payment-links');
}

export interface CreatePaymentLinkPayload {
  amount: number;
  description: string;
  customerName?: string;
  studentId?: string;
  promoCode?: string;
}

export async function createPaymentLinkApi(getToken: GetTokenFn, payload: CreatePaymentLinkPayload) {
  return apiJson<{ ok: boolean; url: string; shortUrl?: string; error?: string }>(getToken, '/payment-links', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function deactivatePaymentLinkApi(getToken: GetTokenFn, id: number) {
  return apiJson<{ ok: boolean; error?: string }>(getToken, `/payment-links/${id}/deactivate`, { method: 'POST' });
}

export interface CreateStudentPayload {
  name: string;
  nickname: string;
  email: string;
  phone: string;
  course: string;
}

export async function createStudent(getToken: GetTokenFn, payload: CreateStudentPayload) {
  return apiJson<{ ok: boolean; id: string; message: string }>(getToken, '/students', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export interface BookingRow {
  id: number;
  date: string;
  time: string;
  studentId: string;
  studentName: string;
  course?: string;
  meetLink?: string;
  createdBy?: string;
  checkedInAt?: string;
}

export interface CreateBookingPayload {
  studentId: string;
  studentName: string;
  bookingDate: string;
  bookingTime: string;
  notes: string;
}

export async function createBooking(getToken: GetTokenFn, payload: CreateBookingPayload) {
  return apiJson<{ ok: boolean; message: string; error?: string }>(getToken, '/bookings', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function fetchBookings(getToken: GetTokenFn) {
  return apiJson<BookingRow[]>(getToken, '/bookings');
}

export async function updateBookingLink(getToken: GetTokenFn, id: number, meetLink: string) {
  return apiJson<{ ok: boolean; message?: string; error?: string }>(getToken, `/bookings/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ meetLink }),
  });
}

export async function cancelBookingApi(getToken: GetTokenFn, id: number) {
  return apiJson<{ ok: boolean; message?: string; error?: string }>(getToken, `/bookings/${id}`, { method: 'DELETE' });
}

export async function mintCheckinToken(getToken: GetTokenFn, bookingId: number) {
  return apiJson<{ ok: boolean; url: string; expiresAt: string; error?: string }>(
    getToken,
    `/bookings/${bookingId}/checkin-token`,
    { method: 'POST' },
  );
}

export interface ScheduleSessionRow {
  date: string;
  time: string;
}

export type ScheduleStatus = 'pending' | 'approved' | 'active' | 'rejected' | 'cancelled' | 'revise';

export interface ScheduleRow {
  id: number;
  studentId: string;
  studentName: string;
  course?: string;
  month: string;
  rate: number;
  sessionCount: number;
  sessions: ScheduleSessionRow[];
  total: number;
  note?: string;
  status: ScheduleStatus;
  reviseNote?: string;
  rejectReason?: string;
  createdBy?: string;
  createdByName?: string;
  approvedBy?: string;
  creditsApplied?: number;
  paymentUrl?: string;
  paymentShortUrl?: string;
}

export async function fetchSchedules(getToken: GetTokenFn) {
  return apiJson<ScheduleRow[]>(getToken, '/schedules');
}

export interface SchedulePayload {
  studentId: string;
  month: string;
  ratePerSession: number;
  note: string;
  sessions: ScheduleSessionRow[];
}

export async function createSchedule(getToken: GetTokenFn, payload: SchedulePayload) {
  return apiJson<{ ok: boolean; message: string; error?: string }>(getToken, '/schedules', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function updateSchedule(getToken: GetTokenFn, id: number, payload: SchedulePayload) {
  return apiJson<{ ok: boolean; message: string; error?: string }>(getToken, `/schedules/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export async function approveScheduleApi(getToken: GetTokenFn, id: number) {
  return apiJson<{ ok: boolean; message: string; paymentUrl?: string; error?: string }>(getToken, `/schedules/${id}/approve`, {
    method: 'POST',
  });
}

export async function rejectScheduleApi(getToken: GetTokenFn, id: number, reason: string) {
  return apiJson<{ ok: boolean; message: string; error?: string }>(getToken, `/schedules/${id}/reject`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export async function reviseScheduleApi(getToken: GetTokenFn, id: number, note: string) {
  return apiJson<{ ok: boolean; message: string; error?: string }>(getToken, `/schedules/${id}/revise`, {
    method: 'POST',
    body: JSON.stringify({ note }),
  });
}

export async function cancelScheduleApi(getToken: GetTokenFn, id: number) {
  return apiJson<{ ok: boolean; message: string; error?: string }>(getToken, `/schedules/${id}/cancel`, { method: 'POST' });
}

export type AmendmentStatus = 'pending' | 'awaiting_payment' | 'applied' | 'rejected' | 'cancelled';

export interface AmendmentRow {
  id: number;
  studentName: string;
  course?: string;
  month: string;
  type: 'add' | 'remove';
  sessions: ScheduleSessionRow[];
  note?: string;
  status: AmendmentStatus;
  chargeAmount: number;
  creditsUsed?: number;
  rejectReason?: string;
  createdBy?: string;
  createdByName?: string;
  paymentUrl?: string;
  paymentShortUrl?: string;
}

export async function fetchAmendments(getToken: GetTokenFn) {
  return apiJson<AmendmentRow[]>(getToken, '/schedule-amendments');
}

export async function submitAmendmentApi(
  getToken: GetTokenFn,
  scheduleId: number,
  payload: { type: 'add' | 'remove'; sessions: ScheduleSessionRow[]; note: string },
) {
  return apiJson<{ ok: boolean; message: string; paymentUrl?: string; chargeAmount?: number; creditsUsed?: number; error?: string }>(
    getToken,
    `/schedules/${scheduleId}/amend`,
    { method: 'POST', body: JSON.stringify(payload) },
  );
}

export async function approveAmendmentApi(getToken: GetTokenFn, id: number) {
  return apiJson<{ ok: boolean; message: string; paymentUrl?: string; chargeAmount?: number; creditsUsed?: number; error?: string }>(
    getToken,
    `/schedule-amendments/${id}/approve`,
    { method: 'POST' },
  );
}

export async function rejectAmendmentApi(getToken: GetTokenFn, id: number, reason: string) {
  return apiJson<{ ok: boolean; message: string; error?: string }>(getToken, `/schedule-amendments/${id}/reject`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export async function cancelAmendmentApi(getToken: GetTokenFn, id: number) {
  return apiJson<{ ok: boolean; message: string; error?: string }>(getToken, `/schedule-amendments/${id}/cancel`, {
    method: 'POST',
  });
}

export interface FinanceTeacherRow {
  teacher: string;
  teacherName?: string;
  students: number;
  count: number;
  total: number;
}

export interface FinanceRecorderRow {
  identity: string;
  name?: string;
  count: number;
  total: number;
}

export interface FinanceTransaction {
  date: string;
  studentName: string;
  method?: string;
  source: 'manual' | 'stripe';
  recordedBy?: string;
  proof?: string;
  stripeSessionId?: string;
  amount: number;
  discountAmount?: number;
}

export interface FinanceResponse {
  total: number;
  count: number;
  manualTotal: number;
  stripeTotal: number;
  pendingLinks: { total: number; count: number };
  discounts: { total: number; count: number };
  byTeacher: FinanceTeacherRow[];
  byRecorder: FinanceRecorderRow[];
  transactions: FinanceTransaction[];
}

export async function fetchFinance(getToken: GetTokenFn, month: string) {
  return apiJson<FinanceResponse>(getToken, `/finance?month=${encodeURIComponent(month)}`);
}

export interface AnalyticsResponse {
  retention: { rate: number | null; retained: number; lastMonthActive: number };
  months: string[];
  revenue: number[];
  classes: number[];
  activeStudents: number[];
  newStudents: number[];
  courses: { course: string; n: number }[];
}

export async function fetchAnalytics(getToken: GetTokenFn) {
  return apiJson<AnalyticsResponse>(getToken, '/analytics');
}

export type StaffRole = 'admin' | 'teacher' | 'staff';

export interface StaffRow {
  identity: string;
  name?: string;
  role: StaffRole;
  isAdmin?: boolean;
  title?: string;
  phone?: string;
}

export async function fetchStaff(getToken: GetTokenFn) {
  return apiJson<StaffRow[]>(getToken, '/staff');
}

export interface CreateStaffPayload {
  name: string;
  email: string;
  role: StaffRole;
  title: string;
  phone: string;
}

export async function createStaffAccount(getToken: GetTokenFn, payload: CreateStaffPayload) {
  return apiJson<{ ok: boolean; message: string }>(getToken, '/staff', { method: 'POST', body: JSON.stringify(payload) });
}

export async function updateStaff(getToken: GetTokenFn, identity: string, payload: { name: string; title: string; phone: string }) {
  return apiJson<{ ok: boolean; message: string }>(getToken, `/staff/${encodeURIComponent(identity)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export async function uploadStaffAvatarApi(getToken: GetTokenFn, identity: string, file: File) {
  const formData = new FormData();
  formData.append('file', file);
  return apiJson<{ ok: boolean; message: string; error?: string }>(getToken, `/staff/${encodeURIComponent(identity)}/avatar`, {
    method: 'POST',
    body: formData,
  });
}

export async function sendStaffPasswordTicket(getToken: GetTokenFn, identity: string) {
  return apiJson<{ ok: boolean; url: string; error?: string }>(getToken, `/staff/${encodeURIComponent(identity)}/password-ticket`, {
    method: 'POST',
  });
}

export async function sendStaffPasskeyTicket(getToken: GetTokenFn, identity: string) {
  return apiJson<{ ok: boolean; url: string; error?: string }>(getToken, `/staff/${encodeURIComponent(identity)}/passkey-ticket`, {
    method: 'POST',
  });
}

export interface StaffIdentity {
  identity: string;
  name?: string;
  isAdmin?: boolean;
  lastSeen?: string;
}

export async function fetchStaffIdentities(getToken: GetTokenFn) {
  return apiJson<StaffIdentity[]>(getToken, '/staff-identities');
}

export interface TeacherAssignment {
  teacher: string;
  teacherName?: string;
  studentIds: string[];
}

export async function fetchTeacherAssignments(getToken: GetTokenFn) {
  return apiJson<TeacherAssignment[]>(getToken, '/teacher-assignments');
}

export async function saveTeacherAssignments(getToken: GetTokenFn, teacher: string, studentIds: string[]) {
  return apiJson<{ ok: boolean; message: string; error?: string }>(getToken, `/teacher-assignments/${encodeURIComponent(teacher)}`, {
    method: 'PUT',
    body: JSON.stringify({ studentIds }),
  });
}

export interface CreditEntry {
  hours: number;
  reason?: string;
  createdAt: string;
  createdBy?: string;
  createdByName?: string;
}

export async function fetchStudentCredits(getToken: GetTokenFn, studentId: string) {
  return apiJson<{ balance: number; entries: CreditEntry[] }>(getToken, `/students/${encodeURIComponent(studentId)}/credits`);
}

export async function adjustStudentCredit(getToken: GetTokenFn, studentId: string, hours: number, reason: string) {
  return apiJson<{ ok: boolean; message: string; error?: string }>(getToken, `/students/${encodeURIComponent(studentId)}/credits/adjust`, {
    method: 'POST',
    body: JSON.stringify({ hours, reason }),
  });
}

export interface NfcCard {
  uid: string;
  personType: 'student' | 'staff';
  personId: string;
  registeredBy?: string;
  registeredAt: string;
}

export async function fetchNfcCards(getToken: GetTokenFn) {
  return apiJson<NfcCard[]>(getToken, '/nfc-cards');
}

export async function registerNfcCardApi(getToken: GetTokenFn, uid: string, personType: 'student' | 'staff', personId: string) {
  return apiJson<{ ok: boolean; error?: string }>(getToken, '/nfc-cards', {
    method: 'POST',
    body: JSON.stringify({ uid, personType, personId }),
  });
}

export async function deleteNfcCardApi(getToken: GetTokenFn, uid: string) {
  return apiJson<{ ok: boolean; error?: string }>(getToken, `/nfc-cards/${encodeURIComponent(uid)}`, { method: 'DELETE' });
}

export interface CampusCheckin {
  personName: string;
  personId: string;
  personType: 'student' | 'staff';
  checkedInAt?: string;
  checkedInBy?: string;
  checkedOutAt?: string;
  checkedOutBy?: string;
  scanMethod: 'qr' | 'barcode' | 'nfc';
}

export async function fetchCampusCheckins(getToken: GetTokenFn) {
  return apiJson<CampusCheckin[]>(getToken, '/campus-checkins');
}

export type BlogStatus = 'pending' | 'published' | 'rejected';

export interface BlogPost {
  id: number;
  title: string;
  titleTh?: string;
  excerpt?: string;
  excerptTh?: string;
  content: string;
  contentTh?: string;
  category?: string;
  slug: string;
  status: BlogStatus;
  authorIdentity?: string;
  authorName?: string;
  reviewedBy?: string;
  createdAt?: string;
  publishedAt?: string;
  coverKey?: string;
  coverMime?: string;
}

export async function fetchBlogPosts(getToken: GetTokenFn) {
  const result = await apiJson<{ posts: BlogPost[] }>(getToken, '/blog-admin/posts');
  return result.posts || [];
}

export interface BlogPostPayload {
  title: string;
  titleTh: string;
  excerpt: string;
  excerptTh: string;
  content: string;
  contentTh: string;
  category: string;
}

export async function createBlogPost(getToken: GetTokenFn, payload: BlogPostPayload & { publish: boolean }) {
  return apiJson<{ ok: boolean; id: number; error?: string }>(getToken, '/blog-admin/posts', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function updateBlogPost(getToken: GetTokenFn, id: number, payload: BlogPostPayload) {
  return apiJson<{ ok: boolean; error?: string }>(getToken, `/blog-admin/posts/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export async function setBlogPostStatusApi(getToken: GetTokenFn, id: number, status: BlogStatus) {
  return apiJson<{ ok: boolean; error?: string }>(getToken, `/blog-admin/posts/${id}/status`, {
    method: 'POST',
    body: JSON.stringify({ status }),
  });
}

export async function deleteBlogPostApi(getToken: GetTokenFn, id: number) {
  return apiJson<{ ok: boolean; error?: string }>(getToken, `/blog-admin/posts/${id}`, { method: 'DELETE' });
}

export async function uploadBlogImage(getToken: GetTokenFn, file: File) {
  const formData = new FormData();
  formData.append('file', file);
  return apiJson<{ ok: boolean; url: string; error?: string }>(getToken, '/blog-admin/images', {
    method: 'POST',
    body: formData,
  });
}

export async function uploadBlogCover(getToken: GetTokenFn, postId: number, file: File) {
  const formData = new FormData();
  formData.append('file', file);
  return apiJson<{ ok: boolean; error?: string }>(getToken, `/blog-admin/posts/${postId}/cover`, {
    method: 'POST',
    body: formData,
  });
}

export async function fetchBlogCoverBlob(getToken: GetTokenFn, postId: number) {
  return apiFetchBlob(getToken, `/blog-admin/posts/${postId}/cover`);
}

export interface ShortLink {
  id: number;
  domain: 'go' | 'payment';
  url: string;
  targetUrl: string;
  title?: string;
  studentId?: string;
  clickCount?: number;
  createdBy?: string;
  createdAt?: string;
  disabledAt?: string | null;
}

export async function fetchShortLinks(getToken: GetTokenFn) {
  return apiJson<ShortLink[]>(getToken, '/links');
}

export interface CreateShortLinkPayload {
  domain: 'go' | 'payment';
  target: string;
  slug?: string;
  studentId?: string;
  title?: string;
}

export async function createShortLinkApi(getToken: GetTokenFn, payload: CreateShortLinkPayload) {
  return apiJson<{ ok: boolean; url: string; error?: string }>(getToken, '/links', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function disableShortLinkApi(getToken: GetTokenFn, id: number) {
  return apiJson<{ ok: boolean; error?: string }>(getToken, `/links/${id}/disable`, { method: 'POST' });
}

export async function enableShortLinkApi(getToken: GetTokenFn, id: number) {
  return apiJson<{ ok: boolean; error?: string }>(getToken, `/links/${id}/enable`, { method: 'POST' });
}

export async function deleteShortLinkApi(getToken: GetTokenFn, id: number) {
  return apiJson<{ ok: boolean; error?: string }>(getToken, `/links/${id}`, { method: 'DELETE' });
}
