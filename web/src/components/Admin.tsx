import { useEffect, useState } from 'react';
import { api } from '../api';
import type { AdminColumn, AdminUser, BoardSettings } from '../types';
import { EnvironmentsTab, TypesTab } from './AdminCatalog';
import { EmailTab, SignInTab, UploadsFields } from './AdminInstance';
import { TokensTab } from './AdminTokens';

type Tab =
  | 'board'
  | 'lanes'
  | 'types'
  | 'environments'
  | 'signin'
  | 'email'
  | 'users'
  | 'tokens';

/**
 * Everything an instance owner needs and nobody else should have: the board's
 * own name, the shape of its lanes, and who is allowed to move things around.
 */
export function Admin({
  meId,
  onChanged,
  onClose,
}: {
  meId: number;
  /** Lanes and the board name are in /api/meta, so the app must re-read it. */
  onChanged: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>('board');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await work();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Administration</h2>
          <button className="close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="tabs">
          {(
            [
              'board',
              'lanes',
              'types',
              'environments',
              'signin',
              'email',
              'users',
              'tokens',
            ] as Tab[]
          ).map((t) => (
            <button
              key={t}
              className={`tab${tab === t ? ' active' : ''}`}
              onClick={() => {
                setTab(t);
                setError('');
              }}
            >
              {
                {
                  board: 'Board',
                  lanes: 'Lanes',
                  types: 'Types',
                  environments: 'Environments',
                  signin: 'Sign-in',
                  email: 'Email',
                  users: 'Users',
                  tokens: 'API tokens',
                }[t]
              }
            </button>
          ))}
        </div>

        <div className="modal-body">
          {error ? <div className="error">{error}</div> : null}
          {tab === 'board' ? <BoardTab busy={busy} run={run} /> : null}
          {tab === 'lanes' ? <LanesTab busy={busy} run={run} /> : null}
          {tab === 'types' ? <TypesTab busy={busy} run={run} /> : null}
          {tab === 'signin' ? <SignInTab busy={busy} run={run} /> : null}
          {tab === 'email' ? <EmailTab busy={busy} run={run} /> : null}
          {tab === 'environments' ? <EnvironmentsTab busy={busy} run={run} /> : null}
          {tab === 'users' ? <UsersTab meId={meId} busy={busy} run={run} /> : null}
          {tab === 'tokens' ? <TokensTab busy={busy} run={run} /> : null}
        </div>
      </div>
    </div>
  );
}

type Runner = (work: () => Promise<unknown>) => Promise<void>;

// --------------------------------------------------------------------- board

function BoardTab({ busy, run }: { busy: boolean; run: Runner }) {
  const [settings, setSettings] = useState<BoardSettings | null>(null);

  useEffect(() => {
    void api
      .adminSettings()
      .then((r) => setSettings(r.settings))
      .catch(() => setSettings({ name: '', tagline: '' }));
  }, []);

  if (!settings) {
    return (
      <div className="center-note">
        <span className="spinner" /> Loading…
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 460 }}>
      <div className="field">
        <label htmlFor="ad-name">Board name</label>
        <input
          id="ad-name"
          type="text"
          value={settings.name}
          onChange={(e) => setSettings({ ...settings, name: e.target.value })}
        />
        <div className="hint">Shown in the top bar and the browser tab.</div>
      </div>

      <div className="field">
        <label htmlFor="ad-tagline">Tagline</label>
        <input
          id="ad-tagline"
          type="text"
          value={settings.tagline}
          placeholder="Optional"
          onChange={(e) => setSettings({ ...settings, tagline: e.target.value })}
        />
      </div>

      <hr style={{ border: 0, borderTop: '1px solid var(--border-soft)', margin: '18px 0' }} />
      <UploadsFields busy={busy} run={run} />

      <button
        className="btn primary"
        disabled={busy || !settings.name.trim()}
        onClick={() =>
          void run(async () => {
            const r = await api.updateAdminSettings(settings);
            setSettings(r.settings);
          })
        }
      >
        Save
      </button>
    </div>
  );
}

// --------------------------------------------------------------------- lanes

