import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import type { AuthOptions, BugCard, BugDetail, Meta, Prefill, Session } from './types';
import { Board } from './components/Board';
import { SignIn } from './components/SignIn';
import { NewBug } from './components/NewBug';
import { RaiseButton } from './components/RaiseButton';
import { BugView } from './components/BugView';
import { Admin } from './components/Admin';

/**
 * A report ezmuze started for us, waiting on a person to finish it.
 *
 * The app has two ways in. A short report fits in the query string; anything
 * carrying a stack trace posts to /api/drafts first and links to the id, since
 * a trace will not survive a URL and would spill into every proxy log on the
 * way.
 */
interface PendingRaise {
  kind: string;
  prefill: Prefill;
  knownBug: BugCard | null;
}

/** Query-string form, for a report small enough to fit in a link. */
function prefillFromQuery(params: URLSearchParams): Prefill | null {
  const map: Array<[string, keyof Prefill]> = [
    ['title', 'title'],
    ['description', 'description'],
    ['steps', 'steps'],
    ['severity', 'severity'],
    ['version', 'appVersion'],
    ['appVersion', 'appVersion'],
    ['platform', 'environment'],
    ['environment', 'environment'],
    ['stackTrace', 'stackTrace'],
  ];

  const prefill: Prefill = {};
  for (const [param, field] of map) {
    const value = params.get(param);
    if (value) prefill[field] = value;
  }

  return Object.keys(prefill).length ? prefill : null;
}

/** Which bug the URL points at, so a bug can be linked to directly. */
function bugFromHash(): number | null {
  const match = /^#\/bug\/(\d+)$/.exec(window.location.hash);
  return match ? Number(match[1]) : null;
}

