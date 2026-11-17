import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles/tokens.css';
import './styles/base.css';
import './styles/scrim.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { openFromNotification } from './lib/push';
import { router } from './lib/router.svelte';
import { usage } from './lib/usage';

mount(App, { target: document.getElementById('app')! });

// The service worker (public/sw.js) shows push notifications and routes taps on them back here.
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'nudge.open') {
      usage.count('push.open');
      openFromNotification(e.data.url, (r) => router.navigate(r.route, r.query, { id: r.params.id }));
    }
  });
  navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('Service worker registration failed', err));
}
