import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { useMe } from '../hooks/useMe';
import { useToast } from '../ui/ToastContext';
import { useConfirm } from '../ui/ConfirmContext';
import {
  makeTokenGetter,
  fetchBlogPosts,
  createBlogPost,
  updateBlogPost,
  setBlogPostStatusApi,
  deleteBlogPostApi,
  uploadBlogImage,
  uploadBlogCover,
  fetchBlogCoverBlob,
  type BlogPost,
  type BlogStatus,
} from '../api/client';

const BLOG_STATUS_LABEL: Record<string, string> = {
  pending: 'รออนุมัติ',
  published: 'เผยแพร่แล้ว',
  rejected: 'ไม่ผ่านการอนุมัติ',
};

const MAX_COVER_VIDEO_SECONDS = 15;
const LAST_STEP = 4;

function blogPostUrl(slug: string): string {
  return 'https://litalkeducation.com/blog-post?slug=' + encodeURIComponent(slug);
}

function shortBlogPostUrl(slug: string): string {
  return 'https://go.litalkeducation.com/' + encodeURIComponent(slug);
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function readVideoDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(video.duration);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    video.src = url;
  });
}

const EMPTY_FORM = { titleEn: '', titleTh: '', excerptEn: '', excerptTh: '', contentEn: '', contentTh: '', category: '' };

