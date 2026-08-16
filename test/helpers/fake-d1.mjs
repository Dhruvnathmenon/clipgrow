// A minimal in-memory stand-in for the subset of the D1 API this project's
// budget/sync logic actually uses (prepare/bind/all/first/run, db.batch).
// Not a general SQL engine -- each table is a plain array of row objects and
// query handling is purpose-built per call shape used by rate-budget.js and
// earnings.js's planInstagramSync. Good enough to prove the real logic
// against real (if simplified) storage, without needing a live D1 binding.

export function makeFakeD1() {
  const tables = { ig_api_calls: [] };
  let nextId = 1;

  function run(sql, args) {
    if (/^INSERT INTO ig_api_calls/.test(sql)) {
      const [social_account_id, called_at] = args;
      tables.ig_api_calls.push({ id: nextId++, social_account_id, called_at });
      return { meta: { last_row_id: nextId - 1 } };
    }
    if (/^DELETE FROM ig_api_calls WHERE social_account_id = \? AND called_at < \?/.test(sql)) {
      const [accountId, before] = args;
      tables.ig_api_calls = tables.ig_api_calls.filter(r => !(r.social_account_id === accountId && r.called_at < before));
      return { meta: {} };
    }
    throw new Error('fake-d1: unhandled run() query: ' + sql);
  }

  function all(sql, args) {
    if (/^SELECT called_at FROM ig_api_calls WHERE social_account_id = \? AND called_at > \?/.test(sql)) {
      const [accountId, since] = args;
      const rows = tables.ig_api_calls
        .filter(r => r.social_account_id === accountId && r.called_at > since)
        .sort((a, b) => a.called_at - b.called_at)
        .map(r => ({ called_at: r.called_at }));
      return { results: rows };
    }
    throw new Error('fake-d1: unhandled all() query: ' + sql);
  }

  return {
    prepare(sql) {
      let boundArgs = [];
      const statement = {
        bind: (...args) => { boundArgs = args; return statement; },
        all: async () => all(sql, boundArgs),
        first: async () => { const r = await all(sql, boundArgs); return (r.results || [])[0] || null; },
        run: async () => run(sql, boundArgs)
      };
      return statement;
    },
    async batch(stmts) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
    _tables: tables
  };
}
