import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { BugDetail } from '../types';

const ACCEPT =
  'image/png,image/jpeg,image/gif,image/webp,video/webm,video/mp4,application/pdf,text/plain';

interface Staged {
  file: File;
  /** Object URL for anything we can show; null for PDFs and text. */
  preview: string | null;
  kind: 'image' | 'video' | 'file';
}

export function NewBug({
  severities,
  onCreated,
  onClose,
}: {
  severities: string[];
  onCreated: (bug: BugDetail) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState('');
  const [expected, setExpected] = useState('');
  const [actual, setActual] = useState('');
  const [severity, setSeverity] = useState('minor');
  const [appVersion, setAppVersion] = useState('');
  const [environment, setEnvironment] = useState('');
  const [files, setFiles] = useState<Staged[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  // Object URLs are per-file and have to be released when the list changes.
  useEffect(
    () => () => {
      for (const f of files) if (f.preview) URL.revokeObjectURL(f.preview);
    },
    [files],
  );

  function add(list: FileList | File[]) {
    const staged: Staged[] = [...list].map((file) => {
      const kind = file.type.startsWith('image/')
        ? 'image'
        : file.type.startsWith('video/')
          ? 'video'
          : 'file';
      return {
        file,
        kind,
        preview: kind === 'file' ? null : URL.createObjectURL(file),
      };
    });
    setFiles((prev) => [...prev, ...staged].slice(0, 10));
  }

  /** Screenshots are usually on the clipboard, not on disk — take a paste too. */
  function onPaste(event: React.ClipboardEvent) {
    const pasted = [...event.clipboardData.files];
    if (pasted.length) {
      event.preventDefault();
      add(pasted);
    }
  }

  async function submit() {
    if (!title.trim()) {
      setError('Give the bug a title');
      return;
    }

    setBusy(true);
    setError('');

    try {
      const { bug } = await api.createBug({
        title,
        description,
        steps,
        expected,
        actual,
        severity,
        appVersion,
        environment,
      });

      if (files.length) {
        const { bug: withFiles } = await api.upload(
          bug.id,
          files.map((f) => f.file),
        );
        onCreated(withFiles);
      } else {
        onCreated(bug);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not raise the bug');
      setBusy(false);
    }
  }

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} onPaste={onPaste}>
        <div className="modal-head">
          <h2>Raise a bug</h2>
          <button className="close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="modal-body">
          {error ? <div className="error">{error}</div> : null}

          <div className="field">
            <label htmlFor="nb-title">Title</label>
            <input
              id="nb-title"
              type="text"
              value={title}
              autoFocus
              placeholder="What went wrong, in one line"
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="nb-desc">What happened</label>
            <textarea
              id="nb-desc"
              rows={3}
              value={description}
              placeholder="Describe the problem"
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="nb-steps">Steps to reproduce</label>
            <textarea
              id="nb-steps"
              rows={3}
              value={steps}
              placeholder={'1. Open…\n2. Click…\n3. See…'}
              onChange={(e) => setSteps(e.target.value)}
            />
          </div>

          <div className="field-row">
            <div className="field">
              <label htmlFor="nb-expected">Expected</label>
              <textarea
                id="nb-expected"
                rows={2}
                value={expected}
                onChange={(e) => setExpected(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="nb-actual">Actual</label>
              <textarea
                id="nb-actual"
                rows={2}
                value={actual}
                onChange={(e) => setActual(e.target.value)}
              />
            </div>
          </div>

          <div className="field-row">
            <div className="field">
              <label htmlFor="nb-sev">Severity</label>
              <select id="nb-sev" value={severity} onChange={(e) => setSeverity(e.target.value)}>
                {severities.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="nb-ver">ezmuze version</label>
              <input
                id="nb-ver"
                type="text"
                value={appVersion}
                placeholder="e.g. 2026.8.1"
                onChange={(e) => setAppVersion(e.target.value)}
              />
            </div>
          </div>

          <div className="field">
            <label htmlFor="nb-env">Machine / OS</label>
            <input
              id="nb-env"
              type="text"
              value={environment}
              placeholder="e.g. Windows 11, desktop DX build"
              onChange={(e) => setEnvironment(e.target.value)}
            />
          </div>

          <div className="field">
            <label>Screenshots and recordings</label>
            <div
              className={`dropzone${dragOver ? ' over' : ''}`}
              onClick={() => input.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                add(e.dataTransfer.files);
              }}
            >
              Drop images or a screen recording here, paste from the clipboard, or click to
              choose
            </div>
            <input
              ref={input}
              type="file"
              accept={ACCEPT}
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) add(e.target.files);
                e.target.value = '';
              }}
            />
            <div className="hint">
              Images (PNG, JPEG, GIF, WebP), screen recordings (WebM, MP4), PDF or .txt —
              up to 10 files, 50MB each.
            </div>

            {files.length ? (
              <div className="thumbs">
                {files.map((f, i) => (
                  <div className="thumb" key={`${f.file.name}-${i}`}>
                    {f.kind === 'image' && f.preview ? (
                      <img src={f.preview} alt={f.file.name} />
                    ) : f.kind === 'video' && f.preview ? (
                      <>
                        {/* muted + no controls: this is a thumbnail, not a player */}
                        <video src={f.preview} muted playsInline preload="metadata" />
                        <span className="badge">video</span>
                      </>
                    ) : (
                      <div className="file">{f.file.name}</div>
                    )}
                    <button
                      className="remove"
                      aria-label={`Remove ${f.file.name}`}
                      onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={busy}>
            {busy ? 'Raising…' : 'Raise bug'}
          </button>
        </div>
      </div>
    </div>
  );
}
