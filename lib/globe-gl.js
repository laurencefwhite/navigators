/*
  GlobeGL – the heavy layers of a canvas globe, drawn on the graphics card.
  Copyright 2026 Laurence F. White. All rights reserved.

  Fills and borders for sets of polygons whose corners are unit vectors on the sphere, an ocean disc with a
  lit-sphere gradient, and a veil over the disc. The page keeps its own 2D canvas on top for labels, lines and
  anything light.

  Polygons are filled without being cut into triangles: each ring is drawn as a fan of triangles from its first
  corner, first into the stencil buffer only (each pixel's bit flips every time a triangle covers it), then again
  in colour wherever the bit is set, clearing it as it goes. What is left painted is exactly what the outline
  encloses, holes and islands included, whatever shape the fan triangles take. Corners are placed on the sphere
  in the vertex shader with the same basis the 2D fast path uses (FX, FY and the centre), so a polygon wholly on
  the near side needs nothing from the processor per frame. A polygon crossing the limb is clipped by the page
  (d3 does that well) and handed over in screen coordinates for the same two-pass fill.
*/
(function () {
'use strict';

var VS_SPHERE = '#version 300 es\n' +
  'in vec3 aV;\n' +
  'uniform vec3 uFX; uniform vec3 uFY; uniform vec2 uC; uniform vec2 uSize;\n' +
  'void main() {\n' +
  '  vec2 s = vec2(dot(uFX, aV), dot(uFY, aV)) + uC;\n' +
  '  gl_Position = vec4(s.x / uSize.x * 2.0 - 1.0, 1.0 - s.y / uSize.y * 2.0, 0.0, 1.0);\n' +
  '}\n';
/* Lines on the sphere, with no clipping on the processor: a corner on the far side is given a depth beyond
   the far plane, so the card cuts every segment where it passes behind the globe. Corners on the near side sit
   on the near plane; a segment crossing the limb is cut within a hair of it. */
var VS_LINES = '#version 300 es\n' +
  'in vec3 aV;\n' +
  'uniform vec3 uFX; uniform vec3 uFY; uniform vec3 uVZ; uniform vec2 uC; uniform vec2 uSize;\n' +
  'void main() {\n' +
  '  vec2 s = vec2(dot(uFX, aV), dot(uFY, aV)) + uC;\n' +
  '  float z = max(-1.0, -dot(uVZ, aV) * 1000.0);\n' +
  '  gl_Position = vec4(s.x / uSize.x * 2.0 - 1.0, 1.0 - s.y / uSize.y * 2.0, z, 1.0);\n' +
  '}\n';
var VS_SCREEN = '#version 300 es\n' +
  'in vec2 aP;\n' +
  'uniform vec2 uSize;\n' +
  'void main() { gl_Position = vec4(aP.x / uSize.x * 2.0 - 1.0, 1.0 - aP.y / uSize.y * 2.0, 0.0, 1.0); }\n';
var FS_FLAT = '#version 300 es\n' +
  'precision mediump float;\n' +
  'uniform vec4 uColour;\n' +
  'out vec4 o;\n' +
  'void main() { o = vec4(uColour.rgb * uColour.a, uColour.a); }\n';
/* the ocean, or a veil: a quad over the whole canvas, kept to the disc with a one-pixel soft edge */
var FS_DISC = '#version 300 es\n' +
  'precision highp float;\n' +
  'uniform vec2 uC; uniform float uR; uniform float uDPR; uniform float uHdev;\n' +
  'uniform vec2 uG0; uniform float uGr0; uniform vec2 uG1; uniform float uGr1;\n' +
  'uniform vec3 uCol0; uniform vec3 uCol1; uniform vec4 uVeil; uniform float uMode;\n' +
  'uniform vec3 uEX; uniform vec3 uEY; uniform vec3 uEZ; uniform float uUseMask; uniform float uLod;\n' +
  'uniform vec3 uLand; uniform sampler2D uMask;\n' +
  'uniform float uUseRelief; uniform sampler2D uRelief; uniform float uLodR;\n' +
  'uniform float uUseZones; uniform sampler2D uZones; uniform sampler2D uPal; uniform vec2 uZoneSize;\n' +
  'out vec4 o;\n' +
  'void main() {\n' +
  '  vec2 p = vec2(gl_FragCoord.x, uHdev - gl_FragCoord.y) / uDPR;\n' +
  '  float d = length(p - uC);\n' +
  '  float inside = clamp(uR - d + 0.5, 0.0, 1.0);\n' +
  '  if (inside <= 0.0) discard;\n' +
  '  vec4 c;\n' +
  '  if (uMode < 0.5) {\n' +
  /* as canvas does it: the largest t for which p lies on the circle between the two given, radius >= 0 */
  '    vec2 cd = uG1 - uG0, pd = p - uG0; float dr = uGr1 - uGr0;\n' +
  '    float A = dot(cd, cd) - dr * dr, B = dot(pd, cd) + uGr0 * dr, C = dot(pd, pd) - uGr0 * uGr0;\n' +
  '    float t = 0.0;\n' +
  '    if (abs(A) < 1e-6) t = C / (2.0 * B);\n' +
  '    else { float D = max(0.0, B * B - A * C), q = sqrt(D); float t1 = (B + q) / A, t2 = (B - q) / A;\n' +
  '      t = max(t1, t2); if (uGr0 + t * dr < 0.0) t = min(t1, t2); }\n' +
  '    t = clamp(t, 0.0, 1.0);\n' +
  '    c = vec4(mix(uCol0, uCol1, t), 1.0);\n' +
  /* where the pixel is on the sphere, and whether that is land: the inverse of the orthographic view */
  '    if (uUseMask > 0.5) {\n' +
  '      vec2 q = (p - uC) / uR; float zz = sqrt(max(0.0, 1.0 - dot(q, q)));\n' +
  '      vec3 v = uEX * q.x + uEY * q.y + uEZ * zz;\n' +
  '      vec2 uv = vec2(atan(v.y, v.x) / 6.2831853 + 0.5, 0.5 - asin(clamp(v.z, -1.0, 1.0)) / 3.1415927);\n' +
  '      float m = textureLod(uMask, uv, uLod).r;\n' +
  '      c.rgb = mix(c.rgb, uUseRelief > 0.5 ? textureLod(uRelief, uv, uLodR).rgb : uLand, m);\n' +
  /* regions as a map of ids: the id under the pixel, exactly (no filtering), then its colour from the palette */
  '      if (uUseZones > 0.5) {\n' +
  '        ivec2 tp = ivec2(clamp(uv * uZoneSize, vec2(0.0), uZoneSize - 1.0));\n' +
  '        vec4 zz4 = texelFetch(uZones, tp, 0);\n' +
  '        int id = int(zz4.r * 255.0 + 0.5) + int(zz4.g * 255.0 + 0.5) * 256;\n' +
  '        vec4 pc = texelFetch(uPal, ivec2(id, 0), 0);\n' +
  '        c.rgb = mix(c.rgb, pc.rgb, pc.a);\n' +
  '      }\n' +
  '    }\n' +
  '  } else c = uVeil;\n' +
  '  c.a *= inside;\n' +
  '  o = vec4(c.rgb * c.a, c.a);\n' +
  '}\n';
/* Soft layers. What is drawn between layerBegin and layerEnd goes to an offscreen image at half resolution,
   which is blurred (a Gaussian in two passes) and laid over the frame, kept to the land by the land mask so that
   a soft edge never spills over a coastline. For borders known only roughly: the width is given by the page. */
var FS_BLUR = '#version 300 es\n' +
  'precision highp float;\n' +
  'uniform sampler2D uTex; uniform vec2 uRes; uniform vec2 uDir; uniform float uStep;\n' +
  'out vec4 o;\n' +
  'void main() {\n' +
  '  vec2 uv = gl_FragCoord.xy / uRes;\n' +
  '  vec4 acc = vec4(0.0); float wsum = 0.0;\n' +
  '  for (int k = -7; k <= 7; k++) {\n' +
  '    float t = float(k) / 3.5;\n' +
  '    float w = exp(-0.5 * t * t);\n' +
  '    acc += texture(uTex, uv + uDir * float(k) * uStep / uRes) * w; wsum += w;\n' +
  '  }\n' +
  '  o = acc / wsum;\n' +
  '}\n';
var FS_COMP = '#version 300 es\n' +
  'precision highp float;\n' +
  'uniform sampler2D uTex; uniform vec2 uDev; uniform float uAlpha;\n' +
  'uniform vec2 uC; uniform float uR; uniform float uDPR; uniform float uHdev;\n' +
  'uniform vec3 uEX; uniform vec3 uEY; uniform vec3 uEZ; uniform float uUseMask; uniform float uLod; uniform sampler2D uMask;\n' +
  'out vec4 o;\n' +
  'void main() {\n' +
  '  vec2 p = vec2(gl_FragCoord.x, uHdev - gl_FragCoord.y) / uDPR;\n' +
  '  vec2 q = (p - uC) / uR;\n' +
  '  float d2 = dot(q, q);\n' +
  '  if (d2 >= 1.0) discard;\n' +
  '  float m = 1.0;\n' +
  '  if (uUseMask > 0.5) {\n' +
  '    vec3 v = uEX * q.x + uEY * q.y + uEZ * sqrt(1.0 - d2);\n' +
  '    vec2 uv = vec2(atan(v.y, v.x) / 6.2831853 + 0.5, 0.5 - asin(clamp(v.z, -1.0, 1.0)) / 3.1415927);\n' +
  '    m = smoothstep(0.25, 0.75, textureLod(uMask, uv, uLod).r);\n' +
  '  }\n' +
  '  o = texture(uTex, gl_FragCoord.xy / uDev) * (m * uAlpha);\n' +
  '}\n';

function compile(gl, type, src) {
  var sh = gl.createShader(type);
  gl.shaderSource(sh, src); gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
  return sh;
}
function program(gl, vs, fs) {
  var p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  var u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (var i = 0; i < n; i++) { var a = gl.getActiveUniform(p, i); u[a.name] = gl.getUniformLocation(p, a.name); }
  return { p: p, u: u };
}

function create(canvas) {
  var gl = null;
  try { gl = canvas.getContext('webgl2', { stencil: true, antialias: true, premultipliedAlpha: true, alpha: true }); } catch (e) { gl = null; }
  if (!gl) return null;
  var sphereP, screenP, discP, lineP, blurP, compP;
  try {
    sphereP = program(gl, VS_SPHERE, FS_FLAT);
    lineP = program(gl, VS_LINES, FS_FLAT);
    screenP = program(gl, VS_SCREEN, FS_FLAT);
    discP = program(gl, VS_SCREEN, FS_DISC);
    blurP = program(gl, VS_SCREEN, FS_BLUR);
    compP = program(gl, VS_SCREEN, FS_COMP);
  } catch (err) {
    if (window.console) console.warn('GlobeGL: falling back to 2D:', err.message);
    return null;
  }
  var W = 1, H = 1, DPR = 1, view = { fx: [0, 0, 0], fy: [0, 0, 0], cx: 0, cy: 0, r: 1, vz: [1, 0, 0] };
  var reliefTex = null, reliefW = 0, maskTex = null, maskW = 0, zoneTex = null, zoneW = 0, zoneH = 0, palTex = null;

  /* one quad over the canvas, for the ocean and the veil */
  var quadVao = gl.createVertexArray(), quadBuf = gl.createBuffer();
  gl.bindVertexArray(quadVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  var aPd = gl.getAttribLocation(discP.p, 'aP');
  gl.enableVertexAttribArray(aPd);
  gl.vertexAttribPointer(aPd, 2, gl.FLOAT, false, 0, 0);

  /* the stream buffer for polygons clipped at the limb, in screen coordinates */
  var scrVao = gl.createVertexArray(), scrBuf = gl.createBuffer(), scrIdx = gl.createBuffer();
  gl.bindVertexArray(scrVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, scrBuf);
  var aPs = gl.getAttribLocation(screenP.p, 'aP');
  gl.enableVertexAttribArray(aPs);
  gl.vertexAttribPointer(aPs, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, scrIdx);
  gl.bindVertexArray(null);

  gl.enable(gl.BLEND);
  gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.disable(gl.DEPTH_TEST);

  var current = null;
  function use(P) {
    if (current === P) return;
    current = P; gl.useProgram(P.p);
    if (P.u.uSize) gl.uniform2f(P.u.uSize, W, H);
    if (P === sphereP || P === lineP) {
      gl.uniform3fv(P.u.uFX, view.fx); gl.uniform3fv(P.u.uFY, view.fy); gl.uniform2f(P.u.uC, view.cx, view.cy);
    }
    if (P === lineP) gl.uniform3fv(P.u.uVZ, view.vz);
  }
  function stencilFill(count, colour, drawFn) {
    /* pass 1: flip the stencil wherever a fan triangle lands */
    gl.enable(gl.STENCIL_TEST);
    gl.colorMask(false, false, false, false);
    gl.stencilFunc(gl.ALWAYS, 0, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
    drawFn();
    /* pass 2: paint where the count came out odd, and put the stencil back to nothing */
    gl.colorMask(true, true, true, true);
    gl.stencilFunc(gl.NOTEQUAL, 0, 0xff);
    gl.stencilOp(gl.ZERO, gl.ZERO, gl.ZERO);
    gl.uniform4fv(current.u.uColour, colour);
    drawFn();
    gl.disable(gl.STENCIL_TEST);
  }

  /* fan triangles and border segments for a list of rings, appended to the arrays given */
  function addRings(rings, dims, verts, tri, lines, base) {
    for (var r = 0; r < rings.length; r++) {
      var a = rings[r], n = a.length / dims;
      if (n < 3) continue;
      var first = base.v;
      for (var k = 0; k < a.length; k++) verts.push(a[k]);
      base.v += n;
      /* a closed ring repeats its first corner at the end; the fan and the segments cope either way */
      for (var t = 1; t < n - 1; t++) tri.push(first, first + t, first + t + 1);
      for (var s = 0; s < n - 1; s++) lines.push(first + s, first + s + 1);
    }
  }

  function gather(S, list, which, colour) {
    var total = 0, i, r;
    for (i = 0; i < list.length; i++) { r = S.ranges[list[i]]; if (r) total += r[which]; }
    if (!total) return;
    var out = new Uint32Array(total), at = 0, off = which === 1 ? 0 : S.triLen;
    for (i = 0; i < list.length; i++) {
      r = S.ranges[list[i]];
      if (!r || !r[which]) continue;
      var from = off + r[which - 1];
      out.set(S.idx.subarray(from, from + r[which]), at); at += r[which];
    }
    use(sphereP);
    gl.bindVertexArray(S.vao2);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, out, gl.STREAM_DRAW);
    if (which === 1) stencilFill(total, colour, function () { gl.drawElements(gl.TRIANGLES, total, gl.UNSIGNED_INT, 0); });
    else { gl.uniform4fv(sphereP.u.uColour, colour); gl.drawElements(gl.LINES, total, gl.UNSIGNED_INT, 0); }
  }

  /* the soft layer: two half-resolution images, the first with a stencil for the fills drawn into it */
  var layer = null, quadVaos = {};
  function quadFor(P) {
    if (quadVaos[P === blurP ? 'b' : 'c']) return quadVaos[P === blurP ? 'b' : 'c'];
    var v = gl.createVertexArray();
    gl.bindVertexArray(v); gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    var a = gl.getAttribLocation(P.p, 'aP'); gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return (quadVaos[P === blurP ? 'b' : 'c'] = v);
  }
  function ensureLayer() {
    var w = Math.max(1, Math.round(canvas.width / 2)), h = Math.max(1, Math.round(canvas.height / 2));
    if (layer && layer.w === w && layer.h === h) return layer;
    if (layer) { layer.tex.forEach(function (t) { gl.deleteTexture(t); }); layer.fbo.forEach(function (f) { gl.deleteFramebuffer(f); }); gl.deleteRenderbuffer(layer.rb); }
    layer = { w: w, h: h, tex: [], fbo: [], rb: gl.createRenderbuffer() };
    gl.bindRenderbuffer(gl.RENDERBUFFER, layer.rb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, w, h);
    for (var k = 0; k < 2; k++) {
      var t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      var f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      if (k === 0) gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, layer.rb);
      layer.tex.push(t); layer.fbo.push(f);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return layer;
  }

  var blank = null;
  function blankTex() {
    if (blank) return blank;
    blank = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, blank);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    return blank;
  }

  var api = {
    gl: gl,
    resize: function (w, h, dpr) {
      W = w; H = h; DPR = dpr;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, w, 0, 0, h, w, h]), gl.STATIC_DRAW);
      current = null;
    },
    /* start a frame: the view in the same terms as the page's fast projection */
    frame: function (fx, fy, cx, cy, r, vz) {
      view = { fx: fx, fy: fy, cx: cx, cy: cy, r: r, vz: vz || [1, 0, 0] };
      current = null;
      gl.clearColor(0, 0, 0, 0); gl.clearStencil(0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    },
    ocean: function (col0, col1, g0x, g0y, gr0, g1x, g1y, gr1, land, zones) {
      use(discP);
      var u = discP.u, r = view.r;
      var useZones = !!(zones && zoneTex && palTex);
      var useMask = !!((land || useZones) && (maskTex || useZones));
      gl.uniform1f(u.uUseMask, useMask ? 1 : 0);
      gl.uniform1f(u.uUseZones, useZones ? 1 : 0);
      if (useZones) {
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, zoneTex); gl.uniform1i(u.uZones, 1);
        gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, palTex); gl.uniform1i(u.uPal, 2);
        gl.uniform2f(u.uZoneSize, zoneW, zoneH);
      }
      if (useMask) {
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, land && maskTex ? maskTex : blankTex()); gl.uniform1i(u.uMask, 0);
        gl.uniform3f(u.uEX, view.fx[0] / r, view.fx[1] / r, view.fx[2] / r);
        gl.uniform3f(u.uEY, view.fy[0] / r, view.fy[1] / r, view.fy[2] / r);
        gl.uniform3fv(u.uEZ, view.vz); gl.uniform3fv(u.uLand, land || [0, 0, 0]);
        gl.uniform1f(u.uUseRelief, land && reliefTex ? 1 : 0);
        if (land && reliefTex) {
          gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, reliefTex); gl.uniform1i(u.uRelief, 3);
          gl.uniform1f(u.uLodR, Math.max(0, Math.log2(reliefW / (2 * Math.PI * r))));
          gl.activeTexture(gl.TEXTURE0);
        }
        /* texels per screen pixel at the centre of the disc sets the level of detail */
        gl.uniform1f(u.uLod, Math.max(0, Math.log2(maskW / (2 * Math.PI * r))));
      }
      gl.uniform2f(u.uC, view.cx, view.cy); gl.uniform1f(u.uR, view.r);
      gl.uniform1f(u.uDPR, DPR); gl.uniform1f(u.uHdev, canvas.height);
      gl.uniform2f(u.uG0, g0x, g0y); gl.uniform1f(u.uGr0, gr0); gl.uniform2f(u.uG1, g1x, g1y); gl.uniform1f(u.uGr1, gr1);
      gl.uniform3fv(u.uCol0, col0); gl.uniform3fv(u.uCol1, col1); gl.uniform1f(u.uMode, 0);
      gl.bindVertexArray(quadVao); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
    veil: function (rgba) {
      use(discP);
      var u = discP.u;
      gl.uniform2f(u.uC, view.cx, view.cy); gl.uniform1f(u.uR, view.r);
      gl.uniform1f(u.uDPR, DPR); gl.uniform1f(u.uHdev, canvas.height);
      gl.uniform4fv(u.uVeil, rgba); gl.uniform1f(u.uMode, 1);
      gl.bindVertexArray(quadVao); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
    /* a set of items, each a list of rings of unit vectors (Float32Array x,y,z,...), uploaded once */
    set: function (items) {
      var verts = [], tri = [], lines = [], base = { v: 0 }, ranges = [];
      for (var i = 0; i < items.length; i++) {
        var t0 = tri.length, l0 = lines.length;
        addRings(items[i], 3, verts, tri, lines, base);
        ranges.push([t0, tri.length - t0, l0, lines.length - l0]);
      }
      var S = { vao: gl.createVertexArray(), vb: gl.createBuffer(), ib: gl.createBuffer(), ranges: ranges,
                triLen: tri.length, verts: base.v,
                /* a second view of the same corners, with indices gathered each frame for batched calls */
                vao2: gl.createVertexArray(), sib: gl.createBuffer(), idx: null };
      gl.bindVertexArray(S.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, S.vb);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
      var aV = gl.getAttribLocation(sphereP.p, 'aV');
      gl.enableVertexAttribArray(aV);
      gl.vertexAttribPointer(aV, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, S.ib);
      var idx = new Uint32Array(tri.length + lines.length);
      idx.set(tri, 0); idx.set(lines, tri.length);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
      S.idx = idx;
      gl.bindVertexArray(S.vao2);
      gl.bindBuffer(gl.ARRAY_BUFFER, S.vb);
      gl.enableVertexAttribArray(aV);
      gl.vertexAttribPointer(aV, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, S.sib);
      gl.bindVertexArray(null);
      return S;
    },
    drop: function (S) {
      if (!S) return;
      gl.deleteVertexArray(S.vao); gl.deleteBuffer(S.vb); gl.deleteBuffer(S.ib);
      gl.deleteVertexArray(S.vao2); gl.deleteBuffer(S.sib);
    },
    fill: function (S, i, colour) {
      var r = S.ranges[i];
      if (!r || !r[1]) return;
      use(sphereP);
      gl.bindVertexArray(S.vao);
      stencilFill(r[1], colour, function () { gl.drawElements(gl.TRIANGLES, r[1], gl.UNSIGNED_INT, r[0] * 4); });
    },
    lines: function (S, i, colour) {
      var r = S.ranges[i];
      if (!r || !r[3]) return;
      use(sphereP);
      gl.bindVertexArray(S.vao);
      gl.uniform4fv(sphereP.u.uColour, colour);
      gl.drawElements(gl.LINES, r[3], gl.UNSIGNED_INT, (S.triLen + r[2]) * 4);
    },
    /* Many items in one call. Every WebGL call has a fixed cost, and at the world view the land alone was
       170 fills. Items filled together must not overlap one another (the stencil counts them as one shape),
       which holds for countries; lines have no such limit. */
    fillMany: function (S, list, colour) { gather(S, list, 1, colour); },
    linesMany: function (S, list, colour) { gather(S, list, 3, colour); },
    /* Static lines (coasts, borders, meshes): a list of polylines of unit vectors, uploaded once and drawn in
       one call, clipped at the limb by the card. */
    lineSet: function (lines) {
      var verts = [], idx = [], base = 0;
      for (var i = 0; i < lines.length; i++) {
        var a = lines[i], m = a.length / 3;
        if (m < 2) continue;
        for (var k = 0; k < a.length; k++) verts.push(a[k]);
        for (var t = 0; t < m - 1; t++) idx.push(base + t, base + t + 1);
        base += m;
      }
      var L = { vao: gl.createVertexArray(), vb: gl.createBuffer(), ib: gl.createBuffer(), count: idx.length };
      gl.bindVertexArray(L.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, L.vb);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
      var aV = gl.getAttribLocation(lineP.p, 'aV');
      gl.enableVertexAttribArray(aV);
      gl.vertexAttribPointer(aV, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, L.ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(idx), gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      return L;
    },
    drawLines: function (L, colour) {
      if (!L || !L.count) return;
      use(lineP);
      gl.bindVertexArray(L.vao);
      gl.uniform4fv(lineP.u.uColour, colour);
      gl.drawElements(gl.LINES, L.count, gl.UNSIGNED_INT, 0);
    },
    dropLines: function (L) {
      if (!L) return;
      gl.deleteVertexArray(L.vao); gl.deleteBuffer(L.vb); gl.deleteBuffer(L.ib);
    },
    /* a polygon already clipped and projected by the page: rings of screen x,y pairs */
    screen: function (rings, fillColour, lineColour) {
      var verts = [], tri = [], lines = [], base = { v: 0 };
      addRings(rings, 2, verts, tri, lines, base);
      if (!tri.length) return;
      use(screenP);
      gl.bindVertexArray(scrVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, scrBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STREAM_DRAW);
      var idx = new Uint32Array(tri.length + lines.length);
      idx.set(tri, 0); idx.set(lines, tri.length);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, scrIdx);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STREAM_DRAW);
      if (fillColour) stencilFill(tri.length, fillColour, function () { gl.drawElements(gl.TRIANGLES, tri.length, gl.UNSIGNED_INT, 0); });
      if (lineColour && lines.length) {
        gl.uniform4fv(screenP.u.uColour, lineColour);
        gl.drawElements(gl.LINES, lines.length, gl.UNSIGNED_INT, tri.length * 4);
      }
    },
    /* the land, drawn flat (equirectangular) on a canvas by the page, for the ocean pass to look up */
    landMask: function (cv) {
      maskTex = gl.createTexture(); maskW = cv.width;
      gl.bindTexture(gl.TEXTURE_2D, maskTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, cv);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.generateMipmap(gl.TEXTURE_2D);
    },
    hasMask: function () { return !!maskTex; },
    /* the colour of the land, drawn flat (equirectangular) – relief, ice – used in place of a flat land colour */
    relief: function (img) {
      reliefTex = gl.createTexture(); reliefW = img.width;
      gl.bindTexture(gl.TEXTURE_2D, reliefTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, gl.RGB, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.generateMipmap(gl.TEXTURE_2D);
    },
    hasRelief: function () { return !!reliefTex; },
    /* a map of region ids (RGBA bytes: id in red and green) and a palette of colours by id, for regions that
       tile the land without overlapping, such as time zones */
    zoneMap: function (w, h, bytes) {
      zoneTex = gl.createTexture(); zoneW = w; zoneH = h;
      gl.bindTexture(gl.TEXTURE_2D, zoneTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    },
    hasZones: function () { return !!zoneTex; },
    palette: function (bytes) {
      if (!palTex) palTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, palTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, bytes.length / 4, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    },
    /* draw into the soft layer until layerEnd */
    layerBegin: function () {
      var L = ensureLayer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, L.fbo[0]);
      gl.viewport(0, 0, L.w, L.h);
      gl.clearColor(0, 0, 0, 0); gl.clearStencil(0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
      current = null;
    },
    /* blur what was drawn by radiusPx (screen pixels, about two standard deviations) and lay it over the frame,
       kept to the land where the land mask is loaded */
    layerEnd: function (radiusPx, alpha) {
      var L = layer, step = Math.max(0.3, radiusPx * DPR / 2 / 3.5);
      gl.disable(gl.BLEND);
      use(blurP);
      gl.uniform2f(blurP.u.uRes, L.w, L.h); gl.uniform1f(blurP.u.uStep, step); gl.uniform1i(blurP.u.uTex, 3);
      gl.bindVertexArray(quadFor(blurP));
      gl.uniform2f(blurP.u.uSize, W, H);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, L.fbo[1]); gl.bindTexture(gl.TEXTURE_2D, L.tex[0]);
      gl.uniform2f(blurP.u.uDir, 1, 0); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, L.fbo[0]); gl.bindTexture(gl.TEXTURE_2D, L.tex[1]);
      gl.uniform2f(blurP.u.uDir, 0, 1); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.enable(gl.BLEND);
      use(compP);
      var u = compP.u, r = view.r;
      gl.bindTexture(gl.TEXTURE_2D, L.tex[0]); gl.uniform1i(u.uTex, 3);
      gl.uniform2f(u.uDev, canvas.width, canvas.height); gl.uniform1f(u.uAlpha, alpha === undefined ? 1 : alpha);
      gl.uniform2f(u.uC, view.cx, view.cy); gl.uniform1f(u.uR, r);
      gl.uniform1f(u.uDPR, DPR); gl.uniform1f(u.uHdev, canvas.height);
      gl.uniform1f(u.uUseMask, maskTex ? 1 : 0);
      if (maskTex) {
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, maskTex); gl.uniform1i(u.uMask, 0);
        gl.uniform3f(u.uEX, view.fx[0] / r, view.fx[1] / r, view.fx[2] / r);
        gl.uniform3f(u.uEY, view.fy[0] / r, view.fy[1] / r, view.fy[2] / r);
        gl.uniform3fv(u.uEZ, view.vz);
        gl.uniform1f(u.uLod, Math.max(0, Math.log2(maskW / (2 * Math.PI * r))));
      }
      gl.bindVertexArray(quadFor(compP)); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      current = null;
    },
    renderer: function () {
      var d = gl.getExtension('WEBGL_debug_renderer_info');
      return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    }
  };
  return api;
}

