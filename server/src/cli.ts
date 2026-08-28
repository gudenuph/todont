/**
 * Admin operations that have to work without a browser — standing the instance
 * up, and rescuing it if nobody is left who can sign in as an admin.
 *
 *   node dist/cli.js users
 *   node dist/cli.js promote <userId|ezmuzeUserId> <user|manager|admin>
 *   node dist/cli.js token <name> [--scopes read,write,manage] [--bot-name "Claude"] [--role manager]
 *   node dist/cli.js tokens
 *   node dist/cli.js revoke <tokenId>
 */
import { db, type UserRow } from './db.js';
import { ALL_SCOPES, hashToken, newToken, type Scope } from './auth/identity.js';

const [, , command, ...rest] = process.argv;

function flag(name: string, fallback?: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] !== undefined ? rest[i + 1] : fallback;
}

function positional(index: number): string | undefined {
  const args = rest.filter((a, i) => !a.startsWith('--') && !rest[i - 1]?.startsWith('--'));
  return args[index];
}

function findUser(ref: string): UserRow | undefined {
  const byId = /^\d+$/.test(ref)
    ? (db.prepare(`SELECT * FROM users WHERE id = ?`).get(Number(ref)) as UserRow | undefined)
    : undefined;
  return (
    byId ??
    (db.prepare(`SELECT * FROM users WHERE ezmuze_user_id = ?`).get(ref.toLowerCase()) as
      | UserRow
      | undefined)
  );
}

function usage(): never {
  console.log(
    [
      'ToDont tracker admin CLI',
      '',
      '  users                                     list every account',
      '  promote <userId|ezmuzeId> <role>          role is user | manager | admin',
      '  token <name> [--scopes a,b] [--bot-name N] [--role manager]',
      '                                            mint an API token (printed once)',
      '  tokens                                    list tokens',
      '  revoke <tokenId>                          revoke a token',
    ].join('\n'),
  );
  process.exit(command ? 1 : 0);
}

switch (command) {
  case 'users': {
    const rows = db
      .prepare(`SELECT * FROM users ORDER BY role, name COLLATE NOCASE`)
      .all() as UserRow[];
    if (!rows.length) {
      console.log('No users yet — the first person to sign in becomes admin.');
      break;
    }
    for (const u of rows) {
      const kind = u.is_bot ? 'bot' : (u.ezmuze_user_id ?? '—');
      console.log(`#${String(u.id).padEnd(4)} ${u.role.padEnd(8)} ${u.name.padEnd(28)} ${kind}`);
    }
    break;
  }

  case 'promote': {
    const ref = positional(0);
    const role = positional(1);
    if (!ref || !role) usage();
    if (!['user', 'manager', 'admin'].includes(role)) {
      console.error(`Role must be user, manager or admin — got "${role}"`);
      process.exit(1);
    }
    const user = findUser(ref);
    if (!user) {
      console.error(`No user matching "${ref}". Run "users" to see the list.`);
      process.exit(1);
    }
    db.prepare(`UPDATE users SET role = ? WHERE id = ?`).run(role, user.id);
    console.log(`${user.name} (#${user.id}) is now ${role}`);
    break;
  }

  case 'token': {
    const name = positional(0);
    if (!name) usage();

    const scopes = (flag('scopes', 'read,write') as string)
      .split(',')
      .map((s) => s.trim())
      .filter((s): s is Scope => (ALL_SCOPES as string[]).includes(s));

    if (!scopes.length) {
      console.error(`--scopes must be some of ${ALL_SCOPES.join(', ')}`);
      process.exit(1);
    }

    const botName = flag('bot-name', name)!;
    const role = flag('role', 'manager')!;
    if (!['user', 'manager', 'admin'].includes(role)) {
      console.error(`--role must be user, manager or admin — got "${role}"`);
      process.exit(1);
    }

    const existingBot = db
      .prepare(`SELECT * FROM users WHERE is_bot = 1 AND name = ?`)
      .get(botName) as UserRow | undefined;

    const userId =
      existingBot?.id ??
      Number(
        db
          .prepare(`INSERT INTO users (ezmuze_user_id, name, role, is_bot) VALUES (NULL, ?, ?, 1)`)
          .run(botName, role).lastInsertRowid,
      );

    if (existingBot && existingBot.role !== role) {
      db.prepare(`UPDATE users SET role = ? WHERE id = ?`).run(role, userId);
    }

    const secret = newToken();
    db.prepare(`INSERT INTO api_tokens (name, token_hash, user_id, scopes) VALUES (?, ?, ?, ?)`).run(
      name,
      hashToken(secret),
      userId,
      scopes.join(','),
    );

    console.log(`Token "${name}" acting as ${botName} (${role}), scopes: ${scopes.join(', ')}`);
    console.log('');
    console.log(`  ${secret}`);
    console.log('');
    console.log('Stored hashed — copy it now, it cannot be shown again.');
    break;
  }

  case 'tokens': {
    const rows = db
      .prepare(
        `SELECT t.*, u.name AS user_name FROM api_tokens t JOIN users u ON u.id = t.user_id ORDER BY t.id`,
      )
      .all() as Array<Record<string, unknown>>;
    if (!rows.length) {
      console.log('No API tokens.');
      break;
    }
    for (const t of rows) {
      const state = t.revoked_at ? 'REVOKED' : 'active ';
      console.log(
        `#${String(t.id).padEnd(3)} ${state} ${String(t.name).padEnd(24)} as ${String(t.user_name).padEnd(20)} [${t.scopes}] last used ${t.last_used_at ?? 'never'}`,
      );
    }
    break;
  }

  case 'revoke': {
    const id = positional(0);
    if (!id) usage();
    const info = db
      .prepare(`UPDATE api_tokens SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL`)
      .run(Number(id));
    console.log(info.changes ? `Token #${id} revoked` : `No active token #${id}`);
    break;
  }

  default:
    usage();
}
