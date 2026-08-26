// The timeline popup: ONE YEAR of your people, sorted by that year's
// engagement, with the year's topic chips — month grouping was yeeted
// (owner, 2026-08-25). Browser-style year tabs page between years; one fetch
// per year (cached, dropped on every panel re-open via __hzRefresh). Search
// is SERVER-SIDE and crosses every year (the filter row was yeeted — owner,
// 2026-08-25): filtering the open year's loaded list could not reach a person
// in another year, nor one past the 250 that list holds, which is most of them
// once history lands. Expanding a row shows one
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
  const recencyEl = document.getElementById('recency');
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
  // 'year' = one year, from /people/year. 'all' = every year at once, from
  // /people/map. The constellation is ALWAYS 'all' (owner, 2026-08-25): a
  // person's topics are a thing about the relationship, not about a calendar
  // year, and slicing them by year made the same friend appear and vanish
  // between tabs.
  // 'all' | 'in' | 'quiet'. Defaults to 'all': the globe's identity is
  // everyone-you-know, so the chip's job is to ASK the recency question, not to
  // answer it on the owner's behalf. Defaulting to 'in' would open on 759 of
  // 2,604 stars and read as a much emptier corpus than it is.
  let recency = 'all';
  let scope = 'year';
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
  // Search state. `findRows` is null when not searching, so an empty ARRAY can
  // honestly mean "nobody matches" rather than "no search has run".
  let findTerm = '';
  let findRows = null;
  let findState = 'idle'; // 'pending' | 'done' | 'degraded'
  let findCapped = false; // the corpus scan hit its row ceiling; counts are a floor
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

  function detailHtml(p, y) {
    const bits = [];
    const sk = `${p.key}|${y}`;
    const sum = summaries.get(sk);
    // The summary is always ABOUT ONE YEAR — that is what /people/summary
    // takes. Outside a year tab it covers the last year this person was
    // active, and says so, because an unlabelled paragraph under an all-years
    // row would read as a summary of the whole relationship.
    const tag = scope === 'all' ? `· ${y}, written by the local model` : '· written by the local model';
    if (sum && sum.state === 'pending') {
      bits.push(`<div class="pl-d pm-sum pm-sum-wait">summarizing ${y}…</div>`);
    } else if (sum && sum.state === 'done') {
      bits.push(`<div class="pl-d pm-sum">${esc(sum.text)} <span class="pm-sum-tag">${tag}</span></div>`);
    } else if (sum && sum.state === 'none') {
      bits.push(`<div class="pl-d pl-dim">no summary — ${esc(sum.reason)}</div>`);
    }
    if (!bits.length) bits.push('<div class="pl-d pl-dim">…</div>');
    return `<div class="pl-detail">${bits.join('')}</div>`;
  }

  // `y` is the row's own year, which in search results is NOT the open tab --
  // a person found in 2021 must carry 2021, or their summary and their message
  // count would be fetched for a year they were never in.
  // WHY THIS PERSON IS IN A SEARCH RESULT. A row that matched on what you talked
  // about is otherwise indistinguishable from a row that matched on their name,
  // and the corpus tier can surface somebody whose name looks nothing like the
  // query -- without this the list reads as broken.
  function whyHtml(p) {
    if (!findTerm) return '';
    if (p.matchField === 'content' && p.evidence) {
      const { messages: m, conversations: c } = p.evidence;
      return `<span class="pm-why">${m} msg${m === 1 ? '' : 's'} · ${c} conversation${c === 1 ? '' : 's'}</span>`;
    }
    const label = { identifier: 'matched their handle', topic: 'a topic of theirs',
                    fuzzy: 'close to their name' }[p.matchField];
    return label ? `<span class="pm-why">${label}</span>` : '';
  }

  // The line that put this person in the list. Bounded and prepared by the
  // server (people/content.mjs); escaped here like everything else, because it
  // is somebody's own words and must never be able to act as markup.
  function excerptHtml(p) {
    const e = findTerm && p.matchField === 'content' ? p.evidence?.excerpt : null;
    if (!e || !e.text) return '';
    return (
      `<div class="pm-quote">` +
        `<span class="pm-quote-who">${e.fromMe ? 'you' : 'them'}${e.room ? ' · in a group' : ''}</span>` +
        `<span class="pm-quote-text">${esc(e.text)}</span>` +
      `</div>`
    );
  }

  function rowHtml(p, y) {
    // Five chips is the row's budget. The all-years union can carry more than
    // that, so the slice lives here rather than in the data — clustering needs
    // every topic a person belongs to, the row only needs the loudest five.
    const chips = (p.topics || []).slice(0, 5)
      .map((t) => `<span class="pl-chip pl-topic">${esc(t.label)}</span>`)
      .join('');
    const rowKey = `${p.key}|${y}`;
    const open = expanded === rowKey;
    const srcIcons = (p.channels || [])
      .map((c) => `<span class="pm-src-ic" data-tip="${esc(CHAN_LABEL[c] || c)}">${hzGlyph(c)}</span>`)
      .join('');
    return (
      `<div class="pl-row${open ? ' open' : ''}" data-rk="${esc(rowKey)}">` +
        `<div class="pl-main">` +
          `<div class="pl-nameline">` +
            `<span class="pl-name">${esc(p.name)}</span>` +
            // TWO NUMBERS, because they answer different questions. "msgs" is
            // what passed between the two of you; "in rooms" is what they said
            // in a group you were also in. Folding the second into the first is
            // what made someone you have never messaged look like a friend.
            (p.messages > 0
              ? `<span class="pm-msgs">${p.messages} msg${p.messages === 1 ? '' : 's'}</span>`
              : '') +
            (p.roomMessages > 0
              ? `<span class="pm-msgs pm-room-msgs">${p.roomMessages} in rooms</span>`
              : '') +
            (y === year ? '' : `<span class="pm-yr-badge">${y}</span>`) +
            // ONLY EVER IN A ROOM. Until now these rendered exactly like people
            // the owner actually talks to, which is what made every nudge about
            // them untrustworthy.
            (p.roomOnly ? '<span class="pm-room-badge" data-tip="you have never exchanged a direct message">only in group chats</span>' : '') +
            whyHtml(p) +
            srcIcons +
          `</div>` +
          excerptHtml(p) +
          (chips ? `<div class="pl-src pm-chip-row">${chips}</div>` : '') +
          (open ? detailHtml(p, y) : '') +
        `</div>` +
      `</div>`
    );
  }

  // A topic narrows the list only — a constellation of one topic is a circle.
  // NAME MATCHING IS NOT HERE ANY MORE: search is server-side and crosses every
  // year, so filtering the loaded rows would quietly re-impose the limit that
  // change removed. Order is the server's: most engaged first.
  function visible(data) {
    let rows = data.people;
    // The topic applies to the LIST ONLY. Filtering the sky by one topic
    // leaves a constellation with a single circle in it — and when a restored
    // state paired 'sky' with a topic, it left NO circles and the page claimed
    // the year had nothing to group. Enforced here rather than trusted to
    // every caller clearing it at the right moment.
    if (topic && view === 'list') {
      rows = rows.filter((p) => (p.topics || []).some((t) => t && t.label === topic));
    }
    // RECENCY APPLIES TO BOTH VIEWS, unlike topic. visible() is the single input
    // to the list and to the sky, so filtering here is what makes the two agree
    // by construction rather than by two call sites remembering to match.
    //
    // On presenceDays, never recencyDays: recencyDays is null for all 467
    // room-only people by design, so a filter on it would silently delete the
    // exact cohort the room work made visible. See the two-clocks comment in
    // ui/server/people/map.mjs.
    if (recency === 'in') {
      rows = rows.filter((p) => presenceOf(p) != null && presenceOf(p) < RECENT_DAYS);
    } else if (recency === 'quiet') {
      rows = rows.filter((p) => { const d = presenceOf(p); return d == null || d >= RECENT_DAYS; });
    }
    return rows;
  }

  // A YEAR, because that is the boundary the eye already uses ("did I see them
  // this year") and because it splits this corpus into two usable halves rather
  // than one big one and a sliver.
  const RECENT_DAYS = 365;

  // Server-computed, with a client fallback for a payload that predates the
  // field — the same shape as the topicsAreMarked detect below, and the reason
  // for it is the same: an app bundle and a backend ship by different routes, so
  // one can be newer than the other. Treating `undefined` as a value would put
  // every star in "gone quiet" on an older server.
  function presenceOf(p) {
    if (typeof p.presenceDays === 'number') return p.presenceDays;
    if (typeof p.recencyDays === 'number') return p.recencyDays;
    if (typeof p.lastSeen === 'number') return Math.max(0, Math.floor((Date.now() - p.lastSeen) / 86400000));
    return null;
  }

  // THE RECENCY SEGMENTS. Three states, each printing its own count, so the
  // control can never be silently on -- a filtered globe that looks like a small
  // corpus is the failure this is guarding against.
  //
  // Globe only: yearCore's rows carry no recency field at all (the year view is
  // built from month buckets, not from the graph person), so the chip would have
  // nothing to filter on inside a year tab. Gated rather than hidden-and-hoped.
  function renderRecency(data) {
    const show = scope === 'all' && !findTerm && Array.isArray(data?.people);
    recencyEl.hidden = !show;
    if (!show) { recencyEl.replaceChildren(); return; }
    const all = data.people;
    const n = (f) => all.filter(f).length;
    const states = [
      { id: 'all', label: 'everyone', count: all.length },
      { id: 'in', label: 'in touch', count: n((p) => presenceOf(p) != null && presenceOf(p) < RECENT_DAYS) },
      { id: 'quiet', label: 'gone quiet', count: n((p) => { const d = presenceOf(p); return d == null || d >= RECENT_DAYS; }) },
    ];
    recencyEl.replaceChildren(...states.map((st) => {
      const b = document.createElement('button');
      b.className = `pm-rec${st.id === recency ? ' active' : ''}`;
      b.dataset.rec = st.id;
      b.textContent = `${st.label} ${st.count}`;
      // "in touch" means seen anywhere, group chats included -- say so, because
      // the number is bigger than a reader expecting direct contact would guess.
      b.title = st.id === 'in' ? 'seen in the last year, group chats included'
        : st.id === 'quiet' ? 'nothing for a year or more, anywhere'
        : 'no recency filter';
      return b;
    }));
  }

  // The chip that says which topic the list is standing in, and the way out of
  // it. Without it a filtered list is indistinguishable from a short year.
  function renderFilter(count) {
    // Same rule as visible(): a topic is a thing the list is standing in, so
    // the chip has no business hanging over the constellation.
    const show = topic && view === 'list';
    filterEl.hidden = !show;
    if (!show) { filterEl.replaceChildren(); return; }
    const chip = document.createElement('button');
    chip.className = 'pm-filter-chip';
    chip.type = 'button';
    const label = document.createElement('span');
    label.textContent = `${topic.toUpperCase()} · ${count}`;
    const x = document.createElement('span');
    x.className = 'pm-filter-x';
    x.textContent = '×';
    chip.append(label, x);
    // Back to the constellation, not to a bare list: without the topic this
    // list is every person in every year, which is thousands of rows nobody
    // asked for. You came from the sky; the way out is back to it.
    chip.addEventListener('click', () => { topic = null; view = 'sky'; render(); });
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
    // Also stand down inside a topic and in all-years: the cards are claims
    // about ONE year — that is what the server computed them over — and
    // sitting them above an all-years or topic list misattributes them.
    const show = hs.length > 0 && !findTerm && view === 'list'
      && !topic && scope === 'year';
    cardsEl.hidden = !show;
    cardsEl.innerHTML = show ? hs.map(cardHtml).join('') : '';
  }

  function renderList(data, rows) {
    const where = scope === 'all' ? 'any year' : String(year);
    const empty = topic
      ? `no one in ${esc(topic)} in ${where}`
      : `no one matches in ${where}`;
    // The row's own year: in all-years each person carries the last year they
    // were active, so their summary is fetched for a year they appear in.
    listEl.innerHTML = rows.map((pp) => rowHtml(pp, scope === 'all' ? (pp.latestYear || year) : year)).join('')
      || `<div class="pl-empty">${empty}</div>`;
    // The overflow line counts one year's rows, so it has no meaning under a
    // topic-filtered list, a search, or the uncapped all-years set.
    if (scope === 'year' && !findTerm && !topic && data.total > data.people.length) {
      listEl.insertAdjacentHTML('beforeend',
        `<div class="pl-more">+ ${data.total - data.people.length} more in ${year} — search reaches all of them</div>`);
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
  // the obvious next question is "who". Stays in scope 'all', so the list is
  // everyone who has ever talked to you about it and the count matches the
  // number printed on the bubble.
  function openTopic(label) {
    topic = label;
    view = 'list';
    scope = 'all';
    render();
  }

  function render() {
    // A SEARCH TAKES OVER, whatever was up. It is server-side and spans every
    // year, so it belongs to neither the open tab nor the constellation — and
    // a sky filtered to one query would be a single circle.
    if (findTerm) {
      listEl.hidden = false;
      skyEl.hidden = true;
      cardsEl.hidden = true;
      // EMPTIED, not just flagged. `hidden` alone left the chip in the DOM and
      // clickable (its author-origin `display: flex` beat the UA [hidden] rule --
      // fixed in CSS too), so a click silently moved the page underneath a screen
      // that does not change. A control that cannot act should not exist.
      filterEl.hidden = true;
      filterEl.replaceChildren();
      renderRecency(null);
      renderFind();
      saveView();
      return;
    }
    if (scope === 'all') {
      if (!mapData) {
        renderTabs();
        cardsEl.hidden = true;
        filterEl.hidden = true;
        surface().innerHTML = '<div class="pm-loading">reading every year…</div>';
        // A THROW INSIDE render() IS NOT A FETCH FAILURE, and this used to report
        // it as one: any error from visible/renderSky/renderRecency arrived here
        // and printed "couldn't read your years", which sends the reader to their
        // network and their corpus for a bug in a renderer. The two causes now
        // read differently, and the message carries the reason -- a globe that
        // fails by going quiet costs more to diagnose than it does to build.
        ensureMap()
          .then(() => {
            try {
              render();
            } catch (err) {
              surface().innerHTML =
                `<div class="pl-empty">couldn’t draw the globe — ${esc(String(err && err.message || err))}</div>`;
            }
          })
          .catch((err) => {
            surface().innerHTML =
              `<div class="pl-empty">couldn’t read your years — ${esc(String(err && err.message || err))}</div>`;
          });
        return;
      }
      return paint(mapData);
    }
    const data = cache.get(year);
    if (!data) return;
    paint(data);
  }

  function paint(data) {
    const rows = visible(data);
    surface();
    renderCards(data);
    renderFilter(rows.length);
    // Counts come from the UNFILTERED data so each segment says how many it
    // would show, not how many are showing now.
    renderRecency(data);
    if (view === 'sky') renderSky(data, rows);
    else renderList(data, rows);
    // One placeholder, because search now means the same thing everywhere:
    // every person, every year, ranked by the server. Naming the open year
    // here would say the box only reaches it.
    searchEl.placeholder = 'search everyone, every year…';
    renderTabs();
    saveView();
  }

  // Browser-style year tabs: oldest left, newest right, the open one active,
  // and the globe last — a view rather than a year, but it lives on the same
  // strip because it shows the same year.
  const GLOBE_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="12" cy="12" r="9"></circle><path d="M3 12h18"></path>' +
    '<path d="M12 3a14 14 0 0 0 0 18a14 14 0 0 0 0-18"></path></svg>';

  // Search results: ranked by the server across every year, each row carrying
  // the year it was found in.
  function renderFind() {
    if (findRows === null) {
      listEl.innerHTML = `<div class="pm-loading">searching…</div>`;
      renderTabs();
      return;
    }
    const head = findState === 'degraded'
      ? `<div class="pl-more">couldn’t reach search — showing matches from the years already loaded</div>`
      : '';
    listEl.innerHTML = head + (findRows.map((p) => rowHtml(p, p.year)).join('')
      || `<div class="pl-empty">no one matches “${esc(findTerm)}”</div>`);
    searchEl.placeholder = 'search everyone, every year…';
    renderTabs();
  }

  // Ask the server. reqId guards the race the same way the year loader does:
  // typing fast means several in flight, and only the newest may paint.
  let findId = 0;
  function runFind(term) {
    const my = ++findId;
    findRows = null;
    findState = 'pending';
    render();
    hzPost('peopleFind', { q: term })
      .then((res) => {
        if (my !== findId) return; // superseded by a later keystroke
        if (!res || !Array.isArray(res.people)) throw new Error('bad find payload');
        findRows = res.people;
        findState = 'done';
        findCapped = res.capped === true;
        if (Array.isArray(res.years) && res.years.length) years = res.years;
        render();
      })
      .catch(() => {
        if (my !== findId) return;
        // DEGRADE HONESTLY. Falling back to the cached years silently would
        // report "no one matches" for people the server would have found, so
        // renderFind says which answer this is.
        const q = term.toLowerCase();
        const seen = new Set();
        const rows = [];
        for (const [y, data] of cache) {
          for (const p of data.people || []) {
            if (seen.has(p.key)) continue;
            if (!(p.name || '').toLowerCase().includes(q)) continue;
            seen.add(p.key);
            rows.push({ ...p, year: y });
          }
        }
        findRows = rows;
        findState = 'degraded';
        findCapped = false;
        render();
      });
  }

  // Browser-style year tabs: oldest left, newest right, the open one active,
  // and the globe last — all-years rather than a year, but on the same strip
  // because it is the same surface.
  function renderTabs() {
    const ys = years.length ? years : [year];
    tabsEl.replaceChildren();
    for (const y of ys) {
      const b = document.createElement('button');
      // Lit only when a YEAR is what is on screen. The globe and everything
      // reached from it are all-years, so no single year is the answer there —
      // an earlier cut marked one anyway and it read as though clicking a
      // bubble had moved you to that year.
      b.className = 'pm-tab' + (y === year && scope === 'year' ? ' active' : '');
      b.dataset.y = String(y);
      b.textContent = String(y);
      tabsEl.appendChild(b);
    }
    const g = document.createElement('button');
    // Stays lit for the topic LIST as well as the constellation: both are
    // all-years and both were reached through here, so this is where you are.
    // No data-tip — its hover bubble is laid out 25px below the strip, which
    // (with overflow-y promoted to auto by the horizontal scroll) made the
    // whole tab row vertically scrollable.
    g.className = 'pm-tab pm-tab-globe' + (scope === 'all' ? ' active' : '');
    g.dataset.view = 'sky';
    g.setAttribute('aria-label', 'every year by topic');
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
        // NAME THE CAUSE. The old sentence blamed the year, which is wrong on an
        // all-years globe and wrong again when a filter is what emptied it —
        // leaving the owner to conclude the corpus is thin.
        ? (recency !== 'all'
            ? `nothing to group among the ${recency === 'in' ? 'in touch' : 'gone quiet'} — try everyone`
            : scope === 'all'
              ? `nothing shared enough to group — a topic needs at least ${MIN_CLUSTER} people`
              : `nothing shared enough to group in ${year} — a topic needs at least ${MIN_CLUSTER} people`)
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
    // NO FOOTNOTE (owner, 2026-08-25). It carried two disclosures and both had
    // stopped being true of this surface: the row cap belonged to /people/year
    // and the constellation no longer reads from there, and the year belonged
    // to a per-year sky that no longer exists. What remains is the topic cap,
    // and the bubbles that fit are the largest ones — see fitLayout.
  }

  // ---- every year at once ----
  // /people/map is the whole graph: every person, UNCAPPED, each carrying
  // their per-year topic chips. The constellation reads from here rather than
  // summing the year payloads, and the reason is arithmetic — /people/year
  // caps at 250 rows, so a sum of capped pages would print topic counts that
  // are quietly short while looking exact.
  //
  // Adapted into the row shape the year payload already uses, so one renderer
  // serves both surfaces.
  let mapData = null;
  let mapPending = null;

  function adaptMap(payload) {
    const people = [];
    for (const p of payload.people || []) {
      const byLabel = new Map();
      let latestYear = null;
      for (const y of p.years || []) {
        if (latestYear === null || y.year > latestYear) latestYear = y.year;
        for (const t of y.topics || []) {
          if (!t || !t.label) continue;
          const cur = byLabel.get(t.label);
          if (cur) cur.n += t.n || 0;
          else byLabel.set(t.label, { label: t.label, n: t.n || 0, tax: t.tax });
        }
      }
      // PRESENCE DECIDES WHETHER TO DRAW SOMEBODY, contact decides where.
      //
      // `messages` became direct-only, so `messages <= 0` quietly went from "we
      // have no history" to "we have never exchanged a direct message" -- and
      // dropped 552 people off this surface, 467 of them the room-only ones the
      // badge exists to show. A globe of "everyone you know" that omits the
      // people you only know from group chats is answering a different question
      // than the one it is labelled with.
      const messages = p.messages || 0;
      const roomMessages = p.roomMessages || 0;
      if (messages <= 0 && roomMessages <= 0) continue;
      people.push({
        key: p.key,
        name: p.name,
        channels: p.channels || [],
        messages,
        roomMessages,
        roomOnly: p.roomOnly === true,
        // Whitelisted through, or the recency filter has nothing to read.
        presenceDays: typeof p.presenceDays === 'number' ? p.presenceDays : null,
        lastSeen: typeof p.lastSeen === 'number' ? p.lastSeen : null,
        // Ordering is still by direct contact: room volume must not buy a
        // bigger star with other people's conversations.
        engagement: messages,
        // The FULL union, not a top-five slice: the chips show five, but the
        // clustering needs every topic a person belongs to or bubbles would
        // lose members for no reason a reader could see.
        topics: [...byLabel.values()].sort((a, b) => b.n - a.n),
        // Which year to summarise when a row is opened outside a year tab.
        latestYear,
      });
    }
    people.sort((a, b) => b.engagement - a.engagement);
    return { people, total: people.length, allYears: true };
  }

  function ensureMap() {
    if (mapData) return Promise.resolve(mapData);
    if (!mapPending) {
      mapPending = hzPost('peopleMap')
        .then((r) => { mapData = adaptMap(r || {}); return mapData; })
        .finally(() => { mapPending = null; });
    }
    return mapPending;
  }

  // ---- remembering where you were ----
  // Closing the popup already returns you here, because the panel survives
  // hidden with its page state intact. A RESTART does not: the page is built
  // again and `year` goes back to today's, which is why quitting and reopening
  // landed on this year with nothing selected.
  //
  // One compact string rather than a JSON blob: native stores it opaquely and
  // bounds its length, and three fields do not need a schema on the far side.
  let saveTimer = null;
  function saveView() {
    clearTimeout(saveTimer);
    // Debounced: render() runs on every keystroke of a search, and each save is
    // a UserDefaults write.
    saveTimer = setTimeout(() => {
      hzPost('monthsView', { state: `${year}|${view}|${topic || ''}|${scope}|${recency}` }).catch(() => {});
    }, 250);
  }

  // Returns the remembered year, or null. view/topic are applied as a side
  // effect because they need no validation against the server's answer — a
  // stale topic simply filters to nothing and the chip offers the way out.
  async function restoreView() {
    let saved = null;
    try {
      const r = await hzPost('monthsView', {});
      saved = r && typeof r.state === 'string' ? r.state : null;
    } catch {
      return null; // no memory is not an error; start on this year
    }
    if (!saved) return null;
    const [y, v, t, s, r] = saved.split('|');
    const n = Number(y);
    // Trust nothing that came back: the value outlives the code that wrote it,
    // and a year the corpus no longer has would strand the page on an empty
    // tab it cannot explain. A three-field value predates the scope field and
    // reads as scope 'year', which is what it meant.
    if (v === 'sky' || v === 'list') view = v;
    scope = s === 'all' ? 'all' : 'year';
    // The constellation IS all-years, so these two cannot disagree.
    if (view === 'sky') scope = 'all';
    // A topic belongs to the list. Never restore one alongside the globe —
    // saveView cannot produce that pair, but a hand-edited or older value can,
    // and it is one line to refuse rather than reason about downstream.
    topic = view === 'list' && t ? t : null;
    // A fifth field is absent from every value written before this existed, and
    // anything unrecognised means no filter -- the safe state, since it is the
    // one that hides nobody.
    recency = r === 'in' || r === 'quiet' ? r : 'all';
    return Number.isInteger(n) && n >= 1990 && n <= new Date().getFullYear() + 1 ? n : null;
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
    mapData = null;
    prefetching = false;
    // A re-open drops the search as well as the cache: a stale query over
    // refetched years would be answering a question nobody is asking now.
    findId++;
    findTerm = '';
    findRows = null;
    findState = 'idle';
    searchEl.value = '';
    // Re-open where the panel was left: in all-years the year fetch is not
    // what is on screen, and loading it would flip the view back to a year.
    if (scope === 'all') render();
    else loadOrFail(year);
  };

  tabsEl.addEventListener('click', (e) => {
    const b = e.target.closest('.pm-tab');
    if (!b) return;
    if (b.dataset.view === 'sky') {
      view = 'sky';
      scope = 'all';
      // Arriving with a topic still selected would show a field where every
      // bubble but the chosen one was missing.
      topic = null;
      render();
      return;
    }
    if (!b.dataset.y) return;
    // A year tab is also the way BACK from the globe, so it has to switch both
    // the view and the scope even when the year itself has not changed —
    // otherwise clicking the already-open year from the constellation does
    // nothing at all.
    view = 'list';
    scope = 'year';
    topic = null;
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
      const cut = rk.lastIndexOf('|');
      const key = rk.slice(0, cut);
      // The row's own year -- a 2021 result summarised against the open tab
      // would be a summary of a year that person may not appear in at all.
      const rowYear = Number(rk.slice(cut + 1)) || year;
      requestSummary(key, rowYear);
    }
    render();
  });
  skyEl.addEventListener('click', (e) => {
    const c = e.target.closest('.pm-cluster');
    if (!c || !c.dataset.topic) return;
    hzSfx.squish();
    openTopic(c.dataset.topic);
  });
  recencyEl.addEventListener('click', (e) => {
    const b = e.target.closest('.pm-rec');
    if (!b || !b.dataset.rec || b.dataset.rec === recency) return;
    recency = b.dataset.rec;
    render();
  });
  syncEl.addEventListener('click', () => { hzPost('openPeople').catch(() => {}); });
  let t = null;
  searchEl.addEventListener('input', () => {
    clearTimeout(t);
    const term = searchEl.value.trim();
    if (term === findTerm) return;
    findTerm = term;
    if (!term) {
      findId++; // any in-flight search must not paint over the year list
      findRows = null;
      findState = 'idle';
      render();
      return;
    }
    // Longer than the old 90ms because each keystroke is now a round trip.
    t = setTimeout(() => runFind(term), 160);
  });
  if (closeEl) closeEl.addEventListener('click', () => { hzSfx.close(); hzPost('close').catch(() => {}); });

  // Resume where the popup was left, then fetch. The restore has to land
  // BEFORE the first load or the page would fetch this year, paint it, and
  // then visibly jump to the remembered one.
  restoreView()
    .then((y) => { if (y !== null) year = y; })
    .catch(() => {})
    .finally(() => {
      // All-years does not want the year fetch painted over it.
      if (scope === 'all') render();
      else loadOrFail(year);
    });
})();
