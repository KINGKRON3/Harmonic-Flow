// Runs the real <script> from index.html in a stub DOM and checks
// (1) the .loader is always hidden after a run, even when building the set fails,
// (2) the Rekordbox XML export has 8 hot cues (A-H) per track with correct timestamps.
// Usage: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
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
  vm.runInContext(script + "\n;globalThis.__hf = { run, buildXML, hotCues, arrange, parseList, keyPenalty, tempoPenalty, normOpts, applyPreset, mixTip, tipFor, aiTips, fmtTime, transition, get current() { return current; }, PRESETS, VIBES };", ctx);
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

test("Rekordbox XML has 8 hot cues A-H per track, ascending, on bar lines and inside the track", () => {
  const { hf } = makeEnv();
  const set = hf.current;
  assert.ok(set.order.length >= 2);
  const xml = hf.buildXML(set);
  const tracks = [...xml.matchAll(/<TRACK TrackID="(\d+)"[^>]*TotalTime="(\d+)"[^>]*>([\s\S]*?)<\/TRACK>/g)];
  assert.equal(tracks.length, set.order.length);
  tracks.forEach(([, , total, body], i) => {
    const bpm = set.order[i].bpm;
    const marks = [...body.matchAll(/<POSITION_MARK ([^>]*)\/>/g)].map(m =>
      Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map(a => [a[1], a[2]])));
    assert.equal(marks.length, 8, `track ${i + 1} has 8 cues`);
    marks.forEach((m, k) => {
      assert.equal(m.Type, "0", "cue type");
      assert.equal(m.Num, String(k), "hot cue slot A-H = Num 0-7");
      assert.match(m.Start, /^\d+\.\d{3}$/, "seconds with ms precision");
      assert.ok(+m.Start <= +total, `cue ${k} (${m.Start}) inside TotalTime ${total}`);
      const bars = +m.Start * bpm / 240;
      assert.ok(Math.abs(bars - Math.round(bars)) < .01, `cue ${k} on a bar line (${bars} bars)`);
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

test("Rekordbox XML escapes quotes, ampersands and angle brackets in track names", () => {
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

// ---- Rekordbox-style table ---------------------------------------------------

test("markup: Rekordbox palette, data-table columns, no rainbow chart / external fonts", () => {
  for (const c of ["#121212", "#1a1a1a", "#2d2d2d", "#00a8ff"]) assert.ok(html.includes(c), `palette ${c}`);
  const heads = [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map(m => m[1]);
  assert.deepEqual(heads, ["#", "Key", "BPM", "Title", "Artist", "Transition", "AI Mix Hint"]);
  assert.match(html, /<tbody id="timeline">/);
  assert.match(html, /\.mono\s*\{[^}]*font-family:\s*var\(--font-mono\)/);
  for (const gone of ['id="plot"', 'id="wheel"', "renderFlow", "renderWheel", "fonts.googleapis.com", "linear-gradient"]) {
    assert.ok(!html.includes(gone), `${gone} must be gone`);
  }
});

test("table: one row per track with key badge, BPM, title, artist, transition and hint", () => {
  const { el, hf } = makeEnv();
  const rows = [...el("timeline").innerHTML.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(m => m[1]);
  assert.equal(rows.length, hf.current.order.length);
  rows.forEach((row, i) => {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1]);
    assert.equal(cells.length, 7, `row ${i + 1} has 7 cells`);
    const t = hf.current.order[i];
    assert.equal(cells[0], String(i + 1).padStart(2, "0"));
    assert.match(cells[1], new RegExp(`class="kbadge[^"]*"[^>]*>${t.key.n}${t.key.m}</span>`));
    assert.match(cells[2], new RegExp(`${Number.isInteger(t.bpm) ? t.bpm : t.bpm.toFixed(1)}$`));
    assert.ok(cells[3].includes(t.title.replace(/&/g, "&amp;")) && cells[4].includes(t.artist.replace(/&/g, "&amp;")));
    if (i === 0) {
      assert.match(cells[5], /Start/);
      assert.equal(cells[6], "");
    } else {
      assert.match(cells[5], /class="tr (perfect|smooth|creative|clash)"/);
      assert.ok(cells[6].replace(/<[^>]+>/g, "").length > 15, "mix hint present");
    }
  });
  assert.match(el("stats").innerHTML, /Runtime/);
});

test("table: track names are HTML-escaped", () => {
  const { el, hf, flush } = makeEnv();
  el("tracks").value = `<img src=x onerror=alert(1)> - <script>alert(2)</script> | 126 | 8A | E3\nB & C - "Q" | 127 | 9A | E4`;
  hf.run(true);
  const out = el("timeline").innerHTML;
  assert.ok(!/<img|<script/i.test(out));
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(out, /B &amp; C/);
});

// ---- Track lengths & hot cues inside the track --------------------------------

test("parseList reads m:ss and h:mm:ss lengths and marks missing ones as estimated", () => {
  const { hf } = makeEnv();
  const { tracks } = hf.parseList("A - One | 126 | 8A | E3 | 5:26\nB - Two | 126 | 8A | E3 | 1:02:03\nC - Three | 126 | 8A | E3\nD - Four | 0:05");
  assert.deepEqual(Array.from(tracks, t => t.duration), [326, 3723, 360, 360]);
  assert.deepEqual(Array.from(tracks, t => t.est.duration), [false, false, true, true]);
});

test("hotCues: all 8 cues stay inside the track for any tempo and length", () => {
  const { hf } = makeEnv();
  for (let bpm = 60; bpm <= 220; bpm += 7) for (const dur of [20, 45, 90, 137.4, 167.9, 240, 330, 465.3, 600, 1500]) {
    const cues = Array.from(hf.hotCues(bpm, dur), c => ({ num: c.num, s: +c.s }));
    assert.equal(cues.length, 8);
    cues.forEach((c, i) => {
      assert.equal(c.num, i);
      assert.ok(c.s >= 0 && c.s <= dur - 2 + 1e-9, `${bpm} BPM / ${dur}s: cue ${i} at ${c.s}`);
      if (i) assert.ok(c.s > cues[i - 1].s, `${bpm} BPM / ${dur}s: cues ascending`);
    });
    assert.equal(cues[0].s, 0);
  }
});

test("hotCues: long tracks keep the phrase layout, short ones are squeezed onto bar lines", () => {
  const { hf } = makeEnv();
  const starts = (bpm, d) => Array.from(hf.hotCues(bpm, d), c => c.s);
  assert.deepEqual(starts(128, 600), ["0.000", "30.000", "60.000", "120.000", "180.000", "300.000", "360.000", "420.000"]);
  // 125 BPM, 2:47: every cue is a whole number of bars and the last one is left of the end
  const short = hf.hotCues(125, 167.905);
  for (const c of short) assert.ok(Math.abs(+c.s * 125 / 240 % 1) < .01 || Math.abs(+c.s * 125 / 240 % 1) > .99, `bar-aligned ${c.s}`);
  assert.ok(+short[7].s <= 165.905);
});

test("Rekordbox XML: TotalTime is the real length and no cue passes it", () => {
  const { hf } = makeEnv();
  const order = [
    { artist: "A", title: "Short", bpm: 125, key: { n: 8, m: "A" }, energy: 3, duration: 167.905 },
    { artist: "B", title: "Long", bpm: 128, key: { n: 9, m: "A" }, energy: 4, duration: 465.322 },
    { artist: "C", title: "Unknown", bpm: 140, key: { n: 9, m: "A" }, energy: 4 }
  ];
  const xml = hf.buildXML({ name: "T", order });
  const blocks = [...xml.matchAll(/<TRACK TrackID="\d+"[^>]*TotalTime="(\d+)"[^>]*>([\s\S]*?)<\/TRACK>/g)];
  assert.deepEqual(blocks.map(b => +b[1]), [168, 465, 360]);
  blocks.forEach(([, total, body], i) => {
    const starts = [...body.matchAll(/Start="([\d.]+)"/g)].map(m => +m[1]);
    assert.equal(starts.length, 8);
    for (const s of starts) assert.ok(s <= +total - 2 + 1e-9 || s === 0, `track ${i + 1}: cue ${s} past TotalTime ${total}`);
  });
});

test("Rekordbox XML: every field is escaped, even hostile ones", () => {
  const { hf } = makeEnv();
  const evil = `x" onload="1' <![CDATA[ & </TRACK><TRACK a=\u0001\u0008￾>`;
  const order = [
    { artist: evil, title: evil, bpm: 126, key: { n: 8, m: "A" }, energy: 3, duration: 300 },
    { artist: "Q", title: "W", bpm: 127, key: { n: 9, m: "A" }, energy: 3, duration: 300 }
  ];
  const xml = hf.buildXML({ name: evil, order });
  assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/.test(xml), "no illegal XML characters");
  assert.equal((xml.match(/<TRACK TrackID=/g) || []).length, 2, "no injected TRACK element");
  assert.equal((xml.match(/<TRACK /g) || []).length, 4, "2 tracks + 2 playlist references, nothing injected");
  assert.equal((xml.match(/<NODE /g) || []).length, 2);
  for (const [, , val] of xml.matchAll(/(\w+)=(")([^"]*)"/g)) {
    assert.ok(!/[<>']/.test(val) && !/&(?!amp;|lt;|gt;|quot;|apos;)/.test(val), `unsafe attribute value: ${val}`);
  }
  if (process.env.HF_XML_OUT) writeFileSync(process.env.HF_XML_OUT, xml, "utf8");
});

// ---- Mixing hints --------------------------------------------------------------

test("mixTip: every key pair gets a short, sensible hint", () => {
  const { hf } = makeEnv();
  const t = (n, m, bpm = 126) => ({ key: { n, m }, bpm });
  for (let n = 1; n <= 12; n++) for (const m of ["A", "B"]) {
    const tip = hf.mixTip(t(8, "A"), t(n, m));
    assert.ok(tip.length > 20 && tip.length < 220, tip);
  }
  assert.match(hf.mixTip(t(8, "A"), t(10, "A")), /^\+2 Boost: Cut low EQ on bar 32, echo out previous track/);
  assert.match(hf.mixTip(t(8, "A"), t(8, "A")), /Perfect match/);
  assert.match(hf.mixTip(t(8, "A"), t(2, "B")), /Key clash/);
  assert.match(hf.mixTip(t(8, "A", 126), t(8, "A", 131)), /pitch up 5 BPM/i);
});

// ---- AI Vibe Prompt -------------------------------------------------------------

const aiReply = (over = {}) => ({
  ok: true,
  json: async () => ({
    source: "llm", note: null, count: 8,
    tracks: Array.from({ length: 8 }, (_, i) => ({ artist: `Artist ${i}`, title: `Track <${i}>`, bpm: 130 + i, key: `${5 + (i % 3)}A`, energy: 3 + (i % 3), duration: 300 + i })),
    tips: Array.from({ length: 7 }, (_, i) => `Hint ${i}: <b>cut</b> the lows`),
    ...over
  })
});

test("AI Curate: posts the prompt, keeps the AI order and shows the AI hints escaped", async () => {
  const { ctx, el, hf, flush } = makeEnv();
  const calls = [];
  ctx.fetch = async (url, init) => { calls.push([url, JSON.parse(init.body)]); return aiReply(); };
  el("ai-prompt").value = "Dark peak-time techno, 130 -> 140 BPM";
  await el("btn-ai").listeners.click();
  flush();
  assert.deepEqual(calls, [["/api/ai-suggest", { prompt: "Dark peak-time techno, 130 -> 140 BPM" }]]);
  assert.equal(el("preset").value, "");
  assert.equal(el("tracks").value.split("\n").length, 8);
  assert.match(el("tracks").value.split("\n")[0], /^Artist 0 - Track <0> \| 130 \| 5A \| E3 \| 5:00$/);
  assert.deepEqual(Array.from(hf.current.order, t => t.artist), Array.from({ length: 8 }, (_, i) => `Artist ${i}`), "AI order kept");
  assert.equal(hf.current.name, "AI Curated Set");
  const out = el("timeline").innerHTML;
  assert.match(out, /<span class="ai">AI<\/span>Hint 0: &lt;b&gt;cut&lt;\/b&gt; the lows/);
  assert.ok(!out.includes("<b>cut</b>"));
  assert.match(el("ai-status").textContent, /Curated by Claude/);
  assert.equal(el("btn-ai").disabled, false);
  assert.equal(el("loader").hidden, true);
});

test("AI Curate: local fallback result works without tips and says so", async () => {
  const { ctx, el, hf, flush } = makeEnv();
  ctx.fetch = async () => aiReply({ source: "local", tips: [] });
  el("ai-prompt").value = "anything";
  await el("btn-ai").listeners.click();
  flush();
  assert.match(el("ai-status").textContent, /Local heuristic generator/);
  assert.ok(!el("timeline").innerHTML.includes('class="ai"'));
  assert.ok(el("timeline").innerHTML.includes("hint-cell"));
  assert.equal(hf.current.order.length, 8);
});

test("AI Curate: empty prompt, server error and offline backend are reported, never crash", async () => {
  const { ctx, el } = makeEnv();
  let called = 0;
  ctx.fetch = async () => { called++; return aiReply(); };
  el("ai-prompt").value = "  ";
  await el("btn-ai").listeners.click();
  assert.equal(called, 0);
  assert.equal(el("ai-error").hidden, false);

  ctx.fetch = async () => ({ ok: false, json: async () => ({ detail: "Kirjoita AI Vibe Prompt" }) });
  el("ai-prompt").value = "ab c";
  await el("btn-ai").listeners.click();
  assert.equal(el("ai-error").textContent, "Kirjoita AI Vibe Prompt");

  ctx.fetch = async () => { throw new TypeError("Failed to fetch"); };
  await el("btn-ai").listeners.click();
  assert.match(el("ai-error").textContent, /Backend offline/);
  assert.equal(el("btn-ai").disabled, false);
  assert.equal(el("btn-ai").textContent, "AI Curate Set");
});

test("playlist fetch writes real track lengths into the track list", async () => {
  const { ctx, el, hf } = makeEnv();
  ctx.fetch = async () => ({ ok: true, json: async () => ({
    tracks: ["Franky Rizardo - Shinjuku"], count: 1,
    details: [{ artist: "Franky Rizardo", title: "Shinjuku", duration_ms: 167905 }, { artist: "Gaskin", title: "No Limits", duration_ms: null }]
  }) });
  el("playlist-url").value = "https://open.spotify.com/playlist/2Mg5wgO65IZ0aOdh2hlg8S";
  await el("btn-fetch").listeners.click();
  assert.equal(el("tracks").value, "Franky Rizardo - Shinjuku | 2:48\nGaskin - No Limits");
  const { tracks } = hf.parseList(el("tracks").value);
  assert.deepEqual(Array.from(tracks, t => t.duration), [168, 360]);
});
