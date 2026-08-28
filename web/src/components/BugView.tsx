import { useEffect, useState } from 'react';
import { api } from '../api';
import type { BoardColumn, BugDetail, Session, User } from '../types';

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
    default:
      return type;
  }
}

interface Props {
  bugId: number;
  session: Session;
  columns: BoardColumn[];
  onChanged: (bug: BugDetail) => void;
  onClose: () => void;
  onOpenOther: (id: number) => void;
}

export function BugView({ bugId, session, columns, onChanged, onClose, onOpenOther }: Props) {
  const [bug, setBug] = useState<BugDetail | null>(null);
  const [assignable, setAssignable] = useState<User[]>([]);
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const canManage = session.scopes?.includes('manage') ?? false;
  const canWrite = session.scopes?.includes('write') ?? false;

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

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="id" style={{ color: 'var(--text-faint)' }}>
            #{bug.id}
          </span>
          <h2>{bug.title}</h2>
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
              <Section title="What happened" body={bug.description} />
              <Section title="Steps to reproduce" body={bug.steps} />
              <Section title="Expected" body={bug.expected} />
              <Section title="Actual" body={bug.actual} />

              {bug.attachments.length ? (
                <div className="detail-section">
                  <h3>Attachments</h3>
                  <div className="shots">
                    {bug.attachments.map((a) => (
                      <a key={a.id} href={a.url} target="_blank" rel="noreferrer" title={a.name}>
                        {a.mime.startsWith('image/') ? (
                          <img src={a.url} alt={a.name} />
                        ) : (
                          <span className="file-link">{a.name}</span>
                        )}
                      </a>
                    ))}
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
                <span>Severity</span>
                <span>{bug.severity}</span>
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
              {bug.appVersion ? (
                <div className="sidebar-row">
                  <span>Version</span>
                  <span>{bug.appVersion}</span>
                </div>
              ) : null}
              {bug.environment ? (
                <div className="sidebar-row">
                  <span>Machine</span>
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
                </div>
              ) : null}
            </aside>
          </div>
        </div>
      </div>
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
