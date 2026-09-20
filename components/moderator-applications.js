/* Moderator side of campaign onboarding: one tab per campaign that has videos
   waiting, oldest submission first (first come, first served).

     CGApps.moderator.mount(el, { api })

   Data comes from GET /api/moderator/applications, which returns the rows AND
   the per-campaign tab counts from one query, so a tab's number can never
   disagree with what opening it shows. A verdict is POST
   /api/moderator/applications/:id { verdict, note }; the server refuses a
   rejection with no reason, and this UI blocks it first so the moderator never
   loses a typed decision to a round trip. */
(function () {
  'use strict';
  const MIN_REASON = 8;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeUrl = u => (/^https?:\/\//i.test(String(u || '')) ? String(u) : '');
  function waited(ms) {
    const m = Math.floor(ms / 60000);
    if (m < 1) return 'under a minute';
    if (m < 60) return m + ' min';
    if (m < 1440) return Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
    return Math.floor(m / 1440) + ' d ' + Math.floor((m % 1440) / 60) + ' h';
  }

  function mount(el, opts) {
    const api = opts.api;
    el.classList.add('cga');
    let data = { applications: [], campaigns: [], total: 0 };
    let tab = null;
    let loadedAt = Date.now();
    // Kept across re-renders so typing a reason is never lost when the queue
    // refreshes underneath the moderator.
    const drafts = new Map();
    const armed = new Set();

    async function load() {
      data = await api('/api/moderator/applications');
      loadedAt = Date.now();
      if (!data.campaigns.some(c => c.campaign_id === tab)) tab = data.campaigns.length ? data.campaigns[0].campaign_id : null;
      render();
    }

    function render() {
      if (!data.total) {
        el.innerHTML = '<div class="cg-empty"><b style="color:var(--c-white)">Nothing waiting.</b><br>Every submitted video has been reviewed.</div>';
        return;
      }
      const tabs = data.campaigns.map(c => `
        <button class="cg-tab" role="tab" aria-selected="${c.campaign_id === tab}" data-tab="${c.campaign_id}">
          <div class="t-n">${esc(c.campaign_name)}</div>
          <div class="t-s">${c.pending} waiting · longest ${waited(Date.now() - c.oldest_created_at)}</div>
        </button>`).join('');
      const rows = data.applications.filter(a => a.campaign_id === tab);
      el.innerHTML = `<div class="cg-tabs" role="tablist">${tabs}</div>${rows.map(item).join('')}`;
      bind();
    }

    function media(a) {
      const url = safeUrl(a.video_url);
      if (url) {
        return `<div><a class="src" href="${esc(url)}" target="_blank" rel="noopener noreferrer"><span>Pasted link</span><span>Open ↗</span></a>
          <div class="cg-muted" style="font-size:.75rem">The clipper pasted a link instead of uploading.</div></div>`;
      }
      // Uploaded file: streamed through the Worker so the moderator never needs
      // access to the founder's Drive.
      return `<video class="q-video" controls preload="metadata" playsinline src="/api/moderator/applications/${a.id}/video"></video>`;
    }

    function item(a) {
      const name = a.clipper_display_name || a.clipper_username;
      const draft = drafts.get(a.id) || '';
      const isArmed = armed.has(a.id);
      const attempt = a.prior_rejections + 1;
      return `<div class="q-item ${a.is_final_attempt ? 'final' : ''}" data-id="${a.id}">
        ${media(a)}
        <div>
          <div class="q-title"><b>${esc(name)}</b>
            <span class="pill pill-review">Attempt ${attempt} of 3</span>
            ${a.is_final_attempt ? '<span class="pill pill-dead">Final attempt</span>' : ''}</div>
          <div class="cg-muted" style="font-size:.8rem">@${esc(a.clipper_username)} · waiting ${waited(Date.now() - a.created_at)}</div>
          ${a.prior_rejections ? `<button class="cg-btn cg-btn-sm" data-hist="${a.id}" style="margin-top:.6rem">Show previous feedback</button><div data-histbox="${a.id}"></div>` : ''}
          <textarea class="note" data-note="${a.id}" maxlength="1000" aria-label="Reason for the clipper"
            placeholder="Reason for the clipper (required to reject, optional to approve). Be specific — they see this in bold.">${esc(draft)}</textarea>
          ${a.is_final_attempt ? '<div class="warn-final" style="margin-top:.6rem">Rejecting this removes the clipper from the campaign.</div>' : ''}
          <div class="err" data-err="${a.id}" role="alert" hidden></div>
          <div class="row-actions">
            <button class="cg-btn cg-btn-primary" data-verdict="approved" data-id="${a.id}">Approve</button>
            <button class="cg-btn cg-btn-danger" data-verdict="rejected" data-id="${a.id}">${isArmed ? 'Confirm — remove from campaign' : 'Reject'}</button>
          </div>
        </div>
      </div>`;
    }

    function bind() {
      el.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tab = Number(b.dataset.tab); render(); });
      el.querySelectorAll('[data-note]').forEach(t => t.oninput = () => {
        drafts.set(Number(t.dataset.note), t.value);
        // Editing after arming the final-attempt confirmation disarms it, so a
        // stale confirmation cannot land on a reason the moderator has since changed.
        armed.delete(Number(t.dataset.note));
      });
      el.querySelectorAll('[data-hist]').forEach(b => b.onclick = async () => {
        const box = el.querySelector(`[data-histbox="${b.dataset.hist}"]`);
        b.disabled = true;
        try {
          const r = await api(`/api/moderator/applications/${b.dataset.hist}/history`);
          box.innerHTML = `<ol class="hist" style="margin-top:.6rem">${(r.history || []).filter(h => h.status === 'rejected').map(h =>
            `<li><b>Attempt ${h.attempt}</b> — ${esc(h.reviewer_note || 'No reason given')} <span class="cg-muted">(${esc(h.reviewer_name || 'reviewer')})</span></li>`).join('')}</ol>`;
          b.remove();
        } catch (e) { box.textContent = e.message; b.disabled = false; }
      });
      el.querySelectorAll('[data-verdict]').forEach(b => b.onclick = () => decide(Number(b.dataset.id), b.dataset.verdict, b));
    }

    async function decide(id, verdict, btn) {
      const a = data.applications.find(x => x.id === id);
      const note = (drafts.get(id) || '').trim();
      const err = el.querySelector(`[data-err="${id}"]`);
      const fail = m => { err.textContent = m; err.hidden = false; };
      err.hidden = true;

      if (verdict === 'rejected') {
        if (note.length < MIN_REASON) return fail(`Write a reason of at least ${MIN_REASON} characters — the clipper sees exactly this.`);
        // Rejecting a final attempt is irreversible for the clipper, so it takes
        // a deliberate second click.
        if (a.is_final_attempt && !armed.has(id)) { armed.add(id); return render(); }
      }
      el.querySelectorAll(`[data-id="${id}"]`).forEach(x => { if (x.tagName === 'BUTTON') x.disabled = true; });
      try {
        await api(`/api/moderator/applications/${id}`, { method: 'POST', body: JSON.stringify({ verdict, note }) });
        drafts.delete(id); armed.delete(id);
        await load();
      } catch (e) {
        el.querySelectorAll(`[data-id="${id}"]`).forEach(x => { if (x.tagName === 'BUTTON') x.disabled = false; });
        // 409 means another reviewer already ruled on it: show the fresh queue.
        fail(e.message || 'Could not save. Try again.');
        if (/already|reviewed/i.test(e.message || '')) setTimeout(load, 1200);
      }
    }

    // Waiting times tick on their own; new submissions arrive on a slow poll.
    // Re-render only when nobody is mid-decision, so a poll never eats a
    // half-typed reason or moves a button under the cursor.
    setInterval(() => { if (!el.contains(document.activeElement) || document.activeElement.tagName !== 'TEXTAREA') { if (Date.now() - loadedAt > 60000) load().catch(() => {}); else render(); } }, 30000);

    load().catch(e => { el.innerHTML = `<div class="cg-empty">Couldn't load the queue. ${esc(e.message)}</div>`; });
    return { reload: load };
  }

  window.CGApps = window.CGApps || {};
  window.CGApps.moderator = { mount };
})();
