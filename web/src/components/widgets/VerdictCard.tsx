import { useState } from 'react';
import { motion } from 'framer-motion';
import { Check, Clock, X, ShoppingBag } from 'lucide-react';
import type { VerdictWidget } from '../../spec';
import { formatCurrency } from '../../lib/format';
import { ActionControls } from '../actions/ActionControls';

const DECISION = {
  yes: { label: 'Yes', sub: 'Safe to buy', Icon: Check, cls: 'verdict-yes', color: 'var(--success)' },
  wait: { label: 'Wait', sub: 'Better after payday', Icon: Clock, cls: 'verdict-wait', color: 'var(--warning)' },
  no: { label: 'No', sub: 'Not this month', Icon: X, cls: 'verdict-no', color: 'var(--danger)' },
} as const;

export function VerdictCard({ widget }: { widget: VerdictWidget }) {
  const d = DECISION[widget.decision];
  const [imgOk, setImgOk] = useState(true);
  const showImage = !!widget.item.image && imgOk;

  return (
    <section className="card h-full p-5 flex flex-col gap-5 overflow-hidden relative" aria-label={`Verdict: ${d.label}`}>
      <div className="verdict-glow" style={{ background: `radial-gradient(60% 80% at 0% 0%, ${d.color}22, transparent 70%)` }} aria-hidden="true" />

      <div className="relative flex items-start gap-4">
        <motion.div
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 320, damping: 18, delay: 0.15 }}
          className={`verdict-badge ${d.cls}`}
        >
          <d.Icon size={22} strokeWidth={2.75} />
          <span>{d.label}</span>
        </motion.div>
        <div className="min-w-0 flex-1">
          <p className="card-title">{widget.title ?? 'Purchase verdict'}</p>
          <p className="text-sm mt-1" style={{ color: d.color }}>{d.sub}</p>
        </div>
      </div>

      <div className="relative flex items-center gap-4 rounded-2xl p-3" style={{ background: 'var(--bg-inset)', border: '1px solid var(--border)' }}>
        <div className="w-16 h-16 rounded-xl overflow-hidden shrink-0 flex items-center justify-center product-thumb">
          {showImage
            ? <img src={widget.item.image} alt="" className="w-full h-full object-cover" onError={() => setImgOk(false)} />
            : <ShoppingBag size={24} className="text-white/90" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-medium truncate" style={{ color: 'var(--text)' }}>{widget.item.title}</p>
          {widget.item.retailer && <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>{widget.item.retailer}</p>}
        </div>
        <p className="text-2xl font-light tabular-nums shrink-0" style={{ color: 'var(--text)' }}>
          {formatCurrency(widget.item.price, true)}
        </p>
      </div>

      <ul className="relative flex flex-col gap-2.5 text-[13px] leading-relaxed">
        {widget.reasoning.map((r, i) => (
          <motion.li
            key={i}
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.25 + i * 0.06 }}
            className="flex gap-2.5"
            style={{ color: 'var(--text-soft)' }}
          >
            <span className="mt-[7px] w-1.5 h-1.5 rounded-full shrink-0" style={{ background: i === widget.reasoning.length - 1 ? d.color : 'var(--muted)' }} />
            <span>{r}</span>
          </motion.li>
        ))}
      </ul>

      <div className="relative mt-auto pt-4 flex flex-wrap items-end justify-between gap-4" style={{ borderTop: '1px solid var(--border)' }}>
        <div>
          <p className="card-title">Month-end balance after purchase</p>
          <p className="text-3xl font-light tabular-nums mt-1" style={{ color: widget.endOfMonthBalance < 0 ? 'var(--danger)' : 'var(--text)' }}>
            {formatCurrency(widget.endOfMonthBalance)}
          </p>
        </div>
        {widget.actionId && (
          <ActionControls
            actionId={widget.actionId}
            approveLabel={widget.decision === 'yes' ? undefined : 'Override and buy'}
            compact
          />
        )}
      </div>
    </section>
  );
}
