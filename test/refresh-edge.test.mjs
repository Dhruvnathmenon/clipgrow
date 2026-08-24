// Edge cases for the chained refresh engine -- the situations that are rare
// individually but certain to happen across many clippers and many runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runChunk, createRefreshJob } from '../src/refresh-jobs.js';

function makeDb({ job, submissions = [], accounts = [], lockedBy = {} } = {}) {
  const state = {
    job: { id: 1, status: 'queued', pending_json: '[]', invocations: 0, clips_fetched: 0,
           clips_failed: 0, clips_skipped: 0, imported: 0, accounts_json: null, ...job },
    submissions: submissions.map(s => ({ ...s })),
    accounts: accounts.map(a => ({ ...a })),
    lockedBy: { ...lockedBy }
  };
  function run(sql, a) {
    if (/^UPDATE refresh_jobs SET status = 'running'/.test(sql)) { state.job.status='running'; state.job.invocations++; return { meta:{changes:1} }; }
    if (/^UPDATE refresh_jobs SET pending_json/.test(sql)) {
      const [p,f,fa,sk,im,aj,st,ts,fin]=a;
      Object.assign(state.job,{pending_json:p,clips_fetched:f,clips_failed:fa,clips_skipped:sk,imported:im,accounts_json:aj,status:st,updated_at:ts,finished_at:fin});
      return { meta:{changes:1} };
    }
    // Accounts in lockedBy are held by a DIFFERENT live job and never yield.
    if (/^UPDATE social_accounts SET active_job_id = \?\s+WHERE id/.test(sql)) {
      const [jobId, accountId] = a;
      if (state.lockedBy[accountId] && state.lockedBy[accountId] !== jobId) return { meta:{changes:0} };
      return { meta:{changes:1} };
    }
    if (/^UPDATE social_accounts SET active_job_id = NULL/.test(sql)) return { meta:{changes:1} };
    if (/^UPDATE submissions SET views/.test(sql) || /^UPDATE submissions SET sync_error/.test(sql)) {
      const id=a[a.length-1]; const s=state.submissions.find(x=>x.id===id);
      if(!s||s.locked_at!=null) return { meta:{changes:0} };
      return { meta:{changes:1} };
    }
    if (/^INSERT INTO ig_api_calls/.test(sql)) return { meta:{} };
    if (/^DELETE FROM ig_api_calls/.test(sql)) return { meta:{} };
    if (/^INSERT INTO refresh_jobs/.test(sql)) return { meta:{ last_row_id: 99 } };
    throw new Error('unhandled run: '+sql);
  }
  function first(sql,a){
    if (/FROM refresh_jobs WHERE id/.test(sql)) return { ...state.job };
    // loadAccount joins in the campaign this account works for, so match the
    // new query shape too and supply the fields it aliases.
    if (/FROM social_accounts/.test(sql)) {
      const acct = state.accounts.find(x => x.id === a[0]) || null;
      return acct ? { ...acct, account_id: acct.id,
                      campaign_id: acct.campaign_id == null ? 1 : acct.campaign_id,
                      allowed_platforms: acct.allowed_platforms || 'instagram,youtube' } : null;
    }
    return null;
  }
  function all(sql,a){
    if (/SELECT id, ig_media_id, last_ok_sync_at FROM submissions/.test(sql))
      return { results: state.submissions.filter(s=>s.account_id===a[0]&&s.status==='active'&&s.locked_at==null&&s.eligible!==0) };
    if (/SELECT ig_media_id FROM submissions WHERE platform/.test(sql)) return { results: [] };
    if (/SELECT called_at FROM ig_api_calls/.test(sql)) return { results: [] };
    if (/FROM participation_accounts pa/.test(sql)) return { results: state.accounts.map(a2=>({
      account_id:a2.id, platform:a2.platform, username:a2.username, status:a2.status,
      auto_import:a2.auto_import, access_token:a2.access_token, connected_at:0 })) };
    throw new Error('unhandled all: '+sql);
  }
  return { _state: state,
    prepare(sql){ let args=[]; const st={bind:(...x)=>{args=x;return st;},run:async()=>run(sql,args),first:async()=>first(sql,args),all:async()=>all(sql,args)}; return st; },
    batch: async(s)=>{const o=[];for(const x of s)o.push(await x.run());return o;} };
}

const acct=(id,o={})=>({ id, platform:'instagram', username:'a'+id, status:'connected',
  access_token:'t', auto_import:0, connected_at:0, active_job_id:null, ...o });
const clipRow=(id,accountId)=>({ id, account_id:accountId, ig_media_id:'m'+id, status:'active',
  locked_at:null, eligible:1, views:0, last_ok_sync_at:null });

