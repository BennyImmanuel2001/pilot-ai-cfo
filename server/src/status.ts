/**
 * Last known outcome of each external service, so /api/health can report what is
 * actually live instead of only which env vars are present.
 */
export type ServiceName = 'llm' | 'paypal' | 'channel3' | 'elastic';

interface ServiceState {
  ok: boolean | null; // null = not tried yet
  error?: string;
  at?: number;
}

const state: Record<ServiceName, ServiceState> = {
  llm: { ok: null },
  paypal: { ok: null },
  channel3: { ok: null },
  elastic: { ok: null },
};

export function markOk(name: ServiceName): void {
  state[name] = { ok: true, at: Date.now() };
}

export function markFailed(name: ServiceName, err: unknown): void {
  const error = (err instanceof Error ? err.message : String(err)).slice(0, 200);
  state[name] = { ok: false, error, at: Date.now() };
}

export function serviceState(name: ServiceName): Readonly<ServiceState> {
  return state[name];
}

export interface FetchedText {
  ok: boolean;
  status: number;
  text: string;
}

/**
 * fetch + read the body under one hard timeout (headers and body both count).
 * Rejects with a readable error on timeout or network failure; never hangs.
 */
export async function fetchText(url: string, init: RequestInit, timeoutMs: number): Promise<FetchedText> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } catch (err) {
    if (controller.signal.aborted) throw new Error(`Timed out after ${timeoutMs}ms: ${new URL(url).host}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
