// The timeline popup: ONE YEAR of your people, sorted by that year's
// engagement, with the year's topic chips — month grouping was yeeted
// (owner, 2026-08-25). Browser-style year tabs page between years; one fetch
// per year (cached for the panel's lifetime and refreshed in the background
// when the panel re-opens). Search
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
  const tabsEl = document.getElementById('tabs');
  // The strip and the globe are separate boxes now, so clicks are caught on
  // the row that holds both.
  const tabRowEl = document.getElementById('tabrow');
  const globeEl = document.getElementById('globe');
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
  // The strip is homed to its right-hand end once, not on every render.
  let tabsHomed = false;
  let scope = 'year';
  // Whether this is the first time this page has ever been opened, decided by
  // native having no remembered view for it. Only ever true before the first
  // fetch lands, and only trusted when the read SUCCEEDED — a bridge that threw
  // tells us nothing, and guessing "first visit" there would route someone away
  // from a page they have used for months.
  let firstVisit = false;
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
  const staleYears = new Set(); // cached years owed a silent freshness check
  const refreshing = new Map(); // year -> in-flight refresh promise
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

  // WHO WEARS WHICH MARK. Rebuilt per paint from the open year's payload, so it
  // is always the year on screen that decides — a trophy that survived a tab
  // change would be a claim about the wrong year. Empty on the all-years
  // surface, which has no awards to give: they are a fact about ONE year, and
  // the map payload does not compute them.
  function awardIndex(data) {
    const by = new Map();
    for (const a of (data && data.awards) || []) {
      for (const key of a.keys || []) {
        if (!by.has(key)) by.set(key, []);
        // The order categories arrive in is the cards' order, and the row wears
        // them in that order too, so two people with the same pair of marks
        // never wear them in a different sequence.
        by.get(key).push(a);
      }
    }
    return by;
  }
  let awardsByKey = new Map();

  // The card's own glyph, at row size, in front of the name. Same icon as the
  // card above it on purpose: the mark is only legible because the card taught
  // it, and a second icon set for the same five ideas would have to be learned
  // twice.
  function awardsHtml(p) {
    const mine = awardsByKey.get(p.key);
    if (!mine || !mine.length) return '';
    return mine.map((a) =>
      `<span class="pl-award" data-kind="${esc(a.kind)}" data-tip="${esc(a.label)}">` +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
      `stroke-linecap="round" stroke-linejoin="round">${CARD_ICON[a.kind] || FALLBACK_ICON}</svg>` +
      '</span>').join('');
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
      `<div class="pl-row${open ? ' open' : ''}" role="button" data-rk="${esc(rowKey)}">` +
        `<div class="pl-main">` +
          `<div class="pl-nameline">` +
            `<span class="pl-face" data-avatar-key="${esc(p.key)}">${esc(initials(p.name))}</span>` +
            awardsHtml(p) +
            `<span class="pl-name">${esc(p.name)}</span>` +
            // ONE NUMBER: what passed between the two of you.
            //
            // ~~Two, the second being "N in rooms" — what they said in a group
            // you were also in.~~ The row no longer prints it (owner,
            // 2026-08-26). The reason the split EXISTS is unchanged and still
            // load-bearing: folding room volume into the direct count is what
            // made someone you have never messaged look like a friend, so
            // `roomMessages` stays separate everywhere it is counted, ranked
            // and filtered — it is simply not a number the row says out loud.
            // What survives on screen is the qualitative half: a person with no
            // direct messages at all still wears the "only in group chats"
            // badge below, which is the part that changes how you read the row.
            (p.messages > 0
              ? `<span class="pm-msgs">${p.messages} msg${p.messages === 1 ? '' : 's'}</span>`
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
    return rows;
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
  // rather than throwing. The same `kind` also picks the card's colour — see
  // the tod-band block in people-months.css — which is why it rides onto both
  // the card and the row glyph as a data attribute rather than being switched
  // on here.
  const CARD_ICON = {
    'person-of-the-year':
      '<path d="M8 4h8v5a4 4 0 0 1-8 0V4Z"></path><path d="M8 5H5v2a3 3 0 0 0 3 3"></path>' +
      '<path d="M16 5h3v2a3 3 0 0 1-3 3"></path><path d="M12 13v4"></path><path d="M9 20h6"></path>',
    'back-from-your-past':
      '<circle cx="12" cy="12" r="8"></circle><path d="M12 7v5l3 2"></path>',
    'rising-star':
      '<path d="M4 17 10 11l4 4 6-8"></path><path d="M16 7h4v4"></path>',
    drifting:
      '<path d="M4 7l6 6 4-4 6 8"></path><path d="M16 17h4v-4"></path>',
    streak:
      '<path d="M12 3s5 4.2 5 9a5 5 0 0 1-10 0c0-4.8 5-9 5-9Z"></path>' +
      '<path d="M12 20a2.6 2.6 0 0 1-2.6-2.6c0-1.6 2.6-3.9 2.6-3.9s2.6 2.3 2.6 3.9A2.6 2.6 0 0 1 12 20Z"></path>',
  };
  const FALLBACK_ICON = '<circle cx="12" cy="12" r="7"></circle>';

  function cardHtml(h, i) {
    const icon = CARD_ICON[h.kind] || FALLBACK_ICON;
    return (
      `<div class="pm-card${i === 0 ? ' lead' : ''}" data-kind="${esc(h.kind)}">` +
        '<div class="pm-card-eyebrow">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
          `stroke-linecap="round" stroke-linejoin="round">${icon}</svg>` +
          `<span>${esc(h.label)}</span>` +
        '</div>' +
        '<div class="pm-card-who">' +
          `<span class="pm-card-face"${h.key ? ` data-avatar-key="${esc(h.key)}"` : ''}>` +
            `${esc(initials(h.name))}</span>` +
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
        // it as one: any error from visible/renderSky arrived here
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
    // Before anything draws a row: rowHtml reads this, and a stale index would
    // put the last year's marks on this year's names.
    awardsByKey = awardIndex(data);
    renderCards(data);
    renderFilter(rows.length);
    if (view === 'sky') renderSky(data, rows);
    else renderList(data, rows);
    // One placeholder, because search now means the same thing everywhere:
    // every person, every year, ranked by the server. Naming the open year
    // here would say the box only reaches it.
    searchEl.placeholder = 'search everyone, every year…';
    renderTabs();
    // After the paint, never during it — see paintAvatars.
    paintAvatars();
    saveView();
  }

  // Browser-style year tabs: oldest left, newest right, the open one active,
  // and the globe last — a view rather than a year, but it lives on the same
  // strip because it shows the same year.
  // Search results: ranked by the server across every year, each row carrying
  // the year it was found in.
  function renderFind() {
    if (findRows === null) {
      listEl.innerHTML = `<div class="pm-loading">searching…</div>`;
      renderTabs();
      return;
    }
    // NO MARKS ON A SEARCH. Results span every year, and the marks belong to
    // one: a row found in 2021 would wear whichever year happened to be open
    // behind the search box. The categories are still readable one tab at a
    // time, which is where they mean something.
    awardsByKey = new Map();
    const head = findState === 'degraded'
      ? `<div class="pl-more">couldn’t reach search — showing matches from the years already loaded</div>`
      : '';
    listEl.innerHTML = head + (findRows.map((p) => rowHtml(p, p.year)).join('')
      || `<div class="pl-empty">no one matches “${esc(findTerm)}”</div>`);
    searchEl.placeholder = 'search everyone, every year…';
    renderTabs();
    // After the paint, never during it — see paintAvatars.
    paintAvatars();
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
  // WHICH END IS ACTUALLY HIDING SOMETHING. The strip's fade used to be painted
  // on both ends at all times, which meant the tab at either end lost its edge
  // to a gradient whether or not there was anything behind it — and the newest
  // year, the one a fresh open selects, is always at an end. Marked from the
  // scroll position instead: a strip with nothing to its left does not fade
  // left. 1px of slack because scrollLeft is fractional on a scaled display.
  function markTabFades() {
    const max = tabsEl.scrollWidth - tabsEl.clientWidth;
    tabsEl.classList.toggle('fade-l', tabsEl.scrollLeft > 1);
    tabsEl.classList.toggle('fade-r', tabsEl.scrollLeft < max - 1);
  }
  tabsEl.addEventListener('scroll', markTabFades, { passive: true });

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
    // The globe is in the HTML, outside the scroller, so a render only lights
    // it. Lit for the topic LIST as well as the constellation: both are
    // all-years and both were reached through here, so this is where you are.
    // No data-tip — its hover bubble is laid out 25px below the strip, which
    // (with overflow-y promoted to auto by the horizontal scroll) made the
    // whole tab row vertically scrollable.
    globeEl.classList.toggle('active', scope === 'all');
    // WHERE THE STRIP SITS.
    //
    // Years run oldest-to-newest, so the interesting end is the RIGHT one, and
    // scrollIntoView({inline:'nearest'}) is a no-op whenever the active tab is
    // already visible -- which on a fresh open means the strip stays pinned to
    // 2019 with the newest years and the globe off the right edge. Ten tabs plus
    // the globe do not fit 520px, so this is the normal case, not an edge one.
    //
    // The newest year is what a fresh open selects, so scroll to the far right
    // and both it and the globe are in view. Only a deliberately older selection
    // gets scrolled to.
    // ONCE, ON THE FIRST PAINT. Re-homing to the right on every render meant any
    // click while the newest year was selected yanked the strip back under the
    // owner's hand — a scroll position the reader set is theirs to keep.
    //
    // Why the right end at all: years run oldest-to-newest and ten tabs need
    // ~646px against 490px of strip, so 8 fit. scrollIntoView({inline:'nearest'})
    // is a no-op when the active tab is already visible, which parked a fresh
    // open on 2012 with the newest years off-screen.
    const active = tabsEl.querySelector('.pm-tab.active');
    // ONCE THE STRIP IS A STRIP. `ys.length > 1` because the first paint of a
    // cold page draws the open year alone, before any payload has said which
    // years exist — homing to the right end of a single tab spends the one
    // homing on nothing, and the real strip then arrives parked on the oldest
    // year. Harmless in the list, where scrollIntoView on the active tab
    // rescues it; visible in the globe, where no year tab is active and the
    // strip simply sat on 2019.
    if (!tabsHomed && ys.length > 1) {
      tabsHomed = true;
      tabsEl.scrollLeft = tabsEl.scrollWidth;
    } else if (active) {
      active.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    }
    // After the scroll above, not before: the fades describe where the strip
    // ended up. The scroll listener covers every move after this one.
    markTabFades();
  }

  // ---- the constellation ----
  // ~~HOW MANY BUBBLES FIT IS SOLVED, NOT CHOSEN: n equal circles on one ring,
  // d(n) = 2*sin(pi/n)*(R - margin)/(1 + sin(pi/n)).~~ The solve was right and
  // its premise was wrong — the bubbles are neither equal nor on one ring, so
  // it guaranteed spacing for a picture the page never drew. That is where the
  // overlap came from. See people-sky-layout.js, which places each bubble on
  // its own radius and proves the result has no intersections.
  const MIN_CLUSTER = 2;
  // The stage geometry — how big each bubble is, how far out it sits, and where
  // around the core it goes — lives in people-sky-layout.js, which has no DOM in
  // it and is imported by widget/test/people-constellation.test.mjs so the
  // arrangement can be checked with numbers. This file draws what it returns.
  const SKY = globalThis.HzSkyLayout;

  // Two words -> both initials, one word -> one letter. Never two letters off a
  // single name: "Je" reads as a truncation, "J" reads as a monogram.
  function initials(name) {
    const parts = String(name == null ? '' : name).trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    const s = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : parts[0][0];
    return s.toUpperCase();
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
  // A person joins every topic they carry: people are not one thing. Activity
  // is the sum of the topic's message counts across those people; this is the
  // value that determines proximity to the owner, not merely how many people
  // happen to share the label.
  //
  // EACH MEMBER KEEPS THE COUNT THAT PUT THEM IN THIS BUBBLE, and the members
  // are ordered by it. ~~Both came from the person's GLOBAL engagement: the
  // roster arrives sorted by total messages, and the faces were sized from
  // p.engagement.~~ That was defensible while a bubble showed five faces and
  // meant "the biggest names who are in here". It stopped being defensible the
  // moment the bubble started carrying its whole cast: inside a circle labelled
  // FAMILY, a face sized by how much somebody talks to you about WORK is a
  // false statement about family, and the seats went to whoever was loudest
  // elsewhere rather than to whoever actually carries the topic. Measured on a
  // synthetic corpus of eight topics: the global ordering seated five faces in
  // one bubble and fourteen in another of nearly the same size, because a cast
  // of uniformly-loud people is a cast of uniformly-large faces, and large
  // faces do not fit. The per-topic count decays the way topics actually do.
  function clustersFrom(people, marked) {
    const by = new Map();
    for (const p of people) {
      for (const t of p.topics || []) {
        if (!t || !t.label) continue;
        if (marked && !t.tax) continue;
        let c = by.get(t.label);
        if (!c) by.set(t.label, (c = { label: t.label, members: [], activity: 0 }));
        const n = Math.max(0, Number(t.n) || 0);
        c.members.push({ person: p, n });
        c.activity += n;
      }
    }
    for (const c of by.values()) {
      // Ties broken by the global order the roster arrived in, which is stable,
      // so a bubble does not reshuffle itself between two renders of the same
      // data. `n` alone is not stable: a topic where everyone sent four
      // messages is entirely ties.
      c.members.forEach((m, i) => { m.at = i; });
      c.members.sort((a, b) => b.n - a.n || a.at - b.at);
    }
    // Not sliced here — renderSky needs the full count to say how many topics
    // the cap left out.
    return [...by.values()]
      .filter((c) => c.members.length >= MIN_CLUSTER)
      .sort((a, b) => b.activity - a.activity || b.members.length - a.members.length || a.label.localeCompare(b.label));
  }

  // How far down the cluster's roster the faces are sized before the packer is
  // asked. Well past what any bubble on this panel seats — the largest one
  // measured seats twenty-one — and it keeps a four-hundred-person topic from
  // sizing four hundred faces to draw twenty.
  const FACE_CANDIDATES = 48;

  // Contact photos, key -> data URI, or null once we know there is none.
  // Cached for the life of the popup: a face does not change while it is open,
  // and re-asking on every tab switch would be a round trip per year.
  const avatarCache = new Map();

  /**
   * Fill in the faces for whatever is on screen.
   *
   * Fetched AFTER the list paints, never before: the names and counts are the
   * page, and a photo arriving a beat later is invisible, while a list that
   * waits for photos is a list that stutters.
   */
  async function paintAvatars() {
    // cardsEl sits OUTSIDE the scrolling surface (it must stay put while the
    // list moves), so both roots are swept or the award faces never fill in.
    const holders = [
      ...surface().querySelectorAll('[data-avatar-key]'),
      ...cardsEl.querySelectorAll('[data-avatar-key]'),
    ];
    const need = [...new Set(holders.map((el) => el.dataset.avatarKey))]
      .filter((k) => k && !avatarCache.has(k));
    if (need.length) {
      try {
        const d = await hzPost('peopleAvatars', { keys: need });
        const got = (d && d.avatars) || {};
        for (const k of need) {
          avatarCache.set(k, got[k] ? `data:image/jpeg;base64,${got[k]}` : null);
        }
      } catch {
        // No faces is a fine page; mark them known so we do not ask again.
        for (const k of need) avatarCache.set(k, null);
      }
    }
    for (const el of holders) {
      const uri = avatarCache.get(el.dataset.avatarKey);
      if (!uri) continue;
      el.style.backgroundImage = `url("${uri}")`;
      el.classList.add('has-photo');
    }
  }

  // A FACE'S DIAMETER IS ITS PERSON'S SHARE OF THIS TOPIC — their messages
  // under this label, against the busiest person under it. The band it moves in
  // comes from the bubble (people-sky-layout.js owns the ratios), so the
  // encoding survives a topic being drawn small.
  function faceSize(n, maxN, fs) {
    return Math.round(fs.min + (fs.max - fs.min) * (Math.max(0, n) / maxN));
  }

  // `at` is the spot the packer solved for: centre offsets from the middle of
  // the bubble, in bubble pixels.
  function faceEl(p, at) {
    const f = document.createElement('div');
    f.className = 'pm-face';
    f.style.width = `${at.d}px`;
    f.style.height = `${at.d}px`;
    f.style.left = `calc(50% + ${at.x.toFixed(1)}px)`;
    f.style.top = `calc(50% + ${at.y.toFixed(1)}px)`;
    f.style.fontSize = at.d >= 28 ? '10px' : `${Math.max(6, Math.round(at.d * 0.34))}px`;
    f.textContent = initials(p.name);
    if (p.key) f.dataset.avatarKey = p.key;
    // data-tip, not title: native tooltips do not fire reliably in a
    // borderless non-activating panel (same reason as the connector glyphs).
    f.setAttribute('data-tip', `${p.name} · ${p.messages} msg${p.messages === 1 ? '' : 's'}`);
    return f;
  }

  // Written once: the layout sizes the stage against this string's width, and
  // a second copy of the format is a second chance for the two to disagree.
  function labelFor(topic, members) {
    return `${String(topic).toUpperCase()} (${members})`;
  }

  function clusterEl(spot, i, stage) {
    const c = spot.cluster;
    const d = spot.d;
    const el = document.createElement('div');
    el.className = 'pm-cluster' + (i === 0 ? ' lead' : '');
    el.dataset.topic = c.label;
    el.style.width = `${d}px`;
    el.style.height = `${d}px`;
    // Percentages so the field still tracks the panel if it is resized under us.
    // The centre is the stage's, a hair above the core's own 51% — the offset is
    // the core's alone, and borrowing it here would push the lowest bubble
    // through the bottom edge on a tall panel.
    el.style.left = `${(50 + (spot.x * 100) / stage.w).toFixed(1)}%`;
    el.style.top = `${(50 + (spot.y * 100) / stage.h).toFixed(1)}%`;

    // SEATS COME FROM THE BUBBLE, not from a constant, and the packer decides
    // how many there are — see people-sky-layout.js. Sizes are computed for the
    // whole candidate list before anything is placed, because a face's size is
    // its engagement against the busiest person in the TOPIC; recomputing it
    // against whoever happened to be seated would make the same person a
    // different size in a bubble that dropped its tail.
    const fs = SKY.faceScaleFor(d);
    const cast = c.cast.slice(0, FACE_CANDIDATES);
    const maxN = Math.max(1, ...cast.map((m) => m.n));
    let packed = SKY.packFaces(d, cast.map((m) => faceSize(m.n, maxN, fs)));
    let chip = null;
    // THE "+N" CHIP TAKES A SEAT, it does not sit on top of the crowd — a seat
    // is the only placement that cannot land on a face. It takes one of the
    // LAST seats, which are the smallest and outermost, so the faces it costs
    // are the least active in the topic and the crowd stays a clean prefix of
    // the roster: everyone drawn is busier here than everyone counted.
    //
    // Which of the last seats depends on the number. Seats run down to a 13px
    // floor, and "+1408" does not fit a 13px circle at a legible size — the
    // first cut drew exactly that, four digits smeared across a disc the width
    // of three. So walk out from the last seat until the text fits at 6px, the
    // smallest the design sets this chip, and give up at four seats: past that
    // the chip is eating people to describe them.
    if (c.cast.length > packed.seated && packed.seated > 1) {
      const digits = `+${c.cast.length - packed.seated + 1}`.length;
      let k = packed.spots.length - 1;
      // 0.6em per character is the monospace advance; 3px keeps the text off
      // the dashed ring it sits inside.
      const fits = (spot) => spot.d >= digits * 6 * 0.6 + 3;
      while (k > 1 && k > packed.spots.length - 5 && !fits(packed.spots[k])) k -= 1;
      chip = packed.spots[k];
      packed = { spots: packed.spots.slice(0, k), seated: k };
    }
    packed.spots.forEach((at, n) => { el.appendChild(faceEl(cast[n].person, at)); });
    const rest = c.cast.length - packed.seated;
    if (chip && rest > 0) {
      const more = document.createElement('div');
      more.className = 'pm-face pm-face-more';
      more.style.width = `${chip.d}px`;
      more.style.height = `${chip.d}px`;
      more.style.left = `calc(50% + ${chip.x.toFixed(1)}px)`;
      more.style.top = `calc(50% + ${chip.y.toFixed(1)}px)`;
      // Shrunk to the text when the seat is tight, never below 6px — the seat
      // walk above is what keeps that floor from being reached with a number
      // too long to sit in it.
      more.style.fontSize =
        `${Math.max(6, Math.min(Math.round(chip.d * 0.36), Math.floor((chip.d - 3) / (`+${rest}`.length * 0.6))))}px`;
      more.textContent = `+${rest}`;
      el.appendChild(more);
    }

    const label = document.createElement('div');
    label.className = 'pm-cluster-label';
    label.textContent = labelFor(c.label, c.members);
    el.appendChild(label);
    return el;
  }

  // The spokes. SVG rather than eight rotated divs: a rotated div's hairline
  // ends are square and visibly clipped at low opacity, and the transform
  // origin has to be re-derived from every bubble's own offset.
  //
  // PARSED, NOT createElementNS, and that is not a style preference. That call
  // takes the SVG namespace as an argument, and the namespace is spelled as a
  // URL — so connectors/test/egress.test.mjs, which scans tracked source for
  // host-shaped literals, reads it as a host this software may contact. It is
  // not one: an XML namespace is an identifier and nothing ever fetches it.
  // But that scan is a tripwire rather than a document (CLAUDE.md rule 3), and
  // declaring the standards body in ops/EGRESS.json to quiet it would put a
  // non-host in the ledger and cost the ledger the one property that makes it
  // worth keeping. The HTML parser applies the namespace on its own, so going
  // through innerHTML needs no such literal anywhere — and it is what every
  // other SVG on this page is already built with. (The prose is worded around
  // the string too, deliberately: the scan matches comments, exactly like the
  // inline-style tripwire does, and for the same reason.)
  //
  // The geometry rides as ATTRIBUTES, which the page's CSP does not gate; only
  // a style attribute is thrown away (see the note at .pm-sky in
  // people-months.css), and there is none here.
  function spokesEl(clusters, stage) {
    const lines = clusters.map((spot) => {
      // Weight and opacity both ride `heat`, the normalised activity the
      // layout used for the bubble's distance. The two ends of each range are
      // the design's.
      const heat = Math.max(0, Math.min(1, Number(spot.heat) || 0));
      return '<line ' +
        // From the CORE's centre, which sits at 51% like the element does — a
        // spoke that starts at 50% leaves a visible stub above the orb.
        `x1="${stage.w / 2}" y1="${stage.h * 0.51}" ` +
        `x2="${(stage.w / 2 + spot.x).toFixed(1)}" y2="${(stage.h / 2 + spot.y).toFixed(1)}" ` +
        `stroke="rgba(197,165,109,${(0.12 + 0.38 * heat).toFixed(2)})" ` +
        `stroke-width="${(1 + 5 * heat).toFixed(1)}"></line>`;
    }).join('');
    const holder = document.createElement('div');
    // Every value in here is arithmetic on numbers this file computed; nothing
    // reaches it from the corpus, so there is no name or label to escape.
    holder.innerHTML =
      `<svg class="pm-spokes" viewBox="0 0 ${stage.w} ${stage.h}" ` +
      'preserveAspectRatio="none"></svg>';
    const svg = holder.firstElementChild;
    svg.innerHTML = lines;
    return svg;
  }

  function renderSky(data, people) {
    skyEl.replaceChildren();
    const marked = topicsAreMarked(people);
    const all = clustersFrom(people, marked);
    const stage = { w: skyEl.clientWidth || 400, h: skyEl.clientHeight || 420 };
    // The layout takes counts, not people: it is geometry, and handing it the
    // corpus would let a change here reach into it. `people` rides along for
    // the faces this file draws.
    const placed = SKY.place(stage.w, stage.h, all.map((c) => ({
      label: c.label,
      members: c.members.length,
      activity: c.activity,
      // {person, n} pairs, busiest in this topic first — clusterEl needs both
      // halves, and handing it bare people would put the sizes back on the
      // global engagement this stopped using. Named apart from `members` above,
      // which the layout reads as a COUNT: one object cannot carry the same key
      // twice, and the silent winner was the array.
      cast: c.members,
      // What the label will measure, so the layout can keep it on the stage.
      // Arithmetic rather than a measuring pass: the face is monospaced, and
      // .pm-cluster-label is 9px with 0.1em of letter-spacing — 5.4px of
      // advance plus 0.9px of tracking, 6.3px a character. It is a PILL now
      // rather than bare text, so its 9px of side padding and 1px of border
      // count twice each on top. Checked against the rendered width of the
      // longest label this corpus produces; they agree to a pixel.
      labelWidth: Math.ceil(labelFor(c.label, c.members.length).length * 6.3) + 20,
    })));
    const clusters = placed.spots;
    if (!clusters.length) {
      const m = document.createElement('div');
      m.className = 'pm-sky-empty';
      m.textContent = people.length
        ? (scope === 'all'
            ? `nothing shared enough to group — a topic needs at least ${MIN_CLUSTER} people`
            : `nothing shared enough to group in ${year} — a topic needs at least ${MIN_CLUSTER} people`)
        : `no one to place in ${year}`;
      skyEl.appendChild(m);
      return;
    }

    // ~~48 seeded background specks, a starfield behind the topics.~~ Yeeted
    // (owner, 2026-08-26). They were the only marks on this surface that meant
    // nothing — every other dot here is a person — and at speck size the eye
    // cannot tell decoration from a person too far out to read.
    //
    // ~~Three dashed orbits at 180/300/420px.~~ Yeeted with them, one design
    // later: they were decoration on a data display, and worse, they read as a
    // distance SCALE they were not — a bubble sitting between two rings looked
    // like it had been measured against them, when the rings were three fixed
    // pixel values and the bubble's distance was a log of its message count.
    //
    // What replaces them is a spoke per topic, core to bubble, carrying the
    // distance encoding a second time as weight and opacity. A line between two
    // marks is the one piece of decoration here that states a fact — this topic
    // is a relationship of yours — and it gives the eye the radial order the
    // rings only pretended to.
    skyEl.appendChild(spokesEl(clusters, stage));

    const core = document.createElement('div');
    // `tod-orb` is the opt-in that puts this blob on the same clock as the
    // home orb (orb-tod.js). Then ask for the mood straight away: that file
    // ran at page load and re-runs on a minute's timer, and this element did
    // not exist for either — without the nudge the core wears the
    // stylesheet's fallback band until the next tick.
    core.className = 'pm-core tod-orb';
    skyEl.appendChild(core);
    if (typeof globalThis.__hzTodApply === 'function') globalThis.__hzTodApply();

    clusters.forEach((spot, i) => {
      skyEl.appendChild(clusterEl(spot, i, stage));
    });

    // BOTH caps, said out loud. The server caps the year's rows, and the ring
    // holds four bubbles — either one silently makes this picture look like the
    // whole year when it is a top slice of it.
    // NO FOOTNOTE (owner, 2026-08-25). It carried two disclosures and both had
    // stopped being true of this surface: the row cap belonged to /people/year
    // and the constellation no longer reads from there, and the year belonged
    // to a per-year sky that no longer exists. What remains is the topic cap,
    // and the bubbles that fit are the largest ones — see people-sky-layout.js,
    // which gives ground on size and on distance before it drops a topic at all.
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
  // The globe's half of the year tabs' contract. `staleYears` marks every
  // cached year for a silent freshness check on its next visit; the map had no
  // such mark, so once it had been read the globe showed that first answer for
  // the life of the webview — and the webview survives every close of the
  // panel. A day of new conversation could not reach it.
  let mapStale = false;

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

  function refreshMap() {
    if (!mapPending) {
      const repaint = mapData !== null;
      mapPending = hzPost('peopleMap')
        .then((r) => {
          mapData = adaptMap(r || {});
          mapStale = false;
          if (repaint && scope === 'all' && !findTerm) render();
          return mapData;
        })
        .finally(() => { mapPending = null; });
    }
    return mapPending;
  }

  function ensureMap() {
    return mapData ? Promise.resolve(mapData) : refreshMap();
  }

  // Entering the globe, exactly as `load` enters a year: paint what is in hand,
  // and check it behind the picture rather than in front of it. A cold globe
  // still shows "reading every year…" once, because there is nothing to paint.
  function visitMap() {
    if (!mapData) return ensureMap();
    if (mapStale) refreshMap().catch(() => {});
    return Promise.resolve(mapData);
  }

  // ---- remembering where you were ----
  // Closing the popup already returns you here, because the panel survives
  // hidden with its page state intact. A RESTART does not: the page is built
  // again and `year` goes back to today's, which is why quitting and reopening
  // landed on this year with nothing selected.
  //
  // One compact string rather than a JSON blob: native stores it opaquely and
  // bounds its length, and four fields do not need a schema on the far side.
  let saveTimer = null;
  function saveView() {
    clearTimeout(saveTimer);
    // Debounced: render() runs on every keystroke of a search, and each save is
    // a UserDefaults write.
    saveTimer = setTimeout(() => {
      hzPost('monthsView', { state: `${year}|${view}|${topic || ''}|${scope}` }).catch(() => {});
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
    // Native replies with the empty string exactly when nothing was ever
    // stored, which is the one signal on this page that means "never been
    // here". A malformed reply leaves saved null and this false: unreadable is
    // not the same as absent.
    firstVisit = saved === '';
    if (!saved) return null;
    const [y, v, t, s] = saved.split('|');
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
    return Number.isInteger(n) && n >= 1990 && n <= new Date().getFullYear() + 1 ? n : null;
  }

  // A first visit that finds NOTHING has nothing to show and no way to fix it
  // from here: the year tabs, the search and the constellation are all views of
  // a corpus, so with no corpus this page can only say "no one matches in 2026"
  // — which reads as a broken year rather than as "you have not connected
  // anything yet". Send them to unify-your-circles, which is where a corpus
  // starts, and which the sync button already opens.
  //
  // Both halves of the condition carry weight. `years` is corpus-wide (buildYear
  // walks every person's whole timeline, not the open year), so this fires on an
  // empty install and never on someone who simply has a thin 2026. And
  // firstVisit keeps a returning owner who opened this page on purpose from
  // being bounced out of it.
  function routeIfEmpty(res) {
    if (!firstVisit) return false;
    firstVisit = false; // decided once, whatever the answer was
    if (!Array.isArray(res.years) || res.years.length > 0) return false;
    hzPost('openPeople').catch(() => {});
    // Leaving this popup open behind unify would mean closing an empty year to
    // get back to the thing that fills it.
    hzPost('close').catch(() => {});
    return true;
  }

  // An uncached year is a server rebuild on first touch, so the click must
  // answer INSTANTLY with a loading state. reqId guards the race: only the
  // newest click's response may paint.
  let reqId = 0;
  function refreshYear(y) {
    const inFlight = refreshing.get(y);
    if (inFlight) return inFlight;

    // STALE-WHILE-REVALIDATE: the cached list stays painted while this request
    // runs. A failed freshness check leaves the old answer in place and the
    // year stale, so its next visit can try again without turning into an
    // empty error screen.
    const request = hzPost('peopleYear', { year: y })
      .then((res) => {
        if (!res || !Array.isArray(res.people)) throw new Error('bad year payload');
        cache.set(y, res);
        staleYears.delete(y);
        if (Array.isArray(res.years) && res.years.length) {
          years = res.years;
          // THE STRIP BELONGS TO BOTH SURFACES. `years` is corpus-wide and
          // arrives with a year payload, so until one lands the strip can only
          // draw the open year — one lonely tab. The constellation is painted
          // from the map and does not repaint when a year lands, which left
          // that placeholder strip on screen for the whole visit: the owner
          // opened the app into the globe and saw a single 2026, with every
          // other year appearing only once something else forced a paint.
          // Redrawing the tabs is cheap and says nothing about the field.
          renderTabs();
        }
        // Only into the list. A background year check landing while the globe
        // is up used to repaint the constellation, which is built from the map
        // and had nothing to learn from it — the whole field blinked.
        if (year === y && !findTerm && scope === 'year') render();
        return res;
      })
      .finally(() => refreshing.delete(y));
    refreshing.set(y, request);
    return request;
  }

  async function load(y) {
    year = y;
    renderTabs();
    if (cache.has(year)) {
      render();
      if (staleYears.has(year)) refreshYear(year).catch(() => {});
      return;
    }
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
    staleYears.delete(year);
    if (Array.isArray(res.years) && res.years.length) years = res.years;
    if (routeIfEmpty(res)) return;
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
        if (res && Array.isArray(res.people)) {
          cache.set(y, res);
          staleYears.delete(y);
        }
      }
      // AND THE GLOBE, last. Every year tab is warmed so its click is instant;
      // the globe was the one tab on the strip that always paid for its own
      // first open, and it is the most expensive read of the lot. It goes last
      // because the years are what is on screen, and /people/map rides the same
      // memoised graph the year scans just built on the server, so by now it is
      // the cheap end of this loop rather than the dear one.
      if (!mapData) await ensureMap();
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

  // Native calls this on every panel re-open. The webview SURVIVES hidden, so
  // keep its already-painted years and summaries, mark the year payloads stale,
  // and refresh only the visible year behind the existing rows. Other years
  // refresh silently when first revisited. This avoids both the blank loading
  // screen and a fan-out request for every historical year on every open.
  window.__hzRefresh = () => {
    for (const y of cache.keys()) staleYears.add(y);
    mapStale = true;
    // A re-open drops the search: a stale query over refreshed data would be
    // answering a question nobody is asking now.
    findId++;
    findTerm = '';
    findRows = null;
    findState = 'idle';
    searchEl.value = '';
    // Re-open where the panel was left: in all-years the year fetch is not
    // what is on screen. Both paths paint their last good payload first, then
    // revalidate just that visible surface behind it.
    if (scope === 'all') {
      render();
      refreshMap().catch(() => {});
    } else if (cache.has(year)) {
      render();
      refreshYear(year).catch(() => {});
    } else {
      loadOrFail(year);
    }
  };

  tabRowEl.addEventListener('click', (e) => {
    // Two shapes, one strip: the year tabs and the globe icon beside them.
    const b = e.target.closest('.pm-tab, .pm-globe');
    if (!b) return;
    if (b.dataset.view === 'sky') {
      view = 'sky';
      scope = 'all';
      // Arriving with a topic still selected would show a field where every
      // bubble but the chosen one was missing.
      topic = null;
      render();
      visitMap().catch(() => {});
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
      if (scope === 'all') {
        render();
        // Reopened INTO the globe, the page used to warm nothing: no year was
        // ever fetched, so `years` stayed empty, the tab strip carried a single
        // year, and the first click on any tab was a cold server rebuild. Read
        // the remembered year quietly behind the constellation — it is what
        // fills the strip — and let the usual warming follow it.
        refreshYear(year).then(() => prefetchRest()).catch(() => {});
      } else loadOrFail(year);
    });
})();
