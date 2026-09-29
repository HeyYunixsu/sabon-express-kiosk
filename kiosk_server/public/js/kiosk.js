'use strict';
// Sabon Express kiosk: attract -> shop -> pay -> order/pin -> dispense -> thanks.
// Landscape 1920x1080, in the cashier V2 dashboard's visual language.
//
// Cash is an order. With the staff tablet on, the customer sees "Pay at the
// counter" with a QR, pays at the counter, and staff mark it paid from their
// tablet; with it off, the kiosk goes straight to the staff PIN pad. Either
// way the server decides, and the kiosk follows its stream.
//
// The dispense screen is driven by the controller, not by this page. Whenever
// STATUS shows paid presses on the machine, this page shows them -- so a
// reload, a crash or a second tab can never hide credit a customer paid for,
// and there is no "tap to continue" for a stranger on the attract screen.

(() => {
  const W = 1920;
  const H = 1080;
  const OFFLINE_MS = 6000;        // silence that means the machine is gone
  const THANKS_MS = 10000;
  const ENDED_MS = 5000;          // "Order expired" / "cancelled" stays this long
  const PAUSED_AFTER_MS = 900;    // remaining time frozen this long = paused
  const DONE_AUTO_MS = 20000;     // all dispensed, Done not tapped: finish anyway
  const MAX_QTY = 20;

  const $ = (id) => document.getElementById(id);
  const peso = (n) => '₱' + n;
  const MINUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M5 12h14"/></svg>';
  const PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';

  let products = [];
  let prices = {};
  let status = null;
  let online = false;
  let cashReady = false;
  let staffTablet = false;
  let staffBase = null;
  let idleSeconds = 60;
  let lastMsgAt = 0;
  let streamOpenedAt = 0;
  let es = null;

  let screen = '';
  let cart = {};                  // slot -> qty
  let cartKey = '';
  let pin = '';
  let lastTouch = Date.now();
  let thanksAt = 0;
  let order = null;               // the paid order being dispensed, from the server

  let pending = null;             // the order waiting for payment, from the server
  let pendingSeenAt = 0;
  let lastClosed = null;
  let myOrder = null;             // number of the order this screen is showing
  let endedAt = 0;                // when "expired"/"cancelled" went up
  let qrFor = '';
  let cancelArmedUntil = 0;

  let sending = false;            // one request at a time from this page
  let sendingSlot = 0;
  let dispenseEnteredAt = 0;
  let sawCredit = false;
  let doneSince = 0;
  let cardsKey = '';
  let pourMsg = '';
  const pour = {};                // slot -> { max, last, changedAt, pausedLocal }

  // ---- stage scaling ---------------------------------------------------------
  const stage = $('stage');
  function fit() {
    const s = Math.min(innerWidth / W, innerHeight / H);
    stage.style.left = `${(innerWidth - W * s) / 2}px`;
    stage.style.top = `${(innerHeight - H * s) / 2}px`;
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
  const myPending = () => (pending && pending.number === myOrder ? pending : null);

  // Items from the cart carry no price (the page's prices are used); items
  // from an order carry the price frozen when it was made.
  function cartRows(items) {
    return items.map((it) => {
      const p = products[it.slot - 1];
      const price = it.price !== undefined ? it.price : (prices[it.slot] || 0);
      return `<li class="v2-cart-row">
        <img src="${p.img}" alt="">
        <span class="v2-cart-name"><b>${p.name}</b><span>${p.ml ? `${p.ml} ml per press · ` : ''}${peso(price)} each</span></span>
        <span class="v2-cart-qty">× ${it.qty}</span>
        <span class="v2-cart-price">${peso(price * it.qty)}</span>
      </li>`;
    }).join('');
  }

  // ---- screens -----------------------------------------------------------------
  const VIEWS = ['shop', 'pay', 'order', 'pin', 'dispense', 'thanks'];
  function show(name) {
    if (name === screen) return;
    screen = name;
    $('attract').hidden = name !== 'attract';
    for (const v of VIEWS) $(`v-${v}`).hidden = v !== name;
    if (name === 'attract') { cart = {}; pin = ''; myOrder = null; endedAt = 0; }
    if (name === 'pay') $('pay-msg').textContent = '';
    if (name === 'pin') { pin = ''; setPinMsg(''); }
    if (name === 'dispense') {
      dispenseEnteredAt = Date.now(); sawCredit = false; doneSince = 0; pourMsg = ''; cardsKey = '';
      myOrder = null;
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
      doneSince = 0;
      return;
    }
    // A waiting order the page does not know about (a reload, a crash):
    // put it back on screen rather than strand it.
    if (pending && !myOrder && ['attract', 'shop', 'pay'].includes(screen)) {
      myOrder = pending.number;
      show(staffTablet ? 'order' : 'pin');
      return;
    }
    // Our order stopped waiting. Paid shows up as credit (above); anything
    // else gets a short explanation, then the start screen.
    if (myOrder && !endedAt && !myPending() && (screen === 'order' || screen === 'pin')) {
      const closed = lastClosed && lastClosed.number === myOrder ? lastClosed : null;
      if (closed && closed.status === 'paid') {
        // Paid normally shows up as credit (above). If the ARM never lands
        // (a lost message), this is the only way off a frozen wait screen:
        // dispense's own 8s "could not be unlocked" message covers it.
        show('dispense');
      } else {
        endedAt = now; show('order'); render();
      }
    }
    if (endedAt && now - endedAt > ENDED_MS) { endedAt = 0; show('attract'); return; }
    if (screen !== 'dispense') return;
    if (sawCredit) {
      // Everything poured: Done / Finish is live. If nobody taps it, finish
      // anyway so the next customer is not left looking at this order.
      doneSince = doneSince || now;
      if (now - doneSince > DONE_AUTO_MS) show('thanks');
    } else if (now - dispenseEnteredAt > 8000) {
      pourMsg = 'Your products could not be unlocked. Please call a staff member.';
    }
  }

  function render() {
    $('offline').hidden = machineReady() || (!lastMsgAt && Date.now() - streamOpenedAt < 2000);
    $('offline-text').textContent = screen === 'dispense'
      ? 'Your paid items are safe. Please wait — dispensing continues when the machine is back.'
      : 'Please wait a moment. If this stays, call a staff member.';
    renderHeader();
    if (screen === 'attract') renderShelf();
    if (screen === 'shop') renderShop();
    if (screen === 'pay') renderPay();
    if (screen === 'order') renderOrder();
    if (screen === 'pin') renderPin();
    if (screen === 'dispense') renderDispense();
  }

  // ---- header (V2 stats + identity) ------------------------------------------
  function renderHeader() {
    const chip = $('chip-state');
    const ready = machineReady();
    const busy = ready && creditOnMachine();
    chip.classList.toggle('is-offline', !ready);
    chip.classList.toggle('is-busy', busy);
    $('kpi-state').textContent = !ready ? 'Offline' : busy ? 'Dispensing' : 'Ready';
    const inStock = products.filter((p) => !isOut(p.slot)).length;
    const k = $('kpi-stock');
    k.textContent = `${inStock}/${products.length}`;
    k.className = 'v2-chip-v ' + (inStock === products.length ? 'is-full' : inStock >= 3 ? 'is-low' : 'is-critical');
    const d = new Date();
    $('v2-clock').textContent = `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
  }

  // ---- attract -------------------------------------------------------------------
  function renderShelf() {
    // Every product lit, stock or not: this screen sells the range. Stock is
    // shown on the shop screen, where it decides what can be bought.
    $('a-shelf').innerHTML = products.map((p) => `
      <div class="a-item">
        <div class="a-img"><img src="${p.img}" alt=""></div>
        <div class="n">${p.name}</div>
        <div class="p">${Number.isInteger(prices[p.slot]) ? `${peso(prices[p.slot])} per press` : '&nbsp;'}</div>
      </div>`).join('');
  }

  // ---- shop: V2 product tiles + cart --------------------------------------------
  // Built once and updated in place: STATUS arrives twice a second, and
  // rebuilding the buttons under a finger swallows the tap.
  function buildGrid() {
    $('v2-grid').innerHTML = products.map((p) => `
      <div class="v2-prod" id="card-${p.slot}" data-slot="${p.slot}">
        <div class="v2-prod-img"><img src="${p.img}" alt=""></div>
        <span class="v2-badge"><span class="v2-dot"></span><span class="b-txt">Ready</span></span>
        <div class="v2-prod-text">
          <div class="v2-prod-name">${p.name}</div>
          <div class="v2-prod-ml">${p.ml ? `${p.ml} ml per press` : '&nbsp;'}</div>
          <div class="v2-prod-price"></div>
        </div>
        <div class="v2-step-row">
          <button class="v2-step v2-step-minus" data-slot="${p.slot}" data-d="-1" aria-label="Less">${MINUS}</button>
          <span class="v2-step-qty">0</span>
          <button class="v2-step v2-step-plus" data-slot="${p.slot}" data-d="1" aria-label="More">${PLUS}</button>
        </div>
      </div>`).join('');
  }

  function renderShop() {
    for (const p of products) {
      const card = $(`card-${p.slot}`);
      const out = isOut(p.slot);
      const price = prices[p.slot];
      if (out) delete cart[p.slot];
      const qty = cart[p.slot] || 0;
      card.classList.toggle('is-empty', out);
      card.classList.toggle('in-cart', qty > 0);
      const badge = card.querySelector('.v2-badge');
      badge.className = 'v2-badge' + (out ? ' is-empty' : qty ? ' is-armed' : '');
      badge.querySelector('.b-txt').textContent = out ? 'Out of stock' : qty ? 'In cart' : 'Ready';
      card.querySelector('.v2-prod-price').innerHTML =
        Number.isInteger(price) ? `${peso(price)} <small>per press</small>` : '&nbsp;';
      card.querySelector('.v2-step-qty').textContent = qty;
      card.querySelector('.v2-step-minus').disabled = qty === 0;
      card.querySelector('.v2-step-plus').disabled = out || !Number.isInteger(price) || qty >= MAX_QTY;
    }
    const items = cartItems();
    const key = items.map((i) => `${i.slot}:${i.qty}`).join(',') + '|' + JSON.stringify(prices);
    if (key !== cartKey) {
      cartKey = key;
      $('v2-cart-list').innerHTML = cartRows(items);
    }
    $('v2-cart-empty').hidden = items.length > 0;
    $('btn-clear').hidden = items.length === 0;
    $('total-items').textContent = cartCount();
    $('total-amount').textContent = peso(cartTotal());
    $('btn-unlock').disabled = items.length === 0 || !pricesKnown() || !machineReady();
  }

  function changeQty(slot, d) {
    const price = prices[slot];
    if (d > 0 && (isOut(slot) || !Number.isInteger(price))) return;
    const qty = Math.max(0, Math.min(MAX_QTY, (cart[slot] || 0) + d));
    if (qty) cart[slot] = qty; else delete cart[slot];
    renderShop();
  }

  $('v2-grid').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-d]');
    if (b) { if (!b.disabled) changeQty(+b.dataset.slot, +b.dataset.d); return; }
    // The whole tile is a target too: a customer taps the bottle they want.
    const card = e.target.closest('.v2-prod');
    if (card) changeQty(+card.dataset.slot, 1);
  });
  $('btn-clear').addEventListener('click', () => { cart = {}; renderShop(); });
  $('btn-unlock').addEventListener('click', () => show('pay'));

  // ---- pay: choose cash or QR ------------------------------------------------------
  function renderPay() {
    $('pay-amount').textContent = peso(cartTotal());
    $('pay-cash').disabled = !cashReady || !machineReady() || sending;
    $('pay-cash-desc').textContent = !cashReady
      ? 'Not set up on this kiosk — please call staff'
      : staffTablet ? 'Pay at the counter' : 'Hand the exact amount to a staff member';
  }

  const PAY_MSG = {
    price_changed: 'Prices were just updated. Please check the new total.',
    machine_busy: 'The machine is still finishing an order. Please wait.',
    order_waiting: 'Another order is waiting for payment. Please wait a moment.',
    offline: 'The machine is not ready. Please try again in a moment.',
    no_prices: 'Prices are still loading. Please wait a moment.',
  };

  $('pay-cash').addEventListener('click', async () => {
    if (sending) return;
    sending = true;
    renderPay();
    const r = await post('/api/order', { items: cartItems(), amount: cartTotal() });
    sending = false;
    if (r.code === 200) {
      pending = r.body.order;
      pendingSeenAt = Date.now();
      myOrder = pending.number;
      endedAt = 0;
      show(staffTablet ? 'order' : 'pin');
      return;
    }
    const e = r.body.error;
    if (e === 'empty') {
      const p = products[(r.body.slot || 1) - 1];
      $('pay-msg').textContent = `Sorry, ${p.name} just ran out. Please change the order.`;
      setTimeout(() => { if (screen === 'pay') show('shop'); }, 2500);
    } else {
      $('pay-msg').textContent = PAY_MSG[e] || PAY_MSG.offline;
    }
    renderPay();
  });

  // ---- order: pay at the counter ------------------------------------------------
  const ENDED = {
    expired: ['Order expired', 'Nothing was charged. You can order again.'],
    customer: ['Order cancelled', 'Nothing was charged.'],
    staff: ['Order cancelled by staff', 'Nothing was charged. Please ask at the counter.'],
    out_of_stock: ['A product ran out', 'Nothing was charged. Please order again.'],
    price_changed: ['Prices changed', 'Nothing was charged. Please order again at the new price.'],
    gone: ['Order no longer available', 'Nothing was charged. Please order again.'],
  };

  function renderOrder() {
    const ended = !!endedAt;
    $('o-live').hidden = ended;
    $('o-wait').hidden = ended;
    $('o-foot').hidden = ended;
    $('o-lead').hidden = ended;
    $('o-ended').hidden = !ended;
    $('o-title').textContent = ended ? `Order ${myOrder || ''}` : 'Pay at the counter';
    if (ended) {
      const c = lastClosed && lastClosed.number === myOrder ? lastClosed : null;
      const key = !c ? 'gone' : c.status === 'expired' ? 'expired' : (c.reason || 'gone');
      const [title, text] = ENDED[key] || ENDED.gone;
      $('o-ended-title').textContent = title;
      $('o-ended-text').textContent = text;
      return;
    }
    const o = myPending();
    if (!o) return;
    $('o-amount').textContent = peso(o.amount);
    $('o-total').textContent = peso(o.amount);
    $('o-number').textContent = o.number;
    $('o-items').innerHTML = cartRows(o.items);
    if (qrFor !== o.number) {
      qrFor = o.number;
      const canQr = !!staffBase && typeof qrcode === 'function';
      if (canQr) {
        const q = qrcode(0, 'M');
        q.addData(`${staffBase}/staff/order/${o.number}`);
        q.make();
        $('o-qr').innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
      }
      $('o-qr').hidden = !canQr;
      $('o-hint').hidden = !canQr;
    }
    const left = Math.max(0, o.remainingMs - (Date.now() - pendingSeenAt));
    const s = Math.ceil(left / 1000);
    $('o-wait-text').textContent = `Waiting for payment · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} left`;
    const bar = $('o-bar');
    bar.style.width = `${Math.min(100, (left / o.totalMs) * 100)}%`;
    bar.parentElement.classList.toggle('is-low', left < 30000);
    const c = $('o-cancel');
    const confirming = Date.now() < cancelArmedUntil;
    c.classList.toggle('is-confirm', confirming);
    c.textContent = confirming ? 'Tap again to cancel' : 'Cancel order';
  }

  async function cancelOrder() {
    const n = myOrder;
    myOrder = null;   // route() must not read our own cancel as an order that ended by itself
    if (n) await post('/api/order/cancel', { number: n });
  }

  // Two taps: a customer brushing the button should not lose their order.
  $('o-cancel').addEventListener('click', async () => {
    if (Date.now() < cancelArmedUntil) {
      cancelArmedUntil = 0;
      await cancelOrder();
      // The customer chose this: straight back to the start, no explanation
      // screen. (show('attract') also clears myOrder, so route() will not
      // treat the closed order as one that ended on its own.)
      show('attract');
      return;
    }
    cancelArmedUntil = Date.now() + 3000;
    renderOrder();
  });
  $('o-staff').addEventListener('click', () => show('pin'));
  $('pin-back').addEventListener('click', async () => {
    if (staffTablet) { show('order'); return; }
    await cancelOrder();
    show('pay');
  });

  // ---- pin: staff confirm the cash ---------------------------------------------------
  function setPinMsg(text, shake) {
    $('pin-msg').textContent = text;
    if (shake) {
      const d = $('pin-dots');
      d.classList.remove('shake'); void d.offsetWidth; d.classList.add('shake');
    }
  }

  function renderPin() {
    const o = myPending();
    const items = o ? o.items : cartItems();
    const amount = o ? o.amount : cartTotal();
    $('pin-summary').innerHTML = cartRows(items);
    $('pin-amount').textContent = $('pin-total').textContent = peso(amount);
    $('pin-items').textContent = items.reduce((a, it) => a + it.qty, 0);
    const slots = Math.max(4, pin.length);
    $('pin-dots').innerHTML = Array.from({ length: slots }, (_, i) =>
      `<i class="${i < pin.length ? 'on' : ''}"></i>`).join('');
    $('confirm-cash').disabled = pin.length < 4 || sending || !machineReady() || !o;
    $('confirm-label').textContent = sending ? 'Checking…' : 'Confirm & Unlock';
  }

  $('keypad').addEventListener('click', (e) => {
    const k = e.target.closest('button[data-k]');
    if (!k || sending) return;
    const key = k.dataset.k;
    if (key === 'clear') pin = '';
    else if (key === 'back') pin = pin.slice(0, -1);
    else if (pin.length < 8) pin += key;
    setPinMsg('');
    renderPin();
  });

  $('confirm-cash').addEventListener('click', async () => {
    if (sending || pin.length < 4 || !myOrder) return;
    sending = true;
    renderPin();
    const r = await post('/api/order/pin', { number: myOrder, pin });
    sending = false;
    pin = '';
    if (r.code === 200) {
      order = { reference: r.body.order.reference, staff: r.body.order.by, items: r.body.order.items };
      renderPin();
      return;       // the credit arrives over the stream and route() goes to dispense
    }
    const e = r.body.error;
    if (e === 'wrong') setPinMsg('Wrong PIN. Please try again.', true);
    else if (e === 'locked') setPinMsg(`Too many wrong PINs. Try again in ${Math.ceil((r.body.retryInMs || 60000) / 1000)} s.`, true);
    else if (e === 'no_staff') setPinMsg('No staff PINs are set up on this kiosk. Please call staff.');
    else if (e === 'machine_busy') setPinMsg('The machine is still finishing an order. Please wait.');
    else if (['not_waiting', 'out_of_stock', 'price_changed'].includes(e)) { /* the stream shows why */ }
    else setPinMsg('The machine is not ready. Don\'t take the cash yet — please try again.');
    renderPin();
  });

  // ---- dispense: the purchased items, side by side ------------------------------
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

  // What was bought. The server remembers the order; anything STATUS still
  // owes that the order does not list (a server restart lost it) is added
  // from STATUS, so paid presses are never missing from the screen.
  function orderItems() {
    const items = order ? order.items.map((i) => ({ slot: i.slot, qty: i.qty })) : [];
    if (status) {
      for (const s of status.slots) {
        if (!hasCredit(s) || items.some((i) => i.slot === s.slot)) continue;
        items.push({ slot: s.slot, qty: s.armed + s.queued + (s.busy ? 1 : 0) });
      }
    }
    return items.sort((a, b) => a.slot - b.slot);
  }

  // Units dispensed = bought - still owed - the one pouring now.
  function units(item) {
    const s = slotState(item.slot);
    const left = s.armed + s.queued;
    const pouring = s.busy ? 1 : 0;
    const qty = Math.max(item.qty, left + pouring);
    return { s, qty, pouring: !!s.busy, done: sawCredit ? qty - left - pouring : 0 };
  }

  function buildCards(items) {
    const key = items.map((i) => `${i.slot}:${i.qty}`).join(',');
    if (key === cardsKey) return;
    cardsKey = key;
    const row = $('d-row');
    row.classList.toggle('many', items.length > 4);
    row.innerHTML = items.map((i) => {
      const p = products[i.slot - 1];
      return `<div class="d-card" id="dc-${i.slot}">
        <div class="d-img"><img src="${p.img}" alt=""></div>
        <div class="d-nozzle">Nozzle ${i.slot}</div>
        <h3 class="d-name">${p.name}</h3>
        <div class="d-qty"></div>
        <div class="d-count"></div>
        <div class="d-pips"></div>
        <div class="d-bar"><i></i></div>
        <button class="d-btn" data-slot="${i.slot}">DISPENSE</button>
      </div>`;
    }).join('');
  }

  const POUR_MSG = {
    no_credit: '',
    empty: 'This product has just run out. Please call a staff member.',
    max_active: 'Please wait — another nozzle is still pouring.',
    priming: 'This nozzle is being cleaned. Please try again in a moment.',
    machine_paused: 'The machine has been paused by staff. Please wait.',
    slot_paused: 'Tap to resume.',
    cooldown: 'Please tap again.',
    timeout: 'The machine did not answer. Please tap again.',
    offline: 'The machine is not ready. Your paid items are safe.',
  };

  function renderDispense() {
    if (!status) return;
    const items = orderItems();
    buildCards(items);
    const anyPouring = status.slots.some((s) => s.busy);
    let unitsLeft = 0;
    let allDone = sawCredit && items.length > 0;

    for (const item of items) {
      const card = $(`dc-${item.slot}`);
      if (!card) continue;
      const prod = products[item.slot - 1];
      const u = units(item);
      const paused = isPaused(u.s);
      const complete = sawCredit && u.done >= u.qty && !u.pouring;
      if (!complete) allDone = false;
      unitsLeft += u.qty - u.done;

      card.classList.toggle('is-pouring', u.pouring && !paused);
      card.classList.toggle('is-paused', u.pouring && paused);
      card.classList.toggle('is-done', complete);
      card.classList.toggle('is-waiting', !u.pouring && !complete && (anyPouring || sending));

      card.querySelector('.d-qty').textContent =
        `Quantity: ${u.qty}${prod.ml ? ` · ${prod.ml} ml each` : ''}`;
      card.querySelector('.d-count').textContent =
        !sawCredit ? 'Unlocking…'
        : u.s.empty && !complete && !u.pouring ? 'Out of stock — call staff'
        : `${u.done} / ${u.qty} dispensed${complete ? ' ✓' : ''}`;
      card.querySelector('.d-pips').innerHTML = u.qty <= 12
        ? Array.from({ length: u.qty }, (_, i) =>
            `<i class="${i < u.done ? 'done' : i === u.done && u.pouring ? 'now' : ''}"></i>`).join('')
        : '';

      const p = pour[item.slot];
      const pct = u.pouring && p && p.max ? Math.round(100 * (1 - u.s.remainingMs / p.max)) : 0;
      card.querySelector('.d-bar i').style.width = `${pct}%`;

      // DISPENSE -> DISPENSING... -> DISPENSED ✓. While pouring, the same
      // button pauses and resumes, so the customer never has to look for it.
      const btn = card.querySelector('.d-btn');
      let act = '';
      let html = 'PLEASE WAIT';
      let cls = 'd-btn';
      if (sending && sendingSlot === item.slot) html = 'STARTING…';
      else if (!sawCredit) html = 'PLEASE WAIT';
      else if (u.pouring && paused) { act = 'resume'; html = 'PAUSED<small>Tap to resume</small>'; cls += ' is-paused'; }
      else if (u.pouring) { act = 'pause'; html = 'DISPENSING…<small>Tap to pause</small>'; cls += ' is-pouring'; }
      else if (complete) { html = 'DISPENSED ✓'; cls += ' is-done'; }
      else if (u.s.priming) html = 'CLEARING AIR…';
      else if (u.s.empty) html = 'CALL STAFF';
      else if (!anyPouring && !sending) { act = 'dispense'; html = u.done ? 'DISPENSE NEXT' : 'DISPENSE'; }
      btn.dataset.act = act;
      btn.disabled = !act;
      btn.className = cls;
      if (btn.innerHTML !== html) btn.innerHTML = html;
    }

    $('d-sub').textContent = order && order.staff
      ? order.reference && order.reference.startsWith('credit ')
        ? `Given back by ${order.staff}. Place your bottle under the nozzle shown, then tap Dispense.`
        : `Cash received by ${order.staff}. Place your bottle under the nozzle shown, then tap Dispense.`
      : 'Place your bottle under the nozzle shown, then tap Dispense.';
    $('d-msg').textContent = status.paused ? POUR_MSG.machine_paused : pourMsg;
    const finished = allDone && !anyPouring;
    $('d-done').hidden = !finished;
    $('d-left').textContent = finished
      ? 'Everything is dispensed.'
      : sawCredit ? `${unitsLeft} ${unitsLeft === 1 ? 'unit' : 'units'} left to dispense` : 'Unlocking your items…';
  }

  $('d-row').addEventListener('click', async (e) => {
    const btn = e.target.closest('.d-btn');
    if (!btn || btn.disabled || sending) return;
    const act = btn.dataset.act;
    const slot = +btn.dataset.slot;
    if (!act) return;
    sending = true;
    sendingSlot = slot;
    pourMsg = '';
    render();
    const r = await post(`/api/${act}`, { slot });
    sending = false;
    sendingSlot = 0;
    const result = r.body.result || r.body.error;
    const p = pour[slot];
    if (p && act === 'pause' && result === 'ok') p.pausedLocal = true;
    if (p && act === 'resume' && result === 'ok') { p.pausedLocal = false; p.changedAt = Date.now(); }
    pourMsg = result === 'ok' ? '' : (POUR_MSG[result] || '');
    render();
  });
  $('d-done').addEventListener('click', () => show('thanks'));

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
    // STATUS cannot tell an air clear from a customer's pour -- both show the
    // slot busy. The server tracks which slots are priming; treat those as
    // not busy everywhere else reads s.busy, on a copy so nothing shared with
    // the server's own object gets mutated.
    if (status && data.priming && data.priming.length) {
      status = {
        ...status,
        slots: status.slots.map((s) =>
          data.priming.includes(s.slot) ? { ...s, busy: false, priming: true } : s),
      };
    }
    if (data.order) order = data.order;
    pending = data.pending || null;
    if (pending) pendingSeenAt = Date.now();
    lastClosed = data.lastClosed || null;
    if (data.staffBase !== undefined && data.staffBase !== staffBase) {
      staffBase = data.staffBase;
      qrFor = '';   // redraw the QR against the new address
    }
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
    // An order keeps the screen: only the order's own timeout ends it.
    if (['shop', 'pay'].includes(screen) && now - lastTouch > idleSeconds * 1000) show('attract');
    if (screen === 'pin' && !myOrder && now - lastTouch > idleSeconds * 1000) show('attract');
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
      staffTablet = !!s.staffTablet;
      staffBase = s.staffBase || null;
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
