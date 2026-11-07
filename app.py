import json
import os
import re
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn
import yt_dlp
import requests

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class PlaylistRequest(BaseModel):
    url: str

def clean_track_name(raw_title):
    title = re.sub(r'\[.*?\]|\(.*?\)', '', raw_title)
    title = re.sub(r'(?i)\b(official video|official audio|music video|lyric video|hd|4k)\b', '', title)
    return title.strip()

SPOTIFY_PLAYLIST_RE = re.compile(r'playlist/([a-zA-Z0-9]{22})')
NEXT_DATA_RE = re.compile(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', re.S)

def parse_spotify_embed(html):
    """Poimii raidat Spotifyn embed-sivun __NEXT_DATA__-JSONista muotoon 'Artisti - Nimi'."""
    m = NEXT_DATA_RE.search(html)
    if not m:
        raise ValueError("Spotifyn embed-sivulta ei löytynyt raitadataa.")
    entity = json.loads(m.group(1))["props"]["pageProps"]["state"]["data"]["entity"]
    tracks = []
    for t in entity.get("trackList", []):
        title = (t.get("title") or "").strip()
        if not title:
            continue
        artist = re.sub(r'\s+', ' ', (t.get("subtitle") or "Unknown").replace(" ", " ")).strip()
        tracks.append(f"{artist} - {title}")
    return tracks

def fetch_spotify_playlist(playlist_id):
    # Anonyymi get_access_token-endpoint palauttaa nykyään 403, joten luetaan
    # julkisen soittolistan embed-sivu, joka ei vaadi kirjautumista.
    resp = requests.get(
        f"https://open.spotify.com/embed/playlist/{playlist_id}",
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9",
        },
        timeout=10,
    )
    resp.raise_for_status()
    return parse_spotify_embed(resp.text)

@app.get("/")
def serve_index():
    if os.path.exists("index.html"):
        return FileResponse("index.html")
    return {"status": "ok", "message": "HarmonicFlow API running. Place index.html here."}

@app.get("/api/health")
def health():
    return {"status": "online"}

@app.post("/api/fetch-playlist")
def fetch_playlist(req: PlaylistRequest):
    url = req.url.strip()
    tracks = []
    
    if "youtube.com" in url or "youtu.be" in url or "soundcloud.com" in url:
        ydl_opts = {
            'extract_flat': 'in_playlist',
            'skip_download': True,
            'quiet': True,
        }
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
                entries = info.get('entries', [])
                if not entries:
                    entries = [info]
                    
                for e in entries:
                    if not e:
                        continue
                    raw_title = e.get('title', 'Unknown')
                    artist = e.get('uploader') or e.get('channel') or 'Unknown'
                    cleaned = clean_track_name(raw_title)
                    tracks.append(f"{artist} - {cleaned}")
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Virhe linkin purkamisessa: {str(e)}")

    elif "spotify.com" in url:
        pl_match = SPOTIFY_PLAYLIST_RE.search(url)
        if not pl_match:
            raise HTTPException(status_code=400, detail="Virheellinen Spotify-soittolistan linkki.")
        try:
            tracks = fetch_spotify_playlist(pl_match.group(1))
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Virhe Spotifyn haussa: {e}")
        if not tracks:
            raise HTTPException(status_code=400, detail="Spotifyn soittolistaa ei saatu luettua. Varmista, että soittolista on julkinen.")

    else:
        raise HTTPException(status_code=400, detail="Tuettuina ovat vain YouTube, SoundCloud ja julkiset Spotify-linkit.")

    return {"tracks": tracks, "count": len(tracks)}

if __name__ == "__main__":
    print("HarmonicFlow palvelin käynnistyy porttiin 5000...")
    uvicorn.run("app:app", host="127.0.0.1", port=5000, reload=True)