function LanesTab({ busy, run }: { busy: boolean; run: Runner }) {
  const [lanes, setLanes] = useState<AdminColumn[]>([]);
  const [newLabel, setNewLabel] = useState('');
  const [removing, setRemoving] = useState<AdminColumn | null>(null);
  const [moveTo, setMoveTo] = useState('');

  const reload = () => api.adminColumns().then((r) => setLanes(r.columns));
  useEffect(() => {
    void reload().catch(() => setLanes([]));
  }, []);

  /** Reorder sends the whole order, so there is never a half-applied state. */
  function move(index: number, delta: number) {
    const next = [...lanes];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setLanes(next);
    void run(async () => {
      await api.reorderColumns(next.map((l) => l.id));
      await reload();
    });
  }

  return (
    <>
      <p className="hint" style={{ marginTop: 0 }}>
        Lanes are the columns on the board, left to right. Renaming one is safe — tickets
        remember a lane by an internal key, not by its name.
      </p>

      <table className="table lanes">
        <thead>
          <tr>
            <th style={{ width: 70 }}>Order</th>
            <th>Name</th>
            <th style={{ width: 70 }}>Colour</th>
            <th style={{ width: 90 }}>Intake</th>
            <th className="num" style={{ width: 70 }}>Tickets</th>
            <th style={{ width: 80 }}></th>
          </tr>
        </thead>
        <tbody>
          {lanes.map((lane, i) => (
            <tr key={lane.id}>
              <td>
                <button
                  className="btn small ghost"
                  disabled={busy || i === 0}
                  aria-label={`Move ${lane.label} left`}
                  onClick={() => move(i, -1)}
                >
                  ↑
                </button>{' '}
                <button
                  className="btn small ghost"
                  disabled={busy || i === lanes.length - 1}
                  aria-label={`Move ${lane.label} right`}
                  onClick={() => move(i, 1)}
                >
                  ↓
                </button>
              </td>
              <td>
                <input
                  type="text"
                  value={lane.label}
                  disabled={busy}
                  onChange={(e) =>
                    setLanes(lanes.map((l) => (l.id === lane.id ? { ...l, label: e.target.value } : l)))
                  }
                  onBlur={(e) => {
                    const label = e.target.value.trim();
                    if (!label || label === lane.label.trim()) return;
                    void run(async () => {
                      await api.updateColumn(lane.id, { label });
                      await reload();
                    });
                  }}
                />
                <div className="lane-key">{lane.key}</div>
              </td>
              <td>
                <input
                  type="color"
                  value={lane.color}
                  disabled={busy}
                  aria-label={`Colour for ${lane.label}`}
                  onChange={(e) =>
                    void run(async () => {
                      await api.updateColumn(lane.id, { color: e.target.value });
                      await reload();
                    })
                  }
                />
              </td>
              <td>
                {lane.intake ? (
                  <span className="pill">new reports</span>
                ) : (
                  <button
                    className="btn small ghost"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await api.updateColumn(lane.id, { intake: true });
                        await reload();
                      })
                    }
                  >
                    Make intake
                  </button>
                )}
              </td>
              <td className="num">{lane.bugCount}</td>
              <td>
                <button
                  className="btn small danger-outline"
                  disabled={busy || lane.intake || lanes.length === 1}
                  title={lane.intake ? 'The intake lane cannot be removed' : undefined}
                  onClick={() => {
                    setRemoving(lane);
                    setMoveTo(lanes.find((l) => l.id !== lane.id)?.key ?? '');
                  }}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {removing ? (
        <div className="notice" style={{ marginTop: 14 }}>
          Remove <b>{removing.label}</b>?
          {removing.bugCount > 0 ? (
            <>
              {' '}
              Its {removing.bugCount} ticket(s) move to{' '}
              <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)} style={{ width: 'auto' }}>
                {lanes
                  .filter((l) => l.id !== removing.id)
                  .map((l) => (
                    <option key={l.id} value={l.key}>
                      {l.label}
                    </option>
                  ))}
              </select>
            </>
          ) : (
            ' It is empty.'
          )}
          <div className="confirm-row" style={{ marginTop: 10 }}>
            <button
              className="btn small danger"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await api.deleteColumn(removing.id, removing.bugCount > 0 ? moveTo : undefined);
                  setRemoving(null);
                  await reload();
                })
              }
            >
              Remove it
            </button>
            <button className="btn small ghost" disabled={busy} onClick={() => setRemoving(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <div className="dep-add" style={{ marginTop: 16 }}>
        <input
          type="text"
          placeholder="New lane name"
          value={newLabel}
          disabled={busy}
          onChange={(e) => setNewLabel(e.target.value)}
        />
        <button
          className="btn"
          disabled={busy || !newLabel.trim()}
          onClick={() =>
            void run(async () => {
              await api.createColumn({ label: newLabel.trim() });
              setNewLabel('');
              await reload();
            })
          }
        >
          Add lane
        </button>
      </div>
    </>
  );
}

// --------------------------------------------------------------------- users

function UsersTab({ meId, busy, run }: { meId: number; busy: boolean; run: Runner }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [query, setQuery] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => {
      void api
        .users(query || undefined)
        .then((r) => setUsers(r.users))
        .catch(() => setUsers([]));
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  return (
    <>
      <input
        className="search"
        type="text"
        placeholder="Filter by name"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{ marginBottom: 12 }}
      />

      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th style={{ width: 130 }}>Role</th>
            <th className="num">Raised</th>
            <th className="num">Assigned</th>
            <th>Last seen</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>
                {u.name}
                {u.isBot ? <span className="pill bot" style={{ marginLeft: 6 }}>bot</span> : null}
                {u.id === meId ? <span className="pill" style={{ marginLeft: 6 }}>you</span> : null}
              </td>
              <td>
                <select
                  value={u.role}
                  disabled={busy || u.id === meId}
                  title={u.id === meId ? 'You cannot change your own role' : undefined}
                  onChange={(e) =>
                    void run(async () => {
                      await api.setRole(u.id, e.target.value);
                      const r = await api.users(query || undefined);
                      setUsers(r.users);
                    })
                  }
                >
                  <option value="user">user</option>
                  <option value="manager">manager</option>
                  <option value="admin">admin</option>
                </select>
              </td>
              <td className="num">{u.reportedCount}</td>
              <td className="num">{u.assignedCount}</td>
              <td style={{ color: 'var(--text-faint)', fontSize: 12 }}>
                {u.lastSeenAt ? u.lastSeenAt.split(' ')[0] : '—'}
              </td>
            </tr>
          ))}
          {users.length === 0 ? (
            <tr>
              <td colSpan={5} style={{ color: 'var(--text-faint)', textAlign: 'center' }}>
                Nobody matches that.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>

      <p className="hint">
        Managers move tickets between lanes, merge duplicates and read stack traces. Admins
        can do that and everything on this dialog.
      </p>
    </>
  );
}
