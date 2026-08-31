import { useEffect, useState } from 'react';
import { api } from '../api';
import type { BackupStatus } from '../types';

type Runner = (work: () => Promise<unknown>) => Promise<void>;
type Settings = Record<string, unknown>;

const FREQUENCIES = [
  ['off', 'Never'],
  ['hourly', 'Every hour'],
  ['daily', 'Every day'],
  ['weekly', 'Every week, on Sunday'],
] as const;

function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function when(iso: string | null): string {
  if (!iso) return 'never';
  return new Date(iso).toLocaleString();
}

/**
 * Backups, from the same page as everything else.
 *
 * The point of putting this here rather than in host cron is that an operator
 * who can only reach a web page can still arrange for the data to outlive the
 * machine — which is most people running this on a small box.
 */
export function BackupsTab({ busy, run }: { busy: boolean; run: Runner }) {
  const [s, setS] = useState<Settings | null>(null);
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [secret, setSecret] = useState('');
  const [note, setNote] = useState('');

  const reload = async () => {
    const [settings, state] = await Promise.all([api.instanceSettings(), api.backups()]);
    setS(settings.settings);
    setStatus(state);
  };

  useEffect(() => {
    void reload().catch(() => setS({}));
  }, []);

  if (!s || !status) {
    return (
      <div className="center-note">
        <span className="spinner" /> Loading…
      </div>
    );
  }

  const save = (patch: Settings) =>
    run(async () => {
      await api.updateInstanceSettings(patch);
      await reload();
    });

  const text = (key: string) => String(s[key] ?? '');
  const frequency = text('backup.frequency');

  const backupNow = () => {
    setNote('Working…');
    void api
      .runBackup()
      .then(async ({ report }) => {
        setNote(
          report.ok
            ? `Done — ${size(report.bytes)}: ${report.delivered.join(', ')}.`
            : `${report.delivered.join(', ')}. Failed: ${report.failed
                .map((f) => `${f.where} (${f.why})`)
                .join('; ')}`,
        );
        await reload();
      })
      .catch((err: unknown) => setNote(err instanceof Error ? err.message : 'That did not work'));
  };

  return (
    <div style={{ maxWidth: 620 }}>
      <p className="hint" style={{ marginTop: 0 }}>
        A backup is one <code>.tar.gz</code> holding a consistent copy of the database and,
        if you want it, the attachments. Restore by extracting it over the instance's data
        directory. There is always a copy on this machine; anywhere else you name here is
        what makes it a real backup.
      </p>

      {/* ------------------------------------------------------------- when */}

      <div className="field">
        <label htmlFor="bk-freq">Take one</label>
        <select
          id="bk-freq"
          value={frequency}
          disabled={busy}
          onChange={(e) => void save({ 'backup.frequency': e.target.value })}
        >
          {FREQUENCIES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <div className="hint">
          Next run: <b>{when(status.nextRunAt)}</b>. Last run: {when(status.lastRun?.at ?? null)}
          {status.lastRun && !status.lastRun.ok ? ' — with failures' : ''}.
        </div>
      </div>

      {frequency === 'daily' || frequency === 'weekly' ? (
        <NumberField
          label="At"
          suffix=":17, server time"
          value={Number(s['backup.hour'])}
          busy={busy}
          onSave={(v) => void save({ 'backup.hour': Math.min(23, Math.max(0, v)) })}
        />
      ) : null}

      <div className="field">
        <label className="check">
          <input
            type="checkbox"
            disabled={busy}
            checked={s['backup.includeUploads'] === true}
            onChange={(e) => void save({ 'backup.includeUploads': e.target.checked })}
          />
          Include attachments
        </label>
        <div className="hint">
          The database is tiny — tickets, comments, accounts, history. The attachments are
          usually a hundred times bigger, which is the difference between a backup that fits
          in an email and one that does not.
        </div>
      </div>

      <NumberField
        label="Keep the last"
        suffix="on this machine"
        value={Number(s['backup.keep'])}
        busy={busy}
        onSave={(v) => void save({ 'backup.keep': v })}
      />

      {/* ------------------------------------------------------------ where */}

      <h3 className="section-head">Send a copy to</h3>
      <p className="hint" style={{ marginTop: 0 }}>
        Leave one blank to switch it off. Each is tried independently, so one that fails does
        not stop the others.
      </p>

      <TextField
        id="bk-email"
        label="Email"
        placeholder="you@example.com"
        value={text('backup.emailTo')}
        busy={busy}
        onSave={(v) => void save({ 'backup.emailTo': v })}
        hint="Uses the mail server on the Email tab. Most mailboxes refuse anything over about 25MB, so this usually means turning attachments off."
      />

      <details className="dest" open={Boolean(text('backup.s3.bucket'))}>
        <summary>Object storage (Backblaze B2, Cloudflare R2, MinIO, S3)</summary>
        <p className="hint">
          Any S3-compatible bucket. This is the honest answer to “somewhere off the box”: B2
          and R2 both have free tiers far bigger than a tracker needs, and neither wants a
          desktop client running.
        </p>

        <TextField
          id="bk-s3-ep"
          label="Endpoint"
          placeholder="https://s3.eu-central-003.backblazeb2.com"
          value={text('backup.s3.endpoint')}
          busy={busy}
          onSave={(v) => void save({ 'backup.s3.endpoint': v })}
        />
        <div className="field-row">
          <TextField
            id="bk-s3-bucket"
            label="Bucket"
            value={text('backup.s3.bucket')}
            busy={busy}
            onSave={(v) => void save({ 'backup.s3.bucket': v })}
          />
          <TextField
            id="bk-s3-region"
            label="Region"
            placeholder="auto"
            value={text('backup.s3.region')}
            busy={busy}
            onSave={(v) => void save({ 'backup.s3.region': v })}
          />
        </div>
        <TextField
          id="bk-s3-prefix"
          label="Folder"
          placeholder="todont/ (optional)"
          value={text('backup.s3.prefix')}
          busy={busy}
          onSave={(v) => void save({ 'backup.s3.prefix': v })}
        />
        <TextField
          id="bk-s3-key"
          label="Access key ID"
          value={text('backup.s3.accessKeyId')}
          busy={busy}
          onSave={(v) => void save({ 'backup.s3.accessKeyId': v })}
        />
        <div className="field">
          <label htmlFor="bk-s3-secret">Secret access key</label>
          <input
            id="bk-s3-secret"
            type="password"
            autoComplete="new-password"
            placeholder={s['backup.s3.secretAccessKey'] === true ? '•••••••• (saved)' : 'not set'}
            value={secret}
            disabled={busy}
            onChange={(e) => setSecret(e.target.value)}
            onBlur={() => {
              if (!secret) return;
              void save({ 'backup.s3.secretAccessKey': secret });
              setSecret('');
            }}
          />
          <div className="hint">Saved secrets are never shown again.</div>
        </div>
      </details>

      <details className="dest" open={Boolean(text('backup.command'))}>
        <summary>Run a command (rsync, scp, git, rclone)</summary>
        {status.commandAllowed ? (
          <>
            <p className="hint">
              Run after each backup with <code>$BACKUP_FILE</code> set to the archive's path.
              This is how you reach anything not listed above — a NAS over rsync, a private
              git repository, or Google Drive and Dropbox through <code>rclone</code>. The
              tool has to exist inside the container, and by default only <code>tar</code>,{' '}
              <code>gzip</code> and <code>curl</code> do.
            </p>
            <TextField
              id="bk-cmd"
              label="Command"
              placeholder={'rsync -a "$BACKUP_FILE" backup@nas:/vol/todont/'}
              value={text('backup.command')}
              busy={busy}
              onSave={(v) => void save({ 'backup.command': v })}
            />
          </>
        ) : (
          <p className="hint">
            Switched off. Administering this board is not meant to be the same thing as
            having a shell on the server, and this would quietly make it so. Set{' '}
            <code>BACKUP_ALLOW_COMMAND=true</code> in the server's environment and restart if
            you want it.
          </p>
        )}
      </details>

      {/* -------------------------------------------------------------- now */}

      <h3 className="section-head">Backups on this machine</h3>

      <div className="dep-add" style={{ marginBottom: 10 }}>
        <button className="btn primary" disabled={busy} onClick={backupNow}>
          Back up now
        </button>
        {note ? (
          <span className="hint" style={{ alignSelf: 'center' }}>
            {note}
          </span>
        ) : null}
      </div>

      {status.archives.length === 0 ? (
        <div className="hint">None yet.</div>
      ) : (
        <table className="table">
          <tbody>
            {status.archives.map((a) => (
              <tr key={a.name}>
                <td>
                  <a href={`/api/admin/backups/${encodeURIComponent(a.name)}`} download>
                    {a.name}
                  </a>
                </td>
                <td className="hint">{size(a.bytes)}</td>
                <td style={{ textAlign: 'right' }}>
                  <button
                    className="btn small danger"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await api.deleteBackup(a.name);
                        await reload();
                      })
                    }
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// -------------------------------------------------------------------- shared

function TextField({
  id,
  label,
  placeholder,
  value,
  busy,
  hint,
  onSave,
}: {
  id: string;
  label: string;
  placeholder?: string;
  value: string;
  busy: boolean;
  hint?: string;
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
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

function NumberField({
  label,
  suffix,
  value,
  busy,
  onSave,
}: {
  label: string;
  suffix?: string;
  value: number;
  busy: boolean;
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
            if (Number.isFinite(n) && n >= 0 && n !== value) onSave(n);
          }}
        />
        {suffix ? (
          <span className="hint" style={{ alignSelf: 'center' }}>
            {suffix}
          </span>
        ) : null}
      </div>
    </div>
  );
}
