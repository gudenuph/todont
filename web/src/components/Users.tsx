import { useEffect, useState } from 'react';
import { api } from '../api';
import type { AdminUser } from '../types';

/** Admin-only: who has signed in, and who is allowed to move bugs around. */
export function Users({ meId, onClose }: { meId: number; onClose: () => void }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      void api
        .users(query || undefined)
        .then((r) => setUsers(r.users))
        .catch((err: unknown) =>
          setError(err instanceof Error ? err.message : 'Could not load users'),
        );
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  async function setRole(id: number, role: string) {
    setBusyId(id);
    setError('');
    try {
      await api.setRole(id, role);
      setUsers((prev) =>
        prev.map((u) => (u.id === id ? { ...u, role: role as AdminUser['role'] } : u)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change that role');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Users</h2>
          <input
            className="search"
            type="text"
            placeholder="Filter by name"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="modal-body">
          {error ? <div className="error">{error}</div> : null}

          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
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
                    {u.id === meId ? (
                      <span className="pill" style={{ marginLeft: 6 }}>
                        you
                      </span>
                    ) : null}
                  </td>
                  <td>
                    <select
                      value={u.role}
                      disabled={busyId === u.id || u.id === meId}
                      title={u.id === meId ? 'You cannot change your own role' : undefined}
                      onChange={(e) => void setRole(u.id, e.target.value)}
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

          <p style={{ color: 'var(--text-faint)', fontSize: 12, marginTop: 14 }}>
            Managers can move bugs between columns and merge duplicates. Admins can also do this and
            manage users.
          </p>
        </div>
      </div>
    </div>
  );
}
