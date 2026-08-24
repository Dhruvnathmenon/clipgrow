// Purpose-built in-memory D1 stand-in for payouts.js + the slice of
// earnings.js's allocateCampaignEarnings it calls into (via reallocateCampaign).
// Not a general SQL engine -- same philosophy as fake-d1.mjs: real tables as
// plain arrays, query handling matched by shape to the actual queries these
// modules issue, so the real logic runs against real (if simplified) storage.

export function makePayoutsDb({ campaigns = [], submissions = [], participations = [], socialAccounts = [], payments = [] } = {}) {
  const state = {
    campaigns: campaigns.map(c => ({ ...c })),
    submissions: submissions.map(s => ({ ...s })),
    participations: participations.map(p => ({ ...p })),
    social_accounts: socialAccounts.map(a => ({ ...a })),
    payments: payments.map(p => ({ ...p }))
  };
  let nextPaymentId = (payments.reduce((max, p) => Math.max(max, p.id || 0), 0)) + 1;

  function campaignById(id) { return state.campaigns.find(c => c.id === id) || null; }
  function subById(id) { return state.submissions.find(s => s.id === id) || null; }

  function all(sql, args) {
    // payableClips
    if (/FROM submissions s\s+JOIN campaigns c ON c\.id = s\.campaign_id\s+LEFT JOIN social_accounts/.test(sql)) {
      const clipperId = args[0];
      const since = args[1];
      let campaignId = null;
      if (/AND s\.campaign_id = \?/.test(sql)) campaignId = args[2];
      const rows = state.submissions
        .filter(s => s.clipper_id === clipperId)
        .filter(s => (s.posted_at || s.created_at) >= since)
        .filter(s => campaignId == null || s.campaign_id === campaignId)
        .map(s => {
          const c = campaignById(s.campaign_id);
          const acc = state.social_accounts.find(a => a.id === s.account_id);
          const pay = s.payment_id ? state.payments.find(p => p.id === s.payment_id) : null;
          return {
            ...s,
            campaign_id: c.id, campaign_name: c.name, cpm: c.cpm, min_views: c.min_views, blueprint_json: c.blueprint_json,
            account_username: acc ? acc.username : null,
            payment_reference: pay ? pay.reference : null, payment_paid_at: pay ? pay.paid_at : null
          };
        })
        .sort((a, b) => (b.posted_at || b.created_at) - (a.posted_at || a.created_at));
      return { results: rows };
    }
    // settlePayment's lookup of the clips being settled
    if (/^SELECT id, clipper_id, campaign_id, earning, status, locked_at\s+FROM submissions WHERE id IN/.test(sql)) {
      const ids = args.map(Number);
      return { results: state.submissions.filter(s => ids.includes(s.id)).map(s => ({ ...s })) };
    }
    // reversePayment's lookup of what a payment locked
    if (/^SELECT id, campaign_id FROM submissions WHERE payment_id = \?/.test(sql)) {
      return { results: state.submissions.filter(s => s.payment_id === args[0]).map(s => ({ id: s.id, campaign_id: s.campaign_id })) };
    }
    // writeOffAllBelowMin's sweep
    if (/^SELECT s\.id, s\.campaign_id FROM submissions s\s+JOIN campaigns c/.test(sql)) {
      let i = 0;
      let campaignId = null, clipperId = null;
      if (/AND s\.campaign_id = \?/.test(sql)) campaignId = args[i++];
      if (/AND s\.clipper_id = \?/.test(sql)) clipperId = args[i++];
      const rows = state.submissions.filter(s => {
        const c = campaignById(s.campaign_id);
        if (!c) return false;
        if (s.locked_at) return false;
        if (s.status !== 'active') return false;
        if (s.eligible === 0) return false;
        if (!s.last_ok_sync_at) return false;
        if (!(c.min_views > 0)) return false;
        if (!(s.views < c.min_views)) return false;
        const cutoff = s.posted_at != null ? s.posted_at : s.created_at;
        const hadPriorPayout = state.payments.some(p =>
          p.clipper_id === s.clipper_id &&
          (p.campaign_id === s.campaign_id || p.campaign_id == null) &&
          p.paid_at >= cutoff
        );
        if (!hadPriorPayout) return false;
        if (campaignId != null && s.campaign_id !== campaignId) return false;
        if (clipperId != null && s.clipper_id !== clipperId) return false;
        return true;
      }).map(s => ({ id: s.id, campaign_id: s.campaign_id }));
      return { results: rows };
    }
    // allocateCampaignEarnings' own submissions query
    if (/FROM submissions s\s+LEFT JOIN participations p/.test(sql)) {
      const campaignId = args[0];
      const rows = state.submissions
        .filter(s => s.campaign_id === campaignId)
        .map(s => {
          const part = state.participations.find(p => p.clipper_id === s.clipper_id && p.campaign_id === s.campaign_id);
          return {
            id: s.id, views: s.views, earning: s.earning, locked_at: s.locked_at, locked_earning: s.locked_earning,
            eligible: s.eligible, sub_status: s.status, part_status: part ? part.status : 'active'
          };
        })
        .sort((a, b) => a.id - b.id);
      return { results: rows };
    }
    throw new Error('fake-payouts-db: unhandled all() query: ' + sql);
  }

  function first(sql, args) {
    if (/^SELECT \* FROM campaigns WHERE id = \?/.test(sql)) {
      return campaignById(args[0]);
    }
    if (/^SELECT \* FROM payments WHERE id = \?/.test(sql)) {
      return state.payments.find(p => p.id === args[0]) || null;
    }
    throw new Error('fake-payouts-db: unhandled first() query: ' + sql);
  }

  function run(sql, args) {
    if (/^INSERT INTO payments/.test(sql)) {
      const [clipper_id, campaign_id, amount, method, reference, note, paid_at, created_at, clip_count, clips_total] = args;
      const row = { id: nextPaymentId++, clipper_id, campaign_id, amount, method, reference, note, paid_at, created_at, clip_count, clips_total };
      state.payments.push(row);
      return { meta: { last_row_id: row.id } };
    }
    if (/^UPDATE submissions SET locked_at = \?, locked_earning = \?, lock_reason = 'paid', payment_id = \?/.test(sql)) {
      const [locked_at, locked_earning, payment_id, id] = args;
      const s = subById(id);
      // Report a real change count: the "AND locked_at IS NULL" guard means an
      // already-locked clip matches zero rows, and settlePayment relies on that
      // to detect a concurrent settle.
      if (s && !s.locked_at) {
        Object.assign(s, { locked_at, locked_earning, lock_reason: 'paid', payment_id });
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    if (/^UPDATE submissions SET locked_at = \?, locked_earning = 0, lock_reason = 'below_min', earning = 0/.test(sql)) {
      const [locked_at, id] = args;
      const s = subById(id);
      if (s && !s.locked_at) {
        Object.assign(s, { locked_at, locked_earning: 0, lock_reason: 'below_min', earning: 0 });
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    if (/^UPDATE submissions SET locked_at = NULL, locked_earning = NULL, lock_reason = NULL, payment_id = NULL/.test(sql)) {
      const paymentId = args[0];
      for (const s of state.submissions) {
        if (s.payment_id === paymentId) Object.assign(s, { locked_at: null, locked_earning: null, lock_reason: null, payment_id: null });
      }
      return { meta: {} };
    }
    if (/^DELETE FROM payments WHERE id = \?/.test(sql)) {
      state.payments = state.payments.filter(p => p.id !== args[0]);
      return { meta: {} };
    }
    if (/^UPDATE submissions SET earning = \? WHERE id = \?/.test(sql)) {
      const [earning, id] = args;
      const s = subById(id);
      if (s) s.earning = earning;
      return { meta: {} };
    }
    if (/^UPDATE campaigns SET status = 'budget_full' WHERE id = \?/.test(sql)) {
      const c = campaignById(args[0]); if (c) c.status = 'budget_full';
      return { meta: {} };
    }
    if (/^UPDATE campaigns SET status = 'active' WHERE id = \?/.test(sql)) {
      const c = campaignById(args[0]); if (c) c.status = 'active';
      return { meta: {} };
    }
    throw new Error('fake-payouts-db: unhandled run() query: ' + sql);
  }

  return {
    prepare(sql) {
      let boundArgs = [];
      const statement = {
        bind: (...a) => { boundArgs = a; return statement; },
        all: async () => all(sql, boundArgs),
        first: async () => first(sql, boundArgs),
        run: async () => run(sql, boundArgs)
      };
      return statement;
    },
    async batch(stmts) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
    _state: state
  };
}
