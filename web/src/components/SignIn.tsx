import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { AuthOptions, User } from '../types';

type Mode = 'login' | 'signup' | 'ezmuze';

/**
 * The way in. Which options appear is up to the instance — an install can offer
 * email and password, a federated provider, or both.
 */
export function SignIn({
  auth,
  onDone,
  onClose,
  reason,
}: {
  auth: AuthOptions;
  onDone: (user: User) => void;
  onClose: () => void;
  /** Why they are being asked, when they did not click "sign in" themselves. */
  reason?: string;
}) {
  const hasLocal = auth.providers.includes('local');
  const hasEzmuze = auth.providers.includes('ezmuze');

  const [mode, setMode] = useState<Mode>(hasLocal ? 'login' : 'ezmuze');

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal narrow" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>
            {mode === 'signup' ? 'Create an account' : 'Sign in'}
          </h2>
          <button className="close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="modal-body">
          {reason ? <p className="signin-reason">{reason}</p> : null}

          {mode === 'ezmuze' ? (
            <EzmuzeHandshake onDone={onDone} />
          ) : (
            <LocalForm mode={mode} onDone={onDone} />
          )}

          {/* Anything the current mode is not. */}
          {(hasLocal && hasEzmuze) || (hasLocal && auth.allowSignup) ? (
            <div className="signin-alt">
              {mode !== 'ezmuze' && hasEzmuze ? (
                <button className="linkish" onClick={() => setMode('ezmuze')}>
                  Sign in with an ezmuze account instead
                </button>
              ) : null}
              {mode === 'ezmuze' && hasLocal ? (
                <button className="linkish" onClick={() => setMode('login')}>
                  Use an email and password instead
                </button>
              ) : null}
              {mode === 'login' && hasLocal && auth.allowSignup ? (
                <button className="linkish" onClick={() => setMode('signup')}>
                  No account yet? Create one
                </button>
              ) : null}
              {mode === 'signup' ? (
                <button className="linkish" onClick={() => setMode('login')}>
                  Already have an account? Sign in
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ email/password

function LocalForm({ mode, onDone }: { mode: Mode; onDone: (user: User) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const signup = mode === 'signup';

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { user } = signup
        ? await api.signup({ email, password, name })
        : await api.login({ email, password });
      onDone(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work');
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      {error ? <div className="error">{error}</div> : null}

      <div className="field">
        <label htmlFor="si-email">Email</label>
        <input
          id="si-email"
          type="email"
          autoComplete="email"
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>

      {signup ? (
        <div className="field">
          <label htmlFor="si-name">Display name</label>
          <input
            id="si-name"
            type="text"
            autoComplete="nickname"
            placeholder="Shown on the bugs you raise"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      ) : null}

      <div className="field">
        <label htmlFor="si-password">Password</label>
        <input
          id="si-password"
          type="password"
          autoComplete={signup ? 'new-password' : 'current-password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {signup ? <div className="hint">At least 8 characters.</div> : null}
      </div>

      <button className="btn primary" type="submit" disabled={busy || !email || !password}>
        {busy ? 'Just a moment…' : signup ? 'Create account' : 'Sign in'}
      </button>
    </form>
  );
}

// ------------------------------------------------------------ ezmuze central

type Phase = 'starting' | 'waiting' | 'approved' | 'error';

/**
 * ezmuze central's app-connect handshake: ask our server to open a request,
 * send the user to ezmuze.co.uk to approve it, then poll until it comes back.
 * The AuthKey never reaches this page — the server swaps it for a cookie.
 */
function EzmuzeHandshake({ onDone }: { onDone: (user: User) => void }) {
  const [phase, setPhase] = useState<Phase>('starting');
  const [error, setError] = useState('');
  const [approvalUrl, setApprovalUrl] = useState('');
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;

    void (async () => {
      let requestId: string;
      try {
        const begun = await api.beginSignIn();
        if (cancelled.current) return;
        requestId = begun.requestId;
        setApprovalUrl(begun.approvalUrl);
        setPhase('waiting');
        // Popups opened from an async callback are usually blocked, so the
        // approval page is a link the user clicks rather than a window we open.
      } catch (err) {
        if (!cancelled.current) {
          setPhase('error');
          setError(err instanceof Error ? err.message : 'Could not start sign-in');
        }
        return;
      }

      const deadline = Date.now() + 10 * 60 * 1000;
      while (!cancelled.current && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        if (cancelled.current) return;

        try {
          const result = await api.pollSignIn(requestId);
          if (result.status === 'approved' && result.user) {
            setPhase('approved');
            onDone(result.user);
            return;
          }
          if (result.status === 'expired') break;
        } catch {
          break;
        }
      }

      if (!cancelled.current) {
        setPhase('error');
        setError('That sign-in request timed out. Start again.');
      }
    })();

    return () => {
      cancelled.current = true;
    };
  }, [onDone]);

  return (
    <>
      {error ? <div className="error">{error}</div> : null}

      <div className="signin-steps">
        <div className={`step ${phase === 'starting' ? 'active' : 'done'}`}>
          <span className="n">1</span>
          <span className="body">
            {phase === 'starting' ? (
              <>
                <span className="spinner" /> Asking ezmuze central for a connection…
              </>
            ) : (
              'Connection requested'
            )}
          </span>
        </div>

        <div className={`step ${phase === 'waiting' ? 'active' : phase === 'approved' ? 'done' : ''}`}>
          <span className="n">2</span>
          <span className="body">
            Approve this site on your ezmuze account.
            {approvalUrl && phase === 'waiting' ? (
              <>
                <br />
                <a href={approvalUrl} target="_blank" rel="noreferrer">
                  Open the approval page ↗
                </a>
              </>
            ) : null}
          </span>
        </div>

        <div className={`step ${phase === 'approved' ? 'done' : phase === 'waiting' ? 'active' : ''}`}>
          <span className="n">3</span>
          <span className="body">
            {phase === 'waiting' ? (
              <>
                <span className="spinner" /> Waiting for you to approve…
              </>
            ) : phase === 'approved' ? (
              'Signed in'
            ) : (
              'Come back here — it signs you in automatically'
            )}
          </span>
        </div>
      </div>
    </>
  );
}
