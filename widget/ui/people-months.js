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
'use strict';

(function () {
  const listEl = document.getElementById('list');
  const searchEl = document.getElementById('search');
  const closeEl = document.getElementById('close');
  const tabsEl = document.getElementById('tabs');
  const syncEl = document.getElementById('sync');
  if (!listEl) return;

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
        `<span class="pm-quote-who">${e.fromMe ? 'you' : 'them'}</span>` +
        `<span class="pm-quote-text">${esc(e.text)}</span>` +
      `</div>`
    );
  }

  function rowHtml(p, y) {
    const chips = (p.topics || [])
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

  function render() {
    if (findTerm) return renderFind();
    const data = cache.get(year);
    if (!data) return;
    // Order is the server's: most engaged first.
    listEl.innerHTML = data.people.map((p) => rowHtml(p, year)).join('')
      || `<div class="pl-empty">no one in ${year}</div>`;
    searchEl.placeholder = `search everyone, every year…`;
    if (data.total > data.people.length) {
      listEl.insertAdjacentHTML('beforeend',
        `<div class="pl-more">+ ${data.total - data.people.length} more in ${year} — search reaches all of them</div>`);
    }
    renderTabs();
  }

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
    findId++;
    findTerm = '';
    findRows = null;
    findState = 'idle';
    searchEl.value = '';
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
      const cut = rk.lastIndexOf('|');
      const key = rk.slice(0, cut);
      // The row's own year -- a 2021 result summarised against the open tab
      // would be a summary of a year that person may not appear in at all.
      const rowYear = Number(rk.slice(cut + 1)) || year;
      requestSummary(key, rowYear);
    }
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

  loadOrFail(year);
})();
