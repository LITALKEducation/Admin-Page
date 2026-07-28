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

/** The notice closing the panel, when one applies to this person. */
export interface ServiceBlock {
  preset: string;
  titleTh: string;
  titleEn: string;
  bodyTh: string;
  bodyEn: string;
  endsAt: string | null;
}

export interface MeResponse {
  email?: string;
  name?: string;
  title?: string | null;
  phone?: string | null;
  hasAvatar?: boolean;
  permissions: string[];
  /** Always null for an admin — the Admin role is never blocked. */
  serviceBlock?: ServiceBlock | null;
}

// Aggregated "needs attention" feed for the notification bell. Stateless by
// design on the server: every item links to the screen where it gets
// resolved, and resolving it drops it from the feed — no read/unread state.
export interface NotificationItem {
  type: string;
  text: string;
  screen: string;
  studentId: string | null;
}

export async function fetchNotifications(getToken: GetTokenFn) {
  return apiJson<{ items: NotificationItem[] }>(getToken, '/notifications');
}

// Rotating token behind the staff ID card's QR — the server gives it a short
// TTL, so the card re-mints well before expiry (see StaffIdCard).
export async function mintStaffIdCardToken(getToken: GetTokenFn) {
  return apiJson<{ status: string; token: string; expiresAt: string; message?: string }>(
    getToken,
    '/staff/id-card-token',
    { method: 'POST' },
  );
}

// Lets the card holder's own device react the instant the front desk scans
// it, rather than only the scanning device showing feedback.
export async function fetchStaffCheckinStatus(getToken: GetTokenFn, since: string) {
  return apiJson<{ status: string; event: { at: string } | null }>(
    getToken,
    `/staff/checkin-status?since=${encodeURIComponent(since)}`,
  );
}