export function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [session, setSession] = useState<Session>({ user: null });
  const [auth, setAuth] = useState<AuthOptions>({ providers: ['local'], allowSignup: true });
  const [bugs, setBugs] = useState<BugCard[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const [signingIn, setSigningIn] = useState(false);
  const [raising, setRaising] = useState<PendingRaise | null>(null);
  const [showAdmin, setShowAdmin] = useState(false);
  const [onlyMine, setOnlyMine] = useState(false);
  const [openBug, setOpenBug] = useState<number | null>(bugFromHash());

  const canManage = session.scopes?.includes('manage') ?? false;
  const isAdmin = session.user?.role === 'admin';

  const refresh = useCallback(async (q?: string, mine?: boolean) => {
    try {
      const { bugs: list } = await api.bugs({ q: q?.trim() || undefined, mine });
      setBugs(list);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the board');
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const [loadedMeta, loadedSession, loadedAuth] = await Promise.all([
          api.meta(),
          api.me(),
          api.authOptions(),
        ]);
        setMeta(loadedMeta);
        setSession(loadedSession);
        setAuth(loadedAuth);
        if (loadedMeta.board?.name) document.title = loadedMeta.board.name;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not reach the tracker');
      }
      await refresh();
      setLoading(false);
    })();
  }, [refresh]);

  // Debounced search; the filter toggle rides the same effect.
  useEffect(() => {
    const timer = setTimeout(() => void refresh(query, onlyMine), 250);
    return () => clearTimeout(timer);
  }, [query, onlyMine, refresh]);

  /**
   * Act on a link from the app, once, on load. Signing in is not required to
   * *open* the form — only to submit it — but asking first is kinder than
   * letting someone write out a report and then bounce them.
   */
  useEffect(() => {
    if (loading || !meta) return;

    const params = new URLSearchParams(window.location.search);
    const draftId = params.get('draft');
    const raiseKind = params.get('raise');
    if (!draftId && !raiseKind) return;

    // Clear it immediately: a refresh should not reopen the form, and a draft
    // id has no business sitting in the address bar afterwards.
    history.replaceState(null, '', window.location.pathname + window.location.hash);

    void (async () => {
      if (draftId) {
        try {
          const { draft, knownBug } = await api.draft(draftId);
          const { kind, ...prefill } = draft;
          setRaising({
            kind: kind ?? meta.kinds[0]?.key ?? 'bug',
            prefill,
            knownBug,
          });
        } catch (err) {
          setError(
            err instanceof Error
              ? err.message
              : 'That prefilled report could not be loaded — raise it by hand',
          );
        }
        return;
      }

      const prefill = prefillFromQuery(params) ?? {};
      const known = meta.kinds.some((k) => k.key === raiseKind);
      setRaising({
        kind: known ? raiseKind! : (meta.kinds[0]?.key ?? 'bug'),
        prefill,
        knownBug: null,
      });
    })();
  }, [loading, meta]);

  // Keep the modal and the address bar agreeing, both ways.
  useEffect(() => {
    const onHashChange = () => setOpenBug(bugFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const openBugById = useCallback((id: number | null) => {
    setOpenBug(id);
    const target = id === null ? ' ' : `#/bug/${id}`;
    if (id === null) {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    } else if (window.location.hash !== target) {
      history.replaceState(null, '', target);
    }
  }, []);

  /**
   * Re-read the board after a change to a ticket.
   *
   * A change can move more than the one card — merging removes it, blocking
   * repaints another — and the detail shape is not a card shape, so splicing
   * one in would be a half-truth. The read is one small request.
   */
  const applyBug = useCallback((updated: BugDetail) => {
    if (updated.mergedIntoId !== null) {
      setBugs((prev) => prev.filter((b) => b.id !== updated.id));
    }
    void refreshQuiet();
  }, []);

  /** Lanes and the board name can change under us, from the admin dialog. */
  async function reloadMeta() {
    try {
      const loaded = await api.meta();
      setMeta(loaded);
      document.title = loaded.board?.name ?? 'ToDont';
    } catch {
      /* keep what we already have */
    }
    await refreshQuiet();
  }

  /** Merges and moves touch more than one card, so re-read the board. */
  async function refreshQuiet() {
    try {
      const { bugs: list } = await api.bugs({ q: query.trim() || undefined, mine: onlyMine });
      setBugs(list);
    } catch {
      /* the optimistic update stands until the next successful read */
    }
  }

  async function move(id: number, status: string, index: number) {
    const before = bugs;
    // Optimistic: the card lands where it was dropped, then the server confirms.
    setBugs((prev) => prev.map((b) => (b.id === id ? { ...b, status } : b)));
    try {
      await api.moveBug(id, status, index);
      await refreshQuiet();
    } catch (err) {
      setBugs(before);
      setError(err instanceof Error ? err.message : 'Could not move that bug');
    }
  }

  async function merge(id: number, intoId: number) {
    const before = bugs;
    setBugs((prev) => prev.filter((b) => b.id !== id));
    try {
      await api.mergeBug(id, intoId);
      await refreshQuiet();
    } catch (err) {
      setBugs(before);
      setError(err instanceof Error ? err.message : 'Could not merge those bugs');
    }
  }

  async function signOut() {
    await api.signOut().catch(() => undefined);
    setSession({ user: null });
    setShowAdmin(false);
    // "Only my bugs" needs a signed-in caller; leaving it on would 401 the board.
    setOnlyMine(false);
  }

  const columns = useMemo(() => meta?.columns ?? [], [meta]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="mark">◆</span>
          <span>{meta?.board?.name ?? 'ToDont'}</span>
          {meta?.board?.tagline ? <span className="sub">{meta.board.tagline}</span> : null}
        </div>

        <div className="spacer" />

        <input
          className="search"
          type="text"
          placeholder="Search bugs"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        {session.user ? (
          <>
            <label className="toggle" title="Bugs you raised, or that are assigned to you">
              <input
                type="checkbox"
                checked={onlyMine}
                onChange={(e) => setOnlyMine(e.target.checked)}
              />
              <span>Only my bugs</span>
            </label>
            <RaiseButton
              kinds={meta?.kinds ?? []}
              onRaise={(k) => setRaising({ kind: k, prefill: {}, knownBug: null })}
            />
            {isAdmin ? (
              <button className="btn ghost" onClick={() => setShowAdmin(true)}>
                Admin
              </button>
            ) : null}
            <span className="whoami">
              {session.user.name}
              {session.user.role !== 'user' ? (
                <span className={`role-chip ${session.user.role}`}>{session.user.role}</span>
              ) : null}
            </span>
            <button className="btn ghost small" onClick={() => void signOut()}>
              Sign out
            </button>
          </>
        ) : (
          <button className="btn primary" onClick={() => setSigningIn(true)}>
            {/* Which provider is on is an instance setting, so do not name one. */}
            Sign in
          </button>
        )}
      </header>

      {error ? (
        <div className="error" style={{ margin: '10px 14px 0' }}>
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="center-note">
          <span className="spinner" /> Loading the board…
        </div>
      ) : (
        <Board
          bugs={bugs}
          columns={columns}
          kinds={meta?.kinds ?? []}
          canManage={canManage}
          onOpen={(id) => openBugById(id)}
          onMove={(id, status, index) => void move(id, status, index)}
          onMerge={(id, intoId) => void merge(id, intoId)}
        />
      )}

      {/*
        A pending report from the app takes over the sign-in prompt: whoever
        arrived from a crash dialog gets signed in and dropped straight into the
        form, rather than being left on an empty board wondering what happened.
      */}
      {signingIn || (raising && !session.user) ? (
        <SignIn
          auth={auth}
          reason={
            raising && !session.user
              ? 'ezmuze started a report for you. Sign in and it will be waiting, already filled in.'
              : undefined
          }
          onClose={() => {
            setSigningIn(false);
            setRaising(null);
          }}
          onDone={(user) => {
            setSigningIn(false);
            void api
              .me()
              .then(setSession)
              .catch(() => setSession({ user }));
          }}
        />
      ) : null}

      {raising && meta && session.user ? (
        <NewBug
          kind={meta.kinds.find((k) => k.key === raising.kind) ?? meta.kinds[0]}
          environments={meta.environments ?? []}
          versions={meta.versions ?? []}
          defaultVersion={meta.defaultVersion ?? ''}
          prefill={raising.prefill}
          knownBug={raising.knownBug}
          onOpenBug={(id) => {
            setRaising(null);
            openBugById(id);
          }}
          onClose={() => setRaising(null)}
          onCreated={(bug) => {
            setRaising(null);
            void refreshQuiet();
            openBugById(bug.id);
          }}
        />
      ) : null}

      {openBug !== null ? (
        <BugView
          bugId={openBug}
          session={session}
          columns={columns}
          environments={meta?.environments ?? []}
          kinds={meta?.kinds ?? []}
          versions={meta?.versions ?? []}
          onChanged={applyBug}
          onDeleted={(id) => {
            setBugs((prev) => prev.filter((b) => b.id !== id));
            openBugById(null);
            // A deleted bug releases any duplicates merged into it, so the
            // board can gain cards as well as lose one.
            void refreshQuiet();
          }}
          onClose={() => openBugById(null)}
          onOpenOther={(id) => openBugById(id)}
        />
      ) : null}

      {showAdmin && session.user ? (
        <Admin
          meId={session.user.id}
          onChanged={() => void reloadMeta()}
          onClose={() => setShowAdmin(false)}
        />
      ) : null}
    </div>
  );
}
