import React from 'react';
import ReactDOM from 'react-dom/client';
import { ModuleRegistry, AllCommunityModule } from 'ag-grid-community';
import '@fontsource-variable/geist';
import './index.css';
import App from './App';
import { ThemeProvider } from './contexts/ThemeContext';
import { ToastProvider } from './contexts/ToastContext';

ModuleRegistry.registerModules([AllCommunityModule]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <ToastProvider>
        <App />
      </ToastProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
