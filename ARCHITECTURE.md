# HarmonicFlow: architecture

HarmonicFlow turns a free-text gig description and/or playlist links into a harmonically mixed DJ set
and exports it for Pioneer Rekordbox. This document describes the code as it is today.

## 1. Overview

The user sees one text box and one button (**Curate & Plan Set**). Behind it a small agent pipeline runs:

1. **Decide**: pick set length, drama arc, peak position, key strictness, tempo flexibility and which
   imported playlists fit the event (`POST /api/analyze-gig`).
2. **Source**: import the playlists the user pasted (`POST /api/fetch-playlist`) or, when there are none,
   curate tracks from the brief (`POST /api/curate`).
3. **Arrange**: order the tracks along the chosen energy curve using the Camelot wheel (client side).
4. **Export**: Rekordbox XML (8 hot cues per track, phase playlists) and M3U.

Everything the agent decided is written into the normal controls, which live in the collapsed
**Advanced Overrides** panel, so the DJ can change any of it and re-arrange locally.

### How the LLM and the heuristic engine work side by side

Each decision point has two implementations behind the same JSON contract:

| Decision | Claude (optional) | Local heuristic engine (always available) |
|---|---|---|
| Gig plan (`/api/analyze-gig`) | `llm_gig_plan` | `local_gig_plan`: time-slot parser, slot type and vibe keywords, pool-name matching |
| Track curation (`/api/curate`) | `llm_suggest` picks 8-12 tracks first | `curate_pool`: style pool filtered by genre, tempo window and fit |
| Stand-alone set (`/api/ai-suggest`) | `llm_suggest` | `local_suggest` |

Rules that make the two coexist safely:

* **One switch.** Claude is used only when `ANTHROPIC_API_KEY` is set. All calls go through `_anthropic_text`
  (one place, 15 s timeout, model from `HARMONICFLOW_AI_MODEL`, default `claude-sonnet-5-5`).
* **Validation, not trust.** Model output is parsed as JSON and checked against the real schema
  (`sanitize_gig_plan`, `sanitize_ai_result`): enums must match, numbers are clamped to their ranges,
  pool ids must be ones the client sent, track keys must be valid Camelot, names are cleaned, duplicates are dropped.
* **Never block the demo.** Any failure (no key, network, timeout, HTTP error, bad JSON, failed validation)
  falls back to the local engine. The response says which one answered (`source: "llm" | "local"`) and, after a
  failure, why (`note`). The UI shows this in the Agent Reasoning Memo.
* **Prompt text stays data.** Event text and prompts are only ever sent as the user turn (the gig text as a JSON
  field). System prompts say to ignore instructions inside them, and because the output is schema-validated the
  worst a hostile text can do is produce a valid but unhelpful plan.
* The local engine is deterministic, so the same brief gives the same plan and the same candidate list.

## 2. Files and responsibilities

| File | Responsibility |
|---|---|
| `app.py` | FastAPI backend: serves the page, URL validation (SSRF guard), playlist import (Spotify embed page, yt-dlp), the agent endpoints, the built-in style pool (`CATALOG`), LLM calls and fallbacks. |
| `index.html` | The whole UI in one file (CSS, markup, script, no external requests): input and pipeline (`curate`), parameter application (`applyGigPlan`), track pool, Camelot arrangement (`arrange`), drama arcs, table rendering, M3U and Rekordbox XML export. |
| `tests/test_app.py` | pytest: backend (SSRF, import, engines, LLM mocks and fallbacks, curation, validation limits), plus runs the Node tests and parses exported XML with a real XML parser. |
| `tests/frontend.test.mjs` | Node test runner: executes the real script of `index.html` in a stub DOM: pipeline, UI wiring, arrangement, arcs, duration, pool, loader, hot cues, XML. |
| `ARCHITECTURE.md` | This file. |

Endpoints:

| Endpoint | Purpose |
|---|---|
| `GET /` | serves `index.html` |
| `GET /api/health` | status badge |
| `POST /api/fetch-playlist` | `{url}` -> name, tracks, per-track duration (Spotify / YouTube / SoundCloud) |
| `POST /api/analyze-gig` | `{text, pools[]}` -> rationale, duration_hours, curve, peak_position, strictness, tempo_flex, selected_pool_ids |
| `POST /api/curate` | `{brief, duration_hours}` -> up to 60 unique candidate tracks, totals, shortfall flag |
| `POST /api/ai-suggest` | `{prompt}` -> an ordered 8-12 track set with tips. The UI no longer calls it; `/api/curate` reuses its LLM and validation code. |

## 3. Data lifecycle

```
 single input box
   "Dark hypnotic techno 130-140 BPM"  and/or  playlist links
        |
        v  splitInput()               links (max 8)  |  brief text
        |
        |-- for each link: POST /api/fetch-playlist --> pool list { name, "Artist - Title | m:ss" lines }
        |                  (failed links are skipped and reported in the memo)
        v
 POST /api/analyze-gig  { text, pools:[{id,name,count}] }
        |   Claude or local engine -> validated plan
        v
 no usable list?  --yes-->  POST /api/curate { brief, duration_hours }
        |                    style pool (+ Claude's picks): unique, tempo-window, closest first, <= 60
        v
 applyGigPlan(): writes duration / arc / peak / strictness / tempo into the controls,
                 ticks the chosen lists in Track Pool, fills the Agent Reasoning Memo
        v
 parsePool(): merge ticked lists, de-duplicate (trackKey), estimate missing BPM / key / energy (marked ~)
        v
 arrangeForDuration(): choose how many unique tracks fit 1-4 h, arrange(): beam search (width 160)
        |   cost = energy distance to the arc target + Camelot key penalty (strictness 1-3)
        |        + tempo-jump penalty (flexibility 1-10 BPM)
        v
 table (#, Key, BPM, Title, Artist, Transition)  -->  buildXML() / buildM3U() downloads
```

