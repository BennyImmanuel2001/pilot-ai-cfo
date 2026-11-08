import { useState, useRef, useCallback, useEffect } from 'react';
import { DashboardSpec } from '../spec';
import {
  ActionCard, ActionStatusEvent, ActionStatusSnapshot, ApiError, ApproveResult, StatusEntry,
  streamChat, approveAction, declineAction, captureOrder, fetchActionStatus,
} from '../lib/api';

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
  /** The turn did not finish (server unreachable or the stream dropped). */
  failed?: boolean;
  actionIds?: string[];
}

export type ActionPhase = 'pending' | 'working' | 'approved' | 'capturing' | 'declined' | 'captured' | 'expired';

export interface ActionState {
  card: ActionCard;
  phase: ActionPhase;
  result?: ApproveResult;
  captureStatus?: string;
  /** Latest PayPal status (CREATED, APPROVED, COMPLETED, APPROVAL_PENDING, ACTIVE…). */
  providerStatus?: string;
  /** Status history pushed by the server: webhooks, live polls, Pilot calls or the simulator. */
  timeline?: StatusEntry[];
  approvedAt?: number;
}

/** Statuses after which a sandbox object is no longer polled. */
const TERMINAL = new Set(['COMPLETED', 'VOIDED', 'DENIED', 'REFUNDED', 'ACTIVE', 'CANCELLED', 'EXPIRED', 'SUSPENDED']);
/** Fallback polling for real sandbox objects when webhooks can't reach the server (e.g. localhost). */
const POLL_MS = 5_000;
const POLL_FOR_MS = 15 * 60_000;

function mergeTimeline(current: StatusEntry[] = [], incoming: StatusEntry[]): StatusEntry[] {
  const key = (t: StatusEntry) => `${t.at}|${t.status}|${t.source}`;
  const seen = new Set(current.map(key));
  return [...current, ...incoming.filter(t => !seen.has(key(t)))].slice(-20);
}

interface UseChatOptions {
  onDashboard: (spec: DashboardSpec) => void;
  onStart?: () => void;
  onFinish?: (gotDashboard: boolean) => void;
  onError?: (message: string) => void;
  onDemo?: () => void;
}

/** The server sends a heartbeat every 10s, so this much silence means the connection is gone. */
const STREAM_IDLE_MS = 45_000;

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

const errorText = (err: unknown, fallback: string) => (err instanceof Error && err.message ? err.message : fallback);

