import { useAuth0 } from '@auth0/auth0-react';
import type { ServiceBlock } from '../api/client';

const PRESET_TITLE: Record<string, string> = {
  opening_soon: 'ยังไม่เปิดให้ใช้งาน',
  trial_opening_soon: 'กำลังจะเปิดให้ทดลองใช้งาน',
  closing_soon: 'ปิดปรับปรุงระบบชั่วคราว',
  trial_closing_soon: 'ช่วงทดลองใช้งานสิ้นสุดแล้ว',
  custom: 'ปิดปรับปรุงระบบชั่วคราว',
};

function formatWhen(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString('th-TH', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

// Shown instead of the whole panel when an admin has closed the 'admin'
// surface. Only non-admins ever get here: the API never reports a block to an
// admin, so the person who closed the panel can still open it again.
//
// This is presentation. The API refuses the same requests independently, so a
// stale tab or a hand-rolled client gets nothing either way.
export default function ServiceClosed({ block, isStaff }: { block: ServiceBlock; isStaff?: string }) {
  const { logout } = useAuth0();
  const back = formatWhen(block.endsAt);

  return (
    <div className="unauthorized-page" style={{ display: 'flex' }}>
      <div className="error-card">
        <div className="error-icon">
          <i className="fas fa-circle-pause"></i>
        </div>
        <h2>{block.titleTh || PRESET_TITLE[block.preset] || PRESET_TITLE.custom}</h2>
        <p>
          {block.bodyTh ||
            'ขณะนี้ระบบแอดมินปิดให้บริการชั่วคราวเพื่อปรับปรุง กรุณาลองใหม่อีกครั้งภายหลัง'}
        </p>
        {back && (
          <p className="form-hint" style={{ marginBottom: 20 }}>
            <i className="fas fa-clock"></i> คาดว่าจะกลับมาใช้งานได้ {back}
          </p>
        )}
        {!back && (
          <p className="form-hint" style={{ marginBottom: 20 }}>
            ยังไม่ได้กำหนดเวลากลับมาใช้งาน — สอบถามผู้ดูแลระบบได้
          </p>
        )}
        {isStaff && (
          <p className="form-hint" style={{ fontFamily: 'monospace', marginBottom: 20 }}>
            บัญชีของคุณ: {isStaff}
          </p>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            <i className="fas fa-rotate"></i>
            ลองอีกครั้ง
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => logout({ logoutParams: { returnTo: `${window.location.origin}/app/` } })}
          >
            <i className="fas fa-sign-out-alt"></i>
            ออกจากระบบ
          </button>
        </div>
      </div>
    </div>
  );
}
