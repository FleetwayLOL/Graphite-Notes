#!/usr/bin/env python3
"""
Live Preview & Portable Storage HTTP Server for Graphite.
Binds to 0.0.0.0:8080, persists notes to PortableData/notes_storage.json,
and provides CORS-free internet theme search & image proxy (/api/net-search, /api/net-image).
"""

import json
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HTML_FILE = ROOT / "Graphite.html"
DATA_DIR = ROOT / "Graphite-Windows-Portable" / "PortableData"
DB_FILE = DATA_DIR / "notes_storage.json"

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _send_common_headers(self, status: int, content_type: str, length: int):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_OPTIONS(self):
        self._send_common_headers(204, "text/plain; charset=utf-8", 0)

    def do_GET(self):
        parsed_url = urllib.parse.urlsplit(self.path)
        path = parsed_url.path
        qs = urllib.parse.parse_qs(parsed_url.query)

        if path == "/api/storage":
            body = DB_FILE.read_bytes() if DB_FILE.exists() else b"{}"
            self._send_common_headers(200, "application/json; charset=utf-8", len(body))
            self.wfile.write(body)
            return

        if path == "/api/pending-files":
            body = b"[]"
            self._send_common_headers(200, "application/json; charset=utf-8", len(body))
            self.wfile.write(body)
            return

        if path == "/api/net-search":
            q = (qs.get("q", [""])[0] or "Sonic the Hedgehog").strip()
            mode = (qs.get("mode", ["hd"])[0] or "hd").strip()
            if mode == "any":
                api_url = (
                    "https://wallhaven.cc/api/v1/search?q="
                    + urllib.parse.quote_plus(q)
                    + "&purity=100&sorting=relevance"
                )
            else:
                api_url = (
                    "https://wallhaven.cc/api/v1/search?q="
                    + urllib.parse.quote_plus(q)
                    + "&purity=100&atleast=1920x1080&ratios=16x9,16x10&sorting=favorites"
                )
            try:
                req = urllib.request.Request(api_url, headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=15) as r:
                    body = r.read(4 * 1024 * 1024)
                self._send_common_headers(200, "application/json; charset=utf-8", len(body))
                self.wfile.write(body)
            except Exception:
                err = b'{"data":[]}'
                self._send_common_headers(502, "application/json; charset=utf-8", len(err))
                self.wfile.write(err)
            return

        if path == "/api/net-image":
            target = (qs.get("url", [""])[0] or "").strip()
            if not (target.startswith("http://") or target.startswith("https://")):
                msg = b"Invalid URL"
                self._send_common_headers(400, "text/plain; charset=utf-8", len(msg))
                self.wfile.write(msg)
                return
            try:
                req = urllib.request.Request(
                    target,
                    headers={"User-Agent": UA, "Accept": "image/webp,image/apng,image/*,application/json,*/*;q=0.8"},
                )
                with urllib.request.urlopen(req, timeout=18) as r:
                    ct = r.headers.get("Content-Type", "application/octet-stream")
                    body = r.read(16 * 1024 * 1024)
                self._send_common_headers(200, ct, len(body))
                self.wfile.write(body)
            except Exception:
                msg = b"Failed to download image"
                self._send_common_headers(502, "text/plain; charset=utf-8", len(msg))
                self.wfile.write(msg)
            return

        body = HTML_FILE.read_bytes()
        self._send_common_headers(200, "text/html; charset=utf-8", len(body))
        self.wfile.write(body)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/storage":
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length > 0 else b""
            try:
                parsed = json.loads(raw.decode("utf-8"))
                if isinstance(parsed, dict):
                    DATA_DIR.mkdir(parents=True, exist_ok=True)
                    tmp = DB_FILE.with_suffix(".tmp")
                    tmp.write_text(json.dumps(parsed, ensure_ascii=False, indent=2), encoding="utf-8")
                    tmp.replace(DB_FILE)
                    resp = b'{"ok":true}'
                    self._send_common_headers(200, "application/json; charset=utf-8", len(resp))
                    self.wfile.write(resp)
                    return
            except Exception:
                pass
            resp = b'{"ok":false}'
            self._send_common_headers(400, "application/json; charset=utf-8", len(resp))
            self.wfile.write(resp)
            return

        self._send_common_headers(404, "text/plain; charset=utf-8", 9)
        self.wfile.write(b"Not Found")


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", 8080), Handler)
    print("Graphite Live Server listening on http://0.0.0.0:8080", flush=True)
    server.serve_forever()
