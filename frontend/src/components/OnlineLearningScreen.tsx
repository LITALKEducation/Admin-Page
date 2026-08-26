import { useNavigate } from 'react-router-dom';
import CoursesScreen from './CoursesScreen';

export default function OnlineLearningScreen() {
  const navigate = useNavigate();
  return <>
    <div className="online-learning-hub">
      <div className="online-learning-hub-copy">
        <span className="online-learning-eyebrow">Online Learning Studio</span>
        <h1>สร้างและเผยแพร่คอร์สเรียนออนไลน์</h1>
        <p>จัดโครงสร้างการเรียนตั้งแต่ Pre‑Test, บทเรียน, แบบทดสอบระหว่างบท, Post‑Test ไปจนถึง Final พร้อมสื่อการสอนและสิทธิ์ LITALK+ ในเส้นทางเดียว</p>
      </div>
      <button type="button" className="btn btn-primary" onClick={() => navigate('/course-content')}>
        <i className="fas fa-layer-group" /> จัดการคลังบทเรียนและ Assessment
      </button>
      <div className="online-learning-flow" aria-label="องค์ประกอบคอร์สออนไลน์">
        <div><i className="fas fa-clipboard-check" /><strong>Pre‑Test</strong><span>วัดพื้นฐานก่อนเริ่ม</span></div>
        <div><i className="fas fa-circle-play" /><strong>Lesson</strong><span>Markdown · Video · Files</span></div>
        <div><i className="fas fa-list-check" /><strong>Checkpoint</strong><span>แบบทดสอบระหว่างบท</span></div>
        <div><i className="fas fa-graduation-cap" /><strong>Post / Final</strong><span>วัดผลและปลดล็อกตามลำดับ</span></div>
        <div className="is-plus"><i className="fas fa-plus" /><strong>LITALK+</strong><span>Midterm/Final · Slides · Detailed answers</span></div>
      </div>
    </div>
    <CoursesScreen />
  </>;
}
