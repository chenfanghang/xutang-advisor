"""语义评价统计；不将程序检查当作质量评价。"""

from backend.schemas import Evaluation, RunRecord


def summarize(records: list[RunRecord], evaluations: list[Evaluation]) -> dict:
    """所有已生成结果为分母，未评价不算通过，失败及停止另列。"""
    generated = [record for record in records if record.result.status == "generated"]
    ids = {record.id for record in generated}
    summary: dict = {
        "total": len(records),
        "generated": len(generated),
        "failed": sum(r.result.status == "failed" for r in records),
        "stopped": sum(r.result.status == "stopped" for r in records),
    }
    for source in ("human", "ai"):
        reviews = [e for e in evaluations if e.source == source and e.run_id in ids]
        judgments = [c.passed for e in reviews for c in e.candidates]
        reviewed = sum(value is not None for value in judgments)
        summary[source] = {
            "total_messages": len(generated) * 3,
            "reviewed_messages": reviewed,
            "unreviewed_messages": len(generated) * 3 - reviewed,
            "passed_messages": sum(value is True for value in judgments),
            "usable_cases": sum(
                any(c.passed is True for c in e.candidates) for e in reviews
            ),
            "qualified_groups": sum(
                all(c.passed is True for c in e.candidates) and e.distinct is True
                for e in reviews
            ),
            "fully_reviewed_cases": sum(
                all(c.passed is not None for c in e.candidates)
                and e.distinct is not None
                for e in reviews
            ),
        }
    return summary
