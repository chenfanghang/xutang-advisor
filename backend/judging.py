"""独立、逐例持久化的自动评测实验。"""

import asyncio
import json
import multiprocessing
import os
import re
import tempfile
from concurrent.futures import ProcessPoolExecutor
from datetime import UTC, datetime
from pathlib import Path

from backend.judge_schemas import JudgeExperiment, JudgeItem, JudgeVerdict, RuleCheck
from backend.schemas import Evaluation, RunRecord
from backend.settings import ModelSettings
from backend.store import Store

RUBRIC_VERSION = "judge-v1"


def load_rubric() -> str:
    return (Path(__file__).parent / "prompts/judge_v1.md").read_text("utf-8")


def check_rules(record: RunRecord) -> list[RuleCheck]:
    """只判断明确结构及停止联系状态，不用关键词判断营销语义。"""
    if record.result.status != "generated":
        passed = (
            record.result.status == "stopped"
            and not record.result.messages
            and record.input.contact_status == "do_not_contact"
        )
        return [
            RuleCheck(
                name="运行状态",
                passed=passed,
                detail="停止生成且无触达消息" if passed else "生成失败，无可评候选",
            )
        ]
    messages = record.result.messages
    return [
        RuleCheck(
            name="候选数量",
            passed=len(messages) == 3,
            detail=f"实际 {len(messages)} 条",
        ),
        RuleCheck(
            name="非空中文",
            passed=all(
                bool(text.strip()) and bool(re.search(r"[\u4e00-\u9fff]", text))
                for text in messages
            ),
            detail="每条非空且包含中文；不代表自然度合格",
        ),
        RuleCheck(
            name="完全重复",
            passed=len(set(messages)) == len(messages),
            detail="不完全重复；不代表切入点有差异",
        ),
        RuleCheck(
            name="联系状态",
            passed=record.input.contact_status != "do_not_contact",
            detail="已结束拒联不应继续生成触达消息",
        ),
    ]


def judge_context(record: RunRecord) -> str:
    """不向 Judge 提供版本及生成模型，统一业务规则由冻结准则提供。"""
    return json.dumps(
        {
            "input": record.input.model_dump(),
            "products": [item.model_dump() for item in record.products],
            "scenario_instruction": record.scenario_instruction,
        },
        ensure_ascii=False,
    )


def evaluate_in_worker(
    settings: ModelSettings,
    rubric: str,
    context: str,
    messages: list[str],
    run_id: str,
) -> tuple[str, dict | None, str | None, dict]:
    """隔离 DeepEval 的进程全局状态及相对路径缓存。"""
    original = os.getcwd()
    with tempfile.TemporaryDirectory(prefix="xutang-judge-") as folder:
        try:
            os.chdir(folder)
            from backend.deepeval_metric import evaluate_case

            metric, result = evaluate_case(settings, rubric, context, messages, run_id)
            verdict = (
                metric.verdict.model_dump() if metric.verdict is not None else None
            )
            return metric.raw_output, verdict, metric.error, result
        finally:
            os.chdir(original)


async def execute_experiment(
    experiment: JudgeExperiment,
    records: list[RunRecord],
    settings: ModelSettings,
    store: Store,
) -> None:
    """3个独立进程并行评审，主进程逐条写入并保留既有轮次。"""
    pool = ProcessPoolExecutor(
        max_workers=3, mp_context=multiprocessing.get_context("spawn")
    )
    completed = {(item.run_id, item.trial) for item in experiment.items}
    queue = asyncio.Queue()
    for trial in range(1, experiment.repetitions + 1):
        for record in records:
            if (record.id, trial) not in completed:
                queue.put_nowait((record, trial))

    async def consume() -> None:
        loop = asyncio.get_running_loop()
        while not queue.empty():
            record, trial = queue.get_nowait()
            rules = check_rules(record)
            item = JudgeItem(
                run_id=record.id, trial=trial, status="skipped", rules=rules
            )
            if record.result.status != "generated":
                item.error = "停止或生成失败不适用三条候选的语义评审。"
            elif not all(check.passed for check in rules):
                item.status = "rule_failed"
                item.error = "确定性检查未通过，不执行语义评分。"
            else:
                item.judge_input = judge_context(record)
                try:
                    raw, verdict, metric_error, result = await loop.run_in_executor(
                        pool,
                        evaluate_in_worker,
                        settings,
                        experiment.rubric,
                        item.judge_input,
                        record.result.messages,
                        record.id,
                    )
                    item.raw_output = raw
                    item.framework_result = result
                    if verdict is None or metric_error:
                        item.status = "error"
                        item.error = (
                            "评审服务或响应校验失败，请检查原始响应与框架记录。"
                        )
                    else:
                        item.status = "reviewed"
                        item.verdict = JudgeVerdict.model_validate(verdict)
                except Exception:
                    item.status = "error"
                    item.error = "自动评测执行失败；未作话术质量判断。"
            experiment.items.append(item)
            store.save_experiment(experiment)
            queue.task_done()

    workers = [asyncio.create_task(consume()) for _ in range(min(3, queue.qsize()))]
    try:
        await asyncio.gather(*workers)
        experiment.status = "completed"
    except asyncio.CancelledError:
        experiment.status = "interrupted"
        experiment.error = "服务停止，评测已中断；已完成结果保留。"
        raise
    except Exception:
        experiment.status = "failed"
        experiment.error = "实验执行中断，请检查已保存记录。"
    finally:
        for worker in workers:
            worker.cancel()
        await asyncio.gather(*workers, return_exceptions=True)
        pool.shutdown(wait=False, cancel_futures=True)
        experiment.finished_at = datetime.now(UTC)
        store.save_experiment(experiment)