export default function BlogScreen() {
  const { getAccessTokenSilently } = useAuth0();
  const { isAdmin, me } = useMe();
  const showToast = useToast();
  const confirmDialog = useConfirm();

  const [posts, setPosts] = useState<BlogPost[] | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [step, setStep] = useState(1);
  const [maxReached, setMaxReached] = useState(1);
  const [form, setForm] = useState(EMPTY_FORM);
  const [publishNow, setPublishNow] = useState(false);
  const [saving, setSaving] = useState(false);

  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [coverObjectUrl, setCoverObjectUrl] = useState<string | null>(null);
  const [coverStatus, setCoverStatus] = useState('');
  const [existingCoverUrl, setExistingCoverUrl] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const coverInputRef = useRef<HTMLInputElement>(null);
  const contentThRef = useRef<HTMLTextAreaElement>(null);
  const contentEnRef = useRef<HTMLTextAreaElement>(null);
  const imageThInputRef = useRef<HTMLInputElement>(null);
  const imageEnInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      setPosts(await fetchBlogPosts(getToken));
    } catch (error) {
      console.error('loadBlogPosts:', error);
      setPosts(null);
    }
  }, [getAccessTokenSilently]);

  useEffect(() => {
    load();
  }, [load]);

  const editingPost = editingId ? posts?.find((p) => p.id === editingId) || null : null;

  const openEditor = (id: number | null) => {
    const post = id ? posts?.find((p) => p.id === id) || null : null;
    setEditingId(id);
    setForm({
      titleEn: post?.title || '',
      titleTh: post?.titleTh || '',
      excerptEn: post?.excerpt || '',
      excerptTh: post?.excerptTh || '',
      contentEn: post?.content || '',
      contentTh: post?.contentTh || '',
      category: post?.category || '',
    });
    setPublishNow(false);
    setCoverFile(null);
    if (coverObjectUrl) URL.revokeObjectURL(coverObjectUrl);
    setCoverObjectUrl(null);
    setExistingCoverUrl(null);
    setMaxReached(1);
    setStep(1);
    setEditorOpen(true);

    if (post?.coverKey && id) {
      (async () => {
        try {
          const getToken = makeTokenGetter(getAccessTokenSilently);
          const blob = await fetchBlogCoverBlob(getToken, id);
          setExistingCoverUrl(URL.createObjectURL(blob));
        } catch (error) {
          console.warn('loadExistingBlogCoverPreview:', error);
        }
      })();
    }
    document.getElementById('screen-blog')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const closeEditor = () => {
    setEditorOpen(false);
    setEditingId(null);
    if (coverObjectUrl) URL.revokeObjectURL(coverObjectUrl);
    setCoverObjectUrl(null);
    if (existingCoverUrl) URL.revokeObjectURL(existingCoverUrl);
    setExistingCoverUrl(null);
  };

  const validateStep = (s: number): string | null => {
    if (s === 2 && !form.contentEn.trim() && !form.contentTh.trim()) {
      return 'กรุณากรอกเนื้อหาบทความอย่างน้อย 1 ภาษา (ไทยหรืออังกฤษ)';
    }
    if (s === 3 && !form.titleEn.trim() && !form.titleTh.trim()) {
      return 'กรุณากรอกหัวข้อบทความอย่างน้อย 1 ภาษา (ไทยหรืออังกฤษ)';
    }
    return null;
  };

  const goNext = () => {
    const err = validateStep(step);
    if (err) {
      showToast('ข้อมูลไม่ครบ', err, 'error');
      return;
    }
    const next = Math.min(step + 1, LAST_STEP);
    setMaxReached((m) => Math.max(m, next));
    setStep(next);
  };

  const goBack = () => setStep((s) => Math.max(1, s - 1));
  const goToStep = (s: number) => {
    if (s > maxReached) return;
    setStep(s);
  };

  const handleCoverFile = async (file: File | null) => {
    if (coverObjectUrl) URL.revokeObjectURL(coverObjectUrl);
    setCoverObjectUrl(null);
    setCoverFile(file);
    if (!file) return;

    const isVideo = file.type.startsWith('video/');
    if (isVideo) {
      setCoverStatus('กำลังตรวจสอบวิดีโอ...');
      const duration = await readVideoDuration(file);
      if (duration === null) {
        setCoverFile(null);
        if (coverInputRef.current) coverInputRef.current.value = '';
        showToast('ไฟล์วิดีโอไม่ถูกต้อง', 'ไม่สามารถอ่านไฟล์วิดีโอนี้ได้ กรุณาลองไฟล์อื่น', 'error');
        return;
      }
      if (duration > MAX_COVER_VIDEO_SECONDS + 0.5) {
        setCoverFile(null);
        if (coverInputRef.current) coverInputRef.current.value = '';
        showToast('วิดีโอยาวเกินไป', `วิดีโอปกต้องไม่เกิน ${MAX_COVER_VIDEO_SECONDS} วินาที (ไฟล์นี้ยาว ${duration.toFixed(1)} วินาที)`, 'error');
        return;
      }
    }
    setCoverObjectUrl(URL.createObjectURL(file));
    setCoverStatus('พร้อมอัปโหลด');
  };

  const clearCover = () => {
    if (coverInputRef.current) coverInputRef.current.value = '';
    if (coverObjectUrl) URL.revokeObjectURL(coverObjectUrl);
    setCoverObjectUrl(null);
    setCoverFile(null);
  };

  const insertImage = async (which: 'th' | 'en', file: File | null) => {
    if (!file) return;
    const textarea = which === 'th' ? contentThRef.current : contentEnRef.current;
    const field = which === 'th' ? 'contentTh' : 'contentEn';
    const placeholder = '![กำลังอัปโหลด...]()';
    const start = textarea?.selectionStart ?? form[field].length;
    const end = textarea?.selectionEnd ?? form[field].length;
    const withPlaceholder = form[field].slice(0, start) + placeholder + form[field].slice(end);
    setForm((f) => ({ ...f, [field]: withPlaceholder }));
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      const result = await uploadBlogImage(getToken, file);
      const markdown = `![${file.name.replace(/\.[^.]+$/, '')}](${result.url})`;
      setForm((f) => ({ ...f, [field]: f[field].replace(placeholder, markdown) }));
    } catch (error) {
      setForm((f) => ({ ...f, [field]: f[field].replace(placeholder, '') }));
      showToast('แทรกรูปภาพไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง', 'error');
    }
  };

  const save = async () => {
    const payload = {
      title: form.titleEn.trim() || form.titleTh.trim(),
      titleTh: form.titleTh.trim(),
      excerpt: form.excerptEn.trim(),
      excerptTh: form.excerptTh.trim(),
      content: form.contentEn.trim() ? form.contentEn : form.contentTh,
      contentTh: form.contentTh,
      category: form.category.trim(),
    };
    if (!payload.title) {
      showToast('ข้อมูลไม่ครบ', 'กรุณากรอกหัวข้อบทความอย่างน้อย 1 ภาษา', 'error');
      return;
    }
    if (!payload.content.trim()) {
      showToast('ข้อมูลไม่ครบ', 'กรุณากรอกเนื้อหาบทความอย่างน้อย 1 ภาษา', 'error');
      return;
    }
    setSaving(true);
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      let postId = editingId;
      if (editingId) {
        await updateBlogPost(getToken, editingId, payload);
        if (isAdmin && publishNow) await setBlogPostStatusApi(getToken, editingId, 'published');
      } else {
        const result = await createBlogPost(getToken, { ...payload, publish: isAdmin && publishNow });
        postId = result.id;
      }
      if (coverFile && postId) {
        try {
          await uploadBlogCover(getToken, postId, coverFile);
        } catch (error) {
          showToast('อัปโหลดรูปหน้าปกไม่สำเร็จ', error instanceof Error ? error.message : 'บทความถูกบันทึกแล้ว แต่รูปหน้าปกอัปโหลดไม่สำเร็จ', 'error');
        }
      }
      closeEditor();
      await load();
      showToast(
        'บันทึกบทความแล้ว',
        publishNow ? 'บทความเผยแพร่บนเว็บไซต์แล้ว' : isAdmin ? 'บทความถูกบันทึกในสถานะรออนุมัติ' : 'ส่งบทความแล้ว — จะแสดงบนเว็บไซต์หลังแอดมินอนุมัติ',
        'success',
      );
    } catch (error) {
      showToast('บันทึกบทความไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง', 'error');
    }
    setSaving(false);
  };

  const setStatus = async (id: number, status: BlogStatus) => {
    const labels: Record<string, string> = {
      published: 'เผยแพร่บทความนี้บนเว็บไซต์?',
      rejected: 'ไม่อนุมัติบทความนี้?',
      pending: 'เลิกเผยแพร่บทความนี้ (กลับเป็นรออนุมัติ)?',
    };
    if (!(await confirmDialog(labels[status] || 'ยืนยันการทำรายการ?', { danger: status === 'rejected' }))) return;
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      await setBlogPostStatusApi(getToken, id, status);
      await load();
      showToast('อัปเดตสถานะแล้ว', BLOG_STATUS_LABEL[status] || status, 'success');
    } catch (error) {
      showToast('ทำรายการไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  const removePost = async (id: number) => {
    if (!(await confirmDialog('ลบบทความนี้ถาวร? การลบไม่สามารถย้อนกลับได้', { danger: true, okLabel: 'ลบบทความ' }))) return;
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      await deleteBlogPostApi(getToken, id);
      if (editingId === id) closeEditor();
      await load();
      showToast('ลบบทความแล้ว', undefined, 'success');
    } catch (error) {
      showToast('ลบบทความไม่สำเร็จ', error instanceof Error ? error.message : 'เกิดข้อผิดพลาด', 'error');
    }
  };

  // Step 4 preview: an iframe loading the REAL litalkeducation.com
  // stylesheet/fonts/markdown pipeline, so this looks like what a reader
  // will actually see once published — not an admin-styled approximation.
  const previewSrcDoc = useMemo(() => {
    if (step !== LAST_STEP) return '';
    const coverUrl = coverFile && coverObjectUrl ? coverObjectUrl : existingCoverUrl;
    const coverIsVideo = coverFile ? coverFile.type.startsWith('video/') : !!editingPost?.coverMime?.startsWith('video/');
    const data = {
      title: form.titleEn || form.titleTh,
      titleTh: form.titleTh || form.titleEn,
      excerpt: form.excerptEn || form.excerptTh,
      excerptTh: form.excerptTh || form.excerptEn,
      content: form.contentEn || form.contentTh,
      contentTh: form.contentTh || form.contentEn,
      category: form.category,
      authorName: me?.name || me?.email || '',
      publishedAt: new Date().toISOString(),
      coverUrl,
      coverIsVideo,
    };
    const json = JSON.stringify(data).replace(/</g, '\\u003c');
    const CLOSE_SCRIPT = '</' + 'script>';
    return [
      '<!doctype html>',
      '<html lang="en" data-lang="en">',
      '<head>',
      '<meta charset="utf-8">',
      '<link rel="stylesheet" href="https://litalkeducation.com/css/fonts.css">',
      '<link rel="stylesheet" href="https://litalkeducation.com/css/style.css">',
      '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">',
      '</head>',
      '<body>',
      '<article aria-labelledby="pv-title">',
      '<section class="post-hero" style="padding-top:32px;">',
      '<div class="container">',
      '<span class="post-hero__category" id="pv-category" hidden></span>',
      '<h1 class="post-hero__title" id="pv-title"></h1>',
      '<p class="post-hero__excerpt" id="pv-excerpt" hidden></p>',
      '<div class="post-hero__meta">',
      '<span id="pv-author"></span>',
      '<span class="dot" id="pv-dot" hidden>&bull;</span>',
      '<span id="pv-date"></span>',
      '</div></div></section>',
      '<div class="container">',
      '<div class="post-cover" id="pv-cover" hidden></div>',
      '<div class="post-content" id="pv-content"></div>',
      '</div></article>',
      '<script src="https://cdn.jsdelivr.net/npm/marked@12.0.0/marked.min.js" defer>' + CLOSE_SCRIPT,
      '<script src="https://litalkeducation.com/js/blog.js" defer>' + CLOSE_SCRIPT,
      '<script defer>',
      'document.addEventListener("DOMContentLoaded", function () {',
      '  var data = ' + json + ';',
      '  function pick(en, th) { return th || en || ""; }',
      '  document.title = (data.titleTh || data.title || "Preview");',
      '  document.getElementById("pv-title").textContent = pick(data.title, data.titleTh);',
      '  if (data.category) { var c = document.getElementById("pv-category"); c.hidden = false; c.textContent = data.category; }',
      '  var excerpt = pick(data.excerpt, data.excerptTh);',
      '  if (excerpt) { var e = document.getElementById("pv-excerpt"); e.hidden = false; e.textContent = excerpt; }',
      '  document.getElementById("pv-author").textContent = data.authorName || "";',
      '  if (data.authorName) document.getElementById("pv-dot").hidden = false;',
      '  document.getElementById("pv-date").textContent = new Date(data.publishedAt).toLocaleDateString("th-TH", { year: "numeric", month: "long", day: "numeric" });',
      '  if (data.coverUrl) {',
      '    var cover = document.getElementById("pv-cover");',
      '    cover.hidden = false;',
      '    cover.innerHTML = data.coverIsVideo',
      '      ? \'<video src="\' + data.coverUrl + \'" autoplay muted loop playsinline disablepictureinpicture></video>\'',
      '      : \'<img src="\' + data.coverUrl + \'" alt="">\';',
      '  }',
      '  var md = pick(data.content, data.contentTh);',
      '  document.getElementById("pv-content").innerHTML = (window.LitalkBlog ? window.LitalkBlog.mdToHtml(md) : md);',
      '});',
      CLOSE_SCRIPT,
      '</body>',
      '</html>',
    ].join('\n');
  }, [step, form, coverFile, coverObjectUrl, existingCoverUrl, editingPost, me]);

  const STEPS = [
    { n: 1, label: 'เนื้อหาไทย' },
    { n: 2, label: 'เนื้อหาอังกฤษ' },
    { n: 3, label: 'ข้อมูล & ปก' },
    { n: 4, label: 'ตัวอย่าง' },
  ];

  const coverCardVisible = !!coverFile || !!existingCoverUrl;

  return (
    <div id="screen-blog" className="tab-content active">
      <div className="screen-header">
        <h1>บทความเว็บไซต์</h1>
        <p>เขียนและจัดการบทความที่แสดงบนหน้า Blog ของเว็บไซต์ litalkeducation.com — บทความของครูจะแสดงบนเว็บไซต์หลังจากแอดมินหรือเจ้าหน้าที่อนุมัติแล้ว</p>
      </div>

      <div className="admin-card" style={{ marginBottom: 20 }}>
        <div className="card-title-bar">
          <span className="card-icon">
            <i className="fas fa-pen-nib"></i>
          </span>
          <div>
            <h3>{editingId ? 'แก้ไขบทความ' : 'เขียนบทความใหม่'}</h3>
            <p>เขียนทีละขั้นตอน แล้วดูตัวอย่างหน้าจริงก่อนบันทึก</p>
          </div>
        </div>

        {editorOpen ? (
          <div className="form-body">
            <div className="blog-wizard-steps">
              {STEPS.map((s, i) => (
                <div key={s.n} style={{ display: 'contents' }}>
                  <button
                    type="button"
                    className={`blog-wizard-step${step === s.n ? ' active' : ''}${step > s.n ? ' done' : ''}`}
                    disabled={s.n > maxReached}
                    onClick={() => goToStep(s.n)}
                  >
                    <span className="blog-wizard-step__num">
                      <i className="fas fa-check" style={{ display: step > s.n ? '' : 'none' }}></i>
                      <span className="blog-wizard-step__digit" style={{ display: step > s.n ? 'none' : '' }}>
                        {s.n}
                      </span>
                    </span>
                    <span className="blog-wizard-step__label">{s.label}</span>
                  </button>
                  {i < STEPS.length - 1 && <div className="blog-wizard-step__line"></div>}
                </div>
              ))}
            </div>

            {step === 1 && (
              <div className="blog-wizard-panel active">
                <div className="form-group">
                  <label>
                    <i className="fab fa-markdown"></i> เนื้อหาบทความ (ภาษาไทย · Markdown)
                  </label>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      style={{ padding: '5px 10px', fontSize: 12.5 }}
                      onClick={() => imageThInputRef.current?.click()}
                    >
                      <i className="fas fa-image"></i> แทรกรูปภาพ
                    </button>
                    <input
                      type="file"
                      accept="image/*"
                      ref={imageThInputRef}
                      style={{ display: 'none' }}
                      onChange={(e) => {
                        insertImage('th', e.target.files?.[0] || null);
                        e.target.value = '';
                      }}
                    />
                  </div>
                  <textarea
                    ref={contentThRef}
                    rows={14}
                    placeholder={'# หัวข้อ\n\nเขียนบทความด้วย Markdown...'}
                    style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13 }}
                    value={form.contentTh}
                    onChange={(e) => setForm({ ...form, contentTh: e.target.value })}
                  />
                  <div className="form-hint">
                    ใส่เฉพาะภาษาเดียวก็ได้ (ไทยหรืออังกฤษ) · แนบลิงก์ด้วย <code>[ข้อความ](https://example.com)</code> · ตัวหนา{' '}
                    <code>**ข้อความ**</code> · หัวข้อ <code># หัวข้อ</code>
                  </div>
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="blog-wizard-panel active">
                <div className="form-group">
                  <label>
                    <i className="fab fa-markdown"></i> เนื้อหาบทความ (English · Markdown)
                  </label>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      style={{ padding: '5px 10px', fontSize: 12.5 }}
                      onClick={() => imageEnInputRef.current?.click()}
                    >
                      <i className="fas fa-image"></i> แทรกรูปภาพ
                    </button>
                    <input
                      type="file"
                      accept="image/*"
                      ref={imageEnInputRef}
                      style={{ display: 'none' }}
                      onChange={(e) => {
                        insertImage('en', e.target.files?.[0] || null);
                        e.target.value = '';
                      }}
                    />
                  </div>
                  <textarea
                    ref={contentEnRef}
                    rows={14}
                    placeholder={'# Heading\n\nWrite your article in Markdown...'}
                    style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13 }}
                    value={form.contentEn}
                    onChange={(e) => setForm({ ...form, contentEn: e.target.value })}
                  />
                  <div className="form-hint">ใส่เฉพาะภาษาเดียวก็ได้ (ไทยหรืออังกฤษ)</div>
                </div>
              </div>
            )}

            {step === 3 && (
              <div className="blog-wizard-panel active">
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                  <div className="form-group">
                    <label>
                      <i className="fas fa-heading"></i> หัวข้อ (ไทย)
                    </label>
                    <input
                      type="text"
                      placeholder="เช่น 10 กลยุทธ์คำศัพท์ที่ได้ผลจริง"
                      maxLength={300}
                      value={form.titleTh}
                      onChange={(e) => setForm({ ...form, titleTh: e.target.value })}
                    />
                  </div>
                  <div className="form-group">
                    <label>
                      <i className="fas fa-heading"></i> หัวข้อ (English)
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. 10 Vocabulary Strategies That Actually Work"
                      maxLength={300}
                      value={form.titleEn}
                      onChange={(e) => setForm({ ...form, titleEn: e.target.value })}
                    />
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                  <div className="form-group">
                    <label>
                      <i className="fas fa-align-left"></i> คำโปรย (ไทย)
                    </label>
                    <input
                      type="text"
                      placeholder="สรุปสั้น ๆ ที่แสดงบนการ์ดบทความ"
                      maxLength={600}
                      value={form.excerptTh}
                      onChange={(e) => setForm({ ...form, excerptTh: e.target.value })}
                    />
                  </div>
                  <div className="form-group">
                    <label>
                      <i className="fas fa-align-left"></i> คำโปรย (English)
                    </label>
                    <input
                      type="text"
                      placeholder="Short summary shown on the blog card"
                      maxLength={600}
                      value={form.excerptEn}
                      onChange={(e) => setForm({ ...form, excerptEn: e.target.value })}
                    />
                  </div>
                </div>
                <div className="form-group">
                  <label>
                    <i className="fas fa-tag"></i> หมวดหมู่
                  </label>
                  <input
                    type="text"
                    placeholder="เช่น Vocabulary / Grammar / Speaking"
                    maxLength={60}
                    value={form.category}
                    onChange={(e) => setForm({ ...form, category: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>
                    <i className="fas fa-photo-film"></i> ปกบทความ (ไม่บังคับ)
                  </label>
                  <div
                    className={`blog-cover-drop${dragOver ? ' dragover' : ''}`}
                    onClick={() => coverInputRef.current?.click()}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOver(true);
                    }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragOver(false);
                      const file = e.dataTransfer.files?.[0];
                      if (file) handleCoverFile(file);
                    }}
                  >
                    <i className="fas fa-cloud-arrow-up" aria-hidden="true"></i>
                    <div className="blog-cover-drop__text">
                      ลากไฟล์มาวาง หรือ <span className="blog-cover-drop__choose">เลือกไฟล์</span> เพื่ออัปโหลด
                    </div>
                  </div>
                  <input
                    type="file"
                    accept="image/*,video/mp4,video/webm,video/quicktime,video/ogg"
                    ref={coverInputRef}
                    style={{ display: 'none' }}
                    onChange={(e) => handleCoverFile(e.target.files?.[0] || null)}
                  />
                  <div className="form-hint">รูปภาพสูงสุด 4 MB หรือวิดีโอสั้นไม่เกิน 15 วินาที (สูงสุด 20 MB) · JPG, PNG, WEBP, MP4, WEBM, MOV</div>

                  {coverCardVisible && (
                    <div className="blog-cover-card" style={{ display: 'block' }}>
                      {coverFile && (
                        <button type="button" className="blog-cover-card__remove" aria-label="นำออก" onClick={clearCover}>
                          <i className="fas fa-xmark"></i>
                        </button>
                      )}
                      <div className="blog-cover-card__row">
                        <div className="blog-cover-card__thumb">
                          {coverFile && coverObjectUrl ? (
                            coverFile.type.startsWith('video/') ? (
                              <video src={coverObjectUrl} muted autoPlay loop playsInline disablePictureInPicture />
                            ) : (
                              <img src={coverObjectUrl} alt="" />
                            )
                          ) : coverFile ? (
                            <i className={`fas ${coverFile.type.startsWith('video/') ? 'fa-video' : 'fa-image'}`}></i>
                          ) : existingCoverUrl ? (
                            editingPost?.coverMime?.startsWith('video/') ? (
                              <video src={existingCoverUrl} muted autoPlay loop playsInline disablePictureInPicture />
                            ) : (
                              <img src={existingCoverUrl} alt="" />
                            )
                          ) : null}
                        </div>
                        <div className="blog-cover-card__info">
                          <p className="blog-cover-card__name">{coverFile ? coverFile.name : 'ปกที่บันทึกไว้แล้ว'}</p>
                          <p className="blog-cover-card__meta">
                            <span>{coverFile ? formatFileSize(coverFile.size) : ''}</span>{' '}
                            <span>{coverFile ? coverStatus : 'เลือกไฟล์ใหม่เพื่อแทนที่'}</span>
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                {isAdmin && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', marginTop: 4 }}>
                    <input type="checkbox" checked={publishNow} onChange={(e) => setPublishNow(e.target.checked)} /> เผยแพร่ทันทีเมื่อบันทึก
                  </label>
                )}
              </div>
            )}

            {step === 4 && (
              <div className="blog-wizard-panel active">
                <div className="blog-preview-note">
                  <i className="fas fa-circle-info"></i> ตัวอย่างนี้โหลดสไตล์จริงจาก litalkeducation.com — หน้าตาจะเหมือนกับที่ผู้อ่านจะเห็นหลังเผยแพร่
                </div>
                <div className="blog-preview-frame-wrap">
                  <iframe className="blog-preview-frame" title="ตัวอย่างบทความ" srcDoc={previewSrcDoc} />
                </div>
              </div>
            )}

            <div className="blog-wizard-nav">
              <button className="btn btn-secondary" style={{ visibility: step === 1 ? 'hidden' : 'visible' }} onClick={goBack}>
                <i className="fas fa-arrow-left"></i> ย้อนกลับ
              </button>
              <div className="blog-wizard-nav__right">
                <button className="btn btn-secondary" onClick={closeEditor}>
                  <i className="fas fa-xmark"></i> ยกเลิก
                </button>
                {step === LAST_STEP ? (
                  <button className="btn btn-primary" onClick={save} disabled={saving}>
                    <i className="fas fa-save"></i> บันทึกบทความ
                  </button>
                ) : (
                  <button className="btn btn-primary" onClick={goNext}>
                    ถัดไป <i className="fas fa-arrow-right"></i>
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="form-body">
            <button className="btn btn-primary" onClick={() => openEditor(null)}>
              <i className="fas fa-plus"></i> เขียนบทความใหม่
            </button>
          </div>
        )}
      </div>

      <div className="admin-card">
        <div className="card-title-bar">
          <span className="card-icon">
            <i className="fas fa-newspaper"></i>
          </span>
          <div>
            <h3>บทความทั้งหมด</h3>
            <p>บทความที่สถานะ "เผยแพร่แล้ว" จะแสดงบนเว็บไซต์</p>
          </div>
        </div>
        <div className="row-list">
          {posts === null ? (
            <div className="form-hint">โหลดรายการบทความไม่สำเร็จ กรุณาลองใหม่อีกครั้ง</div>
          ) : !posts.length ? (
            <div className="form-hint">ยังไม่มีบทความ — กดปุ่ม "เขียนบทความใหม่" เพื่อเริ่มต้น</div>
          ) : (
            posts.map((p) => {
              const color = p.status === 'published' ? 'var(--accent-success)' : p.status === 'rejected' ? 'var(--accent-danger)' : 'var(--text-muted)';
              const mine = (p.authorIdentity || '').toLowerCase() === (me?.email || '').toLowerCase();
              const isVideoCover = !!p.coverMime?.startsWith('video/');
              return (
                <div className="alert-row" style={{ alignItems: 'flex-start' }} key={p.id}>
                  <i className="fas fa-newspaper" style={{ color, marginTop: 3 }}></i>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="alert-text">
                      <strong>{p.title}</strong>
                      {p.titleTh ? ` · ${p.titleTh}` : ''}
                      <span style={{ color }}> — {BLOG_STATUS_LABEL[p.status] || p.status}</span>
                    </div>
                    <div className="alert-text" style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                      {p.category ? `${p.category} · ` : ''}เขียนโดย {p.authorName || p.authorIdentity || '-'}
                      {p.reviewedBy ? ` · ตรวจโดย ${p.reviewedBy}` : ''}
                      {p.coverKey ? (isVideoCover ? ' · มีวิดีโอปก' : ' · มีรูปหน้าปก') : ''}
                    </div>
                    <div className="alert-text" style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                      สร้างเมื่อ {(p.createdAt || '').slice(0, 16)}
                      {p.publishedAt ? ` · เผยแพร่ ${String(p.publishedAt).slice(0, 16)}` : ''}
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                      {isAdmin && p.status !== 'published' && (
                        <button className="btn btn-success" style={{ padding: '6px 10px' }} onClick={() => setStatus(p.id, 'published')}>
                          <i className="fas fa-check"></i> อนุมัติและเผยแพร่
                        </button>
                      )}
                      {isAdmin && p.status === 'pending' && (
                        <button className="btn btn-danger" style={{ padding: '6px 10px' }} onClick={() => setStatus(p.id, 'rejected')}>
                          <i className="fas fa-xmark"></i> ไม่อนุมัติ
                        </button>
                      )}
                      {isAdmin && p.status === 'published' && (
                        <button className="btn btn-secondary" style={{ padding: '6px 10px' }} onClick={() => setStatus(p.id, 'pending')}>
                          <i className="fas fa-eye-slash"></i> เลิกเผยแพร่
                        </button>
                      )}
                      {(isAdmin || mine) && (
                        <>
                          <button className="btn btn-secondary" style={{ padding: '6px 10px' }} onClick={() => openEditor(p.id)}>
                            <i className="fas fa-pen"></i> แก้ไข
                          </button>
                          <button className="btn btn-danger" style={{ padding: '6px 10px' }} onClick={() => removePost(p.id)}>
                            <i className="fas fa-trash"></i> ลบ
                          </button>
                        </>
                      )}
                      {p.status === 'published' && (
                        <>
                          <button
                            className="btn btn-secondary"
                            style={{ padding: '6px 10px' }}
                            title="คัดลอกลิงก์บทความสำหรับแนบในแชทหรือโซเชียล"
                            onClick={() => navigator.clipboard.writeText(shortBlogPostUrl(p.slug))}
                          >
                            <i className="fas fa-link"></i> คัดลอกลิงก์
                          </button>
                          <a className="btn btn-secondary" style={{ padding: '6px 10px' }} href={blogPostUrl(p.slug)} target="_blank" rel="noopener noreferrer">
                            <i className="fas fa-arrow-up-right-from-square"></i> ดูบนเว็บไซต์
                          </a>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
