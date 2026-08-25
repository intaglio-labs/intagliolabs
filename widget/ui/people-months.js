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
  const cardsEl = document.getElementById('cards');
  const filterEl = document.getElementById('filter');
  if (!listEl) return;

  // 'list' = the year by person, 'sky' = the same year by topic. A VIEW, not a
  // year: the year tabs stay live in both, so the globe is the last tab rather
  // than a second window.
  let view = 'list';
  // The topic a bubble was clicked into, or null. Only the list honours it —
  // filtering the constellation to one topic would just draw that one circle.
  let topic = null;

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

  // Search narrows both views; a topic narrows only the list, because a
  // constellation of one topic is a circle. Order is the server's: most
  // engaged first.
  function visible(data) {
    const term = searchEl.value.trim().toLowerCase();
    let rows = data.people;
    if (topic) rows = rows.filter((p) => (p.topics || []).some((t) => t && t.label === topic));
    if (term) rows = rows.filter((p) => (p.name || '').toLowerCase().includes(term));
    return rows;
  }

  // The chip that says which topic the list is standing in, and the way out of
  // it. Without it a filtered list is indistinguishable from a short year.
  function renderFilter(count) {
    filterEl.hidden = !topic;
    if (!topic) { filterEl.replaceChildren(); return; }
    const chip = document.createElement('button');
    chip.className = 'pm-filter-chip';
    chip.type = 'button';
    const label = document.createElement('span');
    label.textContent = `${topic.toUpperCase()} · ${count}`;
    const x = document.createElement('span');
    x.className = 'pm-filter-x';
    x.textContent = '×';
    chip.append(label, x);
    chip.addEventListener('click', () => { topic = null; render(); });
    filterEl.replaceChildren(chip);
  }

  // One glyph per card kind. Keyed by the server's `kind`, with a fallback, so
  // a server that grows a sixth card renders as a nameless-but-present card
  // rather than throwing.
  const CARD_ICON = {
    'person-of-the-year':
      '<path d="M8 4h8v5a4 4 0 0 1-8 0V4Z"></path><path d="M8 5H5v2a3 3 0 0 0 3 3"></path>' +
      '<path d="M16 5h3v2a3 3 0 0 1-3 3"></path><path d="M12 13v4"></path><path d="M9 20h6"></path>',
    'back-from-your-past':
      '<circle cx="12" cy="12" r="8"></circle><path d="M12 7v5l3 2"></path>',
    'rising-star':
      '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z"></path>',
    drifting:
      '<path d="M4 8h10"></path><path d="M4 13h7"></path><path d="M4 18h4"></path>' +
      '<path d="M17 13v6"></path><path d="M14.5 16.5 17 19l2.5-2.5"></path>',
    streak:
      '<path d="M12 3s5 4.2 5 9a5 5 0 0 1-10 0c0-4.8 5-9 5-9Z"></path>' +
      '<path d="M12 20a2.6 2.6 0 0 1-2.6-2.6c0-1.6 2.6-3.9 2.6-3.9s2.6 2.3 2.6 3.9A2.6 2.6 0 0 1 12 20Z"></path>',
  };
  const FALLBACK_ICON = '<circle cx="12" cy="12" r="7"></circle>';

  function cardHtml(h, i) {
    const icon = CARD_ICON[h.kind] || FALLBACK_ICON;
    return (
      `<div class="pm-card${i === 0 ? ' lead' : ''}">` +
        '<div class="pm-card-eyebrow">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
          `stroke-linecap="round" stroke-linejoin="round">${icon}</svg>` +
          `<span>${esc(h.label)}</span>` +
        '</div>' +
        '<div class="pm-card-who">' +
          `<span class="pm-card-face">${esc(initials(h.name))}</span>` +
          `<span class="pm-card-name">${esc(h.name)}</span>` +
        '</div>' +
        `<div class="pm-card-line">${esc(h.line)}</div>` +
      '</div>'
    );
  }

  // Cards describe the YEAR, not the filtered set, so they step aside while a
  // search is running — a card about someone the search excluded reads as a
  // bug. An older backend sends no highlights at all; then there is simply no
  // row, which is the honest result rather than an empty frame.
  function renderCards(data) {
    const hs = Array.isArray(data.highlights) ? data.highlights : [];
    // Also stand down inside a topic: "person of the year" is a claim about the
    // whole year, and sitting it above a list of six travel contacts reads as a
    // claim about travel.
    const show = hs.length > 0 && !searchEl.value.trim() && view === 'list' && !topic;
    cardsEl.hidden = !show;
    cardsEl.innerHTML = show ? hs.map(cardHtml).join('') : '';
  }

  function renderList(data, rows) {
    const empty = topic
      ? `no one in ${esc(topic)} in ${year}`
      : `no one matches in ${year}`;
    listEl.innerHTML = rows.map(rowHtml).join('') || `<div class="pl-empty">${empty}</div>`;
    // The overflow line counts the whole year, so it would be a non-sequitur
    // under a topic-filtered or searched list.
    if (!searchEl.value.trim() && !topic && data.total > data.people.length) {
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

  // Opening a bubble IS opening its list — the sky answers "about what", and
  // the obvious next question is "who". Clearing the topic leaves you in the
  // list rather than bouncing back to the globe: by then you came for a person.
  function openTopic(label) {
    topic = label;
    view = 'list';
    render();
  }

  function render() {
    const data = cache.get(year);
    if (!data) return;
    const rows = visible(data);
    surface();
    renderCards(data);
    renderFilter(rows.length);
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
      // TWO states, and the second one exists because leaving it out was a bug.
      // `active` is the lifted tab the list belongs to. `current` is the year
      // still being looked at while the globe is up — without it the whole
      // strip went unmarked in the sky view, the constellation said nothing
      // about which year it was drawing, and clicking a bubble looked like it
      // had jumped you to some other year rather than revealing the one you
      // were already on.
      const isYear = y === year;
      b.className = 'pm-tab'
        + (isYear && view === 'list' ? ' active' : '')
        + (isYear && view === 'sky' ? ' current' : '');
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
  // HOW MANY BUBBLES FIT IS SOLVED, NOT CHOSEN. This was a flat 4, which was
  // only ever right for the ~400px panel it was measured on — a scaled-up
  // window has room for more and was still being given four.
  //
  // n bubbles of diameter d on a ring of radius r are 2r*sin(pi/n) apart
  // (chord, not arc — arc overstates the gap and lets them touch), and that
  // must be at least d. The ring must also fit: r <= R - d/2 - margin, where R
  // is the stage's half-minor-axis. Substituting one into the other and
  // solving for d gives the most a given n can afford:
  //
  //     d(n) = 2*sin(pi/n) * (R - margin) / (1 + sin(pi/n))
  //
  // So: try the most bubbles we would ever want, shrink them to fit, and stop
  // at the first n whose bubbles are still big enough to hold faces. On a
  // 400px panel that lands back on 4, which is what the design shows.
  const CLUSTER_HARD_CAP = 8; // past this the labels collide and it reads as confetti
  const MIN_CLUSTER = 2;
  const MAX_FACES = 5;
  const RING_MARGIN = 8;
  // The floor is not cosmetic — six discs wrap to a second row, where a circle
  // is much narrower than its diameter, and below this the "+N" chip pushes out
  // through the dashed border. Measured, not guessed.
  const D_FLOOR = 118;
  const D_CEIL = 162;

  // { n, d }: how many bubbles this stage holds, and how big they may be.
  function fitLayout(stageW, stageH, wanted) {
    const R = Math.min(stageW, stageH) / 2;
    const most = Math.max(1, Math.min(wanted, CLUSTER_HARD_CAP));
    for (let n = most; n > 1; n -= 1) {
      const s = Math.sin(Math.PI / n);
      // 0.97 rather than the exact bound: the ring is an ELLIPSE, and the
      // circle-based solve is only near-exact on a square stage. Measured gaps
      // came out at 1-3px on tall panels without it.
      const d = Math.min(D_CEIL, (2 * s * (R - RING_MARGIN) * 0.97) / (1 + s));
      if (d >= D_FLOOR) return { n, d: Math.round(d) };
    }
    return { n: 1, d: Math.round(Math.min(D_CEIL, Math.max(D_FLOOR, R - RING_MARGIN))) };
  }

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

  // Does this payload carry the server's taxonomy mark at all? The app bundle
  // and the backend the launchd agents run are updated by DIFFERENT routes —
  // widget/build.sh installs the bundle, ops/promote.sh installs the backend —
  // so a newer page talking to an older server is a normal state here, not a
  // broken one. Detected rather than assumed, because the first cut assumed it
  // and rendered an empty sky that read as "you have no topics" when it meant
  // "this server never told me which ones were comparable".
  function topicsAreMarked(people) {
    return people.some((p) => (p.topics || []).some((t) => t && typeof t.tax === 'boolean'));
  }

  // Group by topic. Prefer the server's `tax` mark: the other chips are terms
  // distinctive to a single pair ("tokyo station"), which by construction
  // cannot be shared, so clustering on them yields a bubble of one wearing a
  // stranger's word. Without the mark, fall back to "a label at least
  // MIN_CLUSTER people share" — the same line drawn approximately, since a
  // term distinctive to one pair cannot clear that bar either.
  // A person joins every topic they carry: people are not one thing.
  function clustersFrom(people, marked) {
    const by = new Map();
    for (const p of people) {
      for (const t of p.topics || []) {
        if (!t || !t.label) continue;
        if (marked && !t.tax) continue;
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

  // Face sizes SCALE WITH THE BUBBLE, and that is load-bearing rather than
  // tidy. Held at the design's flat 22..32 they stopped fitting once bubbles
  // shrank to make room for more topics: three 32px discs need ~104px, more
  // than a 127px circle offers at its second row, so they wrapped to three rows
  // and pushed out through the border. Measured — the first cut had a dozen
  // faces outside their circles at 400px. 0.20 * d reproduces 22..32 at the
  // largest bubble, which is where the design's numbers came from.
  function faceScale(d) {
    const max = Math.max(16, Math.min(32, Math.round(d * 0.2)));
    return { max, min: Math.round(max * 0.69) };
  }

  function faceEl(p, maxEngagement, fs) {
    const f = document.createElement('div');
    f.className = 'pm-face';
    const size = Math.round(fs.min + (fs.max - fs.min) * ((p.engagement || 0) / maxEngagement));
    f.style.width = `${size}px`;
    f.style.height = `${size}px`;
    f.style.fontSize = size >= 28 ? '10px' : `${Math.max(7, Math.round(size * 0.34))}px`;
    f.textContent = initials(p.name);
    // data-tip, not title: native tooltips do not fire reliably in a
    // borderless non-activating panel (same reason as the connector glyphs).
    f.setAttribute('data-tip', `${p.name} · ${p.messages} msg${p.messages === 1 ? '' : 's'}`);
    return f;
  }

  // The ring the bubbles sit on, from the same solve — the widest ellipse that
  // still keeps a bubble of diameter d wholly on the stage. The panel is
  // native-sized and the owner can scale it, so a hardcoded radius is a clipped
  // bubble waiting to happen, which is exactly what a fixed 32% did.
  function ringFor(stageW, stageH, d) {
    const half = d / 2 + RING_MARGIN;
    return {
      rx: Math.max(0, stageW / 2 - half),
      ry: Math.max(0, stageH / 2 - half),
    };
  }

  function clusterEl(c, i, count, maxMembers, ring, stage, dMax) {
    const el = document.createElement('div');
    el.className = 'pm-cluster' + (i === 0 ? ' lead' : '');
    el.dataset.topic = c.label;
    // Evenly around the centre, starting upper-left so a four-topic year lands
    // on the diagonals the design draws.
    const ang = -Math.PI * 0.75 + (i * Math.PI * 2) / count;
    // Smaller bubbles scale down from the fitted maximum rather than from a
    // constant, so the whole field shrinks together on a tight panel instead of
    // the big one clipping while the small ones sit in space.
    const dMin = Math.min(dMax, D_FLOOR);
    const d = Math.round(dMin + (dMax - dMin) * (c.members.length / maxMembers));
    el.style.width = `${d}px`;
    el.style.height = `${d}px`;
    // Percentages so the ring still tracks the panel if it is resized under us.
    el.style.left = `${(50 + (Math.cos(ang) * ring.rx * 100) / stage.w).toFixed(1)}%`;
    el.style.top = `${(51 + (Math.sin(ang) * ring.ry * 100) / stage.h).toFixed(1)}%`;

    const faces = document.createElement('div');
    faces.className = 'pm-faces';
    const fs = faceScale(d);
    const shown = c.members.slice(0, MAX_FACES);
    const maxE = Math.max(1, ...shown.map((p) => p.engagement || 0));
    for (const p of shown) faces.appendChild(faceEl(p, maxE, fs));
    const rest = c.members.length - shown.length;
    if (rest > 0) {
      const more = document.createElement('div');
      more.className = 'pm-face pm-face-more';
      more.style.width = `${fs.min}px`;
      more.style.height = `${fs.min}px`;
      more.style.fontSize = `${Math.max(7, Math.round(fs.min * 0.36))}px`;
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
    const marked = topicsAreMarked(people);
    const all = clustersFrom(people, marked);
    const stage = { w: skyEl.clientWidth || 400, h: skyEl.clientHeight || 420 };
    const fit = fitLayout(stage.w, stage.h, all.length);
    const clusters = all.slice(0, fit.n);
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

    const ring = ringFor(stage.w, stage.h, fit.d);
    const maxMembers = clusters[0].members.length;
    clusters.forEach((c, i) => {
      skyEl.appendChild(clusterEl(c, i, clusters.length, maxMembers, ring, stage, fit.d));
    });

    // BOTH caps, said out loud. The server caps the year's rows, and the ring
    // holds four bubbles — either one silently makes this picture look like the
    // whole year when it is a top slice of it.
    const caps = [];
    if (data.total > data.people.length) {
      caps.push(`the top ${data.people.length} of ${data.total} people`);
    }
    if (all.length > clusters.length) {
      caps.push(`${clusters.length} of ${all.length} topics`);
    }
    // The YEAR LEADS, and is printed even when there is nothing to caveat —
    // this was only shown alongside a cap, so a year with nothing to disclose
    // drew a constellation that never said which year it was.
    let text = `${year} by topic`;
    if (caps.length) text += ` — showing ${caps.join(' · ')}`;
    // Say when the grouping is the approximation rather than the server's own
    // labelling, so a slightly-off bubble is explainable instead of puzzling.
    if (!marked) text += ' — topics inferred (this local server predates the topic labels)';
    const note = document.createElement('div');
    note.className = 'pm-sky-note';
    note.textContent = text;
    skyEl.appendChild(note);
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
    // The cards belong to the year being replaced, so they go with it rather
    // than sitting over a loading list making last year's claims.
    cardsEl.hidden = true;
    cardsEl.innerHTML = '';
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
      // The globe is the whole year's topics; arriving with one still selected
      // would show a field where every bubble but the chosen one was missing.
      topic = null;
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
  skyEl.addEventListener('click', (e) => {
    const c = e.target.closest('.pm-cluster');
    if (!c || !c.dataset.topic) return;
    hzSfx.squish();
    openTopic(c.dataset.topic);
  });
  syncEl.addEventListener('click', () => { hzPost('openPeople').catch(() => {}); });
  let t = null;
  searchEl.addEventListener('input', () => { clearTimeout(t); t = setTimeout(render, 90); });
  if (closeEl) closeEl.addEventListener('click', () => { hzSfx.close(); hzPost('close').catch(() => {}); });

  loadOrFail(year);
})();
