// Runs the real <script> from index.html in a stub DOM and checks
// (1) the .loader is always hidden after a run, even when building the set fails,
// (2) the Rekordbox XML export has 8 hot cues (A-H) per track with correct timestamps.
// Usage: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function makeEnv() {
  const els = new Map();
  const el = id => {
    if (!els.has(id)) {
      els.set(id, {
        id, hidden: id === "loader", value: "", textContent: "", innerHTML: "", disabled: false,
        style: {}, attrs: {}, listeners: {},
        classList: { add() {}, remove() {} },
        setAttribute(k, v) { this.attrs[k] = v; },
        removeAttribute(k) { delete this.attrs[k]; },
        addEventListener(type, fn) { this.listeners[type] = fn; }
      });
    }
    return els.get(id);
  };
  el("set-len").value = "all";
  const timers = [];
  const ctx = {
    console,
    BigInt, Math, Number, String, Array, Map, Set, JSON, Object, Error, encodeURIComponent,
    document: {
      getElementById: el,
      querySelector: () => ({ value: "peak" }),
      querySelectorAll: () => [],
      createElement: () => ({ click() {}, remove() {} }),
      body: { appendChild() {} }
    },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout: (fn, ms) => { timers.push(fn); return timers.length; },
    clearTimeout() {},
    URL: { createObjectURL: () => "", revokeObjectURL() {} },
    Blob: class {}
  };
  vm.createContext(ctx);
  // Expose top-level const/function bindings for the tests.
  vm.runInContext(script + "\n;globalThis.__hf = { run, buildXML, hotCues, arrange, parseList, get current() { return current; }, PRESETS, VIBES };", ctx);
  const flush = () => { while (timers.length) timers.shift()(); };
  return { ctx, el, flush, hf: ctx.__hf };
}

test("loader is hidden after initial instant run", () => {
  const { el } = makeEnv();
  assert.equal(el("loader").hidden, true);
});

test("loader is hidden after an animated run completes", () => {
  const { el, flush, hf } = makeEnv();
  hf.run(false);
  assert.equal(el("loader").hidden, false, "loader visible while working");
  flush();
  assert.equal(el("loader").hidden, true);
  assert.equal(el("go").attrs["aria-busy"], undefined);
});

test("loader is hidden even when building the set throws", () => {
  const { ctx, el, flush } = makeEnv();
  // Break render() so finish() throws mid-way.
  vm.runInContext("$('timeline').__defineSetter__('innerHTML', () => { throw new Error('boom'); });", ctx);
  vm.runInContext("run(false)", ctx);
  flush();
  assert.equal(el("loader").hidden, true);
  assert.equal(el("error").hidden, false);
  assert.match(el("error").textContent, /boom/);
});

test("superseded runs still leave the loader hidden", () => {
  const { el, flush, hf } = makeEnv();
  hf.run(false);
  hf.run(false);
  hf.run(true);
  assert.equal(el("loader").hidden, true);
  flush();
  assert.equal(el("loader").hidden, true);
});

test("Rekordbox XML has 8 hot cues A-H per track with bar-accurate timestamps", () => {
  const { hf } = makeEnv();
  const set = hf.current;
  assert.ok(set.order.length >= 2);
  const xml = hf.buildXML(set);
  const tracks = [...xml.matchAll(/<TRACK TrackID="(\d+)"[^>]*AverageBpm="([\d.]+)"[^>]*>([\s\S]*?)<\/TRACK>/g)];
  assert.equal(tracks.length, set.order.length);
  const bars = [0, 16, 32, 64, 96, 160, 192, 224];
  tracks.forEach(([, , , body], i) => {
    const bpm = set.order[i].bpm;
    const marks = [...body.matchAll(/<POSITION_MARK ([^>]*)\/>/g)].map(m =>
      Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map(a => [a[1], a[2]])));
    assert.equal(marks.length, 8, `track ${i + 1} has 8 cues`);
    marks.forEach((m, k) => {
      assert.equal(m.Type, "0", "cue type");
      assert.equal(m.Num, String(k), "hot cue slot A-H = Num 0-7");
      assert.match(m.Start, /^\d+\.\d{3}$/, "seconds with ms precision");
      const expected = bars[k] * 240 / bpm;
      assert.ok(Math.abs(+m.Start - expected) <= 0.0005, `cue ${k} at ${m.Start}, expected ${expected}`);
      for (const c of ["Red", "Green", "Blue"]) assert.ok(+m[c] >= 0 && +m[c] <= 255);
    });
    const starts = marks.map(m => +m.Start);
    assert.deepEqual(starts, [...starts].sort((a, b) => a - b), "cues in ascending order");
  });
});

test("hot cue timestamps at 128 BPM and invalid BPM fallback", () => {
  const { hf } = makeEnv();
  const cueStarts = bpm => Array.from(hf.hotCues(bpm), c => c.s);
  const at128 = cueStarts(128);
  assert.deepEqual(at128, ["0.000", "30.000", "60.000", "120.000", "180.000", "300.000", "360.000", "420.000"]);
  for (const bad of [0, -5, NaN, undefined]) assert.deepEqual(cueStarts(bad), at128);
  assert.deepEqual(Array.from(hf.hotCues(174), c => c.num), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test("Rekordbox XML escapes special characters in track names", () => {
  const { hf } = makeEnv();
  const set = { name: "A & B", order: [{ artist: 'X "Y" <Z>', title: "R&B", bpm: 120, key: 1, energy: 3 }, { artist: "Q", title: "W", bpm: 122, key: 2, energy: 3 }] };
  const xml = hf.buildXML(set);
  assert.ok(!/&(?!amp;|lt;|gt;|quot;)/.test(xml), "no raw ampersands");
  assert.match(xml, /Artist="X &quot;Y&quot; &lt;Z&gt;"/);
});
