import React from 'react';
import ReactDOM from 'react-dom/client';
import { ModuleRegistry, AllCommunityModule } from 'ag-grid-community';
import '@fontsource-variable/geist';
import './index.css';
import App from './App';
import { PayPalReturn } from './components/PayPalReturn';
import { isPayPalReturn } from './lib/paypalReturn';
import { ThemeProvider } from './contexts/ThemeContext';
import { ToastProvider } from './contexts/ToastContext';

ModuleRegistry.registerModules([AllCommunityModule]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <ToastProvider>
        {/* PayPal's redirect lands in the approval popup: show a small confirmation there, not the app. */}
        {isPayPalReturn() ? <PayPalReturn /> : <App />}
      </ToastProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
