// The orb's hue drifts with the time of day — the five moods from
// Terminal Palette.dc.html §09 (early / late / power / happy / night), the same
// palettes palette.css defines as the .orb.tod-* bands. But INTERPOLATED: rather
// than snap between five states at the band edges, this blends continuously
// between adjacent moods across the day, so "later morning → power hour"
// actually eases from spring-green toward the brand gradient minute by minute.
//
// It writes the same --tod-* custom properties palette.css already consumes
// (grad, mid, far, glow, glow-armed, light), inline on each .orb — which wins
// over the class-band values, so the discrete bands stay as the CSS fallback and
// this is the live driver. No network, no deps; a MutationObserver-free plain
// interval, because the shift is measured in tens of minutes.
'use strict';

(function () {
  // Each mood anchored at its band's CENTRE hour (night wraps past midnight to
  // hour 1). Colours lifted verbatim from palette.css's .orb.tod-* rules.
  const PHASES = [
    { h: 1.0,  c: ['#6e3a5c', '#48243e', '#1e0f1a'], mid: '#48243e', far: '#6e3a5c', glow: [110, 58, 92],   ga: 0.28, gaArm: 0.50, light: '#f2e8d4' }, // night   21–05
    { h: 7.0,  c: ['#e8e2f0', '#cbb8d6', '#9a8fb8'], mid: '#cbb8d6', far: '#9a8fb8', glow: [154, 143, 184], ga: 0.18, gaArm: 0.38, light: '#f2e8d4' }, // early   05–09
    { h: 10.5, c: ['#b294c9', '#a8bfa0', '#7fc46a'], mid: '#a8bfa0', far: '#7fc46a', glow: [127, 196, 106], ga: 0.22, gaArm: 0.42, light: '#efe7f6' }, // late    09–12
    { h: 14.5, c: ['#f2e8d4', '#c5a56d', '#33ff66'], mid: '#c5a56d', far: '#33ff66', glow: [51, 255, 102],  ga: 0.10, gaArm: 0.30, light: '#f2e8d4' }, // power   12–17
    { h: 19.0, c: ['#f5d9a8', '#e0a35c', '#c56d4a'], mid: '#e0a35c', far: '#c56d4a', glow: [224, 163, 92],  ga: 0.25, gaArm: 0.45, light: '#f2e8d4' }, // happy   17–21
  ];

  const hx = (h) => {
    h = h.replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  };
  const toHex = (r) => '#' + r.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const lerp = (a, b, t) => a + (b - a) * t;
  const lerpRgb = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  const lerpHex = (a, b, t) => toHex(lerpRgb(hx(a), hx(b), t));

  // The two moods this hour sits between, and how far (0..1) from the first.
  // Circular over 24h — the happy→night and night→early segments cross midnight.
  function segment(hour) {
    const n = PHASES.length;
    for (let i = 0; i < n; i++) {
      const A = PHASES[i];
      const B = PHASES[(i + 1) % n];
      let a = A.h;
      let b = B.h;
      if (b <= a) b += 24; // wrap
      let h = hour;
      if (h < a) h += 24;
      if (h >= a && h < b) return { A, B, t: (h - a) / (b - a) };
    }
    return { A: PHASES[0], B: PHASES[0], t: 0 };
  }

  function apply() {
    const now = new Date();
    const hour = now.getHours() + now.getMinutes() / 60;
    const { A, B, t } = segment(hour);

    const c0 = lerpHex(A.c[0], B.c[0], t);
    const c1 = lerpHex(A.c[1], B.c[1], t);
    const c2 = lerpHex(A.c[2], B.c[2], t);
    const mid = lerpHex(A.mid, B.mid, t);
    const far = lerpHex(A.far, B.far, t);
    const light = lerpHex(A.light, B.light, t);
    const g = lerpRgb(A.glow, B.glow, t).map(Math.round);
    const ga = lerp(A.ga, B.ga, t);
    const gaArm = lerp(A.gaArm, B.gaArm, t);

    const grad = `linear-gradient(160deg, ${c0} 0%, ${c1} 45%, ${c2} 100%)`;
    const glow = `rgba(${g[0]}, ${g[1]}, ${g[2]}, ${ga.toFixed(3)})`;
    const glowArm = `rgba(${g[0]}, ${g[1]}, ${g[2]}, ${gaArm.toFixed(3)})`;

    // Set on every .orb present (widget orb today; harmless if more appear).
    for (const orb of document.querySelectorAll('.orb')) {
      const s = orb.style;
      s.setProperty('--tod-grad', grad);
      s.setProperty('--tod-mid', mid);
      s.setProperty('--tod-far', far);
      s.setProperty('--tod-glow', glow);
      s.setProperty('--tod-glow-armed', glowArm);
      s.setProperty('--tod-light', light);
    }
  }

  apply();
  // Once a minute is plenty for a shift this slow; re-run on focus too, so a
  // laptop that slept across a band edge catches up the moment it wakes.
  setInterval(apply, 60000);
  window.addEventListener('focus', apply);
})();
