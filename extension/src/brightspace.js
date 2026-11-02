// Runs on Brightspace pages. The background asks it to read the course data, because a
// request made from the page itself carries your signed-in session.
import { collectBrightspace } from '../../shared/collect.js';

browser.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'collect') {
    collectBrightspace(msg.cfg).then(reply, (e) => reply({ ok: false, errors: [String(e && e.message || e)], courses: [] }));
    return true;
  }
  if (msg?.type === 'topicUrl') {
    fetch(`/d2l/api/le/1.100/${msg.ou}/content/topics/${msg.topicId}`, { credentials: 'include' })
      .then((r) => r.json()).then((j) => reply({ url: j.Url }), () => reply({}));
    return true;
  }
  if (msg?.type === 'ping') { reply({ ok: true }); return false; }
});
