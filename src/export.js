import { clipState } from './clipstate.js';

// CSV backup of the books.
//
// The whole point is that this file still answers "what did we pay, to whom,
// for which videos?" when the site itself is unavailable -- so it is generated
// live from D1 (never a stored file that can drift) and deliberately contains
// the raw dates and amounts rather than anything computed for display.

/**
 * A leading apostrophe, tab, or the =+-@ characters make Excel and Sheets
 * evaluate a cell as a formula. Values here come from Instagram usernames and
 * admin-entered notes, so they are prefixed to stay inert on open.
 */
function cell(value) {
  if (value == null) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers, rows) {
  const out = [headers.map(cell).join(',')];
  for (const row of rows) out.push(row.map(cell).join(','));
  // BOM so Excel opens UTF-8 (rupee signs, non-ASCII handles) correctly.
  return '﻿' + out.join('\r\n') + '\r\n';
}

function isoDate(ts) {
  return ts ? new Date(Number(ts)).toISOString().replace('T', ' ').slice(0, 19) : '';
}

export async function exportClipsCsv(db) {
  const { results } = await db.prepare(
    `SELECT s.id, s.permalink, s.views, s.earning, s.status, s.source, s.sync_error,
            s.created_at, s.posted_at, s.last_ok_sync_at,
            s.locked_at, s.locked_earning, s.lock_reason,
            c.name AS campaign_name, c.cpm, c.min_views,
            cl.username AS clipper_username, cl.display_name AS clipper_name,
            a.username AS account_username,
            pay.id AS payment_id, pay.reference AS payment_reference,
            pay.paid_at AS payment_paid_at, pay.method AS payment_method
     FROM submissions s
     JOIN campaigns c ON c.id = s.campaign_id
     JOIN clippers cl ON cl.id = s.clipper_id
     LEFT JOIN social_accounts a ON a.id = s.account_id
     LEFT JOIN payments pay ON pay.id = s.payment_id
     ORDER BY c.name ASC, cl.username ASC, COALESCE(s.posted_at, s.created_at) ASC`
  ).all();

  const headers = [
    'Campaign', 'Clipper', 'Clipper username', 'Instagram account', 'Clip URL',
    'Posted at', 'Synced to ClipGrow', 'Views last updated',
    'Views', 'Campaign CPM', 'Min views', 'Clip state',
    'Earning', 'Settled amount', 'Payment status', 'Locked at', 'Lock reason',
    'Payment ID', 'Payment reference', 'Payment method', 'Paid at', 'Source'
  ];

  const rows = (results || []).map(r => {
    const state = clipState(r);
    const paymentStatus = r.locked_at
      ? (r.lock_reason === 'paid' ? 'PAID' : 'CLOSED (below minimum)')
      : (r.earning > 0 ? 'PENDING' : 'NOT YET EARNING');
    return [
      r.campaign_name, r.clipper_name || r.clipper_username, r.clipper_username,
      r.account_username ? '@' + r.account_username : '', r.permalink,
      isoDate(r.posted_at), isoDate(r.created_at), isoDate(r.last_ok_sync_at),
      r.views, r.cpm, r.min_views, state,
      r.earning, r.locked_at ? (r.locked_earning || 0) : '', paymentStatus,
      isoDate(r.locked_at), r.lock_reason || '',
      r.payment_id || '', r.payment_reference || '', r.payment_method || '',
      isoDate(r.payment_paid_at), r.source || 'manual'
    ];
  });

  return toCsv(headers, rows);
}

export async function exportPaymentsCsv(db) {
  const { results } = await db.prepare(
    `SELECT p.*, cl.username AS clipper_username, cl.display_name AS clipper_name,
            c.name AS campaign_name,
            (SELECT COUNT(*) FROM submissions s WHERE s.payment_id = p.id) AS locked_clips
     FROM payments p
     JOIN clippers cl ON cl.id = p.clipper_id
     LEFT JOIN campaigns c ON c.id = p.campaign_id
     ORDER BY p.paid_at DESC`
  ).all();

  const headers = [
    'Payment ID', 'Paid at', 'Clipper', 'Clipper username', 'Campaign',
    'Amount paid', 'Clips settled', 'Clips total earned', 'Variance',
    'Method', 'Reference', 'Note', 'Recorded at'
  ];

  const rows = (results || []).map(r => [
    r.id, isoDate(r.paid_at), r.clipper_name || r.clipper_username, r.clipper_username,
    r.campaign_name || 'All campaigns',
    r.amount, r.locked_clips, r.clips_total || 0, (r.amount || 0) - (r.clips_total || 0),
    r.method || '', r.reference || '', r.note || '', isoDate(r.created_at)
  ]);

  return toCsv(headers, rows);
}
