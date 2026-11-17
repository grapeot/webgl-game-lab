'use strict';
const assert = require('node:assert/strict');
const createLab = require('../src/webgl_game_lab/runtime.js');

function fixture() {
  const buffer = new ArrayBuffer(100000), u8 = new Uint8Array(buffer), d = new DataView(buffer);
  const put = (p, n) => d.setUint32(p, n, true), real = (p, n) => d.setFloat32(p, n, true);
  let textAt = 12000, fieldsAt = 20000;
  const types = { 2: 8000, 8: 8010, 12: 8020, 13: 8030, 18: 8040, 29: 8050 };
  const records = {};
  for (const [kind, p] of Object.entries(types)) put(p + 4, Number(kind) << 16);
  const str = s => { const p = textAt; u8.set(new TextEncoder().encode(s), p); textAt += s.length + 1; return p; };
  const namespace = str('Moe.Ski');
  function klass(p, name, definitions) {
    put(p + 8, str(name)); put(p + 12, namespace); put(p + 32, p); put(p + 36, p);
    put(p + 64, fieldsAt);
    for (const [field, offset, kind] of definitions) {
      records[name + '.' + field] = fieldsAt;
      put(fieldsAt, str(field)); put(fieldsAt + 4, types[kind]); put(fieldsAt + 8, p);
      put(fieldsAt + 12, offset); put(fieldsAt + 16, 0x04000001); fieldsAt += 20;
    }
    fieldsAt += 20;
  }
  // Offsets deliberately differ from the original build, exercising FieldInfo discovery.
  const off = { duration: 180, elapsed: 240, x: 268, speed: 236, finished: 260, initialized: 316 };
  klass(1000, 'SkiSoloGame', [
    ['roundDuration', off.duration, 12], ['elapsedSeconds', off.elapsed, 13], ['worldX', off.x, 12],
    ['startX', 264, 12], ['initialized', off.initialized, 2], ['<IsFinished>k__BackingField', off.finished, 2],
    ['<IsPaused>k__BackingField', 261, 2], ['<Speed>k__BackingField', off.speed, 12],
    ['<Height>k__BackingField', 232, 12], ['course', 16, 18], ['runRandomizer', 20, 18],
  ]);
  klass(2000, 'SkiRunRandomizer', [['<LastSeed>k__BackingField', 44, 8], ['<LastObstacleMap>k__BackingField', 48, 8]]);
  klass(3000, 'SkiCourse', [['runtimePoints', 64, 29], ['runtimeTangents', 68, 29]]);
  function game(p, native = 50000) {
    put(p, 1000); put(p + 8, native); put(p + 16, 33000); put(p + 20, 32000);
    real(p + off.duration, 180); d.setFloat64(p + off.elapsed, 10, true);
    real(p + off.x, 100); real(p + off.speed, 20); real(p + 264, 4); u8[p + off.initialized] = 1;
  }
  game(30000); game(31000, 0);
  put(32000, 2000); put(32008, 50100); put(32044, 123); put(32048, 3);
  put(33000, 3000); put(33008, 50200); put(33064, 34000); put(33068, 35000);
  put(34012, 3); put(35012, 3);
  [[0, 0], [100, -20], [400, -40]].forEach(([x, y], i) => { real(34016 + i * 8, x); real(34020 + i * 8, y); real(35016 + i * 4, -0.2); });
  const timers = new Map(); let timer = 0;
  const env = { unityInstance: { Module: { HEAPU8: u8 } }, location: { href: 'https://game.example.com/' },
    setInterval: fn => { timers.set(++timer, fn); return timer; }, clearInterval: id => timers.delete(id) };
  const lab = createLab(env);
  return { lab, env, u8, d, put, real, off, game, records, step: () => { for (const fn of timers.values()) fn(); } };
}

