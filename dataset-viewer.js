(() => {
  "use strict";

  const section = document.querySelector("#dataset");
  const grid = document.querySelector("#mesh-grid");
  const status = document.querySelector("#mesh-status");
  if (!section || !grid || !status) return;

  const dataUrl = "assets/data/mesh-webgl-data.js";
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const previews = [];
  let dataRequested = false;
  let loaded = false;
  let sectionVisible = false;
  let raf = 0;
  let dataScript = null;

  const setState = (state, message) => {
    section.dataset.meshState = state;
    status.textContent = message;
  };
  const motionEnabled = () => {
    const requestedState = document.documentElement.dataset.motion;
    if (requestedState === "playing") return true;
    if (requestedState === "paused") return false;
    return !reducedMotion.matches;
  };
  const shouldAnimate = (cardVisible = true) =>
    motionEnabled() && !document.hidden && sectionVisible && cardVisible;

  function bytes(base64, Type) {
    const string = atob(base64);
    const array = new Uint8Array(string.length);
    for (let i = 0; i < string.length; i += 1) array[i] = string.charCodeAt(i);
    if (array.byteLength % Type.BYTES_PER_ELEMENT)
      throw new Error("Invalid 3D data buffer");
    return new Type(array.buffer);
  }
  function shader(gl, type, source) {
    const value = gl.createShader(type);
    gl.shaderSource(value, source);
    gl.compileShader(value);
    if (!gl.getShaderParameter(value, gl.COMPILE_STATUS))
      throw new Error(
        gl.getShaderInfoLog(value) || "Shader compilation failed",
      );
    return value;
  }
  function program(gl, vs, fs) {
    const value = gl.createProgram();
    const vertex = shader(gl, gl.VERTEX_SHADER, vs);
    const fragment = shader(gl, gl.FRAGMENT_SHADER, fs);
    gl.attachShader(value, vertex);
    gl.attachShader(value, fragment);
    gl.linkProgram(value);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(value, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(value) || "Shader link failed");
    return value;
  }
  function normals(
    vertices,
    faces,
    result = new Float32Array(vertices.length),
  ) {
    result.fill(0);
    for (let i = 0; i < faces.length; i += 3) {
      const a = faces[i] * 3,
        b = faces[i + 1] * 3,
        c = faces[i + 2] * 3;
      const abx = vertices[b] - vertices[a],
        aby = vertices[b + 1] - vertices[a + 1],
        abz = vertices[b + 2] - vertices[a + 2];
      const acx = vertices[c] - vertices[a],
        acy = vertices[c + 1] - vertices[a + 1],
        acz = vertices[c + 2] - vertices[a + 2];
      const x = aby * acz - abz * acy,
        y = abz * acx - abx * acz,
        z = abx * acy - aby * acx;
      result[a] += x;
      result[a + 1] += y;
      result[a + 2] += z;
      result[b] += x;
      result[b + 1] += y;
      result[b + 2] += z;
      result[c] += x;
      result[c + 1] += y;
      result[c + 2] += z;
    }
    for (let i = 0; i < result.length; i += 3) {
      const n = Math.hypot(result[i], result[i + 1], result[i + 2]) || 1;
      result[i] /= n;
      result[i + 1] /= n;
      result[i + 2] /= n;
    }
    return result;
  }

  const MESH_VS = `
    attribute vec3 p;
    attribute vec3 pn;
    attribute vec3 n;
    uniform mat4 m;
    uniform mat4 mn;
    uniform float mixf;
    uniform float angle;
    uniform float aspect;
    varying vec3 normal;
    void main() {
      vec3 first = (m * vec4(p, 1.0)).xyz;
      vec3 second = (mn * vec4(pn, 1.0)).xyz;
      vec3 world = mix(first, second, mixf);
      vec3 worldNormal = normalize(mix(mat3(m) * n, mat3(mn) * n, mixf));
      float c = cos(angle);
      float s = sin(angle);
      world = vec3(c * world.x - s * world.y, s * world.x + c * world.y, world.z);
      worldNormal = vec3(c * worldNormal.x - s * worldNormal.y, s * worldNormal.x + c * worldNormal.y, worldNormal.z);
      float elevation = 0.30;
      float ce = cos(elevation);
      float se = sin(elevation);
      float vertical = world.z * ce - world.y * se;
      normal = normalize(vec3(worldNormal.x, worldNormal.z * ce - worldNormal.y * se, worldNormal.y * ce + worldNormal.z * se));
      gl_Position = vec4(world.x * 1.58 / aspect, (vertical - 0.01) * 1.58, -(world.y * ce + world.z * se) * 1.35, 1.0);
    }
  `;
  const MESH_FS = `
    precision mediump float;
    uniform vec3 color;
    uniform float opacity;
    varying vec3 normal;
    void main() {
      vec3 lightDirection = normalize(vec3(-0.45, 0.35, 0.82));
      float shade = 0.70 + 0.30 * abs(dot(normalize(normal), lightDirection));
      gl_FragColor = vec4(color * shade, opacity);
    }
  `;
  const I = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const COLORS = {
    human: new Float32Array([0.84, 0.84, 0.88]),
    completed: new Float32Array([219 / 255, 221 / 255, 227 / 255]),
    driver: new Float32Array([247 / 255, 202 / 255, 201 / 255]),
    responder: new Float32Array([250 / 255, 235 / 255, 203 / 255]),
  };

  function setTelemetry(root, source, frame, elapsed, progress, angle) {
    const previewDuration = Number(
      source.previewDuration || source.sourceDuration,
    );
    const sourceDuration = Number(source.sourceDuration || previewDuration);
    const sourceTime = progress * sourceDuration;
    root.dataset.meshFrame = String(frame);
    root.dataset.meshAngle = angle.toFixed(3);
    root.dataset.meshPlayheadMs = String(Math.round(elapsed * 1000));
    root.dataset.meshPreviewSeconds = elapsed.toFixed(3);
    root.dataset.meshSourceSeconds = sourceTime.toFixed(3);
    const label = root.querySelector(".mesh-time");
    if (label) {
      const timing =
        sourceDuration > previewDuration
          ? "time-compressed preview of"
          : sourceDuration < previewDuration
            ? "slowed preview of"
            : "preview of";
      label.textContent = `${previewDuration.toFixed(1)} s ${timing} ${sourceDuration.toFixed(1)} s source · source t ${sourceTime.toFixed(1)} s`;
    }
  }

  class Preview {
    constructor(root, source, index, context) {
      this.root = root;
      this.source = source;
      this.canvas = root.querySelector("canvas");
      this.gl =
        context ||
        this.canvas.getContext("webgl", {
          antialias: true,
          alpha: false,
        });
      if (!this.gl) throw new Error("WebGL is unavailable");
      this.renderer = "webgl";
      this.angle = index * 0.72 - 0.55;
      this.initialAngle = this.angle;
      this.dragging = false;
      this.frame = -1;
      this.lastTick = performance.now();
      this.playhead = 0;
      this.decode();
      this.init();
      this.bind();
      this.resize();
      this.visible = true;
      if ("IntersectionObserver" in window) {
        this.observer = new IntersectionObserver(
          ([entry]) => {
            this.visible = entry.isIntersecting;
            this.syncClock();
          },
          { rootMargin: "120px" },
        );
        this.observer.observe(root);
      }
      this.syncClock();
    }
    decode() {
      const d = this.source;
      this.human = bytes(d.humanVertices, Float32Array);
      this.faces = bytes(d.observedFaces, Uint16Array);
      this.completedFaces = bytes(d.completedFaces, Uint16Array);
      this.transforms = bytes(d.objectTransforms, Float32Array);
      if (
        this.human.length !== d.frameCount * d.humanVertexCount * 3 ||
        this.faces.length !== d.observedFaceCount * 3 ||
        this.completedFaces.length !== d.completedFaceCount * 3 ||
        this.transforms.length !== d.frameCount * d.objects.length * 16
      )
        throw new Error("3D animation buffer size mismatch");
      if (
        this.faces.some((index) => index >= d.humanVertexCount) ||
        this.completedFaces.some((index) => index >= d.humanVertexCount)
      )
        throw new Error("3D human face index is out of range");
      this.allFaces = new Uint16Array(
        this.faces.length + this.completedFaces.length,
      );
      this.allFaces.set(this.faces);
      this.allFaces.set(this.completedFaces, this.faces.length);
      this.objects = d.objects.map((o) => ({
        ...o,
        vertices: bytes(o.vertices, Float32Array),
        faces: bytes(o.faces, Uint16Array),
      }));
    }
    buffer(target, contents, usage) {
      const b = this.gl.createBuffer();
      this.gl.bindBuffer(target, b);
      this.gl.bufferData(target, contents, usage);
      return b;
    }
    staticMesh(vertices, faces) {
      const gl = this.gl;
      return {
        p: this.buffer(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW),
        n: this.buffer(
          gl.ARRAY_BUFFER,
          normals(vertices, faces),
          gl.STATIC_DRAW,
        ),
        i: this.buffer(gl.ELEMENT_ARRAY_BUFFER, faces, gl.STATIC_DRAW),
        count: faces.length,
      };
    }
    init() {
      const gl = this.gl;
      this.meshProgram = program(gl, MESH_VS, MESH_FS);
      this.ml = {
        p: gl.getAttribLocation(this.meshProgram, "p"),
        pn: gl.getAttribLocation(this.meshProgram, "pn"),
        n: gl.getAttribLocation(this.meshProgram, "n"),
        m: gl.getUniformLocation(this.meshProgram, "m"),
        mn: gl.getUniformLocation(this.meshProgram, "mn"),
        mix: gl.getUniformLocation(this.meshProgram, "mixf"),
        angle: gl.getUniformLocation(this.meshProgram, "angle"),
        aspect: gl.getUniformLocation(this.meshProgram, "aspect"),
        color: gl.getUniformLocation(this.meshProgram, "color"),
        opacity: gl.getUniformLocation(this.meshProgram, "opacity"),
      };
      const size = this.source.humanVertexCount * 12;
      this.hm = {
        p: this.buffer(gl.ARRAY_BUFFER, size, gl.DYNAMIC_DRAW),
        pn: this.buffer(gl.ARRAY_BUFFER, size, gl.DYNAMIC_DRAW),
        n: this.buffer(gl.ARRAY_BUFFER, size, gl.DYNAMIC_DRAW),
        i: this.buffer(gl.ELEMENT_ARRAY_BUFFER, this.faces, gl.STATIC_DRAW),
        count: this.faces.length,
      };
      this.completedMesh = {
        p: this.hm.p,
        pn: this.hm.pn,
        n: this.hm.n,
        i: this.buffer(
          gl.ELEMENT_ARRAY_BUFFER,
          this.completedFaces,
          gl.STATIC_DRAW,
        ),
        count: this.completedFaces.length,
      };
      this.hn = new Float32Array(this.source.humanVertexCount * 3);
      this.om = this.objects.map((o) => this.staticMesh(o.vertices, o.faces));
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      this.setFrame(0);
    }
    setFrame(frame) {
      if (frame === this.frame) return;
      const gl = this.gl,
        d = this.source,
        next = (frame + 1) % d.frameCount,
        hs = d.humanVertexCount * 3;
      const h = this.human.subarray(frame * hs, (frame + 1) * hs),
        hn = this.human.subarray(next * hs, (next + 1) * hs);
      normals(h, this.allFaces, this.hn);
      [
        [this.hm.p, h],
        [this.hm.pn, hn],
        [this.hm.n, this.hn],
      ].forEach(([b, v]) => {
        gl.bindBuffer(gl.ARRAY_BUFFER, b);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, v);
      });
      this.frame = frame;
    }
    bind() {
      const viewport = this.root.querySelector(".mesh-viewport");
      viewport.addEventListener("pointerdown", (e) => {
        this.dragging = true;
        this.x = e.clientX;
        viewport.setPointerCapture(e.pointerId);
      });
      viewport.addEventListener("pointermove", (e) => {
        if (!this.dragging) return;
        this.angle += (e.clientX - this.x) * 0.011;
        this.x = e.clientX;
      });
      ["pointerup", "pointercancel"].forEach((type) =>
        viewport.addEventListener(type, () => {
          this.dragging = false;
        }),
      );
      viewport.addEventListener("keydown", (e) => {
        if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
        e.preventDefault();
        this.angle += e.key === "ArrowLeft" ? -0.16 : 0.16;
      });
      this.root.querySelector(".mesh-reset").addEventListener("click", () => {
        this.angle = this.initialAngle;
        this.draw(performance.now());
      });
      this.canvas.addEventListener("webglcontextlost", (e) => {
        e.preventDefault();
        this.visible = false;
        this.fail("3D context lost. Reload to restore the preview.");
      });
    }
    syncClock() {
      this.lastTick = performance.now();
    }
    fail(message) {
      this.root.classList.add("mesh-unavailable");
      const error = this.root.querySelector(".mesh-error");
      error.hidden = false;
      error.textContent = message;
    }
    resize() {
      const r = this.canvas.getBoundingClientRect(),
        ratio = Math.min(devicePixelRatio || 1, 1.5),
        w = Math.max(1, Math.round(r.width * ratio)),
        h = Math.max(1, Math.round(r.height * ratio));
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
        this.gl.viewport(0, 0, w, h);
      }
      this.ratio = ratio;
      this.aspect = r.width / Math.max(1, r.height);
    }
    bindMesh(mesh) {
      const gl = this.gl,
        l = this.ml;
      [
        [mesh.p, l.p],
        [mesh.pn || mesh.p, l.pn],
        [mesh.n, l.n],
      ].forEach(([b, loc]) => {
        gl.bindBuffer(gl.ARRAY_BUFFER, b);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
      });
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.i);
    }
    mesh(mesh, m, mn, color, mix, opacity = 1) {
      const gl = this.gl,
        l = this.ml;
      this.bindMesh(mesh);
      gl.uniformMatrix4fv(l.m, false, m);
      gl.uniformMatrix4fv(l.mn, false, mn);
      gl.uniform1f(l.mix, mix);
      gl.uniform3fv(l.color, color);
      gl.uniform1f(l.opacity, opacity);
      gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
    }
    draw(now, force = false) {
      if ((!this.visible && !force) || document.hidden || this.root.classList.contains("mesh-unavailable")) return;
      const moving = shouldAnimate(this.visible);
      const delta = Math.max(0, now - this.lastTick);
      this.lastTick = now;
      if (moving) {
        this.playhead += delta;
        if (!this.dragging) this.angle += delta * 0.000041;
      }
      const d = this.source,
        previewDuration = Number(d.previewDuration || d.sourceDuration),
        elapsed = (this.playhead / 1000) % previewDuration,
        progress = elapsed / previewDuration,
        exact =
          progress * Math.max(0, d.frameCount - 1),
        frame = Math.min(d.frameCount - 1, Math.floor(exact)),
        mix = exact - frame;
      setTelemetry(this.root, d, frame, elapsed, progress, this.angle);
      this.setFrame(frame);
      const gl = this.gl;
      gl.clearColor(1, 1, 1, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.disable(gl.BLEND);
      gl.useProgram(this.meshProgram);
      gl.uniform1f(this.ml.angle, this.angle);
      gl.uniform1f(this.ml.aspect, this.aspect);
      this.mesh(this.hm, I, I, COLORS.human, mix);
      const base = frame * this.objects.length * 16,
        next = ((frame + 1) % d.frameCount) * this.objects.length * 16;
      this.objects.forEach((o, i) =>
        this.mesh(
          this.om[i],
          this.transforms.subarray(base + i * 16, base + (i + 1) * 16),
          this.transforms.subarray(next + i * 16, next + (i + 1) * 16),
          COLORS[o.role] || COLORS.responder,
          mix,
        ),
      );
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      this.mesh(this.completedMesh, I, I, COLORS.completed, mix, 0.126);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
  }

  class SoftwarePreview {
    constructor(root, source, index) {
      this.root = root;
      this.source = source;
      this.canvas = root.querySelector("canvas");
      this.context = this.canvas.getContext("2d", { alpha: false });
      if (!this.context) throw new Error("Canvas is unavailable");
      this.renderer = "software";
      this.angle = index * 0.72 - 0.55;
      this.initialAngle = this.angle;
      this.dragging = false;
      this.lastTick = performance.now();
      this.playhead = 0;
      this.lastRender = 0;
      this.decode();
      this.bind();
      this.resize();
      this.visible = true;
      if ("IntersectionObserver" in window) {
        this.observer = new IntersectionObserver(
          ([entry]) => {
            this.visible = entry.isIntersecting;
            this.syncClock();
          },
          { rootMargin: "120px" },
        );
        this.observer.observe(root);
      }
      this.syncClock();
    }

    decode() {
      const d = this.source;
      this.human = bytes(d.humanVertices, Float32Array);
      this.faces = bytes(d.observedFaces, Uint16Array);
      this.completedFaces = bytes(d.completedFaces, Uint16Array);
      this.transforms = bytes(d.objectTransforms, Float32Array);
      if (
        this.human.length !== d.frameCount * d.humanVertexCount * 3 ||
        this.faces.length !== d.observedFaceCount * 3 ||
        this.completedFaces.length !== d.completedFaceCount * 3 ||
        this.transforms.length !== d.frameCount * d.objects.length * 16
      )
        throw new Error("3D animation buffer size mismatch");
      if (
        this.faces.some((index) => index >= d.humanVertexCount) ||
        this.completedFaces.some((index) => index >= d.humanVertexCount)
      )
        throw new Error("3D human face index is out of range");
      this.objects = d.objects.map((object) => ({
        ...object,
        vertices: bytes(object.vertices, Float32Array),
        faces: bytes(object.faces, Uint16Array),
      }));
    }

    bind() {
      const viewport = this.root.querySelector(".mesh-viewport");
      viewport.addEventListener("pointerdown", (event) => {
        this.dragging = true;
        this.lastX = event.clientX;
        viewport.setPointerCapture(event.pointerId);
      });
      viewport.addEventListener("pointermove", (event) => {
        if (!this.dragging) return;
        this.angle += (event.clientX - this.lastX) * 0.011;
        this.lastX = event.clientX;
        this.draw(performance.now(), true);
      });
      ["pointerup", "pointercancel"].forEach((type) =>
        viewport.addEventListener(type, () => {
          this.dragging = false;
        }),
      );
      viewport.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
        event.preventDefault();
        this.angle += event.key === "ArrowLeft" ? -0.16 : 0.16;
        this.draw(performance.now(), true);
      });
      this.root.querySelector(".mesh-reset").addEventListener("click", () => {
        this.angle = this.initialAngle;
        this.draw(performance.now(), true);
      });
    }

    resize() {
      const bounds = this.canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 1.25);
      const width = Math.max(1, Math.round(bounds.width * ratio));
      const height = Math.max(1, Math.round(bounds.height * ratio));
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
      }
      this.width = width;
      this.height = height;
      this.ratio = ratio;
      this.aspect = bounds.width / Math.max(bounds.height, 1);
    }

    syncClock() {
      this.lastTick = performance.now();
    }

    frameState(now) {
      const moving = shouldAnimate(this.visible);
      const delta = Math.max(0, now - this.lastTick);
      this.lastTick = now;
      if (moving) {
        this.playhead += delta;
        if (!this.dragging) this.angle += delta * 0.000041;
      }
      const previewDuration = Number(
        this.source.previewDuration || this.source.sourceDuration,
      );
      const elapsed = (this.playhead / 1000) % previewDuration;
      const progress = elapsed / previewDuration;
      const exact = progress * Math.max(0, this.source.frameCount - 1);
      const frame = Math.min(this.source.frameCount - 1, Math.floor(exact));
      return {
        frame,
        next: Math.min(frame + 1, this.source.frameCount - 1),
        mix: exact - frame,
        elapsed,
        progress,
      };
    }

    project(x, y, z) {
      const c = Math.cos(this.angle);
      const s = Math.sin(this.angle);
      const turnedX = c * x - s * y;
      const turnedY = s * x + c * y;
      const elevation = 0.3;
      const ce = Math.cos(elevation);
      const se = Math.sin(elevation);
      const vertical = z * ce - turnedY * se;
      return {
        x: (((turnedX * 1.58) / this.aspect) * 0.5 + 0.5) * this.width,
        y: (0.5 - (vertical - 0.01) * 1.58 * 0.5) * this.height,
        depth: -(turnedY * ce + z * se) * 1.35,
      };
    }

    transformedVertex(vertices, index, model, modelNext, mix) {
      const offset = index * 3;
      const x = vertices[offset];
      const y = vertices[offset + 1];
      const z = vertices[offset + 2];
      const firstX = model[0] * x + model[4] * y + model[8] * z + model[12];
      const firstY = model[1] * x + model[5] * y + model[9] * z + model[13];
      const firstZ = model[2] * x + model[6] * y + model[10] * z + model[14];
      const nextX =
        modelNext[0] * x + modelNext[4] * y + modelNext[8] * z + modelNext[12];
      const nextY =
        modelNext[1] * x + modelNext[5] * y + modelNext[9] * z + modelNext[13];
      const nextZ =
        modelNext[2] * x + modelNext[6] * y + modelNext[10] * z + modelNext[14];
      return this.project(
        firstX + (nextX - firstX) * mix,
        firstY + (nextY - firstY) * mix,
        firstZ + (nextZ - firstZ) * mix,
      );
    }

    humanVertex(index, frame, next, mix) {
      const stride = this.source.humanVertexCount * 3;
      const offset = index * 3;
      const first = frame * stride + offset;
      const second = next * stride + offset;
      return this.project(
        this.human[first] + (this.human[second] - this.human[first]) * mix,
        this.human[first + 1] +
          (this.human[second + 1] - this.human[first + 1]) * mix,
        this.human[first + 2] +
          (this.human[second + 2] - this.human[first + 2]) * mix,
      );
    }

    addTriangles(primitives, faces, vertex, color, opacity = 1) {
      for (let face = 0; face < faces.length; face += 3) {
        const a = vertex(faces[face]);
        const b = vertex(faces[face + 1]);
        const c = vertex(faces[face + 2]);
        const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
        if (Math.abs(area) < 0.02) continue;
        const shade = area < 0 ? 0.88 : 0.68;
        primitives.push({
          a,
          b,
          c,
          depth: (a.depth + b.depth + c.depth) / 3,
          color,
          shade,
          opacity,
        });
      }
    }

    draw(now, force = false) {
      if ((!this.visible && !force) || document.hidden) return;
      // Keep the timebase at requestAnimationFrame precision even when painting
      // full meshes at a lower sustainable rate.
      const state = this.frameState(now);
      if (!force && now - this.lastRender < 1000 / 15) return;
      this.lastRender = now;
      const { frame, next, mix, elapsed, progress } = state;
      setTelemetry(this.root, this.source, frame, elapsed, progress, this.angle);
      const primitives = [];
      const projectCached = (count, projectVertex) => {
        const cache = new Array(count);
        return (index) => cache[index] || (cache[index] = projectVertex(index));
      };
      const humanVertex = projectCached(this.source.humanVertexCount, (index) =>
        this.humanVertex(index, frame, next, mix),
      );
      this.addTriangles(primitives, this.faces, humanVertex, [214, 214, 224]);
      this.addTriangles(
        primitives,
        this.completedFaces,
        humanVertex,
        [219, 221, 227],
        0.126,
      );

      const transformBase = frame * this.objects.length * 16;
      const nextTransformBase = next * this.objects.length * 16;
      this.objects.forEach((object, objectIndex) => {
        const model = this.transforms.subarray(
          transformBase + objectIndex * 16,
          transformBase + (objectIndex + 1) * 16,
        );
        const modelNext = this.transforms.subarray(
          nextTransformBase + objectIndex * 16,
          nextTransformBase + (objectIndex + 1) * 16,
        );
        const objectVertex = projectCached(object.vertexCount, (index) =>
          this.transformedVertex(object.vertices, index, model, modelNext, mix),
        );
        const color =
          object.role === "driver" ? [247, 202, 201] : [250, 235, 203];
        this.addTriangles(primitives, object.faces, objectVertex, color);
      });

      primitives.sort((left, right) => right.depth - left.depth);
      const context = this.context;
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, this.width, this.height);
      primitives.forEach((primitive) => {
        const [r, g, b] = primitive.color.map((value) =>
          Math.round(value * primitive.shade),
        );
        context.fillStyle =
          primitive.opacity < 1
            ? `rgba(${r}, ${g}, ${b}, ${primitive.opacity})`
            : `rgb(${r}, ${g}, ${b})`;
        context.beginPath();
        context.moveTo(primitive.a.x, primitive.a.y);
        context.lineTo(primitive.b.x, primitive.b.y);
        context.lineTo(primitive.c.x, primitive.c.y);
        context.closePath();
        context.fill();
      });
    }
  }

  function animate(now) {
    previews.forEach((preview) => preview.draw(now));
    raf = requestAnimationFrame(animate);
  }
  function replaceCanvasForSoftwareFallback(article) {
    // A canvas that has already produced a WebGL context cannot reliably
    // acquire a 2D context. Preserve its accessible attributes in a fresh node.
    const canvas = article.querySelector("canvas");
    const replacement = canvas.cloneNode(false);
    canvas.replaceWith(replacement);
  }
  function card(source, index) {
    const article = document.createElement("article");
    article.className = "mesh-card";
    const caption = source.title.startsWith("OakInk2")
      ? "Observed upper-body motion with a completed lower body."
      : source.caption;
    article.innerHTML = `
      <div class="mesh-viewport" tabindex="0" role="group"
        aria-label="${source.title}: drag or use left and right arrow keys to rotate the three-dimensional scene">
        <canvas aria-label="Three-dimensional mesh preview of ${source.title}"></canvas>
        <span class="mesh-error" role="status" aria-live="polite" hidden></span>
      </div>
      <div class="mesh-caption">
        <strong>${source.title}</strong>
        <p>${caption}</p>
        <p class="mesh-time"></p>
        <p class="mesh-renderer" role="status" aria-live="polite"></p>
        <button class="mesh-reset" type="button">Reset view</button>
      </div>`;
    grid.append(article);
    article.dataset.observedTriangles = String(source.observedFaceCount);
    article.dataset.completedTriangles = String(source.completedFaceCount);
    article.dataset.previewDuration = String(source.previewDuration);
    article.dataset.sourceDuration = String(source.sourceDuration);
    try {
      const canvas = article.querySelector("canvas");
      const webgl = canvas.getContext("webgl", {
        antialias: true,
        alpha: false,
      });
      let preview;
      let fallbackMessage = "";
      if (webgl) {
        try {
          preview = new Preview(article, source, index, webgl);
        } catch (_) {
          replaceCanvasForSoftwareFallback(article);
          preview = new SoftwarePreview(article, source, index);
          fallbackMessage = "WebGL failed; using software rendering.";
        }
      } else {
        preview = new SoftwarePreview(article, source, index);
        fallbackMessage = "WebGL unavailable; using software rendering.";
      }
      article.dataset.renderer = preview.renderer;
      article.querySelector(".mesh-renderer").textContent = fallbackMessage;
      return preview;
    } catch (error) {
      article.classList.add("mesh-unavailable");
      article.querySelector(".mesh-error").hidden = false;
      article.querySelector(".mesh-error").textContent =
        "3D preview unavailable in this browser.";
      return null;
    }
  }
  function prepareRetry(message) {
    loaded = false;
    dataRequested = false;
    if (dataScript) dataScript.remove();
    dataScript = null;
    grid.replaceChildren();
    setState("error", message);
    if (loader) {
      loader.disabled = false;
      loader.hidden = false;
      loader.textContent = "Retry 3D examples";
    }
  }

  function initialise() {
    if (loaded) return;
    loaded = true;
    const data = window.CHOIS_WEBGL_DATA;
    if (!Array.isArray(data) || !data.length) {
      prepareRetry(
        "3D dataset assets were invalid. Please retry loading them.",
      );
      return;
    }
    data.forEach((item, index) => {
      const view = card(item, index);
      if (view) previews.push(view);
    });
    if (!previews.length) {
      prepareRetry(
        "3D previews are unavailable in this browser. Please retry.",
      );
      return;
    }
    setState("ready", "");
    if (loader) loader.hidden = true;
    if (!raf) raf = requestAnimationFrame(animate);
  }

  function requestData() {
    if (dataRequested) return;
    dataRequested = true;
    if (loader) { loader.disabled = true; loader.hidden = true; }
    setState("loading", "Loading interactive 3D dataset examples…");
    dataScript = document.createElement("script");
    dataScript.src = dataUrl;
    dataScript.async = true;
    dataScript.onload = initialise;
    dataScript.onerror = () =>
      prepareRetry("3D dataset assets could not be loaded. Please retry.");
    document.head.append(dataScript);
  }
  const loader = document.querySelector("#mesh-retry");
  if (loader) loader.addEventListener("click", requestData);
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) requestData();
      },
      { rootMargin: "500px 0px" },
    ).observe(section);
    new IntersectionObserver(
      (entries) => {
        sectionVisible = entries.some((entry) => entry.isIntersecting);
      },
      { threshold: 0 },
    ).observe(section);
  } else {
    // No manual Load control: browsers without observers load automatically.
    sectionVisible = true;
    requestData();
  }
  document.addEventListener("bump-motion-change", () => {
    previews.forEach((view) => {
      view.syncClock();
      view.draw(performance.now());
    });
  });
  document.addEventListener("visibilitychange", () =>
    previews.forEach((view) => {
      view.syncClock();
    }),
  );
  reducedMotion.addEventListener("change", () =>
    previews.forEach((view) => {
      view.syncClock();
      view.draw(performance.now());
    }),
  );
  window.addEventListener("resize", () =>
    previews.forEach((view) => {
      view.resize();
      // A resize clears canvas pixels even offscreen; restore its held source frame.
      view.draw(performance.now(), true);
    }),
  );
  if (!dataRequested) {
    setState(
      "idle",
      "Interactive 3D examples load when this section approaches view.",
    );
  }
})();
