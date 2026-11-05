// WhatsApp simulator for the admin dashboard (mock mode only).
(function () {
  const csrf = document.querySelector('meta[name="csrf"]').content;
  const $ = (id) => document.getElementById(id);
  const box = $('sim-msgs');
  let lastRendered = '';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  // WhatsApp-style formatting: *bold* _italic_ ~strike~
  const fmt = (s) =>
    esc(s)
      .replace(/\*([^*\n]+)\*/g, '<b>$1</b>')
      .replace(/(^|\s)_([^_\n]+)_/g, '$1<i>$2</i>')
      .replace(/~([^~\n]+)~/g, '<s>$1</s>')
      .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');

  async function api(path, body) {
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } : {},
      body: body ? JSON.stringify({ ...body, _csrf: csrf }) : undefined,
    });
    return res.json();
  }

  const phone = () => $('sim-phone').value.replace(/\D/g, '');

  async function send(text, replyId) {
    await api('/admin/simulator/send', { phone: phone(), name: $('sim-name').value, text, replyId });
    await refresh();
  }

  function render(messages) {
    const html = messages
      .map((m) => {
        if (m.dir === 'in') return `<div class="bubble out">${esc(m.text)}</div>`;
        const msg = m.msg;
        let inner = '';
        if (msg.kind === 'text') inner = fmt(msg.text);
        else if (msg.kind === 'template') inner = `<i class="small">[template: ${esc(msg.name)}]</i><br>${fmt(msg.fallbackText)}`;
        else {
          inner = (msg.header ? `<b>${esc(msg.header)}</b><br>` : '') + fmt(msg.body) + (msg.footer ? `<br><span class="small muted">${esc(msg.footer)}</span>` : '');
          if (msg.kind === 'buttons') {
            inner += '<div class="opts">' + msg.buttons.map((b) => `<button data-id="${esc(b.id)}" data-title="${esc(b.title)}">${esc(b.title)}</button>`).join('') + '</div>';
          } else if (msg.kind === 'list') {
            inner +=
              `<div class="opts"><button class="toggle">☰ ${esc(msg.button)}</button><div class="rows" hidden>` +
              msg.sections
                .map((s) => (s.title ? `<div class="sec">${esc(s.title)}</div>` : '') + s.rows.map((r) => `<button data-id="${esc(r.id)}" data-title="${esc(r.title)}">${esc(r.title)}${r.description ? `<span class="row-desc">${esc(r.description)}</span>` : ''}</button>`).join(''))
                .join('') +
              '</div></div>';
          } else if (msg.kind === 'cta') {
            inner += `<div class="opts"><a href="${esc(msg.url)}" target="_blank" rel="noopener">🔗 ${esc(msg.displayText)}</a></div>`;
          }
        }
        return `<div class="bubble in">${inner}</div>`;
      })
      .join('');
    if (html === lastRendered) return;
    lastRendered = html;
    box.innerHTML = html || '<p class="muted small" style="text-align:center">Say “hi” to start.</p>';
    box.scrollTop = box.scrollHeight;
  }

  async function refresh() {
    if (!phone()) return;
    const data = await api(`/admin/simulator/messages?phone=${phone()}`);
    render(data.messages || []);
  }

  box.addEventListener('click', (e) => {
    const toggle = e.target.closest('.toggle');
    if (toggle) {
      const rows = toggle.nextElementSibling;
      rows.hidden = !rows.hidden;
      return;
    }
    const btn = e.target.closest('button[data-id]');
    if (btn) send(btn.dataset.title, btn.dataset.id);
  });

  $('sim-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const t = $('sim-text').value.trim();
    if (!t) return;
    $('sim-text').value = '';
    send(t, '');
  });

  $('sim-reset').addEventListener('click', async () => {
    await api('/admin/simulator/reset', { phone: phone() });
    lastRendered = '';
    await refresh();
  });

  $('sim-phone').addEventListener('change', () => {
    lastRendered = '';
    refresh();
  });

  refresh();
  setInterval(refresh, 2000);
})();
