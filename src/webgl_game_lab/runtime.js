/* Original runtime adapter; no third-party game assets or fixed heap addresses. */
(function (root) {
  'use strict';
  function createLab(env = root) {
    const module = env.unityInstance && env.unityInstance.Module;
    if (!module || !module.HEAPU8) throw new Error('UNSUPPORTED: Unity HEAPU8 unavailable');
    const rows = [], events = [], maps = [];
    const limit = 5000;
    let handle = null, held = null, previous = null, mapKey = '', networkStop = null;
    const layouts = new Map();
    const bytes = () => module.HEAPU8;
    const view = () => new DataView(bytes().buffer, bytes().byteOffset, bytes().byteLength);
    function valid(p, size = 4) { return Number.isInteger(p) && p > 0 && p + size <= bytes().length; }
    function u32(p) { if (!valid(p)) throw new Error('LAYOUT: invalid pointer'); return view().getUint32(p, true); }
    function f32(p) { if (!valid(p)) throw new Error('LAYOUT: invalid float'); return view().getFloat32(p, true); }
    function f64(p) { if (!valid(p, 8)) throw new Error('LAYOUT: invalid double'); return view().getFloat64(p, true); }
    function string(p, max = 180) {
      if (!valid(p, 1)) return '';
      const b = bytes(); let end = p;
      while (end < b.length && b[end] && end - p < max) end++;
      if (b[end] !== 0) return '';
      return new TextDecoder().decode(b.subarray(p, end));
    }
    function push(list, item) { list.push(item); if (list.length > limit) list.shift(); }
    function fields(klass) {
      const table = u32(klass + 64), result = {}, types = {}, attributes = {};
      for (let i = 0; i < 256 && valid(table + i * 20, 20); i++) {
        const p = table + i * 20;
        if (u32(p + 8) !== klass) break;
        const name = string(u32(p)), offset = u32(p + 12);
        if (!name || offset > 4096) throw new Error('LAYOUT: invalid FieldInfo');
        result[name] = offset;
        types[name] = (u32(u32(p + 4) + 4) >>> 16) & 255;
        attributes[name] = u32(u32(p + 4) + 4) & 65535;
      }
      return { offsets: result, types, attributes };
    }
    function layout(name, required, namespace = 'Moe.Ski') {
      if (layouts.has(name)) return layouts.get(name);
      const b = bytes(), words = new Uint32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4));
      const needle = new TextEncoder().encode(name), addresses = new Set();
      for (let i = 1; i < b.length - needle.length; i++) {
        if (b[i - 1] !== 0 || b[i] !== needle[0] || b[i + needle.length] !== 0) continue;
        let match = true;
        for (let j = 1; j < needle.length; j++) if (b[i + j] !== needle[j]) { match = false; break; }
        if (match) addresses.add(i);
      }
      const candidates = [];
      for (let i = 2; i < words.length - 44; i++) {
        if (!addresses.has(words[i])) continue;
        const p = i * 4 - 8;
        if (words[i + 6] !== p || words[i + 7] !== p || string(words[i + 1]) !== namespace) continue;
        try {
          const parsed = fields(p);
          if (required.every(n => Object.hasOwn(parsed.offsets, n))) candidates.push({ klass: p, fields: parsed.offsets, types: parsed.types, attributes: parsed.attributes });
        } catch (_) { /* A string reference need not be an IL2CPP class. */ }
      }
      if (candidates.length !== 1) throw new Error('LAYOUT: expected one compatible ' + name);
      layouts.set(name, candidates[0]); return candidates[0];
    }
    const gameNames = ['roundDuration', 'elapsedSeconds', 'worldX', 'startX', 'initialized',
      '<IsFinished>k__BackingField', '<IsPaused>k__BackingField', '<Speed>k__BackingField',
      '<Height>k__BackingField', 'course', 'runRandomizer'];
    function checkFields(spec, expected) {
      const ranges = [];
      for (const [name, kind] of Object.entries(expected)) {
        const offset = spec.fields[name], size = kind === 13 ? 8 : kind === 2 ? 1 : 4;
        if (spec.types[name] !== kind || spec.attributes[name] & (0x10 | 0x40) ||
            offset < 16 || offset % size || ranges.some(([a, b]) => offset < b && offset + size > a))
          throw new Error('LAYOUT: incompatible instance field layout');
        ranges.push([offset, offset + size]);
      }
      return spec;
    }
    function gameSpec() {
      const expected = { roundDuration: 12, elapsedSeconds: 13, worldX: 12, startX: 12,
        initialized: 2, '<IsFinished>k__BackingField': 2, '<IsPaused>k__BackingField': 2,
        '<Speed>k__BackingField': 12, '<Height>k__BackingField': 12, course: 18, runRandomizer: 18 };
      const spec = layout('SkiSoloGame', gameNames);
      for (const name of ['<CrashCount>k__BackingField', '<TotalFlips>k__BackingField'])
        if (name in spec.fields) expected[name] = 8;
      return checkFields(spec, expected);
    }
    function preflight() {
      const spec = gameSpec();
      return { profile: 'moe-ski-wasm32-v1', compatible: true, fields: spec.fields,
        scope: 'metadata-layout; active instance and map formula require separate verification' };
    }
    function resolve() {
      const spec = gameSpec(), off = spec.fields;
      const b = bytes(), words = new Uint32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4));
      const max = Math.max(...Object.values(off)) + 8, candidates = [];
      for (let i = 0; i < words.length - Math.ceil(max / 4); i++) {
        if (words[i] !== spec.klass || !valid(words[i + 2])) continue;
        const p = i * 4;
        if (b[p + off.initialized] !== 1 || b[p + off['<IsFinished>k__BackingField']] > 1) continue;
        const duration = f32(p + off.roundDuration), elapsed = f64(p + off.elapsedSeconds);
        const x = f32(p + off.worldX), speed = f32(p + off['<Speed>k__BackingField']);
        if (![duration, elapsed, x, speed].every(Number.isFinite) || duration < 1 || duration > 86400 ||
          elapsed < 0 || elapsed > 86400 || Math.abs(x) > 1e7 || Math.abs(speed) > 1e5) continue;
        candidates.push({ pointer: p, native: words[i + 2], ...spec });
      }
      if (candidates.length !== 1) throw new Error('INSTANCE: expected one live instance; found ' + candidates.length);
      return candidates[0];
    }
    function stateOf(obj) {
      const p = obj.pointer, o = obj.fields, elapsed = f64(p + o.elapsedSeconds), duration = f32(p + o.roundDuration);
      const state = { wall: Date.now(), binding: { pointer: p, native: obj.native }, elapsed, duration,
        remaining: Math.max(0, Math.max(1, duration) - elapsed), x: f32(p + o.worldX),
        startX: f32(p + o.startX), speed: f32(p + o['<Speed>k__BackingField']),
        height: f32(p + o['<Height>k__BackingField']), finished: !!bytes()[p + o['<IsFinished>k__BackingField']],
        paused: !!bytes()[p + o['<IsPaused>k__BackingField']] };
      for (const [key, field] of [['crashes', '<CrashCount>k__BackingField'], ['flips', '<TotalFlips>k__BackingField']])
        if (field in o) state[key] = u32(p + o[field]);
      return state;
    }
    const same = (a, b) => a && b && a.pointer === b.pointer && a.native === b.native;
    function refresh() {
      let obj;
      try { obj = resolve(); } catch (e) {
        if (held) { held = null; push(events, { wall: Date.now(), event: 'hold-released', reason: 'instance-unavailable' }); }
        throw e;
      }
      const reset = previous && same(previous, obj) && stateOf(obj).elapsed < previous.elapsed - 0.5;
      if (held && (!same(held.binding, obj) || reset)) {
        held = null; push(events, { wall: Date.now(), event: 'hold-released', reason: 'instance-changed' });
      }
      if (reset) mapKey = '';
      if (!same(previous, obj)) push(events, { wall: Date.now(), event: 'binding-changed', binding: stateOf(obj).binding });
      previous = { ...obj, elapsed: stateOf(obj).elapsed }; return obj;
    }
    function discover() { const o = refresh(); return { profile: 'moe-ski-wasm32-v1', fields: o.fields, state: stateOf(o) }; }
    function status() { const o = refresh(); return { state: stateOf(o), mode: held ? 'hold' : 'observe', installed: handle !== null,
      network: !!networkStop, samples: rows.length, events: events.length, maps: maps.length }; }
    function mapOf(obj) {
      const s = stateOf(obj), p = obj.pointer;
      const rand = checkFields(layout('SkiRunRandomizer', ['<LastSeed>k__BackingField', '<LastObstacleMap>k__BackingField']),
        { '<LastSeed>k__BackingField': 8, '<LastObstacleMap>k__BackingField': 8 });
      const rp = u32(p + obj.fields.runRandomizer);
      if (u32(rp) !== rand.klass || !valid(u32(rp + 8))) throw new Error('LAYOUT: invalid randomizer');
      const seed = view().getInt32(rp + rand.fields['<LastSeed>k__BackingField'], true);
      const mapId = view().getInt32(rp + rand.fields['<LastObstacleMap>k__BackingField'], true);
      if (mapId < 0 || mapId > 3) throw new Error('LAYOUT: unknown obstacle template');
      const course = checkFields(layout('SkiCourse', ['runtimePoints', 'runtimeTangents']),
        { runtimePoints: 29, runtimeTangents: 29 });
      const cp = u32(p + obj.fields.course);
      if (u32(cp) !== course.klass || !valid(u32(cp + 8))) throw new Error('LAYOUT: invalid course');
      const points = u32(cp + course.fields.runtimePoints), tangents = u32(cp + course.fields.runtimeTangents);
      const count = u32(points + 12);
      if (!count || count > 10000 || u32(tangents + 12) !== count || !valid(points + 16, count * 8) ||
          !valid(tangents + 16, count * 4)) throw new Error('LAYOUT: invalid curve arrays');
      const terrain = [];
      for (let i = 0; i < count; i++) {
        const row = { x: f32(points + 16 + i * 8), y: f32(points + 20 + i * 8), tangent: f32(tangents + 16 + i * 4) };
        if (!Object.values(row).every(Number.isFinite) || (i && row.x <= terrain[i - 1].x)) throw new Error('LAYOUT: invalid terrain');
        terrain.push(row);
      }
      const spacing = [44, 38, 42][mapId - 1] ?? 40, jitter = [25, 19, 23][mapId - 1] ?? 21;
      const kindModulus = mapId === 1 ? 4 : mapId === 2 ? 3 : 5, end = terrain.at(-1).x, obstacles = [];
      for (let i = 0; i < 10000; i++) {
        let h = (Math.imul(i, 374761393) + Math.imul(seed, 668265263)) >>> 0;
        h = Math.imul((h >>> 13) ^ h, 1274126177) >>> 0; h = ((h >>> 16) ^ h) >>> 0;
        const x = s.startX + 55 + i * spacing + h % jitter;
        if (x >= end) break;
        obstacles.push({ i, x, kind: h % kindModulus === 0 ? 'tree' : 'rock' });
      }
      return { binding: s.binding, seed, map: mapId, spacing, jitterMax: jitter - 1, end, terrain, obstacles,
        verification: 'profile-formula; revalidate formula after game build changes' };
    }
    function tick() {
      try {
        const obj = refresh(); let s = stateOf(obj);
        if (held && s.finished) held = null;
        if (held) {
          view().setFloat32(obj.pointer + obj.fields.roundDuration, s.elapsed + held.remaining, true);
          s = stateOf(obj);
        }
        push(rows, { ...s, mode: held ? 'hold' : 'observe' });
        const rand = layout('SkiRunRandomizer', ['<LastSeed>k__BackingField', '<LastObstacleMap>k__BackingField']);
        const rp = u32(obj.pointer + obj.fields.runRandomizer);
        const key = [obj.pointer, obj.native, u32(rp + rand.fields['<LastSeed>k__BackingField']),
          u32(rp + rand.fields['<LastObstacleMap>k__BackingField'])].join(':');
        if (key !== mapKey) {
          try { const map = mapOf(obj); push(maps, map); mapKey = key; }
          catch (e) { push(events, { wall: Date.now(), event: 'map-unavailable', error: String(e) }); mapKey = key; }
        }
      } catch (e) { push(events, { wall: Date.now(), event: 'sample-unavailable', error: String(e) }); }
    }
    function hold() {
      if (handle === null) throw new Error('NOT_INSTALLED: install the probe before hold');
      const obj = refresh(), s = stateOf(obj);
      if (s.finished || s.paused || s.remaining <= 0) throw new Error('NOT_RUNNING: no active timed run');
      held = { binding: s.binding, remaining: s.remaining }; tick();
      return { ...status(), verified: false, verification: 'Compare fresh state samples and the visible timer' };
    }
    function release() {
      held = null; // Preserve the last deadline; never snap back to the original 180 seconds.
      return status();
    }
    function endpoint(raw) {
      try { const url = new URL(raw, env.location.href); return { origin: url.origin, transport: url.protocol }; }
      catch (_) { return { transport: 'unknown' }; }
    }
    function summary(data) {
      const result = { size: typeof data === 'string' ? data.length : (data && (data.byteLength ?? data.size)) || 0 };
      if (typeof data !== 'string') return result;
      try {
        const j = JSON.parse(data);
        if (!j || typeof j !== 'object' || Array.isArray(j)) return result;
        for (const key of ['code', 'cmd', 'type', 'distance', 'score', 'duration', 'elapsed', 'remaining'])
          if (typeof j[key] === 'number' && Number.isFinite(j[key])) result[key] = j[key];
      } catch (_) { /* Raw text and unrecognized payloads are deliberately discarded. */ }
      return result;
    }
    function enableNetwork() {
      if (networkStop) return;
      let active = true;
      const proto = env.WebSocket && env.WebSocket.prototype, send = proto && proto.send;
      const fetch = env.fetch, sockets = new Map();
      function record(direction, socket, data) {
        if (active) push(events, { wall: Date.now(), direction, ...endpoint(socket.url), ...summary(data) });
      }
      function wrappedSend(data) {
        if (active && !sockets.has(this)) {
          const listener = e => record('in', this, e.data); sockets.set(this, listener); this.addEventListener('message', listener);
        }
        record('out', this, data); return send.call(this, data);
      }
      function wrappedFetch(...args) {
        return fetch.apply(this, args).then(response => {
          const raw = typeof args[0] === 'string' ? args[0] : args[0] && args[0].url;
          if (active) push(events, { wall: Date.now(), transport: 'fetch', ...endpoint(raw), status: response.status }); return response;
        });
      }
      if (send) proto.send = wrappedSend;
      if (fetch) env.fetch = wrappedFetch;
      networkStop = () => {
        active = false;
        if (send && proto.send === wrappedSend) proto.send = send;
        if (fetch && env.fetch === wrappedFetch) env.fetch = fetch;
        for (const [socket, listener] of sockets) socket.removeEventListener('message', listener);
        networkStop = null;
      };
      push(events, { wall: Date.now(), event: 'network-enabled', coverage: 'WebSocket receive attaches at next send; fetch from now on; not XHR or past traffic' });
    }
    function install(options = {}) {
      preflight();
      if (options.network) enableNetwork();
      if (handle === null) { tick(); handle = env.setInterval(tick, 200); }
      try { return status(); }
      catch (e) {
        if (!String(e.message).startsWith('INSTANCE:')) throw e;
        return { installed: true, bound: false, mode: 'observe', reason: 'INSTANCE', network: !!networkStop };
      }
    }
    function stop() {
      held = null;
      if (handle !== null) env.clearInterval(handle);
      handle = null; if (networkStop) networkStop();
      return { stopped: true, mode: 'observe', samples: rows.length, events: events.length };
    }
    return { preflight, discover, status, install, hold, release, stop, map: () => mapOf(refresh()),
      export: () => {
        let current;
        try { current = status(); } catch (_) { current = { bound: false, mode: 'observe' }; }
        return { schema: 1, profile: 'moe-ski-wasm32-v1', ...current, rows, events, maps };
      }, summary };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = createLab;
  else root.__createWebglGameLab = createLab;
})(typeof globalThis !== 'undefined' ? globalThis : this);
