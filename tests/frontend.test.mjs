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
  el("strictness").value = "2";
  el("tempo-flex").value = "6";
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
  vm.runInContext(script + "\n;globalThis.__hf = { run, buildXML, hotCues, arrange, parseList, keyPenalty, tempoPenalty, normOpts, applyPreset, get current() { return current; }, PRESETS, VIBES };", ctx);
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

// ---- Genre presets ---------------------------------------------------------

const GENRES = { latin: [124, 128], dnb: [172, 176], rave: [138, 144] };

for (const [id, [lo, hi]] of Object.entries(GENRES)) {
  test(`preset ${id}: tracks sit in ${lo}-${hi} BPM with explicit key and energy`, () => {
    const { hf } = makeEnv();
    const p = hf.PRESETS[id];
    assert.deepEqual(Array.from(p.bpm), [lo, hi]);
    const { tracks } = hf.parseList(p.tracks);
    assert.ok(tracks.length >= 10, "enough example tracks");
    for (const t of tracks) {
      assert.ok(!t.est.bpm && !t.est.key && !t.est.energy, `${t.title}: BPM/key/energy given explicitly`);
      assert.ok(t.bpm >= lo && t.bpm <= hi, `${t.title} ${t.bpm} BPM outside ${lo}-${hi}`);
      assert.ok(t.energy >= 1 && t.energy <= 5);
    }
  });

  test(`selecting preset ${id} fills the track list, sliders and set`, () => {
    const { el, hf, flush } = makeEnv();
    el("preset").value = id; // a real <select> has the value set before "change" fires
    el("preset").listeners.change({ target: { value: id } });
    flush();
    assert.equal(el("tracks").value, hf.PRESETS[id].tracks);
    assert.equal(el("strictness").value, hf.PRESETS[id].strictness);
    assert.equal(el("tempo-flex").value, hf.PRESETS[id].tempoFlex);
    assert.match(el("strictness-val").textContent, /^\d \/ 3$/);
    assert.equal(hf.current.name, hf.PRESETS[id].label);
    assert.ok(hf.current.order.every(t => t.bpm >= lo && t.bpm <= hi));
    assert.equal(el("loader").hidden, true);
  });
}

test("preset menu lists the new genres", () => {
  for (const id of ["latin", "dnb", "rave"]) assert.match(html, new RegExp(`<option value="${id}">`));
});

// ---- Harmonic Strictness / Tempo Flexibility -------------------------------

const mk = (key, bpm) => ({ artist: "A", title: `${key}@${bpm}`, bpm, key: { n: parseInt(key), m: key.slice(-1) }, energy: 4, est: {} });
const keyD = (a, b) => (b.key.n - a.key.n + 12) % 12;
const K = (n, m = "A") => ({ n, m });

test("sliders exist in the markup with the right ranges", () => {
  assert.match(html, /<input type="range" id="strictness" min="1" max="3"/);
  assert.match(html, /<input type="range" id="tempo-flex" min="1" max="10"/);
});

test("normOpts clamps and falls back to defaults", () => {
  const { hf } = makeEnv();
  assert.deepEqual({ ...hf.normOpts({ strictness: 9, tempoFlex: 0 }) }, { strictness: 3, tempoFlex: 1 });
  assert.deepEqual({ ...hf.normOpts({ strictness: "", tempoFlex: "x" }) }, { strictness: 2, tempoFlex: 6 });
  assert.deepEqual({ ...hf.normOpts() }, { strictness: 2, tempoFlex: 6 });
});

test("keyPenalty: level 1 = tight, 2 = allows +2/+7 boosts, 3 = free", () => {
  const { hf } = makeEnv();
  const P = (a, b, l) => hf.keyPenalty(a, b, l);
  for (const l of [1, 2, 3]) {
    assert.ok(P(K(8), K(8), l) < 1 && P(K(8), K(9), l) < 1 && P(K(8), K(8, "B"), l) < 1.5);
  }
  for (const to of [10, 3]) {
    assert.ok(P(K(8), K(to), 1) >= 14, `level 1 rejects 8A -> ${to}A`);
    assert.ok(P(K(8), K(to), 2) < 5, `level 2 allows 8A -> ${to}A`);
  }
  assert.ok(P(K(8), K(2), 1) >= 14 && P(K(8), K(2), 2) >= 14, "clash penalised at 1 and 2");
  assert.ok(P(K(8), K(2), 3) < 4, "clash nearly free at 3");
  for (let n = 1; n <= 12; n++) for (const m of ["A", "B"]) {
    assert.ok(P(K(8), K(n, m), 3) <= P(K(8), K(n, m), 2) && P(K(8), K(n, m), 2) <= P(K(8), K(n, m), 1));
  }
});

test("tempoPenalty grows steeply once the jump exceeds the flexibility", () => {
  const { hf } = makeEnv();
  const a = { bpm: 126 };
  assert.equal(hf.tempoPenalty(a, { bpm: 126 }, 3), 0);
  assert.ok(hf.tempoPenalty(a, { bpm: 129 }, 3) < 2);
  assert.ok(hf.tempoPenalty(a, { bpm: 130 }, 3) > 6);
  assert.ok(hf.tempoPenalty(a, { bpm: 130 }, 5) < 2, "same jump is fine with more flexibility");
});

