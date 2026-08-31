import { useEffect, useState } from 'react';
import { api } from '../api';

type Runner = (work: () => Promise<unknown>) => Promise<void>;
type Settings = Record<string, unknown>;

/**
 * Instance policy — how people get in, and where mail goes.
 *
 * Everything here has an environment default and a database override; this
 * writes the override, so an instance can be configured after it is running
 * rather than only when it is deployed.
 */
export function SignInTab({ busy, run }: { busy: boolean; run: Runner }) {
  const [s, setS] = useState<Settings | null>(null);

  const reload = () => api.instanceSettings().then((r) => setS(r.settings));
  useEffect(() => {
    void reload().catch(() => setS({}));
  }, []);

  if (!s) return <Loading />;

  const providers = (s['auth.providers'] as string[]) ?? [];
  const save = (patch: Settings) => run(async () => { await api.updateInstanceSettings(patch); await reload(); });

  return (
    <div style={{ maxWidth: 560 }}>
      <div className="field">
        <label>Ways to sign in</label>
        <div className="checks">
          {(['local', 'ezmuze'] as const).map((p) => (
            <label className="check" key={p}>
              <input
                type="checkbox"
                disabled={busy}
                checked={providers.includes(p)}
                onChange={(e) => {
                  const next = e.target.checked
                    ? [...providers, p]
                    : providers.filter((x) => x !== p);
                  void save({ 'auth.providers': next });
                }}
              />
              {p === 'local' ? 'Email and password' : 'ezmuze central'}
            </label>
          ))}
        </div>
        <div className="hint">
          At least one has to stay on, and you cannot switch off the one you signed in
          with — that would lock you out of this page.
        </div>
      </div>

      <div className="field">
        <label className="check">
          <input
            type="checkbox"
            disabled={busy}
            checked={s['auth.allowSignup'] === true}
            onChange={(e) => void save({ 'auth.allowSignup': e.target.checked })}
          />
          Anyone can create an account
        </label>
        <div className="hint">
          Off, only an admin can add people. Existing accounts keep working either way.
        </div>
      </div>

      <div className="field">
        <label className="check">
          <input
            type="checkbox"
            disabled={busy}
            checked={s['auth.requireVerifiedEmail'] === true}
            onChange={(e) => void save({ 'auth.requireVerifiedEmail': e.target.checked })}
          />
          Confirm an email address before raising anything
        </label>
        <div className="hint">
          Reading is public either way; this only gates writing. Needs a mail server —
          without one, nobody can confirm anything.
        </div>
      </div>

      <NumberField
        label="Stay signed in for"
        suffix="days"
        value={Number(s['session.days'])}
        busy={busy}
        onSave={(v) => void save({ 'session.days': v })}
      />
    </div>
  );
}

// --------------------------------------------------------------------- email

