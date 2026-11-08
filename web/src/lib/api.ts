import { DashboardSpec } from '../spec';

const API_BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') || '';

export interface ActionCard {
  id: string;
  type: 'paypal_order' | 'autopay';
  description: string;
  amount: number;
  merchant?: string;
  cadence?: string;
  status: 'pending' | 'approved' | 'declined';
}

export type StatusSource = 'webhook' | 'poll' | 'pilot' | 'simulated';

/** One step in a PayPal order/subscription's life, from a webhook, a live poll, a Pilot call or the simulator. */
export interface StatusEntry {
  status: string;
  label: string;
  source: StatusSource;
  eventType?: string;
  at: string;
}

/** Pushed on GET /api/events whenever PayPal status changes. */
export interface ActionStatusEvent extends StatusEntry {
  actionId: string;
  kind: 'order' | 'subscription';
  resourceId: string;
  demo: boolean;
  captured: boolean;
}

export interface ActionStatusSnapshot {
  actionId: string;
  status: string | null;
  captured: boolean;
  demo: boolean;
  timeline: StatusEntry[];
}

export interface ApproveResult {
  status?: string;
  success: boolean;
  orderId?: string;
  subscriptionId?: string;
  approvalUrl?: string;
  planId?: string;
  demo?: boolean;
  /** Why a result is simulated, e.g. "PayPal sandbox was unavailable". */
  note?: string;
  error?: string;
}

export interface CaptureResult {
  status: 'COMPLETED' | 'NOT_APPROVED' | 'FAILED' | string;
  demo: boolean;
  message?: string;
}

export interface HealthInfo {
  status: string;
  /** `fallback` = configured, but the last call failed and seed data was used instead. */
  llm: 'configured' | 'mock' | 'fallback';
  paypal: 'sandbox' | 'mock';
  paypalMode?: 'sandbox' | 'simulate';
  paypalCredentials?: boolean;
  /** How PayPal status updates arrive: simulated from seed data, verified sandbox webhooks, or not set up (polling). */
  paypalWebhooks?: 'simulated' | 'verified' | 'unconfigured';
  liveTransactions?: 'off' | 'synced' | 'error';
  elastic: 'configured' | 'fallback' | 'disabled';
  channel3: 'configured' | 'mock' | 'fallback';
  transactions: number;
}

/** Error from a JSON API call, keeping the HTTP status and the server's body (code, status, result). */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: Record<string, unknown>) {
    super(message);
  }
}

export type SSEEvent =
  | { event: 'text'; data: { content: string } }
  | { event: 'dashboard'; data: DashboardSpec }
  | { event: 'action'; data: ActionCard }
  | { event: 'done'; data: Record<string, never> }
  | { event: 'error'; data: { message: string } };

export async function* streamChat(
  messages: Array<{ role: string; content: string }>,
  signal?: AbortSignal,
): AsyncGenerator<SSEEvent> {
  const response = await fetch(`${API_BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
    signal,
  });

  if (!response.ok || !response.body) {
    yield { event: 'error', data: { message: `Server returned ${response.status}` } };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';

    for (const part of parts) {
      let eventType = 'message';
      let eventData = '';
      for (const line of part.split('\n')) {
        if (line.startsWith('event: ')) eventType = line.slice(7).trim();
        else if (line.startsWith('data: ')) eventData += line.slice(6);
      }
      if (!eventData) continue; // heartbeat comments and empty frames
      let data: unknown;
      try {
        data = JSON.parse(eventData);
      } catch {
        continue; // Ignore malformed frames
      }
      if (eventType === 'dashboard') {
        const parsed = DashboardSpec.safeParse(data);
        if (!parsed.success) continue; // never hand the dashboard a spec it can't draw
        data = parsed.data;
      }
      yield { event: eventType, data } as SSEEvent;
    }
  }
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data as unknown as Record<string, unknown>);
  }
  return data;
}

const actionPath = (id: string, verb: string) => `/api/actions/${encodeURIComponent(id)}/${verb}`;
export const approveAction = (id: string) => postJson<ApproveResult>(actionPath(id, 'approve'));
export const declineAction = (id: string) => postJson<{ success: boolean }>(actionPath(id, 'decline'));
export const captureOrder = (id: string, orderId: string) => postJson<CaptureResult>(actionPath(id, 'capture'), { orderId });

export async function fetchActionStatus(id: string): Promise<ActionStatusSnapshot> {
  const res = await fetch(`${API_BASE}${actionPath(id, 'status')}`);
  const data = (await res.json().catch(() => ({}))) as ActionStatusSnapshot & { error?: string };
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data as unknown as Record<string, unknown>);
  return data;
}

/** Tells the server the buyer came back from PayPal, so it re-reads the live status for every open tab. */
export const notifyPayPalReturn = (params: { token?: string; subscription_id?: string }) =>
  postJson<{ actionId: string; status: string | null }>('/api/paypal/return', params);

/**
 * Live PayPal status updates (webhooks, polls, simulator) over Server-Sent Events.
 * EventSource reconnects on its own; returns an unsubscribe function.
 */
export function subscribeStatus(onEvent: (event: ActionStatusEvent) => void): () => void {
  if (typeof EventSource === 'undefined') return () => undefined;
  const source = new EventSource(`${API_BASE}/api/events`);
  const handler = (e: MessageEvent<string>) => {
    try {
      onEvent(JSON.parse(e.data) as ActionStatusEvent);
    } catch {
      // ignore malformed frames
    }
  };
  source.addEventListener('status', handler as EventListener);
  return () => {
    source.removeEventListener('status', handler as EventListener);
    source.close();
  };
}

export async function fetchDefaultDashboard(): Promise<DashboardSpec | null> {
  try {
    const res = await fetch(`${API_BASE}/api/chat/default-dashboard`);
    if (!res.ok) return null;
    const parsed = DashboardSpec.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function fetchHealth(): Promise<HealthInfo | null> {
  try {
    const res = await fetch(`${API_BASE}/api/health`);
    return res.ok ? ((await res.json()) as HealthInfo) : null;
  } catch {
    return null;
  }
}
