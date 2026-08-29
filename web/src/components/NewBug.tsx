import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { BugCard, BugDetail, ItemKind, Prefill, Version } from '../types';
import { VersionPicker } from './VersionPicker';

const ACCEPT =
  'image/png,image/jpeg,image/gif,image/webp,video/webm,video/mp4,application/pdf,text/plain';

interface Staged {
  file: File;
  /** Object URL for anything we can show; null for PDFs and text. */
  preview: string | null;
  kind: 'image' | 'video' | 'file';
}

export function NewBug({
  kind,
  environments,
  versions,
  defaultVersion,
  prefill,
  knownBug,
  onCreated,
  onOpenBug,
  onClose,
}: {
  kind: ItemKind;
  environments: string[];
  versions: Version[];
  defaultVersion: string;
  /** What ezmuze already filled in, when the app sent the reporter here. */
  prefill?: Prefill;
  /** A bug whose stack trace already matches this one. */
  knownBug?: BugCard | null;
  onCreated: (bug: BugDetail) => void;
  onOpenBug?: (id: number) => void;
  onClose: () => void;
}) {
  /** The server decides which fields this kind has no use for. */
  const shows = (field: string) => !kind.hiddenFields.includes(field);
  const labelFor = (field: string, fallback: string) => kind.labels[field] ?? fallback;
  const [title, setTitle] = useState(prefill?.title ?? '');
  const [description, setDescription] = useState(prefill?.description ?? '');
  const [steps, setSteps] = useState(prefill?.steps ?? '');
  const [expected, setExpected] = useState(prefill?.expected ?? '');
  const [actual, setActual] = useState(prefill?.actual ?? '');
  const [severity, setSeverity] = useState(
    prefill?.severity ??
      // The middle of this kind's scale, not a key from another one.
      (kind.levels[Math.min(2, kind.levels.length - 1)]?.key ?? ''),
  );
  // Most reports come from whoever is on the current build.
  // What the app reported beats the newest release: it knows its own build.
  const [appVersion, setAppVersion] = useState(prefill?.appVersion ?? defaultVersion);
  const [stackTrace, setStackTrace] = useState(prefill?.stackTrace ?? '');
  const [environment, setEnvironment] = useState(prefill?.environment ?? '');
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
        severity,
        environment,
        kind: kind.key,
        // Hidden fields are never sent, so a feature request cannot carry
        // reproduction text somebody typed before switching kind.
        steps: shows('steps') ? steps : '',
        expected: shows('expected') ? expected : '',
        actual: shows('actual') ? actual : '',
        appVersion: shows('appVersion') ? appVersion : '',
        stackTrace: shows('stackTrace') ? stackTrace : '',
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
          <h2>
            <span className="kind-emoji" aria-hidden="true">
              {kind.emoji}
            </span>{' '}
            Raise {kind.article}
          </h2>
          <button className="close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="modal-body">
          {error ? <div className="error">{error}</div> : null}

          {knownBug ? (
            <div className="notice">
              This crash is already reported as{' '}
              <a
                href={`#/bug/${knownBug.id}`}
                onClick={(e) => {
                  if (!onOpenBug) return;
                  e.preventDefault();
                  onOpenBug(knownBug.id);
                }}
              >
                #{knownBug.id} {knownBug.title}
              </a>
              . You can still send this — it will be counted against that one rather than
              opening a second ticket.
            </div>
          ) : null}

          {prefill && Object.keys(prefill).length ? (
            <p className="prefill-note">
              ezmuze filled in what it knew about your setup. Please add what you were doing
              when it happened.
            </p>
          ) : null}

          <div className="field">
            <label htmlFor="nb-title">Title</label>
            <input
              id="nb-title"
              type="text"
              value={title}
              autoFocus
              placeholder={labelFor('titlePlaceholder', 'What went wrong, in one line')}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="nb-desc">{labelFor('description', 'What happened')}</label>
            <textarea
              id="nb-desc"
              rows={3}
              value={description}
              placeholder={
                shows('steps') ? 'Describe the problem' : 'Describe what you would like, and why'
              }
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          {/* Reproduction fields: nothing to reproduce on a feature request. */}
          {shows('steps') ? (
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
          ) : null}

          {shows('expected') || shows('actual') ? (
            <div className="field-row">
              {shows('expected') ? (
                <div className="field">
                  <label htmlFor="nb-expected">Expected</label>
                  <textarea
                    id="nb-expected"
                    rows={2}
                    value={expected}
                    onChange={(e) => setExpected(e.target.value)}
                  />
                </div>
              ) : null}
              {shows('actual') ? (
                <div className="field">
                  <label htmlFor="nb-actual">Actual</label>
                  <textarea
                    id="nb-actual"
                    rows={2}
                    value={actual}
                    onChange={(e) => setActual(e.target.value)}
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="field-row">
            <div className="field">
              <label htmlFor="nb-sev">{labelFor('severity', 'Severity')}</label>
              <select id="nb-sev" value={severity} onChange={(e) => setSeverity(e.target.value)}>
                {kind.levels.map((level) => (
                  <option key={level.key} value={level.key}>
                    {level.label}
                  </option>
                ))}
              </select>
            </div>
            {shows('appVersion') ? (
              <div className="field">
                <label htmlFor="nb-ver">ezmuze version</label>
                <VersionPicker
                  id="nb-ver"
                  value={appVersion}
                  versions={versions}
                  onChange={setAppVersion}
                />
              </div>
            ) : null}
          </div>

          {shows('stackTrace') ? (
            <div className="field">
              <label htmlFor="nb-stack">Error message or stack trace</label>
              <textarea
                id="nb-stack"
                className="mono"
                rows={5}
                value={stackTrace}
                placeholder="Paste the whole thing, if ezmuze showed you one"
                onChange={(e) => setStackTrace(e.target.value)}
              />
              <div className="hint">
                Optional, but it is the fastest way to match your report to one already
                being worked on. Usernames and file paths are stripped before it is saved.
              </div>
            </div>
          ) : null}

          <div className="field">
            <label htmlFor="nb-env">Where it happened</label>
            <select
              id="nb-env"
              value={environment}
              onChange={(e) => setEnvironment(e.target.value)}
            >
              <option value="">Not sure / not specified</option>
              {environments.map((env) => (
                <option key={env} value={env}>
                  {env}
                </option>
              ))}
            </select>
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
            {busy ? 'Raising…' : `Raise ${kind.label.toLowerCase()}`}
          </button>
        </div>
      </div>
    </div>
  );
}
