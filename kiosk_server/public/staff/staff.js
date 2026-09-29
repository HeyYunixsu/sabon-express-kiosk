'use strict';
// Staff dashboard: sign in once per shift, see the kiosk's waiting order,
// mark it paid or cancel it, and the day's numbers and tools. Polls the
// server once a second -- on the shop Wi-Fi that is live enough and needs
// nothing more than plain fetch.

(() => {
  const $ = (id) => document.getElementById(id);
  const peso = (n) => '₱' + n;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const icon = (name) => `<svg class="i"><use href="#i-${name}"/></svg>`;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const VIEWS = ['overview', 'transactions', 'health', 'inventory', 'settings'];

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
  let view = 'overview';
  try { const v = sessionStorage.getItem('staff-view'); if (VIEWS.includes(v)) view = v; } catch (_) { /* no storage */ }
  // A scanned order link always opens on Overview, where the waiting-order
  // card and its note live -- never wherever the last shift left the page.
  if (focus) view = 'overview';
  const range = { overview: 'today', transactions: 'today' };
  let week = null;              // the 7-day orders, from /staff/api/orders
  let weekTotals = null;        // { orders, paid, cash } over the whole window, not just week
  let weekTimer = null;
  let weekGen = 0;
  let tools = null;
  let toolsTimer = null;
  let toolsGen = 0;
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

  // Signed out: the sign-in card. Signed in: the dashboard.
  function showScreen(v) {
    $('v-login').hidden = v !== 'login';
    $('app').hidden = v !== 'main';
    if (v === 'main') showView(view);
    else { clearTimeout(toolsTimer); clearTimeout(weekTimer); }
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

  // Browsers only allow sound after a tap. A reload lands back on the
  // dashboard already signed in (the session cookie), so the chime for the
  // next new order needs its tap from anywhere on the page, not only Sign in.
  document.addEventListener('pointerdown', () => {
    try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { /* no audio */ }
  }, { once: true });

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
    showScreen('login');
    renderLogin('');
  });

  // ---- sections -----------------------------------------------------------------
  // Overview reads /staff/api/state only; the other sections also poll the
  // tools every 3 s while open.
  function showView(name) {
    view = VIEWS.includes(name) ? name : 'overview';
    for (const v of VIEWS) $(`v-${v}`).hidden = v !== view;
    for (const b of document.querySelectorAll('#s-nav button')) b.classList.toggle('on', b.dataset.view === view);
    try { sessionStorage.setItem('staff-view', view); } catch (_) { /* no storage */ }
    clearTimeout(toolsTimer);
    loadTools();
    loadWeek();
    renderBusy();
    renderOrders();
  }
  $('s-nav').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (b) showView(b.dataset.view);
  });
  // Quick actions, the table's link and the banner: go to a section, and
  // to a card in it.
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-go]');
    if (!b) return;
    showView(b.dataset.go);
    const to = b.dataset.scroll && $(b.dataset.scroll);
    if (to) to.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else window.scrollTo(0, 0);
  });

  // ---- main -------------------------------------------------------------------
  function start() {
    $('s-me').innerHTML = `${icon('user')}Staff: ${esc(me)}`;
    showScreen('main');
    if (focus) lookup(focus);
    if (!polling) { polling = true; poll(); }
  }

  async function poll() {
    const r = await api('/staff/api/state');
    if (r.code === 401) { polling = false; me = null; showScreen('login'); renderLogin(''); return; }
    if (r.code === 200) {
      // Back in touch: take down the Wi-Fi warning, and only that.
      if (netDown) { netDown = false; $('w-msg').textContent = ''; }
      state = r.body; stateAt = Date.now(); render();
    } else if (r.code === 0) {
      netDown = true;
      $('w-msg').className = 's-msg';
      $('w-msg').textContent = 'Cannot reach the kiosk. Check the Wi-Fi.';
      // "System Online" must not stay green during a drop; the next good
      // poll calls render(), which puts both back from state.
      $('s-sys').classList.add('is-off');
      $('s-sys-word').textContent = 'No connection';
      const st = $('s-state');
      st.className = 'd-chip is-offline';
      st.querySelector('b').textContent = 'No connection';
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

  const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const dateOf = (d) => `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;

  function render() {
    if (!state) return;
    $('s-demo').hidden = !state.qrDemo;
    const st = $('s-state');
    st.className = `d-chip is-${state.machine}`;
    st.querySelector('b').textContent = { ready: 'Online', dispensing: 'Dispensing', offline: 'Offline' }[state.machine];
    $('k-name').textContent = state.kiosk.name;
    $('k-loc').hidden = !state.kiosk.location;
    $('k-loc').querySelector('span').textContent = state.kiosk.location;
    $('s-sys').classList.toggle('is-off', !state.online);
    $('s-sys-word').textContent = state.online ? 'System Online' : 'System Offline';

    renderHero();
    renderKpis();
    renderStatus();
    renderOrders();
    renderBanner();
    renderNavDot();
    $('q-credits').hidden = !state.waitingCredits;
    $('q-credits').textContent = state.waitingCredits;
  }

  function renderHero() {
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
    // A QR (demo) order is paid on the customer's phone, never as cash here.
    const qr = !!o && o.method === 'qr';
    $('w-title').textContent = qr ? 'Waiting for QR payment (demo)' : 'Waiting for payment';
    $('w-paid').hidden = qr;
    if (o) {
      // A red/amber tone from the idle side (offline, empty tank) must not
      // stay on the hero once a real order is waiting to be paid.
      delete card.dataset.tone;
      put('w-items', o.items.map((i) => `<li>
        <img src="${esc(i.img)}" alt=""><b>${esc(i.name)}</b><span class="q">× ${i.qty}</span><span class="p">${peso(i.price * i.qty)}</span>
      </li>`).join(''));
      $('w-total').textContent = peso(o.amount);
      const left = Math.max(0, o.remainingMs - (Date.now() - stateAt));
      const s = Math.ceil(left / 1000);
      const t = $('w-timer');
      t.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} left to pay`;
      t.classList.toggle('is-low', left < 30000);
      $('w-bar').style.width = `${o.totalMs ? Math.min(100, (left / o.totalMs) * 100) : 0}%`;
      $('w-bar').classList.toggle('is-low', left < 30000);
      $('w-paid').textContent = `Mark as paid · ${peso(o.amount)}`;
      $('w-paid').disabled = busy || state.machine === 'offline';
      $('w-cancel').disabled = busy;
    } else {
      const s = state.status;
      const [tone, title, text] = !state.online
        ? ['bad', 'Kiosk is Offline', 'The kiosk is not answering. Check that it is switched on.']
        : s.empty.length ? ['warn', 'A tank is empty', `${s.empty.join(', ')} — refill, then run an air clear.`]
        : state.machine === 'dispensing' ? ['ok', 'Dispensing…', 'A customer is pouring.']
        : ['ok', 'Kiosk is Running Smoothly', 'All systems are normal. Ready for orders.'];
      card.dataset.tone = tone;
      $('h-title').textContent = title;
      $('h-text').textContent = text;
      const d = new Date(stateAt);
      $('h-updated').textContent = `Last updated: ${dateOf(d)} ${hm(d)}:${String(d.getSeconds()).padStart(2, '0')}`;
    }
    if (focusNote && (!o || o.number !== focus)) {
      $('w-msg').className = 's-msg';
      $('w-msg').textContent = focusNote;
    }
  }

  // ---- stat cards ---------------------------------------------------------------
  // invert: for a number where more is bad (cancelled), so a rise still gets
  // the red "down" class and a fall the green "up" one.
  function delta(now, before, invert) {
    const cls = (up) => (invert ? !up : up) ? 'up' : 'down';
    if (before === 0) return now > 0 ? `<span class="${cls(true)}">new today</span>` : '<span class="flat">— same as yesterday</span>';
    if (now === before) return '<span class="flat">— same as yesterday</span>';
    const up = now > before;
    const pct = Math.round((Math.abs(now - before) / before) * 100);
    return `<span class="${cls(up)}">${up ? '↑' : '↓'} ${pct}%</span> <span class="nw">vs. yesterday</span>`;
  }

  // Running total of the hourly values up to this hour, as a line and a
  // faint area under it. The Pi's clock decides "this hour", not whatever
  // device is looking at the dashboard.
  function spark(hourly) {
    const upTo = state.hour;
    let sum = 0;
    const pts = (hourly || []).slice(0, upTo + 1).map((v) => (sum += v));
    const max = Math.max(1, ...pts);
    const n = Math.max(1, pts.length - 1);
    const xy = (pts.length ? pts : [0, 0]).map((v, i) => `${((i / n) * 200).toFixed(1)},${(44 - (v / max) * 38).toFixed(1)}`);
    if (xy.length === 1) xy.push(`200,${xy[0].split(',')[1]}`);
    const line = xy.join(' ');
    return `<polygon points="0,48 ${line} 200,48"/><polyline points="${line}"/>`;
  }

  function kpi(id, value, deltaHtml, sub, hourly) {
    const c = $(id);
    c.querySelector('.k-val').textContent = value;
    c.querySelector('.k-delta').innerHTML = deltaHtml;
    c.querySelector('.k-delta').hidden = !deltaHtml;
    c.querySelector('.k-sub').textContent = sub;
    c.querySelector('.k-sub').hidden = !sub;
    const svg = spark(hourly);
    if (lastHtml[id] !== svg) { lastHtml[id] = svg; c.querySelector('.k-spark').innerHTML = svg; }
  }

  function renderKpis() {
    const { today: t, yesterday: y } = state.stats;
    const o = state.pending;
    // The sales figure above is cash only (dayStats' isCash filter); the sub-line
    // must count the same cash orders, not t.paid (every method, including qr).
    const cashPaid = state.today.paid;
    kpi('k-sales', peso(t.sales), delta(t.sales, y.sales), `${cashPaid} ${cashPaid === 1 ? 'order' : 'orders'}`, t.hourly.sales);
    kpi('k-paid', t.paid, delta(t.paid, y.paid), '', t.hourly.paid);
    kpi('k-pending', o ? 1 : 0, '', o ? `Order ${o.number}` : 'No pending', null);
    kpi('k-cancel', t.cancelled, delta(t.cancelled, y.cancelled, true), '', t.hourly.cancelled);
  }

  // ---- kiosk status -------------------------------------------------------------
  // Each sub-line is HTML, every part from the server escaped.
  function statusRows() {
    const s = state.status;
    const synced = s.lastSynced ? `Last confirmed ${esc(String(s.lastSynced).slice(11, 16))}` : 'None this month';
    const queued = s.uploadQueue ? `${s.uploadQueue} ${s.uploadQueue === 1 ? 'sale' : 'sales'} waiting to upload` : 'All sales uploaded';
    return [
      ['conn', 'wifi', 'Device Connection', state.online ? 'Controller connected' : 'Controller not answering',
        state.online ? ['ok', 'Online'] : ['bad', 'Offline']],
      ['pay', 'card', 'Payment', s.cashReady ? `Cash ready${state.qrDemo ? ', QR demo on' : ''}` : 'No staff PINs set up',
        s.cashReady ? ['ok', 'OK'] : ['bad', 'Setup']],
      ['pump', 'drop', 'Pump Status', `${s.pumpsReady}/${s.pumps} pumps ready`,
        !state.online ? ['off', '—'] : s.paused ? ['warn', 'Paused'] : s.pumpsReady < s.pumps ? ['warn', 'Check'] : ['ok', 'OK']],
      ['water', 'waves', 'Water Level', s.empty.length ? `Empty: ${esc(s.empty.join(', '))}` : 'Normal level',
        !state.online ? ['off', '—'] : s.empty.length ? ['bad', 'Empty'] : ['ok', 'Normal']],
      ['sync', 'sync', 'Last Sync', `${queued}<br>${synced}`, s.uploadQueue ? ['warn', 'Waiting'] : ['ok', 'OK']],
    ];
  }

  function renderStatus() {
    const rows = statusRows();
    const html = (pre) => rows.map(([id, ic, title, sub, [tone, word]]) => `<li id="${pre}-${id}" class="is-${tone}">
      <span class="s-ico">${icon(ic)}</span>
      <div><b>${title}</b><small>${sub}</small></div>
      <span class="s-word"><i></i>${word}</span>
    </li>`).join('');
    put('st-list', html('st'));
    put('hx-status', html('hx'));
  }

  // ---- orders table -------------------------------------------------------------
  const BADGE = { paid: ['Paid', 'check'], cancelled: ['Cancelled', 'x'], expired: ['Expired', 'clock'] };
  // The reason in words, under the badge, visible without a hover.
  const REASON_WORDS = {
    customer: 'by customer', staff: 'by staff', out_of_stock: 'product ran out',
    price_changed: 'price changed', timeout: 'not paid in time',
  };
  function orderRows(rows, withDate) {
    return rows.map((x) => {
      const [label, ic] = BADGE[x.status] || [x.status, 'clock'];
      // A QR order cancelled by the customer still says "customer", not "QR demo".
      const who = x.reason === 'customer' ? 'customer' : x.by || (x.method === 'qr' ? 'QR demo' : '—');
      const c = String(x.closed || '');
      const time = withDate && c ? `${MONTHS[Number(c.slice(5, 7)) - 1]} ${Number(c.slice(8, 10))} · ${c.slice(11, 16)}` : c.slice(11, 16);
      const why = x.status === 'cancelled' && x.reason ? ` title="Cancelled: ${esc(x.reason)}"` : '';
      const reasonWord = REASON_WORDS[x.reason];
      const reasonLine = (x.status === 'cancelled' || x.status === 'expired') && reasonWord
        ? `<small class="d-reason">${esc(reasonWord)}</small>` : '';
      return `<tr class="is-${esc(x.status)}">
        <td>${esc(x.number)}</td><td>${peso(x.amount)}</td>
        <td><span class="d-badge b-${esc(x.status)}"${why}><i>${icon(ic)}</i>${esc(label)}</span>${reasonLine}</td>
        <td>${esc(who)}</td><td>${esc(time)}</td>
      </tr>`;
    }).join('') || `<tr class="is-none"><td colspan="5">${withDate ? 'No orders in the last 7 days.' : 'No orders yet today.'}</td></tr>`;
  }
  function renderOrders() {
    if (!state) return;
    for (const [which, list, sum, limit] of [['overview', 't-list', 't-sum', 5], ['transactions', 'o-list', 'o-sum', 200]]) {
      const wk = range[which] === '7d';
      for (const b of document.querySelectorAll(`.d-switch[data-for="${which}"] button`)) b.classList.toggle('on', b.dataset.range === range[which]);
      // Transactions' Today is every order today, from the same 7-day fetch
      // as the 7d switch -- state.today.orders is capped at 20 by the server.
      // state.day, not the browser's date, picks out "today" from that list.
      const fromWeek = wk || which === 'transactions';
      if (fromWeek && !week) { put(list, '<tr class="is-none"><td colspan="5">Loading…</td></tr>'); continue; }
      const rows = wk ? week
        : which === 'transactions' ? week.filter((o) => o.closed.startsWith(state.day))
        : state.today.orders;
      put(list, orderRows(rows.slice(0, limit), wk));
      $(sum).textContent = wk
        // From the server's totals, over the whole window -- the table (and
        // so `rows`) is capped at 200, which a busy week can pass.
        ? `${weekTotals.paid} paid · ${peso(weekTotals.cash)} · last 7 days`
        // Overview's footer agrees with the Paid Orders card, which counts
        // QR demo orders too; the cash total stays cash-only.
        : which === 'overview' ? `${state.stats.today.paid} paid · ${peso(state.today.total)} cash`
        : `${state.today.paid} paid · ${peso(state.today.total)}`;
    }
  }

  // The 7-day list, every 10 s while a table shows it. Transactions needs it
  // for Today too (the full day, not state's latest 20), so it fetches
  // whatever range is showing there; Overview only needs it for the 7d switch.
  async function loadWeek() {
    clearTimeout(weekTimer);
    const gen = ++weekGen;   // an older load still in flight is dropped
    if (!me || !['overview', 'transactions'].includes(view)) return;
    if (view === 'overview' && range.overview !== '7d') return;
    const r = await api('/staff/api/orders');
    if (gen !== weekGen) return;
    if (r.code === 200) { week = r.body.orders; weekTotals = r.body.totals; renderOrders(); }
    weekTimer = setTimeout(loadWeek, 10000);
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.d-switch button[data-range]');
    if (!b) return;
    range[b.closest('.d-switch').dataset.for] = b.dataset.range;
    renderOrders();
    loadWeek();
  });

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
    qr_order: 'This order is paid by QR on the customer\'s phone.',
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
    machine_busy: 'The machine has presses to pour. Prices and give-backs wait until it is free.',
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
    price_changed: 'The price changed since this was paid — write it off and settle it with the customer by hand.',
    no_prices: 'Prices are still loading — try again in a moment.',
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

  // Every 3 s while a tools section is open. Overview needs none of this --
  // its banner reads state.attention instead. A 401 is left to the state
  // poll, which signs the page out.
  async function loadTools() {
    clearTimeout(toolsTimer);
    const gen = ++toolsGen;   // an older load still in flight is dropped
    if (!me || view === 'overview') return;
    const r = await api('/staff/api/tools');
    if (r.code === 401 || gen !== toolsGen) return;
    if (r.code === 200) { tools = r.body; renderTools(); }
    if (view !== 'overview') toolsTimer = setTimeout(loadTools, 3000);
  }

  // The amber "refused for now" note, on Health and Inventory only.
  function renderBusy() {
    const msg = tools && tools.busy ? BUSY_MSG[tools.busy] || '' : '';
    $('x-busy').hidden = !msg || !['health', 'inventory'].includes(view);
    $('x-busy').textContent = msg;
  }

  // A waiting order pulses on the Overview nav item, so it is visible from
  // every section, not only when Overview itself is open.
  function renderNavDot() {
    $('s-nav-dot').hidden = !state.pending;
  }

  function renderBanner() {
    const n = (state && state.attention) || 0;
    const b = $('d-banner');
    b.classList.toggle('is-alert', n > 0);
    if (n) b.dataset.go = 'health'; else delete b.dataset.go;
    b.disabled = !n;
    b.querySelector('.q-chev').hidden = !n;
    $('b-title').textContent = n ? `${n} ${n === 1 ? 'pour needs' : 'pours need'} attention today` : 'Smarter Kiosk. Better Service.';
    $('b-sub').textContent = n ? 'Cut short and charged in full — settle it with the customer.' : 'Real-time monitoring for a seamless experience.';
  }

  function renderTools() {
    const t = tools;
    renderBusy();

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
    put('x-primes', t.products.map((p) => `<button class="s-tile" type="button" data-slot="${p.slot}"${t.primeBusy ? ' disabled' : ''}>
      <img src="${esc(p.img)}" alt=""><b>Nozzle ${p.slot}</b><span>${esc(p.name)}</span><small>${t.primesToday[p.slot] || 0} today</small>
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
    const stockOf = (slot) => m.stock.find((x) => x.slot === slot);
    put('x-stock', t.products.map((p) => {
      const st = stockOf(p.slot);
      const [cls, word] = !st ? ['off', 'Unknown'] : st.empty ? ['bad', 'Empty'] : ['ok', 'Has stock'];
      return `<div class="st-card is-${cls}"><img src="${esc(p.img)}" alt=""><b>${esc(p.name)}</b>
        <small>Tank ${p.slot}</small><span class="d-badge b-${cls}"><i>${icon(st && !st.empty ? 'check' : 'x')}</i>${word}</span></div>`;
    }).join(''));
    put('x-machine', `<dt>Machine ID</dt><dd>${esc(m.machineId || '—')}</dd>
      <dt>Controller</dt><dd class="${m.online ? 'ok' : 'bad'}">${m.online ? 'Online' : 'Offline'}</dd>
      <dt>Staff page</dt><dd>${esc(m.staffBase ? `${m.staffBase}/staff` : 'No network address')}</dd>
      <dt>QR demo</dt><dd class="${state.qrDemo ? 'warn' : ''}">${state.qrDemo ? 'On — QR payments are pretend' : 'Off'}</dd>
      ${t.products.map((p) => {
        const st = stockOf(p.slot);
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
      toast(r.code === 200, r.code === 200 ? `Nozzle ${slot} is clearing air for ${tools.primeSeconds} seconds.`
        : r.body.error === 'machine_busy' ? 'A nozzle is pouring — wait for it to stop.' : failed(r));
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

  // ---- clock ----------------------------------------------------------------------
  function tick() {
    const d = new Date();
    $('s-clock').textContent = `${dateOf(d)} · ${hm(d)}`;
  }
  tick();
  setInterval(tick, 1000);

  // ---- boot ---------------------------------------------------------------------
  (async () => {
    const r = await api('/staff/api/me');
    if (r.code === 200) { me = r.body.name; start(); }
    else { showScreen('login'); renderLogin(''); }
  })();
})();
