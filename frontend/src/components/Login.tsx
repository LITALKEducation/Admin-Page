import { useAuth0 } from '@auth0/auth0-react';
import { useLocation } from 'react-router-dom';
import logo from '../assets/img/LITALK-Black.png';

export default function Login() {
  const { loginWithRedirect } = useAuth0();
  const location = useLocation();

  return (
    <div id="login-section" className="login-page" style={{ display: 'flex' }}>
      <div className="login-wrapper">
        <div className="login-brand-side">
          <div className="brand-content">
            <div className="brand-logo-container">
              <img src={logo} alt="LITALK Logo" className="logo-img" />
            </div>
            <div className="brand-tagline">
              <h2>LITALK Control</h2>
              <p>ระบบแผงควบคุมหลังบ้าน สำหรับแอดมินผู้ดูแลระบบการเรียนการสอนและจัดการค่าเรียน</p>
            </div>
            <ul className="brand-features">
              <li>
                <i className="fas fa-check-circle"></i> <span>บันทึกผลการเรียนนักเรียนและแชร์วิดีโอ</span>
              </li>
              <li>
                <i className="fas fa-check-circle"></i> <span>บันทึกประวัติการชำระเงินและหลักฐานสลิป</span>
              </li>
              <li>
                <i className="fas fa-check-circle"></i>
                <span>เพิ่มนักเรียนใหม่พร้อมระบบสร้างบัญชีอัตโนมัติ</span>
              </li>
            </ul>
          </div>
        </div>

        <div className="login-form-side">
          <div className="login-form-container">
            <div className="mobile-logo">
              <img src={logo} alt="LITALK Logo" className="logo-img" />
            </div>
            <h1 className="login-title">เข้าสู่ระบบแอดมิน</h1>
            <p className="login-subtitle">แผงควบคุมสำหรับจัดการข้อมูลการศึกษา LITALK Education</p>

            <div className="login-card">
              <div className="login-desc-box">
                <i className="fas fa-info-circle"></i>
                <span>เฉพาะผู้ที่มีบัญชีเจ้าหน้าที่ผู้ดูแลระบบเท่านั้นที่ได้รับสิทธิ์การเข้าถึงข้อมูลนี้</span>
              </div>

              <button
                className="btn btn-primary"
                style={{ width: '100%', marginBottom: 12 }}
                onClick={() =>
                  loginWithRedirect({
                    appState: { returnTo: location.pathname + location.search },
                  })
                }
              >
                <i className="fas fa-sign-in-alt"></i>
                เข้าสู่ระบบเจ้าหน้าที่
              </button>

              <a href="https://litalkeducation.com" className="btn btn-secondary" style={{ width: '100%' }}>
                <i className="fas fa-arrow-left"></i>
                กลับไปหน้านักเรียน
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