const adapters={ instagram:{
  fetchViews: async (a,ids,e,{onAttempt}={})=>{ const m=new Map(); for(const id of ids){ if(onAttempt)onAttempt(); m.set(id,{ok:true,views:1}); } return m; },
  listRecent: async()=>[] } };

test('TWO accounts locked by another job does not spin forever', async () => {
  // pending alternates between two accounts, BOTH held elsewhere. The old
  // deferral moved each blocked account to the end and only stopped when every
  // remaining item shared one account -- with two, that never became true and
  // the invocation looped until the platform killed it.
  const pending=[
    {t:'ig_view',a:1,s:1,m:'m1'},{t:'ig_view',a:1,s:2,m:'m2'},
    {t:'ig_view',a:2,s:3,m:'m3'},{t:'ig_view',a:2,s:4,m:'m4'}
  ];
  const db=makeDb({
    job:{ pending_json: JSON.stringify(pending) },
    submissions:[clipRow(1,1),clipRow(2,1),clipRow(3,2),clipRow(4,2)],
    accounts:[acct(1),acct(2)],
    lockedBy:{ 1: 777, 2: 777 }        // both held by a different live job
  });

  const r = await Promise.race([
    runChunk(db, {}, 1, { adapters }),
    new Promise((_,rej)=>setTimeout(()=>rej(new Error('TIMED OUT -- infinite loop')), 3000))
  ]);

  assert.equal(r.blocked, true, 'reports that it was blocked');
  assert.equal(r.remaining, 4, 'all work preserved for a later invocation');
  assert.equal(r.done, false, 'not marked finished');
});

test('a job with no accounts at all completes immediately instead of hanging', async () => {
  const db=makeDb({ job:{ pending_json:'[]' }, accounts:[] });
  const r=await runChunk(db,{},1,{ adapters });
  assert.equal(r.done, true);
  assert.equal(r.remaining, 0);
  assert.equal(db._state.job.status, 'done');
});

test('one blocked account alongside a free one: the free one still gets done', async () => {
  const pending=[
    {t:'ig_view',a:1,s:1,m:'m1'},   // account 1 is locked elsewhere
    {t:'ig_view',a:2,s:2,m:'m2'}    // account 2 is free
  ];
  const db=makeDb({
    job:{ pending_json: JSON.stringify(pending) },
    submissions:[clipRow(1,1),clipRow(2,2)],
    accounts:[acct(1),acct(2)],
    lockedBy:{ 1: 777 }
  });
  const r=await Promise.race([
    runChunk(db,{},1,{ adapters }),
    new Promise((_,rej)=>setTimeout(()=>rej(new Error('TIMED OUT')),3000))
  ]);
  assert.equal(r.stats.fetched, 1, 'the reachable account was refreshed');
  assert.equal(r.remaining, 1, 'only the blocked item is left');
  assert.equal(r.done, false);
});

test('an account whose clips are ALL already locked contributes no work and is not left "waiting"', async () => {
  // Everything on this account has been paid and locked, so buildAccountItems
  // yields nothing for it. It must still settle as done rather than sitting in
  // the checklist forever as an unstarted row.
  const db=makeDb({ job:{ pending_json:'[]' }, accounts:[acct(1)], submissions:[] });
  const r=await runChunk(db,{},1,{ adapters });
  assert.equal(r.done, true);
  const accts=JSON.parse(db._state.job.accounts_json||'{}');
  for(const v of Object.values(accts)) assert.notEqual(v.state,'waiting');
});

test('a job already marked done is a no-op if a stray queue message redelivers it', async () => {
  // Queues can redeliver; running the tail of a finished job again would
  // double-count stats and re-spend real API calls.
  const db=makeDb({ job:{ status:'done', pending_json:'[]', clips_fetched: 42 } });
  const r=await runChunk(db,{},1,{ adapters });
  assert.equal(r.alreadyFinished, true);
  assert.equal(db._state.job.clips_fetched, 42, 'stats untouched by the replay');
});

test('a YouTube batch that throws marks every clip in that batch failed, not just one', async () => {
  const pending=[{t:'yt_views',a:1,s:[1,2,3],m:['v1','v2','v3']}];
  const db=makeDb({
    job:{ pending_json: JSON.stringify(pending) },
    accounts:[acct(1,{platform:'youtube'})],
    submissions:[clipRow(1,1),clipRow(2,1),clipRow(3,1)]
  });
  const boom={ youtube:{ fetchViews: async()=>{ throw Object.assign(new Error('down'),{code:'NETWORK'}); }, listRecent: async()=>[] } };
  const r=await runChunk(db,{},1,{ adapters: boom });
  assert.equal(r.stats.failed, 3, 'all three clips in the batch counted, not one');
  assert.equal(r.done, true, 'the job still finishes rather than stalling');
});
