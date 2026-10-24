/* Navigators sound: generative music and ambient effects, all synthesised in Web Audio. window.NVSound. */
(function () {
  'use strict';
  var AC = window.AudioContext || window.webkitAudioContext;
  var KINDS = ['sea', 'overland', 'polar'];
  var noop = function () {};
  if (!AC) {
    window.NVSound = { start: noop, setMusic: noop, setEffects: noop, setVolume: noop, update: noop, cue: noop,
      state: function () { return { music: false, effects: false, volume: 0, running: false }; },
      _level: function () { return 0; }, _peak: function () { return 0; } };
    return;
  }

  var ctx = null, master, comp, analyser, musicBus, fxBus, verbIn, white, pink, brown, buf;
  var want = { music: false, effects: false, volume: 0.7 };
  var st = { playing: false, kind: null, held: false, moving: false };
  var layers = { m: {}, f: {} };
  var musicTimer = 0, fxTimer = 0, suspendTimer = 0, peak = 0, last = '';
  var noteIdx = { sea: 3, overland: 4, polar: 2 };
  var SCALES = {
    sea: [62, 64, 67, 69, 71, 74, 76, 79],
    overland: [57, 60, 62, 64, 67, 69, 72, 74, 76],
    polar: [71, 76, 78, 83, 88, 90, 95]
  };

  function rnd(a, b) { return a + Math.random() * (b - a); }
  function hz(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  function pick(a) { return a[Math.floor(Math.random() * a.length)]; }

  function makeBuffers() {
    var n = ctx.sampleRate * 4, i, w, b = 0, p0 = 0, p1 = 0, p2 = 0, x;
    white = ctx.createBuffer(1, n, ctx.sampleRate);
    pink = ctx.createBuffer(1, n, ctx.sampleRate);
    brown = ctx.createBuffer(1, n, ctx.sampleRate);
    var dw = white.getChannelData(0), dp = pink.getChannelData(0), db = brown.getChannelData(0);
    for (i = 0; i < n; i++) {
      w = Math.random() * 2 - 1;
      dw[i] = w;
      p0 = 0.99765 * p0 + w * 0.099046; p1 = 0.963 * p1 + w * 0.2965164; p2 = 0.57 * p2 + w * 1.0526913;
      dp[i] = (p0 + p1 + p2 + w * 0.1848) * 0.25;
      b = (b + 0.02 * w) / 1.02;
      db[i] = b * 3.2;
    }
    var fade = 2000;
    [dw, dp, db].forEach(function (d) {
      for (i = 0; i < fade; i++) { x = i / fade; d[n - fade + i] = d[n - fade + i] * (1 - x) + d[i] * x; }
    });
  }

  function makeReverb() {
    var len = Math.floor(ctx.sampleRate * 3), ir = ctx.createBuffer(2, len, ctx.sampleRate), c, i, d, lp, t;
    for (c = 0; c < 2; c++) {
      d = ir.getChannelData(c); lp = 0;
      for (i = 0; i < len; i++) {
        t = i / len;
        lp += (Math.random() * 2 - 1 - lp) * (0.9 - 0.75 * t);
        d[i] = lp * Math.pow(1 - t, 2.6) * (t < 0.01 ? t * 100 : 1);
      }
    }
    var conv = ctx.createConvolver(); conv.buffer = ir;
    var wet = ctx.createGain(); wet.gain.value = 0.55;
    verbIn = ctx.createGain(); verbIn.gain.value = 1;
    verbIn.connect(conv); conv.connect(wet); wet.connect(master);
  }

  function build() {
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = 0;
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -22; comp.ratio.value = 6; comp.attack.value = 0.02; comp.release.value = 0.4;
    analyser = ctx.createAnalyser(); analyser.fftSize = 2048;
    master.connect(comp); comp.connect(analyser); analyser.connect(ctx.destination);
    buf = new Float32Array(analyser.fftSize);
    makeBuffers(); makeReverb();
    musicBus = ctx.createGain(); musicBus.gain.value = 0.8;
    musicBus.connect(master);
    var ms = ctx.createGain(); ms.gain.value = 0.6; musicBus.connect(ms); ms.connect(verbIn);
    fxBus = ctx.createGain(); fxBus.gain.value = 0.5;
    fxBus.connect(master);
    var fs = ctx.createGain(); fs.gain.value = 0.25; fxBus.connect(fs); fs.connect(verbIn);
    master.gain.setTargetAtTime(want.volume * 0.5, ctx.currentTime, 0.05);
  }

  function env(g, t, a, pk, d) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(pk, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }

  function tone(type, f, t, a, pk, d, dest) {
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.value = f;
    env(g, t, a, pk, d);
    o.connect(g); g.connect(dest);
    o.start(t); o.stop(t + a + d + 0.1);
    return o;
  }

  function panned(dest, p) {
    if (!ctx.createStereoPanner) return dest;
    var s = ctx.createStereoPanner(); s.pan.value = p; s.connect(dest); return s;
  }

  function filt(type, f, q, dest) {
    var b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q || 0.7;
    b.connect(dest); return b;
  }

  function loopNoise(b) {
    var s = ctx.createBufferSource(); s.buffer = b; s.loop = true;
    s.start(0, Math.random() * 3); return s;
  }

  function burst(b, t, dur, dest) {
    var s = ctx.createBufferSource(); s.buffer = b;
    s.start(t, Math.random() * 3, dur + 0.05); s.stop(t + dur + 0.06);
    s.connect(dest); return s;
  }

  function lfo(rate, depth, param, srcs) {
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = rate; g.gain.value = depth;
    o.connect(g); g.connect(param); o.start(); srcs.push(o); return o;
  }

  function fadeIn(g, tc) { g.gain.setValueAtTime(0, ctx.currentTime); g.gain.setTargetAtTime(1, ctx.currentTime, tc); }

  function release(layer) {
    var now = ctx.currentTime;
    layer.gain.gain.cancelScheduledValues(now);
    layer.gain.gain.setTargetAtTime(0, now, 0.7);
    setTimeout(function () {
      layer.srcs.forEach(function (s) { try { s.stop(); } catch (e) {} });
      try { layer.gain.disconnect(); } catch (e) {}
    }, 4500);
  }

  function musicLayer(kind) {
    var g = ctx.createGain(), srcs = [], parts, lp, i;
    g.connect(musicBus); fadeIn(g, 1.6);
    var spec = {
      sea: { type: 'sine', f: [73.4, 110, 146.8], lp: 500, a: 0.05 },
      overland: { type: 'triangle', f: [55, 82.4, 110], lp: 420, a: 0.05 },
      polar: { type: 'sine', f: [164.8, 247, 329.6], lp: 900, a: 0.018 }
    }[kind];
    lp = filt('lowpass', spec.lp, 0.5, g);
    for (i = 0; i < spec.f.length; i++) {
      var o = ctx.createOscillator(), og = ctx.createGain();
      o.type = spec.type; o.frequency.value = spec.f[i] * (1 + rnd(-0.002, 0.002));
      og.gain.value = spec.a * (i === 1 ? 0.8 : 1);
      lfo(rnd(0.03, 0.09), spec.a * 0.6, og.gain, srcs);
      o.connect(og); og.connect(lp); o.start(); srcs.push(o);
    }
    lfo(0.04, spec.lp * 0.25, lp.frequency, srcs);
    return { gain: g, srcs: srcs };
  }

  function fxLayer(kind) {
    var g = ctx.createGain(), srcs = [], n, f, ng;
    g.connect(fxBus); fadeIn(g, 1.2);
    if (kind === 'sea') {
      n = loopNoise(brown); f = filt('lowpass', 650, 0.5, null || (ng = ctx.createGain()));
      ng.gain.value = 0.05; ng.connect(g); n.connect(f); srcs.push(n);
      lfo(0.09, 0.035, ng.gain, srcs); lfo(0.063, 280, f.frequency, srcs);
      var n2 = loopNoise(pink), f2 = filt('highpass', 2500, 0.5, ng = ctx.createGain());
      ng.gain.value = 0.008; ng.connect(g); n2.connect(f2); srcs.push(n2);
      lfo(0.11, 0.006, ng.gain, srcs);
    } else if (kind === 'overland') {
      n = loopNoise(pink); f = filt('bandpass', 1100, 0.9, ng = ctx.createGain());
      ng.gain.value = 0.05; ng.connect(g); n.connect(f); srcs.push(n);
      lfo(0.13, 0.03, ng.gain, srcs); lfo(0.08, 350, f.frequency, srcs);
    } else {
      n = loopNoise(pink); f = filt('bandpass', 420, 5, ng = ctx.createGain());
      ng.gain.value = 0.07; ng.connect(g); n.connect(f); srcs.push(n);
      lfo(0.07, 0.045, ng.gain, srcs); lfo(0.05, 160, f.frequency, srcs);
      var n3 = loopNoise(white), f3 = filt('highpass', 6500, 0.5, ng = ctx.createGain());
      ng.gain.value = 0.006; ng.connect(g); n3.connect(f3); srcs.push(n3);
    }
    return { gain: g, srcs: srcs };
  }

  function toggle(set, k, on, builder) {
    if (on && !set[k]) set[k] = builder(k);
    else if (!on && set[k]) { release(set[k]); set[k] = null; }
  }

  function note(kind, dest, m, t) {
    var f = hz(m), lp;
    if (kind === 'sea') {
      lp = filt('lowpass', 2200, 0.5, dest);
      tone('sine', f, t, 0.8, 0.1, 4.5, lp); tone('triangle', f * 1.003, t, 0.9, 0.03, 4, lp);
    } else if (kind === 'overland') {
      lp = filt('lowpass', 2600, 0.8, dest);
      lp.frequency.setValueAtTime(2600, t); lp.frequency.exponentialRampToValueAtTime(550, t + 0.8);
      tone('triangle', f, t, 0.01, 0.15, 1.9, lp); tone('sine', f * 2, t, 0.01, 0.03, 0.9, lp);
    } else {
      tone('sine', f, t, 0.015, 0.075, 5, dest); tone('sine', f * 2.76, t, 0.01, 0.018, 1.6, dest);
      tone('sine', f * 5.4, t, 0.005, 0.007, 0.6, dest);
    }
  }

  function musicTick() {
    musicTimer = 0;
    var kind = st.kind || 'sea', layer = layers.m[kind];
    if (!want.music || !ctx || !layer) return;
    if (Math.random() > 0.2) {
      var sc = SCALES[kind], i = noteIdx[kind];
      i += pick([-2, -1, -1, 0, 1, 1, 2, 3]);
      i = Math.max(0, Math.min(sc.length - 1, i)); noteIdx[kind] = i;
      var t = ctx.currentTime + 0.05;
      note(kind, layer.gain, sc[i], t);
      if (Math.random() < 0.25) note(kind, layer.gain, sc[Math.max(0, i - pick([2, 3, 4]))] , t + rnd(0.1, 0.6));
    }
    var span = { sea: [3, 8], overland: [2.5, 6.5], polar: [6, 14] }[kind];
    musicTimer = setTimeout(musicTick, rnd(span[0], span[1]) * 1000);
  }

  function gull(t) {
    var p = panned(fxBus, rnd(-0.6, 0.6)), n = pick([2, 3]), i, o, g, bp, s, f0 = rnd(1500, 2000);
    for (i = 0; i < n; i++) {
      var ti = t + i * rnd(0.5, 0.7);
      o = ctx.createOscillator(); g = ctx.createGain(); bp = filt('bandpass', 2300, 2, g);
      o.type = 'triangle';
      o.frequency.setValueAtTime(f0 * 1.2, ti);
      o.frequency.linearRampToValueAtTime(f0 * 1.9, ti + 0.12);
      o.frequency.exponentialRampToValueAtTime(f0 * 1.05, ti + 0.45);
      lfo(rnd(25, 40), 60, o.frequency, []);
      env(g, ti, 0.05, 0.035, 0.4);
      o.connect(bp); g.connect(p); o.start(ti); o.stop(ti + 0.6);
      s = burst(white, ti, 0.4, filt('bandpass', 3000, 1.5, g)); void s;
    }
  }

  function creak(t) {
    var o = ctx.createOscillator(), g = ctx.createGain(), bp = filt('bandpass', rnd(500, 900), 9, g), i, d = rnd(0.6, 1.2);
    o.type = 'sawtooth';
    for (i = 0; i < 12; i++) o.frequency.setValueAtTime(rnd(60, 120), t + i * d / 12);
    env(g, t, d * 0.3, 0.025, d * 0.7);
    o.connect(bp); g.connect(panned(fxBus, rnd(-0.4, 0.4))); o.start(t); o.stop(t + d + 0.2);
  }

  function birds(t) {
    var dest = panned(fxBus, rnd(-0.7, 0.7)), n = pick([2, 3, 4]), i, base = rnd(2600, 3800), o, g, ti;
    for (i = 0; i < n; i++) {
      ti = t + i * rnd(0.11, 0.2);
      o = ctx.createOscillator(); g = ctx.createGain(); o.type = 'sine';
      o.frequency.setValueAtTime(base, ti); o.frequency.exponentialRampToValueAtTime(base * rnd(1.15, 1.4), ti + 0.06);
      env(g, ti, 0.01, 0.018, 0.07);
      o.connect(g); g.connect(dest); o.start(ti); o.stop(ti + 0.12);
    }
  }

  function insects(t) {
    var d = rnd(1.5, 3), o = ctx.createOscillator(), am = ctx.createGain(), og = ctx.createGain(), l = ctx.createOscillator(),
      lg = ctx.createGain(), bp = filt('bandpass', 4300, 6, og);
    o.type = 'square'; o.frequency.value = rnd(4000, 4800);
    am.gain.value = 0.5; l.frequency.value = rnd(18, 32); lg.gain.value = 0.5;
    l.connect(lg); lg.connect(am.gain); o.connect(am); am.connect(bp);
    env(og, t, 0.5, 0.005, d); og.connect(panned(fxBus, rnd(-0.8, 0.8)));
    o.start(t); l.start(t); o.stop(t + d + 0.6); l.stop(t + d + 0.6);
  }

  function steps(t, kind) {
    var n = pick([3, 4, 5, 6]), i, ti, dest = panned(fxBus, rnd(-0.3, 0.3));
    for (i = 0; i < n; i++) {
      ti = t + i * rnd(0.5, 0.62);
      var g = ctx.createGain(), f;
      if (kind === 'polar') {
        f = filt('bandpass', rnd(2200, 3200), 1.2, g); env(g, ti, 0.01, 0.025, 0.09);
        burst(white, ti, 0.1, f);
      } else {
        f = filt('lowpass', 260, 0.7, g); env(g, ti, 0.012, 0.05, 0.1);
        burst(pink, ti, 0.12, f);
        tone('sine', 70, ti, 0.008, 0.04, 0.1, dest);
      }
      g.connect(dest);
    }
  }

  function crack(t) {
    var dest = panned(fxBus, rnd(-0.7, 0.7)), g = ctx.createGain(), hp = filt('highpass', 1800, 0.7, g), o = ctx.createOscillator(), og = ctx.createGain();
    env(g, t, 0.002, 0.05, 0.05); g.connect(dest); burst(white, t, 0.06, hp);
    o.type = 'sine'; o.frequency.setValueAtTime(rnd(2500, 3500), t); o.frequency.exponentialRampToValueAtTime(500, t + 0.25);
    env(og, t, 0.003, 0.02, 0.25); o.connect(og); og.connect(dest); o.start(t); o.stop(t + 0.35);
    if (Math.random() < 0.5) {
      var t2 = t + rnd(0.12, 0.3), g2 = ctx.createGain();
      env(g2, t2, 0.002, 0.03, 0.04); g2.connect(dest); burst(white, t2, 0.05, filt('highpass', 2500, 0.7, g2));
    }
  }

  function fxTick() {
    fxTimer = 0;
    var kind = st.kind;
    if (!want.effects || !ctx || !st.playing || !kind) return;
    var t = ctx.currentTime + 0.05, r = Math.random(), calm = st.held ? 0.35 : 1;
    if (kind === 'sea') {
      if (r < 0.22 * calm) gull(t); else if (r < 0.38 * calm) creak(t);
    } else if (kind === 'overland') {
      if (st.moving && !st.held && r < 0.7) steps(t, kind);
      else if (r < 0.3 * calm) birds(t); else if (r < 0.45 * calm) insects(t);
    } else {
      if (st.moving && !st.held && r < 0.55) steps(t, kind);
      else if (r < 0.2 * calm) crack(t);
    }
    var span = st.held ? [4, 9] : (st.moving ? [2, 4] : [2, 5]);
    fxTimer = setTimeout(fxTick, rnd(span[0], span[1]) * 1000);
  }

  function sync() {
    if (!ctx) return;
    var any = want.music || want.effects, mk = st.kind || 'sea';
    if (any) {
      clearTimeout(suspendTimer); suspendTimer = 0;
      if (ctx.state !== 'running') ctx.resume();
    }
    KINDS.forEach(function (k) {
      toggle(layers.m, k, want.music && k === mk, musicLayer);
      toggle(layers.f, k, want.effects && st.playing && k === st.kind, fxLayer);
    });
    fxBus.gain.setTargetAtTime(st.held ? 0.3 : 0.5, ctx.currentTime, 0.8);
    if (want.music && !musicTimer) musicTimer = setTimeout(musicTick, 800);
    if (want.effects && st.playing && st.kind && !fxTimer) fxTimer = setTimeout(fxTick, 600);
    if (!any && !suspendTimer) {
      suspendTimer = setTimeout(function () {
        suspendTimer = 0;
        if (!want.music && !want.effects && ctx.state === 'running') ctx.suspend();
      }, 5000);
    }
  }

  function safe(fn) { return function () { try { return fn.apply(null, arguments); } catch (e) {} }; }

  window.NVSound = {
    start: safe(function () {
      if (!ctx) build();
      if (want.music || want.effects) ctx.resume();
      sync();
    }),
    setMusic: safe(function (on) {
      want.music = !!on;
      if (!on && musicTimer) { clearTimeout(musicTimer); musicTimer = 0; }
      sync();
    }),
    setEffects: safe(function (on) {
      want.effects = !!on;
      if (!on && fxTimer) { clearTimeout(fxTimer); fxTimer = 0; }
      sync();
    }),
    setVolume: safe(function (v) {
      v = Math.max(0, Math.min(1, +v || 0)); want.volume = v;
      if (ctx) master.gain.setTargetAtTime(v * 0.5, ctx.currentTime, 0.08);
    }),
    update: safe(function (s) {
      s = s || {};
      var k = KINDS.indexOf(s.kind) >= 0 ? s.kind : null;
      var key = [!!s.playing, k, !!s.held, !!s.moving].join();
      if (key === last) return;
      last = key;
      st.playing = !!s.playing; st.kind = k; st.held = !!s.held; st.moving = !!s.moving;
      sync();
    }),
    cue: safe(function () {
      if (!ctx || !(want.music || want.effects) || ctx.state !== 'running') return;
      var t = ctx.currentTime + 0.02, dest = ctx.createGain();
      dest.gain.value = 1; dest.connect(musicBus);
      tone('sine', 659.3, t, 0.01, 0.07, 2.4, dest); tone('sine', 659.3 * 2.76, t, 0.005, 0.012, 0.8, dest);
      tone('sine', 987.8, t + 0.22, 0.01, 0.055, 2.8, dest); tone('sine', 987.8 * 2.76, t + 0.22, 0.005, 0.01, 0.8, dest);
    }),
    state: function () {
      return { music: want.music, effects: want.effects, volume: want.volume, running: !!ctx && ctx.state === 'running' };
    },
    _level: function () {
      if (!ctx) return 0;
      analyser.getFloatTimeDomainData(buf);
      var s = 0, i, a;
      for (i = 0; i < buf.length; i++) { a = Math.abs(buf[i]); s += a * a; if (a > peak) peak = a; }
      return Math.sqrt(s / buf.length);
    },
    _peak: function () { var p = peak; peak = 0; return p; }
  };
})();
