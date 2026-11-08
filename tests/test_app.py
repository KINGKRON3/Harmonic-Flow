import json
import os
import re
import shutil
import socket
import subprocess
import types
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

import app as app_module

ROOT = Path(__file__).resolve().parent.parent
PLAYLIST_ID = "2Mg5wgO65IZ0aOdh2hlg8S"
PLAYLIST_URL = f"https://open.spotify.com/playlist/{PLAYLIST_ID}"
DEMO_PROMPT = "Dark peak-time techno set that starts at 130 BPM and ends at 140 BPM with heavy drops"


def post(url):
    """Calls the /api/fetch-playlist handler directly -> (status, body)."""
    try:
        return 200, app_module.fetch_playlist(app_module.PlaylistRequest(url=url))
    except HTTPException as e:
        return e.status_code, {"detail": e.detail}


def ai(prompt):
    try:
        return 200, app_module.ai_suggest(app_module.AiRequest(prompt=prompt))
    except HTTPException as e:
        return e.status_code, {"detail": e.detail}


def embed_html(track_list):
    data = {"props": {"pageProps": {"state": {"data": {"entity": {"name": "Test", "trackList": track_list}}}}}}
    return f'<html><script id="__NEXT_DATA__" type="application/json">{json.dumps(data)}</script></html>'


class FakeResponse:
    def __init__(self, text="", status=200, payload=None):
        self.text, self.status_code, self._payload = text, status, payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return self._payload


