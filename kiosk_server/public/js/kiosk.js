'use strict';
// Sabon Express kiosk screens: attract -> pick -> pay -> dispense -> thanks.
//
// The dispense screen is driven by the controller, not by this page. Whenever
// STATUS shows paid presses on the machine, this page shows them -- so a
// reload, a crash or a second tab can never hide credit a customer paid for,
// and there is no "tap to continue" for a stranger on the attract screen.

(() => {
  const OFFLINE_MS = 6000;        // silence that means the machine is gone
  const THANKS_MS = 10000;
  const PAUSED_AFTER_MS = 900;    // remaining time frozen this long = paused

  const $ = (id) => document.getElementById(id);
  const peso = (n) => '₱' + n;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 'es'}`;

  let products = [];
  let prices = {};
  let status = null;
  let online = false;
  let cashReady = false;
  let idleSeconds = 60;
  let lastMsgAt = 0;
  let streamOpenedAt = 0;
  let es = null;

  let screen = '';
  let cart = {};                  // slot -> qty
  let pin = '';
  let lastTouch = Date.now();
  let thanksAt = 0;
  let staffName = '';

  let sending = false;            // one request at a time from this page
  let dispenseEnteredAt = 0;
  let sawCredit = false;
  let noCreditSince = 0;
  let pourMsg = '';
  const pour = {};                // slot -> { max, last, changedAt, pausedLocal }

  // ---- stage scaling ---------------------------------------------------------
  const stage = $('stage');
  function fit() {
    const s = Math.min(innerWidth / 1080, innerHeight / 1920);
    stage.style.left = `${(innerWidth - 1080 * s) / 2}px`;
    stage.style.top = `${(innerHeight - 1920 * s) / 2}px`;
    stage.style.transform = `scale(${s})`;
  }
  addEventListener('resize', fit);
  fit();

  // ---- helpers ---------------------------------------------------------------
  async function post(url, body) {
    try {
      const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { code: res.status, body: await res.json() };
    } catch (_) {
      return { code: 0, body: { error: 'offline', result: 'offline' } };
    }
  }
  const slotState = (slot) => (status ? status.slots[slot - 1] : null);
  const isOut = (slot) => { const s = slotState(slot); return !!(s && s.empty); };
  const hasCredit = (s) => s.armed > 0 || s.busy || s.queued > 0;
  const creditOnMachine = () => !!status && status.slots.some(hasCredit);
  const cartItems = () => Object.entries(cart).map(([slot, qty]) => ({ slot: +slot, qty }));
  const cartCount = () => cartItems().reduce((a, it) => a + it.qty, 0);
  const cartTotal = () => cartItems().reduce((a, it) => a + (prices[it.slot] || 0) * it.qty, 0);
  const pricesKnown = () => cartItems().every((it) => Number.isInteger(prices[it.slot]));
  const machineReady = () => online && Date.now() - lastMsgAt < OFFLINE_MS;

  // ---- screens -----------------------------------------------------------------
  function show(name) {
    if (name === screen) return;
    screen = name;
    for (const el of document.querySelectorAll('.screen')) el.hidden = el.id !== `s-${name}`;
    if (name === 'attract') { cart = {}; pin = ''; staffName = ''; }
    if (name === 'pay') { pin = ''; setPinMsg(''); }
    if (name === 'dispense') {
      dispenseEnteredAt = Date.now(); sawCredit = false; noCreditSince = 0; pourMsg = '';
    }
    if (name === 'thanks') thanksAt = Date.now();
    lastTouch = Date.now();
    render();
  }

  function route() {
    const now = Date.now();
    if (creditOnMachine()) {
      if (screen !== 'dispense') show('dispense');
      sawCredit = true;
      noCreditSince = 0;
      return;
    }
    if (screen !== 'dispense') return;
    if (sawCredit) {
      // Short grace: between one product finishing and STATUS catching up.
      noCreditSince = noCreditSince || now;
      if (now - noCreditSince > 1500) show('thanks');
    } else if (now - dispenseEnteredAt > 8000) {
      pourMsg = 'Your products could not be unlocked. Please call a staff member.';
    }
  }

  function render() {
    $('offline').hidden = machineReady() || (!lastMsgAt && Date.now() - streamOpenedAt < 2000);
    $('offline-text').textContent = screen === 'dispense'
      ? 'Your paid presses are safe. Please wait — pouring continues when the machine is back.'
      : 'Please wait a moment. If this stays, call a staff member.';
    if (screen === 'attract') renderShelf();
    if (screen === 'pick') renderPick();
    if (screen === 'pay') renderPay();
    if (screen === 'dispense') renderDispense();
  }

  // ---- attract -----------------------------------------------------------------
  function renderShelf() {
    $('attract-shelf').innerHTML = products.map((p) => `
      <div class="shelf-item${isOut(p.slot) ? ' is-out' : ''}">
        <img src="${p.img}" alt="">
        <div class="n">${p.name}</div>
        <div class="p">${isOut(p.slot) ? 'Out of stock'
          : Number.isInteger(prices[p.slot]) ? `${peso(prices[p.slot])} per press` : '&nbsp;'}</div>
      </div>`).join('');
  }

  // ---- pick ----------------------------------------------------------------------
  // Built once and updated in place: STATUS arrives twice a second, and
  // rebuilding the buttons under a finger swallows the tap.
  function buildGrid() {
    $('grid').innerHTML = products.map((p) => `
      <div class="card" id="card-${p.slot}">
        <span class="card-flag" hidden>Out of stock</span>
        <div class="card-img"><img src="${p.img}" alt=""></div>
        <div class="card-name">${p.name}</div>
        <div class="card-meta"></div>
        <div class="stepper">
          <button class="minus" data-slot="${p.slot}" data-d="-1" aria-label="Less">−</button>
          <span class="qty">0</span>
          <button class="plus" data-slot="${p.slot}" data-d="1" aria-label="More">+</button>
        </div>
      </div>`).join('');
  }

  function renderPick() {
    for (const p of products) {
      const card = $(`card-${p.slot}`);
      const out = isOut(p.slot);
      const price = prices[p.slot];
      if (out) delete cart[p.slot];
      const qty = cart[p.slot] || 0;
      card.classList.toggle('is-out', out);
      card.classList.toggle('in-cart', qty > 0);
      card.querySelector('.card-flag').hidden = !out;
      card.querySelector('.card-meta').innerHTML =
        `${p.ml ? `${p.ml} ml · ` : ''}<b>${Number.isInteger(price) ? peso(price) : '—'}</b> per press`;
      card.querySelector('.qty').textContent = qty;
      card.querySelector('.minus').disabled = qty === 0;
      card.querySelector('.plus').disabled = out || !Number.isInteger(price) || qty >= 20;
    }
    const n = cartCount();
    $('pick-count').textContent = n ? `${n} press${n === 1 ? '' : 'es'}` : 'No products yet';
    $('pick-total').textContent = peso(cartTotal());
    $('to-pay').disabled = n === 0 || !pricesKnown() || !machineReady();
  }

  $('grid').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-slot]');
    if (!b || b.disabled) return;
    const slot = +b.dataset.slot;
    const qty = Math.max(0, Math.min(20, (cart[slot] || 0) + +b.dataset.d));
    if (qty) cart[slot] = qty; else delete cart[slot];
    renderPick();
  });
  $('to-pay').addEventListener('click', () => show('pay'));

  // ---- pay -----------------------------------------------------------------------
  function setPinMsg(text, shake) {
    $('pin-msg').textContent = text;
    if (shake) {
      const d = $('pin-dots');
      d.classList.remove('shake'); void d.offsetWidth; d.classList.add('shake');
    }
  }

  function renderPay() {
    $('pay-summary').innerHTML = cartItems().map((it) => {
      const p = products[it.slot - 1];
      return `<li><span>${p.name} × ${it.qty}</span><span>${peso((prices[it.slot] || 0) * it.qty)}</span></li>`;
    }).join('');
    $('pay-total').textContent = $('pay-total-2').textContent = peso(cartTotal());
    $('pin-card').hidden = !cashReady;
    $('cash-off').hidden = cashReady;
    const slots = Math.max(4, pin.length);
    $('pin-dots').innerHTML = Array.from({ length: slots }, (_, i) =>
      `<i class="${i < pin.length ? 'on' : ''}"></i>`).join('');
    $('confirm-cash').disabled = pin.length < 4 || sending || !machineReady();
    $('confirm-cash').textContent = sending ? 'Checking…' : 'Confirm payment';
  }

  $('keypad').addEventListener('click', (e) => {
    const k = e.target.closest('button[data-k]');
    if (!k || sending) return;
    const key = k.dataset.k;
    if (key === 'clear') pin = '';
    else if (key === 'back') pin = pin.slice(0, -1);
    else if (pin.length < 8) pin += key;
    setPinMsg('');
    renderPay();
  });

  $('confirm-cash').addEventListener('click', async () => {
    if (sending || pin.length < 4) return;
    sending = true;
    renderPay();
    const r = await post('/api/cash', { items: cartItems(), amount: cartTotal(), pin });
    sending = false;
    pin = '';
    if (r.code === 200) {
      staffName = r.body.staff;
      show('dispense');
      return;
    }
    const e = r.body.error;
    if (e === 'wrong') setPinMsg('Wrong PIN. Please try again.', true);
    else if (e === 'locked') setPinMsg(`Too many wrong PINs. Try again in ${Math.ceil((r.body.retryInMs || 60000) / 1000)} s.`, true);
    else if (e === 'price_changed') setPinMsg('Prices were just updated. Please check the new total.');
    else if (e === 'empty') {
      const p = products[(r.body.slot || 1) - 1];
      setPinMsg(`Sorry, ${p.name} just ran out. Please change the order.`);
      setTimeout(() => { if (screen === 'pay') show('pick'); }, 2500);
    }
    else if (e === 'machine_busy') setPinMsg('The machine is still finishing an order. Please wait.');
    else if (e === 'no_staff') cashReady = false;
    else if (e === 'no_prices') setPinMsg('Prices are still loading. Please wait a moment.');
    else setPinMsg('The machine is not ready. Nothing was charged — please try again.');
    renderPay();
  });

  // ---- dispense ------------------------------------------------------------------
  function trackPours() {
    const now = Date.now();
    for (const s of status.slots) {
      const p = pour[s.slot] || (pour[s.slot] = { max: 0, last: -1, changedAt: 0, pausedLocal: false });
      if (!s.busy) { p.max = 0; p.last = -1; p.pausedLocal = false; continue; }
      if (s.remainingMs !== p.last) { p.last = s.remainingMs; p.changedAt = now; }
      if (s.remainingMs > p.max) p.max = s.remainingMs;
    }
  }

  function isPaused(s) {
    const p = pour[s.slot];
    if (!s.busy || !p) return false;
    return p.pausedLocal || (s.remainingMs > 0 && Date.now() - p.changedAt > PAUSED_AFTER_MS);
  }

  // The pour in progress first, then the lowest slot still owed presses.
  function currentSlot() {
    if (!status) return null;
    const sl = status.slots;
    return sl.find((s) => s.busy) || sl.find((s) => s.armed > 0 && !s.empty)
        || sl.find((s) => s.armed > 0) || sl.find((s) => s.queued > 0) || null;
  }

  const POUR_MSG = {
    no_credit: '',
    empty: 'This product has just run out. Please call a staff member.',
    max_active: 'Please wait — another nozzle is still pouring.',
    priming: 'This nozzle is being cleaned. Please try again in a moment.',
    machine_paused: 'The machine has been paused by staff. Please wait.',
    slot_paused: 'Tap Resume to continue.',
    cooldown: 'Please tap again.',
    timeout: 'The machine did not answer. Please tap again.',
    offline: 'The machine is not ready. Your paid presses are safe.',
  };

  function renderDispense() {
    const btn = $('d-btn');
    const fill = $('d-fill');
    $('d-sub').textContent = staffName
      ? `Cash received by ${staffName}. Fill one product at a time.`
      : 'Fill your bottle one product at a time.';
    const c = currentSlot();
    if (!c) {
      $('d-state').textContent = sawCredit ? 'All done!' : 'Unlocking your products…';
      fill.style.width = sawCredit ? '100%' : '0';
      fill.className = 'progress-fill' + (sawCredit ? ' is-done' : '');
      btn.disabled = true;
      btn.className = 'btn-pour';
      btn.textContent = sawCredit ? 'Done' : 'Please wait';
      btn.dataset.act = '';
      $('d-msg').textContent = pourMsg;
      $('d-next').innerHTML = '';
      return;
    }

    const prod = products[c.slot - 1];
    const paused = isPaused(c);
    const p = pour[c.slot];
    if ($('d-img').getAttribute('src') !== prod.img) $('d-img').src = prod.img;
    $('d-nozzle').textContent = `Nozzle ${c.slot}`;
    $('d-name').textContent = prod.name;
    $('d-meta').textContent = c.busy
      ? (c.armed > 0 ? `Pouring · ${plural(c.armed, 'press')} still to go` : 'Pouring your paid measure')
      : `${plural(c.armed, 'press')} paid${prod.ml ? ` · ${c.armed * prod.ml} ml` : ''}`;

    const pct = c.busy && p && p.max ? Math.round(100 * (1 - c.remainingMs / p.max)) : 0;
    fill.style.width = `${pct}%`;
    fill.className = 'progress-fill' + (paused ? ' is-paused' : '');

    let act = '';
    if (sending) {
      btn.disabled = true; btn.className = 'btn-pour'; btn.textContent = 'Starting…';
    } else if (c.busy && paused) {
      act = 'resume'; btn.disabled = false; btn.className = 'btn-pour is-resume'; btn.textContent = 'Resume';
    } else if (c.busy) {
      act = 'pause'; btn.disabled = false; btn.className = 'btn-pour is-pause'; btn.textContent = 'Pause';
    } else if (c.armed > 0 && !c.empty) {
      act = 'dispense'; btn.disabled = false; btn.className = 'btn-pour'; btn.textContent = 'Dispense now';
    } else {
      btn.disabled = true; btn.className = 'btn-pour';
      btn.textContent = c.empty ? 'Please call staff' : 'Please wait';
    }
    btn.dataset.act = act;
    btn.dataset.slot = c.slot;

    $('d-state').textContent =
      c.empty && !c.busy ? 'This product has run out'
      : paused ? 'Paused — tap Resume when your bottle is ready'
      : c.busy ? `Pouring… keep your bottle under nozzle ${c.slot}`
      : `Place your bottle under nozzle ${c.slot}`;
    $('d-msg').textContent = status.paused ? POUR_MSG.machine_paused : pourMsg;

    const owed = status.slots.filter(hasCredit);
    $('d-next').innerHTML = owed.length > 1
      ? '<div class="next-label">Your order</div>' + owed.map((s) => {
          const pr = products[s.slot - 1];
          return `<div class="next-item${s.slot === c.slot ? ' is-now' : ''}">
            <img src="${pr.img}" alt="">${pr.name}${s.armed ? ` × ${s.armed}` : ''}</div>`;
        }).join('')
      : '';
  }

  $('d-btn').addEventListener('click', async () => {
    const btn = $('d-btn');
    const act = btn.dataset.act;
    const slot = +btn.dataset.slot;
    if (!act || sending) return;
    sending = true;
    pourMsg = '';
    render();
    const r = await post(`/api/${act}`, { slot });
    sending = false;
    const result = r.body.result || r.body.error;
    const p = pour[slot];
    if (p && act === 'pause' && result === 'ok') p.pausedLocal = true;
    if (p && act === 'resume' && result === 'ok') { p.pausedLocal = false; p.changedAt = Date.now(); }
    pourMsg = result === 'ok' ? '' : (POUR_MSG[result] || '');
    render();
  });

  // ---- navigation, idle, liveness ------------------------------------------------
  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (go && !e.target.closest('button:not([data-go])')) show(go.dataset.go);
  });
  document.addEventListener('pointerdown', () => { lastTouch = Date.now(); }, true);
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  function onState(data) {
    lastMsgAt = Date.now();
    online = data.online;
    status = data.status;
    if (data.prices && Object.keys(data.prices).length) prices = data.prices;
    if (status) trackPours();
    route();
    render();
  }

  function openStream() {
    if (es) es.close();
    streamOpenedAt = Date.now();
    es = new EventSource('/api/stream');
    es.onmessage = (e) => { try { onState(JSON.parse(e.data)); } catch (_) {} };
  }

  setInterval(() => {
    const now = Date.now();
    // An open stream that has gone quiet never fires onerror, so rebuild it.
    if (now - lastMsgAt > OFFLINE_MS && now - streamOpenedAt > OFFLINE_MS) openStream();
    if ((screen === 'pick' || screen === 'pay') && now - lastTouch > idleSeconds * 1000) show('attract');
    if (screen === 'thanks' && now - thanksAt > THANKS_MS) show('attract');
    route();
    render();
  }, 1000);

  async function boot() {
    try {
      const s = await (await fetch('/api/state')).json();
      products = s.products;
      idleSeconds = s.idleSeconds;
      cashReady = s.cashReady;
      buildGrid();
      show('attract');
      onState(s);
    } catch (_) {
      setTimeout(boot, 2000);
      return;
    }
    openStream();
  }
  boot();
})();
