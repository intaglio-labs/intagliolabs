// Your people as a sortable, filterable list. One row per person with the
// fields the map computes; sort by any of them, filter by company / channel /
// status, search by name. Data from GET /people/map via the peopleMap native
// handler — all the sorting and filtering is code here, over that one payload.
// (This is the window the constellation used; a dense star-field looked great
// but you couldn't find anyone, so it's a list now.)
'use strict';

(function () {
  const listEl = document.getElementById('list');
  const searchEl = document.getElementById('search');
  const footEl = document.getElementById('foot');
  const closeEl = document.getElementById('close');
  const sortEl = document.getElementById('sort');
  const companyEl = document.getElementById('fcompany');
  const channelEl = document.getElementById('fchannel');
  const statusEl = document.getElementById('fstatus');
  if (!listEl) return;

  const CAP = 600; // rows rendered at once; search/filter narrows past it
  let people = [];
  let expanded = null; // key of the row showing its detail

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function daysLabel(d) {
    if (d == null) return 'no reply on record';
    if (d < 1) return 'today';
    if (d < 30) return `${d}d ago`;
    if (d < 365) return `${Math.round(d / 30)}mo ago`;
    return `${(d / 365).toFixed(1)}y ago`;
  }
  const recencyKey = (p) => (p.recencyDays == null ? Infinity : p.recencyDays);

  // Nice labels for the source connections a person appears in.
  const CHAN = { imessage: 'iMessage', whatsapp: 'WhatsApp', mail: 'mail', calendar: 'calendar', linkedin: 'LinkedIn' };
  const srcChips = (channels) =>
    (channels || []).map((c) => `<span class="pl-chip">${esc(CHAN[c] || c)}</span>`).join('');

  const SORTS = {
    recent: (a, b) => recencyKey(a) - recencyKey(b) || (b.messages || 0) - (a.messages || 0),
    dormant: (a, b) => recencyKey(b) - recencyKey(a),
    messages: (a, b) => (b.messages || 0) - (a.messages || 0),
    closest: (a, b) => (b.strength || 0) - (a.strength || 0),
    met: (a, b) => (b.metInPerson || 0) - (a.metInPerson || 0) || recencyKey(a) - recencyKey(b),
    name: (a, b) => (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase()),
  };

  function filtered() {
    const term = searchEl.value.trim().toLowerCase();
    const company = companyEl.value;
    const channel = channelEl.value;
    const status = statusEl.value;
    return people.filter((p) => {
      if (term && !(p.name || '').toLowerCase().includes(term) && !(p.clusterLabel || '').toLowerCase().includes(term)) return false;
      if (company && p.cluster !== company) return false;
      if (channel && !(p.channels || []).includes(channel)) return false;
      if (status === 'active' && !(p.recencyDays != null && p.recencyDays < 90)) return false;
      if (status === 'dormant' && !(p.recencyDays != null && p.recencyDays >= 365)) return false;
      return true;
    });
  }

  // A warmth dot: warm (recent) = gold, cold (dormant) = dim slate.
  function warmDot(warm) {
    const t = Math.max(0, Math.min(1, warm || 0));
    const r = Math.round(122 + (229 - 122) * t);
    const g = Math.round(134 + (214 - 134) * t);
    const b = Math.round(158 + (187 - 158) * t);
    return `rgb(${r},${g},${b})`;
  }

  function detailHtml(p) {
    const dots = (n) => { const k = Math.max(0, Math.min(5, Math.round(n * 5))); return '●'.repeat(k) + '○'.repeat(5 - k); };
    const bits = [];
    const ids = (p.identifiers || []).slice(0, 3).map(esc).join(' · ');
    if (ids) bits.push(`<div class="pl-d">${ids}</div>`);
    if (p.messages) bits.push(`<div class="pl-d">${p.messages} msgs · you reply ${dots(p.reciprocity || 0)}</div>`);
    const tail = [];
    if (p.metInPerson) tail.push(`met ${p.metInPerson}×`);
    if (p.title) tail.push(esc(p.title));
    // channels/sources are shown as chips on the row itself, not repeated here
    if (tail.length) bits.push(`<div class="pl-d pl-dim">${tail.join(' · ')}</div>`);
    return bits.join('');
  }

  function rowHtml(p) {
    const sub = [];
    if (p.clusterLabel && p.clusterLabel !== 'personal') sub.push(esc(p.clusterLabel));
    sub.push(daysLabel(p.recencyDays));
    if (p.messages) sub.push(`${p.messages} msg${p.messages === 1 ? '' : 's'}`);
    const open = expanded === p.key;
    return (
      `<div class="pl-row${open ? ' open' : ''}" data-key="${esc(p.key)}">` +
        `<span class="pl-dot"></span>` +
        `<div class="pl-main">` +
          `<div class="pl-nameline">` +
            `<span class="pl-name">${esc(p.name)}</span>` +
            `<span class="pl-src">${srcChips(p.channels)}</span>` +
          `</div>` +
          `<div class="pl-sub">${sub.join(' · ')}</div>` +
          (open ? `<div class="pl-detail">${detailHtml(p)}</div>` : '') +
        `</div>` +
      `</div>`
    );
  }

  function render() {
    const rows = filtered().sort(SORTS[sortEl.value] || SORTS.recent);
    const shown = rows.slice(0, CAP);
    listEl.innerHTML = shown.map(rowHtml).join('') || '<div class="pl-empty">no one matches</div>';
    // The page CSP (style-src 'self', no 'unsafe-inline') refuses markup-borne
    // style attributes; the dot color has to be written through the CSSOM.
    const dots = listEl.querySelectorAll('.pl-dot');
    shown.forEach((p, i) => { if (dots[i]) dots[i].style.background = warmDot(p.warm); });
    // The count lives in the search placeholder (shown while the box is empty),
    // and reflects the current filtered result — "search your people (42)…".
    searchEl.placeholder = `search your people (${rows.length})…`;
    footEl.textContent = rows.length > CAP ? `showing the first ${CAP} — search or filter to narrow` : '';
  }

  // Row click toggles its inline detail.
  listEl.addEventListener('click', (e) => {
    const row = e.target.closest('.pl-row');
    if (!row) return;
    const key = row.getAttribute('data-key');
    expanded = expanded === key ? null : key;
    render();
  });

  let t = null;
  const debounced = () => { clearTimeout(t); t = setTimeout(render, 90); };
  searchEl.addEventListener('input', debounced);
  for (const el of [sortEl, companyEl, channelEl, statusEl]) el.addEventListener('change', render);
  if (closeEl) closeEl.addEventListener('click', () => { hzPost('close').catch(() => {}); });

  function fillCompanies(clusters) {
    const named = (clusters || []).filter((c) => !c.personal && c.size >= 2).sort((a, b) => b.size - a.size);
    const opts = ['<option value="">all</option>'];
    for (const c of named) opts.push(`<option value="${esc(c.key)}">${esc(c.label)} (${c.size})</option>`);
    // The personal field last, so "all your work groups" reads first.
    const personal = (clusters || []).find((c) => c.personal);
    if (personal) opts.push(`<option value="personal">personal (${personal.size})</option>`);
    companyEl.innerHTML = opts.join('');
  }

  async function load() {
    const res = await hzPost('peopleMap', {});
    if (!res || !Array.isArray(res.people)) throw new Error('bad map');
    people = res.people;
    fillCompanies(res.clusters);
    render();
  }

  load().catch(() => { searchEl.placeholder = "couldn’t load"; listEl.innerHTML = '<div class="pl-empty">couldn’t load your people</div>'; });
})();
