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
  var GAP = 12;
  // The core is 54px, and a bubble that touches it reads as belonging to it.
  var CORE_CLEAR = 27 + 12;
  // The largest a bubble may be, from the design.
  var D_CEIL = 162;
  // The smallest. ~~118, on a measurement taken when faces were a flat 22..32px
  // and six discs stopped fitting below it.~~ Faces have scaled with the bubble
  // (0.20 * d) since, so that floor was describing code that no longer exists —
  // and it cost the size encoding its whole range: on the owner's own corpus
  // eight topics spanning 48 to 183 people came out 120px to 122px, a 3.8x
  // difference in the data drawn as 2px. Re-measured against the faces the page
  // actually draws now: at 78px a five-face bubble with its "+N" chip and its
  // label still sits inside its own ring.
  var D_SMALL = 78;

  // The ellipse the bubble CENTRES ride, sized so a bubble of diameter d stays
  // wholly on the stage. The panel is native-sized and the owner can scale it,
  // so a hardcoded radius is a clipped bubble waiting to happen.
  function ringFor(stageW, stageH, d) {
    var half = d / 2 + RING_MARGIN;
    return {
      rx: Math.max(0, stageW / 2 - half),
      ry: Math.max(0, stageH / 2 - half),
    };
  }

  // How big the largest bubble on this stage may be.
  function ceilingFor(stageW, stageH) {
    var room = Math.min(stageW, stageH) / 2 - RING_MARGIN - CORE_CLEAR;
    return Math.max(D_SMALL, Math.min(D_CEIL, Math.round(room)));
  }

  // SIZE IS PEOPLE. Square root rather than linear: linear scaling lets one
  // enormous topic eat the stage while everything else collapses onto the
  // floor, and the reader loses the differences among the small ones, which is
  // where most topics live.
  function diameterFor(members, maxMembers, dMax) {
    var lo = Math.min(D_SMALL, dMax);
    var share = Math.sqrt(Math.max(0, members) / Math.max(1, maxMembers));
    return Math.round(lo + (dMax - lo) * Math.min(1, share));
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
    return clusters.map(function (c, i) {
      var floor = Math.min(1, (CORE_CLEAR + diameters[i] / 2) / inner);
      if (hi === lo) return 1;
      var t = (acts[i] - lo) / (hi - lo);
      var full = floor + (1 - Math.max(0, Math.min(1, t))) * (1 - floor);
      return 1 - (1 - full) * pull;
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

  function attempt(stageW, stageH, clusters, scale, pull, start) {
    var dMax = Math.max(D_SMALL, Math.round(ceilingFor(stageW, stageH) * scale));
    var maxMembers = Math.max.apply(null, clusters.map(function (c) {
      return Math.max(1, Number(c.members) || 0);
    }));
    var diameters = clusters.map(function (c) {
      return diameterFor(Number(c.members) || 0, maxMembers, dMax);
    });
    var ring = ringFor(stageW, stageH, dMax);
    var radials = radialsFor(clusters, diameters, ring, pull);
    var angles = anglesFor(diameters, radials, ring, start);
    if (!angles) return null;
    var spots = clusters.map(function (c, i) {
      var at = centreOf(angles[i], radials[i], ring);
      return {
        cluster: c,
        d: diameters[i],
        ang: angles[i],
        radial: radials[i],
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

  // How many faces a bubble of this diameter can hold without pushing them out
  // through its own ring: two rows of whatever fits across the faces' 78% band,
  // one slot of which becomes the "+N" chip when there are more people than
  // seats. Derived from the same numbers the stylesheet uses, so a change there
  // is a change here.
  function facesFor(d, faceMax) {
    var perRow = Math.max(1, Math.floor((d * 0.78 + 4) / (faceMax + 4)));
    return Math.max(1, Math.min(5, perRow * 2 - 1));
  }

  var api = {
    place: place,
    ringFor: ringFor,
    overlaps: overlaps,
    facesFor: facesFor,
    diameterFor: diameterFor,
    HARD_CAP: HARD_CAP,
    D_CEIL: D_CEIL,
    D_SMALL: D_SMALL,
    GAP: GAP,
  };

  // The page loads this as a plain script; the tests import the same file.
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.HzSkyLayout = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
