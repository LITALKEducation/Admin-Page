'use client';

import { CheckCircle, FileText, Loader2, TriangleAlert, Upload, X } from 'lucide-react';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';

interface UploadItem {
  id: string;
  name: string;
  progress: number;
  status: 'uploading' | 'completed' | 'error';
  error?: string;
}

// Adapted from the shadcn file-upload-06 block: the original ships with
// seeded demo rows and onChange/onDrop handlers that only console.log the
// selection. Reworked into a real, reusable dropzone that drives an actual
// upload call per file, with a simulated progress ramp (real byte-level
// progress isn't available since the API client uses fetch, not XHR) that
// snaps to 100% only once the request genuinely resolves — the "uploading"
// vs "done"/"failed" state is always accurate even though the percentage
// before completion is a rough visual cue rather than a true measurement.
export default function FileUpload06({
  accept = '*/*',
  maxSizeMB = 10,
  helperText,
  onUpload,
}: {
  accept?: string;
  maxSizeMB?: number;
  helperText?: string;
  onUpload: (file: File, signal: AbortSignal) => Promise<void>;
}) {
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const filePickerRef = useRef<HTMLInputElement>(null);
  const controllersRef = useRef<Map<string, AbortController>>(new Map());
  const ramperRef = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());

  useEffect(() => {
    const controllers = controllersRef.current;
    const rampers = ramperRef.current;
    return () => {
      controllers.forEach((controller) => controller.abort());
      rampers.forEach((timer) => clearInterval(timer));
    };
  }, []);

  const startUpload = (file: File) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const controller = new AbortController();
    controllersRef.current.set(id, controller);

    setUploads((prev) => [...prev, { id, name: file.name, progress: 8, status: 'uploading' }]);

    const ramp = setInterval(() => {
      setUploads((prev) =>
        prev.map((item) =>
          item.id === id && item.status === 'uploading' && item.progress < 90
            ? { ...item, progress: item.progress + Math.random() * 12 }
            : item,
        ),
      );
    }, 250);
    ramperRef.current.set(id, ramp);

    const finish = () => {
      clearInterval(ramp);
      ramperRef.current.delete(id);
      controllersRef.current.delete(id);
    };

    onUpload(file, controller.signal)
      .then(() => {
        finish();
        setUploads((prev) => prev.map((item) => (item.id === id ? { ...item, progress: 100, status: 'completed' } : item)));
      })
      .catch((error) => {
        finish();
        if (controller.signal.aborted) {
          setUploads((prev) => prev.filter((item) => item.id !== id));
          return;
        }
        setUploads((prev) =>
          prev.map((item) =>
            item.id === id
              ? { ...item, status: 'error', error: error instanceof Error ? error.message : 'อัปโหลดล้มเหลว' }
              : item,
          ),
        );
      });
  };

  const openFilePicker = () => {
    filePickerRef.current?.click();
  };

  const handleFiles = (fileList: FileList | null) => {
    if (!fileList) return;
    Array.from(fileList).forEach(startUpload);
  };

  const onFileInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    handleFiles(event.target.files);
    event.target.value = '';
  };

  const onDragOver = (event: React.DragEvent) => {
    event.preventDefault();
  };

  const onDropFiles = (event: React.DragEvent) => {
    event.preventDefault();
    handleFiles(event.dataTransfer.files);
  };

  const removeUpload = (id: string) => {
    const controller = controllersRef.current.get(id);
    if (controller) {
      controller.abort();
      return;
    }
    setUploads((prev) => prev.filter((item) => item.id !== id));
  };

  const activeUploads = uploads.filter((file) => file.status === 'uploading');
  const erroredUploads = uploads.filter((file) => file.status === 'error');
  const completedUploads = uploads.filter((file) => file.status === 'completed');

  return (
    <div className="flex w-full flex-col gap-y-6">
      <Card
        className="group flex max-h-[200px] w-full cursor-pointer flex-col items-center justify-center gap-4 border-dashed py-8 text-sm shadow-none transition-colors hover:bg-muted/50"
        onClick={openFilePicker}
        onDragOver={onDragOver}
        onDrop={onDropFiles}
      >
        <div className="grid space-y-3">
          <div className="flex items-center gap-x-2 text-muted-foreground">
            <Upload className="size-5" />
            <div>
              ลากไฟล์มาวางที่นี่ หรือ{' '}
              <Button className="h-auto p-0 font-normal text-primary" onClick={openFilePicker} variant="link">
                เลือกไฟล์
              </Button>
            </div>
          </div>
        </div>
        <input
          accept={accept}
          className="hidden"
          multiple
          onChange={onFileInputChange}
          ref={filePickerRef}
          type="file"
        />
        <span className="mt-2 block text-base/6 text-muted-foreground group-disabled:opacity-50 sm:text-xs">
          {helperText || `ขนาดไฟล์สูงสุด ${maxSizeMB} MB`}
        </span>
      </Card>

      {uploads.length > 0 && (
        <div className="flex flex-col gap-y-4">
          {activeUploads.length > 0 && (
            <div>
              <h2 className="mb-4 flex items-center text-balance font-mono font-normal text-foreground text-lg uppercase sm:text-xs">
                <Loader2 className="mr-1 size-4 animate-spin" />
                กำลังอัปโหลด
              </h2>
              <div className="-mt-2 divide-y">
                {activeUploads.map((file) => (
                  <div className="group flex items-center py-4" key={file.id}>
                    <div className="mr-3 grid size-10 shrink-0 place-content-center rounded border bg-muted">
                      <FileText className="inline size-4 group-hover:hidden" />
                      <Button
                        aria-label="ยกเลิก"
                        className="hidden size-4 h-auto p-0 group-hover:inline"
                        onClick={() => removeUpload(file.id)}
                        size="icon"
                        variant="ghost"
                      >
                        <X className="size-4" />
                      </Button>
                    </div>
                    <div className="mb-1 flex w-full flex-col">
                      <div className="flex justify-between gap-2">
                        <span className="select-none text-base/6 text-foreground group-disabled:opacity-50 sm:text-sm/6">
                          {file.name}
                        </span>
                        <span className="text-muted-foreground text-sm tabular-nums">
                          {Math.round(file.progress)}%
                        </span>
                      </div>
                      <Progress className="mt-1 h-2 min-w-64" value={file.progress} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeUploads.length > 0 && (erroredUploads.length > 0 || completedUploads.length > 0) && (
            <Separator className="my-0" />
          )}

          {erroredUploads.length > 0 && (
            <div>
              <h2 className="mb-4 flex items-center text-balance font-mono font-normal text-destructive text-lg uppercase sm:text-xs">
                <TriangleAlert className="mr-1 size-4" />
                ล้มเหลว
              </h2>
              <div className="-mt-2 divide-y">
                {erroredUploads.map((file) => (
                  <div className="group flex items-center py-4" key={file.id}>
                    <div className="mr-3 grid size-10 shrink-0 place-content-center rounded border bg-muted">
                      <FileText className="size-4" />
                    </div>
                    <div className="mb-1 flex w-full flex-col">
                      <div className="flex justify-between gap-2">
                        <span className="select-none text-base/6 text-foreground sm:text-sm/6">{file.name}</span>
                        <Button
                          aria-label="นำออก"
                          className="size-4 h-auto p-0"
                          onClick={() => removeUpload(file.id)}
                          size="icon"
                          variant="ghost"
                        >
                          <X className="size-4" />
                        </Button>
                      </div>
                      <span className="text-destructive text-xs">{file.error}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {erroredUploads.length > 0 && completedUploads.length > 0 && <Separator className="my-0" />}

          {completedUploads.length > 0 && (
            <div>
              <h2 className="mb-4 flex items-center text-balance font-mono font-normal text-foreground text-lg uppercase sm:text-xs">
                <CheckCircle className="mr-1 size-4" />
                เสร็จสิ้น
              </h2>
              <div className="-mt-2 divide-y">
                {completedUploads.map((file) => (
                  <div className="group flex items-center py-4" key={file.id}>
                    <div className="mr-3 grid size-10 shrink-0 place-content-center rounded border bg-muted">
                      <FileText className="inline size-4 group-hover:hidden" />
                      <Button
                        aria-label="นำออก"
                        className="hidden size-4 h-auto p-0 group-hover:inline"
                        onClick={() => removeUpload(file.id)}
                        size="icon"
                        variant="ghost"
                      >
                        <X className="size-4" />
                      </Button>
                    </div>
                    <div className="mb-1 flex w-full flex-col">
                      <div className="flex justify-between gap-2">
                        <span className="select-none text-base/6 text-foreground group-disabled:opacity-50 sm:text-sm/6">
                          {file.name}
                        </span>
                        <span className="text-muted-foreground text-sm tabular-nums">100%</span>
                      </div>
                      <Progress className="mt-1 h-2 min-w-64" value={100} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
