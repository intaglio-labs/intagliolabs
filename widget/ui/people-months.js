// The timeline popup: one year, month sections newest-first, rows by that
// month's engagement with that month's topic chips. One fetch per year
// (cached); search filters by name client-side. Same CSP discipline as
// people-sky.js: bar widths and nothing else go through the CSSOM.
'use strict';

(function () {
  const listEl = document.getElementById('list');
  const searchEl = document.getElementById('search');
  const footEl = document.getElementById('foot');
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

  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let year = new Date().getFullYear();
  let years = []; // every year with activity, from the server
  const cache = new Map(); // year -> payload

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function monthLabel(ym) {
    return `${MONTH_NAMES[Number(ym.slice(5)) - 1]} ${ym.slice(0, 4)}`;
  }

  function rowHtml(p, maxEng) {
    const chips = (p.topics || [])
      .map((t) => `<span class="pl-chip pl-topic">${esc(t.label)}</span>`)
      .join('');
    const sub = [];
    sub.push(`${p.messages} msg${p.messages === 1 ? '' : 's'}`);
    if (p.met) sub.push(`met ${p.met}×`);
    if (p.company) sub.push(esc(p.company));
    const w = Math.max(2, Math.round((p.engagement / (maxEng || 1)) * 100));
    return (
      `<div class="pl-row">` +
        `<div class="pl-main">` +
          `<div class="pl-nameline">` +
            `<span class="pl-name">${esc(p.name)}</span>` +
            `<span class="pl-src">${chips}</span>` +
          `</div>` +
          `<div class="pl-bar"><span class="pl-bar-fill" data-w="${w}"></span></div>` +
          `<div class="pl-sub">${sub.join(' · ')}</div>` +
        `</div>` +
      `</div>`
    );
  }

  function paintBars(root) {
    for (const bar of root.querySelectorAll('.pl-bar-fill[data-w]')) {
      bar.style.width = bar.getAttribute('data-w') + '%';
    }
  }

  // Within-month orderings for the sort control. Engagement is the default
  // and the server's own order; the rest re-sort client-side.
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
      for (const m of data.months) {
        for (const p of m.people) {
          if (!p.cluster || p.cluster === 'personal') continue;
          sizes.set(p.cluster, (sizes.get(p.cluster) || 0) + 1);
          if (!labels.has(p.cluster)) labels.set(p.cluster, p.clusterLabel || p.cluster);
        }
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
    const html = [];
    let shown = 0;
    for (const m of data.months) {
      const rows = m.people.filter((p) => passesFilters(p, term));
      rows.sort(SORTS[sortEl.value] || SORTS.engagement);
      if (rows.length === 0) continue;
      const maxEng = Math.max(...rows.map((p) => p.engagement));
      const count = filtering ? rows.length : m.total;
      html.push(`<div class="pl-year">${monthLabel(m.ym)} <span class="pl-year-n">· ${count} people</span></div>`);
      for (const p of rows) html.push(rowHtml(p, maxEng));
      if (!filtering && m.total > m.people.length) {
        html.push(`<div class="pl-more">+ ${m.total - m.people.length} more in ${monthLabel(m.ym)}</div>`);
      }
      shown += rows.length;
    }
    listEl.innerHTML = html.join('') || `<div class="pl-empty">no activity in ${year}</div>`;
    paintBars(listEl);
    searchEl.placeholder = `search ${year} (${shown} shown)…`;
    footEl.textContent = 'by month — most engaged first · chips are that month’s topics';
    renderTabs();
  }

  // Browser-style year tabs: oldest left, newest right, the open one active.
  // Until the first payload names the years, the strip shows just the year
  // being loaded.
  function renderTabs() {
    const ys = years.length ? years : [year];
    tabsEl.innerHTML = ys
      .map((y) => `<button class="pm-tab${y === year ? ' active' : ''}" data-y="${y}">${y}</button>`)
      .join('');
    const active = tabsEl.querySelector('.pm-tab.active');
    if (active) active.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }

  // An uncached year is a full server rebuild (~seconds), so the click must
  // answer INSTANTLY with a loading state — a tab that highlights while the
  // old year's list sits there reads as broken. reqId guards the race: only
  // the newest click's response may paint (clicking 2019 then 2024 must never
  // end on 2019's data because 2019's fetch finished last).
  let reqId = 0;
  async function load(y) {
    year = y;
    renderTabs();
    if (cache.has(year)) return render();
    const my = ++reqId;
    searchEl.placeholder = `loading ${year}…`;
    listEl.innerHTML = `<div class="pm-loading">loading ${year}…</div>`;
    footEl.textContent = '';
    const res = await hzPost('peopleMonths', { year });
    if (my !== reqId) return; // superseded by a newer tab click
    if (!res || !Array.isArray(res.months)) throw new Error('bad months payload');
    cache.set(year, res);
    if (Array.isArray(res.years) && res.years.length) years = res.years;
    fillCompanies();
    render();
    prefetchRest();
  }

  // Warm the remaining years in the background, newest first, one at a time —
  // the server memoizes the heavy scan after the first build, so each of
  // these is cheap, and every later tab click lands on the client cache.
  let prefetching = false;
  async function prefetchRest() {
    if (prefetching) return;
    prefetching = true;
    try {
      for (const y of [...years].reverse()) {
        if (cache.has(y)) continue;
        const res = await hzPost('peopleMonths', { year: y });
        if (res && Array.isArray(res.months)) cache.set(y, res);
      }
    } catch {
      // Background warming only; a failure costs nothing but the warmth.
    } finally {
      prefetching = false;
    }
  }

  tabsEl.addEventListener('click', (e) => {
    const b = e.target.closest('.pm-tab');
    if (!b || !b.dataset.y) return;
    loadOrFail(Number(b.dataset.y));
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

  function loadOrFail(y) {
    load(y).catch(() => {
      searchEl.placeholder = 'couldn’t load';
      listEl.innerHTML = `<div class="pl-empty">couldn’t load ${y} — click its tab to retry</div>`;
    });
  }
  loadOrFail(year);
})();