@pytest.fixture(autouse=True)
def isolated(monkeypatch):
    """No real DNS lookups from the SSRF guard and no API key unless a test sets one."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    fake = types.SimpleNamespace(
        getaddrinfo=lambda host, port, *a, **k: [(2, 1, 6, "", ("93.184.216.34", 0))],
        inet_aton=socket.inet_aton,
    )
    monkeypatch.setattr(app_module, "socket", fake)


# ---------------------------------------------------------------------------
# basics + Spotify import
# ---------------------------------------------------------------------------

def test_health():
    assert app_module.health() == {"status": "online"}


def test_parse_spotify_embed_normalizes_artists_and_keeps_durations():
    html = embed_html([
        {"title": "Breather", "subtitle": "CHRIS STASSY, S.A.M.", "duration": 465322},
        {"title": "", "subtitle": "Skipped"},
        {"title": "No Artist"},
        {"title": "Pipe | Name", "subtitle": "A|B", "duration": -5},
    ])
    assert app_module.parse_spotify_embed_details(html) == [
        {"artist": "CHRIS STASSY, S.A.M.", "title": "Breather", "duration_ms": 465322},
        {"artist": "Unknown", "title": "No Artist", "duration_ms": None},
        {"artist": "A/B", "title": "Pipe / Name", "duration_ms": None},
    ]
    assert app_module.parse_spotify_embed(html)[0] == "CHRIS STASSY, S.A.M. - Breather"


def test_parse_spotify_embed_without_data_raises():
    with pytest.raises(ValueError):
        app_module.parse_spotify_embed("<html></html>")


def test_spotify_endpoint_returns_real_durations(monkeypatch):
    seen = {}

    def fake_get(url, **kwargs):
        seen["url"] = url
        return FakeResponse(embed_html([{"title": "Shinjuku", "subtitle": "Franky Rizardo", "duration": 167905}]))

    monkeypatch.setattr(app_module.requests, "get", fake_get)
    status, body = post(PLAYLIST_URL + "?si=abc123")
    assert status == 200
    assert body == {
        "name": "Test",
        "tracks": ["Franky Rizardo - Shinjuku"],
        "details": [{"artist": "Franky Rizardo", "title": "Shinjuku", "duration_ms": 167905}],
        "count": 1,
    }
    assert seen["url"] == f"https://open.spotify.com/embed/playlist/{PLAYLIST_ID}"


def test_spotify_http_error_returns_400(monkeypatch):
    monkeypatch.setattr(app_module.requests, "get", lambda url, **kw: FakeResponse("", 404))
    status, body = post(PLAYLIST_URL)
    assert status == 400
    assert "Spotify" in body["detail"]


def test_spotify_empty_playlist_returns_clean_400(monkeypatch):
    monkeypatch.setattr(app_module.requests, "get", lambda url, **kw: FakeResponse(embed_html([])))
    status, body = post(PLAYLIST_URL)
    assert status == 400
    assert body["detail"].startswith("Spotifyn soittolistaa ei saatu luettua")


def test_invalid_spotify_link():
    status, body = post("https://open.spotify.com/album/xyz")
    assert status == 400
    assert body["detail"] == "Virheellinen Spotify-soittolistan linkki."


def test_unsupported_url():
    status, body = post("https://example.com/list")
    assert status == 400
    assert body["detail"].startswith("Tuettuina ovat vain")


@pytest.mark.skipif(os.environ.get("HF_OFFLINE") == "1", reason="network test disabled")
def test_live_spotify_playlist():
    """Fetches the real playlist from Spotify (set HF_OFFLINE=1 to skip)."""
    status, body = post(PLAYLIST_URL)
    assert status == 200, body
    assert body["count"] == len(body["tracks"]) == len(body["details"]) > 0
    assert "Robbie Doherty - Call It What You Like" in body["tracks"]
    assert all(" - " in t for t in body["tracks"])
    assert all(d["duration_ms"] and d["duration_ms"] > 30_000 for d in body["details"])
    assert body["name"] == "Bar"


# ---------------------------------------------------------------------------
# SSRF protection
# ---------------------------------------------------------------------------

LOCAL_URLS = [
    "http://localhost:5000/api/health",
    "http://LOCALHOST./",
    "http://127.0.0.1/",
    "http://127.0.0.1:8080/admin",
    "http://127.1/",
    "http://2130706433/",
    "http://0x7f.1/",
    "http://017700000001/",
    "http://0.0.0.0/",
    "http://10.0.0.5/",
    "http://172.16.0.1/",
    "http://192.168.1.1/router",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.64.0.1/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fe80::1]/",
    "http://[fd00::1]/",
    "http://foo.localhost/",
    "http://intranet/",
    "http://printer.local/",
    "http://db.internal/",
    "http://127.0.0.1/?u=https://open.spotify.com/playlist/" + PLAYLIST_ID,
    "http://127.0.0.1/playlist/" + PLAYLIST_ID,
]


@pytest.mark.parametrize("url", LOCAL_URLS)
def test_local_and_private_addresses_are_rejected_before_any_request(url, monkeypatch):
    def boom(*a, **k):
        raise AssertionError("network access attempted for a blocked URL")

    monkeypatch.setattr(app_module.requests, "get", boom)
    monkeypatch.setattr(app_module.yt_dlp, "YoutubeDL", boom)
    status, body = post(url)
    assert status == 400
    assert body["detail"] == app_module.BLOCKED_MSG


@pytest.mark.parametrize("url", [
    "ftp://open.spotify.com/playlist/" + PLAYLIST_ID,
    "file:///etc/passwd",
    "javascript:alert(1)",
    "open.spotify.com/playlist/" + PLAYLIST_ID,
    "",
    "https://user:pw@open.spotify.com/playlist/" + PLAYLIST_ID,
    "https://open.spotify.com.evil.com/playlist/" + PLAYLIST_ID,
    "https://evilspotify.com/playlist/" + PLAYLIST_ID,
    "https://evil.com/?x=open.spotify.com/playlist/" + PLAYLIST_ID,
    "https://8.8.8.8/playlist/" + PLAYLIST_ID,
])
def test_other_bad_urls_are_rejected(url, monkeypatch):
    monkeypatch.setattr(app_module.requests, "get", lambda *a, **k: (_ for _ in ()).throw(AssertionError("fetched")))
    status, _ = post(url)
    assert status == 400


def test_allowed_hosts_pass_validation():
    ok = {
        PLAYLIST_URL: "spotify",
        "https://www.youtube.com/playlist?list=PL123": "youtube",
        "https://music.youtube.com/watch?v=abc": "youtube",
        "https://youtu.be/abc": "youtube",
        "https://soundcloud.com/a/sets/b": "soundcloud",
    }
    for url, kind in ok.items():
        assert app_module.validate_public_url(url) == (kind, url)


def test_allowed_name_resolving_to_internal_ip_is_rejected(monkeypatch):
    internal = types.SimpleNamespace(
        getaddrinfo=lambda *a, **k: [(2, 1, 6, "", ("127.0.0.1", 0))], inet_aton=socket.inet_aton)
    monkeypatch.setattr(app_module, "socket", internal)
    status, body = post(PLAYLIST_URL)
    assert (status, body["detail"]) == (400, app_module.BLOCKED_MSG)


def test_dns_failure_does_not_block_allowed_hosts(monkeypatch):
    def fail(*a, **k):
        raise OSError("no network")

    monkeypatch.setattr(app_module, "socket", types.SimpleNamespace(getaddrinfo=fail, inet_aton=socket.inet_aton))
    assert app_module.validate_public_url(PLAYLIST_URL)[0] == "spotify"


# ---------------------------------------------------------------------------
# AI DJ agent
# ---------------------------------------------------------------------------

VALID_KEY = app_module.CAMELOT_RE


def assert_valid_tracks(tracks):
    assert 8 <= len(tracks) <= 12
    assert len({(t["artist"], t["title"]) for t in tracks}) == len(tracks), "no duplicates"
    for t in tracks:
        assert VALID_KEY.match(t["key"]) and 60 <= t["bpm"] <= 220 and 1 <= t["energy"] <= 5
        assert t["artist"] and t["title"] and "|" not in t["artist"] + t["title"]
        assert t["duration"] is None or 90 <= t["duration"] <= 1200


def test_local_generator_follows_the_demo_prompt():
    status, body = ai(DEMO_PROMPT)
    assert status == 200
    assert body["source"] == "local" and body["tips"] == [] and body["count"] == len(body["tracks"])
    tracks = body["tracks"]
    assert_valid_tracks(tracks)
    assert abs(tracks[0]["bpm"] - 130) <= 3 and abs(tracks[-1]["bpm"] - 140) <= 3
    assert tracks[-1]["bpm"] > tracks[0]["bpm"]
    assert sum(t["energy"] for t in tracks) / len(tracks) >= 3.8, "heavy drops -> high energy"
    clashes = sum(app_module.camelot_cost(a["key"], b["key"]) >= 9 for a, b in zip(tracks, tracks[1:]))
    assert clashes <= 1, "keys chain harmonically"


def test_local_generator_is_deterministic():
    assert app_module.local_suggest(DEMO_PROMPT) == app_module.local_suggest(DEMO_PROMPT)


@pytest.mark.parametrize("prompt,lo,hi", [
    ("drum and bass 174 BPM", 170, 177),
    ("Latin tech house party 126", 122, 130),
    ("melodic techno journey", 120, 127),
    ("deep warm house for sunset, 12 tracks", 116, 126),
    ("peak time rave 140 bpm", 128, 147),
    ("something completely different", 60, 220),
    ("tehdään synkkä techno-setti", 60, 220),
])
def test_local_generator_genres_and_free_text(prompt, lo, hi):
    tracks = app_module.local_suggest(prompt)
    assert_valid_tracks(tracks)
    assert all(lo <= t["bpm"] <= hi for t in tracks), [t["bpm"] for t in tracks]


def test_local_generator_chill_prompt_gets_low_energy():
    tracks = app_module.local_suggest("chill warm-up house, 12 tracks")
    assert len(tracks) == 12
    assert sum(t["energy"] for t in tracks) / 12 <= 3.2


def test_ai_endpoint_input_validation():
    with pytest.raises(ValidationError):
        app_module.AiRequest(prompt="x" * 501)
    status, body = ai("  ?  ")
    assert status == 400 and "AI Vibe Prompt" in body["detail"]


def llm_payload(tracks=None, tips=None, wrap=True):
    tracks = tracks if tracks is not None else [
        {"artist": f"Artist {i}", "title": f"Title {i}", "bpm": 126 + i, "key": f"{5 + i % 4}a", "energy": 3 + i % 3, "duration": 300 + i}
        for i in range(10)
    ]
    tips = tips if tips is not None else [f"Tip {i}: cut the lows on bar 32" for i in range(len(tracks) - 1)]
    text = json.dumps({"tracks": tracks, "tips": tips})
    return {"content": [{"type": "text", "text": ("Here you go:\n" + text + "\nEnjoy!") if wrap else text}]}


def test_llm_path_when_api_key_is_set(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-secret")
    sent = {}

    def fake_post(url, headers=None, json=None, timeout=None):
        sent.update(url=url, headers=headers, body=json, timeout=timeout)
        return FakeResponse(payload=llm_payload())

    monkeypatch.setattr(app_module.requests, "post", fake_post)
    status, body = ai(DEMO_PROMPT)
    assert status == 200 and body["source"] == "llm" and body["note"] is None
    assert_valid_tracks(body["tracks"])
    assert body["tracks"][0]["key"] == "5A", "keys are normalised to upper case"
    assert len(body["tips"]) == len(body["tracks"]) - 1
    assert sent["url"] == "https://api.anthropic.com/v1/messages"
    assert sent["headers"]["x-api-key"] == "sk-test-secret" and sent["timeout"]
    assert sent["body"]["messages"] == [{"role": "user", "content": DEMO_PROMPT}], "prompt only goes in the user turn"
    assert DEMO_PROMPT not in sent["body"]["system"]
    assert "sk-test-secret" not in json.dumps(body)


def _bad_tracks(**over):
    base = {"artist": "A", "title": "T", "bpm": 128, "key": "8A", "energy": 3}
    return [{**base, "artist": f"A{i}", **over} for i in range(10)]


@pytest.mark.parametrize("broken", [
    "not json at all",
    json.dumps({"tracks": []}),
    json.dumps({"tracks": "x"}),
    json.dumps({"tracks": _bad_tracks()[:3]}),
    json.dumps({"tracks": _bad_tracks(bpm=999)}),
    json.dumps({"tracks": _bad_tracks(key="99Z")}),
    json.dumps({"tracks": _bad_tracks(bpm="fast")}),
])
def test_bad_llm_output_falls_back_to_local(broken, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
    monkeypatch.setattr(app_module.requests, "post",
                        lambda *a, **k: FakeResponse(payload={"content": [{"type": "text", "text": broken}]}))
    status, body = ai(DEMO_PROMPT)
    assert status == 200 and body["source"] == "local" and body["note"]
    assert_valid_tracks(body["tracks"])


def _raise(exc):
    def f(*a, **k):
        raise exc
    return f


@pytest.mark.parametrize("failure", [
    _raise(app_module.requests.ConnectionError("offline")),
    _raise(app_module.requests.Timeout("slow")),
    lambda *a, **k: FakeResponse(status=529),
])
def test_llm_outage_never_breaks_the_demo(failure, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
    monkeypatch.setattr(app_module.requests, "post", failure)
    status, body = ai(DEMO_PROMPT)
    assert status == 200 and body["source"] == "local" and "paikallista generaattoria" in body["note"]
    assert_valid_tracks(body["tracks"])


def test_llm_text_is_sanitised_and_wrong_tip_count_is_dropped(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
    tracks = [{"artist": f"Ar|tist\n{i}", "title": "T\x00itle" + "x" * 300, "bpm": 126.04, "key": "8a", "energy": 9, "duration": 5}
              for i in range(9)]
    monkeypatch.setattr(app_module.requests, "post",
                        lambda *a, **k: FakeResponse(payload=llm_payload(tracks=tracks, tips=["only one"])))
    status, body = ai("x test")
    assert body["source"] == "llm" and body["tips"] == []
    t = body["tracks"][0]
    assert t["artist"] == "Ar/tist 0" and len(t["title"]) == 80 and "\x00" not in t["title"]
    assert (t["bpm"], t["key"], t["energy"], t["duration"]) == (126.0, "8A", 5, None)


# ---------------------------------------------------------------------------
# frontend (Node) + Rekordbox XML
# ---------------------------------------------------------------------------

needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")


@needs_node
def test_frontend_table_ai_loader_and_rekordbox_export():
    """Runs tests/frontend.test.mjs (table, AI prompt, sliders, presets, loader, XML)."""
    res = subprocess.run(["node", "--test", "tests/frontend.test.mjs"],
                         cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
    assert res.returncode == 0, res.stdout[-4000:] + res.stderr


@needs_node
def test_rekordbox_xml_parses_with_a_real_xml_parser(tmp_path):
    """The XML built from hostile track names must be well-formed and keep its structure."""
    out = tmp_path / "export.xml"
    res = subprocess.run(["node", "--test", "--test-name-pattern=every field is escaped", "tests/frontend.test.mjs"],
                         cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
                         env={**os.environ, "HF_XML_OUT": str(out)})
    assert res.returncode == 0, res.stdout[-3000:] + res.stderr
    root = ET.parse(out).getroot()
    assert root.tag == "DJ_PLAYLISTS"
    tracks = root.findall("./COLLECTION/TRACK")
    assert len(tracks) == 2 == int(root.find("COLLECTION").get("Entries"))
    for tr in tracks:
        total = int(tr.get("TotalTime"))
        marks = tr.findall("POSITION_MARK")
        assert [m.get("Num") for m in marks] == [str(i) for i in range(8)]
        assert all(float(m.get("Start")) <= total for m in marks)
    assert tracks[0].get("Artist").startswith('x" onload="1\' <![CDATA[ &'), "hostile text round-trips as plain data"
    assert len(root.findall("./PLAYLISTS//TRACK")) == 2


ARC_PHASES = {
    "classic": ["1. Warm-up", "2. Build-up", "3. Peak Hour", "4. Outro"],
    "slow": ["1. Warm-up", "2. Build-up", "3. Peak Hour"],
    "banger": ["1. Opener", "2. Peak Hour", "3. Closer"],
    "coaster": ["1. Build-up", "2. Peak 1", "3. Breather", "4. Peak 2", "5. Outro"],
}


@pytest.fixture(scope="module")
def arc_exports(tmp_path_factory):
    """Rekordbox XML files produced by the real frontend code for each drama arc."""
    if shutil.which("node") is None:
        pytest.skip("node not installed")
    out = tmp_path_factory.mktemp("arc") / "{arc}.xml"
    res = subprocess.run(["node", "--test", r"--test-name-pattern=Rekordbox XML \(", "tests/frontend.test.mjs"],
                         cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
                         env={**os.environ, "HF_XML_ARC_OUT": str(out)})
    assert res.returncode == 0, res.stdout[-3000:] + res.stderr
    return {arc: ET.parse(str(out).replace("{arc}", arc)).getroot() for arc in ARC_PHASES}


@pytest.mark.parametrize("arc", list(ARC_PHASES))
def test_rekordbox_playlist_tree_follows_the_arc(arc, arc_exports):
    root = arc_exports[arc]
    ids = [t.get("TrackID") for t in root.findall("./COLLECTION/TRACK")]
    assert len(ids) == 20 == int(root.find("COLLECTION").get("Entries"))

    top = root.find("./PLAYLISTS/NODE")
    assert (top.get("Name"), top.get("Type")) == ("ROOT", "0")
    children = list(top)
    assert int(top.get("Count")) == len(children) == 2

    full, folder = children
    assert (full.get("Name"), full.get("Type")) == ("HarmonicFlow - Full Set", "1")
    full_keys = [t.get("Key") for t in full]
    assert full_keys == ids and int(full.get("Entries")) == 20, "whole set in chronological order"

    assert (folder.get("Name"), folder.get("Type")) == ("HarmonicFlow - Phases", "0")
    phases = list(folder)
    assert [p.get("Name") for p in phases] == ARC_PHASES[arc]
    assert int(folder.get("Count")) == len(phases)
    for p in phases:
        keys = [t.get("Key") for t in p]
        assert keys and int(p.get("Entries")) == len(keys) and p.get("Type") == "1"
    assert [t.get("Key") for p in phases for t in p] == full_keys, "phases partition the set without gaps or overlaps"


@pytest.mark.parametrize("arc", list(ARC_PHASES))
def test_rekordbox_hot_cues_stay_on_bars_and_inside_each_track(arc, arc_exports):
    for tr in arc_exports[arc].findall("./COLLECTION/TRACK"):
        total, bpm = int(tr.get("TotalTime")), float(tr.get("AverageBpm"))
        marks = tr.findall("POSITION_MARK")
        assert [m.get("Num") for m in marks] == [str(i) for i in range(8)], "hot cues A-H"
        starts = [float(m.get("Start")) for m in marks]
        assert starts == sorted(starts) and starts[0] == 0 and starts[-1] <= total
        for s in starts:
            bars = s * bpm / 240
            assert abs(bars - round(bars)) < 0.02, f"{s}s is not on a bar line at {bpm} BPM"


# ---------------------------------------------------------------------------
# Gig Brief / Event Analyzer (/api/analyze-gig)
# ---------------------------------------------------------------------------

GIG_POOLS = [
    {"id": "manual", "name": "Custom list", "count": 12},
    {"id": "url:a", "name": "Dark Techno", "count": 30},
    {"id": "url:b", "name": "Latin Tech", "count": 24},
    {"id": "url:c", "name": "Bar", "count": 7},
]
ALL_IDS = [p["id"] for p in GIG_POOLS]
OPENING_BRIEF = "Opening slot at warehouse party 22-00, dark hypnotic vibes"


def gig(text, pools=None):
    pools = GIG_POOLS if pools is None else pools
    try:
        return 200, app_module.analyze_gig(app_module.GigRequest(text=text, pools=pools))
    except HTTPException as e:
        return e.status_code, {"detail": e.detail}


def assert_valid_plan(plan, pools=None):
    ids = [p["id"] for p in (GIG_POOLS if pools is None else pools)]
    assert plan["source"] in ("llm", "local")
    assert plan["duration_hours"] in (1, 2, 3, 4) and isinstance(plan["duration_hours"], int)
    assert plan["curve"] in ("classic", "slow", "banger", "coaster")
    assert isinstance(plan["peak_position"], int) and 50 <= plan["peak_position"] <= 90
    assert plan["strictness"] in (1, 2, 3)
    assert isinstance(plan["tempo_flex"], int) and 1 <= plan["tempo_flex"] <= 10
    assert set(plan["selected_pool_ids"]) <= set(ids) and len(set(plan["selected_pool_ids"])) == len(plan["selected_pool_ids"])
    if ids:
        assert plan["selected_pool_ids"], "at least one list is always selected"
    r = plan["rationale"]
    assert 20 < len(r) <= 400 and "\n" not in r
    assert len(re.findall(r"[.!?](?:\s|$)", r)) <= 2, "1-2 sentences"


@pytest.mark.parametrize("text,hours,curve,peak,strictness,max_flex,pools", [
    (OPENING_BRIEF, 2, "slow", 90, 1, 4, ["url:a"]),
    ("Headline set at festival main stage 23:00-01:00, hard techno bangers", 2, "banger", 60, 2, 8, ["url:a"]),
    ("Closing set 4am-8am sunrise after-hours", 4, "classic", 60, 2, 8, ALL_IDS),
    ("Marathon all night, 6 hour b2b journey", 4, "coaster", 75, 2, 8, ALL_IDS),
    ("10pm-11pm latin party", 1, "classic", 75, 2, 8, ["url:b"]),
    ("Avauskeikka 21-23, lämmittely", 2, "slow", 90, 2, 8, ALL_IDS),
    ("Open format wedding party, 3 hours, anything goes", 3, "classic", 75, 3, 10, ALL_IDS),
    ("gibberish xyz", 2, "classic", 75, 2, 8, ALL_IDS),
])
def test_local_gig_engine_decisions(text, hours, curve, peak, strictness, max_flex, pools):
    status, plan = gig(text)
    assert status == 200 and plan["source"] == "local" and plan["note"] is None
    assert_valid_plan(plan)
    assert (plan["duration_hours"], plan["curve"], plan["peak_position"], plan["strictness"]) == (hours, curve, peak, strictness)
    assert plan["tempo_flex"] <= max_flex
    assert plan["selected_pool_ids"] == pools
    assert f"{hours} h" in plan["rationale"]


def test_gig_engine_is_deterministic_and_reads_time_ranges():
    assert gig(OPENING_BRIEF) == gig(OPENING_BRIEF)
    for text, hours in [("22-00", 2), ("22:00-01:00", 3), ("10pm to 2am", 4), ("9 pm - 10 pm", 1), ("20:00 till 21:30", 2), ("11am-1pm", 2)]:
        assert gig("DJ slot " + text)[1]["duration_hours"] == hours, text
    # numbers that are not a time slot must not be read as one
    for text in ["techno 130-140 BPM", "tickets 5-10 euro", "on 12.11.2026", "entry 20-30%"]:
        assert gig(text)[1]["duration_hours"] == 2, text


def test_gig_engine_pool_matching_and_edge_cases():
    pools = [{"id": "w", "name": "Warehouse Bangers", "count": 5}, {"id": "d", "name": "DnB Run", "count": 5}, {"id": "w", "name": "dup", "count": 1}]
    plan = gig("warehouse rave tonight", pools)[1]
    assert plan["selected_pool_ids"] == ["w"]
    assert_valid_plan(plan, pools)
    plan = gig("drum and bass night", pools)[1]
    assert plan["selected_pool_ids"] == ["d"]
    empty = gig("Opening slot 22-00", [])[1]
    assert empty["selected_pool_ids"] == []
    assert_valid_plan(empty, [])
    # a pool name that only repeats generic words matches nothing, so everything stays selected
    assert gig("opening set", [{"id": "x", "name": "My playlist", "count": 3}])[1]["selected_pool_ids"] == ["x"]


def test_gig_input_validation():
    with pytest.raises(ValidationError):
        app_module.GigRequest(text="x" * 2001)
    with pytest.raises(ValidationError):
        app_module.GigRequest(text="ok", pools=[{"id": str(i), "name": "n"} for i in range(31)])
    with pytest.raises(ValidationError):
        app_module.GigRequest(text="ok", pools=[{"id": "a", "name": "x" * 121}])
    status, body = gig("  ?  ")
    assert status == 400 and "tapahtumakuvaus" in body["detail"]


def test_gig_hostile_pool_names_cannot_inject_text():
    pools = [{"id": "p1", "name": 'Evil"\n<script>alert(1)</script>| techno', "count": 1}]
    plan = gig("dark techno warehouse", pools)[1]
    assert plan["selected_pool_ids"] == ["p1"]
    assert "\n" not in plan["rationale"] and "|" not in plan["rationale"]


LLM_PLAN = {"rationale": "Warm opening slot, so a slow climb with tight key matching.", "duration_hours": 2, "curve": "slow",
            "peak_position": 85, "strictness": 1, "tempo_flex": 3, "selected_pool_ids": ["url:a"]}


def gig_llm(monkeypatch, reply, capture=None):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-gig-secret")

    def fake_post(url, headers=None, json=None, timeout=None):
        if capture is not None:
            capture.update(url=url, headers=headers, body=json)
        if isinstance(reply, Exception):
            raise reply
        text = reply if isinstance(reply, str) else globals()["json"].dumps(reply)
        return FakeResponse(payload={"content": [{"type": "text", "text": text}]})

    monkeypatch.setattr(app_module.requests, "post", fake_post)


def test_gig_llm_path(monkeypatch):
    sent = {}
    gig_llm(monkeypatch, "Sure!\n" + json.dumps(LLM_PLAN) + "\nHope this helps", capture=sent)
    status, plan = gig(OPENING_BRIEF)
    assert status == 200 and plan["source"] == "llm" and plan["note"] is None
    assert_valid_plan(plan)
    assert (plan["curve"], plan["peak_position"], plan["selected_pool_ids"]) == ("slow", 85, ["url:a"])
    assert sent["url"] == "https://api.anthropic.com/v1/messages" and sent["headers"]["x-api-key"] == "sk-gig-secret"
    msgs = sent["body"]["messages"]
    assert len(msgs) == 1 and msgs[0]["role"] == "user"
    assert json.loads(msgs[0]["content"]) == {
        "event": OPENING_BRIEF, "pools": [{"id": p["id"], "name": p["name"], "tracks": p["count"]} for p in GIG_POOLS]}
    assert OPENING_BRIEF not in sent["body"]["system"], "event text only travels as user data"
    assert "sk-gig-secret" not in json.dumps(plan)


def test_gig_llm_output_is_clamped_and_pool_names_are_mapped_to_ids(monkeypatch):
    gig_llm(monkeypatch, {**LLM_PLAN, "duration_hours": 9, "peak_position": 12, "strictness": 8, "tempo_flex": 0.4,
                          "curve": "Banger", "selected_pool_ids": ["latin tech", "url:a", "url:a", "ghost", 7, None]})
    status, plan = gig("some brief")
    assert plan["source"] == "llm"
    assert (plan["duration_hours"], plan["peak_position"], plan["strictness"], plan["tempo_flex"], plan["curve"]) == (4, 50, 3, 1, "banger")
    assert plan["selected_pool_ids"] == ["url:b", "url:a"]
    assert_valid_plan(plan)


@pytest.mark.parametrize("bad", [
    "no json here",
    {**LLM_PLAN, "curve": "zigzag"},
    {**LLM_PLAN, "duration_hours": "two"},
    {**LLM_PLAN, "peak_position": None},
    {**LLM_PLAN, "strictness": True},
    {**LLM_PLAN, "selected_pool_ids": ["ghost"]},
    {**LLM_PLAN, "selected_pool_ids": "url:a"},
    {**LLM_PLAN, "rationale": "   "},
    [1, 2, 3],
])
def test_bad_gig_llm_output_falls_back_to_the_local_engine(bad, monkeypatch):
    gig_llm(monkeypatch, bad if not isinstance(bad, list) else json.dumps(bad))
    status, plan = gig(OPENING_BRIEF)
    assert status == 200 and plan["source"] == "local" and plan["note"]
    assert plan["curve"] == "slow" and plan["selected_pool_ids"] == ["url:a"]
    assert_valid_plan(plan)


@pytest.mark.parametrize("failure", [
    app_module.requests.ConnectionError("offline"), app_module.requests.Timeout("slow"), RuntimeError("HTTP 529"),
])
def test_gig_llm_outage_never_breaks_the_demo(failure, monkeypatch):
    gig_llm(monkeypatch, failure)
    status, plan = gig(OPENING_BRIEF)
    assert status == 200 and plan["source"] == "local" and "paikallista päätösmoottoria" in plan["note"]
    assert_valid_plan(plan)

# ---------------------------------------------------------------------------
# Autonomous curation (/api/curate) and the built-in style pool
# ---------------------------------------------------------------------------

CURATE_BRIEF = "Dark hypnotic techno 130-140 BPM"
KNOWN_TAGS = {"techno", "rave", "tech", "melodic", "dnb", "latin", "house"}


def curate_call(brief, hours=2):
    try:
        return 200, app_module.curate(app_module.CurateRequest(brief=brief, duration_hours=hours))
    except HTTPException as e:
        return e.status_code, {"detail": e.detail}


def keys_of(tracks):
    return [app_module.track_key(t["artist"], t["title"]) for t in tracks]


def test_style_pool_is_rich_unique_and_well_formed():
    pool = app_module.CATALOG
    assert len(pool) >= 80
    assert len(set(keys_of(pool))) == len(pool), "no track twice in the pool"
    for t in pool:
        assert app_module.CAMELOT_RE.match(t["key"]) and 60 <= t["bpm"] <= 220 and 1 <= t["energy"] <= 5
        assert 90 <= t["duration"] <= 1200
        assert t["tags"] and t["tags"] <= KNOWN_TAGS
        assert "|" not in t["artist"] + t["title"]
    for tag in KNOWN_TAGS:
        assert sum(tag in t["tags"] for t in pool) >= 7, f"enough {tag} tracks"


def test_track_key_ignores_case_punctuation_and_edit_suffixes_but_not_remixes():
    k = app_module.track_key
    assert k("Kolter", "Trapped") == k("KOLTER", "Trapped - Radio-Edit") == k("kolter", "trapped (radio edit)") == k("Kolter", "Trapped (Extended Mix)")
    assert k("ARTBAT", "Return to Oz") != k("ARTBAT", "Return to Oz (Monolink Remix)")
    assert k("Dom Dolla", "Rhyme Dust") == k("Dom  Dolla", "Rhyme-Dust")


def test_curate_from_a_brief_alone_gives_unique_fitting_tracks():
    status, r = curate_call(CURATE_BRIEF)
    assert status == 200 and r["source"] == "local" and r["note"] is None
    tracks = r["tracks"]
    assert r["count"] == len(tracks) and 8 <= len(tracks) <= app_module.MAX_CANDIDATES
    assert len(set(keys_of(tracks))) == len(tracks), "unique tracks only"
    assert r["genres"] == ["techno"] and r["bpm_range"] == [130, 140]
    assert all(125 <= t["bpm"] <= 145 for t in tracks)
    assert all(app_module.CAMELOT_RE.match(t["key"]) and 1 <= t["energy"] <= 5 and t["duration"] for t in tracks)
    assert r["total_seconds"] == sum(t["duration"] for t in tracks) >= r["target_seconds"] == 7200
    assert r["shortfall"] is False
    centre = [abs(t["bpm"] - 135) for t in tracks]
    assert centre[:5] == sorted(centre[:5]) and min(centre) <= 1, "closest to the requested tempo first"


@pytest.mark.parametrize("brief,hours", [
    (CURATE_BRIEF, 1), (CURATE_BRIEF, 4), ("drum and bass 174", 1), ("drum and bass 174", 4), ("Latin tech house party", 3),
    ("melodic techno journey", 2), ("warm deep house sunset", 4), ("something completely different", 2), ("hard rave 150 bpm", 1),
    ("tehdään synkkä techno-setti", 2),
])
def test_curated_pool_never_repeats_a_track_to_fill_the_time(brief, hours):
    status, r = curate_call(brief, hours)
    assert status == 200
    assert len(set(keys_of(r["tracks"]))) == r["count"] >= 8
    assert r["total_seconds"] == sum(t["duration"] for t in r["tracks"])
    assert r["target_seconds"] == hours * 3600
    assert r["shortfall"] == (r["total_seconds"] < hours * 3600)


def test_curate_reports_a_shortfall_instead_of_padding():
    status, r = curate_call("drum and bass 174", 4)
    assert r["shortfall"] is True and r["total_seconds"] < 4 * 3600
    assert all(170 <= t["bpm"] <= 178 for t in r["tracks"][:10]), "the genre first, neighbours only after it"


def test_curate_input_validation():
    status, body = curate_call("  ?  ")
    assert status == 400 and "Kuvaile" in body["detail"]
    with pytest.raises(ValidationError):
        app_module.CurateRequest(brief="x" * 1001)
    for hours in (0, 5):
        with pytest.raises(ValidationError):
            app_module.CurateRequest(brief="techno", duration_hours=hours)


def test_curate_puts_claudes_picks_first_and_tops_up_from_the_pool_without_duplicates(monkeypatch):
    own = [{"artist": f"Claude Artist {i}", "title": f"Own Pick {i}", "bpm": 132 + i, "key": f"{5 + i % 3}A", "energy": 4, "duration": 330}
           for i in range(9)]
    own.append({"artist": "Charlotte de Witte", "title": "Doppler", "bpm": 140, "key": "5A", "energy": 4, "duration": 372})
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
    monkeypatch.setattr(app_module.requests, "post",
                        lambda *a, **k: FakeResponse(payload=llm_payload(tracks=own, tips=["t"] * 9)))
    status, r = curate_call(CURATE_BRIEF)
    assert status == 200 and r["source"] == "llm" and r["note"] is None
    assert [t["title"] for t in r["tracks"][:9]] == [f"Own Pick {i}" for i in range(9)]
    keys = keys_of(r["tracks"])
    assert len(set(keys)) == len(keys), "Claude's Doppler and the pool's Doppler are one track"
    assert keys.count(app_module.track_key("Charlotte de Witte", "Doppler")) == 1
    assert r["count"] > 10, "topped up from the style pool"


@pytest.mark.parametrize("failure", [
    _raise(app_module.requests.ConnectionError("offline")), lambda *a, **k: FakeResponse(status=529),
    lambda *a, **k: FakeResponse(payload={"content": [{"type": "text", "text": "nonsense"}]}),
])
def test_curate_survives_ai_outages_with_the_style_pool(failure, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
    monkeypatch.setattr(app_module.requests, "post", failure)
    status, r = curate_call(CURATE_BRIEF)
    assert status == 200 and r["source"] == "local" and "tyylipoolia" in r["note"]
    assert len(set(keys_of(r["tracks"]))) == r["count"] >= 8


@needs_node
def test_real_plan_and_curated_pool_land_in_the_ui(tmp_path):
    """The backend's gig plan and curated pool for a brief-only input are fed through the real page code."""
    status, plan = gig(CURATE_BRIEF, [])
    assert status == 200
    status, curated = curate_call(CURATE_BRIEF, plan["duration_hours"])
    assert status == 200
    f = tmp_path / "agent.json"
    f.write_text(json.dumps({"text": CURATE_BRIEF, "plan": plan, "curated": curated}), encoding="utf-8")
    res = subprocess.run(["node", "--test", "--test-name-pattern=backend plan and curated pool", "tests/frontend.test.mjs"],
                         cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
                         env={**os.environ, "HF_GIG_PLAN": str(f)})
    out = res.stdout + res.stderr
    assert res.returncode == 0, out[-3000:]
    assert "skipped 0" in out and "pass 1" in out, "the contract test must actually run"
