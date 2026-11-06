// Runs on Brightspace pages. The background asks it to read the course data, because a
// request made from the page itself carries your signed-in session.
//
// The snapshot is several hundred KB; Safari can stall on one message that size, so it
// is handed back in chunks: `collect` answers with how many, `chunk` returns each one.
import { collectBrightspace } from '../../shared/collect.js';

const CHUNK = 150000;
let held = null;

// The background may add this script again if a page is slow to answer; one listener only.
if (!globalThis.__loadBrightspace) {
  globalThis.__loadBrightspace = true;
  browser.runtime.onMessage.addListener(listen);
}

function listen(msg, sender, reply) {
  if (msg?.type === 'collect') {
    collectBrightspace(msg.cfg)
      .catch((e) => ({ ok: false, errors: [String((e && e.message) || e)], courses: [] }))
      .then((snap) => {
        held = JSON.stringify(snap);
        reply({ chunks: Math.ceil(held.length / CHUNK), size: held.length, ok: snap.ok, errors: snap.errors });
      });
    return true;
  }
  if (msg?.type === 'chunk') {
    reply({ i: msg.i, data: held ? held.slice(msg.i * CHUNK, (msg.i + 1) * CHUNK) : null });
    return false;
  }
  if (msg?.type === 'topicUrl') {
    fetch(`/d2l/api/le/1.100/${msg.ou}/content/topics/${msg.topicId}`, { credentials: 'include' })
      .then((r) => r.json()).then((j) => reply({ url: j.Url }), () => reply({}));
    return true;
  }
  if (msg?.type === 'ping') { reply({ ok: true }); return false; }
}
