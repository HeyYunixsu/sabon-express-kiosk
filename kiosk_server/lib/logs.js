'use strict';
// Reading the machine's own records for the staff tools. Every file here is
// appended by someone else (the controller, the uploader, this server), so a
// line is never trusted: a torn or foreign line is skipped, not fatal.
//
// The staff page polls, so a read is cached until the file changes (size or
// mtime) -- months of payments are not re-parsed every second.

const fs = require('fs');
const path = require('path');

const cache = new Map();   // file -> { size, mtimeMs, rows }

// Returns the cached array: callers filter or slice, never mutate it.
function readJsonl(file) {
  let st;
  try { st = fs.statSync(file); } catch (_) { cache.delete(file); return []; }
  const c = cache.get(file);
  if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.rows;
  let text = '';
  try { text = fs.readFileSync(file, 'utf-8'); } catch (_) { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r === 'object') rows.push(r);
    } catch (_) { /* torn line */ }
  }
  cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, rows });
  return rows;
}

const onDay = (day) => (r) => String((r && r.date_created) || '').startsWith(day);

// Where each record lives: the default inside the checkout, or the config.env
// value -- relative ones against the repo root, the rule the controller's
// resolve_config_path() applies, so both sides read the same file.
function logPaths(config, root) {
  const at = (key, ...dflt) => (config[key] ? path.resolve(root, config[key]) : path.join(root, ...dflt));
  return {
    prices: at('PRICE_LOG', 'logs', 'price_changes.jsonl'),
    primes: at('PRIME_LOG', 'logs', 'prime_events.jsonl'),
    unclaimed: at('UNCLAIMED_LOG', 'logs', 'unclaimed_credits.jsonl'),
    interrupted: at('INTERRUPTED_LOG', 'logs', 'interrupted_sales.jsonl'),
    salesArchive: at('SALES_ARCHIVE_DIR', 'logs', 'sales'),
    transactions: at('TRANSACTION_DIR', 'transaction'),
  };
}

// Sale files are pretty-printed multi-line JSON (controller/src/transaction.cpp),
// so they cannot go through readJsonl's line-based cache -- but a sale file
// never changes once written, so once parsed it is kept here for good, keyed
// by its full path. Only new paths get read; a path no longer in the
// directory is dropped (uploaded and archived, or removed).
const txnCache = new Map();   // full path -> parsed record

// Today's sales per slot: what the cloud has confirmed (the uploader's monthly
// archive) plus what is still waiting to upload (the transaction directory).
// A sale is in one or the other: the uploader archives it, then deletes it.
// ponytail: a sale caught between those two steps counts twice for a moment.
function salesToday(p, day) {
  const rows = readJsonl(path.join(p.salesArchive, `sales-${day.slice(0, 7)}.jsonl`)).filter(onDay(day));
  let names = [];
  try { names = fs.readdirSync(p.transactions).filter((n) => n.endsWith('.json')); } catch (_) { /* none yet */ }
  const present = new Set();
  for (const n of names) {
    const full = path.join(p.transactions, n);
    present.add(full);
    if (txnCache.has(full)) continue;
    try {
      txnCache.set(full, JSON.parse(fs.readFileSync(full, 'utf-8')));
    } catch (_) { /* being written or uploaded right now; retry next call */ }
  }
  for (const full of txnCache.keys()) {
    if (path.dirname(full) === p.transactions && !present.has(full)) txnCache.delete(full);
  }
  for (const [full, r] of txnCache) {
    if (path.dirname(full) === p.transactions && onDay(day)(r)) rows.push(r);
  }
  const bySlot = {};
  let presses = 0;
  let amount = 0;
  for (const r of rows) {
    const slot = Number(r.slot);
    const a = Number(r.amount) || 0;
    const s = bySlot[slot] || (bySlot[slot] = { presses: 0, amount: 0 });
    s.presses++;
    s.amount += a;
    presses++;
    amount += a;
  }
  return { bySlot, presses, amount };
}

// The controller writes no id for a credit; its own time, slot and qty are one.
const creditId = (r) => `${r.date_created}|${r.slot}|${r.qty}`;
const SETTLING = new Set(['credit_give_back', 'credit_write_off']);

// Paid-for presses never poured (UNCLAIMED_LOG), from sinceDay on, that no
// staff member has given back or written off yet. Newest first.
function openCredits(unclaimedRows, staffRows, sinceDay) {
  const settled = new Set(staffRows.filter((e) => SETTLING.has(e.event)).map((e) => e.credit));
  return unclaimedRows
    .filter((r) => String(r.date_created || '') >= sinceDay && !settled.has(creditId(r)))
    .map((r) => ({
      id: creditId(r), slot: Number(r.slot), qty: Number(r.qty),
      amount: Number(r.amount) || 0, reason: r.reason, date_created: r.date_created,
    }))
    .filter((c) => Number.isInteger(c.slot) && c.slot >= 1 && c.slot <= 6 && Number.isInteger(c.qty) && c.qty > 0)
    .reverse();
}

module.exports = { readJsonl, logPaths, salesToday, openCredits, creditId };