export function staffAvatarUrl(email: string): string {
  return `${FILES_API_URL}/staff/${encodeURIComponent(email)}/avatar?v=${Date.now()}`;
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

export async function uploadStudentFile(
  getToken: GetTokenFn,
  studentId: string,
  fileType: string,
  file: File,
  signal?: AbortSignal,
) {
  const formData = new FormData();
  formData.append('student_id', studentId);
  formData.append('file_type', fileType);
  formData.append('file', file);
  return apiJson<{ ok: boolean; error?: string }>(getToken, '/upload', { method: 'POST', body: formData, signal });
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
  status: 'active' | 'paid' | 'deactivated' | 'expired';
  createdAt: string;
  createdBy?: string;
  promoCode?: string;
  discountAmount?: number;
  shortUrl?: string;
  url: string;
  expiresAt?: string | null;
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
  refundedAmount?: number;
}

export interface FinanceResponse {
  total: number;
  count: number;
  refunds: { total: number; count: number };
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

// ---------------------------------------------------------------------------
// AI chat settings ("ตั้งค่า AI Chat" screen)
// ---------------------------------------------------------------------------

// Each surface น้องลิลลี่ answers on. They share one settings row server-side
// but are configured independently — see worker/src/aiSettings.ts.
export type AiSurface = 'portal' | 'general' | 'vocab' | 'staff';

export interface AiChatOptions {
  tone?: 'friendly' | 'formal' | 'concise';
  length?: 'short' | 'medium' | 'detailed';
  emoji?: boolean;
  language?: 'auto' | 'th' | 'en';
  unknown?: 'admit' | 'referStaff';
  referContact?: boolean;
  noPricing?: boolean;
}

export interface AiSurfaceSettings {
  enabled: boolean;
  dailyLimit: number;
  options: AiChatOptions;
  instructions: string;
}

export type AiChatSettings = Record<AiSurface, AiSurfaceSettings>;

export async function fetchAiChatSettings(getToken: GetTokenFn) {
  return apiJson<AiChatSettings>(getToken, '/settings/ai-chat');
}

// Partial by design: the settings screen saves the tab you edited, and the
// server read-modify-writes so the untouched surfaces keep their values.
export async function saveAiChatSettings(getToken: GetTokenFn, patch: Partial<AiChatSettings>) {
  return apiJson<AiChatSettings>(getToken, '/settings/ai-chat', {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
}

// One row per conversation for the settings screen's log list — the full
// transcript is fetched separately, only for the one you open.
export interface AiChatLogRow {
  conversationId: string;
  messages: number;
  startedAt: string;
  lastAt: string;
  actor: string | null;
  studentId: string | null;
  firstMessage: string | null;
}

export interface AiChatTranscriptRow {
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export async function fetchAiChatLogs(getToken: GetTokenFn, scope: AiSurface) {
  return apiJson<{ conversations: AiChatLogRow[]; consents: number | null; termsVersion: string }>(
    getToken,
    `/settings/ai-chat/logs?scope=${encodeURIComponent(scope)}`,
  );
}

export async function fetchAiChatTranscript(getToken: GetTokenFn, conversationId: string) {
  return apiJson<{ messages: AiChatTranscriptRow[] }>(
    getToken,
    `/settings/ai-chat/logs/${encodeURIComponent(conversationId)}`,
  );
}

// ---------------------------------------------------------------------------
// Service notices ("ควบคุมการเปิด-ปิดระบบ" screen)
// ---------------------------------------------------------------------------

// The admin panel is deliberately not among these — whoever turns a notice on
// has to stay able to turn it off.
export type ServiceSurface =
  | 'website'
  | 'ask'
  | 'chat_site'
  | 'portal'
  | 'chat_portal'
  | 'checkin'
  | 'booking'
  /** This panel. The Admin role passes through it — see the middleware in worker/src/index.ts. */
  | 'admin';

export type ServicePreset =
  | 'opening_soon'
  | 'trial_opening_soon'
  | 'closing_soon'
  | 'trial_closing_soon'
  | 'custom';

export interface ServiceNotice {
  id: number;
  enabled: boolean;
  preset: ServicePreset;
  surfaces: ServiceSurface[];
  titleTh: string;
  titleEn: string;
  bodyTh: string;
  bodyEn: string;
  /** Heads-up starts showing. Null means "as soon as it is enabled". */
  announceFrom: string | null;
  /** Blocking begins. Null means it only ever announces, never blocks. */
  startsAt: string | null;
  /** Everything stops. Null is open-ended — the screen warns about it. */
  endsAt: string | null;
  dismissible: boolean;
  updatedAt?: string;
  updatedBy?: string | null;
}

export type ServiceNoticeDraft = Omit<ServiceNotice, 'id' | 'updatedAt' | 'updatedBy'>;

export async function fetchServiceNotices(getToken: GetTokenFn) {
  return apiJson<{ notices: ServiceNotice[]; surfaces: ServiceSurface[]; bypassToken: string }>(
    getToken,
    '/settings/service-notices',
  );
}

export async function createServiceNotice(getToken: GetTokenFn, draft: ServiceNoticeDraft) {
  return apiJson<{ id: number }>(getToken, '/settings/service-notices', {
    method: 'POST',
    body: JSON.stringify(draft),
  });
}

export async function updateServiceNotice(getToken: GetTokenFn, id: number, draft: ServiceNoticeDraft) {
  return apiJson<{ status: string }>(getToken, `/settings/service-notices/${id}`, {
    method: 'PUT',
    body: JSON.stringify(draft),
  });
}

export async function deleteServiceNotice(getToken: GetTokenFn, id: number) {
  return apiJson<{ status: string }>(getToken, `/settings/service-notices/${id}`, { method: 'DELETE' });
}

export async function rotateServiceBypassToken(getToken: GetTokenFn) {
  return apiJson<{ bypassToken: string }>(getToken, '/settings/service-notices/rotate-bypass', { method: 'POST' });
}

/** Disables every notice that is blocking right now. Returns how many. */
export async function restoreService(getToken: GetTokenFn) {
  return apiJson<{ restored: number }>(getToken, '/settings/service-notices/restore', { method: 'POST' });
}

/* ===================== Quizzes / online tests ===================== */

export type QuizStatus = 'draft' | 'published' | 'archived';
export type QuestionType = 'single' | 'multiple' | 'truefalse' | 'short';

export interface QuizSummary {
  id: number;
  title: string;
  titleTh: string | null;
  description: string | null;
  descriptionTh: string | null;
  category: string | null;
  status: QuizStatus;
  timeLimitMin: number | null;
  passScore: number;
  allowRetake: number;
  showAnswers: number;
  authorName: string | null;
  reviewedBy: string | null;
  publishedAt: string | null;
  questionCount: number;
  attemptCount: number;
}

export interface QuizQuestion {
  id?: number;
  type: QuestionType;
  prompt: string;
  options: string[];
  // Shape depends on type: single -> number, multiple -> number[],
  // truefalse -> boolean, short -> string[].
  answer: unknown;
  explanation: string | null;
  points: number;
}

export interface QuizPayload {
  title: string;
  titleTh?: string;
  description?: string;
  descriptionTh?: string;
  lesson?: string;
  lessonTh?: string;
  category?: string;
  timeLimitMin?: number | null;
  passScore?: number;
  allowRetake?: boolean;
  showAnswers?: boolean;
  questions?: QuizQuestion[];
}

export interface QuizDetail extends QuizSummary {
  lesson: string | null;
  lessonTh: string | null;
}

export interface QuizAttemptRow {
  id: number;
  studentId: string;
  studentName: string | null;
  studentNickname: string | null;
  score: number;
  maxScore: number;
  passed: number;
  submittedAt: string;
}

export async function fetchQuizzes(getToken: GetTokenFn) {
  return apiJson<{ isAdmin: boolean; quizzes: QuizSummary[] }>(getToken, '/quizzes');
}

export async function fetchQuiz(getToken: GetTokenFn, id: number) {
  return apiJson<{ quiz: QuizDetail; questions: QuizQuestion[] }>(getToken, `/quizzes/${id}`);
}

export async function createQuiz(getToken: GetTokenFn, payload: QuizPayload) {
  return apiJson<{ ok: boolean; id: number; error?: string }>(getToken, '/quizzes', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function updateQuiz(getToken: GetTokenFn, id: number, payload: QuizPayload) {
  return apiJson<{ ok: boolean; error?: string }>(getToken, `/quizzes/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export async function setQuizStatusApi(getToken: GetTokenFn, id: number, status: QuizStatus) {
  return apiJson<{ ok: boolean; error?: string }>(getToken, `/quizzes/${id}/status`, {
    method: 'POST',
    body: JSON.stringify({ status }),
  });
}

export async function deleteQuizApi(getToken: GetTokenFn, id: number) {
  return apiJson<{ ok: boolean; error?: string }>(getToken, `/quizzes/${id}`, { method: 'DELETE' });
}

export async function fetchQuizAttempts(getToken: GetTokenFn, id: number) {
  return apiJson<{ attempts: QuizAttemptRow[] }>(getToken, `/quizzes/${id}/attempts`);
}

/* ===================== Courses (paid, Stripe-gated) ===================== */

export type CourseStatus = 'draft' | 'published' | 'archived';

export interface CourseSummary {
  id: number;
  title: string;
  titleTh: string | null;
  description: string | null;
  descriptionTh: string | null;
  category: string | null;
  priceSatang: number;
  currency: string;
  status: CourseStatus;
  authorName: string | null;
  reviewedBy: string | null;
  publishedAt: string | null;
  itemCount: number;
  enrollCount: number;
}

export interface CourseDetail extends CourseSummary {
  overview: string | null;
  overviewTh: string | null;
}

export interface CourseItem {
  quizId: number;
  title: string;
  titleTh: string | null;
}

export interface CourseAvailableQuiz {
  id: number;
  title: string;
  titleTh: string | null;
  status: string;
  courseId: number | null;
}

export interface CourseEnrollmentRow {
  id: number;
  studentId: string;
  studentName: string | null;
  studentNickname: string | null;
  amount: number;
  status: string;
  enrolledAt: string;
}

export interface CoursePayload {
  title: string;
  titleTh?: string;
  description?: string;
  descriptionTh?: string;
  overview?: string;
  overviewTh?: string;
  category?: string;
  priceSatang?: number;
  currency?: string;
  quizIds?: number[];
}

export async function fetchCourses(getToken: GetTokenFn) {
  return apiJson<{ isAdmin: boolean; courses: CourseSummary[] }>(getToken, '/courses');
}

export async function fetchCourse(getToken: GetTokenFn, id: number) {
  return apiJson<{ course: CourseDetail; items: CourseItem[] }>(getToken, `/courses/${id}`);
}

export async function fetchCourseAvailableQuizzes(getToken: GetTokenFn, id: number) {
  return apiJson<{ quizzes: CourseAvailableQuiz[] }>(getToken, `/courses/${id}/available-quizzes`);
}

export async function createCourse(getToken: GetTokenFn, payload: CoursePayload) {
  return apiJson<{ ok: boolean; id: number; error?: string }>(getToken, '/courses', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function updateCourse(getToken: GetTokenFn, id: number, payload: CoursePayload) {
  return apiJson<{ ok: boolean; error?: string }>(getToken, `/courses/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export async function setCourseStatusApi(getToken: GetTokenFn, id: number, status: CourseStatus) {
  return apiJson<{ ok: boolean; error?: string }>(getToken, `/courses/${id}/status`, {
    method: 'POST',
    body: JSON.stringify({ status }),
  });
}

export async function deleteCourseApi(getToken: GetTokenFn, id: number) {
  return apiJson<{ ok: boolean; error?: string }>(getToken, `/courses/${id}`, { method: 'DELETE' });
}

export async function fetchCourseEnrollments(getToken: GetTokenFn, id: number) {
  return apiJson<{ enrollments: CourseEnrollmentRow[] }>(getToken, `/courses/${id}/enrollments`);
}
