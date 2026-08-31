import { useEffect, useState } from 'react';
import { api } from '../api';
import type { ApiToken } from '../types';

type Runner = (work: () => Promise<unknown>) => Promise<void>;

const SCOPES = [
  ['read', 'Read the board'],
  ['write', 'Raise tickets and comment'],
  ['manage', 'Move, merge, assign, delete'],
  ['versions', 'Register a release'],
  ['admin', 'Everything on this dialog'],
] as const;

/**
 * Machine credentials, so nobody has to reach for a shell to make one.
 *
 * A token acts as a user — a bot account created alongside it — so whatever it
 * does is attributed on the board like anyone else's work, and revoking it
 * leaves that history intact.
 */
export function TokensTab({ busy, run }: { busy: boolean; run: Runner }) {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [name, setName] = useState('');
  const [botName, setBotName] = useState('');
  const [role, setRole] = useState('manager');
  const [scopes, setScopes] = useState<string[]>(['read', 'write']);
  const [minted, setMinted] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const reload = () => api.tokens().then((r) => setTokens(r.tokens));
  useEffect(() => {
    void reload().catch(() => setTokens([]));
  }, []);

  return (
    <>
      <p className="hint" style={{ marginTop: 0 }}>
        For anything that talks to this tracker without a person: a release pipeline, a
        crash reporter, an agent working the board. Give each one its own, with only the
        permissions it needs — then revoking it costs nothing else.
      </p>

      {minted ? (
        <div className="notice">
          <b>Copy this now.</b> It is stored hashed and cannot be shown again.
          <div className="token-reveal">
            <code>{minted}</code>
            <button
              className="btn small"
              onClick={() => {
                void navigator.clipboard?.writeText(minted).then(
                  () => setCopied(true),
                  () => setCopied(false),
                );
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button className="btn small ghost" onClick={() => { setMinted(null); setCopied(false); }}>
              Done
            </button>
          </div>
        </div>
      ) : null}

      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Acts as</th>
            <th>Can</th>
            <th>Last used</th>
            <th style={{ width: 80 }}></th>
          </tr>
        </thead>
        <tbody>
          {tokens.map((t) => (
            <tr key={t.id} style={t.revokedAt ? { opacity: 0.5 } : undefined}>
              <td>
                {t.name}
                {t.revokedAt ? <span className="pill" style={{ marginLeft: 6 }}>revoked</span> : null}
              </td>
              <td>
                {t.actsAs.name} <span className="lane-key">{t.actsAs.role}</span>
              </td>
              <td style={{ fontSize: 12, color: 'var(--text-dim)' }}>{t.scopes.join(', ')}</td>
              <td style={{ fontSize: 12, color: 'var(--text-faint)' }}>
                {t.lastUsedAt ? t.lastUsedAt.split(' ')[0] : 'never'}
              </td>
              <td>
                {t.revokedAt ? null : (
                  <button
                    className="btn small danger-outline"
                    disabled={busy}
                    onClick={() => {
                      if (!confirm(`Revoke "${t.name}"? Anything using it stops working.`)) return;
                      void run(async () => {
                        await api.revokeToken(t.id);
                        await reload();
                      });
                    }}
                  >
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
          {tokens.length === 0 ? (
            <tr>
              <td colSpan={5} style={{ color: 'var(--text-faint)', textAlign: 'center' }}>
                No tokens yet.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>

      <h3 style={{ fontSize: 13, marginTop: 22, marginBottom: 10 }}>New token</h3>

      <div className="field-row">
        <div className="field">
          <label htmlFor="tk-name">What is it for</label>
          <input
            id="tk-name"
            type="text"
            placeholder="release-pipeline"
            value={name}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="hint">So you know what you are revoking later.</div>
        </div>

        <div className="field">
          <label htmlFor="tk-bot">Show on the board as</label>
          <input
            id="tk-bot"
            type="text"
            placeholder={name || 'Releases'}
            value={botName}
            disabled={busy}
            onChange={(e) => setBotName(e.target.value)}
          />
          <div className="hint">The name against anything it does.</div>
        </div>
      </div>

      <div className="field">
        <label>Allowed to</label>
        <div className="checks">
          {SCOPES.map(([scope, what]) => (
            <label className="check" key={scope}>
              <input
                type="checkbox"
                disabled={busy}
                checked={scopes.includes(scope)}
                onChange={(e) =>
                  setScopes(
                    e.target.checked ? [...scopes, scope] : scopes.filter((s) => s !== scope),
                  )
                }
              />
              {what}
            </label>
          ))}
        </div>
        <div className="hint">
          A token can never do more than its role allows, so pick the narrowest that works.
        </div>
      </div>

      <div className="field" style={{ maxWidth: 220 }}>
        <label htmlFor="tk-role">Role</label>
        <select id="tk-role" value={role} disabled={busy} onChange={(e) => setRole(e.target.value)}>
          <option value="user">user</option>
          <option value="manager">manager</option>
          <option value="admin">admin</option>
        </select>
      </div>

      <button
        className="btn primary"
        disabled={busy || !name.trim() || !scopes.length}
        onClick={() =>
          void run(async () => {
            const created = await api.createToken({
              name: name.trim(),
              scopes,
              botName: botName.trim() || name.trim(),
              botRole: role,
            });
            setMinted(created.token);
            setCopied(false);
            setName('');
            setBotName('');
            await reload();
          })
        }
      >
        Create token
      </button>
    </>
  );
}
