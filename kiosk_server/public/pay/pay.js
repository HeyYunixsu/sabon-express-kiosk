'use strict';
// QR payment DEMO: the page a phone opens by scanning the kiosk's QR. No
// money moves -- Pay tells the kiosk the order is paid. The server serves it
// only with QR_DEMO = 1.

(() => {
  const $ = (id) => document.getElementById(id);
  const peso = (n) => '₱' + n;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const number = (location.pathname.match(/^\/pay\/([A-Z]-\d+)$/) || [])[1];
  let order = null;
  let busy = false;

  async function api(path, body) {
    const opt = body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    };
    try {
      const r = await fetch(path, opt);
      return { code: r.status, body: await r.json().catch(() => ({})) };
    } catch (_) {
      return { code: 0, body: { error: 'network' } };
    }
  }

  const ENDED = {
    paid: 'This order is already paid.',
    expired: 'This order expired. Nothing was charged — order again on the kiosk.',
    cancelled: 'This order was cancelled. Nothing was charged.',
  };
  const FAIL = {
    offline: 'The machine is not ready — try again in a moment.',
    machine_busy: 'The machine is busy — try again in a moment.',
    out_of_stock: 'A product ran out — the order was cancelled. Nothing was charged.',
    price_changed: 'Prices changed — the order was cancelled. Nothing was charged.',
    network: 'Cannot reach the kiosk. Check the Wi-Fi.',
  };

  // msg undefined: say what the order's own state means.
  function render(msg, ok) {
    const st = $('p-state');
    st.className = ok ? 'p-state is-ok' : 'p-state';
    if (!order) {
      $('p-body').hidden = true;
      st.textContent = msg || 'Order not found. Scan the code on the kiosk again.';
      return;
    }
    $('p-body').hidden = false;
    $('p-num').textContent = `Order ${order.number}`;
    $('p-items').innerHTML = order.items.map((i) =>
      `<li><span>${esc(i.name)} × ${i.qty}</span><span>${peso(i.price * i.qty)}</span></li>`).join('');
    $('p-total').textContent = peso(order.amount);
    const waiting = order.status === 'waiting';
    const pay = $('p-pay');
    pay.hidden = !waiting;
    pay.disabled = busy;
    pay.textContent = busy ? 'Paying…' : `Pay ${peso(order.amount)}`;
    st.textContent = msg !== undefined ? msg : waiting ? '' : ENDED[order.status] || '';
  }

  async function load() {
    if (!number) { render('Scan the code on the kiosk.'); return; }
    const r = await api(`/pay/api/order?number=${encodeURIComponent(number)}`);
    order = r.code === 200 ? r.body.order : null;
    render(r.code === 0 ? FAIL.network : undefined);
  }

  $('p-pay').addEventListener('click', async () => {
    if (busy || !order) return;
    busy = true;
    render('');
    const r = await api('/pay/api/confirm', { number: order.number });
    busy = false;
    if (r.code === 200) {
      order = r.body.order;
      render('Payment successful ✓ Go back to the kiosk to pour.', true);
      return;
    }
    if (r.body.order) order = r.body.order;
    render(FAIL[r.body.error] || (r.body.order ? undefined : 'That did not work — try again.'));
  });

  load();
})();
