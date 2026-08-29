import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import type { BugCard, BugDetail, Meta, Session } from './types';
import { Board } from './components/Board';
import { SignIn } from './components/SignIn';
import { NewBug } from './components/NewBug';
import { RaiseButton } from './components/RaiseButton';
import { BugView } from './components/BugView';
import { Users } from './components/Users';

/** Which bug the URL points at, so a bug can be linked to directly. */
function bugFromHash(): number | null {
  const match = /^#\/bug\/(\d+)$/.exec(window.location.hash);
  return match ? Number(match[1]) : null;
}

export function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [session, setSession] = useState<Session>({ user: null });
  const [bugs, setBugs] = useState<BugCard[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const [signingIn, setSigningIn] = useState(false);
  const [raising, setRaising] = useState<string | null>(null);
  const [showUsers, setShowUsers] = useState(false);
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
        const [loadedMeta, loadedSession] = await Promise.all([api.meta(), api.me()]);
        setMeta(loadedMeta);
        setSession(loadedSession);
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

  /** Splice a changed bug back into the board without a full reload. */
  const applyBug = useCallback((updated: BugDetail) => {
    setBugs((prev) => {
      const without = prev.filter((b) => b.id !== updated.id);
      // A merged bug leaves the board; everything else takes its new place.
      return updated.mergedIntoId === null ? [...without, updated] : without;
    });
    void refreshQuiet();
  }, []);

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
    setShowUsers(false);
    // "Only my bugs" needs a signed-in caller; leaving it on would 401 the board.
    setOnlyMine(false);
  }

  const columns = useMemo(() => meta?.columns ?? [], [meta]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="mark">◆</span>
          <span>ezmuze bugs</span>
          <span className="sub">what's broken, and who's on it</span>
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
            <RaiseButton kinds={meta?.kinds ?? []} onRaise={(k) => setRaising(k)} />
            {isAdmin ? (
              <button className="btn ghost" onClick={() => setShowUsers(true)}>
                Users
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
            Sign in with ezmuze
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

      {signingIn ? (
        <SignIn
          onClose={() => setSigningIn(false)}
          onDone={(user) => {
            setSigningIn(false);
            void api.me().then(setSession).catch(() => setSession({ user }));
          }}
        />
      ) : null}

      {raising && meta ? (
        <NewBug
          kind={meta.kinds.find((k) => k.key === raising) ?? meta.kinds[0]}
          environments={meta.environments ?? []}
          versions={meta.versions ?? []}
          defaultVersion={meta.defaultVersion ?? ''}
          onClose={() => setRaising(null)}
          onCreated={(bug) => {
            setRaising(null);
            setBugs((prev) => [...prev, bug]);
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

      {showUsers && session.user ? (
        <Users meId={session.user.id} onClose={() => setShowUsers(false)} />
      ) : null}
    </div>
  );
}