Key mechanics:

* **Track identity.** `trackKey` (JS) and `track_key` (Python) lower-case the text and drop punctuation and
  "Radio Edit / Extended Mix / Original Mix / Remastered" suffixes; remixes stay distinct. A track is taken once per set;
  `arrange` also selects by index, so it cannot return one object twice.
* **No padding.** If the unique tracks are shorter than the chosen slot the set simply ends early and the page says
  so ("Only N unique tracks are available ..."). Nothing is repeated to fill time.
* **Imported playlists carry no BPM, key or energy.** Spotify's embed page only provides title, artist and duration.
  Missing values are estimated deterministically from a hash of the name and shown with `~`. Curated tracks
  from the style pool have (estimated) values.
* **Style pool.** `CATALOG` holds ~90 example tracks across techno/rave, tech house, melodic, drum and bass, latin
  and house, with approximate BPM, Camelot key, energy and length. They are placeholders for the demo, not verified
  metadata, and some genres only fill an hour or so. The brief decides the genre tags and the tempo window
  (`parse_vibe_prompt`).
* **Drama arcs.** `ARCS` maps set position to a target energy (classic journey, slow burn, festival banger,
  rollercoaster) and splits the set into named phases. Peak Position (50-90 %) moves the main peak.
* **Camelot rules.** Strictness 1 allows same / adjacent / relative keys, 2 adds the +2 and +7 energy boosts,
  3 allows any move at a small cost. Breaking the active rule adds a large penalty rather than failing, so a
  pool without a perfect chain still produces a set.
* **Rekordbox XML.** Each track gets `TotalTime` (real length when known, otherwise 6:00, flagged in the UI) and
  8 hot cues (A-H = `Num` 0-7) at phrase positions, squeezed onto bar lines inside the track (last cue at least 2 s
  before the end). `<PLAYLISTS>` contains `HarmonicFlow - Full Set` (chronological) and a folder
  `HarmonicFlow - Phases` with one numbered playlist per non-empty arc phase. All attribute text goes through
  `xmlEsc` (entities and illegal control characters).

## 4. Security architecture

The backend runs on `127.0.0.1` and fetches URLs on behalf of the page, so server-side request forgery (SSRF)
is the main risk. `validate_public_url` runs before anything is fetched:

1. Only `http` / `https`; no credentials in the URL; bad ports are rejected.
2. IP literals are parsed including legacy forms (`2130706433`, `0x7f.1`, `127.1`, `[::ffff:127.0.0.1]`) and rejected
   unless globally routable (loopback, private, link-local, CGNAT, multicast, unspecified are all refused).
3. Names such as `localhost`, `*.localhost`, `*.local`, `*.internal`, `*.lan`, `*.home.arpa` and single-label hosts are refused.
4. **Allowlist by host name**, with suffix match on a dot boundary: `youtube.com`, `youtu.be`, `soundcloud.com`,
   `spotify.com`. The service is chosen from the parsed host, never from a substring of the URL
   (`http://127.0.0.1/?x=spotify.com` and `open.spotify.com.evil.com` are rejected).
5. Best-effort DNS check: if an allowed name resolves to a non-public address the request is refused.
6. Spotify requests never use the user's URL: only the 22-character playlist id is extracted and a fixed
   `https://open.spotify.com/embed/playlist/<id>` URL is requested.

Other measures:

* **Input limits** (pydantic): URL 2048, set prompt 500, gig text 2000 (+ at most 30 pools, names 120), curate brief 1000;
  the page sends at most 8 links per press.
* **Output handling.** All text shown in the page goes through `esc()` or `textContent`; model text is never put in
  `innerHTML`. Track fields are normalised by `clean_text` (control characters, `|` and length). XML is escaped.
* **Secrets.** The API key only comes from the environment and is never returned or logged by the app.
* **CORS** allows any origin but without credentials.

Known limits (not addressed):

* DNS rebinding between the validation lookup and the actual request, and redirects followed by `requests` / yt-dlp,
  are not re-validated.
* Because CORS is open and there is no authentication or rate limiting, any web page open in the same browser could
  call the local API (including the LLM-backed endpoints, which use your key). Run it locally and do not expose the port.
* Third-party extractors (yt-dlp) and Spotify's embed page format can change; the Spotify import relies on an
  undocumented `__NEXT_DATA__` structure.

## 5. Tests

```
python -m pytest tests/              # backend + runs the Node tests + XML parser checks
node --test tests/frontend.test.mjs  # frontend only
HF_OFFLINE=1 python -m pytest tests/ # skip the one test that fetches a real Spotify playlist
```

* FastAPI's `TestClient` is not used (incompatible with the installed starlette/httpx pair); tests call the handlers directly.
* Contract tests feed the real backend output (plan, curated pool) through the real page script, and the exported XML
  is parsed with `xml.etree` to check playlists, `TotalTime` and hot cues.
* The Claude path is only tested against mocked responses (no API key in CI).
