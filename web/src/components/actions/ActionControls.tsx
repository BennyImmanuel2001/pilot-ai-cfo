import { AlertTriangle, CheckCircle2, Clock3, ExternalLink, Loader2, XCircle, CreditCard, Repeat } from 'lucide-react';
import type { StatusEntry, StatusSource } from '../../lib/api';
import { useActions } from '../../contexts/ActionsContext';
import { openPayPal } from '../../lib/paypalReturn';
import { formatCurrency } from '../../lib/format';

interface Props {
  actionId: string;
  /** Label for the approve button, e.g. "Override and buy". */
  approveLabel?: string;
  compact?: boolean;
}

/** Short badge text, with the full explanation as a tooltip. */
const SOURCE_LABEL: Record<StatusSource, [string, string]> = {
  webhook: ['webhook', 'Signature-verified PayPal sandbox webhook'],
  poll: ['live', 'Read live from the PayPal sandbox'],
  pilot: ['API', 'PayPal API response to a call Pilot made'],
  simulated: ['simulated', 'Simulated webhook (PAYPAL_MODE=simulate): same event shape as PayPal, built from seed data'],
};

const GOOD = new Set(['APPROVED', 'COMPLETED', 'ACTIVE']);
const BAD = new Set(['DENIED', 'VOIDED', 'REFUNDED', 'CANCELLED', 'SUSPENDED', 'EXPIRED', 'PAYMENT_FAILED']);

/** Latest PayPal status with where it came from, plus the two steps before it. */
function StatusTimeline({ timeline }: { timeline?: StatusEntry[] }) {
  if (!timeline?.length) return null;
  const recent = timeline.slice(-3).reverse();
  return (
    <ol className="flex flex-col gap-1" aria-label="PayPal status" aria-live="polite">
      {recent.map((t, i) => {
        const Icon = BAD.has(t.status) ? AlertTriangle : GOOD.has(t.status) ? CheckCircle2 : Clock3;
        const color = BAD.has(t.status) ? 'var(--danger, #F87171)' : GOOD.has(t.status) ? 'var(--success, #34D399)' : 'var(--muted)';
        const time = new Date(t.at);
        return (
          <li key={`${t.at}-${t.status}-${t.source}`} className="flex items-center gap-1.5 text-[11px]" style={{ opacity: i === 0 ? 1 : 0.6 }}>
            <Icon size={12} style={{ color, flexShrink: 0 }} />
            <span className="min-w-0 truncate" style={{ color: i === 0 ? 'var(--text)' : 'var(--muted)' }} title={t.label}>{t.label}</span>
            <span className="sim-badge whitespace-nowrap shrink-0" title={`${SOURCE_LABEL[t.source][1]}${t.eventType ? ` · ${t.eventType}` : ''}`}>
              {SOURCE_LABEL[t.source][0]}
            </span>
            {!Number.isNaN(time.getTime()) && (
              <span className="tabular-nums whitespace-nowrap shrink-0 ml-auto" style={{ color: 'var(--muted)' }}>
                {time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** Approve / decline buttons and the resulting PayPal state. Shared by chat cards and the verdict widget. */
export function ActionControls({ actionId, approveLabel, compact }: Props) {
  const { actions, approve, decline, capture } = useActions();
  const state = actions[actionId];
  if (!state) return null;

  const { card, phase, result } = state;
  const isOrder = card.type === 'paypal_order';
  const size = compact ? 'text-xs py-1.5 px-3.5' : '';

  if (phase === 'declined') {
    return (
      <div className="result-pill result-muted">
        <XCircle size={14} /> Declined. Nothing was sent to PayPal.
      </div>
    );
  }

  if (phase === 'expired') {
    return (
      <div className="result-pill result-muted">
        <XCircle size={14} /> This proposal expired. Ask Pilot again for a fresh one.
      </div>
    );
  }

  if (phase === 'captured') {
    return (
      <div className="flex flex-col gap-2">
        <div className="result-pill result-success">
          <CheckCircle2 size={14} /> Payment {state.captureStatus?.toLowerCase() ?? 'completed'}
          {result?.demo && <span className="sim-badge">simulated</span>}
        </div>
        <StatusTimeline timeline={state.timeline} />
      </div>
    );
  }

  if ((phase === 'approved' || phase === 'capturing') && result) {
    const id = result.orderId ?? result.subscriptionId;
    const capturing = phase === 'capturing';
    return (
      <div className="flex flex-col gap-2">
        <div className="result-pill result-success">
          <CheckCircle2 size={14} />
          {isOrder ? 'PayPal order created' : 'PayPal subscription created'}
          {result.demo && <span className="sim-badge">simulated</span>}
        </div>
        {id && (
          <p className="text-[11px] tabular-nums" style={{ color: 'var(--muted)' }}>
            {isOrder ? 'Order' : 'Subscription'} ID <code className="mono">{id}</code>
          </p>
        )}
        <StatusTimeline timeline={state.timeline} />
        {result.demo && result.note && (
          <p className="text-[11px]" style={{ color: 'var(--muted)' }}>{result.note}</p>
        )}
        <div className="flex flex-wrap gap-2">
          {result.approvalUrl && (
            <button type="button" onClick={() => openPayPal(result.approvalUrl!)} className={`btn-secondary ${size}`}>
              {isOrder ? 'Complete in PayPal sandbox' : 'Approve in PayPal sandbox'} <ExternalLink size={12} />
            </button>
          )}
          {isOrder && result.orderId && (
            <button
              className={`${state.providerStatus === 'APPROVED' ? 'btn-primary' : 'btn-secondary'} ${size}`}
              onClick={() => capture(actionId, result.orderId!)}
              disabled={capturing}
            >
              {capturing && <Loader2 size={13} className="animate-spin" />}
              Capture payment
            </button>
          )}
        </div>
      </div>
    );
  }

  const working = phase === 'working';
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        className={`btn-primary ${size}`}
        onClick={() => approve(actionId)}
        disabled={working}
        aria-label={`Approve ${card.description}`}
      >
        {working ? <Loader2 size={13} className="animate-spin" /> : isOrder ? <CreditCard size={13} /> : <Repeat size={13} />}
        {approveLabel ?? (isOrder ? `Pay ${formatCurrency(card.amount, true)} with PayPal` : 'Approve autopay')}
      </button>
      <button className={`btn-ghost ${size}`} onClick={() => decline(actionId)} disabled={working}>
        Decline
      </button>
    </div>
  );
}