export function useChat({ onDashboard, onStart, onFinish, onError, onDemo }: UseChatOptions) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [actions, setActions] = useState<Record<string, ActionState>>({});
  const [isLoading, setIsLoading] = useState(false);
  const loadingRef = useRef(false);
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;

  const patchAssistant = useCallback((id: string, patch: (m: Message) => Message) => {
    setMessages(prev => prev.map(m => (m.id === id ? patch(m) : m)));
  }, []);

  const send = useCallback(async (userText: string) => {
    const text = userText.trim();
    if (!text || loadingRef.current) return;
    loadingRef.current = true;
    setIsLoading(true);
    onStart?.();

    const userMsg: Message = { id: uid(), role: 'user', content: text };
    const assistantId = uid();
    // Failed turns are left out of the history so the model doesn't see half answers.
    const history = [...messagesRef.current.filter(m => !m.failed), userMsg].map(m => ({ role: m.role, content: m.content }));
    setMessages(prev => [...prev, userMsg, { id: assistantId, role: 'assistant', content: '', streaming: true, actionIds: [] }]);

    const controller = new AbortController();
    let idleTimer = 0;
    const resetIdle = () => {
      window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => controller.abort(), STREAM_IDLE_MS);
    };

    let acc = '';
    let gotDashboard = false;
    let gotDone = false;
    let failure: string | null = null;
    try {
      resetIdle();
      for await (const event of streamChat(history, controller.signal)) {
        resetIdle();
        if (event.event === 'text') {
          acc += event.data.content;
          const snapshot = acc;
          patchAssistant(assistantId, m => ({ ...m, content: snapshot }));
        } else if (event.event === 'dashboard') {
          gotDashboard = true;
          onDashboard(event.data);
        } else if (event.event === 'action') {
          const card = event.data;
          setActions(prev => ({ ...prev, [card.id]: { card, phase: 'pending' } }));
          patchAssistant(assistantId, m => ({ ...m, actionIds: [...(m.actionIds ?? []), card.id] }));
        } else if (event.event === 'done') {
          gotDone = true;
        } else if (event.event === 'error') {
          throw new Error(event.data.message);
        }
      }
      if (!gotDone) failure = 'The connection dropped before Pilot finished.';
    } catch (err) {
      failure = controller.signal.aborted
        ? 'Pilot stopped responding.'
        : acc
          ? `The connection dropped before Pilot finished: ${errorText(err, 'network error')}`
          : `Pilot couldn't reach the server: ${errorText(err, 'network error')}`;
    } finally {
      window.clearTimeout(idleTimer);
    }

    if (failure) {
      onError?.(`${failure} Try sending it again.`);
      if (!acc) acc = "I couldn't reach the server just now. Check that the API is running and try again.";
    }

    const finalText = acc || 'Done. The dashboard has the details.';
    patchAssistant(assistantId, m => ({ ...m, content: finalText, streaming: false, failed: !!failure }));
    loadingRef.current = false;
    setIsLoading(false);
    onFinish?.(gotDashboard);
  }, [onDashboard, onStart, onFinish, onError, patchAssistant]);

  const setPhase = (id: string, patch: Partial<ActionState>) =>
    setActions(prev => (prev[id] ? { ...prev, [id]: { ...prev[id], ...patch } } : prev));

  /** Applies a live PayPal status update (from GET /api/events). */
  const applyStatus = useCallback((evt: ActionStatusEvent) => {
    setActions(prev => {
      const cur = prev[evt.actionId];
      if (!cur) return prev;
      const entry: StatusEntry = { status: evt.status, label: evt.label, source: evt.source, eventType: evt.eventType, at: evt.at };
      const next: ActionState = { ...cur, providerStatus: evt.status, timeline: mergeTimeline(cur.timeline, [entry]) };
      if (evt.kind === 'order' && evt.captured && cur.phase !== 'captured') {
        next.phase = 'captured';
        next.captureStatus = 'COMPLETED';
      }
      return { ...prev, [evt.actionId]: next };
    });
  }, []);

  /** Applies a GET /api/actions/:id/status snapshot (live read from the PayPal sandbox). */
  const applySnapshot = useCallback((snap: ActionStatusSnapshot) => {
    setActions(prev => {
      const cur = prev[snap.actionId];
      if (!cur) return prev;
      const next: ActionState = { ...cur, providerStatus: snap.status ?? cur.providerStatus, timeline: mergeTimeline(cur.timeline, snap.timeline) };
      if (cur.card.type === 'paypal_order' && snap.captured && cur.phase !== 'captured') {
        next.phase = 'captured';
        next.captureStatus = 'COMPLETED';
      }
      return { ...prev, [snap.actionId]: next };
    });
  }, []);

  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  useEffect(() => {
    const timer = window.setInterval(() => {
      for (const [id, a] of Object.entries(actionsRef.current)) {
        if (!a.result || a.result.demo) continue;
        if (a.phase !== 'approved' && a.phase !== 'capturing') continue;
        if (TERMINAL.has(a.providerStatus ?? '')) continue;
        if (a.approvedAt && Date.now() - a.approvedAt > POLL_FOR_MS) continue;
        void fetchActionStatus(id).then(applySnapshot).catch(() => undefined);
      }
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [applySnapshot]);

  /**
   * Maps a 404/409 from the actions API onto the card's real state, so a stale or repeated click
   * never leaves the buttons in a state the server will keep rejecting.
   */
  const reconcile = (id: string, err: unknown, fallbackPhase: ActionPhase): void => {
    if (err instanceof ApiError) {
      const body = err.body;
      if (err.status === 404) {
        setPhase(id, { phase: 'expired' });
        onError?.(err.message);
        return;
      }
      if (err.status === 409 && body.status === 'declined') {
        setPhase(id, { phase: 'declined' });
        return;
      }
      if (err.status === 409 && body.status === 'approved' && body.result) {
        const result = body.result as ApproveResult;
        setPhase(id, { phase: 'approved', result });
        if (result.demo) onDemo?.();
        onError?.(err.message);
        return;
      }
    }
    setPhase(id, { phase: fallbackPhase });
    onError?.(errorText(err, 'Something went wrong. Please try again.'));
  };

  const approve = useCallback(async (id: string) => {
    setPhase(id, { phase: 'working' });
    try {
      const result = await approveAction(id);
      setActions(prev => (prev[id] ? {
        ...prev,
        [id]: { ...prev[id], phase: 'approved', result, approvedAt: Date.now(), providerStatus: prev[id].providerStatus ?? result.status },
      } : prev));
      if (result.demo) onDemo?.();
      return result;
    } catch (err) {
      reconcile(id, err, 'pending');
      return null;
    }
  }, [onDemo, onError]);

  const decline = useCallback(async (id: string) => {
    setPhase(id, { phase: 'working' });
    try {
      await declineAction(id);
      setPhase(id, { phase: 'declined' });
    } catch (err) {
      reconcile(id, err, 'pending');
    }
  }, [onDemo, onError]);

  const capture = useCallback(async (id: string, orderId: string) => {
    setPhase(id, { phase: 'capturing' });
    try {
      const res = await captureOrder(id, orderId);
      if (res.status === 'NOT_APPROVED') {
        // Normal for a real sandbox order: the buyer still has to approve it in PayPal.
        setPhase(id, { phase: 'approved' });
        onError?.(res.message ?? 'Approve the order in the PayPal sandbox window first, then capture.');
        return;
      }
      setPhase(id, { phase: 'captured', captureStatus: res.status });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        reconcile(id, err, 'approved');
        return;
      }
      setPhase(id, { phase: 'approved' });
      onError?.(errorText(err, 'Capture failed. Nothing was charged.'));
    }
  }, [onDemo, onError]);

  /** Re-reads one action's PayPal status now (used when the PayPal popup reports back). */
  const refreshAction = useCallback((id: string) => {
    void fetchActionStatus(id).then(applySnapshot).catch(() => undefined);
  }, [applySnapshot]);

  return { messages, actions, isLoading, send, approve, decline, capture, applyStatus, refreshAction };
}
