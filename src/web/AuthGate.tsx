import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { api } from './api';

/** When ARIADNE_TOKEN is set, unlock the UI once with that token (HttpOnly cookie). */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'loading' | 'ok' | 'need'>('loading');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.auth().then(
      (s) => setState(!s.required || s.ok ? 'ok' : 'need'),
      () => setState('need'),
    );
  }, []);

  if (state === 'loading') return <div className="auth-gate muted">Loading…</div>;
  if (state === 'ok') return <>{children}</>;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.unlock(token);
      setState('ok');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-gate">
      <form className="auth-card" onSubmit={submit}>
        <h1>Ariadne</h1>
        <p className="muted">This instance requires the access token. Cursor and Claude Code send it as a Bearer header; the browser keeps it in a session cookie.</p>
        <label>
          Access token
          <input
            type="password"
            autoComplete="current-password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoFocus
          />
        </label>
        {error && <p className="auth-error">{error}</p>}
        <button className="btn" type="submit" disabled={busy || !token.trim()}>
          Unlock
        </button>
      </form>
    </div>
  );
}
