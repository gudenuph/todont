import { useState } from 'react';
import { api } from '../api';
import type { User } from '../types';

/**
 * Choose a new password, from the emailed link.
 *
 * Shown instead of the board when the URL carries a reset token, because there
 * is nothing else worth doing until it is finished or abandoned — and the token
 * is single use, so bouncing away from it wastes it.
 */
export function ResetPassword({
  token,
  onDone,
  onCancel,
}: {
  token: string;
  onDone: (user: User | null) => void;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const mismatch = confirm !== '' && password !== confirm;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (mismatch) return;

    setBusy(true);
    setError('');
    try {
      const { user } = await api.resetPassword(token, password);
      onDone(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work');
      setBusy(false);
    }
  }

  return (
    <div className="scrim">
      <div className="modal narrow" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Choose a new password</h2>
        </div>

        <form className="modal-body" onSubmit={submit}>
          {error ? <div className="error">{error}</div> : null}

          <div className="field">
            <label htmlFor="rp-password">New password</label>
            <input
              id="rp-password"
              type="password"
              autoComplete="new-password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <div className="hint">At least 8 characters.</div>
          </div>

          <div className="field">
            <label htmlFor="rp-confirm">Type it again</label>
            <input
              id="rp-confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
            {mismatch ? <div className="hint" style={{ color: '#ffb0b0' }}>These do not match.</div> : null}
          </div>

          <p className="hint">
            Setting a new password signs out anywhere else you are already signed in.
          </p>

          <div className="confirm-row">
            <button
              className="btn primary"
              type="submit"
              disabled={busy || !password || mismatch}
            >
              {busy ? 'Just a moment…' : 'Set password'}
            </button>
            <button className="btn ghost" type="button" disabled={busy} onClick={onCancel}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
