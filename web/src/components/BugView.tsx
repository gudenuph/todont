import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { BoardColumn, BugDetail, ItemKind, Session, User } from '../types';
import { levelColor, levelLabel } from '../severity';

function when(iso: string): string {
  // SQLite hands back "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker.
  const date = new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z'));
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function describeEvent(type: string, detail: string): string {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(detail) as Record<string, unknown>;
  } catch {
    /* older or plain-text details */
  }

  switch (type) {
    case 'created':
      return `raised this${data.via === 'token' ? ' via the API' : ''}`;
    case 'status_changed':
      return `moved it from ${String(data.from)} to ${String(data.to)}`;
    case 'merged':
      return `merged this into #${String(data.into)}`;
    case 'unmerged':
      return `split this back out of #${String(data.from)}`;
    case 'duplicate_added':
      return `marked #${String(data.duplicate)} a duplicate of this`;
    case 'duplicate_removed':
      return `removed #${String(data.duplicate)} as a duplicate`;
    case 'assigned':
      return 'assigned it';
    case 'unassigned':
      return 'unassigned it';
    case 'edited':
      return 'edited the details';
    case 'attachment_added':
      return `added ${String(data.count ?? 1)} attachment(s)`;
    case 'attachment_removed':
      return `removed an attachment`;
    case 'comment_deleted':
      return `deleted a comment by ${String(data.author ?? 'someone')}`;
    default:
      return type;
  }
}

/** Every field a manager may rewrite, exactly matching what PATCH accepts. */
interface Draft {
  title: string;
  description: string;
  steps: string;
  expected: string;
  actual: string;
  appVersion: string;
  environment: string;
}

interface Props {
  bugId: number;
  session: Session;
  columns: BoardColumn[];
  environments: string[];
  kinds: ItemKind[];
  onChanged: (bug: BugDetail) => void;
  onDeleted: (id: number) => void;
  onClose: () => void;
  onOpenOther: (id: number) => void;
}

