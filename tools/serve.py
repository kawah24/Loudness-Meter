"""Serves the meter on http://127.0.0.1:8787 so live input works.

Started hidden by launch.vbs. Exits by itself after 15 idle minutes, and exits
immediately if the port is already taken (another instance is running).
"""
import http.server
import os
import socketserver
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8787
IDLE_TIMEOUT = 15 * 60

last_hit = [time.time()]


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        last_hit[0] = time.time()
        if self.path in ("", "/"):
            self.send_response(302)
            self.send_header("Location", "/LoudnessMeter.html")
            self.end_headers()
            return
        super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def watchdog():
    while True:
        time.sleep(20)
        if time.time() - last_hit[0] > IDLE_TIMEOUT:
            os._exit(0)


def main():
    try:
        httpd = Server(
            ("127.0.0.1", PORT),
            lambda *a, **k: Handler(*a, directory=ROOT, **k),
        )
    except OSError:
        return  # port busy: an instance is already serving
    threading.Thread(target=watchdog, daemon=True).start()
    httpd.serve_forever()


if __name__ == "__main__":
    main()
