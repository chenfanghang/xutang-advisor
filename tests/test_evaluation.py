"""评估、筛选、同输入比较与 Excel 的 HTTP 行为。"""

from io import BytesIO
from pathlib import Path

from fastapi.testclient import TestClient
from openpyxl import load_workbook

from backend.app import create_app
from backend.schemas import BatchItem, BatchRun, RunRecord
from backend.schemas import TestCase as Case
from backend.store import Store


def generate(client: TestClient, name: str = "虚构客户") -> dict:
    """规则分支返回三条真实规则输出，避免依赖外部模型。"""
    response = client.post(
        "/api/generate",
        json={
            "scenario": "reactivation",
            "client_information": name,
            "contact_status": "just_refused",
        },
    )
    response.raise_for_status()
    return response.json()


def evaluation(*, source: str = "human", third: bool | None = None) -> dict:
    return {
        "source": source,
        "candidates": [
            {"passed": True, "reason": "尊重拒联"},
            {"passed": False, "reason": "表达生硬"},
            {"passed": third, "reason": ""},
        ],
        "distinct": None,
        "distinct_reason": "",
        "notes": "人工阅读后录入",
    }


def test_reviews_are_separate_persisted_and_unreviewed_not_passed(tmp_path: Path):
    path = tmp_path / "config.local.json"
    with TestClient(create_app(path)) as client:
        run = generate(client)
        generate(client, "另一个虚构客户")
        empty = client.get("/api/evaluation").json()
        assert empty["summary"]["human"]["passed_messages"] == 0
        assert empty["summary"]["human"]["unreviewed_messages"] == 6
        saved = client.put(f"/api/history/{run['id']}/evaluation", json=evaluation())
        assert saved.status_code == 200
        ai = evaluation(source="ai", third=True)
        ai["candidates"] = [{"passed": True, "reason": ""}] * 3
        ai["distinct"] = True
        client.put(f"/api/history/{run['id']}/evaluation", json=ai).raise_for_status()
    with TestClient(create_app(path)) as client:
        view = client.get("/api/evaluation").json()
        assert len(view["evaluations"]) == 2
        human, ai_summary = view["summary"]["human"], view["summary"]["ai"]
        assert human["passed_messages"] == 1
        assert human["reviewed_messages"] == 2
        assert human["unreviewed_messages"] == 4
        assert human["usable_cases"] == 1
        assert human["qualified_groups"] == 0
        assert ai_summary["qualified_groups"] == 1
        assert view["summary"]["generated"] == 2
        assert client.get(f"/api/history/{run['id']}").json() == run
        changed = {
            **ai,
            "source": "human",
            "distinct": False,
            "distinct_reason": "三条切入点重复",
        }
        client.put(
            f"/api/history/{run['id']}/evaluation", json=changed
        ).raise_for_status()
        revised = client.get("/api/evaluation").json()["summary"]
        assert revised["human"]["passed_messages"] == 3
        assert revised["human"]["qualified_groups"] == 0
        assert revised["ai"]["qualified_groups"] == 1


def test_invalid_review_rejected_and_missing_or_stopped_not_rated(tmp_path: Path):
    with TestClient(create_app(tmp_path / "config.local.json")) as client:
        run = generate(client)
        payload = evaluation()
        payload["candidates"][1]["reason"] = " "
        assert (
            client.put(f"/api/history/{run['id']}/evaluation", json=payload).status_code
            == 422
        )
        assert (
            client.put("/api/history/missing/evaluation", json=evaluation()).status_code
            == 404
        )
        no_difference_reason = evaluation()
        no_difference_reason["distinct"] = False
        assert (
            client.put(
                f"/api/history/{run['id']}/evaluation", json=no_difference_reason
            ).status_code
            == 422
        )
        stopped = client.post(
            "/api/generate",
            json={
                "scenario": "reactivation",
                "client_information": "虚构客户",
                "contact_status": "do_not_contact",
            },
        ).json()
        assert (
            client.put(
                f"/api/history/{stopped['id']}/evaluation", json=evaluation()
            ).status_code
            == 422
        )


