// The timeline popup: ONE YEAR of your people, sorted by that year's
// engagement, with the year's topic chips — month grouping was yeeted
// (owner, 2026-08-25). Browser-style year tabs page between years; one fetch
// per year (cached, dropped on every panel re-open via __hzRefresh); search
// and search narrows client-side (the filter row was yeeted — owner,
// 2026-08-25). Expanding a row shows one
// thing: a model-written summary fetched on demand — labeled as the
// model's, because unlike the chips it is not counted, it is written. The
// taxonomy and specifics lines were yeeted in turn (owner, 2026-08-25); the
// row's own chips are the whole counted topic surface, five of them.
// (The file keeps its historical name; renaming the page id would ripple
// through the bridge allowlist and panel factory for no behavioral gain.)
//
// TWO VIEWS OF ONE YEAR (2026-08-25). The list answers "who did I talk to";
// the globe tab answers "about what" — the same people regrouped into topic
// bubbles. A view, not a fetch: the constellation is built from the year
// already in the cache, so the globe opens instantly and a search narrows
// both. Its positions and sizes are assigned through element.style and NEVER
// a style attribute, because this page ships style-src 'self' with no
// 'unsafe-inline' — an inline style attribute is parsed, dropped, and fails
// in total silence. See widget/test/csp-inline-style.test.mjs.
'use strict';