def quality_counts(verdicts: list[JudgeVerdict], total_cases: int) -> dict:
    """同一口径汇总全实验及各生成版本，待复核不计通过。"""
    decisions = [
        candidate.passed for verdict in verdicts for candidate in verdict.candidates
    ]
    return {
        "total_cases": total_cases,
        "total_messages": total_cases * 3,
        "reviewed_cases": len(verdicts),
        "reviewed_messages": len(decisions),
        "passed_messages": sum(value is True for value in decisions),
        "failed_messages": sum(value is False for value in decisions),
        "pending_messages": sum(value is None for value in decisions),
        "unreviewed_messages": total_cases * 3 - len(decisions),
        "usable_cases": sum(
            any(c.passed is True for c in verdict.candidates) for verdict in verdicts
        ),
        "qualified_groups": sum(
            all(c.passed is True for c in verdict.candidates)
            and verdict.diversity >= 3
            and not verdict.diversity_needs_review
            for verdict in verdicts
        ),
    }


def experiment_summary(
    experiment: JudgeExperiment,
    records: list[RunRecord],
    evaluations: list[Evaluation] | None = None,
) -> dict:
    """重复次数按案例-轮次统计，同时显示覆盖、错误和同案例判断一致性。"""
    eligible = {record.id for record in records if record.result.status == "generated"}
    total_cases = len(eligible) * experiment.repetitions
    reviewed = [
        (item.run_id, verdict)
        for item in experiment.items
        if item.status == "reviewed" and (verdict := item.verdict) is not None
    ]
    repeated = []
    humans = {
        item.run_id: item for item in (evaluations or []) if item.source == "human"
    }
    comparisons: list[tuple[bool, bool]] = []
    for run_id, verdict in reviewed:
        human = humans.get(run_id)
        if human is not None:
            for candidate, label in zip(
                verdict.candidates, human.candidates, strict=True
            ):
                if candidate.passed is not None and label.passed is not None:
                    comparisons.append((candidate.passed, label.passed))
    for identifier in eligible:
        values = [verdict for run_id, verdict in reviewed if run_id == identifier]
        if experiment.repetitions > 1 and len(values) == experiment.repetitions:
            signatures = [
                (
                    [c.passed for c in verdict.candidates],
                    verdict.diversity >= 3,
                    verdict.diversity_needs_review,
                )
                for verdict in values
            ]
            repeated.append(all(value == signatures[0] for value in signatures))
    by_version = {}
    for version in sorted({record.prompt_version for record in records}):
        ids = {
            record.id
            for record in records
            if record.prompt_version == version and record.id in eligible
        }
        by_version[version] = quality_counts(
            [verdict for run_id, verdict in reviewed if run_id in ids],
            len(ids) * experiment.repetitions,
        )
    return {
        **quality_counts([verdict for _, verdict in reviewed], total_cases),
        "by_version": by_version,
        "evaluation_errors": sum(item.status == "error" for item in experiment.items),
        "rule_failures": sum(item.status == "rule_failed" for item in experiment.items),
        "skipped": sum(item.status == "skipped" for item in experiment.items),
        "repeated_cases": len(repeated),
        "consistent_cases": sum(repeated),
        "human_compared_messages": len(comparisons),
        "human_agreements": sum(judge == human for judge, human in comparisons),
        "false_acceptances": sum(judge and not human for judge, human in comparisons),
        "false_rejections": sum(not judge and human for judge, human in comparisons),
        "calibrated": False,
    }
