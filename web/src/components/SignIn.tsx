import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { User } from '../types';

type Phase = 'starting' | 'waiting' | 'approved' | 'error';

/**
 * ezmuze central's app-connect handshake, from the browser's side: ask our
 * server to open a request, send the user to ezmuze.co.uk to approve it, then
 * poll until it comes back approved. The AuthKey itself never reaches this page
 * — the server swaps it for a session cookie.
 */
export function SignIn({ onDone, onClose }: { onDone: (user: User) => void; onClose: () => void }) {
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
    <div className="scrim" onClick={onClose}>
      <div className="modal narrow" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Sign in with ezmuze</h2>
          <button className="close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="modal-body">
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

            <div
              className={`step ${phase === 'waiting' ? 'active' : phase === 'approved' ? 'done' : ''}`}
            >
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
        </div>

        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
