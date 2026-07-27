import { useCallback, useEffect, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import {
  makeTokenGetter,
  fetchAiChatLogs,
  fetchAiChatTranscript,
  type AiChatLogRow,
  type AiChatTranscriptRow,
  type AiSurface,
} from '../api/client';

// Read-only view of what people actually asked น้องลิลลี่ on one surface.
// Every turn has always been written to ai_chat_messages; this is the first
// thing that surfaces it, so admins can see what visitors ask, spot answers
// the assistant got wrong, and follow up on real enquiries.
//
// The list is loaded on first expand rather than with the settings above it:
// most visits to this screen are to change a setting, not to read logs.
export default function AiChatLogs({ surface }: { surface: AiSurface }) {
  const { getAccessTokenSilently } = useAuth0();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<AiChatLogRow[] | null>(null);
  const [consents, setConsents] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<AiChatTranscriptRow[] | null>(null);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const result = await fetchAiChatLogs(makeTokenGetter(getAccessTokenSilently), surface);
      setRows(result.conversations);
      setConsents(result.consents);
    } catch (error) {
      console.error('fetchAiChatLogs:', error);
      setFailed(true);
    }
  }, [getAccessTokenSilently, surface]);

  // Switching tabs must drop the previous surface's rows, or the list shows
  // the old conversations until the new fetch lands.
  useEffect(() => {
    setRows(null);
    setOpenId(null);
    setTranscript(null);
    if (open) load();
  }, [surface, open, load]);

  const openTranscript = async (conversationId: string) => {
    if (openId === conversationId) {
      setOpenId(null);
      return;
    }
    setOpenId(conversationId);
    setTranscript(null);
    try {
      const result = await fetchAiChatTranscript(makeTokenGetter(getAccessTokenSilently), conversationId);
      setTranscript(result.messages);
    } catch (error) {
      console.error('fetchAiChatTranscript:', error);
      setTranscript([]);
    }
  };

  return (
    <div className="admin-card">
      <button
        type="button"
        className="ai-advanced-toggle card-title-bar"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className="card-icon">
          <i className="fas fa-clock-rotate-left"></i>
        </span>
        <div>
          <h3>บันทึกการสนทนา</h3>
          <p>ดูคำถามที่ผู้ใช้ถามเข้ามาจริงในช่องทางนี้ (อ่านอย่างเดียว)</p>
        </div>
        <i className="fas fa-chevron-down ai-advanced-chevron"></i>
      </button>

      {open && (
        <div style={{ marginTop: 16 }}>
          {consents !== null && (
            <div className="ai-status-strip" style={{ marginBottom: 14 }}>
              <span className="ai-status-pill">
                <i className="fas fa-file-signature"></i>
                ยอมรับเงื่อนไขแล้ว {consents} คน
              </span>
              <span className="ai-status-pill">
                <i className="fas fa-comments"></i>
                {rows?.length ?? 0} บทสนทนาล่าสุด
              </span>
              {/* Stated here because "the conversation I wanted is missing"
                  otherwise looks like a bug rather than the published policy. */}
              <span className="ai-status-pill">
                <i className="fas fa-clock-rotate-left"></i>
                เก็บย้อนหลัง 6 เดือน
              </span>
            </div>
          )}

          {failed ? (
            <div className="form-hint">
              โหลดบันทึกการสนทนาไม่สำเร็จ —{' '}
              <button className="btn btn-secondary" style={{ marginLeft: 8 }} onClick={load}>
                ลองใหม่
              </button>
            </div>
          ) : rows === null ? (
            <div className="skeleton skeleton-line" style={{ width: '70%' }}></div>
          ) : !rows.length ? (
            <div className="empty-state">
              <i className="fas fa-comment-slash"></i>
              <div className="empty-title">ยังไม่มีการสนทนาในช่องทางนี้</div>
              <div className="empty-sub">บทสนทนาจะปรากฏที่นี่เมื่อมีผู้ใช้เริ่มคุยกับน้องลิลลี่</div>
            </div>
          ) : (
            <div className="row-list">
              {rows.map((row) => (
                <div className="alert-row" style={{ alignItems: 'flex-start' }} key={row.conversationId}>
                  <i className="fas fa-comment-dots" style={{ marginTop: 3, color: 'var(--text-muted)' }}></i>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="alert-text">{row.firstMessage || '(ไม่มีข้อความจากผู้ใช้)'}</div>
                    <div className="alert-text" style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                      {row.messages} ข้อความ · เริ่ม {String(row.startedAt || '').slice(0, 16)}
                      {row.actor ? ` · ${row.actor}` : ''}
                      {row.studentId ? ` · ${row.studentId}` : ''}
                    </div>
                    <button
                      className="btn btn-secondary"
                      style={{ padding: '6px 10px', marginTop: 8 }}
                      onClick={() => openTranscript(row.conversationId)}
                    >
                      <i className={`fas ${openId === row.conversationId ? 'fa-chevron-up' : 'fa-eye'}`}></i>{' '}
                      {openId === row.conversationId ? 'ซ่อนบทสนทนา' : 'ดูบทสนทนา'}
                    </button>

                    {openId === row.conversationId && (
                      <div style={{ marginTop: 10 }}>
                        {transcript === null ? (
                          <div className="skeleton skeleton-line" style={{ width: '60%' }}></div>
                        ) : (
                          transcript.map((message, i) => (
                            <div key={i} style={{ marginBottom: 8 }}>
                              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>
                                {message.role === 'user' ? 'ผู้ใช้' : 'น้องลิลลี่'} ·{' '}
                                {String(message.createdAt || '').slice(0, 16)}
                              </div>
                              <div style={{ fontSize: 13, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>
                                {message.content}
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
