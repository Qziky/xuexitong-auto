import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../src/ui/App';
import '../src/ui/style.css';
createRoot(document.getElementById('root')!).render(<App />);
