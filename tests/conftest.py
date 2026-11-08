"""外部模型 HTTP 测试替身。"""

import json
import time
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

import pytest


@pytest.fixture
def model_server() -> Iterator[str]:
    """用本机 HTTP 服务替代外部模型，不替换内部实现。"""

    calls = 0

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            nonlocal calls
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if self.path != "/chat/completions":
                self.send_error(404)
                return
            if self.headers.get("Authorization") != "Bearer sk-fictional-test-key":
                self.send_error(401)
                return
            if payload["model"] == "html-model":
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(b"<html><body>Not a model API</body></html>")
                return
            if payload["model"] not in {
                "fixture-model",
                "two-candidates",
                "invalid-json",
                "batch-mixed",
                "batch-slow",
                "judge-fixture",
                "judge-invalid",
                "judge-bad-quote",
                "judge-pass",
            }:
                self.send_error(404)
                return
            content = "连接正常"
            if payload.get("response_format"):
                if payload["model"] == "batch-slow":
                    time.sleep(0.04)
                calls += 1
                candidates = [
                    "您好，您偏爱轻便款式，轻舟斜挎包可供您参考。",
                    "您好，结合日常出行需求，想请您看看轻舟斜挎包。",
                    "您好，若您方便，我们可以先聊聊您对随身包容量的期待。",
                ]
                if payload["model"] == "two-candidates" or (
                    payload["model"] == "batch-mixed" and calls == 2
                ):
                    candidates = candidates[:2]
                content = json.dumps({"messages": candidates}, ensure_ascii=False)
                if payload["model"] == "invalid-json":
                    content = "这是一段非 JSON 内容"
                if payload["model"].startswith("judge-"):
                    candidate = {
                        "index": 1,
                        "scores": {
                            "personalization": 5,
                            "brand": 5,
                            "scenario": 5,
                            "naturalness": 5,
                        },
                        "independent": True,
                        "needs_review": False,
                        "reason": "模拟评审，按实际输入核对。",
                        "violations": [
                            {
                                "kind": "contact",
                                "quote": "停止主动"
                                if payload["model"] == "judge-bad-quote"
                                else "尊重您的意愿",
                                "reason": "虚构违规用于测试高分不可抵消。",
                                "basis": "测试校准夹具，不是实际质量判断。",
                            }
                        ],
                    }
                    verdict = {
                        "candidates": [
                            candidate,
                            {**candidate, "index": 2, "violations": []},
                            {
                                **candidate,
                                "index": 3,
                                "violations": [],
                                "needs_review": True,
                            },
                        ],
                        "diversity": 5,
                        "diversity_needs_review": False,
                        "diversity_reason": "模拟三个切入点。",
                    }
                    if payload["model"] == "judge-pass":
                        for item in verdict["candidates"]:
                            item["violations"] = []
                            item["needs_review"] = False
                    content = (
                        "非 JSON"
                        if payload["model"] == "judge-invalid"
                        else json.dumps(verdict, ensure_ascii=False)
                    )
            response = {
                "id": "test-completion",
                "object": "chat.completion",
                "created": 1,
                "model": "fixture-model",
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {
                            "role": "assistant",
                            "content": content,
                        },
                    }
                ],
            }
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(response).encode())

        def log_message(self, format: str, *args: object) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