/* a d3 path context that collects what d3 draws (clipped at the limb) as rings of screen points */
function ringCollector() {
  var rings = [], cur = null;
  return {
    rings: rings,
    reset: function () { rings.length = 0; cur = null; },
    moveTo: function (x, y) { cur = [x, y]; rings.push(cur); },
    lineTo: function (x, y) { if (cur) cur.push(x, y); },
    closePath: function () { if (cur && cur.length >= 4) cur.push(cur[0], cur[1]); cur = null; },
    arc: function () {}
  };
}

/* a GeoJSON geometry (or feature) as rings or polylines of unit vectors, for set() and lineSet() */
function toXYZ(g) {
  g = g && g.geometry ? g.geometry : g;
  var out = [], D = Math.PI / 180;
  function add(r) {
    var a = new Float32Array(r.length * 3);
    for (var i = 0; i < r.length; i++) {
      var l = r[i][0] * D, p = r[i][1] * D, c = Math.cos(p);
      a[i * 3] = c * Math.cos(l); a[i * 3 + 1] = c * Math.sin(l); a[i * 3 + 2] = Math.sin(p);
    }
    out.push(a);
  }
  if (!g) return out;
  var c = g.coordinates, i, j;
  if (g.type === 'Polygon' || g.type === 'MultiLineString') for (i = 0; i < c.length; i++) add(c[i]);
  else if (g.type === 'MultiPolygon') for (i = 0; i < c.length; i++) for (j = 0; j < c[i].length; j++) add(c[i][j]);
  else if (g.type === 'LineString') add(c);
  return out;
}

/* CSS colour to premultiply-ready floats */
function rgba(s) {
  var c = d3.rgb(s);
  return [c.r / 255, c.g / 255, c.b / 255, c.opacity == null ? 1 : c.opacity];
}

window.GlobeGL = { create: create, ringCollector: ringCollector, rgba: rgba, toXYZ: toXYZ };
})();
