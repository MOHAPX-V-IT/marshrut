import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import '@xyflow/react/dist/style.css';
import '@fontsource/manrope/cyrillic-400.css';
import '@fontsource/manrope/cyrillic-500.css';
import '@fontsource/manrope/cyrillic-600.css';
import '@fontsource/manrope/cyrillic-700.css';
import '@fontsource/manrope/latin-400.css';
import '@fontsource/manrope/latin-500.css';
import '@fontsource/manrope/latin-600.css';
import '@fontsource/manrope/latin-700.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import './style.css';
import './identity.css';
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
