/**
 * PayPal opens in a popup and, after approval, redirects that popup to APP_URL/?paypal=success&token=….
 * The popup only reports back to the Pilot tab that opened it and closes, instead of loading a second
 * copy of the app with fresh data.
 */
export const RETURN_CHANNEL = 'pilot-paypal-return';

export interface PayPalReturnMessage {
  outcome: 'success' | 'cancel';
  token?: string;
  subscriptionId?: string;
  /** Pilot action id, when the server matched the PayPal object. */
  actionId?: string;
}

/** True when this page load is PayPal's redirect back (the popup), not a normal visit. */
export function isPayPalReturn(): boolean {
  return new URLSearchParams(window.location.search).has('paypal');
}

export function readReturnParams(): PayPalReturnMessage {
  const p = new URLSearchParams(window.location.search);
  return {
    outcome: p.get('paypal') === 'success' ? 'success' : 'cancel',
    token: p.get('token') ?? undefined,
    subscriptionId: p.get('subscription_id') ?? undefined,
  };
}

/** Sends the result to the Pilot tab (same origin) over BroadcastChannel and window.opener. */
export function announceReturn(msg: PayPalReturnMessage): void {
  try {
    const ch = new BroadcastChannel(RETURN_CHANNEL);
    ch.postMessage(msg);
    ch.close();
  } catch {
    // BroadcastChannel unsupported: window.opener below still works
  }
  try {
    window.opener?.postMessage({ type: RETURN_CHANNEL, ...msg }, window.location.origin);
  } catch {
    // opener gone or cross-origin
  }
}

/** Listens for PayPal returns in the main Pilot tab. Returns an unsubscribe function. */
export function onPayPalReturn(handler: (msg: PayPalReturnMessage) => void): () => void {
  let ch: BroadcastChannel | null = null;
  const seen = new Set<string>();
  const handle = (msg: PayPalReturnMessage) => {
    const key = `${msg.outcome}|${msg.token ?? ''}|${msg.subscriptionId ?? ''}`;
    if (seen.has(key)) return; // both channels deliver the same message
    seen.add(key);
    handler(msg);
  };
  try {
    ch = new BroadcastChannel(RETURN_CHANNEL);
    ch.onmessage = (e: MessageEvent<PayPalReturnMessage>) => handle(e.data);
  } catch {
    ch = null;
  }
  const onWindow = (e: MessageEvent) => {
    if (e.origin !== window.location.origin || e.data?.type !== RETURN_CHANNEL) return;
    const { type: _type, ...msg } = e.data as PayPalReturnMessage & { type: string };
    handle(msg);
  };
  window.addEventListener('message', onWindow);
  return () => {
    ch?.close();
    window.removeEventListener('message', onWindow);
  };
}

/** Opens PayPal's approval page in a centred popup; falls back to a new tab if popups are blocked. */
export function openPayPal(url: string): void {
  const w = 480;
  const h = 720;
  const left = Math.max(0, window.screenX + (window.outerWidth - w) / 2);
  const top = Math.max(0, window.screenY + (window.outerHeight - h) / 2);
  const popup = window.open(url, 'pilot-paypal', `popup=yes,width=${w},height=${h},left=${left},top=${top}`);
  if (!popup) window.open(url, '_blank');
  else popup.focus();
}
