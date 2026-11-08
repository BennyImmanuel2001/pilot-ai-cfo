import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { MessageCircle } from 'lucide-react';
import { TopBar } from './components/layout/TopBar';
import { ChatPanel } from './components/layout/ChatPanel';
import { DashboardPanel } from './components/dashboard/DashboardPanel';
import { useDashboard } from './hooks/useDashboard';
import { useChat } from './hooks/useChat';
import { ActionsContext } from './contexts/ActionsContext';
import { useToast } from './contexts/ToastContext';
import { fetchHealth, subscribeStatus, type HealthInfo } from './lib/api';
import { onPayPalReturn } from './lib/paypalReturn';

function useIsNarrow(maxWidth = 900) {
  const query = `(max-width: ${maxWidth - 1}px)`;
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return narrow;
}

export default function App() {
  const toast = useToast();
  const dashboard = useDashboard();
  const [input, setInput] = useState('');
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [sawSimulated, setSawSimulated] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const isNarrow = useIsNarrow();

  useEffect(() => {
    void fetchHealth().then(setHealth);
  }, []);

  const onStart = useCallback(() => {
    dashboard.setIsLoading(true);
    if (isNarrow) window.setTimeout(() => setDrawerOpen(false), 900);
  }, [dashboard, isNarrow]);

  const onFinish = useCallback((gotDashboard: boolean) => {
    if (!gotDashboard) dashboard.setIsLoading(false);
  }, [dashboard]);

  const onError = useCallback((message: string) => toast(message), [toast]);
  const onDemo = useCallback(() => setSawSimulated(true), []);

  const chat = useChat({ onDashboard: dashboard.updateSpec, onStart, onFinish, onError, onDemo });

  // Live PayPal status: verified sandbox webhooks, live polls, or simulated webhooks in simulate mode.
  const { applyStatus } = chat;
  useEffect(() => subscribeStatus(applyStatus), [applyStatus]);

  // The PayPal popup reports back here after approval; this tab keeps its conversation and refreshes
  // just that order or subscription (the live status also arrives over /api/events).
  const { refreshAction } = chat;
  useEffect(() => onPayPalReturn(msg => {
    if (msg.outcome !== 'success') {
      toast('PayPal approval was cancelled. Nothing was charged.');
      return;
    }
    toast(msg.token && !msg.subscriptionId ? 'Approved in PayPal. You can capture the payment now.' : 'Approved in PayPal.', 'success');
    if (msg.actionId) refreshAction(msg.actionId);
  }), [refreshAction, toast]);

  const actionsApi = useMemo(() => ({
    actions: chat.actions,
    approve: (id: string) => void chat.approve(id),
    decline: (id: string) => void chat.decline(id),
    capture: (id: string, orderId: string) => void chat.capture(id, orderId),
  }), [chat]);

  const chatPanel = (onClose?: () => void) => (
    <ChatPanel
      messages={chat.messages}
      isLoading={chat.isLoading}
      onSend={chat.send}
      input={input}
      setInput={setInput}
      onClose={onClose}
    />
  );

  return (
    <ActionsContext.Provider value={actionsApi}>
      <div className="app-bg" aria-hidden="true" />
      <div className="relative z-10 flex flex-col h-full">
        <TopBar health={health} sawSimulated={sawSimulated} />

        <main className="flex flex-1 min-h-0">
          {!isNarrow && (
            <aside className="chat-pane" aria-label="Chat with Pilot">
              {chatPanel()}
            </aside>
          )}
          <section className="flex-1 min-w-0" aria-label="Dashboard">
            <DashboardPanel
              spec={dashboard.spec}
              specKey={dashboard.specKey}
              isLoading={dashboard.isLoading}
              failed={dashboard.failed}
              onRetry={dashboard.reload}
            />
          </section>
        </main>
      </div>

      {isNarrow && (
        <>
          <motion.button
            className="fab"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open chat"
            whileTap={{ scale: 0.92 }}
            animate={{ scale: drawerOpen ? 0 : 1 }}
          >
            <MessageCircle size={22} />
            {chat.isLoading && <span className="fab-dot" />}
          </motion.button>
          <AnimatePresence>
            {drawerOpen && (
              <>
                <motion.div
                  className="drawer-scrim"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  onClick={() => setDrawerOpen(false)}
                />
                <motion.aside
                  className="drawer"
                  role="dialog"
                  aria-label="Chat with Pilot"
                  initial={{ x: '-100%' }}
                  animate={{ x: 0 }}
                  exit={{ x: '-100%' }}
                  transition={{ type: 'spring', stiffness: 380, damping: 38 }}
                >
                  {chatPanel(() => setDrawerOpen(false))}
                </motion.aside>
              </>
            )}
          </AnimatePresence>
        </>
      )}
    </ActionsContext.Provider>
  );
}
