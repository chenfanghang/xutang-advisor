"""自动评测 HTTP 行为，调用真实 DeepEval 与模拟外部评审服务。"""

import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path
from threading import Barrier, BrokenBarrierError, Thread
from urllib.request import Request, urlopen

from fastapi.testclient import TestClient
from openpyxl import load_workbook

from backend.app import create_app
from backend.schemas import RunRecord
from backend.store import Store


def run_id(client: TestClient) -> str:
    result = client.post(
        "/api/generate",
        json={
            "scenario": "reactivation",
            "client_information": "虚构客户，刚要求停止联系。",
            "contact_status": "just_refused",
        },
    )
    result.raise_for_status()
    return result.json()["id"]


def wait_for_experiment(client: TestClient, identifier: str) -> dict:
    for _ in range(200):
        response = client.get(f"/api/judge-experiments/{identifier}")
        response.raise_for_status()
        data = response.json()
        if data["status"] != "running":
            return data
        time.sleep(0.02)
    raise AssertionError("自动评测未在测试时限内完成")


def test_deepeval_records_rules_evidence_and_hard_fail_without_overwriting(
    tmp_path: Path,
    model_server: str,
):
    path = tmp_path / "config.local.json"
    with TestClient(create_app(path)) as client:
        identifier = run_id(client)
        client.put(
            "/api/settings",
            json={
                "base_url": model_server,
                "model": "fixture-model",
                "api_key": "sk-fictional-test-key",
            },
        ).raise_for_status()
        before = client.get(f"/api/history/{identifier}").json()
        start = client.post(
            "/api/judge-experiments",
            json={
                "run_ids": [identifier],
                "judge_model": "judge-fixture",
            },
        )
        assert start.status_code == 202
        experiment = wait_for_experiment(client, start.json()["id"])
        assert experiment["status"] == "completed"
        assert experiment["framework_version"] == "4.3.3"
        assert experiment["calibrated"] is False
        item = experiment["items"][0]
        assert item["status"] == "reviewed"
        assert all(check["passed"] for check in item["rules"])
        assert item["verdict"]["candidates"][0]["violations"]
        assert (
            item["framework_result"]["test_results"][0]["metrics_data"][0]["score"] == 0
        )
        assert "sk-fictional-test-key" not in str(experiment)
        assert client.get(f"/api/history/{identifier}").json() == before
        assert client.get("/api/evaluation").json()["evaluations"] == []
        assert client.get("/api/settings").json()["model"] == "fixture-model"
        summary = client.get(
            f"/api/judge-experiments/{experiment['id']}/summary"
        ).json()
        assert summary["passed_messages"] == 1
        assert summary["pending_messages"] == 1
        assert summary["failed_messages"] == 1
        assert summary["qualified_groups"] == 0
        assert summary["human_compared_messages"] == 0
        client.put(
            f"/api/history/{identifier}/evaluation",
            json={
                "source": "human",
                "candidates": [
                    {"passed": True, "reason": "测试人工标签"},
                    {"passed": False, "reason": "测试人工标签不通过"},
                    {"passed": True, "reason": "测试人工标签"},
                ],
                "distinct": True,
            },
        ).raise_for_status()
        compared = client.get(
            f"/api/judge-experiments/{experiment['id']}/summary"
        ).json()
        assert compared["human_compared_messages"] == 2
        assert compared["false_acceptances"] == 1
        assert compared["false_rejections"] == 1
    with TestClient(create_app(path)) as client:
        assert (
            client.get(f"/api/judge-experiments/{experiment['id']}").json()
            == experiment
        )
        export = client.get(f"/api/judge-experiments/{experiment['id']}/export.xlsx")
        export.raise_for_status()
        workbook = load_workbook(BytesIO(export.content))
        assert "评审证据" in workbook.sheetnames
        assert workbook["评审证据"].max_row == 4
        assert "sk-fictional-test-key" not in str(
            [list(sheet.values) for sheet in workbook]
        )


def test_invalid_judge_json_is_execution_error_and_repeats_are_kept(
    tmp_path: Path,
    model_server: str,
):
    with TestClient(create_app(tmp_path / "config.local.json")) as client:
        identifier = run_id(client)
        client.put(
            "/api/settings",
            json={
                "base_url": model_server,
                "model": "fixture-model",
                "api_key": "sk-fictional-test-key",
            },
        ).raise_for_status()
        for model in ("judge-invalid", "judge-bad-quote"):
            started = client.post(
                "/api/judge-experiments",
                json={
                    "run_ids": [identifier],
                    "judge_model": model,
                    "repetitions": 3,
                },
            )
            started.raise_for_status()
            experiment = wait_for_experiment(client, started.json()["id"])
            assert len(experiment["items"]) == 3
            assert all(
                item["status"] == "error" and item["verdict"] is None
                for item in experiment["items"]
            )
            summary = client.get(
                f"/api/judge-experiments/{experiment['id']}/summary"
            ).json()
            assert summary["evaluation_errors"] == 3
            assert summary["failed_messages"] == 0
            assert summary["unreviewed_messages"] == 9


