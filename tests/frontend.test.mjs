// Runs the real <script> from index.html in a stub DOM: single-prompt agent flow, arrangement, arcs,
// duration, pool, loader behaviour and the Rekordbox XML export.
// Usage: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

// elements that carry the `hidden` attribute in the real markup
const HIDDEN_IDS = new Set([...html.matchAll(/<[^>]*id="([^"]+)"[^>]*\shidden[^>]*>/g)].map(m => m[1]));

// Default fixture pool for the arrangement / export tests (12 tech house tracks with BPM, key, energy)
const TECH = `Fisher - Losing It | 125 | 8A | E4
Chris Lake - Turn Off The Lights | 126 | 9A | E4
Dom Dolla - Rhyme Dust | 126 | 8A | E5
Cloonee - Fine Night | 127 | 11A | E4
John Summit - Where You Are | 126 | 10B | E5
Michael Bibi - Got The Fire | 125 | 7A | E3
Pawsa - Dog Tales | 128 | 9A | E4
Mau P - Drugs From Amsterdam | 125 | 8A | E5
Gorgon City - Voodoo | 125 | 9A | E4
Vintage Culture - Fractions | 126 | 10A | E3
Sidepiece - Together | 126 | 11B | E4
Green Velvet - Bigger Than Prince | 124 | 8A | E3`;

function makeEnv({ seed = true } = {}) {
  const els = new Map();
  const el = id => {
    if (!els.has(id)) {
      els.set(id, {
        id, hidden: HIDDEN_IDS.has(id), value: "", textContent: "", innerHTML: "", disabled: false,
        style: {}, attrs: {}, listeners: {},
        classList: { add() {}, remove() {} },
        setAttribute(k, v) { this.attrs[k] = v; },
        removeAttribute(k) { delete this.attrs[k]; },
        addEventListener(type, fn) { this.listeners[type] = fn; }
      });
    }
    return els.get(id);
  };
  el("set-len").value = "7200";
  el("arc").value = "classic";
  el("peak-pos").value = "75";
  el("strictness").value = "2";
  el("tempo-flex").value = "6";
  const timers = [];
  const ctx = {
    console,
    BigInt, Math, Number, String, Array, Map, Set, JSON, Object, Error, encodeURIComponent,
    document: {
      getElementById: el,
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
  vm.runInContext(script + "\n;globalThis.__hf = { run, buildXML, hotCues, arrange, parseList, keyPenalty, tempoPenalty, normOpts, mixTip, fmtTime, transition, ARCS, arcShape, splitPhases, readArc, arrangeForDuration, sources, parsePool, addSource, renderPool, sumSeconds, trackSeconds, trackKey, splitInput, applyGigPlan, get current() { return current; } };", ctx);
  if (seed) vm.runInContext(`addSource({ id: "manual", name: "Tech House Peak Hour", text: ${JSON.stringify(TECH)}, checked: true }); run(true);`, ctx);
  const flush = () => { while (timers.length) timers.shift()(); };
  return { ctx, el, flush, hf: ctx.__hf };
}

// Replaces the pool with a single list (the old tests typed this into the custom track list)
const setList = (hf, text) => { hf.sources.splice(0, hf.sources.length); hf.addSource({ id: "manual", name: "Custom list", text, checked: true }); };

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
  const order = hf.arrange(pool, hf.arcShape("banger"), null, { strictness: 1, tempoFlex: 5 });
  assert.equal(order.length, 5);
  for (let i = 1; i < order.length; i++) {
    assert.ok([0, 1, 11].includes(keyD(order[i - 1], order[i])), `${order[i - 1].title} -> ${order[i].title}`);
  }
});

test("arrange: strictness 2 chains +2 boosts that strictness 1 forbids", () => {
  const { hf } = makeEnv();
  const pool = ["1A", "3A", "5A", "7A", "9A"].map(k => mk(k, 126));
  const order = hf.arrange(pool, hf.arcShape("banger"), null, { strictness: 2, tempoFlex: 5 });
  const steps = order.slice(1).map((t, i) => keyD(order[i], t));
  assert.ok(steps.every(d => d === 2 || d === 10 || d === 7), "whole-step moves " + steps);
  const total = l => order.slice(1).reduce((s, t, i) => s + hf.keyPenalty(order[i].key, t.key, l), 0);
  assert.ok(total(1) > total(2) + 40);
});

test("arrange: strictness 3 lets tempo decide over key clashes", () => {
  const { hf } = makeEnv();
  const pool = [[2, 130], [8, 126], [5, 128], [11, 124]].map(([n, b]) => mk(n + "A", b));
  const order = hf.arrange(pool, hf.arcShape("banger"), null, { strictness: 3, tempoFlex: 2 });
  const bpms = order.map(t => t.bpm);
  assert.ok(bpms.every((b, i) => !i || Math.abs(b - bpms[i - 1]) <= 2), "bpm ladder " + bpms);
});

test("arrange: tempo flexibility caps BPM jumps between consecutive tracks", () => {
  const { hf } = makeEnv();
  const pool = [128, 120, 124, 122, 126].map(b => mk("8A", b));
  for (const flex of [2, 4]) {
    const order = hf.arrange(pool, hf.arcShape("banger"), null, { strictness: 2, tempoFlex: flex });
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
  const run = o => hf.arrange(pool, hf.arcShape("banger"), null, o).map(t => t.title);
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
  assert.match(html, /<tbody id="timeline">/);
  assert.match(html, /\.mono\s*\{[^}]*font-family:\s*var\(--font-mono\)/);
  for (const gone of ['id="plot"', 'id="wheel"', "renderFlow", "renderWheel", "fonts.googleapis.com", "linear-gradient"]) {
    assert.ok(!html.includes(gone), `${gone} must be gone`);
  }
});

test("table: one row per track with key badge, BPM, title, artist and transition (6 columns)", () => {
  const { el, hf } = makeEnv();
  const rows = [...el("timeline").innerHTML.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(m => m[1]);
  assert.equal(rows.length, hf.current.order.length);
  rows.forEach((row, i) => {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1]);
    assert.equal(cells.length, 6, `row ${i + 1} has 6 cells`);
    const t = hf.current.order[i];
    assert.equal(cells[0], String(i + 1).padStart(2, "0"));
    assert.match(cells[1], new RegExp(`class="kbadge[^"]*"[^>]*>${t.key.n}${t.key.m}</span>`));
    assert.match(cells[2], new RegExp(`${Number.isInteger(t.bpm) ? t.bpm : t.bpm.toFixed(1)}$`));
    assert.ok(cells[3].includes(t.title.replace(/&/g, "&amp;")) && cells[4].includes(t.artist.replace(/&/g, "&amp;")));
    if (i === 0) assert.match(cells[5], /Start/);
    else assert.match(cells[5], /class="tr (perfect|smooth|creative|clash)"[^>]*>[^<]+<\/span><span class="delta">[+-]?\d/);
  });
  assert.match(el("stats").innerHTML, /Runtime/);
  assert.ok(!el("timeline").innerHTML.includes("hint-cell"));
});

test("table: track names are HTML-escaped", () => {
  const { el, hf, flush } = makeEnv();
  setList(hf, `<img src=x onerror=alert(1)> - <script>alert(2)</script> | 126 | 8A | E3\nB & C - "Q" | 127 | 9A | E4`);
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

// ---- Drama arcs ------------------------------------------------------------------

const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const mean = xs => xs.reduce((s, x) => s + x, 0) / xs.length;

test("markup: arc menu, peak slider, duration choices and pool replace the old vibe radios", () => {
  assert.ok(!html.includes('name="vibe"'));
  const arcs = [...html.match(/<select id="arc">([\s\S]*?)<\/select>/)[1].matchAll(/<option value="(\w+)"[^>]*>([^<]+)</g)].map(m => [m[1], m[2]]);
  assert.deepEqual(arcs, [["classic", "Classic Club Journey"], ["slow", "Steadily Rising / Slow Burn"],
    ["banger", "Peak Time Banger / Festival"], ["coaster", "Rollercoaster / Two Peaks"]]);
  assert.match(html, /<label for="arc">Set Energy Curve \/ Drama Arc<\/label>/);
  assert.match(html, /<input type="range" id="peak-pos" min="50" max="90" step="5"/);
  const lens = [...html.match(/<select id="set-len">([\s\S]*?)<\/select>/)[1].matchAll(/value="(\d+)"/g)].map(m => +m[1]);
  assert.deepEqual(lens, [3600, 7200, 10800, 14400]);
  assert.match(html, /<div class="pool" id="pool"/);
});

test("classic arc at the default peak: 20% warm-up E1-E2, 40% build E3-E4, 30% peak E5, 10% outro E3", () => {
  const { hf } = makeEnv();
  const a = hf.arcShape("classic", .75);
  for (const p of [0, .05, .1, .19]) assert.ok(a.target(p) >= 1 && a.target(p) <= 2, `warm-up p=${p}`);
  for (const p of [.21, .4, .59]) assert.ok(a.target(p) >= 3 && a.target(p) <= 4, `build p=${p}`);
  for (const p of [.61, .75, .89]) assert.equal(a.target(p), 5, `peak p=${p}`);
  for (const p of [.91, 1]) assert.equal(a.target(p), 3, `outro p=${p}`);
  assert.deepEqual(Array.from(a.phases, ph => ph.name), ["Warm-up", "Build-up", "Peak Hour", "Outro"]);
  [.2, .6, .9, 1].forEach((end, i) => assert.ok(close(a.phases[i].end, end), `phase ${i} ends at ${a.phases[i].end}`));
});

test("peak position slider moves the main peak and is clamped to 50-90%", () => {
  const { hf } = makeEnv();
  const early = hf.arcShape("classic", .5), late = hf.arcShape("classic", .9);
  assert.equal(early.target(.5), 5);
  assert.equal(early.target(.8), 3, "outro after an early peak");
  assert.equal(late.target(.9), 5);
  assert.ok(late.target(.5) <= 4, "still building at 50% when the peak is at 90%");
  assert.equal(hf.arcShape("classic", .1).peakPos, .5);
  assert.equal(hf.arcShape("classic", 7).peakPos, .9);
  assert.equal(hf.arcShape("nope", NaN).id, "classic");
  for (const id of ["classic", "slow", "banger", "coaster"]) for (const pk of [.5, .6, .75, .9]) {
    const ends = hf.arcShape(id, pk).phases.map(ph => ph.end);
    assert.deepEqual(Array.from(ends), [...ends].sort((x, y) => x - y), `${id}@${pk} phases ascending`);
    assert.equal(ends[ends.length - 1], 1);
    for (let i = 0; i <= 40; i++) assert.ok(hf.arcShape(id, pk).target(i / 40) >= 1 && hf.arcShape(id, pk).target(i / 40) <= 5);
  }
});

test("slow burn climbs linearly from low energy to the closing peak", () => {
  const { hf } = makeEnv();
  const a = hf.arcShape("slow", .9);
  assert.equal(a.target(0), 1);
  assert.equal(a.target(.9), 5);
  assert.ok(close(a.target(.45), 3));
  let prev = 0;
  for (let i = 0; i <= 40; i++) { assert.ok(a.target(i / 40) >= prev); prev = a.target(i / 40); }
});

test("festival arc keeps E4-E5 from start to finish", () => {
  const { hf } = makeEnv();
  for (const pk of [.5, .6, .9]) for (let i = 0; i <= 40; i++) assert.ok(hf.arcShape("banger", pk).target(i / 40) >= 4);
});

test("rollercoaster: peak 1, short E3 breather, then the main peak 2", () => {
  const { hf } = makeEnv();
  for (const pk of [.5, .75, .9]) {
    const a = hf.arcShape("coaster", pk), p1 = pk * .45, mid = (p1 + pk) / 2;
    assert.equal(a.target(p1), 5);
    assert.equal(a.target(mid), 3);
    assert.equal(a.target(pk), 5);
    assert.ok(a.target(0) <= 2.5);
    assert.ok(a.target(p1 / 2) > a.target(0) && a.target(p1 / 2) < 5, "rises into peak 1");
  }
});

// arrange(): 50 tracks, 10 of each energy level, harmonically chained keys, equal tempo
const energyPool = () => Array.from({ length: 50 }, (_, i) => ({
  artist: "A" + i, title: "T" + i, bpm: 126, energy: (i % 5) + 1, key: { n: 7 + (i % 3), m: "A" }, est: {}, duration: 300
}));
const arcOrder = (hf, id, pk, n = 20) => hf.arrange(energyPool(), hf.arcShape(id, pk), n, { strictness: 2, tempoFlex: 6 });
const winMean = (order, a, b) => mean(order.filter((_, i) => i / (order.length - 1) >= a && i / (order.length - 1) <= b).map(t => t.energy));

test("arrange follows the classic arc and never opens with the biggest banger", () => {
  const { hf } = makeEnv();
  const o = arcOrder(hf, "classic", .75);
  assert.equal(o.length, 20);
  assert.ok(o[0].energy <= 2, `opener E${o[0].energy}`);
  assert.ok(mean(o.slice(0, 4).map(t => t.energy)) <= 2.25, "warm-up");
  assert.ok(winMean(o, .62, .88) >= 4.9, "peak hour");
  assert.ok(winMean(o, .22, .58) >= 3 && winMean(o, .22, .58) <= 4.1, "build-up");
  assert.ok(Math.abs(mean(o.slice(-2).map(t => t.energy)) - 3) <= .5, "outro");
});

test("arrange: slow burn rises, festival stays high, rollercoaster has two peaks", () => {
  const { hf } = makeEnv();
  const slow = arcOrder(hf, "slow", .9);
  assert.ok(slow[0].energy <= 2);
  assert.ok(mean(slow.slice(-4).map(t => t.energy)) - mean(slow.slice(0, 4).map(t => t.energy)) >= 2.5, "climb");
  assert.ok(slow.every((t, i) => i < 2 || t.energy >= slow[i - 2].energy - 1), "no big dips on the way up");

  const fest = arcOrder(hf, "banger", .6);
  assert.ok(fest.every(t => t.energy >= 4), "E4-E5 throughout: " + fest.map(t => t.energy));

  const co = arcOrder(hf, "coaster", .75), pk = .75, p1 = pk * .45, mid = (p1 + pk) / 2;
  const at = (p, w = .05) => winMean(co, p - w, p + w);
  assert.ok(at(p1) >= 4.5 && at(pk) >= 4.5, "two peaks");
  assert.ok(at(mid, .04) <= 3.6, "breather in between: " + co.map(t => t.energy));
  assert.ok(co[0].energy <= 3);
});

test("arrange: the peak position slider shifts where the peak lands", () => {
  const { hf } = makeEnv();
  const centroid = o => mean(o.map((t, i) => [t.energy, i / (o.length - 1)]).filter(([e]) => e === 5).map(([, p]) => p));
  assert.ok(centroid(arcOrder(hf, "classic", .55)) + .12 < centroid(arcOrder(hf, "classic", .9)));
});

// ---- 1-4 h duration -------------------------------------------------------------------

const lines = (n, prefix = "L", base = 0) => Array.from({ length: n }, (_, i) =>
  `${prefix}Artist${i} - ${prefix}Title${i} | ${124 + (i % 6)} | ${7 + (i % 3)}A | E${(i % 5) + 1} | ${4 + (i % 4)}:${String((i * 7) % 60).padStart(2, "0")}`).join("\n");

test("duration choices 1-4 h limit the number of tracks to the target time", () => {
  const { el, hf, flush } = makeEnv();
  setList(hf, lines(80));
  const counts = [];
  for (const sec of [3600, 7200, 10800, 14400]) {
    el("set-len").value = String(sec);
    el("set-len").listeners.change();
    flush();
    const run = hf.sumSeconds(hf.current.order);
    assert.equal(hf.current.targetSec, sec);
    assert.ok(Math.abs(run - sec) <= 420, `${sec / 3600} h: runtime ${run}s`);
    assert.match(el("stats").innerHTML, new RegExp(`Target</dt><dd>${hf.fmtTime(sec)}`));
    assert.equal(new Set(hf.current.order).size, hf.current.order.length, "no repeated track");
    counts.push(hf.current.order.length);
  }
  assert.ok(counts.every((c, i) => !i || c > counts[i - 1]), "more time, more tracks: " + counts);
});

test("duration: a short pool uses everything and says so; the loader stays hidden", () => {
  const { el, hf, flush } = makeEnv();
  setList(hf, lines(10));
  el("set-len").value = "14400";
  el("set-len").listeners.change();
  flush();
  assert.equal(hf.current.order.length, 10);
  assert.match(el("notice").textContent, /Only 10 unique tracks are available .* of the 4:00:00 target/);
  assert.equal(el("loader").hidden, true);
});

test("duration: 4 h from a 120-track pool arranges in reasonable time", () => {
  const { el, hf } = makeEnv();
  setList(hf, lines(120));
  el("set-len").value = "14400";
  const t0 = Date.now();
  hf.run(true);
  const ms = Date.now() - t0;
  assert.ok(Math.abs(hf.sumSeconds(hf.current.order) - 14400) <= 420, "runtime " + hf.sumSeconds(hf.current.order));
  assert.ok(ms < 15000, `took ${ms} ms`);
  console.log(`# 4h arrange of ${hf.current.order.length}/120 tracks: ${ms} ms`);
});

// ---- Arc controls wiring ----------------------------------------------------------------------

test("arc menu: picking an arc sets its natural peak position, redraws the curve and re-arranges", () => {
  const { el, hf, flush } = makeEnv();
  el("arc").value = "slow";
  el("arc").listeners.change();
  flush();
  assert.equal(el("peak-pos").value, 90);
  assert.equal(el("peak-pos-val").textContent, "90%");
  assert.equal(hf.current.arc, "slow");
  assert.match(el("set-vibe").textContent, /Steadily Rising \/ Slow Burn \/ peak 90%/);
  assert.match(el("arc-hint").textContent, /Linear climb/);
  assert.match(el("arc-preview").innerHTML, /<polyline points="0\.0,28\.0 /);
  el("peak-pos").value = "60";
  el("peak-pos").listeners.input();
  assert.equal(el("peak-pos-val").textContent, "60%");
  el("peak-pos").listeners.change();
  flush();
  assert.equal(hf.current.peakPos, .6);
  assert.equal(el("loader").hidden, true);
});

test("generated set is ordered by the chosen arc (energy of the opener < peak)", () => {
  const { el, hf, flush } = makeEnv();
  setList(hf, lines(40));
  for (const arc of ["classic", "slow", "coaster"]) {
    el("arc").value = arc;
    el("arc").listeners.change();
    flush();
    const o = hf.current.order;
    assert.ok(o[0].energy <= 3 && Math.max(...o.map(t => t.energy)) === 5 && o[0].energy < 5, `${arc} opener E${o[0].energy}`);
  }
});

// ---- Rekordbox playlists by arc phase ------------------------------------------------------------

function playlistsOf(xml) {
  const root = xml.match(/<PLAYLISTS>([\s\S]*)<\/PLAYLISTS>/)[1];
  const lists = [...root.matchAll(/<NODE Name="([^"]*)" Type="1" KeyType="0" Entries="(\d+)">([\s\S]*?)<\/NODE>/g)].map(m => ({
    name: m[1], entries: +m[2], keys: [...m[3].matchAll(/<TRACK Key="(\d+)"\/>/g)].map(k => +k[1])
  }));
  const folder = root.match(/<NODE Type="0" Name="HarmonicFlow - Phases" Count="(\d+)">/);
  return { lists, folderCount: folder ? +folder[1] : 0, rootCount: +root.match(/<NODE Type="0" Name="ROOT" Count="(\d+)">/)[1] };
}

const phaseNames = { classic: ["1. Warm-up", "2. Build-up", "3. Peak Hour", "4. Outro"], slow: ["1. Warm-up", "2. Build-up", "3. Peak Hour"],
  banger: ["1. Opener", "2. Peak Hour", "3. Closer"], coaster: ["1. Build-up", "2. Peak 1", "3. Breather", "4. Peak 2", "5. Outro"] };

for (const arc of Object.keys(phaseNames)) {
  test(`Rekordbox XML (${arc}): Full Set plus one playlist per phase, in order, nothing lost`, () => {
    const { el, hf, flush } = makeEnv();
    setList(hf, lines(20));
    el("set-len").value = "14400";
    el("arc").value = arc;
    el("arc").listeners.change();
    flush();
    const set = hf.current, n = set.order.length;
    assert.equal(n, 20);
    const xml = hf.buildXML(set);
    const { lists, folderCount, rootCount } = playlistsOf(xml);
    assert.equal(lists[0].name, "HarmonicFlow - Full Set");
    assert.equal(lists[0].entries, n);
    assert.deepEqual(lists[0].keys, Array.from({ length: n }, (_, i) => i + 1), "chronological");
    assert.deepEqual(lists.slice(1).map(l => l.name), phaseNames[arc]);
    assert.equal(folderCount, lists.length - 1);
    assert.equal(rootCount, 2);
    assert.deepEqual(lists.slice(1).flatMap(l => l.keys), lists[0].keys, "phases partition the full set in order");
    for (const l of lists) assert.equal(l.entries, l.keys.length);
    // every playlist entry refers to a COLLECTION track, each of which still has 8 hot cues
    assert.equal((xml.match(/<TRACK TrackID=/g) || []).length, n);
    assert.equal((xml.match(/<POSITION_MARK /g) || []).length, n * 8);
    if (process.env.HF_XML_ARC_OUT) writeFileSync(process.env.HF_XML_ARC_OUT.replace("{arc}", arc), xml, "utf8");
  });
}

test("Rekordbox XML: classic phase sizes follow the 20/40/30/10 split", () => {
  const { el, hf, flush } = makeEnv();
  setList(hf, lines(20));
  el("set-len").value = "14400";
  hf.run(true);
  const { lists } = playlistsOf(hf.buildXML(hf.current));
  assert.deepEqual(lists.slice(1).map(l => l.entries), [4, 8, 6, 2]);
});

test("Rekordbox XML: empty phases are dropped and numbering stays contiguous", () => {
  const { hf } = makeEnv();
  const order = ["A", "B", "C"].map((x, i) => ({ artist: x, title: x, bpm: 126, key: { n: 8, m: "A" }, energy: 3, duration: 300 }));
  const { lists } = playlistsOf(hf.buildXML({ name: "x", order, arc: "coaster", peakPos: .75 }));
  const phases = lists.slice(1);
  assert.ok(phases.length >= 1 && phases.every(l => l.entries > 0));
  phases.forEach((l, i) => assert.ok(l.name.startsWith(`${i + 1}. `), l.name));
  assert.deepEqual(phases.flatMap(l => l.keys), [1, 2, 3]);
  const none = playlistsOf(hf.buildXML({ name: "x", order }));
  assert.equal(none.lists.length, 1);
  assert.equal(none.rootCount, 1);
});

// =============================================================================================
// Agent-first single-prompt UX
// =============================================================================================

const unique = list => new Set(Array.from(list, t => hfTrackKey(t))).size === list.length;
let hfTrackKey = null; // set per env below (trackKey lives in the page script)

const PLAN = (over = {}) => ({
  source: "llm", note: null, rationale: "Warehouse opening slot: slow climb with tight key matching.",
  duration_hours: 2, curve: "slow", peak_position: 90, strictness: 1, tempo_flex: 3, selected_pool_ids: [], ...over
});

const curatedReply = (n, over = {}) => ({
  source: "local", note: null, count: n, genres: ["techno"], bpm_range: [130, 140], total_seconds: n * 330, target_seconds: 7200, shortfall: false,
  tracks: Array.from({ length: n }, (_, i) => ({ artist: `CArtist${i}`, title: `CTitle${i}`, bpm: 130 + (i % 11), key: `${6 + (i % 3)}A`, energy: (i % 5) + 1, duration: 300 + i })),
  ...over
});

const playlistData = (name, n, prefix, over = {}) => ({
  name, count: n, tracks: [],
  details: Array.from({ length: n }, (_, i) => ({ artist: `${prefix}Artist${i}`, title: `${prefix}Title${i}`, duration_ms: (200 + i * 9) * 1000 })),
  ...over
});

const fail = detail => ({ __fail: detail });

// Routes the page's fetch() calls: path -> data | fail(detail) | Error | (body) => any
function api(env, routes) {
  const calls = [];
  env.ctx.fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push([url, body]);
    let r = routes[url];
    if (typeof r === "function") r = r(body);
    if (r && r.name === "TypeError" && r.message !== undefined) throw r;
    if (r === undefined) return { ok: false, json: async () => ({ detail: `no route ${url}` }) };
    if (r && r.__fail) return { ok: false, json: async () => ({ detail: r.__fail }) };
    return { ok: true, json: async () => r };
  };
  return calls;
}

