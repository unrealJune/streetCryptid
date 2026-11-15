/*
 * The flip-dot map field behind all three pages.
 *
 * Every dot is a cell on a fixed lattice holding one colour. A scene change
 * repaints the lattice by flipping each dot -- squash to its edge, swap colour
 * at the halfway point, open again -- with the start time offset along the
 * diagonal so the change sweeps across the board rather than cutting.
 *
 * The palettes are transcribed 1:1 from the app's cryptid-theme.ts `canvas`
 * block (daybreak = light, deepsea = dark), so the site and the map render the
 * same city in the same colours -- mixed most of the way there from the page
 * ground, because this is a full-bleed background with page copy on it, and a
 * background that wins a contrast fight against its own text is a bug. `off`
 * is the one value with no counterpart in the app: the unrevealed ground a
 * board is built out of before its scene has been evaluated.
 *
 * The board is edge to edge. An earlier version cleared only a disc and left
 * the corners under fog, which read as a circle pasted onto the page rather
 * than as a map the page stands on; the fog is gone and the scene is evaluated
 * over the whole viewport. Keeping copy legible is now #scrim's job, which is
 * where it belongs.
 *
 * Dependency-free by house rule, and it draws into a single <canvas> that is
 * aria-hidden -- nothing here is load-bearing for reading either page.
 *
 * ── How it draws, and why it is shaped this way ───────────────────────────
 *
 * The lattice is drawn by a fragment shader, not by JavaScript. The previous
 * version pathed every dot on every frame -- at this density that is ~50k
 * Path2D.ellipse() calls sixty times a second, and ~85% of those frames were
 * repainting a picture that had not changed, because a scene rests for 4.6s
 * between 1.0s sweeps. Per frame this now sets five uniforms and draws one
 * quad; the dot geometry, the diagonal sweep offset and the squash are all
 * computed per fragment on the GPU. That is what buys the density: the dot
 * pitch went 8px to 3-5.5px and the frame cost went to roughly nothing,
 * because frame cost no longer depends on how many dots there are.
 *
 * The scenes stay in JavaScript. They are the art, they are awkward to port
 * to GLSL without drift, and they only need to run when the scene changes --
 * so `stepBuild` evaluates them a few milliseconds per frame across the hold,
 * and the sweep starts with the next board already staged. Nothing in the
 * scene functions below changed.
 *
 * Cells are stored twice: `code` (one byte of palette key + quantised fog)
 * and `rgb` (what the shader samples). Keeping the code means a theme change
 * is a palette re-map over an existing board rather than a re-evaluation of
 * the scene -- ~1ms instead of ~80ms, which matters because a system theme
 * flip should not stutter.
 *
 * Without WebGL the field falls back to Canvas2D at the old density and with
 * instant scene changes -- the same degradation `prefers-reduced-motion`
 * already gets. A client that cannot compile a ten-line shader has no
 * business running a 60fps dot field either.
 */
