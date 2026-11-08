import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import { notifyPayPalReturn } from '../lib/api';
import { announceReturn, readReturnParams } from '../lib/paypalReturn';
import { PilotGlyph } from './layout/TopBar';

/**
 * Shown in the PayPal popup after approval (or cancel). Tells the server to re-read the live status,
 * tells the Pilot tab, then closes itself. It never loads the full app.
 */
export function PayPalReturn() {
  const [msg] = useState(readReturnParams);
  const [closeFailed, setCloseFailed] = useState(false);

  useEffect(() => {
    // Strip the PayPal query so a refresh of this window doesn't report twice.
    window.history.replaceState(null, '', window.location.pathname);
    const finish = (actionId?: string) => {
      announceReturn({ ...msg, actionId });
      window.setTimeout(() => {
        window.close();
        // Browsers only let scripts close windows they opened; if this one stays, say so.
        window.setTimeout(() => setCloseFailed(true), 300);
      }, 900);
    };
    if (msg.outcome === 'success' && (msg.token || msg.subscriptionId)) {
      notifyPayPalReturn({ token: msg.token, subscription_id: msg.subscriptionId })
        .then(r => finish(r.actionId))
        .catch(() => finish());
    } else {
      finish();
    }
  }, [msg]);

  const ok = msg.outcome === 'success';
  return (
    <div className="h-full flex items-center justify-center p-6" style={{ background: 'var(--bg-base)' }}>
      <div className="card p-8 max-w-sm w-full text-center flex flex-col items-center gap-4">
        <PilotGlyph />
        {ok ? <CheckCircle2 size={36} style={{ color: 'var(--success)' }} /> : <XCircle size={36} style={{ color: 'var(--muted)' }} />}
        <h1 className="text-lg font-semibold">{ok ? 'Approved in PayPal' : 'PayPal approval cancelled'}</h1>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          {closeFailed
            ? 'You can close this window. Your Pilot tab has already been updated.'
            : 'Returning you to Pilot…'}
        </p>
        {closeFailed && (
          <button className="btn-secondary" onClick={() => window.close()}>Close window</button>
        )}
      </div>
    </div>
  );
}
