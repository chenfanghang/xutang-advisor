"""SQLite 产品资料与历史记录。"""

import json
import sqlite3
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path

from backend.judge_schemas import JudgeExperiment
from backend.schemas import BatchRun, Evaluation, Product, RunRecord, TestCase


class Store:
    """保存产品资料和每次运行的独立快照。"""

    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as connection:
            connection.executescript(
                """CREATE TABLE IF NOT EXISTS products (
                       id TEXT PRIMARY KEY, payload TEXT NOT NULL);
                   CREATE TABLE IF NOT EXISTS runs (
                       id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
                       scenario TEXT NOT NULL, status TEXT NOT NULL,
                       payload TEXT NOT NULL);
                   CREATE TABLE IF NOT EXISTS test_cases (
                       id TEXT PRIMARY KEY, payload TEXT NOT NULL);
                   CREATE TABLE IF NOT EXISTS batches (
                       id TEXT PRIMARY KEY, status TEXT NOT NULL,
                       payload TEXT NOT NULL);
                   CREATE TABLE IF NOT EXISTS evaluations (
                       run_id TEXT NOT NULL, source TEXT NOT NULL,
                       payload TEXT NOT NULL, PRIMARY KEY (run_id, source));
                   CREATE TABLE IF NOT EXISTS judge_experiments (
                       id TEXT PRIMARY KEY, payload TEXT NOT NULL);"""
            )
            products = json.loads(
                (Path(__file__).parent / "data/products.json").read_text("utf-8")
            )
            for item in products:
                product = Product.model_validate(item)
                connection.execute(
                    "INSERT OR IGNORE INTO products VALUES (?, ?)",
                    (product.id, product.model_dump_json()),
                )
            dataset = json.loads(
                (Path(__file__).parent / "data/test_cases_v1.json").read_text("utf-8")
            )
            self.cases_version = dataset["version"]
            for item in dataset["cases"]:
                case = TestCase.model_validate(item)
                connection.execute(
                    "INSERT OR IGNORE INTO test_cases VALUES (?, ?)",
                    (case.id, case.model_dump_json()),
                )

    @contextmanager
    def connection(self) -> Generator[sqlite3.Connection]:
        """每项读写独立打开并关闭连接，不跨模型请求持有事务。"""
        connection = sqlite3.connect(self.path)
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def products(self) -> list[Product]:
        """返回当前商品事实。"""
        with self.connection() as connection:
            rows = connection.execute("SELECT payload FROM products ORDER BY rowid")
            return [Product.model_validate_json(row[0]) for row in rows]

    def save_run(self, record: RunRecord) -> None:
        """插入新记录，不覆盖已有记录。"""
        with self.connection() as connection:
            connection.execute(
                "INSERT INTO runs VALUES (?, ?, ?, ?, ?)",
                (
                    record.id,
                    record.created_at.isoformat(),
                    record.input.scenario,
                    record.result.status,
                    record.model_dump_json(),
                ),
            )

    def history(self, limit: int) -> list[RunRecord]:
        """按最近运行顺序读取快照。"""
        with self.connection() as connection:
            rows = connection.execute(
                "SELECT payload FROM runs ORDER BY rowid DESC LIMIT ?", (limit,)
            )
            return [RunRecord.model_validate_json(row[0]) for row in rows]

    def get_run(self, run_id: str) -> RunRecord | None:
        """读取一条完整历史。"""
        with self.connection() as connection:
            row = connection.execute(
                "SELECT payload FROM runs WHERE id = ?", (run_id,)
            ).fetchone()
            return RunRecord.model_validate_json(row[0]) if row else None

    def all_runs(self) -> list[RunRecord]:
        """评估与导出遍历完整本机历史，不受最近记录条数限制。"""
        with self.connection() as connection:
            return [
                RunRecord.model_validate_json(row[0])
                for row in connection.execute(
                    "SELECT payload FROM runs ORDER BY rowid DESC"
                )
            ]

    def save_evaluation(self, evaluation: Evaluation) -> None:
        """只覆盖同来源的评价，不修改生成快照或另一来源。"""
        with self.connection() as connection:
            connection.execute(
                "INSERT INTO evaluations VALUES (?, ?, ?) ON CONFLICT(run_id, source) "
                "DO UPDATE SET payload=excluded.payload",
                (evaluation.run_id, evaluation.source, evaluation.model_dump_json()),
            )

    def evaluations(self) -> list[Evaluation]:
        """读取已有评价。"""
        with self.connection() as connection:
            return [
                Evaluation.model_validate_json(row[0])
                for row in connection.execute(
                    "SELECT payload FROM evaluations ORDER BY rowid"
                )
            ]

    def test_cases(self) -> list[TestCase]:
        """读取固定案例，不提供覆盖它们的编辑接口。"""
        with self.connection() as connection:
            return [
                TestCase.model_validate_json(row[0])
                for row in connection.execute(
                    "SELECT payload FROM test_cases ORDER BY id"
                )
            ]

    def save_batch(self, batch: BatchRun) -> None:
        """创建批次或保存已完成案例的进度。"""
        with self.connection() as connection:
            connection.execute(
                "INSERT INTO batches VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE "
                "SET status=excluded.status, payload=excluded.payload",
                (batch.id, batch.status, batch.model_dump_json()),
            )

    def batches(self) -> list[BatchRun]:
        """按最近创建顺序读取批次。"""
        with self.connection() as connection:
            return [
                BatchRun.model_validate_json(row[0])
                for row in connection.execute(
                    "SELECT payload FROM batches ORDER BY rowid DESC"
                )
            ]

    def get_batch(self, batch_id: str) -> BatchRun | None:
        """读取指定批次的输入与进度。"""
        with self.connection() as connection:
            row = connection.execute(
                "SELECT payload FROM batches WHERE id=?", (batch_id,)
            ).fetchone()
            return BatchRun.model_validate_json(row[0]) if row else None

    def interrupt_batches(self) -> None:
        """服务重启后保留已有结果，明确标记未结束的任务。"""
        for batch in self.batches():
            if batch.status == "running":
                batch.status = "interrupted"
                batch.error = "服务已重启，批次中断；已完成结果仍保留。"
                self.save_batch(batch)

    def save_experiment(self, experiment: JudgeExperiment) -> None:
        with self.connection() as connection:
            connection.execute(
                "INSERT INTO judge_experiments VALUES (?, ?) ON CONFLICT(id) "
                "DO UPDATE SET payload=excluded.payload",
                (experiment.id, experiment.model_dump_json()),
            )

    def experiments(self) -> list[JudgeExperiment]:
        with self.connection() as connection:
            return [
                JudgeExperiment.model_validate_json(row[0])
                for row in connection.execute(
                    "SELECT payload FROM judge_experiments ORDER BY rowid DESC"
                )
            ]

    def get_experiment(self, identifier: str) -> JudgeExperiment | None:
        with self.connection() as connection:
            row = connection.execute(
                "SELECT payload FROM judge_experiments WHERE id=?", (identifier,)
            ).fetchone()
            return JudgeExperiment.model_validate_json(row[0]) if row else None
