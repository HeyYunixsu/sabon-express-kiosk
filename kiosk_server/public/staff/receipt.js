'use strict';
// The receipt for an order, as the customer (kiosk, Pay at the counter) and
// the cashier (staff page, the cash pop-up) see it -- and as a receipt
// printer would print it if one is ever added. One renderer so the two
// screens always match. Plain browser script: window.Receipt.
(function () {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
  const peso = (n) => '₱' + n;

  // "2026-10-02 14:14:05" -> ["Oct 2, 2026", "2:14 PM"]
  function when(stamp) {
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(String(stamp || ''));
    if (!m) return ['', ''];
    const h = Number(m[4]);
    return [`${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`, `${h % 12 || 12}:${m[5]} ${h < 12 ? 'AM' : 'PM'}`];
  }

  function html(o, kioskName) {
    const [day, time] = when(o.created);
    const qr = o.method === 'qr';
    const rows = o.items.map((i) =>
      `<div class="rc-row"><span>${esc(i.name)} x${i.qty}</span><span>${peso(i.price * i.qty)}</span></div>`).join('');
    return `<div class="rcpt">
      <div class="rc-c rc-big">SABON EXPRESS</div>
      <div class="rc-c">${esc(kioskName || 'Kiosk')} · Self-service refill</div>
      <div class="rc-hr"></div>
      <div class="rc-row"><span>ORDER</span><b>${esc(o.number)}</b></div>
      <div class="rc-row"><span>${day}</span><span>${time}</span></div>
      <div class="rc-hr"></div>
      ${rows}
      <div class="rc-hr"></div>
      <div class="rc-row rc-tot"><span>TOTAL</span><span>${peso(o.amount)}</span></div>
      <div class="rc-row"><span>Payment</span><span>${qr ? 'QR' : 'CASH'}</span></div>
      <div class="rc-hr"></div>
      <div class="rc-c">${qr ? 'Scan to pay' : 'Pay at the counter'}</div>
      <div class="rc-c">Thank you!</div>
    </div>`;
  }

  // esc/peso are shared too: kiosk.js and staff.js reuse these instead of
  // keeping their own copies (receipt.js loads first on both pages).
  window.Receipt = { html, when, esc, peso };
})();