{
  const f = fixture(), before = Buffer.from(f.u8);
  assert.equal(f.lab.discover().state.binding.pointer, 30000);
  f.lab.install(); assert.equal(f.lab.status().mode, 'observe');
  assert.deepEqual(Buffer.from(f.u8), before, 'discovery and installation must not modify game memory');
  const map = f.lab.map(); assert.equal(map.terrain.length, 3); assert.equal(map.end, 400);
  assert.equal(map.spacing, 42); assert.ok(map.obstacles.length > 3);
  assert.equal(new Set(map.obstacles.slice(1).map((x, i) => x.x - map.obstacles[i].x)).size > 1, true);
}
{
  const f = fixture(); f.lab.install(); f.lab.hold();
  f.d.setFloat64(30000 + f.off.elapsed, 20, true); f.real(30000 + f.off.x, 300); f.step();
  assert.equal(f.lab.status().state.remaining, 170);
  assert.equal(f.lab.status().state.x, 300);
  f.lab.release(); f.d.setFloat64(30000 + f.off.elapsed, 25, true); f.step();
  assert.equal(f.lab.status().state.remaining, 165, 'release preserves deadline instead of resetting duration');
}
{
  const f = fixture(); f.lab.install(); f.lab.hold();
  f.put(30008, 0); f.game(36000, 50300); f.step();
  assert.equal(f.lab.status().state.binding.pointer, 36000);
  assert.equal(f.lab.status().mode, 'observe', 'hold must not cross instance replacement, even if round number repeats');
  assert.equal(f.lab.status().state.duration, 180);
}
{
  const f = fixture(); f.lab.install(); f.lab.hold(); f.game(36000, 50300); f.step();
  assert.throws(() => f.lab.status(), /found 2/);
  assert.equal(f.d.getFloat32(30000 + f.off.duration, true), 180);
  f.put(36008, 0); assert.equal(f.lab.status().mode, 'observe', 'ambiguity clears the hold');
}
{
  const f = fixture(); f.lab.install(); f.lab.hold(); f.lab.stop();
  f.d.setFloat64(30000 + f.off.elapsed, 20, true); f.step();
  assert.equal(f.lab.status().state.remaining, 160);
  assert.equal(f.lab.status().installed, false);
}
{
  const f = fixture(); f.u8[30000 + f.off.finished] = 1; f.lab.install();
  assert.throws(() => f.lab.hold(), /NOT_RUNNING/);
  assert.throws(() => fixture().lab.hold(), /NOT_INSTALLED/);
  f.put(8024, 13 << 16); assert.throws(() => createLab(f.env).status(), /instance field layout/);
}
{
  const f = fixture();
  const raw = JSON.stringify({ cmd: 12, token: 'FAKE_LOGIN_SECRET', uid: 12345,
    name: 'FAKE_PLAYER', score: 500, nested: { secret: 'FAKE_NESTED_SECRET' } });
  const data = f.lab.summary(raw);
  assert.deepEqual(data, { size: raw.length, cmd: 12, score: 500 });
  assert.ok(!JSON.stringify(data).includes('SECRET'));
  assert.deepEqual(f.lab.summary('{bad'), { size: 4 });
}
{
  const f = fixture(); f.put(30008, 0);
  assert.equal(f.lab.preflight().compatible, true);
  assert.equal(f.lab.install().bound, false);
  assert.throws(() => f.lab.hold(), /found 0/);
  f.game(36000, 50300); f.step();
  assert.equal(f.lab.status().state.binding.pointer, 36000);
  f.put(36008, 0); f.step(); assert.ok(f.lab.export().rows.length > 0);
}
{
  const f = fixture(); f.put(8024, (12 << 16) | 0x10);
  assert.throws(() => f.lab.preflight(), /instance field layout/);
}
{
  const f = fixture(); f.put(f.records['SkiSoloGame.worldX'] + 12, f.off.duration);
  assert.throws(() => f.lab.preflight(), /instance field layout/);
}
{
  const f = fixture(); f.put(f.records['SkiSoloGame.course'] + 4, 8020);
  assert.throws(() => f.lab.preflight(), /instance field layout/);
}
{
  const f = fixture(); f.real(30000 + f.off.duration, 300); f.d.setFloat64(30000 + f.off.elapsed, 210, true);
  f.lab.install(); f.lab.hold(); f.d.setFloat64(30000 + f.off.elapsed, 230, true); f.step();
  f.lab.release(); f.d.setFloat64(30000 + f.off.elapsed, 240, true); f.step();
  assert.equal(f.lab.status().state.remaining, 80);
}
{
  const f = fixture(); f.lab.install(); f.lab.hold();
  f.d.setFloat64(30000 + f.off.elapsed, 1, true); f.step();
  assert.equal(f.lab.status().mode, 'observe', 'elapsed reset on same instance also ends hold');
}
async function networkTests() {
  const f = fixture(); let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  class Socket {
    constructor() { this.url = 'wss://alice:pass@game.example.com/token/FAKE?secret=FAKE'; this.listeners = new Set(); }
    addEventListener(name, fn) { this.listeners.add(fn); }
    removeEventListener(name, fn) { this.listeners.delete(fn); }
    send() { return 7; }
    receive(data) { for (const listener of this.listeners) listener({ data }); }
  }
  f.env.WebSocket = Socket; f.env.fetch = () => pending;
  f.lab.install({ network: true });
  const socket = new Socket(); socket.send('{}'); socket.receive('{"cmd":2,"token":"FAKE"}');
  const inflight = f.env.fetch('https://game.example.com/FAKE?token=FAKE');
  const oldSend = Socket.prototype.send, oldFetch = f.env.fetch;
  const thirdPartySend = function (data) { return oldSend.call(this, data); };
  const thirdPartyFetch = (...args) => oldFetch(...args);
  Socket.prototype.send = thirdPartySend; f.env.fetch = thirdPartyFetch;
  f.lab.stop(); const count = f.lab.export().events.length;
  socket.send('{}'); socket.receive('{}'); new Socket().send('{}');
  finish({ status: 200 }); await inflight; await f.env.fetch('https://game.example.com/');
  assert.equal(f.lab.export().events.length, count, 'stopped generations must never record');
  assert.equal(Socket.prototype.send, thirdPartySend);
  assert.equal(f.env.fetch, thirdPartyFetch);
  assert.equal(socket.listeners.size, 0);
  assert.ok(!JSON.stringify(f.lab.export()).includes('FAKE'));
  f.lab.install({ network: true });
  const before = f.lab.export().events.length;
  assert.equal(socket.send('{}'), 7); socket.receive('{}');
  assert.equal(f.lab.export().events.length, before + 2, 'reinstall records only one generation');
  f.lab.stop();
}
networkTests().then(() => console.log('Runtime regression scenarios passed')).catch(e => { console.error(e); process.exitCode = 1; });