// Types into the single input and presses "Curate & Plan Set"; resolves when the whole pipeline has finished.
async function curate(env, text) {
  env.el("main-input").value = text;
  env.el("form").listeners.submit({ preventDefault() {} });
  for (let i = 0; i < 500 && env.el("go").disabled; i++) await new Promise(r => setImmediate(r));
  env.flush();
}

const emptyEnv = () => {
  const env = makeEnv({ seed: false });
  hfTrackKey = t => env.hf.trackKey(t.artist, t.title);
  return env;
};
const titles = env => Array.from(env.hf.current.order, t => t.title);
const rows = env => (env.el("timeline").innerHTML.match(/<tr>/g) || []).length;
const checkedIds = hf => Array.from(hf.sources.filter(x => x.checked), x => x.id);

test("markup: one input, one button, memo, table, exports - and nothing of the old manual UI", () => {
  assert.equal((html.match(/<textarea/g) || []).length, 1, "a single textarea");
  assert.match(html, /<textarea id="main-input"[^>]*placeholder="Describe your gig, vibe, venue, or paste Spotify\/SoundCloud\/YouTube links\.\.\."/);
  assert.match(html, /<button class="go" id="go" type="submit">Curate &amp; Plan Set<\/button>/);
  for (const gone of ['id="tracks"', 'id="preset"', "ai-prompt", "btn-ai", "btn-fetch", "btn-gig", "playlist-url", "AI Mix Hint", "AI Vibe Prompt",
    "Custom Track List", "Custom track list", 'id="copy"', "export-view", "gig-text", "PRESETS", "VIBES", "aiTips"]) {
    assert.ok(!html.includes(gone), `${gone} must be gone`);
  }
  const heads = [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map(m => m[1]);
  assert.deepEqual(heads, ["#", "Key", "BPM", "Title", "Artist", "Transition"]);
  assert.match(html, /id="dl-xml"[^>]*>Rekordbox XML/);
  assert.match(html, /id="dl-m3u"[^>]*>M3U Playlist/);
});

test("markup: visible flow is input -> reasoning memo -> table -> export buttons", () => {
  const at = s => { const i = html.indexOf(s); assert.ok(i > 0, s); return i; };
  assert.ok(at('id="main-input"') < at('id="gig-memo"') && at('id="gig-memo"') < at("<table") && at("<table") < at('id="dl-xml"'));
  assert.match(html, /<h2>Agent Reasoning Memo/);
  assert.match(html, /<section class="panel memo" id="gig-memo"[^>]*hidden>/);
});

test("markup: all manual controls live inside a closed <details> 'Advanced Overrides (Auto-managed by AI)'", () => {
  const m = html.match(/<details class="advanced" id="advanced"([^>]*)>([\s\S]*?)<\/details>/);
  assert.ok(m, "details element");
  assert.ok(!/\bopen\b/.test(m[1]), "closed by default");
  assert.match(m[2], /<summary>Advanced Overrides \(Auto-managed by AI\)<\/summary>/);
  for (const id of ["arc", "peak-pos", "strictness", "tempo-flex", "set-len", "pool"]) assert.ok(m[2].includes(`id="${id}"`), `${id} is inside the details`);
  const outside = html.slice(0, html.indexOf("<details")) + html.slice(html.indexOf("</details>"));
  for (const id of ["arc", "peak-pos", "strictness", "tempo-flex", "set-len"]) assert.ok(!outside.includes(`id="${id}"`), `${id} only in the details`);
});

test("start state: empty table hint, memo hidden, export buttons disabled", () => {
  const env = emptyEnv();
  assert.equal(env.el("gig-memo").hidden, true);
  assert.match(html, /<button class="btn primary" id="dl-xml" type="button" disabled>/);
  assert.match(html, /<button class="btn" id="dl-m3u" type="button" disabled>/);
  assert.match(html, /<tr class="empty"><td colspan="6">Describe your gig above/);
  assert.equal(env.hf.sources.length, 0);
});

test("splitInput separates playlist links from the brief", () => {
  const { hf } = emptyEnv();
  const r = hf.splitInput("Dark techno 130-140 BPM, see https://open.spotify.com/playlist/AAA, and (https://soundcloud.com/x/sets/y). https://open.spotify.com/playlist/AAA");
  assert.deepEqual(Array.from(r.urls), ["https://open.spotify.com/playlist/AAA", "https://soundcloud.com/x/sets/y"]);
  assert.equal(r.brief, "Dark techno 130-140 BPM, see and");
  assert.equal(r.extra, 0);
  const none = hf.splitInput("  Opening slot   22-00  ");
  assert.deepEqual([Array.from(none.urls), none.brief], [[], "Opening slot 22-00"]);
  const many = hf.splitInput(Array.from({ length: 11 }, (_, i) => `https://youtu.be/v${i}`).join(" "));
  assert.equal(many.urls.length, 8);
  assert.equal(many.extra, 3);
  assert.equal(hf.splitInput("only spotify.com text, no scheme").urls.length, 0);
});

test("duplicates: the same song (case, 'Radio Edit', punctuation) is only ever taken once, remixes stay separate", () => {
  const { hf } = emptyEnv();
  const { tracks, dupes } = hf.parseList([
    "Kolter - Trapped | 138 | 5A | E4", "KOLTER - Trapped - Radio-Edit | 138 | 5A | E4", "kolter - trapped (radio edit) | 138 | 5A | E4",
    "ARTBAT - Return to Oz | 124 | 4A | E3", "ARTBAT - Return to Oz (Monolink Remix) | 124 | 4A | E3", "Mau P - Drugs From Amsterdam | 125 | 8A | E5"].join("\n"));
  assert.equal(tracks.length, 4);
  assert.equal(dupes, 2);
  assert.deepEqual(Array.from(tracks, t => t.title), ["Trapped", "Return to Oz", "Return to Oz (Monolink Remix)", "Drugs From Amsterdam"]);
});

test("brief only (no link): the agent plans, curates unique tracks itself and generates the set", async () => {
  const env = emptyEnv();
  const { el, hf } = env;
  const calls = api(env, { "/api/analyze-gig": PLAN(), "/api/curate": curatedReply(30) });
  await curate(env, "  Dark hypnotic techno 130-140 BPM  ");

  assert.deepEqual(calls.map(c => c[0]), ["/api/analyze-gig", "/api/curate"], "no playlist fetch without links");
  assert.deepEqual(calls[0][1], { text: "Dark hypnotic techno 130-140 BPM", pools: [] });
  assert.deepEqual(calls[1][1], { brief: "Dark hypnotic techno 130-140 BPM", duration_hours: 2 });
  assert.deepEqual(Array.from(hf.sources, x => x.id), ["curated"]);
  assert.deepEqual(checkedIds(hf), ["curated"]);
  assert.equal(el("error").hidden, true);
  assert.equal(el("gig-memo").hidden, false);
  assert.match(el("gig-steps").innerHTML, /Curated 30 unique tracks \(techno, 130-140 BPM\) from the built-in style pool/);
  assert.equal(el("gig-rationale").textContent, PLAN().rationale);
  assert.equal(el("gig-source").textContent, "Claude");
  assert.equal(el("arc").value, "slow");
  assert.equal(el("peak-pos").value, "90");
  assert.equal(el("strictness").value, "1");
  assert.equal(el("tempo-flex").value, "3");

  assert.ok(hf.current, "set generated by the single button");
  assert.equal(hf.current.name, "Set: Dark hypnotic techno 130-140 BPM");
  assert.equal(hf.current.arc, "slow");
  assert.equal(hf.current.targetSec, 7200);
  assert.ok(Math.abs(hf.sumSeconds(hf.current.order) - 7200) <= 420);
  assert.equal(rows(env), hf.current.order.length);
  assert.ok(hf.current.order.every(t => t.title.startsWith("CTitle")));
  assert.ok(unique(hf.current.order));
  assert.equal(el("dl-xml").disabled, false);
  assert.equal(el("dl-m3u").disabled, false);
  assert.equal(el("go").disabled, false);
  assert.equal(el("go").textContent, "Curate & Plan Set");
  assert.equal(el("loader").hidden, true);
  assert.equal(el("agent-status").textContent, "");
});

test("links only: the agent imports them, decides the parameters and picks from them without curating", async () => {
  const env = emptyEnv();
  const { el, hf } = env;
  const A = "https://open.spotify.com/playlist/AAAAAAAAAAAAAAAAAAAAAA", B = "https://soundcloud.com/x/sets/latin";
  const calls = api(env, {
    "/api/fetch-playlist": b => b.url === A ? playlistData("Bar", 7, "B") : playlistData("Latin Tech", 24, "L"),
    "/api/analyze-gig": body => PLAN({ source: "local", selected_pool_ids: body.pools.map(p => p.id), curve: "classic", peak_position: 75, strictness: 2, tempo_flex: 5, duration_hours: 3 })
  });
  await curate(env, `${A}\n${B}`);

  assert.deepEqual(calls.map(c => c[0]), ["/api/fetch-playlist", "/api/fetch-playlist", "/api/analyze-gig"], "no curation when links were given");
  assert.equal(calls[2][1].text, "DJ set from the provided playlists");
  assert.deepEqual(calls[2][1].pools, [{ id: "url:" + A, name: "Bar", count: 7 }, { id: "url:" + B, name: "Latin Tech", count: 24 }]);
  assert.deepEqual(checkedIds(hf), ["url:" + A, "url:" + B]);
  assert.match(el("gig-steps").innerHTML, /Imported &quot;Bar&quot;: 7 tracks\./);
  assert.match(el("gig-steps").innerHTML, /Imported &quot;Latin Tech&quot;: 24 tracks\./);
  assert.equal(hf.current.name, "Playlist set");
  assert.equal(hf.current.targetSec, 10800);
  assert.equal(hf.current.order.length, 31, "both lists together are shorter than 3 h: every unique track once");
  assert.ok(unique(hf.current.order));
  assert.equal(el("gig-source").textContent, "Local engine");
  assert.match(el("pool").innerHTML, /<span class="pool-name">Bar<\/span><span class="mono">\(7\)<\/span>/);
});

test("links + brief: the plan picks the fitting list and only that one feeds the set", async () => {
  const env = emptyEnv();
  const A = "https://open.spotify.com/playlist/AAAAAAAAAAAAAAAAAAAAAA", B = "https://soundcloud.com/x/sets/latin";
  const calls = api(env, {
    "/api/fetch-playlist": b => b.url === A ? playlistData("Bar", 7, "B") : playlistData("Latin Tech", 24, "L"),
    "/api/analyze-gig": PLAN({ selected_pool_ids: ["url:" + B] })
  });
  await curate(env, `Latin warm-up for a rooftop bar ${A} ${B}`);
  assert.equal(calls[2][1].text, "Latin warm-up for a rooftop bar");
  assert.ok(!calls.some(c => c[0] === "/api/curate"));
  assert.deepEqual(checkedIds(env.hf), ["url:" + B]);
  assert.equal(env.hf.current.order.length, 24);
  assert.ok(env.hf.current.order.every(t => t.title.startsWith("LTitle")));
  assert.match(env.el("pool-total").textContent, /^24 tracks selected$/);
});

test("overlapping playlists never put the same song in twice", async () => {
  const env = emptyEnv();
  const A = "https://youtu.be/AAA", B = "https://youtu.be/BBB";
  api(env, {
    "/api/fetch-playlist": b => b.url === A ? playlistData("One", 8, "S") : playlistData("Two", 8, "S", {
      details: playlistData("Two", 8, "S").details.map((d, i) => i < 5 ? { ...d, title: d.title + (i % 2 ? " (Radio Edit)" : "").toUpperCase() } : { ...d, title: "Own" + i })
    }),
    "/api/analyze-gig": b => PLAN({ selected_pool_ids: b.pools.map(p => p.id), duration_hours: 4 })
  });
  await curate(env, `${A} ${B}`);
  const order = env.hf.current.order;
  assert.ok(unique(order));
  assert.equal(order.length, 11, "8 + 8 minus 5 repeats");
  assert.match(env.el("notice").textContent, /Removed 5 duplicate tracks\./);
});

test("a pool that is shorter than the slot gives a shorter set instead of repeats", async () => {
  const env = emptyEnv();
  api(env, { "/api/analyze-gig": PLAN({ duration_hours: 4 }), "/api/curate": curatedReply(10, { shortfall: true, total_seconds: 3300, target_seconds: 14400 }) });
  await curate(env, "drum and bass 174");
  const { hf, el } = env;
  assert.equal(hf.current.order.length, 10);
  assert.ok(unique(hf.current.order));
  assert.match(el("notice").textContent, /Only 10 unique tracks are available \(.* of the 4:00:00 target\), so the set ends there instead of repeating songs\./);
  assert.match(el("gig-steps").innerHTML, /no track is repeated to fill it/);
});

test("for any slot length the set is unique and as long as the unique tracks allow", async () => {
  const env = emptyEnv();
  for (const hours of [1, 2, 3, 4]) for (const n of [6, 25, 80]) {
    api(env, { "/api/analyze-gig": PLAN({ duration_hours: hours }), "/api/curate": curatedReply(n) });
    await curate(env, "techno set");
    const order = env.hf.current.order, total = env.hf.sumSeconds(order), all = env.hf.sumSeconds(env.hf.parsePool().tracks);
    assert.ok(unique(order), `${hours} h / ${n} tracks`);
    assert.ok(order.length <= n);
    if (all <= hours * 3600) assert.equal(order.length, n, "everything used when the pool is too short");
    else assert.ok(Math.abs(total - hours * 3600) <= 420, `${hours} h / ${n}: ${total}s`);
  }
});

test("a failing link falls back to curation from the brief; the failure is reported in the memo", async () => {
  const env = emptyEnv();
  const calls = api(env, {
    "/api/fetch-playlist": fail("Paikalliset ja yksityiset osoitteet on estetty."),
    "/api/analyze-gig": PLAN(), "/api/curate": curatedReply(20)
  });
  await curate(env, "Peak time techno https://open.spotify.com/playlist/BROKEN");
  assert.deepEqual(calls.map(c => c[0]), ["/api/fetch-playlist", "/api/analyze-gig", "/api/curate"]);
  assert.match(env.el("gig-steps").innerHTML, /Skipped open\.spotify\.com\/playlist\/BROKEN: Paikalliset ja yksityiset osoitteet on estetty\./);
  assert.match(env.el("gig-steps").innerHTML, /Curated 20 unique tracks/);
  assert.ok(env.hf.current.order.length >= 2);
});

test("only failing links and no brief: clear error, nothing generated, button usable again", async () => {
  const env = emptyEnv();
  const calls = api(env, { "/api/fetch-playlist": fail("Virhe Spotifyn haussa: HTTP 404") });
  await curate(env, "https://open.spotify.com/playlist/NOPE");
  assert.deepEqual(calls.map(c => c[0]), ["/api/fetch-playlist"]);
  assert.match(env.el("error").textContent, /Skipped open\.spotify\.com\/playlist\/NOPE: Virhe Spotifyn haussa: HTTP 404/);
  assert.equal(env.el("error").hidden, false);
  assert.equal(env.hf.current, null);
  assert.equal(env.el("go").disabled, false);
  assert.equal(env.el("gig-memo").hidden, true);
});

test("short input, offline backend and server errors are reported without breaking the page", async () => {
  const env = emptyEnv();
  let n = 0;
  env.ctx.fetch = async () => { n++; throw new TypeError("Failed to fetch"); };
  await curate(env, "  ");
  assert.equal(n, 0);
  assert.match(env.el("error").textContent, /Describe your gig or paste playlist links first/);

  await curate(env, "Opening set 22-00");
  assert.equal(env.el("error").textContent, "Backend offline. Start it with: python app.py");
  await curate(env, "https://youtu.be/abc");
  assert.equal(env.el("error").textContent, "Backend offline. Start it with: python app.py");

  api(env, { "/api/analyze-gig": fail("Liitä tapahtumakuvaus tai soittoaika ensin.") });
  await curate(env, "ab ?");
  assert.equal(env.el("error").textContent, "Liitä tapahtumakuvaus tai soittoaika ensin.");
  assert.equal(env.el("go").disabled, false);
  assert.equal(env.el("go").textContent, "Curate & Plan Set");
  assert.equal(env.hf.current, null);
});

test("every press plans from scratch: earlier lists are replaced, a re-run keeps the loader hidden", async () => {
  const env = emptyEnv();
  api(env, { "/api/analyze-gig": PLAN(), "/api/curate": curatedReply(12), "/api/fetch-playlist": playlistData("Bar", 9, "B") });
  await curate(env, "techno");
  assert.deepEqual(Array.from(env.hf.sources, x => x.id), ["curated"]);
  await curate(env, "https://open.spotify.com/playlist/AAAAAAAAAAAAAAAAAAAAAA");
  assert.deepEqual(Array.from(env.hf.sources, x => x.id), ["url:https://open.spotify.com/playlist/AAAAAAAAAAAAAAAAAAAAAA"]);
  assert.ok(env.hf.current.order.every(t => t.title.startsWith("BTitle")));
  assert.equal(env.el("loader").hidden, true);
});

test("advanced overrides re-arrange the current pool without asking the agent again", async () => {
  const env = emptyEnv();
  const { el, hf } = env;
  const calls = api(env, { "/api/analyze-gig": PLAN(), "/api/curate": curatedReply(40) });
  await curate(env, "techno 130-140");
  const before = calls.length, order0 = titles(env).join();

  el("arc").value = "banger";
  el("arc").listeners.change();
  env.flush();
  assert.equal(el("peak-pos").value, 60);
  assert.equal(hf.current.arc, "banger");
  assert.ok(hf.current.order.every(t => t.energy >= 3), "festival arc re-ordered the same pool");

  el("set-len").value = "3600";
  el("set-len").listeners.change();
  env.flush();
  assert.equal(hf.current.targetSec, 3600);
  assert.ok(Math.abs(hf.sumSeconds(hf.current.order) - 3600) <= 420);

  el("strictness").value = "3"; el("strictness").listeners.change(); env.flush();
  el("tempo-flex").value = "9"; el("tempo-flex").listeners.change(); env.flush();
  assert.deepEqual({ ...hf.current.opts }, { strictness: 3, tempoFlex: 9 });

  el("pool").listeners.change({ target: { dataset: { id: "curated" }, checked: false } });
  env.flush();
  assert.match(el("error").textContent, /Select at least two tracks/);
  el("pool").listeners.change({ target: { dataset: { id: "curated" }, checked: true } });
  env.flush();
  assert.equal(el("error").hidden, true);
  assert.equal(calls.length, before, "no new API calls: overrides are local");
  assert.notEqual(titles(env).join(), order0);
  assert.equal(el("loader").hidden, true);
});

test("overrides before anything was planned just say what to do", () => {
  const env = emptyEnv();
  env.el("arc").value = "slow";
  env.el("arc").listeners.change();
  assert.match(env.el("error").textContent, /Describe your gig above and press Curate & Plan Set/);
  assert.equal(env.hf.current, null);
});

test("model-supplied text (rationale, list names, steps) is never interpreted as HTML", async () => {
  const env = emptyEnv();
  api(env, {
    "/api/fetch-playlist": playlistData("<img src=x onerror=alert(1)>", 6, "X"),
    "/api/analyze-gig": b => PLAN({ rationale: "<script>alert(1)</script> plan", selected_pool_ids: b.pools.map(p => p.id) })
  });
  await curate(env, "https://youtu.be/xyz");
  assert.equal(env.el("gig-rationale").textContent, "<script>alert(1)</script> plan");
  for (const id of ["gig-chips", "gig-steps", "pool"]) assert.ok(!/<img|<script/i.test(env.el(id).innerHTML), id);
  assert.match(env.el("pool").innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("exports are enabled after a run and download M3U / XML for the planned set", async () => {
  const env = emptyEnv();
  api(env, { "/api/analyze-gig": PLAN({ curve: "classic", peak_position: 75 }), "/api/curate": curatedReply(24) });
  await curate(env, "techno");
  env.el("dl-xml").listeners.click();
  assert.equal(env.el("toast").textContent, "Downloaded HarmonicFlow-classic.xml");
  env.el("dl-m3u").listeners.click();
  assert.equal(env.el("toast").textContent, "Downloaded HarmonicFlow-classic.m3u");
  const xml = env.hf.buildXML(env.hf.current);
  assert.match(xml, /<NODE Name="HarmonicFlow - Full Set" Type="1"/);
  assert.match(xml, /<NODE Type="0" Name="HarmonicFlow - Phases"/);
  assert.equal((xml.match(/<POSITION_MARK /g) || []).length, env.hf.current.order.length * 8);
});

// Contract test: pytest feeds the real backend's plan and curated pool for a brief through the real page code.
test("backend plan and curated pool land in the UI and produce a unique set", { skip: !process.env.HF_GIG_PLAN }, async () => {
  const { text, plan, curated } = JSON.parse(readFileSync(process.env.HF_GIG_PLAN, "utf8"));
  const env = emptyEnv();
  const calls = api(env, { "/api/analyze-gig": plan, "/api/curate": curated });
  await curate(env, text);
  const { el, hf } = env;
  assert.deepEqual(calls[1][1], { brief: text, duration_hours: plan.duration_hours });
  assert.equal(el("set-len").value, String(plan.duration_hours * 3600));
  assert.equal(el("arc").value, plan.curve);
  assert.equal(+el("peak-pos").value, plan.peak_position);
  assert.equal(el("strictness").value, String(plan.strictness));
  assert.equal(el("tempo-flex").value, String(plan.tempo_flex));
  assert.equal(hf.current.arc, plan.curve);
  const order = hf.current.order, [lo, hi] = curated.bpm_range;
  assert.ok(order.length >= 8 && unique(order));
  assert.ok(order.every(t => t.bpm >= lo - 6 && t.bpm <= hi + 6), "tracks fit the requested tempo window");
  assert.ok(hf.sumSeconds(order) <= plan.duration_hours * 3600 + 420);
});
