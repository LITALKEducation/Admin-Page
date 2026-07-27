import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import QRCode from 'qrcode';
import {
  makeTokenGetter,
  mintStaffIdCardToken,
  fetchStaffCheckinStatus,
  staffAvatarUrl,
  type MeResponse,
} from '../api/client';
import icon192 from '../assets/img/icon-192.png';

// Re-mint ahead of the server's 2-minute TTL so the code on screen is never
// the expired one when someone finally scans it.
const QR_REFRESH_MS = 100_000;
const CHECKIN_POLL_MS = 1500;

// Short double-beep so the card holder knows they were scanned without
// having to watch the front desk's screen.
function playScannedTone() {
  const AudioCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtor) return;
  const ctx = new AudioCtor();
  let t = ctx.currentTime;
  [880, 1320].forEach((freq) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.28, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.14);
    t += 0.15;
  });
  setTimeout(() => ctx.close().catch(() => {}), 800);
}

// The staff member's own digital ID card: identity plus a rotating QR that
// the front desk scans at scan.html to check them in/out (first scan of the
// day checks in, the next checks out). Ports the legacy
// openStaffIdCardModal — always "my own" card, no lookup of other people.
export default function StaffIdCard({
  me,
  isAdmin,
  onClose,
}: {
  me: MeResponse | null;
  isAdmin: boolean;
  onClose: () => void;
}) {
  const { getAccessTokenSilently } = useAuth0();
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [qrError, setQrError] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const expiresAtRef = useRef(0);

  const refreshQr = useCallback(async () => {
    try {
      const result = await mintStaffIdCardToken(makeTokenGetter(getAccessTokenSilently));
      if (result.status !== 'success' || !result.token) throw new Error(result.message || 'mint failed');
      expiresAtRef.current = Date.parse(result.expiresAt) || Date.now() + 120_000;
      // Render well above the on-screen size: the QR is drawn as flat
      // modules, so at small pixel sizes their edges land on fractional
      // pixels and blur into gray bands that camera decoders struggle to
      // threshold. Large + CSS scale-down keeps the edges crisp.
      setQrDataUrl(await QRCode.toDataURL(result.token, { width: 400, margin: 1, errorCorrectionLevel: 'M' }));
      setQrError(false);
    } catch (error) {
      console.warn('Failed to mint staff ID card QR:', error);
      setQrError(true);
    }
  }, [getAccessTokenSilently]);

  useEffect(() => {
    refreshQr();
    const refreshTimer = setInterval(refreshQr, QR_REFRESH_MS);
    const countdownTimer = setInterval(() => {
      setSecondsLeft(Math.max(0, Math.round((expiresAtRef.current - Date.now()) / 1000)));
    }, 1000);
    return () => {
      clearInterval(refreshTimer);
      clearInterval(countdownTimer);
    };
  }, [refreshQr]);

  // Poll our own check-in feed while the card is open so this device reacts
  // the moment the front desk scans it.
  useEffect(() => {
    let since = new Date().toISOString();
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const result = await fetchStaffCheckinStatus(makeTokenGetter(getAccessTokenSilently), since);
        if (cancelled || result.status !== 'success' || !result.event) return;
        since = result.event.at;
        if (navigator.vibrate) navigator.vibrate(80); // no-op on iOS Safari
        playScannedTone();
      } catch {
        // Transient network hiccups just mean the next poll tries again.
      }
    }, CHECKIN_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [getAccessTokenSilently]);

  const displayName = me?.name || me?.email || '-';
  const initial = String(me?.name || me?.email || '').trim().charAt(0).toUpperCase();

  return (
    <div className="modal-overlay active" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-box idcard-modal-box">
        <div className="idcard-modal-head">
          <h3>
            <i className="fas fa-id-card"></i> บัตรประจำตัวดิจิทัล
          </h3>
          <button type="button" className="idcard-modal-close" onClick={onClose} aria-label="ปิด">
            <i className="fas fa-times"></i>
          </button>
        </div>
        <div className="idcard-modal-body">
          <div className="idcard">
            <div className="idcard-top">
              <img src={icon192} className="idcard-logo" alt="" />
              <span className="idcard-brand">LITALK Education</span>
            </div>
            <div className="idcard-main">
              <div className="idcard-photo">
                {me?.hasAvatar && me.email ? (
                  <img src={staffAvatarUrl(me.email)} alt="รูปโปรไฟล์" />
                ) : (
                  <div className="idcard-photo-fallback" aria-hidden="true">
                    {initial}
                  </div>
                )}
              </div>
              <div className="idcard-info">
                <span className="idcard-role">{isAdmin ? 'ADMIN' : 'TEACHER'}</span>
                <h4 className="idcard-name">{displayName}</h4>
                <span className="idcard-title">{me?.title || ''}</span>
                {me?.email && (
                  <div className="idcard-field">
                    <span className="idcard-field-label">อีเมล/บัญชี</span>
                    <span className="idcard-field-value">{me.email}</span>
                  </div>
                )}
              </div>
            </div>
            <div className="idcard-qr-wrap">
              <div className="idcard-qr-label">
                <i className="fas fa-qrcode"></i> QR เช็คชื่อเข้า-ออก
              </div>
              <div className="idcard-qr">
                {qrError ? (
                  <div className="idcard-qr-fallback idcard-qr-error">
                    <i className="fas fa-triangle-exclamation"></i> ออก QR ไม่สำเร็จ
                    <br />
                    ลองปิดแล้วเปิดบัตรใหม่
                  </div>
                ) : qrDataUrl ? (
                  <img src={qrDataUrl} alt="QR เช็คชื่อ" style={{ width: '100%', height: '100%' }} />
                ) : null}
              </div>
              <span className="idcard-qr-countdown">
                {qrError
                  ? 'ออก QR ไม่สำเร็จ'
                  : secondsLeft === null
                    ? 'กำลังออก QR...'
                    : `รีเฟรชอัตโนมัติใน ${secondsLeft} วิ`}
              </span>
              <span className="idcard-qr-hint">
                ให้เจ้าหน้าที่อีกคนสแกนที่จุดเช็คชื่อ — สแกนครั้งแรกเช็คชื่อเข้า ครั้งถัดไปเช็คชื่อออก
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
