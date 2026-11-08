import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import { notifyPayPalReturn } from '../lib/api';
import { announceReturn, openedByPilot, readReturnParams } from '../lib/paypalReturn';
import { PilotGlyph } from './layout/TopBar';

/**
 * Shown in the PayPal popup after approval (or cancel). Tells the server to re-read the live status,
 * tells the Pilot tab, then closes itself. It never loads the full app.
 */
export function PayPalReturn() {
  const [msg] = useState(readReturnParams);
  // Only a window Pilot opened may close itself; one opened from a link or bookmark cannot.
  const [fromPilot] = useState(openedByPilot);
  const [stillOpen, setStillOpen] = useState(false);

  useEffect(() => {
    // Strip the PayPal query so a refresh of this window doesn't report twice.
    window.history.replaceState(null, '', window.location.pathname);
    const finish = (actionId?: string) => {
      // Tells the Pilot tab, which also closes this window if the browser lets it.
      announceReturn({ ...msg, actionId });
      window.setTimeout(() => {
        window.close();
        window.setTimeout(() => setStillOpen(true), 400);
      }, 700);
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
          {!stillOpen
            ? 'Returning you to Pilot…'
            : fromPilot
              ? 'Your Pilot tab is updated. You can close this window.'
              : ok
                ? 'Pilot has the approval. Switch back to your Pilot tab to capture the payment, or open Pilot here.'
                : 'Nothing was charged. Switch back to your Pilot tab, or open Pilot here.'}
        </p>
        {stillOpen && (
          // Browsers block window.close() for windows a script didn't open, so offer a link instead.
          <a className="btn-secondary" href={window.location.pathname}>Open Pilot</a>
        )}
      </div>
    </div>
  );
}
