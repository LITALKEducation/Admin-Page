import { useState } from 'react';
import { marked } from 'marked';

// Shared write/preview textarea (Markdown feedback on logs, blog body, etc).
export default function MarkdownField({
  value,
  onChange,
  rows = 5,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  placeholder?: string;
}) {
  const [tab, setTab] = useState<'write' | 'preview'>('write');

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <div className="tab-menu-mini">
          <button
            type="button"
            className={`tab-btn-mini${tab === 'write' ? ' active' : ''}`}
            onClick={() => setTab('write')}
          >
            เขียน
          </button>
          <button
            type="button"
            className={`tab-btn-mini${tab === 'preview' ? ' active' : ''}`}
            onClick={() => setTab('preview')}
          >
            ดูตัวอย่าง
          </button>
        </div>
      </div>
      {tab === 'write' ? (
        <textarea rows={rows} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <div
          className="markdown-preview timeline-feedback"
          dangerouslySetInnerHTML={{ __html: marked.parse(value || '', { async: false }) as string }}
        />
      )}
    </div>
  );
}