(function () {
  const listEl = document.getElementById('list');
  const searchEl = document.getElementById('search');
  const closeEl = document.getElementById('close');
  const tabsEl = document.getElementById('tabs');
  const syncEl = document.getElementById('sync');
  const skyEl = document.getElementById('sky');
  if (!listEl) return;

  // 'list' = the year by person, 'sky' = the same year by topic. A VIEW, not a
  // year: the year tabs stay live in both, so the globe is the last tab rather
  // than a second window.
  let view = 'list';

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
    if (!bits.length) bits.push('<div class="pl-d pl-dim">…</div>');
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

  // Search is the one narrowing control left; the filter row was yeeted
  // (owner, 2026-08-25). Order is the server's: most engaged first. Both views
  // narrow through this, so a search term thins the constellation too.
  function visible(data) {
    const term = searchEl.value.trim().toLowerCase();
    return term
      ? data.people.filter((p) => (p.name || '').toLowerCase().includes(term))
      : data.people;
  }

  function renderList(data, rows) {
    listEl.innerHTML = rows.map(rowHtml).join('') || `<div class="pl-empty">no one matches in ${year}</div>`;
    if (!searchEl.value.trim() && data.total > data.people.length) {
      listEl.insertAdjacentHTML('beforeend',
        `<div class="pl-more">+ ${data.total - data.people.length} more in ${year} — search or filter to narrow</div>`);
    }
  }

  // The surface currently on screen. Both views share the search box, the
  // tabs, and the loading and failure states, so those need to know which one
  // they are talking to.
  function surface() {
    // hidden, not display juggling: the list keeps its scroll position while
    // the globe is up, so coming back lands where it was left.
    listEl.hidden = view !== 'list';
    skyEl.hidden = view !== 'sky';
    return view === 'sky' ? skyEl : listEl;
  }

  function render() {
    const data = cache.get(year);
    if (!data) return;
    const rows = visible(data);
    surface();
    if (view === 'sky') renderSky(data, rows);
    else renderList(data, rows);
    searchEl.placeholder = `search ${year} (${rows.length} shown)…`;
    renderTabs();
  }

  // Browser-style year tabs: oldest left, newest right, the open one active,
  // and the globe last — a view rather than a year, but it lives on the same
  // strip because it shows the same year.
  const GLOBE_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="12" cy="12" r="9"></circle><path d="M3 12h18"></path>' +
    '<path d="M12 3a14 14 0 0 0 0 18a14 14 0 0 0 0-18"></path></svg>';

  function renderTabs() {
    const ys = years.length ? years : [year];
    tabsEl.replaceChildren();
    for (const y of ys) {
      const b = document.createElement('button');
      b.className = 'pm-tab' + (y === year && view === 'list' ? ' active' : '');
      b.dataset.y = String(y);
      b.textContent = String(y);
      tabsEl.appendChild(b);
    }
    const g = document.createElement('button');
    g.className = 'pm-tab pm-tab-globe' + (view === 'sky' ? ' active' : '');
    g.dataset.view = 'sky';
    g.setAttribute('data-tip', `${year} by topic`);
    g.innerHTML = GLOBE_SVG;
    tabsEl.appendChild(g);
    const active = tabsEl.querySelector('.pm-tab.active');
    if (active) active.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }

  // ---- the constellation ----
  // FOUR, and the number is geometry rather than taste. Bubbles sit on a ring
  // of radius r, so neighbours are 2*pi*r/n apart and must not be closer than a
  // bubble is wide; the ring must also stay inside the panel, r <= W/2 - d/2.
  // At the panel's ~400px those two bounds only both hold up to four. Six was
  // tried first and measured: two bubbles ran past the panel edge and the rest
  // overlapped. Anything dropped by this cap is reported in the footnote.
  const MAX_CLUSTERS = 4;
  const MIN_CLUSTER = 2;
  const MAX_FACES = 5;
  // Bubble diameter range, from the same two inequalities solved for d at
  // n = 4 and the panel's ~400px: 0.6366d <= W/2 - d/2 - 6 gives d <= 170. 162
  // takes that with a little slack. The floor is not cosmetic — six discs have
  // to fit inside a CIRCLE, whose usable width at the second row is well under
  // its diameter, and at 100px the "+N" chip pushed out through the border.
  const D_MIN = 118;
  const D_MAX = 162;

  // Two words -> both initials, one word -> one letter. Never two letters off a
  // single name: "Je" reads as a truncation, "J" reads as a monogram.
  function initials(name) {
    const parts = String(name == null ? '' : name).trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    const s = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : parts[0][0];
    return s.toUpperCase();
  }

  // Seeded PRNG (mulberry32). Math.random would reshuffle the background on
  // every keystroke of a search, which reads as the sky twitching at you.
  // Seeded by the year, so a year always comes back the same sky.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Group by topic. ONLY `tax` chips — the fixed vocabulary from the server's
  // TOPIC_SIGNALS. The other chips are terms distinctive to one pair
  // ("tokyo station"), which by construction cannot be shared, so clustering
  // on them would produce a bubble of one wearing a stranger's word.
  // A person joins every topic they carry: people are not one thing.
  function clustersFrom(people) {
    const by = new Map();
    for (const p of people) {
      for (const t of p.topics || []) {
        if (!t || !t.tax) continue;
        let c = by.get(t.label);
        if (!c) by.set(t.label, (c = { label: t.label, members: [] }));
        c.members.push(p);
      }
    }
    // Not sliced here — renderSky needs the full count to say how many topics
    // the cap left out.
    return [...by.values()]
      .filter((c) => c.members.length >= MIN_CLUSTER)
      .sort((a, b) => b.members.length - a.members.length || a.label.localeCompare(b.label));
  }

  function faceEl(p, maxEngagement) {
    const f = document.createElement('div');
    f.className = 'pm-face';
    // 22..32px, the design's range, carrying this year's engagement.
    const size = Math.round(22 + 10 * ((p.engagement || 0) / maxEngagement));
    f.style.width = `${size}px`;
    f.style.height = `${size}px`;
    f.style.fontSize = size >= 28 ? '10px' : '9px';
    f.textContent = initials(p.name);
    // data-tip, not title: native tooltips do not fire reliably in a
    // borderless non-activating panel (same reason as the connector glyphs).
    f.setAttribute('data-tip', `${p.name} · ${p.messages} msg${p.messages === 1 ? '' : 's'}`);
    return f;
  }

  // The ring the bubbles sit on, measured from the stage rather than assumed.
  // The panel is native-sized and the user can scale it, so a hardcoded radius
  // is a clipped bubble waiting to happen — which is exactly what 32% did.
  function ringFor(stageW, stageH) {
    const half = D_MAX / 2 + 6; // biggest bubble's reach, plus a hair of margin
    return {
      rx: Math.max(0, Math.min(stageW / 2 - half, stageW * 0.32)),
      ry: Math.max(0, Math.min(stageH / 2 - half, stageH * 0.30)),
    };
  }

  function clusterEl(c, i, count, maxMembers, ring, stage) {
    const el = document.createElement('div');
    el.className = 'pm-cluster' + (i === 0 ? ' lead' : '');
    // Evenly around the centre, starting upper-left so a four-topic year lands
    // on the diagonals the design draws.
    const ang = -Math.PI * 0.75 + (i * Math.PI * 2) / count;
    const d = Math.round(D_MIN + (D_MAX - D_MIN) * (c.members.length / maxMembers));
    el.style.width = `${d}px`;
    el.style.height = `${d}px`;
    // Percentages so the ring still tracks the panel if it is resized under us.
    el.style.left = `${(50 + (Math.cos(ang) * ring.rx * 100) / stage.w).toFixed(1)}%`;
    el.style.top = `${(51 + (Math.sin(ang) * ring.ry * 100) / stage.h).toFixed(1)}%`;

    const faces = document.createElement('div');
    faces.className = 'pm-faces';
    const shown = c.members.slice(0, MAX_FACES);
    const maxE = Math.max(1, ...shown.map((p) => p.engagement || 0));
    for (const p of shown) faces.appendChild(faceEl(p, maxE));
    const rest = c.members.length - shown.length;
    if (rest > 0) {
      const more = document.createElement('div');
      more.className = 'pm-face pm-face-more';
      more.style.width = '22px';
      more.style.height = '22px';
      more.style.fontSize = '8px';
      more.textContent = `+${rest}`;
      faces.appendChild(more);
    }

    const label = document.createElement('div');
    label.className = 'pm-cluster-label';
    label.textContent = `${c.label.toUpperCase()} · ${c.members.length}`;

    el.append(faces, label);
    return el;
  }

  function renderSky(data, people) {
    skyEl.replaceChildren();
    const all = clustersFrom(people);
    const clusters = all.slice(0, MAX_CLUSTERS);
    if (!clusters.length) {
      const m = document.createElement('div');
      m.className = 'pm-sky-empty';
      m.textContent = people.length
        ? `nothing shared enough to group in ${year} — a topic needs at least ${MIN_CLUSTER} people`
        : `no one to place in ${year}`;
      skyEl.appendChild(m);
      return;
    }

    const rnd = mulberry32(year * 2654435761);
    for (const d of [180, 300, 420]) {
      const o = document.createElement('div');
      o.className = 'pm-orbit';
      o.style.width = `${d}px`;
      o.style.height = `${d}px`;
      skyEl.appendChild(o);
    }
    for (let i = 0; i < 48; i += 1) {
      const s = document.createElement('span');
      s.className = 'pm-speck';
      const size = 2.5 + rnd() * 2.5;
      s.style.width = `${size.toFixed(1)}px`;
      s.style.height = `${size.toFixed(1)}px`;
      s.style.left = `${(2 + rnd() * 96).toFixed(1)}%`;
      s.style.top = `${(4 + rnd() * 92).toFixed(1)}%`;
      s.style.opacity = (0.22 + rnd() * 0.3).toFixed(2);
      skyEl.appendChild(s);
    }

    const core = document.createElement('div');
    core.className = 'pm-core';
    skyEl.appendChild(core);

    const stage = { w: skyEl.clientWidth || 400, h: skyEl.clientHeight || 420 };
    const ring = ringFor(stage.w, stage.h);
    const maxMembers = clusters[0].members.length;
    clusters.forEach((c, i) => {
      skyEl.appendChild(clusterEl(c, i, clusters.length, maxMembers, ring, stage));
    });

    // BOTH caps, said out loud. The server caps the year's rows, and the ring
    // holds four bubbles — either one silently makes this picture look like the
    // whole year when it is a top slice of it.
    const bits = [];
    if (data.total > data.people.length) {
      bits.push(`the top ${data.people.length} of ${data.total} people`);
    }
    if (all.length > clusters.length) {
      bits.push(`${clusters.length} of ${all.length} topics`);
    }
    if (bits.length) {
      const note = document.createElement('div');
      note.className = 'pm-sky-note';
      note.textContent = `showing ${bits.join(' · ')} in ${year}`;
      skyEl.appendChild(note);
    }
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
    // Into whichever surface is actually up. Writing it unconditionally to the
    // list meant a tab click from the constellation looked like nothing had
    // happened — the old year's bubbles just sat there until the fetch landed.
    surface().innerHTML = `<div class="pm-loading">loading ${year}…</div>`;
    const res = await hzPost('peopleYear', { year });
    if (my !== reqId) return; // superseded by a newer tab click
    if (!res || !Array.isArray(res.people)) throw new Error('bad year payload');
    cache.set(year, res);
    if (Array.isArray(res.years) && res.years.length) years = res.years;
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
      surface().innerHTML = `<div class="pl-empty">couldn’t load ${y} — click its tab to retry</div>`;
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
    if (!b) return;
    if (b.dataset.view === 'sky') {
      view = 'sky';
      render();
      return;
    }
    if (!b.dataset.y) return;
    // A year tab is also the way BACK from the globe, so it has to switch the
    // view even when the year itself has not changed — otherwise clicking the
    // already-open year while the constellation is up does nothing at all.
    view = 'list';
    const y = Number(b.dataset.y);
    if (y === year && cache.has(y)) { render(); return; }
    loadOrFail(y);
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
  let t = null;
  searchEl.addEventListener('input', () => { clearTimeout(t); t = setTimeout(render, 90); });
  if (closeEl) closeEl.addEventListener('click', () => { hzSfx.close(); hzPost('close').catch(() => {}); });

  loadOrFail(year);
})();