export function EmailTab({ busy, run }: { busy: boolean; run: Runner }) {
  const [s, setS] = useState<Settings | null>(null);
  const [pass, setPass] = useState('');
  const [testTo, setTestTo] = useState('');
  const [result, setResult] = useState('');

  const reload = () => api.instanceSettings().then((r) => setS(r.settings));
  useEffect(() => {
    void reload().catch(() => setS({}));
  }, []);

  if (!s) return <Loading />;

  const save = (patch: Settings) => run(async () => { await api.updateInstanceSettings(patch); await reload(); });
  const text = (key: string) => String(s[key] ?? '');

  return (
    <div style={{ maxWidth: 560 }}>
      <p className="hint" style={{ marginTop: 0 }}>
        Used for confirming addresses and resetting passwords — a handful of messages a
        day at most, so an ordinary mailbox is plenty. Leave the server blank and links
        are written to the container log instead, which works but is manual.
      </p>

      <div className="field-row">
        <TextField
          id="sm-host"
          label="Server"
          placeholder="smtp.gmail.com"
          value={text('smtp.host')}
          busy={busy}
          onSave={(v) => void save({ 'smtp.host': v })}
        />
        <NumberField
          label="Port"
          value={Number(s['smtp.port'])}
          busy={busy}
          onSave={(v) => void save({ 'smtp.port': v })}
        />
      </div>

      <TextField
        id="sm-user"
        label="Username"
        placeholder="you@gmail.com"
        value={text('smtp.user')}
        busy={busy}
        onSave={(v) => void save({ 'smtp.user': v })}
      />

      <div className="field">
        <label htmlFor="sm-pass">Password</label>
        <input
          id="sm-pass"
          type="password"
          autoComplete="new-password"
          placeholder={s['smtp.pass'] === true ? '•••••••• (saved)' : 'not set'}
          value={pass}
          disabled={busy}
          onChange={(e) => setPass(e.target.value)}
          onBlur={() => {
            if (!pass) return;
            void save({ 'smtp.pass': pass });
            setPass('');
          }}
        />
        <div className="hint">
          Gmail refuses an account password when two-factor is on, which it is by default.
          Create an <b>App Password</b> and use that. Saved passwords are never shown again.
        </div>
      </div>

      <TextField
        id="sm-from"
        label="Send as"
        placeholder="Bugs <you@gmail.com>"
        value={text('smtp.from')}
        busy={busy}
        onSave={(v) => void save({ 'smtp.from': v })}
      />

      <div className="field">
        <label className="check">
          <input
            type="checkbox"
            disabled={busy}
            checked={s['smtp.allowInsecureTls'] === true}
            onChange={(e) => void save({ 'smtp.allowInsecureTls': e.target.checked })}
          />
          Accept a certificate that does not verify
        </label>
        <div className="hint">
          Only for an internal relay with a self-signed certificate, on a network you
          trust.
        </div>
      </div>

      <div className="field">
        <label htmlFor="sm-test">Send a test to</label>
        <div className="dep-add">
          <input
            id="sm-test"
            type="email"
            placeholder="your own address"
            value={testTo}
            disabled={busy}
            onChange={(e) => setTestTo(e.target.value)}
          />
          <button
            className="btn"
            disabled={busy}
            onClick={() =>
              void api
                .testEmail(testTo || undefined)
                .then((r) => setResult(`Sent to ${r.to}. If it arrives, mail works.`))
                .catch((err: unknown) =>
                  setResult(err instanceof Error ? err.message : 'That did not work'),
                )
            }
          >
            Send test
          </button>
        </div>
        {result ? <div className="hint">{result}</div> : null}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- uploads

export function UploadsFields({ busy, run }: { busy: boolean; run: Runner }) {
  const [s, setS] = useState<Settings | null>(null);

  const reload = () => api.instanceSettings().then((r) => setS(r.settings));
  useEffect(() => {
    void reload().catch(() => setS({}));
  }, []);

  if (!s) return null;

  const save = (patch: Settings) => run(async () => { await api.updateInstanceSettings(patch); await reload(); });
  const ceiling = Number(s['uploads.maxBytesCeiling']);

  return (
    <>
      <NumberField
        label="Largest attachment"
        suffix="MB"
        value={Math.round(Number(s['uploads.maxBytes']) / 1024 / 1024)}
        busy={busy}
        onSave={(v) => void save({ 'uploads.maxBytes': v * 1024 * 1024 })}
        hint={`Up to ${Math.round(ceiling / 1024 / 1024)}MB, which is what this server was started with. Raising it past that needs a restart.`}
      />
      <NumberField
        label="Attachments per ticket"
        value={Number(s['uploads.maxPerBug'])}
        busy={busy}
        onSave={(v) => void save({ 'uploads.maxPerBug': v })}
      />
    </>
  );
}

// -------------------------------------------------------------------- shared

function Loading() {
  return (
    <div className="center-note">
      <span className="spinner" /> Loading…
    </div>
  );
}

function TextField({
  id,
  label,
  placeholder,
  value,
  busy,
  onSave,
}: {
  id: string;
  label: string;
  placeholder?: string;
  value: string;
  busy: boolean;
  onSave: (value: string) => void;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="text"
        defaultValue={value}
        placeholder={placeholder}
        disabled={busy}
        onBlur={(e) => (e.target.value !== value ? onSave(e.target.value.trim()) : undefined)}
      />
    </div>
  );
}

function NumberField({
  label,
  suffix,
  value,
  busy,
  hint,
  onSave,
}: {
  label: string;
  suffix?: string;
  value: number;
  busy: boolean;
  hint?: string;
  onSave: (value: number) => void;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <div className="dep-add">
        <input
          type="text"
          inputMode="numeric"
          defaultValue={String(value)}
          disabled={busy}
          onBlur={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n) && n > 0 && n !== value) onSave(n);
          }}
        />
        {suffix ? <span className="hint" style={{ alignSelf: 'center' }}>{suffix}</span> : null}
      </div>
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}
