import { ImagePlus, RefreshCw, Trash2, TriangleAlert } from 'lucide-react';
import { useId, useRef, useState, type DragEvent } from 'react';
import { LIMITS } from '@shared/api';
import { formatBytes } from '../lib/format';
import { readAsDataUrl, readImageSize, validateImageFile } from '../lib/image';
import { cn } from '../lib/cn';
import { Button } from './Button';

export interface SelectedImage {
  file: File;
  /** data: URL (allowed by the default CSP, unlike blob: URLs). */
  previewUrl: string;
  width: number | null;
  height: number | null;
}

const ACCEPT = LIMITS.imageMimeTypes.join(',');

/** Character image picker: drag and drop, click, or keyboard (Enter/Space on the button). */
export function ImageDropZone({
  value,
  onChange,
  error,
}: {
  value: SelectedImage | null;
  onChange: (image: SelectedImage | null) => void;
  error?: string | null;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const id = useId();

  const openPicker = () => inputRef.current?.click();

  const accept = async (file: File | undefined) => {
    if (!file) return;
    const problem = validateImageFile(file);
    if (problem) {
      setLocalError(problem);
      return;
    }
    setLocalError(null);
    setReading(true);
    try {
      const previewUrl = await readAsDataUrl(file);
      const size = await readImageSize(previewUrl);
      if (!size) {
        setLocalError('This image could not be decoded. Try another file.');
        return;
      }
      onChange({ file, previewUrl, width: size.width, height: size.height });
    } catch {
      setLocalError('This file could not be read. Try another image.');
    } finally {
      setReading(false);
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    void accept(event.dataTransfer.files[0]);
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    if (!dragging) setDragging(true);
  };

  const shownError = localError ?? error ?? null;
  const landscape = value?.width && value.height ? value.width > value.height : false;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span id={`${id}-label`} className="text-sm font-medium">
          Character image
        </span>
        <span className="text-xs text-subtle">JPEG, PNG or WebP, up to {formatBytes(LIMITS.imageMaxBytes)}</span>
      </div>
      <input
        ref={inputRef}
        id={`${id}-input`}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          void accept(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
      <div
        onDragOver={onDragOver}
        onDragEnter={onDragOver}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={onDrop}
        className={cn(
          'rounded-xl border-2 border-dashed transition-colors',
          dragging ? 'border-accent bg-accent-soft' : shownError ? 'border-danger/60' : 'border-line-strong',
          value ? 'p-3' : 'p-0',
        )}
      >
        {value ? (
          <div className="flex gap-4">
            <img
              src={value.previewUrl}
              alt="Selected character"
              className="h-36 w-24 shrink-0 rounded-lg bg-surface-2 object-cover sm:h-40 sm:w-28"
            />
            <div className="flex min-w-0 flex-1 flex-col justify-between gap-3">
              <div className="min-w-0 text-sm">
                <p className="truncate font-medium" title={value.file.name}>
                  {value.file.name}
                </p>
                <p className="text-muted">
                  {formatBytes(value.file.size)}
                  {value.width && value.height ? ` · ${value.width} × ${value.height}` : ''}
                </p>
                {landscape && (
                  <p className="mt-2 flex items-start gap-1.5 text-xs text-warn">
                    <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
                    Landscape image. A portrait photo works best for 9:16 video.
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={openPicker}
                  loading={reading}
                  icon={<RefreshCw className="size-4" aria-hidden="true" />}
                >
                  Replace
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setLocalError(null);
                    onChange(null);
                  }}
                  icon={<Trash2 className="size-4" aria-hidden="true" />}
                >
                  Remove
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={openPicker}
            aria-labelledby={`${id}-label ${id}-cta`}
            aria-describedby={shownError ? `${id}-error` : undefined}
            className="flex w-full flex-col items-center justify-center gap-2 rounded-[10px] px-4 py-8 text-center hover:bg-surface-2"
          >
            <span className="flex size-11 items-center justify-center rounded-full bg-accent-soft text-accent-text">
              <ImagePlus className="size-5" aria-hidden="true" />
            </span>
            <span id={`${id}-cta`} className="text-sm font-medium">
              {reading ? 'Reading image...' : 'Drop an image here or click to browse'}
            </span>
            <span className="max-w-xs text-xs text-muted">
              A clear, well-lit photo of one person, face visible. It is used for every frame of the video.
            </span>
          </button>
        )}
      </div>
      {shownError && (
        <p id={`${id}-error`} role="alert" className="text-xs font-medium text-danger">
          {shownError}
        </p>
      )}
    </div>
  );
}
