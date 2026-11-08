import { fetchText, markFailed, markOk, serviceState } from '../status';

const BASE_URL = (process.env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com').replace(/\/$/, '');
const CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const APP_URL = (process.env.APP_URL || 'http://localhost:5173').replace(/\/$/, '');
const TIMEOUT_MS = 10_000;

/**
 * `simulate` (default) never sends anything to PayPal. `sandbox` is opt-in and talks to the PayPal
 * sandbox when credentials are set; the sandbox keeps every product, plan and payment permanently.
 */
export const paypalMode: 'sandbox' | 'simulate' =
  (process.env.PAYPAL_MODE || '').trim().toLowerCase() === 'sandbox' ? 'sandbox' : 'simulate';

export const hasPayPalCredentials = !!(CLIENT_ID && CLIENT_SECRET);

/** True when requests will actually be sent to PayPal. */
export const isPayPalConfigured = hasPayPalCredentials && paypalMode === 'sandbox';

/**
 * What /api/health reports: `sandbox` only when credentials work (or haven't been checked yet).
 * Waits at most 3s for a credential check that is already in flight, never starts a new one.
 */
export async function paypalHealth(): Promise<'sandbox' | 'mock'> {
  if (!isPayPalConfigured) return 'mock';
  if (tokenInFlight) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      tokenInFlight.catch(() => undefined),
      new Promise(resolve => { timer = setTimeout(resolve, 3_000); }),
    ]);
    clearTimeout(timer);
  }
  return serviceState('paypal').ok === false ? 'mock' : 'sandbox';
}

let cachedToken: { token: string; expiresAt: number } | null = null;
let tokenInFlight: Promise<string> | null = null;

export class PayPalError extends Error {
  constructor(message: string, readonly status: number, readonly issue?: string) {
    super(message);
  }
}

async function fetchAccessToken(): Promise<string> {
  const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const res = await fetchText(`${BASE_URL}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  }, TIMEOUT_MS);
  if (!res.ok) throw new PayPalError(`PayPal token error ${res.status}`, res.status);
  const data = JSON.parse(res.text) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new PayPalError('PayPal token response had no access_token', res.status);
  cachedToken = { token: data.access_token, expiresAt: Date.now() + Math.max((data.expires_in ?? 600) - 60, 60) * 1000 };
  return cachedToken.token;
}

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token;
  // Share one token request between concurrent callers.
  tokenInFlight ??= fetchAccessToken()
    .then(t => { markOk('paypal'); return t; })
    .catch(err => { markFailed('paypal', err); throw err; })
    .finally(() => { tokenInFlight = null; });
  return tokenInFlight;
}

/** Cheap, non-blocking credential check used at startup so /api/health is honest. */
export function checkPayPalCredentials(): void {
  if (!isPayPalConfigured) return;
  getAccessToken().then(
    () => console.log('[PayPal] sandbox credentials OK'),
    err => console.warn(`[PayPal] credential check failed, approvals will be simulated: ${err instanceof Error ? err.message : err}`),
  );
}

/** Webhook id from the sandbox app (Developer Dashboard → app → Webhooks, or `npm run paypal:webhooks -- create <url>`). */
export const webhookId = (process.env.PAYPAL_WEBHOOK_ID || '').trim();

export async function paypalFetch(path: string, method: string, body?: object): Promise<Record<string, unknown>> {
  const token = await getAccessToken();
  const res = await fetchText(`${BASE_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }, TIMEOUT_MS);

  console.log(`[PayPal] ${method} ${path} -> ${res.status}`);
  let data: Record<string, unknown> = {};
  try { data = res.text ? JSON.parse(res.text) : {}; } catch { /* non-JSON error page */ }
  if (!res.ok) {
    if (res.status === 401) cachedToken = null;
    const issue = (data.details as Array<{ issue?: string }> | undefined)?.[0]?.issue ?? (data.name as string | undefined);
    throw new PayPalError(`PayPal ${method} ${path} failed: ${res.status}${issue ? ` ${issue}` : ''}`, res.status, issue);
  }
  return data;
}

