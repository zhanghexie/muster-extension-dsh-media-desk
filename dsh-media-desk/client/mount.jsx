import React from 'react';
import { createRoot } from 'react-dom/client';
import { Desk } from './index.jsx';

const syncTheme = () => document.body.toggleAttribute('data-ds-dark-theme', document.documentElement.dataset.theme === 'dark');
new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
syncTheme();
window.ma.ready.then(() => createRoot(document.getElementById('root')).render(<Desk />)).catch(error => { document.getElementById('root').textContent = error.message; });
