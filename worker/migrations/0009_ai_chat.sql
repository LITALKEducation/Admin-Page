-- AI chat assistant: conversation history + audit trail. Serves two
-- surfaces sharing one table: the public student portal (students and
-- parents alike — the portal has no separate parent identity, see
-- worker/README.md) and the authenticated admin panel (teachers/admins).
CREATE TABLE ai_chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  scope TEXT NOT NULL,              -- 'portal' | 'staff'
  student_id TEXT,                  -- portal: the student the chat is about; staff: student in context, if any
  actor TEXT,                       -- staff: staff email; portal: NULL (shared portal link, no individual identity)
  role TEXT NOT NULL,               -- 'user' | 'assistant'
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_ai_chat_conversation ON ai_chat_messages(conversation_id, id);
CREATE INDEX idx_ai_chat_student_created ON ai_chat_messages(student_id, created_at);
CREATE INDEX idx_ai_chat_actor_created ON ai_chat_messages(actor, created_at);