/**
 * Text sent to PayPal is limited to a short label (item or payee name). This strips anything that
 * looks like personal financial data an LLM might paste in: amounts, dates, emails, long numbers.
 */
function safeLabel(text: string, fallback: string): string {
  const cleaned = text
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '')
    .replace(/\$\s?\d[\d,]*(\.\d+)?/g, '')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '')
    .replace(/\b\d{5,}\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

const approveLink = (data: Record<string, unknown>) =>
  ((data.links ?? []) as Array<{ rel: string; href: string }>).find(l => l.rel === 'approve')?.href ?? '';

export interface OrderResult {
  orderId: string;
  approvalUrl: string;
  demo: boolean;
  /** PayPal order status right after creation (PAYER_ACTION_REQUIRED or CREATED). */
  status: string;
  note?: string;
}

export interface SubscriptionResult {
  subscriptionId: string;
  approvalUrl: string;
  planId: string;
  demo: boolean;
  /** PayPal subscription status right after creation (normally APPROVAL_PENDING). */
  status: string;
  note?: string;
}

export interface CaptureResult {
  status: 'COMPLETED' | 'NOT_APPROVED' | 'FAILED' | string;
  demo: boolean;
  /** PayPal capture id: the same id Transaction Search reports for this payment. */
  captureId?: string;
  message?: string;
}

function simulatedNote(): string {
  if (paypalMode === 'simulate') return 'Simulated (PAYPAL_MODE=simulate, the default): nothing was sent to PayPal.';
  if (!hasPayPalCredentials) return 'PayPal is not configured, so this is a simulated result.';
  return 'PayPal sandbox was unavailable, so this is a simulated result.';
}

const demoOrder = (): OrderResult => ({ orderId: `DEMO-ORDER-${Date.now()}`, approvalUrl: '', demo: true, status: 'CREATED', note: simulatedNote() });

export async function createOrder(amount: number, description: string): Promise<OrderResult> {
  if (!isPayPalConfigured) return demoOrder();

  try {
    // Only the amount and a short item label are sent: no transaction history, balances or user details.
    const data = await paypalFetch('/v2/checkout/orders', 'POST', {
      intent: 'CAPTURE',
      purchase_units: [{ amount: { currency_code: 'USD', value: amount.toFixed(2) }, description: safeLabel(description, 'Purchase') }],
      application_context: {
        brand_name: 'Pilot',
        user_action: 'PAY_NOW',
        shipping_preference: 'NO_SHIPPING',
        return_url: `${APP_URL}/?paypal=success`,
        cancel_url: `${APP_URL}/?paypal=cancel`,
      },
    });
    if (typeof data.id !== 'string') throw new Error('PayPal order response had no id');
    return { orderId: data.id, approvalUrl: approveLink(data), demo: false, status: typeof data.status === 'string' ? data.status : 'CREATED' };
  } catch (err) {
    console.error('[PayPal] createOrder failed, simulating:', err instanceof Error ? err.message : err);
    return demoOrder();
  }
}

export async function captureOrder(orderId: string): Promise<CaptureResult> {
  if (orderId.startsWith('DEMO')) {
    return { status: 'COMPLETED', demo: true, captureId: `DEMO-CAPTURE-${Date.now()}`, message: 'Simulated payment. Nothing was charged.' };
  }
  if (!isPayPalConfigured) {
    return { status: 'FAILED', demo: false, message: 'PayPal is not enabled on this server, so a real order cannot be captured.' };
  }
  try {
    const data = await paypalFetch(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, 'POST');
    const capture = (data.purchase_units as Array<{ payments?: { captures?: Array<{ id?: string }> } }> | undefined)?.[0]?.payments?.captures?.[0];
    return { status: (data.status as string) ?? 'COMPLETED', demo: false, captureId: capture?.id };
  } catch (err) {
    const issue = err instanceof PayPalError ? err.issue : undefined;
    if (issue === 'ORDER_NOT_APPROVED' || issue === 'PAYER_ACTION_REQUIRED') {
      return { status: 'NOT_APPROVED', demo: false, message: 'Approve the order in the PayPal sandbox window first, then capture.' };
    }
    if (issue === 'ORDER_ALREADY_CAPTURED') {
      return { status: 'COMPLETED', demo: false, message: 'This order was already captured.' };
    }
    console.error('[PayPal] captureOrder failed:', err instanceof Error ? err.message : err);
    return { status: 'FAILED', demo: false, message: `PayPal could not capture this order${issue ? ` (${issue})` : ''}. Nothing was charged.` };
  }
}

// Catalog products and billing plans are reusable, so create each one once per server run
// instead of adding a new product + plan to the sandbox on every approval.
const productCache = new Map<string, string>();
const planCache = new Map<string, string>();

async function getProductId(name: string): Promise<string> {
  const cached = productCache.get(name);
  if (cached) return cached;
  const product = await paypalFetch('/v1/catalogs/products', 'POST', { name, type: 'SERVICE', category: 'SOFTWARE' });
  if (typeof product.id !== 'string') throw new Error('PayPal product response had no id');
  productCache.set(name, product.id);
  return product.id;
}

async function getPlanId(name: string, amount: number, cadence: string): Promise<string> {
  const key = `${name}|${amount.toFixed(2)}|${cadence}`;
  const cached = planCache.get(key);
  if (cached) return cached;
  const productId = await getProductId(name);
  const plan = await paypalFetch('/v1/billing/plans', 'POST', {
    product_id: productId,
    name: `${name} ${cadence} plan`,
    status: 'ACTIVE',
    billing_cycles: [{
      frequency: { interval_unit: cadence === 'weekly' ? 'WEEK' : 'MONTH', interval_count: 1 },
      tenure_type: 'REGULAR',
      sequence: 1,
      total_cycles: 0,
      pricing_scheme: { fixed_price: { value: amount.toFixed(2), currency_code: 'USD' } },
    }],
    payment_preferences: { auto_bill_outstanding: true },
  });
  if (typeof plan.id !== 'string') throw new Error('PayPal plan response had no id');
  planCache.set(key, plan.id);
  return plan.id;
}

export async function createSubscription(merchant: string, amount: number, cadence: string): Promise<SubscriptionResult> {
  const demo = (): SubscriptionResult => ({
    subscriptionId: `DEMO-SUB-${Date.now()}`,
    approvalUrl: '',
    planId: `DEMO-PLAN-${Date.now()}`,
    demo: true,
    status: 'APPROVAL_PENDING',
    note: simulatedNote(),
  });
  if (!isPayPalConfigured) return demo();

  try {
    // Sent: payee label, amount and cadence. Never transaction history, balances or user details.
    const planId = await getPlanId(safeLabel(merchant, 'Autopay'), amount, cadence);
    const sub = await paypalFetch('/v1/billing/subscriptions', 'POST', {
      plan_id: planId,
      application_context: { brand_name: 'Pilot', user_action: 'SUBSCRIBE_NOW', return_url: `${APP_URL}/?paypal=success`, cancel_url: `${APP_URL}/?paypal=cancel` },
    });
    if (typeof sub.id !== 'string') throw new Error('PayPal subscription response had no id');
    return {
      subscriptionId: sub.id,
      approvalUrl: approveLink(sub),
      planId,
      demo: false,
      status: typeof sub.status === 'string' ? sub.status : 'APPROVAL_PENDING',
    };
  } catch (err) {
    console.error('[PayPal] createSubscription failed, simulating:', err instanceof Error ? err.message : err);
    return demo();
  }
}

/** Live order status from the PayPal sandbox (GET /v2/checkout/orders/{id}). */
export async function getOrderStatus(orderId: string): Promise<string> {
  const data = await paypalFetch(`/v2/checkout/orders/${encodeURIComponent(orderId)}`, 'GET');
  return typeof data.status === 'string' ? data.status : 'UNKNOWN';
}

/** Live subscription status from the PayPal sandbox (GET /v1/billing/subscriptions/{id}). */
export async function getSubscriptionStatus(subscriptionId: string): Promise<string> {
  const data = await paypalFetch(`/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`, 'GET');
  return typeof data.status === 'string' ? data.status : 'UNKNOWN';
}

/** The headers PayPal signs every webhook delivery with. */
export interface WebhookHeaders {
  authAlgo?: string;
  certUrl?: string;
  transmissionId?: string;
  transmissionSig?: string;
  transmissionTime?: string;
}

/**
 * Asks PayPal whether a webhook delivery is genuine (POST /v1/notifications/verify-webhook-signature).
 * Requires PAYPAL_WEBHOOK_ID. Returns false for a forged or replayed-to-another-webhook delivery.
 */
export async function verifyWebhookSignature(headers: WebhookHeaders, event: unknown): Promise<boolean> {
  if (!webhookId) throw new Error('PAYPAL_WEBHOOK_ID is not set');
  const { authAlgo, certUrl, transmissionId, transmissionSig, transmissionTime } = headers;
  if (!authAlgo || !certUrl || !transmissionId || !transmissionSig || !transmissionTime) return false;
  const data = await paypalFetch('/v1/notifications/verify-webhook-signature', 'POST', {
    auth_algo: authAlgo,
    cert_url: certUrl,
    transmission_id: transmissionId,
    transmission_sig: transmissionSig,
    transmission_time: transmissionTime,
    webhook_id: webhookId,
    webhook_event: event,
  });
  return data.verification_status === 'SUCCESS';
}

/**
 * Live USD balance of the sandbox account that owns the app (GET /v1/reporting/balances).
 * Needs the same "Transaction search" feature as Transaction Search.
 */
export async function getBalance(): Promise<number | null> {
  const data = await paypalFetch('/v1/reporting/balances?currency_code=USD', 'GET');
  type Money = { value?: string; currency_code?: string };
  const rows = (data.balances ?? []) as Array<{ currency?: string; available_balance?: Money; total_balance?: Money }>;
  const usd = rows.find(b => b.currency === 'USD') ?? rows[0];
  const value = Number(usd?.available_balance?.value ?? usd?.total_balance?.value);
  return Number.isFinite(value) ? value : null;
}

export interface PayPalTransaction {
  transaction_info?: {
    transaction_id?: string;
    transaction_initiation_date?: string;
    transaction_amount?: { value?: string; currency_code?: string };
    transaction_subject?: string;
    transaction_note?: string;
    transaction_status?: string;
  };
  payer_info?: { payer_name?: { alternate_full_name?: string; given_name?: string; surname?: string } };
  cart_info?: { item_details?: Array<{ item_name?: string }> };
}

/**
 * Sandbox account activity via Transaction Search (GET /v1/reporting/transactions).
 * The sandbox app needs the "Transaction search" feature enabled; PayPal limits a request to 31 days
 * and new transactions can take up to 3 hours to appear.
 */
export async function searchTransactions(start: Date, end: Date): Promise<PayPalTransaction[]> {
  const out: PayPalTransaction[] = [];
  for (let page = 1; page <= 5; page++) {
    const qs = new URLSearchParams({
      start_date: start.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      end_date: end.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      fields: 'transaction_info,payer_info,cart_info',
      page_size: '500',
      page: String(page),
    });
    const data = await paypalFetch(`/v1/reporting/transactions?${qs}`, 'GET');
    out.push(...((data.transaction_details ?? []) as PayPalTransaction[]));
    if (page >= Number(data.total_pages ?? 1)) break;
  }
  return out;
}
