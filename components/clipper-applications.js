/* Clipper side of campaign onboarding: the campaign list, and per campaign the
   step tracker, reference material, and the video submission (Step 1).

   Standalone on purpose. It knows nothing about dashboard.html -- the host page
   hands it an `api(path, opts)` function (the page's own, which already handles
   401s) and an `onConnect(campaign)` callback for Step 2, which stays the
   existing connect-account flow.

     CGApps.clipper.mount(el, { api, onConnect })

   Every state on screen comes from GET /api/clipper/campaigns/:id/applications
   (applicationState in src/applications.js), so what the clipper is told can
   never disagree with what the server will accept. */
(function () {
  'use strict';
  const MAX_ATTEMPTS = 3;
  const ALLOWED_EXT = { mp4: 'video/mp4', mov: 'video/quicktime' };   // what the server accepts (ALLOWED_MIME in src/drive.js)

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  const mb = b => b < 1048576 ? Math.max(1, Math.round(b / 1024)) + ' KB'
    : (b / 1048576 >= 100 ? Math.round(b / 1048576) : (b / 1048576).toFixed(1)) + ' MB';
  const safeUrl = u => (/^https?:\/\//i.test(String(u || '')) ? String(u) : '');
  const ago = ts => {
    const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    if (m < 1440) return Math.round(m / 60) + ' h ago';
    return Math.round(m / 1440) + ' d ago';
  };
  function gradient(name) {
    let h = 0;
    for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return `linear-gradient(135deg,hsl(${h},60%,32%),hsl(${(h + 50) % 360},65%,22%))`;
  }

  /* The one place that turns raw server state into what the clipper sees:
     `tone` colours the badge on the cover, `head`/`sub` are the bold status line
     and its caption on the card, `pill` is the compact form used on the page. */
  function view(c) {
    const part = c.participation;
    const app = c.application || null;
    const r = (key, tone, head, sub, extra) => Object.assign({ key, tone, head, sub, pill: [tone === 't-ok' ? 'pill-ok' : tone === 't-warn' ? 'pill-review' : tone === 't-dead' ? 'pill-dead' : 'pill-open', head] }, extra);
    if (part && part.status === 'kicked') {
      return r('removed', 't-dead', 'Removed', 'Contact the ClipGrow admin', { dead: true, note: part.note || 'You were removed from this campaign. Contact the ClipGrow admin.' });
    }
    if (app && app.state === 'exhausted') {
      return r('exhausted', 't-dead', 'Failed 3 times', `Failed ${MAX_ATTEMPTS} times, so you can't join this campaign`, { dead: true });
    }
    if (c.status === 'completed') return r('ended', '', 'Ended', 'This campaign is over');
    // A full budget closes the campaign to anyone who has not yet been approved
    // (the server refuses their video). Say so on the card instead of letting
    // them open a page whose only button will fail. Reversible: the campaign
    // reopens if budget is added, and the card follows.
    if (c.status === 'budget_full' && !(app && app.state === 'approved') && !(part && Object.keys(part.accounts || {}).length)) {
      return r('full', '', 'Budget full', 'Closed to new clippers for now', { dead: true, note: 'The budget for this campaign is fully allocated. It reopens if more budget is added.' });
    }
    if (!part) return r('open', '', 'Open to join', 'Free to join · a quick video review comes first');
    const connected = Object.keys(part.accounts || {}).length > 0;
    if (connected) return r('live', 't-ok', 'Live', c.my_stats ? `${money(c.my_stats.earned)} earned so far` : 'Your account is connected');
    if (!app) return r('loading', '', 'Checking…', '');
    if (app.state === 'approved') return r('approved', 't-ok', 'Approved', 'Step 2 of 3 · connect your account');
    if (app.state === 'pending') return r('pending', 't-warn', 'Waiting for review', 'Step 1 of 3 · a reviewer will get to it');
    if (app.state === 'rejected') {
      const l = app.attempts_left;
      return r('rejected', 't-warn', 'Changes needed', `${l} ${l === 1 ? 'try' : 'tries'} left`, { note: 'A reviewer left feedback on your video. Open the campaign to read it.' });
    }
    return r('start', 't-warn', 'Submit your video', `Step 1 of 3 · ${MAX_ATTEMPTS} tries`);
  }

  /* The cover: an uploaded image when the campaign has one, otherwise a
     generated face so a campaign without art still looks intentional. The image
     sits over the generated face, so a broken URL falls back instead of
     showing a broken-image icon. */
  function face(c, inner, badge) {
    const initials = String(c.name || '?').split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
    const u = String(c.cover_url || '');
    // http(s), a same-origin path (how the real cover route will be served), or an inline image.
    const img = (safeUrl(u) || /^\/[^/]/.test(u) || /^data:image\//i.test(u)) ? `<img src="${esc(u)}" alt="" loading="lazy" decoding="async">` : '';
    return `<div class="tc-face" style="background:${gradient(c.name)}"><div class="tc-art" aria-hidden="true">${esc(initials)}</div>${img}<div class="tc-shade"></div>${badge}${inner}</div>`;
  }

  function mount(el, opts) {
    const api = opts.api;
    const onConnect = opts.onConnect || (() => {});
    // Whether the clipper still has to connect Discord, read live from the host so
    // it is current the moment they come back from Discord.
    const discordState = opts.discord || (() => null);
    // The host page can hand over the campaign list it already fetched, so the
    // first paint does not cost a second identical request.
    let initial = opts.initial || null;
    el.classList.add('cga');
    let campaigns = [];
    let openId = null;
    // The upload in flight, kept here so a re-render mid-upload cannot orphan it.
    let upload = null;

    async function load() {
      el.innerHTML = '<div class="cg-empty">Loading campaigns…</div>';
      const data = initial || await api('/api/clipper/campaigns');
      initial = null;
      campaigns = data.campaigns || [];
      // Joined campaigns need their review state for the card badge. Fetched in
      // parallel, and only for campaigns the clipper is actually in.
      await Promise.all(campaigns.filter(c => c.participation && !c.application).map(async c => {
        try { c.application = await api(`/api/clipper/campaigns/${c.id}/applications`); } catch (e) { c.application = null; }
      }));
      render();
      if (opts.onData) opts.onData(campaigns);
    }

    function render() {
      const c = campaigns.find(x => x.id === openId);
      el.innerHTML = c ? detail(c) : list();
      bind(c);
      // Lets the host hide page furniture (connected accounts, etc.) that only
      // belongs next to the campaign list.
      if (opts.onView) opts.onView(c ? 'detail' : 'list');
    }

    /* ---------------------------------------------------------------- list */
    function list() {
      if (!campaigns.length) return '<div class="cg-empty">No campaigns are open right now. Check back soon.</div>';
      return '<div class="tc-list">' + campaigns.map(c => {
        const v = view(c);
        const pct = c.budget > 0 ? Math.min(100, Math.round((c.spent / c.budget) * 100)) : 0;
        const plats = (c.allowed_platforms || []).map(p => `<span class="tc-plat p-${esc(p)}"><i></i>${esc(p)}</span>`).join('');
        const badge = `<span class="tc-badge ${v.tone}">${esc(v.head)}</span>`;
        const cap = `<div class="tc-cap"><div><h3>${esc(c.name)}</h3><p>${money(c.cpm)} per 1K views</p></div>
          ${v.dead ? '' : '<span class="tc-go">Open <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span>'}</div>`;
        return `<article class="tc ${v.dead ? 'is-dead' : 'is-live'}" data-open="${c.id}"
                     ${v.dead ? 'aria-disabled="true"' : 'role="button" tabindex="0"'} aria-label="${esc(c.name)} — ${esc(v.head)}">
          ${face(c, cap, badge)}
          <div class="tc-body">
            <div class="tc-row">
              <div><p class="tc-status">${esc(v.head)}</p><p class="tc-sub">${esc(v.sub)}</p></div>
              <div class="tc-plats">${plats}</div>
            </div>
            <div class="tc-rule"></div>
            <div class="tc-stats">
              <div class="tc-stat"><b>${money(c.cpm)}</b><span>Per 1K views</span></div>
              <div class="tc-stat"><b>${money(c.remaining)}</b><span>Budget left</span></div>
              <div class="tc-stat"><b>${c.min_views ? Number(c.min_views).toLocaleString('en-IN') : 'None'}</b><span>Min views</span></div>
            </div>
            <div class="tc-meter"><div class="cg-bar"><i style="width:${pct}%"></i></div><em>${pct}% paid</em></div>
            ${v.note ? `<p class="tc-note ${v.dead ? 'n-dead' : 'n-warn'}">${esc(v.note)}</p>` : ''}
          </div>
        </article>`;
      }).join('') + '</div>';
    }

    /* -------------------------------------------------------------- detail */
    function stepper(v) {
      const s1 = v.key === 'approved' || v.key === 'live' ? 'done' : 'on';
      const s2 = v.key === 'live' ? 'done' : (v.key === 'approved' ? 'on' : '');
      const sub = (k, on, done) => done ? 'Done' : (on ? 'You are here' : 'Locked');
      return `<div class="cg-steps">
        <div class="step ${s1}"><div class="step-n">Step 1</div><div class="step-t">Video review</div><div class="step-s">${sub(1, s1 === 'on', s1 === 'done')}</div></div>
        <div class="step ${s2}"><div class="step-n">Step 2</div><div class="step-t">Connect your account</div><div class="step-s">${sub(2, s2 === 'on', s2 === 'done')}</div></div>
      </div>`;
    }

    function dots(app) {
      const used = app ? app.rejections : 0;
      const pending = app && app.state === 'pending';
      let d = '';
      for (let i = 0; i < MAX_ATTEMPTS; i++) d += `<i class="dot ${i < used ? 'used' : (i === used && pending ? 'now' : '')}"></i>`;
      const left = app ? app.attempts_left : MAX_ATTEMPTS;
      return `<div class="attempts" aria-label="${used} of ${MAX_ATTEMPTS} attempts failed">${d}
        <span class="attempts-t">${used} of ${MAX_ATTEMPTS} failed${left > 0 ? ` · ${left} ${left === 1 ? 'try' : 'tries'} left` : ''}</span></div>`;
    }

    const KIND = { drive: 'Google Drive', instagram: 'Instagram', youtube: 'YouTube', tiktok: 'TikTok', x: 'X', facebook: 'Facebook', twitch: 'Twitch', snapchat: 'Snapchat' };
    // Which platform a stored link points at, for the tag on its card. Derived
    // from the host so links saved before references accepted social pages
    // still read correctly.
    const kindOf = url => {
      let h = '';
      try { h = new URL(url).hostname.toLowerCase(); } catch (e) { return ''; }
      const has = b => h === b || h.endsWith('.' + b);
      if (has('drive.google.com')) return 'Google Drive';
      if (has('instagram.com')) return 'Instagram';
      if (has('youtube.com') || has('youtu.be')) return 'YouTube';
      if (has('tiktok.com')) return 'TikTok';
      if (has('x.com') || has('twitter.com')) return 'X';
      if (has('facebook.com') || has('fb.watch')) return 'Facebook';
      if (has('twitch.tv')) return 'Twitch';
      if (has('snapchat.com')) return 'Snapchat';
      return '';
    };
    const linkCard = (label, tag, url) => {
      const u = safeUrl(url);
      return u ? `<a class="src" href="${esc(u)}" target="_blank" rel="noopener noreferrer"><span>${esc(label)}${tag ? ` <span class="cg-muted" style="font-size:.75rem">· ${esc(tag)}</span>` : ''}</span><span>Open ↗</span></a>` : '';
    };

    /* What the campaign is about: shown to everyone, including before they
       join -- this is the page they decide from. Only fields the admin actually
       filled in are drawn; a value that is a link becomes one. */
    function about(c) {
      const bp = c.blueprint || {};
      const rows = [];
      const add = (k, v) => {
        const t = String(v == null ? '' : v).trim();
        if (!t) return;
        const u = safeUrl(t);
        rows.push(`<div class="cg-row"><div class="cg-k">${esc(k)}</div><div class="cg-v">${u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(t)}</a>` : esc(t)}</div></div>`);
      };
      add('Objective', bp.objective);
      add('Brand guidelines', bp.guidelines);
      add('Call to action', bp.cta);
      add('Tags', bp.tags);
      if (bp.max_payout) add('Max payout per video', money(bp.max_payout));
      if (c.min_views) add('Minimum views to earn', Number(c.min_views).toLocaleString('en-IN'));
      const rules = c.description ? `<ul class="rules">${String(c.description).split(/\n+/).filter(Boolean).map(l => `<li>${esc(l)}</li>`).join('')}</ul>` : '';
      if (!rows.length && !rules) return '';
      return `<div class="cg-panel"><h3>About this campaign</h3>${rows.join('')}${rules ? `<div style="margin-top:.7rem">${rules}</div>` : ''}</div>`;
    }

    /* Working material -- only once the clipper has joined. The reference
       videos are what to aim for, the raw footage is what to make it from; the
       server also withholds both from anyone who has not joined. */
    function reference(c) {
      const refs = (c.reference_links || []).map((u, i, all) => linkCard(all.length > 1 ? `Reference video ${i + 1}` : 'Reference video', kindOf(u), u)).join('');
      const raw = (c.raw_sources || []).map(r => linkCard(r.label || (KIND[r.kind] || 'Source') + ' footage', KIND[r.kind] || '', r.url)).join('');
      return (refs ? `<div class="cg-panel"><h3>Reference — what a good clip looks like</h3><div class="sub">Watch these before you make yours.</div>${refs}</div>` : '')
        + (raw ? `<div class="cg-panel"><h3>Raw footage — clip from these</h3><div class="sub">Download from the official pages or the Drive folder, then make your edit.</div>${raw}</div>` : '');
    }

    function feedback(app) {
      const last = (app.history || []).find(h => h.status === 'rejected');
      if (!last || app.state !== 'rejected') return '';
      return `<div class="feedback" role="alert">
        <div class="fb-h">Not approved — attempt ${last.attempt} of ${MAX_ATTEMPTS}</div>
        <div class="fb-t">${esc(last.reviewer_note || 'No reason was given.')}</div>
        <div class="fb-by">${last.reviewer_name ? 'From ' + esc(last.reviewer_name) + ' · ' : ''}${last.reviewed_at ? ago(last.reviewed_at) : ''}</div>
      </div>`;
    }

    function submitPanel(app) {
      const attempt = app.rejections + 1;
      const final = app.attempts_left === 1;
      return `<div class="cg-panel" id="cga-submit">
        <h3>${app.state === 'rejected' ? 'Fix it and send again' : 'Submit your video'}</h3>
        <div class="sub">Attempt ${attempt} of ${MAX_ATTEMPTS}. A reviewer will approve it or tell you exactly what to change.</div>
        ${final ? '<div class="warn-final">This is your last try. If it is rejected you will be removed from this campaign.</div>' : ''}
        <div id="cga-file"></div>
        <div class="drop" id="cga-drop" tabindex="0" role="button" aria-label="Choose a video file">
          <b>Drop your video here</b> or click to choose
          <div class="hint">MP4 or MOV · up to <span id="cga-max">500 MB</span> · it is uploaded securely and deleted once reviewed</div>
          <input type="file" id="cga-input" accept="video/mp4,video/quicktime,.mp4,.mov" hidden>
        </div>
        <details style="margin-top:.8rem"><summary class="cg-muted" style="cursor:pointer;font-size:.8rem">Can't upload? Paste a link instead</summary>
          <input class="linkfield" id="cga-link" placeholder="https://drive.google.com/…" inputmode="url" autocomplete="off">
        </details>
        <div class="err" id="cga-err" role="alert" hidden></div>
        <div class="row-actions"><button class="cg-btn cg-btn-primary" id="cga-send" disabled>Send for review</button></div>
      </div>`;
    }

    function history(app) {
      const rows = (app.history || []).filter(h => h.status === 'rejected');
      if (rows.length < 2) return '';
      return `<div class="cg-panel"><h3>Earlier attempts</h3><ol class="hist" style="margin-top:.6rem">${rows.map(h =>
        `<li><b>Attempt ${h.attempt}</b> — ${esc(h.reviewer_note || 'No reason given')}</li>`).join('')}</ol></div>`;
    }

    function detail(c) {
      const v = view(c);
      const app = c.application || { state: 'none', rejections: 0, attempts_left: MAX_ATTEMPTS, may_submit: true, history: [] };
      const joined = !!c.participation;
      let body = '';
      const dc = discordState();
      const needDiscord = !!(dc && dc.required && !dc.linked) && v.key !== 'live' && v.key !== 'ended';

      if (needDiscord) {
        // Step 0, ahead of everything else: joining, sending a video and connecting
        // an account all need it, so nothing else is offered until it is done.
        body = `<div class="cg-panel"><h3>Connect your Discord first</h3>
          <div class="sub">One quick step before you start. Connecting adds you to the ClipGrow server and lets us reach you about this campaign. It takes a few seconds and you only do it once.</div>
          <div class="row-actions"><a class="cg-btn cg-btn-primary" id="cga-discord" href="/api/auth/discord/start?campaign_id=${c.id}">Connect Discord</a></div></div>`;
      } else if (!joined) {
        body = `<div class="cg-panel"><h3>Join this campaign</h3><div class="sub">Joining is free. You'll send a short video for review before you connect an account.</div>
          <button class="cg-btn cg-btn-primary" id="cga-join">Join campaign</button><div class="err" id="cga-err" role="alert" hidden></div></div>`;
      } else if (v.key === 'live') {
        body = `<div class="approved-box"><b>You're live on this campaign.</b> Your account is connected and views are counted every hour.</div>`;
      } else if (v.key === 'approved') {
        body = `<div class="approved-box"><b>Your video was approved.</b>${app.approved && app.approved.reviewer_note ? ' ' + esc(app.approved.reviewer_note) : ''}<br>
          Next, connect the account you'll post from.<div class="row-actions"><button class="cg-btn cg-btn-primary" id="cga-connect">Connect account</button></div></div>`;
      } else if (v.key === 'pending') {
        body = `<div class="waiting"><b>Waiting for review.</b> Sent ${app.pending ? ago(app.pending.created_at) : ''}. Reviewers check every video within 24 hours. You'll see the result here — you can't send another video until this one is reviewed.</div>${dots(app)}`;
      } else if (v.key === 'ended') {
        body = '<div class="cg-panel"><h3>This campaign has ended</h3></div>';
      } else {
        body = feedback(app) + dots(app) + (app.may_submit ? submitPanel(app) : '');
      }

      const heroBadge = `<span class="tc-badge ${v.tone}">${esc(v.head)}</span>`;
      const heroCap = `<div class="tc-cap"><div><h2>${esc(c.name)}</h2><p>${money(c.cpm)} per 1K views · ${money(c.remaining)} left in budget</p></div></div>`;
      return `<button class="cg-back" id="cga-back">← All campaigns</button>
        <div class="hero">${face(c, heroCap, heroBadge)}</div>
        ${joined ? stepper(v) : '<div style="height:1rem"></div>'}
        ${body}${joined ? history(app) : ''}${about(c)}${joined ? reference(c) : ''}`;
    }

    /* ------------------------------------------------------------ behaviour */
    function bind(c) {
      el.querySelectorAll('[data-open]').forEach(n => {
        const go = () => { const camp = campaigns.find(x => x.id === Number(n.dataset.open)); if (!camp || view(camp).dead) return;
          // A campaign the clipper is already live on has its own full page in the
          // host (clips, earnings); the review screen would only be in the way.
          if (view(camp).key === 'live' && opts.onOpenLive) return opts.onOpenLive(camp);
          openId = camp.id; render(); window.scrollTo({ top: 0 }); };
        n.addEventListener('click', go);
        n.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      });
      if (!c) return;
      const $ = id => el.querySelector('#' + id);
      $('cga-back').onclick = () => { openId = null; render(); };
      if ($('cga-connect')) $('cga-connect').onclick = () => onConnect(c);
      if ($('cga-join')) $('cga-join').onclick = async () => {
        const b = $('cga-join'); b.disabled = true;
        try { await api(`/api/clipper/campaigns/${c.id}/join`, { method: 'POST' }); await load(); openId = c.id; render(); }
        catch (e) { showErr(e.message); b.disabled = false; }
      };
      if ($('cga-drop')) bindSubmit(c);
    }

    function showErr(msg) {
      const e = el.querySelector('#cga-err');
      if (e) { e.textContent = msg; e.hidden = !msg; }
    }

    function bindSubmit(c) {
      const $ = id => el.querySelector('#' + id);
      const drop = $('cga-drop'), input = $('cga-input'), send = $('cga-send'), link = $('cga-link');
      let file = null;

      const refresh = () => {
        $('cga-file').innerHTML = file
          ? `<div class="file-row"><span class="fname">${esc(file.name)} · ${mb(file.size)}</span><button class="cg-btn cg-btn-sm" id="cga-clear" type="button">Remove</button></div>` : '';
        drop.hidden = !!file;
        send.disabled = !(file || safeUrl(link.value));
        const clr = $('cga-clear'); if (clr) clr.onclick = () => { file = null; input.value = ''; refresh(); };
      };
      const pick = f => {
        showErr('');
        if (!f) return;
        const ext = (f.name.split('.').pop() || '').toLowerCase();
        if (!ALLOWED_EXT[ext]) return showErr('That file type is not accepted. Use an MP4 or MOV video.');
        if (f.size > 500 * 1048576) return showErr(`That file is ${mb(f.size)}. The limit is 500 MB — trim or compress it first.`);
        file = f; refresh();
      };

      drop.onclick = () => input.click();
      drop.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } };
      input.onchange = () => pick(input.files[0]);
      ['dragover', 'dragenter'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
      ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
      drop.addEventListener('drop', e => pick(e.dataTransfer.files[0]));
      link.oninput = refresh;

      send.onclick = async () => {
        showErr('');
        send.disabled = true;
        try {
          let body;
          if (file) {
            send.textContent = 'Uploading… 0%';
            const ext = (file.name.split('.').pop() || 'mp4').toLowerCase();
            const mime = file.type || ALLOWED_EXT[ext] || 'video/mp4';
            const s = await api(`/api/clipper/campaigns/${c.id}/applications/upload-url`, {
              method: 'POST', body: JSON.stringify({ mime_type: mime, size_bytes: file.size, ext })
            });
            const id = await putToDrive(s.sessionUrl, file, mime, p => { send.textContent = `Uploading… ${p}%`; });
            body = { drive_file_id: id };
          } else {
            body = { video_url: link.value.trim() };
          }
          send.textContent = 'Sending…';
          await api(`/api/clipper/campaigns/${c.id}/applications`, { method: 'POST', body: JSON.stringify(body) });
          await load(); openId = c.id; render();
        } catch (e) {
          showErr(e.message || 'Something went wrong. Try again.');
          send.textContent = 'Send for review'; send.disabled = false;
        }
      };
      refresh();
    }

    /* Bytes go straight to Google's resumable session URL -- never through our
       Worker. XHR rather than fetch because fetch cannot report upload progress. */
    function putToDrive(sessionUrl, file, mime, onProgress) {
      return new Promise((resolve, reject) => {
        const x = new XMLHttpRequest();
        upload = x;
        x.open('PUT', sessionUrl);
        x.setRequestHeader('Content-Type', mime);
        x.upload.onprogress = e => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
        x.onload = () => {
          upload = null;
          if (x.status >= 200 && x.status < 300) {
            try { const id = JSON.parse(x.responseText).id; return id ? resolve(id) : reject(new Error('Upload finished but Google returned no file id. Try again.')); }
            catch (e) { return reject(new Error('Upload finished but the response was unreadable. Try again.')); }
          }
          reject(new Error(`Upload failed (${x.status}). Check your connection and try again.`));
        };
        x.onerror = () => { upload = null; reject(new Error('Upload interrupted. Check your connection and try again.')); };
        x.send(file);
      });
    }

    load().catch(e => { el.innerHTML = `<div class="cg-empty">Couldn't load campaigns. ${esc(e.message)}</div>`; });
    return {
      reload: load,
      // Lets the host send a clipper straight to one campaign's page, e.g. when
      // an old "connect" link is followed before they have passed step 1.
      open(id) { openId = id; render(); window.scrollTo({ top: 0 }); }
    };
  }

  window.CGApps = window.CGApps || {};
  window.CGApps.clipper = { mount, _view: view };
})();
