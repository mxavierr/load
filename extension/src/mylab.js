// Runs on MyLab. Reads the "Homework and Tests" list when the background asks.
import { parseMyLab } from '../../shared/collect.js';

browser.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'parseMyLab') {
    const tryParse = (n) => {
      const rows = parseMyLab();
      if (rows.length || n <= 0) reply({ ok: rows.length > 0, rows, url: location.pathname });
      else setTimeout(() => tryParse(n - 1), 1000);
    };
    tryParse(10);
    return true;
  }
});
