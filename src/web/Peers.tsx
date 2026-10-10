import { useEffect, useState } from 'react';
import { api, type FederationStatus } from './api';
import { useApp } from './App';

/** Pair this instance with another, and share the focused task with a peer. */
export function Peers({ onClose }: { onClose(): void }) {
  const { focus, reload } = useApp();
  const [status, setStatus] = useState<FederationStatus | null>(null);
  const [invite, setInvite] = useState('');
  const [paste, setPaste] = useState('');
  const [peerId, setPeerId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const load = () => api.federation().then(setStatus, (e) => setError(e instanceof Error ? e.message : String(e)));
  useEffect(() => {
    void load();
  }, []);
  const run = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
      await load();
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="peers" role="dialog" aria-label="Peers">
      <div className="panel-head">
        <h2>Peers</h2>
        <button className="btn small" onClick={onClose}>
          Close
        </button>
      </div>
      {!status?.enabled && <p className="muted">Federation is off on this instance.</p>}
      {status?.enabled && (
        <>
          <p className="muted">This instance is {status.peerId}. WebSocket addresses: {(status.announce ?? []).join(' ') || 'none advertised'}.</p>
          <div className="row">
            <button className="btn small" onClick={() => run(async () => setInvite((await api.invite('direct')).invite))}>
              Invite on this network
            </button>
            <button className="btn small" onClick={() => run(async () => setInvite((await api.invite('relay')).invite))}>
              Invite through the relay
            </button>
          </div>
          {invite && (
            <textarea readOnly value={invite} aria-label="Invite" onFocus={(e) => e.currentTarget.select()} />
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api.acceptInvite(paste.trim());
                setPaste('');
              });
            }}
          >
            <textarea value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="Paste an invite" aria-label="Paste an invite" />
            <button className="btn primary" disabled={!paste.trim()}>
              Pair
            </button>
          </form>
          <ul>
            {(status.peers ?? []).map((p) => (
              <li key={p.peerId}>
                <code>{p.peerId}</code>
                {p.offersRelay ? ' · relay' : ''}
              </li>
            ))}
          </ul>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!focus) return;
              void run(() => api.share(focus, peerId).then(() => undefined));
            }}
          >
            <p className="muted">Share the focused task with a paired peer. Only what that task needs goes with it.</p>
            <input value={peerId} onChange={(e) => setPeerId(e.target.value)} placeholder="Peer id" aria-label="Peer id" list="peer-ids" />
            <datalist id="peer-ids">
              {(status.peers ?? []).map((p) => (
                <option key={p.peerId} value={p.peerId} />
              ))}
            </datalist>
            <button className="btn" disabled={!focus || !peerId.trim()}>
              Share focus
            </button>
          </form>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
