'use strict';
// Clock times on the staff dashboard: 12-hour with AM/PM, like the kiosk's
// own header clock ("2:24 PM"). Loaded by the page before staff.js, and
// required by the tests.

(function (root) {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => String(n).padStart(2, '0');

  // clock12(13, 31) -> '1:31 PM'; with seconds, '1:31:07 PM'.
  function clock12(h, m, s) {
    const t = `${h % 12 || 12}:${pad(m)}${s === undefined ? '' : `:${pad(s)}`}`;
    return `${t} ${h < 12 ? 'AM' : 'PM'}`;
  }

  // The logs' 'YYYY-MM-DD HH:MM:SS' as numbers, or null.
  function parts(str) {
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(String(str || ''));
    return m ? m.slice(1).map(Number) : null;
  }

  // '2026-09-30 13:31:00' -> '1:31 PM'
  function timeOf(str) {
    const p = parts(str);
    return p ? clock12(p[3], p[4]) : '';
  }

  // '2026-09-28 10:36:00' -> 'Sep 28 · 10:36 AM'
  function dateTimeOf(str) {
    const p = parts(str);
    return p ? `${MONTHS[p[1] - 1]} ${p[2]} · ${clock12(p[3], p[4])}` : '';
  }

  const api = { clock12, timeOf, dateTimeOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StaffTime = api;
})(this);
