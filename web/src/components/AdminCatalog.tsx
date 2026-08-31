import { useEffect, useState } from 'react';
import { api } from '../api';
import type { AdminKind, AdminEnvironment } from '../types';

type Runner = (work: () => Promise<unknown>) => Promise<void>;

/**
 * Ticket types, their scales, and where a bug can have happened — the last of
 * what used to be hardcoded. An instance that tracks something other than
 * software bugs reshapes it all from here.
 */
export function TypesTab({ busy, run }: { busy: boolean; run: Runner }) {
  const [kinds, setKinds] = useState<AdminKind[]>([]);
  const [hideable, setHideable] = useState<string[]>([]);
  const [newLabel, setNewLabel] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const reload = () =>
    api.adminKinds().then((r) => {
      setKinds(r.kinds);
      setHideable(r.hideableFields);
    });

  useEffect(() => {
    void reload().catch(() => setKinds([]));
  }, []);

  const save = (work: () => Promise<unknown>) => run(async () => { await work(); await reload(); });

  return (
    <>
      <p className="hint" style={{ marginTop: 0 }}>
        A type is what a ticket <i>is</i>. Each has its own scale and can hide the fields that
        make no sense for it. Renaming is safe — tickets remember a type by an internal key.
      </p>

      {kinds.map((kind) => (
        <div className="kind-card" key={kind.id}>
          <div className="kind-head">
            <input
              className="kind-emoji-input"
              value={kind.emoji}
              disabled={busy}
              aria-label={`Emoji for ${kind.label}`}
              onChange={(e) =>
                setKinds(kinds.map((k) => (k.id === kind.id ? { ...k, emoji: e.target.value } : k)))
              }
              onBlur={(e) =>
                e.target.value.trim() && e.target.value !== kind.emoji
                  ? void save(() => api.updateKind(kind.id, { emoji: e.target.value.trim() }))
                  : undefined
              }
            />
            <input
              type="text"
              value={kind.label}
              disabled={busy}
              aria-label={`Name of ${kind.label}`}
              onChange={(e) =>
                setKinds(kinds.map((k) => (k.id === kind.id ? { ...k, label: e.target.value } : k)))
              }
              onBlur={(e) => {
                const label = e.target.value.trim();
                if (label) void save(() => api.updateKind(kind.id, { label }));
              }}
            />
            <span className="lane-key">{kind.key}</span>
            <span className="num" style={{ color: 'var(--text-faint)', fontSize: 12 }}>
              {kind.bugCount} ticket{kind.bugCount === 1 ? '' : 's'}
            </span>
            <button
              className="btn small ghost"
              onClick={() => setOpen(open === kind.key ? null : kind.key)}
            >
              {open === kind.key ? 'Done' : 'Edit'}
            </button>
            <button
              className="btn small danger-outline"
              disabled={busy || kinds.length === 1}
              onClick={() => {
                const other = kinds.find((k) => k.id !== kind.id);
                if (!other) return;
                if (kind.bugCount > 0 && !confirm(
                  `Move ${kind.bugCount} ticket(s) to "${other.label}" and remove "${kind.label}"?`,
                )) return;
                void save(() =>
                  api.deleteKind(kind.id, kind.bugCount > 0 ? other.key : undefined),
                );
              }}
            >
              Remove
            </button>
          </div>

          {open === kind.key ? (
            <div className="kind-body">
              <div className="field">
                <label>Raise menu wording</label>
                <input
                  type="text"
                  defaultValue={kind.article}
                  disabled={busy}
                  onBlur={(e) =>
                    e.target.value.trim() !== kind.article
                      ? void save(() => api.updateKind(kind.id, { article: e.target.value.trim() }))
                      : undefined
                  }
                />
                <div className="hint">Reads as "Raise {kind.article}".</div>
              </div>

              <div className="field">
                <label>Hide these fields</label>
                <div className="checks">
                  {hideable.map((field) => (
                    <label key={field} className="check">
                      <input
                        type="checkbox"
                        disabled={busy}
                        checked={kind.hiddenFields.includes(field)}
                        onChange={(e) => {
                          const next = e.target.checked
                            ? [...kind.hiddenFields, field]
                            : kind.hiddenFields.filter((f) => f !== field);
                          void save(() => api.updateKind(kind.id, { hiddenFields: next }));
                        }}
                      />
                      {field}
                    </label>
                  ))}
                </div>
              </div>

              <div className="field-row">
                {(['description', 'severity', 'severityShort', 'titlePlaceholder'] as const).map(
                  (slot) => (
                    <div className="field" key={slot}>
                      <label>{slot}</label>
                      <input
                        type="text"
                        defaultValue={kind.labels[slot] ?? ''}
                        placeholder="default"
                        disabled={busy}
                        onBlur={(e) =>
                          void save(() =>
                            api.updateKind(kind.id, {
                              labels: { ...kind.labels, [slot]: e.target.value },
                            }),
                          )
                        }
                      />
                    </div>
                  ),
                )}
              </div>

              <div className="field">
                <label>Scale — most pressing first</label>
                <table className="table lanes">
                  <tbody>
                    {kind.levels.map((level, i) => (
                      <tr key={level.key}>
                        <td style={{ width: 66 }}>
                          <button
                            className="btn small ghost"
                            disabled={busy || i === 0}
                            aria-label="Move up"
                            onClick={() => {
                              const keys = kind.levels.map((l) => l.key);
                              [keys[i - 1], keys[i]] = [keys[i], keys[i - 1]];
                              void save(() => api.reorderLevels(kind.id, keys));
                            }}
                          >
                            ↑
                          </button>{' '}
                          <button
                            className="btn small ghost"
                            disabled={busy || i === kind.levels.length - 1}
                            aria-label="Move down"
                            onClick={() => {
                              const keys = kind.levels.map((l) => l.key);
                              [keys[i + 1], keys[i]] = [keys[i], keys[i + 1]];
                              void save(() => api.reorderLevels(kind.id, keys));
                            }}
                          >
                            ↓
                          </button>
                        </td>
                        <td>
                          <input
                            type="text"
                            defaultValue={level.label}
                            disabled={busy}
                            aria-label="Level name"
                            onBlur={(e) =>
                              e.target.value.trim() && e.target.value !== level.label
                                ? void save(() =>
                                    api.updateLevel(kind.id, level.key, { label: e.target.value.trim() }),
                                  )
                                : undefined
                            }
                          />
                          <div className="lane-key">{level.key}</div>
                        </td>
                        <td style={{ width: 130 }}>
                          <input
                            type="text"
                            defaultValue={level.short}
                            disabled={busy}
                            aria-label="Short name for cards"
                            onBlur={(e) =>
                              e.target.value.trim() && e.target.value !== level.short
                                ? void save(() =>
                                    api.updateLevel(kind.id, level.key, { short: e.target.value.trim() }),
                                  )
                                : undefined
                            }
                          />
                        </td>
                        <td style={{ width: 56 }}>
                          <input
                            type="color"
                            value={level.color}
                            disabled={busy}
                            aria-label="Level colour"
                            onChange={(e) =>
                              void save(() =>
                                api.updateLevel(kind.id, level.key, { color: e.target.value }),
                              )
                            }
                          />
                        </td>
                        <td className="num" style={{ width: 60 }}>{level.bugCount}</td>
                        <td style={{ width: 80 }}>
                          <button
                            className="btn small danger-outline"
                            disabled={busy || kind.levels.length === 1}
                            onClick={() => {
                              const other = kind.levels.find((l) => l.key !== level.key);
                              if (!other) return;
                              if (level.bugCount > 0 && !confirm(
                                `Move ${level.bugCount} ticket(s) to "${other.label}"?`,
                              )) return;
                              void save(() =>
                                api.deleteLevel(
                                  kind.id,
                                  level.key,
                                  level.bugCount > 0 ? other.key : undefined,
                                ),
                              );
                            }}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <AddLevel kindId={kind.id} busy={busy} onAdd={save} />
              </div>
            </div>
          ) : null}
        </div>
      ))}

      <div className="dep-add" style={{ marginTop: 16 }}>
        <input
          type="text"
          placeholder="New type name"
          value={newLabel}
          disabled={busy}
          onChange={(e) => setNewLabel(e.target.value)}
        />
        <button
          className="btn"
          disabled={busy || !newLabel.trim()}
          onClick={() =>
            void save(async () => {
              await api.createKind({ label: newLabel.trim() });
              setNewLabel('');
            })
          }
        >
          Add type
        </button>
      </div>
    </>
  );
}

function AddLevel({
  kindId,
  busy,
  onAdd,
}: {
  kindId: number;
  busy: boolean;
  onAdd: Runner;
}) {
  const [label, setLabel] = useState('');
  return (
    <div className="dep-add">
      <input
        type="text"
        placeholder="New level name"
        value={label}
        disabled={busy}
        onChange={(e) => setLabel(e.target.value)}
      />
      <button
        className="btn small"
        disabled={busy || !label.trim()}
        onClick={() =>
          void onAdd(async () => {
            await api.createLevel(kindId, { label: label.trim() });
            setLabel('');
          })
        }
      >
        Add level
      </button>
    </div>
  );
}

// -------------------------------------------------------------- environments

export function EnvironmentsTab({ busy, run }: { busy: boolean; run: Runner }) {
  const [rows, setRows] = useState<AdminEnvironment[]>([]);
  const [label, setLabel] = useState('');

  const reload = () => api.adminEnvironments().then((r) => setRows(r.environments));
  useEffect(() => {
    void reload().catch(() => setRows([]));
  }, []);

  const save = (work: () => Promise<unknown>) => run(async () => { await work(); await reload(); });

  return (
    <>
      <p className="hint" style={{ marginTop: 0 }}>
        Where a bug happened, as offered by the report form. Tickets keep this as plain text,
        so removing one never changes anything already reported.
      </p>

      <table className="table lanes">
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.id}>
              <td style={{ width: 66 }}>
                <button
                  className="btn small ghost"
                  disabled={busy || i === 0}
                  aria-label="Move up"
                  onClick={() => {
                    const ids = rows.map((r) => r.id);
                    [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
                    void save(() => api.reorderEnvironments(ids));
                  }}
                >
                  ↑
                </button>{' '}
                <button
                  className="btn small ghost"
                  disabled={busy || i === rows.length - 1}
                  aria-label="Move down"
                  onClick={() => {
                    const ids = rows.map((r) => r.id);
                    [ids[i + 1], ids[i]] = [ids[i], ids[i + 1]];
                    void save(() => api.reorderEnvironments(ids));
                  }}
                >
                  ↓
                </button>
              </td>
              <td>{row.label}</td>
              <td style={{ width: 80 }}>
                <button
                  className="btn small danger-outline"
                  disabled={busy}
                  onClick={() => void save(() => api.deleteEnvironment(row.id))}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="dep-add" style={{ marginTop: 14 }}>
        <input
          type="text"
          placeholder="e.g. Android, or Web — Opera"
          value={label}
          disabled={busy}
          onChange={(e) => setLabel(e.target.value)}
        />
        <button
          className="btn"
          disabled={busy || !label.trim()}
          onClick={() =>
            void save(async () => {
              await api.createEnvironment(label.trim());
              setLabel('');
            })
          }
        >
          Add
        </button>
      </div>
    </>
  );
}
