// The constellation's geometry, and nothing else: no DOM, no fetch, no state.
//
// It lives in its own file so it can be checked with NUMBERS instead of by eye
// (widget/test/people-constellation.test.mjs imports this exact file and asserts
// that no two bubbles intersect across a few hundred synthetic corpora). The
// overlap this was written to end shipped for a day looking like a style bug,
// and no source-scanning test could have caught it: every rule in the file was
// individually correct and the arrangement they produced was not.
//
// THE TWO ENCODINGS ARE THE PRODUCT. A bubble's DIAMETER is how many people
// share the topic; its DISTANCE from the core is how much of your conversation
// it is. A reader is invited to compare those, so neither may be quietly
// adjusted to make a picture fit. The ANGLE around the core carries nothing at
// all — which makes it the one free variable, and the only thing this file
// moves to resolve a collision.
//
// ~~Bubbles were spaced evenly around the ring at 2*pi/n.~~ That is only
// collision-free while every bubble sits on the SAME ring, and they do not:
// pulling a high-activity topic inward shortens the arc to its neighbours. With
// eight topics on a 490x470 stage the old rule put six of the twenty-eight
// pairs in contact, the worst pair 40px deep into each other (59px on a taller
// panel) — measured with the shipped math, not estimated.
(function (root) {
  'use strict';

  // Past eight the labels collide with each other whatever the geometry does,
  // and the picture reads as confetti rather than as your year.
  var HARD_CAP = 8;
  // Daylight between the stage edge and a bubble, and between two bubbles.
  var RING_MARGIN = 8;
  var GAP = 14;
  // The core is 54px, and a bubble that touches it reads as belonging to it.
  var CORE_CLEAR = 27 + 12;
  // The largest a bubble may be, from the design.
  var D_CEIL = 162;
  // The smallest. ~~118, on a measurement taken when faces were a flat 22..32px
  // and six discs stopped fitting below it.~~ ~~78, once faces scaled with the
  // bubble at 0.20 * d.~~ Both were the same mistake made twice: a floor set by
  // what the FACES needed, left behind each time the faces changed, quietly
  // spending the size encoding's range to pay for it. That range is the whole
  // point — eight topics spanning 48 to 183 people came out 120px to 122px
  // under the first floor, a 3.8x difference in the data drawn as 2px, and
  // 119px to 159px under the second, still 3.8x drawn as 1.3x.
  //
  // 63 is not another guess at what faces need. It is the smallest bubble the
  // design's own artboard draws (People Constellation.dc.html, the FITNESS
  // circle), and the packer fills it: at 63px the face band is 16px down to the
  // 13px floor, and packFaces seats seven of them inside the ring with the
  // label still legible on the hem. The floor is a DESIGN limit now — below
  // this a circle stops reading as a group — so the next change to the faces
  // does not silently move it a third time.
  var D_SMALL = 63;

  // THE LABEL HANGS BELOW ITS BUBBLE NOW. It used to be the last item of the
  // bubble's own flex column, inside the circle and costing the ring nothing.
  // The design hangs it off the bottom edge as a pill (bottom: -8px in
  // people-months.css), so the lowest bubble on the stage reaches 8px further
  // down than its circle does, and a ring sized to the circle alone clips it.
  // Taken off BOTH ends of the vertical radius rather than the bottom only:
  // the ring is centred on the stage, so an asymmetric allowance would have to
  // move the centre too, and 8px of unused sky at the top costs nothing a
  // reader can see.
  var LABEL_DROP = 8;

  // The ellipse the bubble CENTRES ride, sized so a bubble of diameter d stays
  // wholly on the stage. The panel is native-sized and the owner can scale it,
  // so a hardcoded radius is a clipped bubble waiting to happen.
  function ringFor(stageW, stageH, d) {
    var half = d / 2 + RING_MARGIN;
    return {
      rx: Math.max(0, stageW / 2 - half),
      ry: Math.max(0, stageH / 2 - half - LABEL_DROP),
    };
  }

  // How big the largest bubble on this stage may be.
  function ceilingFor(stageW, stageH) {
    var room = Math.min(stageW, stageH) / 2 - RING_MARGIN - CORE_CLEAR;
    return Math.max(D_SMALL, Math.min(D_CEIL, Math.round(room)));
  }

  // SIZE IS PEOPLE, and specifically the circle's AREA is its people. Square
  // root rather than linear: a disc drawn at linear diameter overstates the big
  // topic by its own factor again, because the eye reads the area.
  //
  // ~~lo + (dMax - lo) * share.~~ That is a square root with an OFFSET under
  // it, and the offset is the thing that has been quietly eating this
  // encoding's range for two floors running. It makes D_SMALL a baseline every
  // bubble is measured up from rather than a limit — so no bubble is ever drawn
  // small, areas stop being comparable to each other at all, and the reader is
  // invited to compare them anyway. On eight topics spanning 48 to 183 people
  // it drew 119px to 159px: a 3.8x difference in the data rendered as 1.3x,
  // and the 63px end of the range unreachable by any real corpus.
  //
  // The floor is a CLAMP now. Areas are proportional over the whole range above
  // it, and a topic small enough to be clamped is one the reader can see has
  // hit the bottom, rather than one silently pulled up toward the middle.
  function diameterFor(members, maxMembers, dMax) {
    var share = Math.sqrt(Math.max(0, members) / Math.max(1, maxMembers));
    return Math.max(Math.min(D_SMALL, dMax), Math.round(dMax * Math.min(1, share)));
  }

  // DISTANCE IS CONVERSATION. log1p because message counts are heavy-tailed:
  // on a linear scale the busiest topic pins everything else to the rim.
  //
  // The inner limit is geometric, not editorial — a bubble may not reach the
  // core. Taken against the SHORT axis of the ring so it holds at every angle;
  // the old rule measured it along the bubble's own angle, which made the floor
  // a function of a variable this file now solves for.
  //
  // `pull` is how much of that range the ring can afford today. At 1 the
  // busiest topic sits as close to the core as geometry allows; lowering it
  // walks every bubble back out toward the rim TOGETHER, so the order and the
  // relative spacing survive while the picture gets a little flatter. It is the
  // first thing spent when a stage is too small for the topics on it, because
  // a compressed distance still answers "which of these do I talk about most"
  // and a dropped topic answers nothing at all.
  function radialsFor(clusters, diameters, ring, pull) {
    var inner = Math.max(1, Math.min(ring.rx, ring.ry));
    var acts = clusters.map(function (c) {
      return Math.log1p(Math.max(0, Number(c.activity) || 0));
    });
    var lo = Math.min.apply(null, acts);
    var hi = Math.max.apply(null, acts);
    // `heat` is that same normalised activity handed back for the SPOKE the
    // page draws from the core to each bubble. It is deliberately a second,
    // redundant rendering of the distance encoding rather than a new one: the
    // spoke is what makes distance legible at all on a field of eight circles,
    // and giving it any other variable would make the picture say two things
    // along one line. Kept here so the two can never drift apart.
    return clusters.map(function (c, i) {
      var floor = Math.min(1, (CORE_CLEAR + diameters[i] / 2) / inner);
      if (hi === lo) return { radial: 1, heat: 1 };
      var t = Math.max(0, Math.min(1, (acts[i] - lo) / (hi - lo)));
      var full = floor + (1 - t) * (1 - floor);
      return { radial: 1 - (1 - full) * pull, heat: t };
    });
  }

  // The smallest angle between two bubbles that keeps them apart, solved rather
  // than iterated: with centres at radii r1 and r2, the law of cosines gives the
  // angle at which their gap closes to zero.
  //
  // Solved on a CIRCLE of the ring's short radius even though the ring is an
  // ellipse. That is deliberate and conservative: stretching one axis of a
  // point set can only grow the distance between any two of its points, so an
  // arrangement that clears on the circle also clears on the ellipse it maps to.
  function minSeparation(r1, r2, need) {
    if (r1 <= 0 || r2 <= 0) return need <= Math.abs(r1 - r2) ? 0 : Math.PI;
    var cos = (r1 * r1 + r2 * r2 - need * need) / (2 * r1 * r2);
    if (cos >= 1) return 0; // already apart on radius alone
    if (cos <= -1) return Math.PI; // no angle saves this pair; the caller shrinks
    return Math.acos(cos);
  }

  // WHERE THE ANGLES COME FROM.
  //
  // ~~One walk around the ring, each bubble handed the arc its neighbour
  // demanded.~~ That treats the field as a single ring, and it is not one: a
  // bubble's radius is its own data, so a quiet topic out at the rim and a busy
  // one near the core can share an angle without ever touching. Forcing them
  // into one cyclic order spent arc on pairs that were already apart, and the
  // bill came due as dropped topics — six of eight on the owner's stage, with
  // the distances flattened to a 17% band on top of it.
  //
  // Each bubble is placed on ITS OWN radius, closest-first, at the angle
  // nearest the even spread that clears everything already down. Closest-first
  // because the inner ring is the tight one: an inner bubble sweeps a much
  // larger angle for the same width, so it must choose before the rim does.
  function anglesFor(diameters, radials, ring, start) {
    var n = diameters.length;
    var placed = [];
    var angles = [];
    // 2 degrees. Finer buys nothing a reader can see and costs a scan.
    var STEP = Math.PI / 90;
    for (var i = 0; i < n; i += 1) {
      var ideal = start + (i * Math.PI * 2) / n;
      var found = null;
      // Out from the ideal in both directions, so a bubble that has to move
      // moves as little as possible and the field stays balanced.
      for (var k = 0; k <= 180 && found === null; k += 1) {
        for (var sign = 1; sign >= -1; sign -= 2) {
          var ang = ideal + sign * k * STEP;
          var at = centreOf(ang, radials[i], ring);
          var clear = true;
          for (var j = 0; j < placed.length && clear; j += 1) {
            var need = (diameters[i] + placed[j].d) / 2 + GAP;
            clear = Math.hypot(at.x - placed[j].x, at.y - placed[j].y) >= need;
          }
          if (clear) { found = ang; break; }
          if (k === 0) break; // +0 and -0 are the same angle
        }
      }
      if (found === null) return null; // this set does not fit; the caller gives ground
      var spot = centreOf(found, radials[i], ring);
      placed.push({ d: diameters[i], x: spot.x, y: spot.y });
      angles.push(found);
    }
    return angles;
  }

  function centreOf(ang, radial, ring) {
    return { x: Math.cos(ang) * ring.rx * radial, y: Math.sin(ang) * ring.ry * radial };
  }

  // The check the tests run and the layout trusts: exact, in stage pixels, on
  // the ellipse rather than the circle the angles were solved on.
  function overlaps(spots) {
    var hits = [];
    for (var i = 0; i < spots.length; i += 1) {
      for (var j = i + 1; j < spots.length; j += 1) {
        var need = (spots[i].d + spots[j].d) / 2;
        var dist = Math.hypot(spots[i].x - spots[j].x, spots[i].y - spots[j].y);
        if (dist < need) hits.push({ i: i, j: j, by: need - dist });
      }
    }
    return hits;
  }

  // A LABEL IS WIDER THAN ITS BUBBLE AND THAT IS FINE — the design draws it
  // that way, a topic name being worth more than a tidy silhouette. Running off
  // the STAGE is not fine: "ENGINEERING · 47" on a bubble parked at the left
  // edge lost its first letters to the panel border. So the ring is pulled in
  // horizontally by the widest overhang any bubble carries. Vertically nothing
  // changes; the label sits inside the bubble's own height.
  function overhangFor(clusters, diameters) {
    var worst = 0;
    for (var i = 0; i < clusters.length; i += 1) {
      var w = Number(clusters[i].labelWidth) || 0;
      worst = Math.max(worst, (w - diameters[i]) / 2);
    }
    return Math.max(0, Math.round(worst));
  }

  function attempt(stageW, stageH, clusters, scale, pull, start) {
    var dMax = Math.max(D_SMALL, Math.round(ceilingFor(stageW, stageH) * scale));
    var maxMembers = Math.max.apply(null, clusters.map(function (c) {
      return Math.max(1, Number(c.members) || 0);
    }));
    var diameters = clusters.map(function (c) {
      return diameterFor(Number(c.members) || 0, maxMembers, dMax);
    });
    var ring = ringFor(stageW - 2 * overhangFor(clusters, diameters), stageH, dMax);
    var reach = radialsFor(clusters, diameters, ring, pull);
    var radials = reach.map(function (r) { return r.radial; });
    // THE CORE IS A BUBBLE TOO, and on a stage this small the ring itself can
    // pass through it: the radial floor is a fraction of the ring, so when the
    // ring is shorter than the core plus a bubble's own radius, "as far out as
    // it goes" is still on top of the owner. Fail here instead, and let the
    // ladder shrink until there is room. The short axis is the worst case, so
    // checking it covers every angle.
    var inner = Math.min(ring.rx, ring.ry);
    for (var q = 0; q < diameters.length; q += 1) {
      if (inner * radials[q] < CORE_CLEAR + diameters[q] / 2) return null;
    }
    var angles = anglesFor(diameters, radials, ring, start);
    if (!angles) return null;
    var spots = clusters.map(function (c, i) {
      var at = centreOf(angles[i], radials[i], ring);
      return {
        cluster: c,
        d: diameters[i],
        ang: angles[i],
        radial: radials[i],
        heat: reach[i].heat,
        x: at.x,
        y: at.y,
      };
    });
    return overlaps(spots).length ? null : spots;
  }

  /**
   * Place the topics on the stage.
   *
   * `clusters` arrive sorted the way the page ranks them — most conversation
   * first — and are placed in that order, so radius changes monotonically as
   * you walk the ring instead of jumping in and out.
   *
   * Returns { spots, shown, dropped }. Bubbles are shrunk before any are
   * dropped, and neither is done silently: `dropped` is what the caller has to
   * disclose.
   */
  function place(stageW, stageH, clusters) {
    var w = Math.max(1, stageW);
    var h = Math.max(1, stageH);
    // Upper-left first, so a four-topic year lands on the diagonals the design
    // draws.
    var start = -Math.PI * 0.75;
    var wanted = Math.min(clusters.length, HARD_CAP);
    for (var n = wanted; n >= 1; n -= 1) {
      var use = clusters.slice(0, n);
      // GIVE GROUND BEFORE GIVING UP A TOPIC. Each step tightens the ring a
      // little — bubbles a few percent smaller, distances a few percent
      // flatter — and both encodings keep their order the whole way down. Only
      // when 22 steps of that are not enough does a topic come off the stage,
      // and the caller says so when it does.
      for (var step = 0; step <= 25; step += 1) {
        var spots = attempt(w, h, use, 1 - step * 0.02, 1 - step * 0.012, start);
        if (spots) return { spots: spots, shown: n, dropped: clusters.length - n };
      }
    }
    return { spots: [], shown: 0, dropped: clusters.length };
  }

  // ---- the faces inside a bubble ----
  //
  // ~~Two flex-wrapped rows of up to five discs, centred.~~ That is a row of
  // avatars, not a crowd: a 174px bubble seated five people and spent the rest
  // of itself on empty gradient, and the "+N" chip carried the other eighty-
  // seven. The design packs the bubble instead — the whole cast visible as a
  // cloud, largest at the centre — so the bubble's AREA reads as its people
  // rather than a number in a chip does.
  //
  // A FACE'S DIAMETER IS ITS PERSON'S SHARE OF THE TOPIC — their messages under
  // this label against the busiest person under it; the page owns that
  // arithmetic (faceSize in people-months.js) and this file owns the band it
  // moves in. It is an encoding on the same footing as the two above and just
  // as unavailable for tidying. The ceiling and the floor are the design's,
  // read off the drawn artboard: 0.26 * d for the busiest face and 0.09 * d
  // for the quietest, never under 13px, which is where two initials stop being
  // legible.
  var FACE_MAX = 0.26;
  var FACE_MIN = 0.09;
  var FACE_FLOOR = 13;
  // Daylight between two faces, and between the outermost face and the bubble's
  // own dashed ring.
  var FACE_GAP = 2;
  var FACE_INSET = 5;

  function faceScaleFor(d) {
    var max = Math.max(FACE_FLOOR, Math.round(d * FACE_MAX));
    return { max: max, min: Math.min(max, Math.max(FACE_FLOOR, Math.round(d * FACE_MIN))) };
  }

  /**
   * Pack faces into a bubble of diameter `d`.
   *
   * `sizes` are face DIAMETERS, largest first — the caller has already sorted
   * its people by their share of this topic, and size is monotone in that
   * share, so the sequence does not change when the tail is cut off. Returns
   * the spots that fit, in the order they were given; `seated` is how many of
   * `sizes` were placed, and everyone past it is the caller's "+N".
   *
   * Biggest face at the middle, then each next one at the SMALLEST radius that
   * clears everything already down. ~~Concentric rings, each one starting
   * outside the last one's extent.~~ That is easy to prove correct and it
   * wastes most of the bubble: a ring's faces are narrower than the ring it
   * sits outside, so the next ring began past a circle of empty gradient it
   * could have nested into. Measured on the design's own largest bubble — 174px
   * holding twenty-three people — strict rings seated eight.
   *
   * The radius is SOLVED rather than searched. Along a fixed heading the
   * forbidden band around each placed face is the interval between the roots of
   * |r*u - C|^2 = need^2, a quadratic in r; walking a candidate radius past
   * each band it lands in, until a pass changes nothing, lands on the smallest
   * radius that clears them all. A few dozen headings then compete on that
   * radius. Exact where it matters and no iteration to tune.
   */
  function packFaces(d, sizes) {
    var room = d / 2 - FACE_INSET;
    var spots = [];
    if (!sizes.length || sizes[0] / 2 > room) return { spots: spots, seated: 0 };
    spots.push({ x: 0, y: 0, d: sizes[0] });
    // 5 degrees. The face is then nudged by the solve rather than the scan, so
    // a finer sweep buys a fraction of a pixel and costs a whole pass.
    var STEP = Math.PI / 36;
    for (var i = 1; i < sizes.length; i += 1) {
      var rf = sizes[i] / 2;
      var best = null;
      for (var k = 0; k < 72; k += 1) {
        // The heading each face starts from walks by the golden angle, so a
        // tie among equal radii — which is most of them early on — does not
        // hand every face the same side of the bubble.
        var ang = i * 2.399963 + k * STEP;
        var ux = Math.cos(ang);
        var uy = Math.sin(ang);
        var r = 0;
        for (var pass = 0; pass < 8; pass += 1) {
          var moved = false;
          for (var j = 0; j < spots.length; j += 1) {
            var need = rf + spots[j].d / 2 + FACE_GAP;
            var proj = spots[j].x * ux + spots[j].y * uy;
            var disc = proj * proj - (spots[j].x * spots[j].x + spots[j].y * spots[j].y) + need * need;
            if (disc <= 0) continue; // this heading misses the face entirely
            var out = proj + Math.sqrt(disc);
            if (r < out - 1e-9 && r > proj - Math.sqrt(disc) - 1e-9) { r = out; moved = true; }
          }
          if (!moved) break;
        }
        if (r + rf > room) continue;
        if (best === null || r < best.r) best = { r: r, x: r * ux, y: r * uy };
      }
      // No heading on this bubble has room for a face this size, and every face
      // after it is smaller — but not by enough to be worth another sweep each.
      if (best === null) break;
      spots.push({ x: best.x, y: best.y, d: sizes[i] });
    }
    return { spots: spots, seated: spots.length };
  }

  // The check the tests run on a packing: exact, in bubble pixels. Returns the
  // pairs that touch and the faces that reach outside the bubble's own ring.
  function faceFaults(d, spots) {
    var bad = [];
    for (var i = 0; i < spots.length; i += 1) {
      if (Math.hypot(spots[i].x, spots[i].y) + spots[i].d / 2 > d / 2 + 0.01) {
        bad.push({ i: i, out: true });
      }
      for (var j = i + 1; j < spots.length; j += 1) {
        var need = (spots[i].d + spots[j].d) / 2;
        var dist = Math.hypot(spots[i].x - spots[j].x, spots[i].y - spots[j].y);
        if (dist < need - 0.01) bad.push({ i: i, j: j, by: need - dist });
      }
    }
    return bad;
  }

  var api = {
    place: place,
    ringFor: ringFor,
    overlaps: overlaps,
    packFaces: packFaces,
    faceScaleFor: faceScaleFor,
    faceFaults: faceFaults,
    diameterFor: diameterFor,
    HARD_CAP: HARD_CAP,
    D_CEIL: D_CEIL,
    D_SMALL: D_SMALL,
    GAP: GAP,
    FACE_FLOOR: FACE_FLOOR,
  };

  // The page loads this as a plain script; the tests import the same file.
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.HzSkyLayout = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
