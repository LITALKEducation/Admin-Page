import { useAuth0 } from '@auth0/auth0-react';

export default function Unauthorized() {
  const { logout } = useAuth0();

  return (
    <div id="unauthorized-section" className="unauthorized-page" style={{ display: 'flex' }}>
      <div className="error-card">
        <div className="error-icon">
          <i className="fas fa-exclamation-triangle"></i>
        </div>
        <h2>เกิดข้อผิดพลาดในการตรวจสอบสิทธิ์</h2>
        <p>บัญชีของคุณไม่ได้รับสิทธิ์ในการเข้าถึงระบบจัดการ กรุณาแจ้งแอดมินหรือออกจากระบบและใช้บัญชีอื่น</p>

        <button
          className="btn btn-danger"
          onClick={() => logout({ logoutParams: { returnTo: `${window.location.origin}/app/` } })}
        >
          <i className="fas fa-sign-out-alt"></i>
          ออกจากระบบ
        </button>
      </div>
    </div>
  );
}
