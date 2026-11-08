import { Fragment, useEffect, useRef, type KeyboardEvent } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, ArrowUp, Loader2, CreditCard, Repeat, X } from 'lucide-react';
import type { Message } from '../../hooks/useChat';
import { useActions } from '../../contexts/ActionsContext';
import { ActionControls } from '../actions/ActionControls';
import { formatCurrency } from '../../lib/format';
import { PilotGlyph } from './TopBar';

interface ChatPanelProps {
  messages: Message[];
  isLoading: boolean;
  onSend: (text: string) => void;
  input: string;
  setInput: (v: string) => void;
  onClose?: () => void;
}

export const CHIPS = [
  'Can I afford a PS5?',
  'Food spend last 6 months',
  'Project my expenses this month',
  'Find bills I should autopay',
];

function TypingIndicator() {
  return (
    <div className="flex gap-1.5 items-center h-5" aria-label="Pilot is thinking">
      <span className="typing-dot" />
      <span className="typing-dot" />
      <span className="typing-dot" />
    </div>
  );
}

function InlineAction({ id }: { id: string }) {
  const { actions } = useActions();
  const state = actions[id];
  if (!state) return null;
  const { card } = state;
  const isOrder = card.type === 'paypal_order';
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.1 }}
      className="action-card"
    >
      <div className="flex items-center gap-2.5 mb-3">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'rgba(99,102,241,0.14)', color: 'var(--accent-indigo)' }}>
          {isOrder ? <CreditCard size={15} /> : <Repeat size={15} />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] uppercase tracking-wider font-medium" style={{ color: 'var(--muted)' }}>
            {isOrder ? 'PayPal order · needs approval' : 'PayPal subscription · needs approval'}
          </p>
          <p className="text-sm font-medium truncate" style={{ color: 'var(--text)' }}>{card.description}</p>
        </div>
        <p className="text-sm tabular-nums font-medium shrink-0" style={{ color: 'var(--text)' }}>
          {formatCurrency(card.amount, true)}{card.cadence ? <span style={{ color: 'var(--muted)' }}>/{card.cadence === 'monthly' ? 'mo' : 'wk'}</span> : null}
        </p>
      </div>
      <ActionControls actionId={id} compact />
    </motion.div>
  );
}

function FormattedText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith('**') && part.endsWith('**')
          ? <strong key={i}>{part.slice(2, -2)}</strong>
          : <Fragment key={i}>{part}</Fragment>,
      )}
    </>
  );
}

export function ChatPanel({ messages, isLoading, onSend, input, setInput, onClose }: ChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [input]);

  const handleSend = (text = input) => {
    if (!text.trim() || isLoading) return;
    setInput('');
    onSend(text);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const isEmpty = messages.length === 0;
  const canSend = !!input.trim() && !isLoading;

  return (
    <div className="flex flex-col h-full">
      {onClose && (
        <div className="flex items-center justify-between px-4 pt-3">
          <span className="text-sm font-medium" style={{ color: 'var(--muted)' }}>Chat</span>
          <button onClick={onClose} className="icon-btn" aria-label="Close chat"><X size={16} /></button>
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-5 flex flex-col gap-4 min-h-0" aria-live="polite">
        {isEmpty && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: 'easeOut' }}
            className="flex flex-col justify-center flex-1 gap-6 px-1"
          >
            <div>
              <PilotGlyph size={40} />
              <h2 className="text-xl font-semibold tracking-tight mt-5" style={{ color: 'var(--text)' }}>Good to see you.</h2>
              <p className="text-sm mt-1.5 leading-relaxed" style={{ color: 'var(--muted)' }}>
                Ask your money a question. You'll get a decision, a dashboard, and a PayPal action you can approve.
              </p>
            </div>
            <div className="flex flex-col gap-2">
              {CHIPS.map((chip, i) => (
                <motion.button
                  key={chip}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.15 + i * 0.06 }}
                  className="prompt-row"
                  onClick={() => handleSend(chip)}
                >
                  {chip}
                  <ArrowUp size={13} className="rotate-45 opacity-50" />
                </motion.button>
              ))}
            </div>
          </motion.div>
        )}

        <AnimatePresence initial={false}>
          {messages.map(msg => (
            <motion.div
              key={msg.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, ease: 'easeOut' }}
              className={`flex flex-col gap-2 ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
            >
              {msg.role === 'user' ? (
                <div className="bubble-user">{msg.content}</div>
              ) : (
                <div className="flex gap-2.5 w-full">
                  <PilotGlyph size={24} />
                  <div className="flex-1 min-w-0 flex flex-col gap-2.5">
                    <div className="bubble-assistant">
                      {msg.content ? <FormattedText text={msg.content} /> : <TypingIndicator />}
                      {msg.streaming && msg.content && <span className="caret" aria-hidden="true" />}
                    </div>
                    {msg.failed && (
                      <p className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--danger)' }} role="status">
                        <AlertTriangle size={12} /> This reply didn't finish. Send your question again to retry.
                      </p>
                    )}
                    {msg.actionIds?.map(id => <InlineAction key={id} id={id} />)}
                  </div>
                </div>
              )}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {!isEmpty && (
        <div className="px-4 pb-2 flex gap-2 overflow-x-auto no-scrollbar shrink-0">
          {CHIPS.map(chip => (
            <button key={chip} className="chip shrink-0" onClick={() => handleSend(chip)} disabled={isLoading}>
              {chip}
            </button>
          ))}
        </div>
      )}

      <div className="px-4 pb-4 pt-1 shrink-0">
        <div className="composer">
          <textarea
            ref={inputRef}
            id="chat-input"
            rows={1}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about your money…"
            aria-label="Message Pilot"
            className="flex-1 bg-transparent text-sm outline-none resize-none py-1.5 leading-relaxed"
          />
          <button
            onClick={() => handleSend()}
            disabled={!canSend}
            aria-label="Send message"
            className="send-btn"
          >
            {isLoading ? <Loader2 size={15} className="animate-spin" /> : <ArrowUp size={15} strokeWidth={2.5} />}
          </button>
        </div>
      </div>
    </div>
  );
}