def test_judge_rejects_missing_credentials_or_records_and_skips_stopped(
    tmp_path: Path, model_server: str
):
    with TestClient(create_app(tmp_path / "config.local.json")) as client:
        identifier = run_id(client)
        assert (
            client.post(
                "/api/judge-experiments", json={"run_ids": [identifier]}
            ).status_code
            == 422
        )
        client.put(
            "/api/settings",
            json={
                "base_url": model_server,
                "model": "fixture-model",
                "api_key": "sk-fictional-test-key",
            },
        ).raise_for_status()
        assert (
            client.post(
                "/api/judge-experiments", json={"run_ids": ["missing"]}
            ).status_code
            == 404
        )
        stopped = client.post(
            "/api/generate",
            json={
                "scenario": "reactivation",
                "client_information": "虚构客户",
                "contact_status": "do_not_contact",
            },
        ).json()
        started = client.post(
            "/api/judge-experiments", json={"run_ids": [stopped["id"]]}
        ).json()
        experiment = wait_for_experiment(client, started["id"])
        assert experiment["items"][0]["status"] == "skipped"
        assert experiment["items"][0]["verdict"] is None


def test_valid_results_can_pass_and_repeated_trials_are_not_independent_cases(
    tmp_path: Path,
    model_server: str,
):
    with TestClient(create_app(tmp_path / "config.local.json")) as client:
        identifier = run_id(client)
        baseline = RunRecord.model_validate(
            client.get(f"/api/history/{identifier}").json()
        ).model_copy(update={"id": "baseline-example", "prompt_version": "v1"})
        Store(tmp_path / "xutang.sqlite3").save_run(baseline)
        client.put(
            "/api/settings",
            json={
                "base_url": model_server,
                "model": "fixture-model",
                "api_key": "sk-fictional-test-key",
            },
        ).raise_for_status()
        started = client.post(
            "/api/judge-experiments",
            json={
                "run_ids": [identifier, baseline.id],
                "judge_model": "judge-pass",
                "repetitions": 3,
            },
        )
        started.raise_for_status()
        experiment = wait_for_experiment(client, started.json()["id"])
        assert len(experiment["items"]) == 6
        assert all(
            item["framework_result"]["test_results"][0]["metrics_data"][0]["score"] == 1
            for item in experiment["items"]
        )
        summary = client.get(
            f"/api/judge-experiments/{experiment['id']}/summary"
        ).json()
        assert summary["passed_messages"] == 18
        assert summary["qualified_groups"] == 6
        assert summary["repeated_cases"] == 2
        assert summary["consistent_cases"] == 2
        assert summary["by_version"]["v1"]["qualified_groups"] == 3
        assert summary["by_version"]["v2"]["qualified_groups"] == 3


def test_resume_runs_three_requests_concurrently_without_overwriting_completed(
    tmp_path: Path,
    model_server: str,
):
    barrier = Barrier(3, timeout=8)

    class Proxy(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers["Content-Length"]))
            try:
                barrier.wait()
            except BrokenBarrierError:
                self.send_error(503)
                return
            request = Request(
                model_server + self.path,
                data=body,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": self.headers["Authorization"],
                },
                method="POST",
            )
            with urlopen(request, timeout=5) as response:
                data = response.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, format, *args):
            pass

    proxy = ThreadingHTTPServer(("127.0.0.1", 0), Proxy)
    thread = Thread(target=proxy.serve_forever, daemon=True)
    thread.start()
    path = tmp_path / "config.local.json"
    try:
        with TestClient(create_app(path)) as client:
            identifiers = [run_id(client) for _ in range(4)]
            client.put(
                "/api/settings",
                json={
                    "base_url": f"http://127.0.0.1:{proxy.server_port}",
                    "model": "fixture-model",
                    "api_key": "sk-fictional-test-key",
                },
            ).raise_for_status()
            store = Store(tmp_path / "xutang.sqlite3")
            from datetime import UTC, datetime

            from backend.judge_schemas import JudgeExperiment, JudgeItem

            experiment = JudgeExperiment(
                id="resume-test",
                created_at=datetime.now(UTC),
                status="interrupted",
                run_ids=identifiers,
                judge_model="judge-pass",
                base_url=f"http://127.0.0.1:{proxy.server_port}",
                repetitions=1,
                rubric_version="judge-v1",
                rubric="规则",
                framework_version="4.3.3",
                items=[
                    JudgeItem(
                        run_id=identifiers[0],
                        trial=1,
                        status="error",
                        rules=[],
                        error="已保存错误",
                    )
                ],
            )
            store.save_experiment(experiment)
            response = client.post("/api/judge-experiments/resume-test/resume")
            assert response.status_code == 202
            finished = wait_for_experiment(client, "resume-test")
            assert finished["status"] == "completed"
            assert len(finished["items"]) == 4
            assert finished["items"][0]["error"] == "已保存错误"
            assert {item["run_id"] for item in finished["items"][1:]} == set(
                identifiers[1:]
            )
            assert all(item["status"] == "reviewed" for item in finished["items"][1:])
            assert all(
                item["run_id"] == item["framework_result"]["test_results"][0]["name"]
                for item in finished["items"][1:]
            )
    finally:
        proxy.shutdown()
        proxy.server_close()
        thread.join()
