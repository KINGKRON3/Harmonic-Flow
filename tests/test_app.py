import json
import os
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
