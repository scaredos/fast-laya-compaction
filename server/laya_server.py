#!/usr/bin/env python3
"""Local Laya scoring server, speaking the same wire format fast-*-compaction
already sends: POST {state, questions, model?} -> {answers, routing}.

The plugin's JevAsker posts to this instead of a paid API. Laya runs locally,
so there is no key and no per-input cost. Load the checkpoints once (preload),
keep them resident, answer over HTTP.

    pip install laya
    python server/laya_server.py            # 127.0.0.1:8756
    LAYA_PORT=9000 python server/laya_server.py

Point the plugin at it with LAYA_URL (default http://127.0.0.1:8756/predict).
"""
import json
import os
import time
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CHECKPOINTS = {"english", "multilingual", "typed-decisions"}

# ponytail: one global lock serializes predict() so concurrent compaction
# requests can't drive one model instance at once. A T4 does 100-330 q/s, and
# compaction fires a handful of requests, so serial is fine. Swap for a real
# request queue with dynamic batching only if throughput ever matters.
_lock = threading.Lock()
_router = None


def pick_device() -> str:
    """LAYA_DEVICE if set, else CUDA when it's actually usable, else CPU."""
    override = os.environ.get("LAYA_DEVICE")
    if override:
        return override
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda"
    except Exception:
        pass
    return "cpu"


def get_router():
    global _router
    if _router is None:
        from laya import Router
        # max_loaded=3 keeps English + multilingual + typed-decisions resident so
        # the router never pays the 7-10s checkpoint reload mid-session.
        device = pick_device()
        try:
            _router = Router(preload=True, device=device, max_loaded=3)
        except Exception as exc:
            if device == "cpu":
                raise
            print(f"laya: {device} failed ({exc}); falling back to cpu", flush=True)
            device = "cpu"
            _router = Router(preload=True, device=device, max_loaded=3)
        print(f"laya loaded on {device}", flush=True)
    return _router


def predict(body: dict) -> dict:
    state = body.get("state")
    questions = body.get("questions")
    if not isinstance(questions, dict) or not questions:
        raise ValueError("request has no questions")
    model = body.get("model")
    router = get_router()
    with _lock:
        if model in CHECKPOINTS:
            return router.predict(state, questions, model=model)
        return router.predict(state, questions)  # auto-route by language/script


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, payload: dict) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._send(200, {"ok": True, "service": "laya"})

    def do_POST(self):
        length = int(self.headers.get("content-length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        started = time.time()
        try:
            body = json.loads(raw or b"{}")
            result = predict(body)
        except Exception as exc:  # plugin treats any error as "fall back to built-in summary"
            self._send(500, {"error": str(exc)})
            self.log_message("predict FAILED after %d ms: %s", (time.time() - started) * 1000, exc)
            return
        self._send(200, result)
        self.log_message(
            "predict ok: %d question(s), %s input tokens, %d ms",
            len(body.get("questions") or {}),
            (result.get("usage") or {}).get("input_tokens", "?"),
            (time.time() - started) * 1000,
        )

    def log_message(self, fmt, *args):  # one line per request, for checking what the plugin sent
        print("%s %s" % (time.strftime("%H:%M:%S"), fmt % args), flush=True)


def main():
    port = int(os.environ.get("LAYA_PORT", "8756"))
    print(f"loading Laya checkpoints (preload)...", flush=True)
    get_router()  # fail fast if laya/torch/model is missing, before we bind
    # The plugin opens `concurrency` connections at once; the stdlib default
    # backlog of 5 makes Windows refuse the overflow instead of queueing it.
    ThreadingHTTPServer.request_queue_size = 64
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"laya server on http://127.0.0.1:{port}/predict", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    sys.exit(main())
