import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type {
  BoardColumn,
  BugCard,
  BugDetail,
  ItemKind,
  RelatedTicket,
  Session,
  User,
  Version,
} from '../types';
import { VersionPicker } from './VersionPicker';
import { Lightbox, type LightboxImage } from './Lightbox';
import { levelColor, levelLabel } from '../severity';

/**
 * Images and recordings only on a comment. A comment is where you show
 * somebody what you mean; a PDF belongs in the bug's own attachments.
 */
const COMMENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'video/webm',
  'video/mp4',
];

function when(iso: string): string {
  // SQLite hands back "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker.
  const date = new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z'));
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/**
 * `label` turns a stored column key into what people actually see. Column names
 * are display-only and can be renamed at any time; the trail would otherwise
 * still be quoting keys nobody recognises.
 */
function describeEvent(type: string, detail: string, label: (key: string) => string): string {
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
      return `moved it from ${label(String(data.from))} to ${label(String(data.to))}`;
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
    case 'blocked_by_added':
      return `marked this blocked by #${String(data.blocker)}`;
    case 'blocked_by_removed':
      return `removed #${String(data.blocker)} as a blocker`;
    case 'now_blocking':
      return `made this block #${String(data.blocked)}`;
    case 'no_longer_blocking':
      return `stopped this blocking #${String(data.blocked)}`;
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
  stackTrace?: string;
}

interface Props {
  bugId: number;
  /**
   * Bumped whenever a poll found the board had changed. Reading a ticket while
   * somebody comments on it should not mean reading a stale one.
   */
  liveTick?: number;
  session: Session;
  columns: BoardColumn[];
  environments: string[];
  kinds: ItemKind[];
  versions: Version[];
  onChanged: (bug: BugDetail) => void;
  onDeleted: (id: number) => void;
  onClose: () => void;
  onOpenOther: (id: number) => void;
}

export function BugView({
  bugId,
  liveTick = 0,
  session,
  columns,
  environments,
  kinds,
  versions,
  onChanged,
  onDeleted,
  onClose,
  onOpenOther,
}: Props) {
  const [bug, setBug] = useState<BugDetail | null>(null);
  const [assignable, setAssignable] = useState<User[]>([]);
  const [comment, setComment] = useState('');
  /** Staged for the comment being written, with a preview URL to revoke. */
  const [commentFiles, setCommentFiles] = useState<Array<{ file: File; preview: string }>>([]);
  const [commentDragOver, setCommentDragOver] = useState(false);
  const commentInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [candidates, setCandidates] = useState<BugCard[]>([]);
  const [blockerChoice, setBlockerChoice] = useState('');
  /** Which attachment is open full size, if any. */
  const [viewing, setViewing] = useState<number | null>(null);
  /** Comments that arrived while this ticket was open, so they announce themselves. */
  const [freshComments, setFreshComments] = useState<Set<number>>(new Set());

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

  /**
   * Every image on the ticket in reading order — the gallery, then the thread —
   * so opening one and pressing the arrow keys walks all of them rather than
   * only the group it happened to be in.
   */
  const images: LightboxImage[] = bug
    ? [...bug.attachments, ...bug.comments.flatMap((c) => c.attachments)]
        .filter((a) => a.mime.startsWith('image/'))
        .map((a) => ({ url: a.url, name: a.name }))
    : [];

  const openImage = (url: string) => setViewing(images.findIndex((i) => i.url === url));

  function stageForComment(list: FileList | File[]) {
    const staged = [...list]
      .filter((file) => COMMENT_TYPES.includes(file.type))
      .map((file) => ({ file, preview: URL.createObjectURL(file) }));

    setCommentFiles((prev) => [...prev, ...staged].slice(0, 10));
  }

  function dropStaged(index: number) {
    setCommentFiles((prev) => {
      URL.revokeObjectURL(prev[index].preview);
      return prev.filter((_, i) => i !== index);
    });
  }

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

  /**
   * Pick up what changed underneath, without the view flinching.
   *
   * Deliberately not the loader above: that clears the ticket to null first,
   * which is right when you open a different one and very wrong here — it
   * would blank what somebody is reading. Skipped entirely while an edit is
   * open, because replacing the ticket under a half-typed form is worse than
   * being a few seconds behind.
   */
  useEffect(() => {
    if (!liveTick || draft !== null) return;

    let live = true;
    void api
      .bug(bugId)
      .then(({ bug: fresh }) => {
        if (!live) return;

        setBug((current) => {
          // Anything said while this was open gets a moment of attention.
          if (current) {
            const known = new Set(current.comments.map((c) => c.id));
            const arrived = fresh.comments.filter((c) => !known.has(c.id)).map((c) => c.id);
            if (arrived.length) setFreshComments(new Set(arrived));
          }
          return fresh;
        });
      })
      .catch(() => {
        /* the ticket on screen stands until a read succeeds */
      });

    return () => {
      live = false;
    };
    // draft is read, not depended on: finishing an edit should not trigger a
    // re-read that discards what was just saved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveTick, bugId]);

  // The highlight is an announcement, not a state.
  useEffect(() => {
    if (!freshComments.size) return;
    const timer = setTimeout(() => setFreshComments(new Set()), 4000);
    return () => clearTimeout(timer);
  }, [freshComments]);

  useEffect(() => {
    if (!canManage) return;
    void api
      .assignable()
      .then(({ users }) => setAssignable(users))
      .catch(() => setAssignable([]));
    void api
      .bugs()
      .then(({ bugs }) => setCandidates(bugs))
      .catch(() => setCandidates([]));
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
      // A reporter editing their own bug is served an empty trace, so it must
      // never enter the draft — saving would otherwise wipe what they cannot see.
      stackTrace: canManage ? bug.stackTrace : undefined,
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
      if (value === undefined) continue; // a field this editor cannot see
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
  const columnLabel = (key: string) => columns.find((c) => c.key === key)?.label ?? key;
  const kind = kinds.find((k) => k.key === bug.kind);
  const shows = (field: string) => !kind?.hiddenFields.includes(field);
  const labelFor = (field: string, fallback: string) => kind?.labels[field] ?? fallback;

  return (
    <div className="scrim" onClick={onClose}>
      {/*
        Above the ticket rather than inside it: it covers the screen, and the
        scrim's own click-to-close must not fire behind it.
      */}
      {viewing !== null && viewing >= 0 ? (
        <div onClick={(e) => e.stopPropagation()}>
          <Lightbox images={images} index={viewing} onClose={() => setViewing(null)} />
        </div>
      ) : null}

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
                  {shows('stackTrace') && canManage ? (
                    <div className="field">
                      <label htmlFor="bv-stack">Stack trace</label>
                      <textarea
                        id="bv-stack"
                        className="mono"
                        rows={5}
                        value={draft.stackTrace ?? ''}
                        onChange={(e) => setDraft({ ...draft, stackTrace: e.target.value })}
                      />
                      <div className="hint">
                        Editing this re-matches future reports, so an existing count stays
                        but new crashes will only join if they match the new text.
                      </div>
                    </div>
                  ) : null}

                  <div className="field-row">
                    {shows('appVersion') ? (
                      <div className="field">
                        <label htmlFor="bv-version">ezmuze version</label>
                        <VersionPicker
                          id="bv-version"
                          value={draft.appVersion}
                          versions={versions}
                          onChange={(v) => setDraft({ ...draft, appVersion: v })}
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
                  {shows('stackTrace') && bug.hasStackTrace ? (
                    <div className="detail-section">
                      <h3>Stack trace</h3>
                      {bug.stackTrace ? (
                        <>
                          <pre className="stack">{bug.stackTrace}</pre>
                          <div className="hint">
                            Paths and usernames were generalised before saving; this is what
                            new reports are matched against.
                          </div>
                        </>
                      ) : (
                        <p className="empty" style={{ color: 'var(--text-faint)' }}>
                          A stack trace was sent with this report. Managers can read it.
                        </p>
                      )}
                    </div>
                  ) : null}
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
                          {/*
                            Still an anchor: a middle-click or ctrl-click should
                            keep working and open the file itself. Only a plain
                            click is taken over.
                          */}
                          <a
                            href={a.url}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => {
                              if (!a.mime.startsWith('image/')) return;
                              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                              e.preventDefault();
                              openImage(a.url);
                            }}
                          >
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

              {bug.blockedBy.length || bug.blocking.length || canManage ? (
                <div className="detail-section">
                  <h3>Dependencies</h3>

                  <div className="dep-group">
                    <span className="dep-label">Blocked by</span>
                    {bug.blockedBy.length ? (
                      <div className="dep-list">
                        {bug.blockedBy.map((t) => (
                          <TicketChip
                            key={t.id}
                            ticket={t}
                            onOpen={onOpenOther}
                            onRemove={
                              canManage && !busy
                                ? () => void mutate(() => api.removeBlocker(bug.id, t.id))
                                : undefined
                            }
                          />
                        ))}
                      </div>
                    ) : (
                      <span className="dep-none">Nothing — this one can start</span>
                    )}
                  </div>

                  <div className="dep-group">
                    <span className="dep-label">Blocking</span>
                    {bug.blocking.length ? (
                      <div className="dep-list">
                        {bug.blocking.map((t) => (
                          <TicketChip
                            key={t.id}
                            ticket={t}
                            onOpen={onOpenOther}
                            onRemove={
                              canManage && !busy
                                ? () => void mutate(() => api.removeBlocker(t.id, bug.id))
                                : undefined
                            }
                          />
                        ))}
                      </div>
                    ) : (
                      <span className="dep-none">Nothing is waiting on this</span>
                    )}
                  </div>

                  {canManage ? (
                    <div className="dep-add">
                      <select
                        aria-label="Add a blocker"
                        value={blockerChoice}
                        disabled={busy}
                        onChange={(e) => setBlockerChoice(e.target.value)}
                      >
                        <option value="">Blocked by…</option>
                        {candidates
                          .filter(
                            (c) =>
                              c.id !== bug.id &&
                              !bug.blockedBy.some((t) => t.id === c.id) &&
                              // Offering something this ticket already blocks
                              // would only produce a cycle the server refuses.
                              !bug.blocking.some((t) => t.id === c.id),
                          )
                          .map((c) => (
                            <option key={c.id} value={c.id}>
                              #{c.id} — {c.title.slice(0, 60)}
                            </option>
                          ))}
                      </select>
                      <button
                        className="btn small"
                        disabled={busy || !blockerChoice}
                        onClick={() =>
                          void mutate(async () => {
                            const result = await api.addBlocker(bug.id, Number(blockerChoice));
                            setBlockerChoice('');
                            return result;
                          })
                        }
                      >
                        Add
                      </button>
                    </div>
                  ) : null}
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
                      <div
                        className={`comment${freshComments.has(c.id) ? ' just-arrived' : ''}`}
                        key={c.id}
                      >
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
                        {c.body ? <p>{c.body}</p> : null}

                        {c.attachments.length ? (
                          <div className="comment-shots">
                            {c.attachments.map((a) =>
                              a.mime.startsWith('video/') ? (
                                <div className="comment-shot" key={a.id} title={a.name}>
                                  <video src={a.url} controls preload="metadata" playsInline />
                                  {canRemoveAttachment(a.uploadedBy?.id) ? (
                                    <button
                                      className="shot-remove"
                                      title="Remove this image"
                                      disabled={busy}
                                      onClick={() => void mutate(() => api.deleteAttachment(a.id))}
                                    >
                                      ×
                                    </button>
                                  ) : null}
                                </div>
                              ) : (
                                <div className="comment-shot" key={a.id} title={a.name}>
                                  <a
                                    href={a.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    onClick={(e) => {
                                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) {
                                        return;
                                      }
                                      e.preventDefault();
                                      openImage(a.url);
                                    }}
                                  >
                                    <img src={a.url} alt={a.name} />
                                  </a>
                                  {canRemoveAttachment(a.uploadedBy?.id) ? (
                                    <button
                                      className="shot-remove"
                                      title="Remove this image"
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
                        ) : null}
                      </div>
                    ))
                  )}
                </div>

                {canWrite ? (
                  <div
                    className={`composer${commentDragOver ? ' over' : ''}`}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setCommentDragOver(true);
                    }}
                    onDragLeave={() => setCommentDragOver(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setCommentDragOver(false);
                      stageForComment(e.dataTransfer.files);
                    }}
                    /* A screenshot is on the clipboard far more often than on disk. */
                    onPaste={(e) => {
                      if (e.clipboardData.files.length) {
                        e.preventDefault();
                        stageForComment(e.clipboardData.files);
                      }
                    }}
                  >
                    <textarea
                      rows={3}
                      value={comment}
                      placeholder="Add a comment — paste or drop an image to show what you mean"
                      onChange={(e) => setComment(e.target.value)}
                    />

                    {commentFiles.length ? (
                      <div className="comment-shots staged">
                        {commentFiles.map((f, i) => (
                          <div className="comment-shot" key={`${f.file.name}-${i}`}>
                            {f.file.type.startsWith('video/') ? (
                              <video src={f.preview} muted playsInline preload="metadata" />
                            ) : (
                              <img src={f.preview} alt={f.file.name} />
                            )}
                            <button
                              className="shot-remove"
                              title="Do not send this one"
                              disabled={busy}
                              onClick={() => dropStaged(i)}
                            >
                              ×
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : null}

                    <div className="composer-actions">
                      <button
                        className="btn small"
                        disabled={busy}
                        onClick={() => commentInput.current?.click()}
                      >
                        Add image
                      </button>
                      <input
                        ref={commentInput}
                        type="file"
                        accept={COMMENT_TYPES.join(',')}
                        multiple
                        hidden
                        onChange={(e) => {
                          if (e.target.files) stageForComment(e.target.files);
                          e.target.value = '';
                        }}
                      />
                      <button
                        className="btn primary small"
                        /* A picture on its own says plenty. */
                        disabled={busy || (!comment.trim() && !commentFiles.length)}
                        onClick={() =>
                          void mutate(async () => {
                            const result = await api.comment(
                              bug.id,
                              comment,
                              commentFiles.map((f) => f.file),
                            );
                            for (const f of commentFiles) URL.revokeObjectURL(f.preview);
                            setComment('');
                            setCommentFiles([]);
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
                      {describeEvent(e.type, e.detail, columnLabel)} · {when(e.createdAt)}
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
              {bug.occurrences > 1 ? (
                <div className="sidebar-row">
                  <span>Seen</span>
                  <span title="Automatic reports matching this stack trace">
                    {bug.occurrences.toLocaleString()} times
                  </span>
                </div>
              ) : null}
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

function TicketChip({
  ticket,
  onOpen,
  onRemove,
}: {
  ticket: RelatedTicket;
  onOpen: (id: number) => void;
  onRemove?: () => void;
}) {
  return (
    <span className="dep-chip">
      <button className="dep-open" onClick={() => onOpen(ticket.id)} title={ticket.title}>
        <span className="dep-id">#{ticket.id}</span> {ticket.title}
      </button>
      {onRemove ? (
        <button className="dep-remove" onClick={onRemove} aria-label={`Remove #${ticket.id}`}>
          ×
        </button>
      ) : null}
    </span>
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
