"""HTTP 入口。"""

import asyncio
import sqlite3
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from importlib.metadata import version as package_version
from pathlib import Path
from time import perf_counter
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError
from starlette.responses import JSONResponse, Response

from backend.batches import execute_batch
from backend.evaluation import summarize
from backend.export import export_workbook
from backend.judge_schemas import JudgeExperiment, JudgeRequest
from backend.judging import (
    RUBRIC_VERSION,
    execute_experiment,
    experiment_summary,
    load_rubric,
)
from backend.model_client import ModelServiceError, complete
from backend.schemas import (
    SCENARIOS,
    BatchRun,
    Evaluation,
    EvaluationInput,
    GenerationRequest,
    RunRecord,
    Scenario,
)
from backend.settings import (
    ModelSettings,
    SettingsView,
    public_settings,
    read_settings,
    resolve_settings,
    save_settings,
)
from backend.store import Store
from backend.workflow import (
    PROMPT_VERSION,
    build_workflow,
    generate_record,
    load_brand_rules,
)


def create_app(settings_path: Path | None = None) -> FastAPI:
    """创建本机应用。"""
    path = settings_path or Path(__file__).resolve().parents[1] / "config.local.json"

    store = Store(path.parent / "xutang.sqlite3")
    graph = build_workflow(path)
    jobs: set[asyncio.Task] = set()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncGenerator[None]:
        store.interrupt_batches()
        for experiment in store.experiments():
            if experiment.status == "running":
                experiment.status = "interrupted"
                experiment.error = "服务已重启；评测中断，已完成结果保留。"
                experiment.finished_at = datetime.now(UTC)
                store.save_experiment(experiment)
        try:
            yield
        finally:
            for task in jobs:
                task.cancel()
            await asyncio.gather(*jobs, return_exceptions=True)

    application = FastAPI(title="序棠话术工具", lifespan=lifespan)

    @application.exception_handler(ModelServiceError)
    async def model_error(request: Request, error: ModelServiceError) -> JSONResponse:
        return JSONResponse(
            status_code=error.status_code, content={"detail": error.detail}
        )

    @application.exception_handler(sqlite3.Error)
    async def database_error(request: Request, error: sqlite3.Error) -> JSONResponse:
        return JSONResponse(
            status_code=500,
            content={"detail": "本机数据库读写失败，请检查磁盘空间和目录权限。"},
        )

    @application.exception_handler(RequestValidationError)
    async def validation_error(
        request: Request, error: RequestValidationError
    ) -> JSONResponse:
        # 只返回中文字段及原因，避免回显密钥等原始输入。
        labels = {
            "client_information": "客户信息",
            "scenario": "业务场景",
            "conversation_history": "对话历史",
            "scenario_information": "场景补充",
            "product_ids": "相关产品",
            "contact_status": "联系意愿",
            "base_url": "服务地址",
            "model": "模型名称",
            "api_key": "API Key",
        }
        messages = []
        for issue in error.errors():
            field = issue["loc"][1] if len(issue["loc"]) > 1 else "输入"
            reason = {
                "missing": "缺少必填资料",
                "string_too_short": "请填写此项",
                "literal_error": "选项不受支持，请刷新页面后选择",
                "json_invalid": "请求格式不正确",
            }.get(issue["type"], "输入格式不正确")
            if issue["type"] == "value_error":
                reason = issue["msg"].removeprefix("Value error, ")
            messages.append(f"{labels.get(str(field), '输入')}：{reason}")
        return JSONResponse(
            status_code=422,
            content={"detail": "；".join(messages)},
        )

    @application.get("/api/settings", response_model=SettingsView)
    def get_settings() -> SettingsView:
        try:
            return public_settings(read_settings(path))
        except (OSError, ValidationError) as error:
            raise HTTPException(500, "本机配置无法读取，请检查配置文件。") from error

    @application.put("/api/settings", response_model=SettingsView)
    def put_settings(update: ModelSettings) -> SettingsView:
        try:
            settings = resolve_settings(
                update, read_settings(path, include_environment=False)
            )
            save_settings(path, settings)
            return public_settings(read_settings(path))
        except (OSError, ValidationError) as error:
            raise HTTPException(
                500, "配置无法保存，请检查本机文件及目录权限。"
            ) from error

    @application.post("/api/settings/test")
    async def test_connection(update: ModelSettings) -> dict[str, bool | int | str]:
        """测试当前表单，沿用已保存密钥，但不隐式保存表单。"""
        try:
            settings = resolve_settings(update, read_settings(path))
        except (OSError, ValidationError) as error:
            raise HTTPException(500, "本机配置无法读取，请检查配置文件。") from error
        started = perf_counter()
        await complete(settings, [{"role": "user", "content": "请只回复：连接正常"}])
        return {
            "ok": True,
            "message": "已收到模型回复，连接正常。",
            "latency_ms": round((perf_counter() - started) * 1000),
        }

    @application.get("/api/catalog")
    def catalog() -> dict:
        return {
            "products": [product.model_dump() for product in store.products()],
            "scenarios": [{"id": key, **value} for key, value in SCENARIOS.items()],
        }

    @application.post("/api/generate", response_model=RunRecord)
    async def generate(request: GenerationRequest):
        record, status_code = await generate_record(request, store, graph)
        if record.result.status == "failed":
            return JSONResponse(
                status_code=status_code,
                content={
                    "detail": record.result.error,
                    "run_id": record.id,
                },
            )
        return record

    @application.get("/api/history", response_model=list[RunRecord])
    def history(limit: int = Query(default=50, ge=1, le=200)) -> list[RunRecord]:
        return store.history(limit)

    @application.get("/api/history/{run_id}", response_model=RunRecord)
    def get_run(run_id: str) -> RunRecord:
        record = store.get_run(run_id)
        if record is None:
            raise HTTPException(404, "未找到这条生成记录。")
        return record

    @application.put("/api/history/{run_id}/evaluation", response_model=Evaluation)
    def save_evaluation(run_id: str, update: EvaluationInput) -> Evaluation:
        record = get_run(run_id)
        if record.result.status != "generated":
            raise HTTPException(422, "失败或停止生成没有三条候选，请查看程序检查结果。")
        evaluation = Evaluation(
            **update.model_dump(), run_id=run_id, updated_at=datetime.now(UTC)
        )
        store.save_evaluation(evaluation)
        return evaluation

    @application.get(
        "/api/history/{run_id}/comparisons", response_model=list[RunRecord]
    )
    def comparisons(run_id: str) -> list[RunRecord]:
        record = get_run(run_id)
        return [
            item
            for item in store.all_runs()
            if item.id != run_id
            and item.input == record.input
            and item.products == record.products
        ]

    def evaluation_records(
        scenario: Scenario | None,
        version: str | None,
        batch_id: str | None,
    ) -> list[RunRecord]:
        ids = None
        if batch_id:
            batch = store.get_batch(batch_id)
            if batch is None:
                raise HTTPException(404, "未找到这个批次。")
            ids = {item.run_id for item in batch.items}
        return [
            item
            for item in store.all_runs()
            if (scenario is None or item.input.scenario == scenario)
            and (not version or item.prompt_version == version)
            and (ids is None or item.id in ids)
        ]

    @application.get("/api/evaluation")
    def evaluation_view(
        scenario: Scenario | None = None,
        version: str | None = None,
        batch_id: str | None = None,
    ) -> dict:
        records = evaluation_records(scenario, version, batch_id)
        ids = {record.id for record in records}
        evaluations = [item for item in store.evaluations() if item.run_id in ids]
        return {
            "records": records,
            "evaluations": evaluations,
            "summary": summarize(records, evaluations),
            "versions": sorted({item.prompt_version for item in store.all_runs()}),
        }

    @application.get("/api/export.xlsx")
    def export_cases(
        scenario: Scenario | None = None,
        version: str | None = None,
        batch_id: str | None = None,
    ) -> Response:
        records = evaluation_records(scenario, version, batch_id)
        ids = {record.id for record in records}
        evaluations = [item for item in store.evaluations() if item.run_id in ids]
        return Response(
            export_workbook(records, evaluations, store.batches()),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": 'attachment; filename="xutang-cases.xlsx"'},
        )

    @application.post(
        "/api/judge-experiments", response_model=JudgeExperiment, status_code=202
    )
    async def start_experiment(request: JudgeRequest) -> JudgeExperiment:
        if any(item.status == "running" for item in store.experiments()):
            raise HTTPException(409, "已有自动评测正在运行，请等待完成。")
        records = [get_run(identifier) for identifier in dict.fromkeys(request.run_ids)]
        try:
            settings = read_settings(path)
        except (OSError, ValidationError) as error:
            raise HTTPException(500, "本机配置无法读取，请检查配置文件。") from error
        if not settings.api_key.get_secret_value():
            raise HTTPException(422, "请先在模型设置保存可用密钥。")
        judge_settings = settings.model_copy(update={"model": request.judge_model})
        experiment = JudgeExperiment(
            id=str(uuid4()),
            created_at=datetime.now(UTC),
            run_ids=[record.id for record in records],
            judge_model=request.judge_model,
            base_url=settings.base_url,
            repetitions=request.repetitions,
            rubric_version=RUBRIC_VERSION,
            rubric=load_rubric(),
            framework_version=package_version("deepeval"),
            request_timeout_seconds=180.0,
        )
        store.save_experiment(experiment)
        task = asyncio.create_task(
            execute_experiment(experiment, records, judge_settings, store)
        )
        jobs.add(task)
        task.add_done_callback(jobs.discard)
        return experiment

    @application.get("/api/judge-experiments")
    def experiments() -> list[dict]:
        return [
            {
                "id": item.id,
                "created_at": item.created_at,
                "status": item.status,
                "judge_model": item.judge_model,
                "total": len(item.run_ids) * item.repetitions,
                "completed": len(item.items),
            }
            for item in store.experiments()
        ]

    @application.get(
        "/api/judge-experiments/{identifier}", response_model=JudgeExperiment
    )
    def experiment_detail(identifier: str) -> JudgeExperiment:
        experiment = store.get_experiment(identifier)
        if experiment is None:
            raise HTTPException(404, "未找到自动评测实验。")
        return experiment

    @application.post(
        "/api/judge-experiments/{identifier}/resume",
        response_model=JudgeExperiment,
        status_code=202,
    )
    async def resume_experiment(identifier: str) -> JudgeExperiment:
        experiment = experiment_detail(identifier)
        if experiment.status != "interrupted":
            raise HTTPException(409, "只能继续已中断的实验。")
        if any(item.status == "running" for item in store.experiments()):
            raise HTTPException(409, "已有自动评测正在运行，请等待完成。")
        try:
            settings = read_settings(path)
        except (OSError, ValidationError) as error:
            raise HTTPException(500, "本机配置无法读取，请检查配置文件。") from error
        if (
            not settings.api_key.get_secret_value()
            or settings.base_url != experiment.base_url
        ):
            raise HTTPException(422, "请配置与原实验相同服务地址的有效密钥。")
        if package_version("deepeval") != experiment.framework_version:
            raise HTTPException(409, "DeepEval 版本已变化，请恢复原版本后续跑。")
        records = [get_run(run_id) for run_id in experiment.run_ids]
        settings = settings.model_copy(update={"model": experiment.judge_model})
        experiment.status = "running"
        experiment.finished_at = None
        experiment.error = None
        store.save_experiment(experiment)
        task = asyncio.create_task(
            execute_experiment(experiment, records, settings, store)
        )
        jobs.add(task)
        task.add_done_callback(jobs.discard)
        return experiment

    @application.get("/api/judge-experiments/{identifier}/summary")
    def judge_summary(identifier: str) -> dict:
        experiment = experiment_detail(identifier)
        return experiment_summary(
            experiment,
            [get_run(run_id) for run_id in experiment.run_ids],
            store.evaluations(),
        )

    @application.get("/api/judge-experiments/{identifier}/export.xlsx")
    def judge_export(identifier: str) -> Response:
        from backend.export import export_experiment

        experiment = experiment_detail(identifier)
        records = [get_run(run_id) for run_id in experiment.run_ids]
        return Response(
            export_experiment(
                experiment, records, store.batches(), store.evaluations()
            ),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={
                "Content-Disposition": 'attachment; filename="xutang-deepeval.xlsx"'
            },
        )

    @application.get("/api/test-cases")
    def test_cases() -> dict:
        return {"version": store.cases_version, "cases": store.test_cases()}

    @application.post("/api/batches", response_model=BatchRun, status_code=202)
    async def start_batch() -> BatchRun:
        if any(item.status == "running" for item in store.batches()):
            raise HTTPException(409, "已有批次正在运行，请等待其结束。")
        try:
            settings = read_settings(path)
        except (OSError, ValidationError) as error:
            raise HTTPException(500, "本机配置无法读取，请检查配置文件。") from error
        if not settings.api_key.get_secret_value():
            raise HTTPException(422, "请先在模型设置中保存 API Key，再运行批量测试。")
        batch = BatchRun(
            id=str(uuid4()),
            created_at=datetime.now(UTC),
            cases_version=store.cases_version,
            cases=store.test_cases(),
            model=settings.model,
            base_url=settings.base_url,
            prompt_version=PROMPT_VERSION,
            brand_rules=load_brand_rules(),
        )
        store.save_batch(batch)
        task = asyncio.create_task(
            execute_batch(batch, store, build_workflow(path, settings))
        )
        jobs.add(task)
        task.add_done_callback(jobs.discard)
        return batch

    @application.get("/api/batches", response_model=list[BatchRun])
    def batches() -> list[BatchRun]:
        return store.batches()

    @application.get("/api/batches/{batch_id}", response_model=BatchRun)
    def batch_detail(batch_id: str) -> BatchRun:
        batch = store.get_batch(batch_id)
        if batch is None:
            raise HTTPException(404, "未找到这个批次。")
        return batch

    frontend = Path(__file__).resolve().parents[1] / "frontend" / "dist"
    if frontend.is_dir():
        application.mount("/", StaticFiles(directory=frontend, html=True), name="web")

    return application


app = create_app()
