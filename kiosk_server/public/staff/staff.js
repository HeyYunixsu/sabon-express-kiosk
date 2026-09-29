'use strict';
// Staff tablet page: sign in once per shift, see the kiosk's waiting order,
// mark it paid or cancel it. Polls the server once a second -- on the shop
// Wi-Fi that is live enough and needs nothing more than plain fetch.

(() => {
  const $ = (id) => document.getElementById(id);
  const peso = (n) => '₱' + n;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // A scanned QR opens /staff/order/A-27: that order gets looked up and,
  // if it is not the one waiting, what happened to it is shown.
  const m = location.pathname.match(/^\/staff\/order\/([A-Z]-\d+)$/);
  let focus = m ? m[1] : null;

  let me = null;
  let pin = '';
  let state = null;
  let stateAt = 0;
  let polling = false;
  let busy = false;
  let lastPending = null;
  let focusNote = '';
  let dialogAction = null;
  let audio = null;

  async function api(path, body) {
    const opt = body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    };
    try {
      const r = await fetch(path, { credentials: 'same-origin', ...opt });
      return { code: r.status, body: await r.json().catch(() => ({})) };
    } catch (_) {
      return { code: 0, body: { error: 'network' } };
    }
  }

  function showView(v) {
    $('v-login').hidden = v !== 'login';
    $('v-main').hidden = v !== 'main';
    $('s-me').hidden = v !== 'main';
    $('s-out').hidden = v !== 'main';
  }

  // A short two-note chime for a new order. Browsers only allow sound after a
  // tap, and signing in is that tap.
  function chime() {
    if (!audio) return;
    const t = audio.currentTime;
    for (const [f, at] of [[880, 0], [1320, 0.16]]) {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + at);
      g.gain.exponentialRampToValueAtTime(0.3, t + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.25);
      o.connect(g).connect(audio.destination);
      o.start(t + at);
      o.stop(t + at + 0.3);
    }
  }

  // ---- sign in ----------------------------------------------------------------
  function renderLogin(msg) {
    $('l-dots').innerHTML = Array.from({ length: Math.max(4, pin.length) }, (_, i) =>
      `<i class="${i < pin.length ? 'on' : ''}"></i>`).join('');
    $('l-go').disabled = pin.length < 4 || busy;
    if (msg !== undefined) $('l-msg').textContent = msg;
  }

  $('l-keypad').addEventListener('click', (e) => {
    const k = e.target.closest('button[data-k]');
    if (!k || busy) return;
    const key = k.dataset.k;
    if (key === 'clear') pin = '';
    else if (key === 'back') pin = pin.slice(0, -1);
    else if (pin.length < 8) pin += key;
    renderLogin('');
  });

  $('l-go').addEventListener('click', async () => {
    if (busy || pin.length < 4) return;
    try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { audio = null; }
    busy = true;
    renderLogin();
    const r = await api('/staff/api/login', { pin });
    busy = false;
    pin = '';
    if (r.code === 200) { me = r.body.name; start(); return; }
    const e = r.body.error;
    renderLogin(e === 'locked' ? `Too many wrong PINs. Try again in ${Math.ceil((r.body.retryInMs || 60000) / 1000)} s.`
      : e === 'no_staff' ? 'No staff PINs are set up on this kiosk.'
      : e === 'network' ? 'Cannot reach the kiosk. Check the Wi-Fi.'
      : 'Wrong PIN. Please try again.');
  });

  $('s-out').addEventListener('click', async () => {
    await api('/staff/api/logout', {});
    me = null;
    showView('login');
    renderLogin('');
  });

  // ---- main -------------------------------------------------------------------
  function start() {
    $('s-me').textContent = `Signed in as ${me}`;
    showView('main');
    if (focus) lookup(focus);
    if (!polling) { polling = true; poll(); }
  }

  async function poll() {
    const r = await api('/staff/api/state');
    if (r.code === 401) { polling = false; me = null; showView('login'); renderLogin(''); return; }
    if (r.code === 200) { state = r.body; stateAt = Date.now(); render(); }
    else if (r.code === 0) { $('w-msg').className = 's-msg'; $('w-msg').textContent = 'Cannot reach the kiosk. Check the Wi-Fi.'; }
    setTimeout(poll, 1000);
  }

  async function lookup(number) {
    const r = await api(`/staff/api/order?number=${encodeURIComponent(number)}`);
    if (r.code !== 200) { focusNote = `Order ${number} is not known on this kiosk (it may be from another day).`; return; }
    const o = r.body.order;
    if (o.status === 'waiting') { focusNote = ''; return; }
    const when = (o.closed || '').slice(11, 16);
    focusNote = o.status === 'paid' ? `Order ${o.number} was already paid (${o.by}, ${when}).`
      : o.status === 'expired' ? `Order ${o.number} expired — do not take payment. Ask the customer to order again.`
      : `Order ${o.number} was cancelled (${o.reason}${o.by ? `, ${o.by}` : ''}) — do not take payment.`;
  }

  function render() {
    if (!state) return;
    const st = $('s-state');
    st.className = `s-state is-${state.machine}`;
    st.querySelector('b').textContent = { ready: 'Kiosk ready', dispensing: 'Dispensing', offline: 'Kiosk offline' }[state.machine];

    const o = state.pending;
    if (o && o.number !== lastPending) chime();
    lastPending = o ? o.number : null;

    const card = $('w-card');
    card.classList.toggle('is-live', !!o);
    card.classList.toggle('is-focus', !!focus && (!o || o.number !== focus) && !!focusNote);
    $('w-body').hidden = !o;
    $('w-empty').hidden = !!o;
    $('w-num').textContent = o ? `Order ${o.number}` : '';
    if (o) {
      $('w-items').innerHTML = o.items.map((i) => `<li>
        <img src="${esc(i.img)}" alt=""><b>${esc(i.name)}</b><span class="q">× ${i.qty}</span><span class="p">${peso(i.price * i.qty)}</span>
      </li>`).join('');
      $('w-total').textContent = peso(o.amount);
      const left = Math.max(0, o.remainingMs - (Date.now() - stateAt));
      const s = Math.ceil(left / 1000);
      const t = $('w-timer');
      t.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} left to pay`;
      t.classList.toggle('is-low', left < 30000);
      $('w-paid').textContent = `Mark as paid · ${peso(o.amount)}`;
      $('w-paid').disabled = busy || state.machine === 'offline';
      $('w-cancel').disabled = busy;
    }
    if (focusNote && (!o || o.number !== focus)) {
      $('w-msg').className = 's-msg';
      $('w-msg').textContent = focusNote;
    }

    const today = state.today;
    $('t-sum').textContent = `${today.paid} paid · ${peso(today.total)}`;
    $('t-list').innerHTML = today.orders.map((x) => `<li>
      <span>${esc(x.number)}</span><span>${peso(x.amount)}</span>
      <span class="st-${x.status}">${x.status === 'paid' ? `Paid · ${esc(x.by)}` : x.status === 'expired' ? 'Expired'
        : `Cancelled · ${esc(x.reason)}${x.by ? ` · ${esc(x.by)}` : ''}`} · ${esc((x.closed || '').slice(11, 16))}</span>
    </li>`).join('') || '<li><span></span><span></span><span>No orders yet today.</span></li>';
  }

  // ---- confirm dialog ---------------------------------------------------------
  function ask(title, text, yesLabel, action) {
    $('dlg-title').textContent = title;
    $('dlg-text').textContent = text;
    $('dlg-yes').textContent = yesLabel;
    dialogAction = action;
    $('dlg').hidden = false;
  }
  $('dlg-no').addEventListener('click', () => { $('dlg').hidden = true; dialogAction = null; });
  $('dlg-yes').addEventListener('click', async () => {
    $('dlg').hidden = true;
    const act = dialogAction;
    dialogAction = null;
    if (act) await act();
  });

  const PAID_MSG = {
    not_waiting: 'This order is no longer waiting — do not take payment.',
    offline: 'Machine not ready — don\'t take the cash yet.',
    out_of_stock: 'A product ran out — the order was cancelled. Do not take payment.',
    price_changed: 'Prices changed — the order was cancelled. Ask the customer to order again.',
    machine_busy: 'The machine is still busy — wait a moment and try again.',
    network: 'Cannot reach the kiosk. Check the Wi-Fi.',
  };

  $('w-paid').addEventListener('click', () => {
    const o = state && state.pending;
    if (!o) return;
    ask(`Did you receive ${peso(o.amount)} cash?`, `Order ${o.number}`, 'Yes, received', async () => {
      busy = true; render();
      const r = await api('/staff/api/orders/paid', { number: o.number });
      busy = false;
      const msg = $('w-msg');
      if (r.code === 200) { msg.className = 's-msg is-ok'; msg.textContent = `${o.number} paid. The kiosk is unlocked.`; }
      else { msg.className = 's-msg'; msg.textContent = PAID_MSG[r.body.error] || 'That did not work — try again.'; }
      focus = null; focusNote = '';
      render();
    });
  });

  $('w-cancel').addEventListener('click', () => {
    const o = state && state.pending;
    if (!o) return;
    ask(`Cancel order ${o.number}?`, 'The kiosk goes back to the start screen.', 'Yes, cancel', async () => {
      busy = true; render();
      const r = await api('/staff/api/orders/cancel', { number: o.number });
      busy = false;
      const msg = $('w-msg');
      msg.className = r.code === 200 ? 's-msg is-ok' : 's-msg';
      msg.textContent = r.code === 200 ? `${o.number} cancelled.` : (PAID_MSG[r.body.error] || 'That did not work — try again.');
      render();
    });
  });

  // ---- boot ---------------------------------------------------------------------
  (async () => {
    const r = await api('/staff/api/me');
    if (r.code === 200) { me = r.body.name; start(); }
    else { showView('login'); renderLogin(''); }
  })();
})();
