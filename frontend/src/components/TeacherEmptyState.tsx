import { useAuth0 } from '@auth0/auth0-react';

// Shown to a non-admin teacher who has zero students assigned to them —
// ports the legacy applyRoleGating() teacher-empty-state. With no students
// there's nothing for them to act on, so the whole app is replaced by this
// notice (menus included) until an admin assigns students to the account.
export default function TeacherEmptyState({ identity }: { identity?: string }) {
  const { logout } = useAuth0();

  return (
    <div className="unauthorized-page" style={{ display: 'flex' }}>
      <div className="error-card">
        <div className="error-icon">
          <i className="fas fa-user-clock"></i>
        </div>
        <h2>ยังไม่มีนักเรียนในความดูแลของคุณ</h2>
        <p>
          โปรดติดต่อเจ้าหน้าที่ผู้ดูแลระบบเพื่อกำหนดนักเรียนที่คุณรับผิดชอบ
          จากนั้นเมนูต่าง ๆ จะแสดงขึ้นให้ใช้งาน
        </p>
        {identity && (
          <p className="form-hint" style={{ fontFamily: 'monospace', marginBottom: 20 }}>
            บัญชีของคุณ: {identity}
          </p>
        )}
        <button
          className="btn btn-secondary"
          onClick={() => logout({ logoutParams: { returnTo: `${window.location.origin}/app/` } })}
        >
          <i className="fas fa-sign-out-alt"></i>
          ออกจากระบบ
        </button>
      </div>
    </div>
  );
}
