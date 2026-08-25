// The timeline popup: ONE YEAR of your people, sorted by that year's
// engagement, with the year's topic chips — month grouping was yeeted
// (owner, 2026-08-25). Browser-style year tabs page between years; one fetch
// per year (cached, dropped on every panel re-open via __hzRefresh); search
// and the funnel filters narrow client-side. Expanding a row shows a
// model-written summary fetched on demand — labeled as the model's, because
// unlike every other line here it is not counted, it is written — and the
// specifics (word pairs first). The taxonomy line was yeeted: the row's own
// chips are the topics line, five of them.
// (The file keeps its historical name; renaming the page id would ripple
// through the bridge allowlist and panel factory for no behavioral gain.)
'use strict';

(function () {
  const listEl = document.getElementById('list');
  const searchEl = document.getElementById('search');
  const closeEl = document.getElementById('close');
  const tabsEl = document.getElementById('tabs');
  const syncEl = document.getElementById('sync');
  const filtEl = document.getElementById('filt');
  const filtersEl = document.getElementById('filters');
  const sortEl = document.getElementById('sort');
  const companyEl = document.getElementById('fcompany');
  const channelEl = document.getElementById('fchannel');
  const statusEl = document.getElementById('fstatus');
  const resetEl = document.getElementById('freset');
  if (!listEl) return;

  // Hover hint per connector — shown by our own CSS tooltip (data-tip),
  // because native title tooltips are unreliable in a borderless
  // non-activating panel.
  const CHAN_LABEL = { imessage: 'iMessage', whatsapp: 'WhatsApp', mail: 'mail', calendar: 'calendar', linkedin: 'LinkedIn' };

  let year = new Date().getFullYear();
  let years = []; // every year with activity, from the server
  let expanded = null; // '<personKey>|<year>' of the row showing its detail
  const cache = new Map(); // year -> payload
  const summaries = new Map(); // '<personKey>|<year>' -> {state, text?, reason?}

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // ---- the model-written summary, fetched on demand per expanded row ----
  function requestSummary(key, y) {
    const sk = `${key}|${y}`;
    if (summaries.has(sk)) return;
    summaries.set(sk, { state: 'pending' });
    hzPost('peopleSummary', { key, year: y })
      .then((r) => {
        summaries.set(sk, r && r.text
          ? { state: 'done', text: r.text }
          : { state: 'none', reason: (r && r.reason) || 'unavailable' });
      })
      .catch(() => summaries.set(sk, { state: 'none', reason: 'unavailable' }))
      .finally(render);
  }

  function detailHtml(p) {
    const bits = [];
    const sk = `${p.key}|${year}`;
    const sum = summaries.get(sk);
    if (sum && sum.state === 'pending') {
      bits.push('<div class="pl-d pm-sum pm-sum-wait">summarizing this year…</div>');
    } else if (sum && sum.state === 'done') {
      bits.push(`<div class="pl-d pm-sum">${esc(sum.text)} <span class="pm-sum-tag">· written by the local model</span></div>`);
    } else if (sum && sum.state === 'none') {
      bits.push(`<div class="pl-d pl-dim">no summary — ${esc(sum.reason)}</div>`);
    }
    if (p.specifics && p.specifics.length) {
      bits.push(`<div class="pl-d">specifics: ${p.specifics.map((t) => `${esc(t.label)} (${t.n})`).join(' · ')}</div>`);
    }
    if (!bits.length) bits.push('<div class="pl-d pl-dim">not enough said this year to name topics</div>');
    return `<div class="pl-detail">${bits.join('')}</div>`;
  }

  function rowHtml(p) {
    const chips = (p.topics || [])
      .map((t) => `<span class="pl-chip pl-topic">${esc(t.label)}</span>`)
      .join('');
    const rowKey = `${p.key}|${year}`;
    const open = expanded === rowKey;
    const srcIcons = (p.channels || [])
      .map((c) => `<span class="pm-src-ic" data-tip="${esc(CHAN_LABEL[c] || c)}">${hzGlyph(c)}</span>`)
      .join('');
    return (
      `<div class="pl-row${open ? ' open' : ''}" data-rk="${esc(rowKey)}">` +
        `<div class="pl-main">` +
          `<div class="pl-nameline">` +
            `<span class="pl-name">${esc(p.name)}</span>` +
            `<span class="pm-msgs">${p.messages} msg${p.messages === 1 ? '' : 's'}</span>` +
            srcIcons +
          `</div>` +
          (chips ? `<div class="pl-src pm-chip-row">${chips}</div>` : '') +
          (open ? detailHtml(p) : '') +
        `</div>` +
      `</div>`
    );
  }

  const SORTS = {
    engagement: (a, b) => b.engagement - a.engagement,
    messages: (a, b) => (b.messages || 0) - (a.messages || 0),
    met: (a, b) => (b.met || 0) - (a.met || 0) || b.engagement - a.engagement,
    name: (a, b) => (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase()),
  };

  function passesFilters(p, term) {
    if (term && !(p.name || '').toLowerCase().includes(term)) return false;
    if (companyEl.value && p.cluster !== companyEl.value) return false;
    if (channelEl.value && !(p.channels || []).includes(channelEl.value)) return false;
    if (statusEl.value === 'active' && !(p.recencyDays != null && p.recencyDays < 90)) return false;
    if (statusEl.value === 'dormant' && !(p.recencyDays != null && p.recencyDays >= 365)) return false;
    return true;
  }

  // Company dropdown options from every cached year, so switching tabs keeps
  // the selection meaningful. Rebuilt after each load; selection preserved.
  function fillCompanies() {
    const sizes = new Map();
    const labels = new Map();
    for (const data of cache.values()) {
      for (const p of data.people) {
        if (!p.cluster || p.cluster === 'personal') continue;
        sizes.set(p.cluster, (sizes.get(p.cluster) || 0) + 1);
        if (!labels.has(p.cluster)) labels.set(p.cluster, p.clusterLabel || p.cluster);
      }
    }
    const keep = companyEl.value;
    const opts = ['<option value="">all</option>'];
    for (const [key] of [...sizes.entries()].sort((a, b) => b[1] - a[1])) {
      opts.push(`<option value="${esc(key)}">${esc(labels.get(key))}</option>`);
    }
    opts.push('<option value="personal">personal</option>');
    companyEl.innerHTML = opts.join('');
    companyEl.value = keep;
    if (companyEl.value !== keep) companyEl.value = '';
  }

  function render() {
    const data = cache.get(year);
    if (!data) return;
    const term = searchEl.value.trim().toLowerCase();
    const filtering = Boolean(term || companyEl.value || channelEl.value || statusEl.value);
    const rows = data.people.filter((p) => passesFilters(p, term));
    rows.sort(SORTS[sortEl.value] || SORTS.engagement);
    listEl.innerHTML = rows.map(rowHtml).join('') || `<div class="pl-empty">no one matches in ${year}</div>`;
    const shown = rows.length;
    searchEl.placeholder = `search ${year} (${shown} shown)…`;
    if (!filtering && data.total > data.people.length) {
      listEl.insertAdjacentHTML('beforeend',
        `<div class="pl-more">+ ${data.total - data.people.length} more in ${year} — search or filter to narrow</div>`);
    }
    renderTabs();
  }

  // Browser-style year tabs: oldest left, newest right, the open one active.
  function renderTabs() {
    const ys = years.length ? years : [year];
    tabsEl.innerHTML = ys
      .map((y) => `<button class="pm-tab${y === year ? ' active' : ''}" data-y="${y}">${y}</button>`)
      .join('');
    const active = tabsEl.querySelector('.pm-tab.active');
    if (active) active.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }

  // An uncached year is a server rebuild on first touch, so the click must
  // answer INSTANTLY with a loading state. reqId guards the race: only the
  // newest click's response may paint.
  let reqId = 0;
  async function load(y) {
    year = y;
    renderTabs();
    if (cache.has(year)) return render();
    const my = ++reqId;
    searchEl.placeholder = `loading ${year}…`;
    listEl.innerHTML = `<div class="pm-loading">loading ${year}…</div>`;
    const res = await hzPost('peopleYear', { year });
    if (my !== reqId) return; // superseded by a newer tab click
    if (!res || !Array.isArray(res.people)) throw new Error('bad year payload');
    cache.set(year, res);
    if (Array.isArray(res.years) && res.years.length) years = res.years;
    fillCompanies();
    render();
    prefetchRest();
  }

  // Warm the remaining years in the background, newest first — the server
  // memoizes the heavy scan, so each is cheap and later clicks land on the
  // client cache.
  let prefetching = false;
  async function prefetchRest() {
    if (prefetching) return;
    prefetching = true;
    try {
      for (const y of [...years].reverse()) {
        if (cache.has(y)) continue;
        const res = await hzPost('peopleYear', { year: y });
        if (res && Array.isArray(res.people)) cache.set(y, res);
      }
    } catch {
      // Background warming only; a failure costs nothing but the warmth.
    } finally {
      prefetching = false;
    }
  }

  function loadOrFail(y) {
    load(y).catch(() => {
      searchEl.placeholder = 'couldn’t load';
      listEl.innerHTML = `<div class="pl-empty">couldn’t load ${y} — click its tab to retry</div>`;
    });
  }

  // Native calls this on every panel re-open: the webview SURVIVES hidden
  // (panels keep state), so without it the first open's data was the data
  // forever. Refetch is cheap (the server memoizes the heavy scan).
  window.__hzRefresh = () => {
    cache.clear();
    summaries.clear();
    prefetching = false;
    loadOrFail(year);
  };

  tabsEl.addEventListener('click', (e) => {
    const b = e.target.closest('.pm-tab');
    if (!b || !b.dataset.y) return;
    loadOrFail(Number(b.dataset.y));
  });
  listEl.addEventListener('click', (e) => {
    const row = e.target.closest('.pl-row');
    if (!row) return;
    const rk = row.getAttribute('data-rk');
    expanded = expanded === rk ? null : rk;
    if (expanded !== null) {
      const key = rk.slice(0, rk.lastIndexOf('|'));
      requestSummary(key, year);
    }
    render();
  });
  syncEl.addEventListener('click', () => { hzPost('openPeople').catch(() => {}); });
  filtEl.addEventListener('click', () => {
    filtersEl.hidden = !filtersEl.hidden;
    filtEl.classList.toggle('on', !filtersEl.hidden);
  });
  for (const el of [sortEl, companyEl, channelEl, statusEl]) el.addEventListener('change', render);
  resetEl.addEventListener('click', () => {
    sortEl.value = 'engagement';
    companyEl.value = '';
    channelEl.value = '';
    statusEl.value = '';
    render();
  });
  let t = null;
  searchEl.addEventListener('input', () => { clearTimeout(t); t = setTimeout(render, 90); });
  if (closeEl) closeEl.addEventListener('click', () => { hzSfx.close(); hzPost('close').catch(() => {}); });

  loadOrFail(year);
})();
