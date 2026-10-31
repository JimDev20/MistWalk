#!/usr/bin/env python3
"""MistWalk local server.

Geolocation is only granted to secure contexts. http://localhost and
http://127.0.0.1 count as secure, so this little server is enough for live GPS
on the same computer. A phone needs an HTTPS host (or a trusted local tunnel).
"""

from __future__ import annotations

import argparse
import functools
import http.server
import os
import socket
import socketserver
import sys
import threading
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".webmanifest": "application/manifest+json",
        ".json": "application/json",
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2",
    }

    def end_headers(self) -> None:
        # Development-friendly: never let a stale HTML shell hide a code change.
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("  %s\n" % (fmt % args))


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def local_ip() -> str:
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("8.8.8.8", 80))
        ip = probe.getsockname()[0]
        probe.close()
        return ip
    except OSError:
        return "127.0.0.1"


def main() -> int:
    parser = argparse.ArgumentParser(description="Serve MistWalk locally.")
    parser.add_argument("--port", type=int, default=4173, help="port (default: 4173)")
    parser.add_argument("--host", default="127.0.0.1", help="bind address (default: localhost only)")
    parser.add_argument("--open", action="store_true", help="open the default browser")
    parser.add_argument("--lan", action="store_true", help="also listen on your local network")
    args = parser.parse_args()

    os.chdir(ROOT)
    host = "0.0.0.0" if args.lan else args.host
    url = f"http://{'127.0.0.1' if host == '0.0.0.0' else host}:{args.port}/"

    handler = functools.partial(Handler, directory=ROOT)
    with ThreadingServer((host, args.port), handler) as httpd:
        print()
        print("  MISTWALK  /  local exploration system")
        print("  ------------------------------------")
        print(f"  Open:      {url}")
        if args.lan:
            print(f"  Phone LAN: http://{local_ip()}:{args.port}/  (GPS needs HTTPS on phones)")
        print("  Stop:      Ctrl+C")
        print()
        if args.open:
            threading.Timer(0.7, lambda: webbrowser.open(url)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n  MistWalk stopped. Your tiles are saved in the browser.\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