(function () {
  'use strict';

  var PALETTES = {
    daybreak: {
      bg: [236, 240, 244],
      off: [213, 220, 227],
      accent: [214, 124, 26],
      terr0: [176, 190, 200],
      terr1: [108, 132, 148],
      terr2: [52, 84, 106],
      terr3: [20, 44, 64],
      water0: [150, 192, 224],
      water1: [74, 140, 196],
      water2: [30, 104, 170],
      park0: [158, 200, 168],
      park1: [80, 164, 110],
      park2: [34, 128, 80],
      transit: [124, 74, 176],
      streetLabel: [46, 78, 98],
      parkLabel: [30, 110, 78],
    },
    deepsea: {
      bg: [9, 18, 30],
      off: [23, 36, 50],
      accent: [240, 166, 64],
      terr0: [34, 66, 74],
      terr1: [46, 120, 130],
      terr2: [120, 196, 198],
      terr3: [212, 236, 234],
      water0: [26, 74, 128],
      water1: [38, 110, 176],
      water2: [86, 168, 232],
      park0: [30, 84, 58],
      park1: [54, 140, 86],
      park2: [120, 206, 132],
      transit: [178, 138, 240],
      streetLabel: [184, 208, 216],
      parkLabel: [132, 198, 150],
    },
  };

  // Every palette key a scene can return, in a fixed order: a cell is stored
  // as `index * 5 + fogStep`, one byte, which is what makes a theme change a
  // table lookup rather than a rebuild. Appending is safe; reordering is not.
  var KEYS = [
    'off',
    'accent',
    'terr0',
    'terr1',
    'terr2',
    'terr3',
    'water0',
    'water1',
    'water2',
    'park0',
    'park1',
    'park2',
    'transit',
  ];
  var KEY_INDEX = {};
  for (var ki = 0; ki < KEYS.length; ki++) KEY_INDEX[KEYS[ki]] = ki;
  var FALLBACK_CODE = KEY_INDEX.terr1 * 5;

  // Sizing is derived from the viewport's narrow axis rather than fixed, which
  // is what keeps a phone from rendering a zoomed-in corner of the same city.
  // Hold BLOCK_SPAN city blocks across that axis at every size and draw a block
  // with DOTS_PER_BLOCK dots; the dot pitch and the geometric unit both fall
  // out of that, and their ratio stays put -- so the lattice looks the same on
  // a 390px phone and on a 27-inch display, and only the amount of map changes.
  var BLOCK_SPAN = 15; // city blocks across the narrow axis of the viewport
  var BLOCK_MIN = 26; // px: below this a block has no room for a building
  var BLOCK_MAX = 64; // px: above this a large display is just zoomed in
  var DOTS_PER_BLOCK = 10;
  var SPACING_MIN = 3; // px between dot centres; a disc needs a few to be one
  var SPACING_MAX = 5.5;
  var SPACING_2D = 1.6; // coarser lattice without WebGL, same block size
  var DOT_RATIO = 0.38; // dot radius as a fraction of the spacing
  // How far a cell travels from the page ground toward its own colour: the
  // field is background (see header). Per palette, because daybreak's terrain
  // is pale to begin with and deepsea's is not -- one number for both leaves
  // the light board a smudge or the dark one loud enough to fight its own copy.
  var QUIET = { daybreak: 0.8, deepsea: 0.6 };
  var HOLD = 4600; // ms a scene rests before the next sweep starts
  var FLIP = 220; // ms for one dot to close and reopen
  var SWEEP = 760; // ms for the flip to cross the board diagonally
  var JITTER = 60; // ms of per-dot scatter on top of the diagonal
  var BUILD_MS = 3; // per-frame budget for evaluating the next scene
  var RESIZE_QUIET = 120; // ms of stillness before a resize is acted on

  function fract(n) {
    return n - Math.floor(n);
  }

  function hash2(x, y) {
    var s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return s - Math.floor(s);
  }

  function vnoise(x, y) {
    var xi = Math.floor(x),
      yi = Math.floor(y),
      xf = x - xi,
      yf = y - yi;
    var u = xf * xf * (3 - 2 * xf),
      v = yf * yf * (3 - 2 * yf);
    var a = hash2(xi, yi),
      b = hash2(xi + 1, yi),
      c = hash2(xi, yi + 1),
      d = hash2(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }

  function fbm(x, y) {
    return vnoise(x, y) * 0.6 + vnoise(x * 2.1, y * 2.1) * 0.3 + vnoise(x * 4.3, y * 4.3) * 0.1;
  }

  // Street grid -> city blocks -> subdivided lots -> building footprints with a
  // height tone. Streets and the gaps between buildings are one dot wide;
  // footprints are solid masses. Everything is keyed off the block index, so a
  // block looks the same at every size and on every repaint.
  function city(X, Y, bx, by, du, seed, dens) {
    var ix = Math.floor(X / bx + seed),
      iy = Math.floor(Y / by + seed * 1.7);
    var fx = fract(X / bx + seed),
      fy = fract(Y / by + seed * 1.7);
    var sx = (du * 1.15) / bx,
      sy = (du * 1.15) / by;
    var major = hash2(ix * 3.3, 9.1) > 0.86 ? 2.2 : 1;
    if (fx < sx * major || fy < sy * major) return 'street';
    var nx = 1 + Math.floor(hash2(ix, iy) * 3),
      ny = 1 + Math.floor(hash2(ix + 41, iy - 17) * 3);
    var lx = Math.floor(fx * nx),
      ly = Math.floor(fy * ny);
    var h = hash2(ix * 7.7 + lx, iy * 5.3 + ly);
    if (h > dens) return 'court';
    var gx = (du * 0.95) / bx,
      gy = (du * 0.95) / by;
    var ux = fx * nx - lx,
      uy = fy * ny - ly;
    if (ux < gx * nx || uy < gy * ny || ux > 1 - gx * nx * 0.35 || uy > 1 - gy * ny * 0.35)
      return 'court';
    var t = hash2(ix * 2.1 + lx * 13.7, iy * 3.9 + ly * 11.3);
    return t > 0.84 ? 'terr3' : t > 0.5 ? 'terr2' : 'terr1x';
  }

  // Each scene is a pure function from a normalised point to a palette key,
  // plus a few map labels. It is evaluated over the whole viewport.
  var SCENES = [
    {
      name: 'TOKYO · SHIBUYA',
      labels: [
        { t: 'JR YAMANOTE', u: 0.17, v: 0.3, k: 'transit' },
        { t: 'SHIBUYA', u: 0.66, v: 0.6, k: 'streetLabel' },
        { t: 'SUMIDA', u: 0.3, v: 0.83, k: 'water2' },
      ],
      f: function (X, Y, ar, du, gu) {
        var rv = Math.abs(Y - (0.78 + 0.05 * Math.sin(X * 3.1)));
        if (rv < gu * 1.6) return 'water2';
        if (rv < gu * 3.2) return 'water1';
        if (Math.abs(Y - (0.3 + 0.09 * Math.sin(X * 2.2 + 1))) < du * 0.7) return 'transit';
        if (Math.abs(X - (0.55 * ar + 0.05 * Math.sin(Y * 5))) < du * 0.7) return 'transit';
        var k = city(X, Y, gu * 5, gu * 5, du, 0.3, 0.93);
        if (k === 'street') return 'terr0';
        if (k === 'court') return fbm(X * 20, Y * 20) > 0.62 ? 'terr0' : 'off';
        return k === 'terr1x' ? 'terr1' : k;
      },
    },
    {
      name: 'BIG SUR · CALIFORNIA',
      labels: [
        { t: 'PACIFIC', u: 0.1, v: 0.55, k: 'water2' },
        { t: 'HWY 1', u: 0.52, v: 0.24, k: 'streetLabel' },
        { t: 'VENTANA', u: 0.8, v: 0.72, k: 'parkLabel' },
      ],
      f: function (X, Y, ar, du, gu) {
        var coast = 0.34 * ar + 0.07 * Math.sin(Y * 5.2) + 0.05 * fbm(Y * 3.4, 7.7);
        var d = X - coast;
        if (d < -gu * 9) return 'water2';
        if (d < -gu * 3.5) return 'water1';
        if (d < 0) return 'water0';
        if (Math.abs(d - (gu * 4 + 0.02 * Math.sin(Y * 8))) < du * 0.8) return 'terr2';
        if (d > gu * 9 && d < gu * 16 && Math.abs(Y - 0.62) < 0.06) {
          var k = city(X - gu * 9, Y - 0.56, gu * 3, gu * 3, du, 0.8, 0.62);
          if (k === 'street') return 'terr0';
          if (k !== 'court') return k === 'terr3' ? 'terr2' : k === 'terr1x' ? 'terr1' : k;
        }
        var e = fbm(X * 6, Y * 6) + d * 0.45;
        return e > 0.74 ? 'terr3' : e > 0.6 ? 'park2' : e > 0.46 ? 'park1' : 'park0';
      },
    },
    {
      name: 'BARCELONA · EIXAMPLE',
      labels: [
        { t: 'DIAGONAL', u: 0.28, v: 0.22, k: 'streetLabel' },
        { t: 'EIXAMPLE', u: 0.7, v: 0.5, k: 'streetLabel' },
        { t: 'BALEARIC', u: 0.82, v: 0.9, k: 'water2' },
      ],
      f: function (X, Y, ar, du, gu) {
        // The Mediterranean along the bottom, climbing to the right the way the
        // real coast does.
        var sea = 0.84 + 0.1 * (X / ar) + 0.02 * Math.sin(X * 6);
        if (Y > sea + gu * 2.2) return 'water2';
        if (Y > sea + gu * 0.9) return 'water1';
        if (Y > sea) return 'water0';

        // One avenue driven across the grid at an angle: the thing that makes
        // the Eixample legible from the air.
        var dg = Math.abs(X - 0.06 * ar - Y * 1.25);
        if (dg < du * 1.1) return 'transit'; // the tram down the middle of it
        if (dg < du * 4.2) return 'terr0';

        var b = gu * 4.4;
        var ix = Math.floor(X / b),
          iy = Math.floor(Y / b);
        var fx = fract(X / b),
          fy = fract(Y / b);
        if (fx < (du * 1.25) / b || fy < (du * 1.25) / b) return 'terr0';
        // Every block is an octagon and the cut corners open into the crossing.
        // This is the whole idea of the plan and it is one line of arithmetic.
        if (Math.min(fx, 1 - fx) + Math.min(fy, 1 - fy) < 0.3) return 'terr0';
        // The interior patio the blocks were meant to keep.
        if (Math.abs(fx - 0.5) < 0.17 && Math.abs(fy - 0.5) < 0.17) {
          return hash2(ix * 5.1, iy * 3.7) > 0.7 ? 'park1' : 'off';
        }
        var t = hash2(ix * 2.3, iy * 7.9);
        return t > 0.78 ? 'terr3' : t > 0.28 ? 'terr2' : 'terr1';
      },
    },
    {
      name: 'CHICAGO · THE LOOP',
      labels: [
        { t: 'LAKE MICHIGAN', u: 0.85, v: 0.36, k: 'water2' },
        { t: 'BROWN LINE', u: 0.3, v: 0.31, k: 'transit' },
        { t: 'W MADISON', u: 0.14, v: 0.72, k: 'streetLabel' },
      ],
      f: function (X, Y, ar, du, gu) {
        var d = X - (0.62 * ar + 0.02 * Math.sin(Y * 3));
        if (d > gu * 7) return 'water2';
        if (d > gu * 2.5) return 'water1';
        if (d > 0) return 'water0';
        var x0 = 0.28 * ar,
          x1 = 0.46 * ar;
        var inY = Y > 0.36 && Y < 0.66,
          inX = X > x0 && X < x1;
        if (
          (inY && (Math.abs(X - x0) < du * 0.7 || Math.abs(X - x1) < du * 0.7)) ||
          (inX && (Math.abs(Y - 0.36) < du * 0.7 || Math.abs(Y - 0.66) < du * 0.7))
        )
          return 'transit';
        if (d > -gu * 2.5) return 'park1';
        var loop = Math.max(0, 1 - Math.hypot((X - 0.42 * ar) / 0.34, (Y - 0.5) / 0.34));
        var k = city(X, Y, gu * 7, gu * 4.5, du, 0.1, 0.72 + loop * 0.26);
        if (k === 'street') return 'terr0';
        if (k === 'court') return 'off';
        if (k === 'terr1x' && loop > 0.45) return 'terr2';
        if (k === 'terr2' && loop > 0.7) return 'terr3';
        return k === 'terr1x' ? 'terr1' : k;
      },
    },
    {
      name: 'LOFOTEN · NORWAY',
      labels: [
        { t: 'REINEFJORDEN', u: 0.24, v: 0.3, k: 'water2' },
        { t: 'MOSKENES', u: 0.7, v: 0.68, k: 'parkLabel' },
      ],
      f: function (X, Y, ar, du, gu) {
        var d = fbm(X * 3.2 + 3.1, Y * 3.2 + 1.7) - 0.52;
        if (d < -gu * 5) return 'water2';
        if (d < -gu * 2) return 'water1';
        if (d < 0) return 'water0';
        if (d > 0.15) return 'terr3';
        if (d > 0.085) return 'terr2';
        return d > 0.035 ? 'park1' : 'park0';
      },
    },
    {
      name: 'ISTANBUL · THE BOSPHORUS',
      labels: [
        { t: 'BOSPHORUS', u: 0.52, v: 0.16, k: 'water2' },
        { t: 'BEYOĞLU', u: 0.16, v: 0.6, k: 'streetLabel' },
        { t: 'ÜSKÜDAR', u: 0.86, v: 0.74, k: 'streetLabel' },
      ],
      f: function (X, Y, ar, du, gu) {
        // A strait rather than a coast: city on both banks, and the water
        // running away between them at an angle.
        var mid = 0.5 * ar + (Y - 0.5) * 0.34 * ar + 0.07 * ar * Math.sin(Y * 4.2);
        var d = X - mid,
          a = Math.abs(d);

        if (a < gu * 7.5 && (Math.abs(Y - 0.27) < du * 1.2 || Math.abs(Y - 0.68) < du * 1.2)) {
          return 'transit'; // two bridges, which is what a strait city is for
        }
        if (a < gu * 3.4) return 'water2';
        if (a < gu * 5) return 'water1';
        if (a < gu * 6) return 'water0';

        // The hills carry the density: the higher the ground, the taller and
        // tighter what stands on it.
        var h = fbm(X * 3.4 + 4.4, Y * 3.4 + 9.1);
        var k = city(X, Y, gu * 3.4, gu * 3, du, d < 0 ? 0.2 : 0.75, 0.8 + h * 0.18);
        if (k === 'street') return 'terr0';
        if (k === 'court') return h > 0.58 ? 'park1' : 'off';
        if (k === 'terr1x') return h > 0.6 ? 'terr2' : 'terr1';
        return k;
      },
    },
    {
      name: 'ZÜRICH · APPROACH TRACKS',
      labels: [
        { t: 'PLATFORM 4', u: 0.2, v: 0.13, k: 'streetLabel' },
        { t: 'S12 · S8', u: 0.62, v: 0.44, k: 'transit' },
        { t: 'DEPOT', u: 0.82, v: 0.87, k: 'streetLabel' },
      ],
      f: function (X, Y, ar, du, gu) {
        var spread = 0.22 + 0.78 * (1 - X / ar);
        var pitch = gu * 4 * spread;
        var m = (Y - 0.5) / pitch;
        var near = Math.round(m);
        if (Math.abs(near) <= 5 && Math.abs(m - near) * pitch < du * 0.7) return 'transit';
        if (Y < 0.15 || Y > 0.85) {
          var k = city(X, Y, gu * 6, gu * 4, du, 0.6, 0.78);
          if (k === 'street') return 'terr0';
          if (k === 'court') return 'off';
          return k === 'terr1x' ? 'terr1' : k;
        }
        return fbm(X * 12, Y * 12) > 0.6 ? 'terr1' : 'off';
      },
    },
    {
      name: 'NEW ORLEANS · THE CRESCENT',
      labels: [
        { t: 'MISSISSIPPI', u: 0.38, v: 0.64, k: 'water2' },
        { t: 'VIEUX CARRÉ', u: 0.7, v: 0.26, k: 'streetLabel' },
        { t: 'THE LEVEE', u: 0.13, v: 0.46, k: 'streetLabel' },
      ],
      f: function (X, Y, ar, du, gu) {
        var river = 0.56 + 0.22 * Math.sin((X / ar) * 3.6 - 0.9);
        var t = Y - river,
          a = Math.abs(t);
        if (a < gu * 3.2) return 'water2';
        if (a < gu * 4.6) return 'water1';
        if (a < gu * 5.4) return 'water0';
        if (a < gu * 6.4) return 'terr0'; // the levee road on both banks

        // The grid is bent, not square. Streets here were laid perpendicular to
        // the river, so the whole city shears with the meander -- which is what
        // you get by handing `city` the distance from the water instead of Y.
        var k = city(X, t, gu * 4.6, gu * 3.4, du, t > 0 ? 0.15 : 0.62, 0.88);
        if (k === 'street') return 'terr0';
        if (k === 'court') return fbm(X * 9, Y * 9) > 0.58 ? 'park1' : 'off';
        return k === 'terr1x' ? 'terr1' : k;
      },
    },
    {
      name: 'AMSTERDAM · GRACHTENGORDEL',
      labels: [
        { t: 'HET IJ', u: 0.6, v: 0.07, k: 'water2' },
        { t: 'PRINSENGRACHT', u: 0.22, v: 0.52, k: 'water2' },
        { t: 'JORDAAN', u: 0.76, v: 0.72, k: 'streetLabel' },
      ],
      f: function (X, Y, ar, du, gu) {
        if (Y < 0.1) return Y < 0.06 ? 'water2' : 'water1';
        var dx = X - 0.5 * ar,
          dy = Y - 1.22;
        var r = Math.hypot(dx, dy),
          a = Math.atan2(dy, dx);
        var pitch = gu * 6;
        var m = (r - 0.34) / pitch;
        if (r > 0.28 && r < 0.8 && Math.abs(m - Math.round(m)) * pitch < du * 0.9) return 'water1';
        if (fract(a * 11) < 0.075) return 'terr0';
        var k = city(X, Y, gu * 3.2, gu * 3.2, du, 0.45, 0.9);
        if (k === 'street') return 'terr0';
        if (k === 'court') return 'off';
        return k === 'terr3' ? 'terr2' : k === 'terr1x' ? 'terr1' : k;
      },
    },
    {
      name: 'SIERRA NEVADA · CONTOURS',
      labels: [
        { t: 'THE BASIN', u: 0.28, v: 0.72, k: 'water2' },
        { t: 'CREST TRAIL', u: 0.72, v: 0.3, k: 'transit' },
      ],
      f: function (X, Y, ar, du, gu) {
        var e = fbm(X * 2.4 + 13.1, Y * 2.4 + 5.6);
        if (e < 0.33) return e < 0.29 ? 'water2' : 'water1'; // a tarn in the low ground

        // A trail that holds one elevation across the slope. At this lattice it
        // comes out dashed wherever the ground steepens, which is the truth.
        if (Math.abs(e - 0.52) < 0.006) return 'transit';

        // Isolines, thick every fifth one, the way a printed topo marks its
        // index contours. They crowd where it is steep and open out where it is
        // not, because that is what a contour is.
        var band = (e - 0.33) * 30,
          i = Math.round(band);
        if (Math.abs(band - i) < (i % 5 === 0 ? 0.28 : 0.14)) {
          return e > 0.62 ? 'terr3' : 'terr2';
        }
        return e > 0.68 ? 'terr2' : e > 0.52 ? 'terr1' : e > 0.42 ? 'park1' : 'park0';
      },
    },
    {
      name: 'VENICE · CANNAREGIO',
      labels: [
        { t: 'CANAL GRANDE', u: 0.5, v: 0.38, k: 'water2' },
        { t: 'LAGUNA', u: 0.16, v: 0.86, k: 'water2' },
        { t: 'CANNAREGIO', u: 0.8, v: 0.18, k: 'streetLabel' },
      ],
      f: function (X, Y, ar, du, gu) {
        // Open lagoon wherever the ground falls away.
        var lag = fbm(X * 2.1 + 6.3, Y * 2.1 + 1.9);
        if (lag < 0.3) return 'water2';
        if (lag < 0.36) return 'water1';
        if (lag < 0.4) return 'water0';

        var gc = Math.abs(Y - (0.46 + 0.17 * Math.sin((X / ar) * 4.2 + 0.6)));
        if (gc < gu * 2.6) return 'water2';
        if (gc < gu * 3.6) return 'water1';

        // The capillaries. A ridge line drawn through noise branches and
        // dead-ends the way a real canal network does, which no lattice of
        // streets will ever do.
        if (Math.abs(fbm(X * 8.5 + 2.2, Y * 8.5 + 7.4) - 0.5) < 0.02) return 'water1';

        var k = city(X, Y, gu * 2.8, gu * 2.8, du, 0.9, 0.96);
        if (k === 'street') return 'terr0';
        if (k === 'court') return 'off';
        return k === 'terr3' ? 'terr2' : k === 'terr1x' ? 'terr1' : k;
      },
    },
    {
      name: 'MANHATTAN · THE PARK',
      labels: [
        { t: 'THE RESERVOIR', u: 0.44, v: 0.42, k: 'water2' },
        { t: 'CROSSTOWN', u: 0.14, v: 0.78, k: 'streetLabel' },
        { t: 'GREAT LAWN', u: 0.44, v: 0.68, k: 'parkLabel' },
      ],
      f: function (X, Y, ar, du, gu) {
        if (X > 0.34 * ar && X < 0.54 * ar && Y > 0.1 && Y < 0.9) {
          if (Math.hypot((X - 0.44 * ar) / (gu * 3.5), (Y - 0.42) / (gu * 6)) < 1) return 'water1';
          var p = fbm(X * 8, Y * 8);
          return p > 0.58 ? 'park2' : p > 0.42 ? 'park1' : 'park0';
        }
        if (Math.abs(X - 0.3 * ar) < du * 0.7 || Math.abs(X - 0.59 * ar) < du * 0.7)
          return 'transit';
        var k = city(X, Y, gu * 4, gu * 9, du, 0.05, 0.95);
        if (k === 'street') return 'terr0';
        if (k === 'court') return 'off';
        return k === 'terr1x' ? 'terr1' : k;
      },
    },
  ];

  // ── GPU lattice ───────────────────────────────────────────────────────────
  //
  // One quad. The shader turns a fragment position into a cell, samples that
  // cell's current and next colour, works out how far through its flip the cell
  // is from its own position on the diagonal, and squashes the disc to match.
  // No per-dot work reaches JavaScript.

  var VERT = ['attribute vec2 aPos;', 'void main() { gl_Position = vec4(aPos, 0.0, 1.0); }'].join(
    '\n'
  );

  var FRAG = [
    'precision highp float;',
    'uniform vec2 uRes;', // canvas size in CSS px
    'uniform vec2 uGrid;', // cols, rows
    'uniform float uDpr;',
    'uniform float uSpacing;',
    'uniform float uRadius;',
    'uniform float uT;', // ms since the sweep began; negative while at rest
    'uniform float uFlip;',
    'uniform float uSweep;',
    'uniform float uJitter;',
    'uniform vec3 uBg;',
    'uniform sampler2D uCur;',
    'uniform sampler2D uNext;',
    '',
    // Deliberately NOT the sin-based hash the scene functions use. This one is
    // fed cell indices, so its argument grows with the size of the board, and
    // sin() past a few thousand radians is where mobile GPUs stop agreeing with
    // each other -- the failure is a visible stripe in the sweep on some phones
    // and nothing on the machine it was written on. Integer-ish mixing has no
    // such range.
    'float hash(vec2 p) {',
    '  vec3 q = fract(vec3(p.xyx) * 0.1031);',
    '  q += dot(q, q.yzx + 33.33);',
    '  return fract((q.x + q.y) * q.z);',
    '}',
    '',
    'void main() {',
    '  vec2 css = gl_FragCoord.xy / uDpr;',
    '  css.y = uRes.y - css.y;', // to the top-left origin the cell grid is built in
    '  vec2 g = clamp(floor(css / uSpacing), vec2(0.0), uGrid - 1.0);',
    '  vec2 uv = (g + 0.5) / uGrid;',
    '',
    '  vec3 a = texture2D(uCur, uv).rgb;',
    '  vec3 b = texture2D(uNext, uv).rgb;',
    '  vec3 col = a;',
    '  float sy = 1.0;',
    '  if (uT >= 0.0) {',
    '    float t0 = ((g.x + g.y) / (uGrid.x + uGrid.y)) * uSweep + hash(g) * uJitter;',
    '    float p = (uT - t0) / uFlip;',
    '    if (p >= 1.0) {',
    '      col = b;',
    '    } else if (p > 0.0) {',
    '      sy = abs(1.0 - 2.0 * p);',
    '      col = (p < 0.5) ? a : b;',
    '    }',
    '  }',
    '',
    // Squash by scaling the sample point instead of the disc, so the edge stays
    // one circle test. The floor leaves a sliver at the halfway point rather
    // than nothing, which is what a real disc turned edge-on looks like.
    '  vec2 d = css - (g + 0.5) * uSpacing;',
    '  d.y /= max(sy, 0.02);',
    '  float aa = 0.5 / uDpr;',
    '  float mask = 1.0 - smoothstep(uRadius - aa, uRadius + aa, length(d));',
    '  gl_FragColor = vec4(mix(uBg, col, mask), 1.0);',
    '}',
  ].join('\n');

  var UNIFORMS = [
    'uRes',
    'uGrid',
    'uDpr',
    'uSpacing',
    'uRadius',
    'uT',
    'uFlip',
    'uSweep',
    'uJitter',
    'uBg',
    'uCur',
    'uNext',
  ];

  function compile(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  function makeTexture(gl) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    // NEAREST and CLAMP_TO_EDGE: the texture is one texel per cell and is read
    // at texel centres, so filtering would only smear neighbouring cells into
    // each other. It also keeps non-power-of-two sizes legal in WebGL 1.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  function Lattice(canvas) {
    var opts = {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'low-power',
    };
    this.ok = false;
    var gl = null;
    try {
      gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
    } catch (e) {
      gl = null;
    }
    if (!gl) return;

    var vs = compile(gl, gl.VERTEX_SHADER, VERT);
    var fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return;
    var prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;

    this.gl = gl;
    this.prog = prog;
    this.u = {};
    for (var i = 0; i < UNIFORMS.length; i++) {
      this.u[UNIFORMS[i]] = gl.getUniformLocation(prog, UNIFORMS[i]);
    }

    // One triangle large enough to cover the clip cube; cheaper than two and
    // it avoids the seam a quad's diagonal can show under some drivers.
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.cur = makeTexture(gl);
    this.next = makeTexture(gl);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.useProgram(prog);
    gl.uniform1i(this.u.uCur, 0);
    gl.uniform1i(this.u.uNext, 1);
    this.ok = true;
  }

  Lattice.prototype.upload = function (which, rgb, cols, rows) {
    var gl = this.gl;
    // draw() leaves unit 1 active; upload on unit 0 so a stray binding cannot
    // outlive this call.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, which === 'next' ? this.next : this.cur);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, cols, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgb);
  };

  // Settling a sweep is a pointer swap, not a copy: the board that was `next`
  // simply becomes `cur`. This is the whole reason a finished flip costs
  // nothing -- the old version wrote back to every cell it had flipped.
  Lattice.prototype.swap = function () {
    var t = this.cur;
    this.cur = this.next;
    this.next = t;
  };

  Lattice.prototype.draw = function (f, t) {
    var gl = this.gl,
      u = this.u;
    gl.viewport(0, 0, f.canvas.width, f.canvas.height);
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.cur);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.next);
    gl.uniform2f(u.uRes, f.w, f.h);
    gl.uniform2f(u.uGrid, f.cols, f.rows);
    gl.uniform1f(u.uDpr, f.dpr);
    gl.uniform1f(u.uSpacing, f.spacing);
    gl.uniform1f(u.uRadius, f.spacing * DOT_RATIO);
    gl.uniform1f(u.uT, t);
    gl.uniform1f(u.uFlip, FLIP);
    gl.uniform1f(u.uSweep, SWEEP);
    gl.uniform1f(u.uJitter, JITTER);
    gl.uniform3f(u.uBg, f.pal.bg[0] / 255, f.pal.bg[1] / 255, f.pal.bg[2] / 255);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  // ── Canvas2D lattice (no WebGL) ───────────────────────────────────────────
  //
  // Static: one full paint per scene, no flip. See the header for why that is
  // the right trade rather than a second animated renderer to keep in step.

  function Flat(canvas) {
    this.ctx = canvas.getContext('2d');
    this.ok = !!(this.ctx && window.Path2D);
  }

  Flat.prototype.upload = function () {};
  Flat.prototype.swap = function () {};

  Flat.prototype.draw = function (f) {
    var ctx = this.ctx,
      cols = f.cols,
      rows = f.rows,
      rgb = f.curRGB;
    ctx.setTransform(f.dpr, 0, 0, f.dpr, 0, 0);
    ctx.fillStyle = 'rgb(' + f.pal.bg.join(',') + ')';
    ctx.fillRect(0, 0, f.w, f.h);
    var r = Math.max(1.35, f.spacing * DOT_RATIO);
    var batch = {},
      order = [];
    for (var gy = 0; gy < rows; gy++) {
      for (var gx = 0; gx < cols; gx++) {
        var o = (gy * cols + gx) * 4;
        var k = (rgb[o] << 16) | (rgb[o + 1] << 8) | rgb[o + 2];
        var path = batch[k];
        if (!path) {
          path = batch[k] = new Path2D();
          order.push(k);
        }
        var cx = gx * f.spacing + f.spacing / 2,
          cy = gy * f.spacing + f.spacing / 2;
        path.moveTo(cx + r, cy);
        path.arc(cx, cy, r, 0, Math.PI * 2);
      }
    }
    for (var i = 0; i < order.length; i++) {
      var kk = order[i];
      ctx.fillStyle =
        'rgb(' + ((kk >> 16) & 255) + ',' + ((kk >> 8) & 255) + ',' + (kk & 255) + ')';
      ctx.fill(batch[kk]);
    }
  };

  // ── Labels ────────────────────────────────────────────────────────────────
  //
  // A second, 2D canvas over the lattice. The lattice canvas is WebGL and
  // cannot also take fillText, and labels have no business being redrawn at
  // 60fps regardless: they are painted while they fade in and then left alone.
  // Inserted directly after the field, so #scrim covers them exactly as it did
  // when they were drawn into the field itself.

  var LABEL_FADE = 420;

  function Plate(field) {
    var c = document.createElement('canvas');
    c.setAttribute('aria-hidden', 'true');
    c.style.cssText =
      'position:fixed;inset:0;width:100%;height:100%;' + 'display:block;pointer-events:none';
    field.parentNode.insertBefore(c, field.nextSibling);
    this.canvas = c;
    this.ctx = c.getContext('2d');
  }

  Plate.prototype.resize = function (w, h, dpr) {
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  Plate.prototype.draw = function (f, alpha) {
    var ctx = this.ctx;
    ctx.clearRect(0, 0, f.w, f.h);
    if (alpha <= 0 || !f.labels) return;
    ctx.save();
    ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0.18em';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (var i = 0; i < f.labels.length; i++) {
      var l = f.labels[i];
      var wdt = ctx.measureText(l.t).width;
      var half = wdt / 2 + 10;
      var x = Math.max(half, Math.min(f.w - half, l.u * f.w));
      var y = Math.max(16, Math.min(f.h - 16, l.v * f.h));
      // A plate in the ground colour, so a label never sits on top of a dot.
      ctx.globalAlpha = alpha * 0.82;
      ctx.fillStyle = 'rgb(' + f.pal.bg.join(',') + ')';
      ctx.fillRect(x - wdt / 2 - 7, y - 9, wdt + 14, 18);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = 'rgb(' + (f.pal[l.k] || f.pal.streetLabel).join(',') + ')';
      ctx.fillText(l.t, x, y);
    }
    ctx.restore();
  };

  // ── Field ─────────────────────────────────────────────────────────────────

  // A sweep is over once the last dot -- furthest along the diagonal and
  // carrying the most jitter -- has finished reopening.
  var SWEEP_TOTAL = SWEEP + JITTER + FLIP;

  function Field(canvas, renderer, gpu, onScene) {
    this.canvas = canvas;
    this.r = renderer;
    this.gpu = gpu;
    this.onScene = onScene || function () {};
    this.plate = new Plate(canvas);
    this.spacing = SPACING_MAX; // both replaced by the first resize()
    this.gu = BLOCK_MAX / (5 * 900);

    this.index = 0;
    this.nextIndex = 0;
    this.labels = SCENES[0].labels;
    this.pending = null; // in-flight scene evaluation
    this.staged = false; // next board built and uploaded, waiting for its turn
    this.sweepAt = -1; // performance.now() the running sweep began, or -1
    this.labelAt = performance.now();
    this.resizeAt = 0;
    this.running = false;
    this.lost = false;
    this.dirty = true;

    this.mqDark = window.matchMedia('(prefers-color-scheme: dark)');
    this.mqMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.applyTheme();

    var self = this;
    this.onThemeChange = function () {
      self.applyTheme();
      // The scene is unchanged -- only what its cells mean in colour is. Re-map
      // the boards we already hold instead of re-evaluating a scene function
      // over every cell: ~1ms against ~80ms, for something a user just did.
      if (self.curCode) {
        self.recolour(self.curCode, self.curRGB);
        self.r.upload('cur', self.curRGB, self.cols, self.rows);
      }
      if (self.staged) {
        self.recolour(self.nextCode, self.nextRGB);
        self.r.upload('next', self.nextRGB, self.cols, self.rows);
      }
      self.dirty = true;
      self.plate.draw(self, 1);
      self.labelAt = -LABEL_FADE;
    };
    // addListener is the pre-2020 spelling, and this page exists for old clients.
    if (this.mqDark.addEventListener) this.mqDark.addEventListener('change', this.onThemeChange);
    else if (this.mqDark.addListener) this.mqDark.addListener(this.onThemeChange);

    // Coalesced, not immediate: a ResizeObserver fires continuously while a
    // window is dragged, and every one of those used to be a full rebuild.
    var markResize = function () {
      self.resizeAt = performance.now();
    };
    if (window.ResizeObserver) {
      this.ro = new ResizeObserver(markResize);
      this.ro.observe(canvas);
    } else {
      window.addEventListener('resize', markResize);
    }

    if (gpu) {
      canvas.addEventListener(
        'webglcontextlost',
        function (e) {
          // Without preventDefault the context is never offered back. A phone
          // that backgrounded this tab for a while comes back through here.
          e.preventDefault();
          self.lost = true;
          self.stop();
        },
        false
      );
      canvas.addEventListener(
        'webglcontextrestored',
        function () {
          var fresh = new Lattice(canvas);
          if (!fresh.ok) return;
          self.r = fresh;
          self.lost = false;
          self.resize();
          self.start();
        },
        false
      );
    }

    // A field nobody is looking at should not hold a core awake; a phone that
    // followed an invite here may well be locked seconds later.
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) self.stop();
      else self.start();
    });

    this.resize();
    this.onScene(SCENES[0].name);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () {
        self.plate.draw(self, performance.now() < self.labelAt + LABEL_FADE ? 0 : 1);
      });
    }
    this.start();
  }

  Field.prototype.applyTheme = function () {
    var theme = this.mqDark.matches ? 'deepsea' : 'daybreak';
    var pal = PALETTES[theme];
    this.pal = pal;

    // The board covers the page and the page has copy on it, so every cell is
    // mixed QUIET of the way from the ground toward its own colour. Those are
    // the numbers that hold the field under the text: at them, the darkest
    // terrain in daybreak and the brightest in deepsea both land far enough
    // from --ink that body copy clears 4.5:1 through the thinnest ground
    // #scrim puts under copy. Map labels are drawn from `pal` at full strength
    // -- they are the one thing on the board meant to be read.
    var bg = pal.bg,
      q = QUIET[theme],
      quiet = {};
    for (var key in pal) {
      var v = pal[key];
      quiet[key] = [
        Math.round(bg[0] + (v[0] - bg[0]) * q),
        Math.round(bg[1] + (v[1] - bg[1]) * q),
        Math.round(bg[2] + (v[2] - bg[2]) * q),
      ];
    }
    quiet.bg = bg;
    this.quiet = quiet;

    // Cells still carry a five-step ramp toward `off` in their low bits. The
    // scenes no longer emit anything but step 0, but the byte layout is what
    // the boards and the textures are built around, so it stays.
    var lut = new Uint8Array(KEYS.length * 5 * 3);
    for (var k = 0; k < KEYS.length; k++) {
      var a = quiet[KEYS[k]] || quiet.terr1,
        b = quiet.off;
      for (var q = 0; q < 5; q++) {
        var m = q / 4,
          o = (k * 5 + q) * 3;
        lut[o] = Math.round(a[0] + (b[0] - a[0]) * m);
        lut[o + 1] = Math.round(a[1] + (b[1] - a[1]) * m);
        lut[o + 2] = Math.round(a[2] + (b[2] - a[2]) * m);
      }
    }
    this.lut = lut;
  };

  // No WebGL means no sweep: the same degradation reduced motion already gets,
  // for the same reason. See the file header.
  Field.prototype.reduced = function () {
    return this.mqMotion.matches || !this.gpu;
  };

  Field.prototype.recolour = function (code, rgb) {
    var lut = this.lut,
      n = code.length;
    for (var i = 0; i < n; i++) {
      var o = code[i] * 3,
        j = i * 4;
      rgb[j] = lut[o];
      rgb[j + 1] = lut[o + 1];
      rgb[j + 2] = lut[o + 2];
      rgb[j + 3] = 255;
    }
  };

  Field.prototype.resize = function () {
    var cv = this.canvas;
    var w = cv.clientWidth,
      h = cv.clientHeight;
    if (!w || !h) return;
    var now = performance.now();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    this.w = w;
    this.h = h;
    this.dpr = dpr;

    // A block is a fixed share of the narrow axis and the dot pitch a fixed
    // share of a block, so a portrait phone gets the same lattice over a wider
    // view rather than seven blocks blown up to fill the screen.
    var block = Math.max(BLOCK_MIN, Math.min(BLOCK_MAX, Math.min(w, h) / BLOCK_SPAN));
    var spacing = Math.max(SPACING_MIN, Math.min(SPACING_MAX, block / DOTS_PER_BLOCK));
    this.spacing = this.gpu ? spacing : spacing * SPACING_2D;
    this.gu = block / (5 * h); // a city block is five geometric units wide

    this.cols = Math.ceil(w / this.spacing) + 1;
    this.rows = Math.ceil(h / this.spacing) + 1;
    this.ar = w / h;
    this.plate.resize(w, h, dpr);

    var n = this.cols * this.rows;
    if (!this.curCode || this.curCode.length !== n) {
      this.curCode = new Uint8Array(n);
      this.nextCode = new Uint8Array(n);
      this.curRGB = new Uint8Array(n * 4);
      this.nextRGB = new Uint8Array(n * 4);
    }

    // Geometry changed, so both the staged board and any running sweep are void.
    this.staged = false;
    this.sweepAt = -1;
    this.beginBuild(this.index, 'cur');
    this.dirty = true;
    // Mid-hold the fade is long over and the labels have to come straight back,
    // because sizing the plate cleared them.
    this.plate.draw(this, now < this.labelAt + LABEL_FADE ? 0 : 1);
  };

  Field.prototype.beginBuild = function (index, target) {
    var next = target === 'next';
    this.pending = {
      index: index,
      target: target,
      gy: 0,
      code: next ? this.nextCode : this.curCode,
      rgb: next ? this.nextRGB : this.curRGB,
    };
    if (next) return;
    // A visible board is built in front of the reader, so start it as
    // unrevealed ground and let the scene fill in rather than showing the
    // buffer's zeroes. Which is also the one thing this page is about.
    this.index = index;
    this.labels = SCENES[index].labels;
    var rgb = this.curRGB,
      off = this.quiet.off;
    for (var i = 0; i < rgb.length; i += 4) {
      rgb[i] = off[0];
      rgb[i + 1] = off[1];
      rgb[i + 2] = off[2];
      rgb[i + 3] = 255;
    }
    this.r.upload('cur', rgb, this.cols, this.rows);
    this.r.upload('next', rgb, this.cols, this.rows);
  };

  // Evaluates the scene a row at a time until the budget runs out, so a scene
  // change costs a few milliseconds per frame across the 4.6s hold instead of
  // one ~80ms hitch. This is what lets the density go up at all: per-frame cost
  // is now fixed, and only the build scales with the number of dots.
  Field.prototype.stepBuild = function (budget) {
    var p = this.pending;
    if (!p) return;
    var sc = SCENES[p.index],
      ar = this.ar,
      cols = this.cols,
      rows = this.rows;
    var du = 1 / (rows - 1),
      gu = this.gu;
    var code = p.code,
      rgb = p.rgb,
      lut = this.lut;
    var deadline = performance.now() + budget;

    while (p.gy < rows) {
      var gy = p.gy,
        Y = gy / (rows - 1),
        base = gy * cols;
      for (var gx = 0; gx < cols; gx++) {
        var X = (gx / (cols - 1)) * ar;
        var idx = KEY_INDEX[sc.f(X, Y, ar, du, gu)];
        var c = idx === undefined ? FALLBACK_CODE : idx * 5;
        var i = base + gx,
          o = c * 3,
          j = i * 4;
        code[i] = c;
        rgb[j] = lut[o];
        rgb[j + 1] = lut[o + 1];
        rgb[j + 2] = lut[o + 2];
        rgb[j + 3] = 255;
      }
      p.gy++;
      if (performance.now() >= deadline) break;
    }

    var done = p.gy >= rows;
    if (p.target === 'cur' && (this.gpu || done)) {
      // On the GPU, show the partial board: it fills in from the unrevealed
      // ground, which costs an upload. Repainting a half-built board by hand
      // would cost the whole board, so the flat path waits for the last row.
      this.r.upload('cur', rgb, cols, rows);
      this.dirty = true;
    }
    if (!done) return;
    this.pending = null;
    if (p.target === 'next') {
      this.r.upload('next', rgb, cols, rows);
      this.staged = true;
    }
  };

  // Hands the staged board to the lattice.
  Field.prototype.arm = function (now) {
    this.index = this.nextIndex;
    this.labels = SCENES[this.index].labels;
    this.staged = false;
    if (this.reduced()) {
      this.settle();
      this.labelAt = now;
    } else {
      this.sweepAt = now;
      this.labelAt = now + SWEEP * 0.55;
    }
    this.plate.draw(this, 0);
    this.dirty = true;
    this.onScene(SCENES[this.index].name);
  };

  // Settling is a pointer swap, not a copy: the board that was `next` simply
  // becomes `cur`. That is why a finished flip costs nothing -- the old version
  // wrote a new colour back into every cell it had flipped.
  Field.prototype.settle = function () {
    this.r.swap();
    var c = this.curCode;
    this.curCode = this.nextCode;
    this.nextCode = c;
    var g = this.curRGB;
    this.curRGB = this.nextRGB;
    this.nextRGB = g;
    this.sweepAt = -1;
    this.dirty = true;
  };

  Field.prototype.start = function () {
    if (this.running || this.lost) return;
    this.running = true;
    this.lastFlip = performance.now();
    var self = this;
    this.tickFn = function (now) {
      if (!self.running) return;
      self.raf = requestAnimationFrame(self.tickFn);
      self.frame(now);
    };
    this.raf = requestAnimationFrame(this.tickFn);
  };

  Field.prototype.stop = function () {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
  };

  Field.prototype.frame = function (now) {
    if (this.resizeAt && now - this.resizeAt > RESIZE_QUIET) {
      this.resizeAt = 0;
      this.resize();
    }

    // A board the reader is already looking at is worth more of the frame than
    // one being staged behind the hold.
    if (this.pending) this.stepBuild(this.pending.target === 'cur' ? BUILD_MS * 2 : BUILD_MS);

    var sweeping = this.sweepAt >= 0;
    if (sweeping && now - this.sweepAt > SWEEP_TOTAL) {
      this.settle();
      sweeping = false;
    }

    // Build the next board during the hold, so the sweep never waits on it.
    if (!sweeping && !this.pending && !this.staged) {
      this.nextIndex = (this.index + 1) % SCENES.length;
      this.beginBuild(this.nextIndex, 'next');
    }

    var hold = HOLD * (this.reduced() ? 2 : 1);
    if (!sweeping && this.staged && now - this.lastFlip > hold + SWEEP) {
      this.lastFlip = now;
      this.arm(now);
      sweeping = this.sweepAt >= 0;
    }

    if (now < this.labelAt + LABEL_FADE) {
      this.plate.draw(this, Math.max(0, Math.min(1, (now - this.labelAt) / LABEL_FADE)));
    }

    // The whole point: at rest there is nothing to draw. A scene holds for 4.6s
    // out of every 5.4, and those frames now cost one comparison.
    if (!sweeping && !this.dirty) return;
    this.dirty = false;
    this.r.draw(this, sweeping ? now - this.sweepAt : -1);
  };

  window.startField = function (canvasId, placeId) {
    var canvas = document.getElementById(canvasId);
    if (!canvas || !canvas.getContext) return null;
    var place = placeId ? document.getElementById(placeId) : null;
    var report = function (name) {
      if (place) place.textContent = name;
    };

    var gpu = new Lattice(canvas);
    if (gpu.ok) return new Field(canvas, gpu, true, report);

    // A canvas keeps the first context type it is asked for. If WebGL came up
    // but could not be programmed, that dead context has to be left behind with
    // the element -- otherwise getContext('2d') returns null and the page gets
    // no field at all rather than a plain one.
    var plain = canvas;
    if (canvas.parentNode) {
      plain = canvas.cloneNode(false);
      canvas.parentNode.replaceChild(plain, canvas);
    }
    var flat = new Flat(plain);
    if (!flat.ok) return null;
    return new Field(plain, flat, false, report);
  };
})();