test("arrange: strictness 1 chains only same/adjacent keys when possible", () => {
  const { hf } = makeEnv();
  const pool = ["10A", "8A", "12A", "9A", "11A"].map(k => mk(k, 126));
  const order = hf.arrange(pool, hf.VIBES.peak, null, { strictness: 1, tempoFlex: 5 });
  assert.equal(order.length, 5);
  for (let i = 1; i < order.length; i++) {
    assert.ok([0, 1, 11].includes(keyD(order[i - 1], order[i])), `${order[i - 1].title} -> ${order[i].title}`);
  }
});

test("arrange: strictness 2 chains +2 boosts that strictness 1 forbids", () => {
  const { hf } = makeEnv();
  const pool = ["1A", "3A", "5A", "7A", "9A"].map(k => mk(k, 126));
  const order = hf.arrange(pool, hf.VIBES.peak, null, { strictness: 2, tempoFlex: 5 });
  const steps = order.slice(1).map((t, i) => keyD(order[i], t));
  assert.ok(steps.every(d => d === 2 || d === 10 || d === 7), "whole-step moves " + steps);
  const total = l => order.slice(1).reduce((s, t, i) => s + hf.keyPenalty(order[i].key, t.key, l), 0);
  assert.ok(total(1) > total(2) + 40);
});

test("arrange: strictness 3 lets tempo decide over key clashes", () => {
  const { hf } = makeEnv();
  const pool = [[2, 130], [8, 126], [5, 128], [11, 124]].map(([n, b]) => mk(n + "A", b));
  const order = hf.arrange(pool, hf.VIBES.peak, null, { strictness: 3, tempoFlex: 2 });
  const bpms = order.map(t => t.bpm);
  assert.ok(bpms.every((b, i) => !i || Math.abs(b - bpms[i - 1]) <= 2), "bpm ladder " + bpms);
});

test("arrange: tempo flexibility caps BPM jumps between consecutive tracks", () => {
  const { hf } = makeEnv();
  const pool = [128, 120, 124, 122, 126].map(b => mk("8A", b));
  for (const flex of [2, 4]) {
    const order = hf.arrange(pool, hf.VIBES.peak, null, { strictness: 2, tempoFlex: flex });
    assert.equal(order.length, 5);
    for (let i = 1; i < order.length; i++) {
      assert.ok(Math.abs(order[i].bpm - order[i - 1].bpm) <= flex, `flex ${flex}: ${order.map(t => t.bpm)}`);
    }
  }
});

test("arrange: the slider values change the resulting order", () => {
  const { hf } = makeEnv();
  // Harmonic pairs 8A+9A and 2A+3A are 10 BPM apart; across the pairs keys clash but tempo is close.
  const pool = [mk("8A", 120), mk("9A", 130), mk("2A", 121), mk("3A", 131)];
  const run = o => hf.arrange(pool, hf.VIBES.peak, null, o).map(t => t.title);
  const strict = run({ strictness: 1, tempoFlex: 10 });
  const loose = run({ strictness: 3, tempoFlex: 1 });
  assert.notDeepEqual(strict, loose);
  // free + tight tempo orders by BPM (ascending or descending), only one big jump
  const bpms = loose.map(t => +t.split("@")[1]);
  assert.ok(bpms.filter((b, i) => i && Math.abs(b - bpms[i - 1]) > 1).length === 1, "bpm order " + bpms);
  // strict keeps 8A next to 9A and 2A next to 3A
  const adj = (x, y) => Math.abs(strict.indexOf(x) - strict.indexOf(y)) === 1;
  assert.ok(adj("8A@120", "9A@130") && adj("2A@121", "3A@131"), strict.join());
});

test("sliders: moving them updates labels, re-runs the set and keeps the loader hidden", () => {
  const { el, hf, flush } = makeEnv();
  el("strictness").value = "1";
  el("strictness").listeners.input();
  assert.equal(el("strictness-val").textContent, "1 / 3");
  assert.match(el("strictness-hint").textContent, /only same or adjacent/);
  el("tempo-flex").value = "3";
  el("tempo-flex").listeners.change();
  assert.match(el("tempo-flex-val").textContent, /3 BPM/);
  flush();
  assert.deepEqual({ ...hf.current.opts }, { strictness: 1, tempoFlex: 3 });
  assert.equal(el("loader").hidden, true);
});

test("slider values reach arrange(): strict set is at least as harmonic as free set", () => {
  const { el, hf, flush } = makeEnv();
  const cost = set => set.order.slice(1).reduce((s, t, i) => s + hf.keyPenalty(set.order[i].key, t.key, 1), 0);
  el("strictness").value = "1"; el("strictness").listeners.change(); flush();
  const strictCost = cost(hf.current);
  el("strictness").value = "3"; el("strictness").listeners.change(); flush();
  assert.ok(strictCost <= cost(hf.current));
});