export function BugView({
  bugId,
  session,
  columns,
  environments,
  kinds,
  onChanged,
  onDeleted,
  onClose,
  onOpenOther,
}: Props) {
  const [bug, setBug] = useState<BugDetail | null>(null);
  const [assignable, setAssignable] = useState<User[]>([]);
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);

  const canManage = session.scopes?.includes('manage') ?? false;
  const canWrite = session.scopes?.includes('write') ?? false;

  /**
   * The same rule the server enforces: a manager edits anything, and a reporter
   * may still fix their own wording while the bug is untriaged.
   */
  const intakeKey = columns.find((c) => c.intake)?.key;
  const canEdit =
    canManage ||
    (bug !== null && bug.reporter?.id === session.user?.id && bug.status === intakeKey);

  /** Managers can pull anything; everyone else only what they uploaded. */
  const canRemoveAttachment = (uploaderId: number | undefined) =>
    canManage || (uploaderId !== undefined && uploaderId === session.user?.id);

  useEffect(() => {
    let live = true;
    setBug(null);
    void api
      .bug(bugId)
      .then(({ bug: loaded }) => {
        if (live) setBug(loaded);
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : 'Could not load that bug');
      });
    return () => {
      live = false;
    };
  }, [bugId]);

  useEffect(() => {
    if (!canManage) return;
    void api
      .assignable()
      .then(({ users }) => setAssignable(users))
      .catch(() => setAssignable([]));
  }, [canManage]);

  /** Every mutation returns the fresh bug, so the board and this view stay in step. */
  async function mutate(work: () => Promise<{ bug: BugDetail }>) {
    setBusy(true);
    setError('');
    try {
      const { bug: updated } = await work();
      setBug(updated);
      onChanged(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work');
    } finally {
      setBusy(false);
    }
  }

  function startEditing() {
    if (!bug) return;
    setDraft({
      title: bug.title,
      description: bug.description,
      steps: bug.steps,
      expected: bug.expected,
      actual: bug.actual,
      appVersion: bug.appVersion,
      environment: bug.environment,
    });
  }

  async function saveDraft() {
    if (!bug || !draft) return;
    if (!draft.title.trim()) {
      setError('Title cannot be empty');
      return;
    }
    // Send only what actually changed, so the activity trail stays honest.
    const changed: Record<string, string> = {};
    for (const [key, value] of Object.entries(draft)) {
      if (value !== (bug as unknown as Record<string, string>)[key]) changed[key] = value;
    }
    if (!Object.keys(changed).length) {
      setDraft(null);
      return;
    }
    await mutate(async () => {
      const result = await api.updateBug(bug.id, changed);
      setDraft(null);
      return result;
    });
  }

  /** Deleting a bug leaves nothing to re-render, so it closes the dialog. */
  async function removeBug() {
    if (!bug) return;
    setBusy(true);
    setError('');
    try {
      await api.deleteBug(bug.id);
      onDeleted(bug.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete that bug');
      setBusy(false);
    }
  }

  if (error && !bug) {
    return (
      <div className="scrim" onClick={onClose}>
        <div className="modal narrow" onClick={(e) => e.stopPropagation()}>
          <div className="modal-body">
            <div className="error">{error}</div>
          </div>
        </div>
      </div>
    );
  }

  if (!bug) {
    return (
      <div className="scrim" onClick={onClose}>
        <div className="modal narrow" onClick={(e) => e.stopPropagation()}>
          <div className="center-note">
            <span className="spinner" /> Loading…
          </div>
        </div>
      </div>
    );
  }

  const column = columns.find((c) => c.key === bug.status);
  const kind = kinds.find((k) => k.key === bug.kind);
  const shows = (field: string) => !kind?.hiddenFields.includes(field);
  const labelFor = (field: string, fallback: string) => kind?.labels[field] ?? fallback;

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="id" style={{ color: 'var(--text-faint)' }}>
            {kind ? (
              <span className="kind-emoji" title={kind.label} role="img" aria-label={kind.label}>
                {kind.emoji}
              </span>
            ) : null}{' '}
            #{bug.id}
          </span>
          {draft ? (
            <input
              className="title-edit"
              type="text"
              value={draft.title}
              aria-label="Title"
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          ) : (
            <h2>{bug.title}</h2>
          )}
          {canEdit && !draft ? (
            <button className="btn small ghost" onClick={startEditing}>
              Edit
            </button>
          ) : null}
          <button className="close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="modal-body">
          {error ? <div className="error">{error}</div> : null}

          {bug.mergedIntoId ? (
            <div className="error" style={{ background: 'rgba(255,196,64,0.1)', borderColor: 'rgba(255,196,64,0.4)', color: 'var(--amber)' }}>
              This is a duplicate of{' '}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  onOpenOther(bug.mergedIntoId!);
                }}
              >
                #{bug.mergedIntoId}
              </a>
              {canManage ? (
                <>
                  {' — '}
                  <button
                    className="btn small ghost"
                    disabled={busy}
                    onClick={() => void mutate(() => api.unmergeBug(bug.id))}
                  >
                    Split it back out
                  </button>
                </>
              ) : null}
            </div>
          ) : null}

          <div className="detail-grid">
            <div>
              {draft ? (
                <div className="edit-form">
                  <Field
                    label={labelFor('description', 'What happened')}
                    value={draft.description}
                    rows={4}
                    onChange={(v) => setDraft({ ...draft, description: v })}
                  />
                  {shows('steps') ? (
                    <Field
                      label="Steps to reproduce"
                      value={draft.steps}
                      rows={4}
                      onChange={(v) => setDraft({ ...draft, steps: v })}
                    />
                  ) : null}
                  {shows('expected') || shows('actual') ? (
                    <div className="field-row">
                      {shows('expected') ? (
                        <Field
                          label="Expected"
                          value={draft.expected}
                          rows={3}
                          onChange={(v) => setDraft({ ...draft, expected: v })}
                        />
                      ) : null}
                      {shows('actual') ? (
                        <Field
                          label="Actual"
                          value={draft.actual}
                          rows={3}
                          onChange={(v) => setDraft({ ...draft, actual: v })}
                        />
                      ) : null}
                    </div>
                  ) : null}
                  <div className="field-row">
                    {shows('appVersion') ? (
                      <div className="field">
                        <label htmlFor="bv-version">ezmuze version</label>
                        <input
                          id="bv-version"
                          type="text"
                          value={draft.appVersion}
                          placeholder="e.g. 2026.8.1"
                          onChange={(e) => setDraft({ ...draft, appVersion: e.target.value })}
                        />
                      </div>
                    ) : null}
                    <div className="field">
                      <label htmlFor="bv-env">Where it happened</label>
                      <select
                        id="bv-env"
                        value={draft.environment}
                        onChange={(e) => setDraft({ ...draft, environment: e.target.value })}
                      >
                        <option value="">Not sure / not specified</option>
                        {environments.map((env) => (
                          <option key={env} value={env}>
                            {env}
                          </option>
                        ))}
                        {/* A value from the API that predates this list must
                            still be selectable, or saving would silently drop it. */}
                        {draft.environment && !environments.includes(draft.environment) ? (
                          <option value={draft.environment}>{draft.environment}</option>
                        ) : null}
                      </select>
                    </div>
                  </div>
                  <div className="edit-actions">
                    <button className="btn ghost" disabled={busy} onClick={() => setDraft(null)}>
                      Cancel
                    </button>
                    <button className="btn primary" disabled={busy} onClick={() => void saveDraft()}>
                      {busy ? 'Saving…' : 'Save changes'}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <Section title={labelFor('description', 'What happened')} body={bug.description} />
                  {shows('steps') ? <Section title="Steps to reproduce" body={bug.steps} /> : null}
                  {shows('expected') ? <Section title="Expected" body={bug.expected} /> : null}
                  {shows('actual') ? <Section title="Actual" body={bug.actual} /> : null}
                </>
              )}

              {bug.attachments.length ? (
                <div className="detail-section">
                  <h3>Attachments</h3>
                  <div className="shots">
                    {bug.attachments.map((a) =>
                      // A video plays in place; wrapping it in a link would put
                      // its own controls in a fight with the anchor.
                      a.mime.startsWith('video/') ? (
                        <div className="shot video" key={a.id} title={a.name}>
                          <video src={a.url} controls preload="metadata" playsInline />
                          <a href={a.url} target="_blank" rel="noreferrer" className="file-link">
                            {a.name}
                          </a>
                          {canRemoveAttachment(a.uploadedBy?.id) ? (
                            <button
                              className="shot-remove"
                              title="Remove this attachment"
                              disabled={busy}
                              onClick={() => void mutate(() => api.deleteAttachment(a.id))}
                            >
                              ×
                            </button>
                          ) : null}
                        </div>
                      ) : (
                        <div className="shot" key={a.id} title={a.name}>
                          <a href={a.url} target="_blank" rel="noreferrer">
                            {a.mime.startsWith('image/') ? (
                              <img src={a.url} alt={a.name} />
                            ) : (
                              <span className="file-link">{a.name}</span>
                            )}
                          </a>
                          {canRemoveAttachment(a.uploadedBy?.id) ? (
                            <button
                              className="shot-remove"
                              title="Remove this attachment"
                              disabled={busy}
                              onClick={() => void mutate(() => api.deleteAttachment(a.id))}
                            >
                              ×
                            </button>
                          ) : null}
                        </div>
                      ),
                    )}
                  </div>
                </div>
              ) : null}

              {bug.duplicates.length ? (
                <div className="detail-section">
                  <h3>Merged duplicates ({bug.duplicates.length})</h3>
                  <div className="dup-list">
                    {bug.duplicates.map((d) => (
                      <div className="dup-item" key={d.id}>
                        <span style={{ color: 'var(--text-faint)' }}>#{d.id}</span>
                        <span className="grow">
                          {d.title}
                          {d.reporter ? (
                            <span style={{ color: 'var(--text-faint)' }}> — {d.reporter.name}</span>
                          ) : null}
                        </span>
                        <button className="btn small ghost" onClick={() => onOpenOther(d.id)}>
                          Open
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="detail-section">
                <h3>Discussion</h3>
                <div className="thread">
                  {bug.comments.length === 0 ? (
                    <p className="empty" style={{ color: 'var(--text-faint)' }}>
                      Nothing yet.
                    </p>
                  ) : (
                    bug.comments.map((c) => (
                      <div className="comment" key={c.id}>
                        <div className="comment-head">
                          <b>{c.author?.name ?? 'someone'}</b>
                          {c.author?.isBot ? <span className="pill bot">bot</span> : null}
                          <span>{when(c.createdAt)}</span>
                          {canManage ? (
                            <button
                              className="comment-remove"
                              title="Delete this comment"
                              disabled={busy}
                              onClick={() => void mutate(() => api.deleteComment(c.id))}
                            >
                              ×
                            </button>
                          ) : null}
                        </div>
                        <p>{c.body}</p>
                      </div>
                    ))
                  )}
                </div>

                {canWrite ? (
                  <div style={{ marginTop: 10 }}>
                    <textarea
                      rows={3}
                      value={comment}
                      placeholder="Add a comment"
                      onChange={(e) => setComment(e.target.value)}
                    />
                    <div style={{ marginTop: 8, textAlign: 'right' }}>
                      <button
                        className="btn primary small"
                        disabled={busy || !comment.trim()}
                        onClick={() =>
                          void mutate(async () => {
                            const result = await api.comment(bug.id, comment);
                            setComment('');
                            return result;
                          })
                        }
                      >
                        Comment
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="detail-section">
                <h3>Activity</h3>
                <div className="activity">
                  {bug.events.map((e) => (
                    <div key={e.id}>
                      <b style={{ color: 'var(--text-dim)' }}>{e.actor?.name ?? 'someone'}</b>{' '}
                      {describeEvent(e.type, e.detail)} · {when(e.createdAt)}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <aside>
              <div className="sidebar-row">
                <span>Column</span>
                <span style={{ color: column?.color }}>{column?.label ?? bug.status}</span>
              </div>
              <div className="sidebar-row">
                <span>{labelFor('severityShort', 'Severity')}</span>
                <span style={{ textAlign: 'right' }}>
                  <i className="sev-dot" style={{ background: levelColor(kind, bug.severity) }} />
                  {levelLabel(kind, bug.severity)}
                </span>
              </div>
              <div className="sidebar-row">
                <span>Reported by</span>
                <span>{bug.reporter?.name ?? 'unknown'}</span>
              </div>
              <div className="sidebar-row">
                <span>Raised</span>
                <span>{when(bug.createdAt)}</span>
              </div>
              <div className="sidebar-row">
                <span>Updated</span>
                <span>{when(bug.updatedAt)}</span>
              </div>
              {bug.appVersion && shows('appVersion') ? (
                <div className="sidebar-row">
                  <span>Version</span>
                  <span>{bug.appVersion}</span>
                </div>
              ) : null}
              {bug.environment ? (
                <div className="sidebar-row">
                  <span>Where</span>
                  <span style={{ textAlign: 'right' }}>{bug.environment}</span>
                </div>
              ) : null}
              {bug.externalRef ? (
                <div className="sidebar-row">
                  <span>Ref</span>
                  <span>{bug.externalRef}</span>
                </div>
              ) : null}

              {canManage ? (
                <div style={{ marginTop: 16 }}>
                  <div className="field">
                    <label htmlFor="bv-status">Move to</label>
                    <select
                      id="bv-status"
                      value={bug.status}
                      disabled={busy || bug.mergedIntoId !== null}
                      onChange={(e) => void mutate(() => api.moveBug(bug.id, e.target.value))}
                    >
                      {columns.map((c) => (
                        <option key={c.key} value={c.key}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="field">
                    <label htmlFor="bv-kind">Type</label>
                    <select
                      id="bv-kind"
                      value={bug.kind}
                      disabled={busy}
                      onChange={(e) =>
                        void mutate(() => api.updateBug(bug.id, { kind: e.target.value }))
                      }
                    >
                      {kinds.map((k) => (
                        <option key={k.key} value={k.key}>
                          {k.emoji} {k.label}
                        </option>
                      ))}
                    </select>
                    <div className="hint">Retyping hides or reveals the fields above.</div>
                  </div>

                  <div className="field">
                    <label htmlFor="bv-severity">{labelFor('severity', 'Severity')}</label>
                    <select
                      id="bv-severity"
                      value={bug.severity}
                      disabled={busy}
                      onChange={(e) =>
                        void mutate(() => api.updateBug(bug.id, { severity: e.target.value }))
                      }
                    >
                      {(kind?.levels ?? []).map((level) => (
                        <option key={level.key} value={level.key}>
                          {level.label}
                        </option>
                      ))}
                    </select>
                    <div className="hint">Sets the colour of the strip down the card.</div>
                  </div>

                  <div className="field">
                    <label htmlFor="bv-assignee">Assignee</label>
                    <select
                      id="bv-assignee"
                      value={bug.assignee?.id ?? ''}
                      disabled={busy}
                      onChange={(e) =>
                        void mutate(() =>
                          api.assignBug(bug.id, e.target.value ? Number(e.target.value) : null),
                        )
                      }
                    >
                      <option value="">Nobody</option>
                      {assignable.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                          {u.isBot ? ' (bot)' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="danger-zone">
                    <ConfirmButton
                      label="Delete this bug"
                      confirmLabel={`Delete #${bug.id} permanently`}
                      disabled={busy}
                      onConfirm={() => void removeBug()}
                    />
                    <div className="hint">
                      Removes the bug, its comments and its attachments for good.
                      {bug.duplicateCount > 0
                        ? ` Its ${bug.duplicateCount} merged duplicate(s) go back on the board.`
                        : ''}
                    </div>
                  </div>
                </div>
              ) : null}
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Two-step delete. An inline confirm rather than window.confirm: the native
 * dialog is jarring against this UI, and it lets the button say exactly what
 * is about to go.
 */
function ConfirmButton({
  label,
  confirmLabel,
  disabled,
  onConfirm,
}: {
  label: string;
  confirmLabel: string;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  // Disarm on its own, so a half-pressed delete cannot sit there waiting to be
  // hit by the next stray click.
  useEffect(() => {
    if (!armed) return;
    timer.current = window.setTimeout(() => setArmed(false), 5000);
    return () => window.clearTimeout(timer.current);
  }, [armed]);

  if (!armed) {
    return (
      <button className="btn small danger-outline" disabled={disabled} onClick={() => setArmed(true)}>
        {label}
      </button>
    );
  }

  return (
    <span className="confirm-row">
      <button className="btn small danger" disabled={disabled} onClick={onConfirm}>
        {confirmLabel}
      </button>
      <button className="btn small ghost" disabled={disabled} onClick={() => setArmed(false)}>
        Cancel
      </button>
    </span>
  );
}

function Field({
  label,
  value,
  rows,
  onChange,
}: {
  label: string;
  value: string;
  rows: number;
  onChange: (value: string) => void;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <textarea rows={rows} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function Section({ title, body }: { title: string; body: string }) {
  return (
    <div className="detail-section">
      <h3>{title}</h3>
      {body.trim() ? <p>{body}</p> : <p className="empty">Not given</p>}
    </div>
  );
}
