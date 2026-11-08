"""从 HTTP 接口验证固定测试集及批量任务。"""

import time
from collections import Counter
from pathlib import Path

from fastapi.testclient import TestClient

from backend.app import create_app


def test_fixed_cases_cover_all_scenarios(tmp_path: Path) -> None:
    """正式输入固定为 50 例，场景比例与规格一致。"""
    with TestClient(create_app(tmp_path / "config.local.json")) as client:
        response = client.get("/api/test-cases")
        assert response.status_code == 200
        data = response.json()
        assert data["version"] == "cases-v1"
        assert len(data["cases"]) == 50
        assert len({case["id"] for case in data["cases"]}) == 50
        assert Counter(case["input"]["scenario"] for case in data["cases"]) == {
            "greeting": 8,
            "recommendation": 9,
            "post_purchase": 8,
            "reactivation": 8,
            "event_invitation": 8,
            "price_objection": 9,
        }


def wait_for_batch(client: TestClient, batch_id: str) -> dict:
    """等待本机模拟模型完成，超时即报告运行问题。"""
    for _ in range(200):
        data = client.get(f"/api/batches/{batch_id}").json()
        if data["status"] != "running":
            return data
        time.sleep(0.05)
    raise AssertionError("批量任务未在 10 秒内完成")


def test_batch_keeps_partial_failures_and_fixed_model(
    tmp_path: Path, model_server: str
) -> None:
    """一例模型失败不丢失其他结果，批次不受后续配置改动影响。"""
    path = tmp_path / "config.local.json"
    with TestClient(create_app(path)) as client:
        client.put(
            "/api/settings",
            json={
                "base_url": model_server,
                "model": "batch-mixed",
                "api_key": "sk-fictional-test-key",
            },
        ).raise_for_status()
        response = client.post("/api/batches")
        assert response.status_code == 202
        batch_id = response.json()["id"]
        assert "sk-fictional-test-key" not in response.text
        client.put(
            "/api/settings",
            json={
                "base_url": model_server,
                "model": "invalid-json",
                "api_key": "",
            },
        ).raise_for_status()
        batch = wait_for_batch(client, batch_id)
        assert batch["status"] == "completed"
        assert len(batch["items"]) == 50
        assert Counter(item["status"] for item in batch["items"]) == {
            "generated": 49,
            "failed": 1,
        }
        first = client.get(f"/api/history/{batch['items'][0]['run_id']}").json()
        assert first["model"] == "batch-mixed"
        assert first["prompt_version"] == "v2"
        assert first["brand_rules"] == batch["brand_rules"]
        failed = next(item for item in batch["items"] if item["status"] == "failed")
        assert "三条独立" in failed["error"]

    with TestClient(create_app(path)) as restarted:
        assert restarted.get(f"/api/batches/{batch_id}").json() == batch
        assert restarted.get(f"/api/history/{first['id']}").json() == first


def test_batch_requires_saved_key(tmp_path: Path) -> None:
    """配置缺失时不启动伪造的批量运行。"""
    with TestClient(create_app(tmp_path / "config.local.json")) as client:
        response = client.post("/api/batches")
        assert response.status_code == 422
        assert "API Key" in response.json()["detail"]
        assert client.get("/api/batches").json() == []


def test_shutdown_keeps_completed_cases_and_marks_interrupted(
    tmp_path: Path, model_server: str
) -> None:
    """服务停止时保留已完成案例，不留下永久运行中的假状态。"""
    path = tmp_path / "config.local.json"
    with TestClient(create_app(path)) as client:
        client.put(
            "/api/settings",
            json={
                "base_url": model_server,
                "model": "batch-slow",
                "api_key": "sk-fictional-test-key",
            },
        ).raise_for_status()
        batch_id = client.post("/api/batches").json()["id"]
        for _ in range(200):
            batch = client.get(f"/api/batches/{batch_id}").json()
            if batch["items"]:
                break
            time.sleep(0.01)
        assert 0 < len(batch["items"]) < 50
        assert client.post("/api/batches").status_code == 409
    with TestClient(create_app(path)) as restarted:
        saved = restarted.get(f"/api/batches/{batch_id}").json()
        assert saved["status"] == "interrupted"
        assert len(saved["items"]) >= len(batch["items"])
        assert (
            restarted.get(f"/api/history/{saved['items'][0]['run_id']}").status_code
            == 200
        )