def test_filter_export_and_compare_full_inputs_without_recent_limit(tmp_path: Path):
    path = tmp_path / "config.local.json"
    with TestClient(create_app(path)) as client:
        run = generate(client)
        other = generate(client, "不同客户")
        store = Store(path.parent / "xutang.sqlite3")
        for index in range(55):
            copy = RunRecord.model_validate(run).model_copy(
                update={
                    "id": f"version2-{index}",
                    "prompt_version": "test-next",
                }
            )
            store.save_run(copy)
        filtered = client.get(
            "/api/evaluation?scenario=reactivation&version=test-next"
        ).json()
        assert len(filtered["records"]) == 55
        assert filtered["summary"]["generated"] == 55
        assert client.get("/api/evaluation?scenario=greeting").json()["records"] == []
        compared = client.get(f"/api/history/{run['id']}/comparisons").json()
        assert len(compared) == 55
        assert other["id"] not in [record["id"] for record in compared]
        response = client.get("/api/export.xlsx?version=test-next")
        assert response.status_code == 200
        workbook = load_workbook(BytesIO(response.content))
        assert workbook["案例结果"].max_row == 56
        assert "v2" not in [row["提示词版本"] for row in rows(workbook["案例结果"])]
        assert client.get("/api/evaluation?batch_id=missing").status_code == 404


def test_batch_filter_statistics_and_excel_share_the_same_scope(tmp_path: Path):
    path = tmp_path / "config.local.json"
    with TestClient(create_app(path)) as client:
        run = RunRecord.model_validate(generate(client))
        generate(client, "批次外客户")
        client.put(
            f"/api/history/{run.id}/evaluation", json=evaluation()
        ).raise_for_status()
        store = Store(path.parent / "xutang.sqlite3")
        batch = BatchRun(
            id="batch-evaluation",
            created_at=run.created_at,
            cases_version="test-v1",
            cases=[
                Case(
                    id="CASE001",
                    title="虚构拒联测试",
                    focus="尊重意愿",
                    input=run.input,
                )
            ],
            model="fixture-model",
            base_url="http://127.0.0.1",
            prompt_version=run.prompt_version,
            brand_rules=run.brand_rules,
            status="completed",
            items=[BatchItem(case_id="CASE001", run_id=run.id, status="generated")],
        )
        store.save_batch(batch)
        view = client.get("/api/evaluation?batch_id=batch-evaluation").json()
        assert [record["id"] for record in view["records"]] == [run.id]
        assert view["summary"]["human"]["total_messages"] == 3
        assert len(view["evaluations"]) == 1
        workbook = load_workbook(
            BytesIO(client.get("/api/export.xlsx?batch_id=batch-evaluation").content)
        )
        exported = rows(workbook["案例结果"])
        assert len(exported) == 1
        assert exported[0]["案例ID"] == "CASE001"
        assert exported[0]["批次ID"] == "batch-evaluation"
        assert rows(workbook["批次说明"])[0]["本次导出数"] == 1


def rows(sheet):
    data = list(sheet.values)
    return [dict(zip(data[0], row, strict=True)) for row in data[1:]]


def test_export_keeps_text_outputs_reviews_and_long_input_without_keys(tmp_path: Path):
    with TestClient(create_app(tmp_path / "config.local.json")) as client:
        client.put(
            "/api/settings",
            json={
                "base_url": "https://api.deepseek.com",
                "model": "fixture-model",
                "api_key": "sk-not-for-export",
            },
        ).raise_for_status()
        long_name = "=客户资料" + "虚构偏好" * 9000
        run = generate(client, long_name)
        human = {**evaluation(), "notes": "人工备注" * 10000}
        ai = {**evaluation(source="ai"), "notes": "AI备注" * 10000}
        client.put(
            f"/api/history/{run['id']}/evaluation", json=human
        ).raise_for_status()
        client.put(f"/api/history/{run['id']}/evaluation", json=ai).raise_for_status()
        response = client.get("/api/export.xlsx")
        assert response.status_code == 200
        workbook = load_workbook(BytesIO(response.content))
        case = rows(workbook["案例结果"])[0]
        assert case["候选1"] == run["result"]["messages"][0]
        assert case["结果来源"] == "规则回复"
        reviews = rows(workbook["评价记录"])
        assert reviews[0]["评价来源"] == "人工复核"
        assert reviews[0]["候选2原因"] == "表达生硬"
        chunks = [
            r["内容"] for r in rows(workbook["长文本"]) if r["字段"] == "客户信息"
        ]
        assert "".join(chunks) == long_name
        for source, expected in (
            ("人工复核", human["notes"]),
            ("AI 初评", ai["notes"]),
        ):
            notes = [
                r["内容"]
                for r in rows(workbook["长文本"])
                if r["字段"] == f"{source} / 备注"
            ]
            assert "".join(notes) == expected
        cells = [cell for sheet in workbook for row in sheet for cell in row]
        assert not any(cell.data_type == "f" for cell in cells)
        assert "sk-not-for-export" not in str([cell.value for cell in cells])
