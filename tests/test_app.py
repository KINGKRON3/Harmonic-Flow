import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest
from fastapi import HTTPException

import app as app_module

ROOT = Path(__file__).resolve().parent.parent
PLAYLIST_URL = "https://open.spotify.com/playlist/2Mg5wgO65IZ0aOdh2hlg8S"


def post(url):
    """Calls the /api/fetch-playlist handler directly -> (status, body)."""
    try:
        return 200, app_module.fetch_playlist(app_module.PlaylistRequest(url=url))
    except HTTPException as e:
        return e.status_code, {"detail": e.detail}


def embed_html(track_list):
    data = {"props": {"pageProps": {"state": {"data": {"entity": {"name": "Test", "trackList": track_list}}}}}}
    return f'<html><script id="__NEXT_DATA__" type="application/json">{json.dumps(data)}</script></html>'


class FakeResponse:
    def __init__(self, text, status=200):
        self.text, self.status_code = text, status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


def test_health():
    assert app_module.health() == {"status": "online"}


def test_parse_spotify_embed_normalizes_artists():
    html = embed_html([
        {"title": "Breather", "subtitle": "CHRIS STASSY, S.A.M."},
        {"title": "", "subtitle": "Skipped"},
        {"title": "No Artist"},
    ])
    assert app_module.parse_spotify_embed(html) == [
        "CHRIS STASSY, S.A.M. - Breather",
        "Unknown - No Artist",
    ]


def test_parse_spotify_embed_without_data_raises():
    with pytest.raises(ValueError):
        app_module.parse_spotify_embed("<html></html>")


def test_spotify_endpoint_with_mocked_embed(monkeypatch):
    seen = {}

    def fake_get(url, **kwargs):
        seen["url"] = url
        return FakeResponse(embed_html([{"title": "Shinjuku", "subtitle": "Franky Rizardo"}]))

    monkeypatch.setattr(app_module.requests, "get", fake_get)
    status, body = post(PLAYLIST_URL + "?si=abc123")
    assert status == 200
    assert body == {"tracks": ["Franky Rizardo - Shinjuku"], "count": 1}
    assert seen["url"] == "https://open.spotify.com/embed/playlist/2Mg5wgO65IZ0aOdh2hlg8S"


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


@pytest.mark.skipif(os.environ.get("HF_OFFLINE") == "1", reason="network test disabled")
def test_live_spotify_playlist():
    """Fetches the real playlist from Spotify (set HF_OFFLINE=1 to skip)."""
    status, body = post(PLAYLIST_URL)
    assert status == 200, body
    assert body["count"] == len(body["tracks"]) > 0
    assert "Robbie Doherty - Call It What You Like" in body["tracks"]
    assert all(" - " in t for t in body["tracks"])


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_frontend_loader_and_rekordbox_export():
    """Runs tests/frontend.test.mjs (loader visibility + Rekordbox hot cues)."""
    res = subprocess.run(
        ["node", "--test", "tests/frontend.test.mjs"],
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
    )
    assert res.returncode == 0, res.stdout + res.stderr
