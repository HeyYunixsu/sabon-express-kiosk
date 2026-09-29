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
  let seenFirstState = false;   // the first state after load sets the baseline, silently
  let netDown = false;
  let focusNote = '';
  let dialogAction = null;
  let audio = null;
  let tab = 'counter';
  let tools = null;
  let toolsTimer = null;
  let toastTimer = null;
  const lastHtml = {};

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
    $('s-tabs').hidden = v !== 'main';
    $('s-me').hidden = v !== 'main';
    $('s-out').hidden = v !== 'main';
    if (v === 'main') showTab(tab);
    else { $('v-main').hidden = true; $('v-tools').hidden = true; }
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
    if (r.code === 200) {
      // Back in touch: take down the Wi-Fi warning, and only that.
      if (netDown) { netDown = false; $('w-msg').textContent = ''; }
      state = r.body; stateAt = Date.now(); render();
    } else if (r.code === 0) {
      netDown = true;
      $('w-msg').className = 's-msg';
      $('w-msg').textContent = 'Cannot reach the kiosk. Check the Wi-Fi.';
    }
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
    if (o && seenFirstState && o.number !== lastPending) chime();
    seenFirstState = true;
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

  // ---- tools --------------------------------------------------------------------
  const nameOf = (slot) => (tools && tools.products[slot - 1] ? tools.products[slot - 1].name : `Slot ${slot}`);
  const hhmm = (d) => String(d || '').slice(11, 16);
  const when = (d) => String(d || '').slice(5, 16);
  const validPrice = (v) => /^\d+$/.test(String(v)) && Number(v) >= 1 && Number(v) <= 10000;

  const BUSY_MSG = {
    order_waiting: 'An order is waiting for payment. Prices, air clears and give-backs wait until it is paid or cancelled.',
    machine_busy: 'The machine is dispensing. Prices, air clears and give-backs wait until it is free.',
    offline: 'The kiosk is offline. Prices, air clears and give-backs wait until it is back.',
  };
  const TOOL_MSG = {
    ...BUSY_MSG,
    timeout: 'The machine did not answer — try again.',
    sale_in_progress: 'The machine still has presses to pour — try again when it is free.',
    slot_busy: 'That nozzle is running — wait for it to stop.',
    slot_empty: 'That tank reads empty — refill it first.',
    paused: 'The machine is paused.',
    max_active: 'Two pumps are already running — wait a moment.',
    not_open: 'That credit was already settled.',
    bad_price: 'Enter a whole number of pesos.',
    network: 'Cannot reach the kiosk. Check the Wi-Fi.',
  };

  // Set a list's HTML only when it changed: rebuilding buttons every poll
  // swallows a tap that lands mid-rebuild.
  function put(id, html) {
    if (lastHtml[id] === html) return;
    lastHtml[id] = html;
    $(id).innerHTML = html;
  }

  function toast(ok, text) {
    const t = $('x-msg');
    t.className = ok ? 's-toast is-ok' : 's-toast';
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 6000);
  }
  const failed = (r) => TOOL_MSG[r.body.error || r.body.result] || 'That did not work — try again.';

  function showTab(t) {
    tab = t;
    for (const b of document.querySelectorAll('#s-tabs button')) b.classList.toggle('on', b.dataset.tab === t);
    $('v-main').hidden = t !== 'counter';
    $('v-tools').hidden = t !== 'tools';
    clearTimeout(toolsTimer);
    if (t === 'tools') loadTools();
  }
  $('s-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) showTab(b.dataset.tab);
  });

  // Every 3 s while Tools is open. A 401 is left to the state poll, which
  // signs the page out.
  async function loadTools() {
    clearTimeout(toolsTimer);
    if (tab !== 'tools' || !me) return;
    const r = await api('/staff/api/tools');
    if (r.code === 401) return;
    if (r.code === 200) { tools = r.body; renderTools(); }
    toolsTimer = setTimeout(loadTools, 3000);
  }

  function renderTools() {
    const t = tools;
    const busyMsg = t.busy ? BUSY_MSG[t.busy] || '' : '';
    $('x-busy').hidden = !busyMsg;
    $('x-busy').textContent = busyMsg;

    // Prices: rows built once, so a poll never overwrites what is being typed.
    const list = $('x-prices');
    if (!list.children.length) {
      list.innerHTML = t.products.map((p) => `<li data-slot="${p.slot}">
        <img src="${esc(p.img)}" alt=""><b>${esc(p.name)}</b>
        <label class="s-peso">₱<input type="number" inputmode="numeric" min="1" max="10000" step="1" aria-label="${esc(p.name)} price"></label>
        <button class="s-btn s-primary s-small" type="button" disabled>Save</button>
      </li>`).join('');
    }
    for (const li of list.children) {
      const slot = Number(li.dataset.slot);
      const input = li.querySelector('input');
      const now = t.prices[slot];
      if (document.activeElement !== input && !input.dataset.dirty) input.value = Number.isInteger(now) ? now : '';
      li.querySelector('button').disabled = !!t.busy || !validPrice(input.value) || Number(input.value) === now;
    }
    put('x-price-log', t.priceHistory.map((h) => `<li>
      <span>${esc(nameOf(h.slot))}</span><span>${peso(h.from)} → ${peso(h.to)}</span><span>${esc(when(h.date_created))}</span>
    </li>`).join(''));

    $('x-prime-sec').textContent = `${t.primeSeconds} s each`;
    put('x-primes', t.products.map((p) => `<button class="s-tile" type="button" data-slot="${p.slot}"${t.busy ? ' disabled' : ''}>
      <b>Nozzle ${p.slot}</b><span>${esc(p.name)}</span><small>${t.primesToday[p.slot] || 0} today</small>
    </button>`).join(''));

    $('x-credit-sum').textContent = t.credits.length
      ? `${t.credits.length} · ${peso(t.credits.reduce((a, c) => a + c.amount, 0))}` : '';
    put('x-credits', t.credits.map((c) => `<li data-id="${esc(c.id)}">
      <div><b>${esc(nameOf(c.slot))} × ${c.qty}</b>
        <small>${peso(c.amount)} · ${c.reason === 'cancelled' ? 'cancelled' : 'not collected'} · ${esc(when(c.date_created))}</small></div>
      <div class="s-acts">
        <button class="s-btn s-primary s-small" data-act="give" type="button"${t.busy ? ' disabled' : ''}>Give back</button>
        <button class="s-btn s-ghost s-small" data-act="off" type="button">Write off</button>
      </div>
    </li>`).join('') || '<li class="s-none">No waiting credits.</li>');

    put('x-attention', t.attention.map((a) => `<li>
      <span>${esc(nameOf(a.slot))} · ${peso(a.amount)}</span>
      <span>${a.reason === 'tank_empty' ? 'Tank ran out mid-pour' : a.reason === 'pause_timeout' ? 'Paused too long' : esc(a.reason)} · ${esc(hhmm(a.date_created))}</span>
    </li>`).join('') || '<li class="s-none">Nothing today.</li>');

    const s = t.sales;
    $('x-sales-sum').textContent = `${s.presses} presses · ${peso(s.amount)}`;
    put('x-sales', t.products.filter((p) => s.bySlot[p.slot]).map((p) => `<li>
      <span>${esc(p.name)} · ${s.bySlot[p.slot].presses} presses</span><span>${peso(s.bySlot[p.slot].amount)}</span>
    </li>`).join('') || '<li class="s-none">No sales yet today.</li>');
    put('x-cash', Object.entries(t.cashByStaff).map(([n, c]) => `<li>
      <span>Cash · ${esc(n)} · ${c.count} ${c.count === 1 ? 'order' : 'orders'}</span><span>${peso(c.amount)}</span>
    </li>`).join(''));

    const m = t.machine;
    put('x-machine', `<dt>Machine ID</dt><dd>${esc(m.machineId || '—')}</dd>
      <dt>Controller</dt><dd class="${m.online ? 'ok' : 'bad'}">${m.online ? 'Online' : 'Offline'}</dd>
      <dt>Staff page</dt><dd>${esc(m.staffBase ? `${m.staffBase}/staff` : 'No network address')}</dd>
      ${t.products.map((p) => {
        const st = m.stock.find((x) => x.slot === p.slot);
        return `<dt>${esc(p.name)}</dt><dd class="${!st ? '' : st.empty ? 'bad' : 'ok'}">${!st ? '—' : st.empty ? 'Empty' : 'Has stock'}</dd>`;
      }).join('')}`);
  }

  $('x-prices').addEventListener('input', (e) => {
    if (e.target.tagName !== 'INPUT') return;
    e.target.dataset.dirty = '1';
    renderTools();
  });
  $('x-prices').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    const li = b.closest('li');
    const slot = Number(li.dataset.slot);
    const input = li.querySelector('input');
    const price = Number(input.value);
    const from = tools.prices[slot];
    ask(`Change ${nameOf(slot)} to ${peso(price)}?`, `It is ${peso(from)} now. New orders use the new price.`, 'Yes, change it', async () => {
      const r = await api('/staff/api/price', { slot, price });
      delete input.dataset.dirty;
      if (r.code !== 200) toast(false, failed(r));
      else if (r.body.result === 'not_saved') toast(false, `${nameOf(slot)} is ${peso(price)} now, but it could not be saved — it goes back after a restart.`);
      else toast(true, `${nameOf(slot)} is now ${peso(price)}.`);
      loadTools();
    });
  });

  $('x-primes').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-slot]');
    if (!b || b.disabled) return;
    const slot = Number(b.dataset.slot);
    ask(`Put a cup under nozzle ${slot}`, `${nameOf(slot)}. Run it for ${tools.primeSeconds} seconds?`, 'Yes, run it', async () => {
      const r = await api('/staff/api/prime', { slot, confirm: true });
      toast(r.code === 200, r.code === 200 ? `Nozzle ${slot} is clearing air for ${tools.primeSeconds} seconds.` : failed(r));
      loadTools();
    });
  });

  $('x-credits').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b || b.disabled) return;
    const c = tools.credits.find((x) => x.id === b.closest('li').dataset.id);
    if (!c) return;
    const what = `${nameOf(c.slot)} × ${c.qty}`;
    if (b.dataset.act === 'give') {
      ask(`Give back ${what}?`, 'The kiosk opens the dispense screen for these presses. The customer pours them there.', 'Yes, give back', async () => {
        const r = await api('/staff/api/credits/give-back', { id: c.id });
        toast(r.code === 200, r.code === 200 ? `${what} is ready on the kiosk.` : failed(r));
        loadTools();
      });
    } else {
      ask(`Write off ${what}?`, `The ${peso(c.amount)} stays paid and the presses are not given. This cannot be undone.`, 'Yes, write off', async () => {
        const r = await api('/staff/api/credits/write-off', { id: c.id });
        toast(r.code === 200, r.code === 200 ? `${what} written off.` : failed(r));
        loadTools();
      });
    }
  });

  // ---- boot ---------------------------------------------------------------------
  (async () => {
    const r = await api('/staff/api/me');
    if (r.code === 200) { me = r.body.name; start(); }
    else { showView('login'); renderLogin(''); }
  })();
})();
