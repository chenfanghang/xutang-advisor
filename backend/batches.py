"""在应用进程中串行执行固定批次，逐例保存。"""

import asyncio
import logging

from langgraph.graph.state import CompiledStateGraph

from backend.schemas import BatchItem, BatchRun
from backend.store import Store
from backend.workflow import generate_record

logger = logging.getLogger(__name__)


async def execute_batch(
    batch: BatchRun, store: Store, graph: CompiledStateGraph
) -> None:
    """复用单次生成入口，模型失败作为单例结果继续执行。"""
    try:
        for case in batch.cases:
            record, _ = await generate_record(
                case.input, store, graph, brand_rules=batch.brand_rules
            )
            batch.items.append(
                BatchItem(
                    case_id=case.id,
                    run_id=record.id,
                    status=record.result.status,
                    error=record.result.error,
                )
            )
            store.save_batch(batch)
        batch.status = "completed"
    except asyncio.CancelledError:
        batch.status = "interrupted"
        batch.error = "服务停止，批次中断；已完成结果仍保留。"
        store.save_batch(batch)
        raise
    except Exception:
        logger.exception("批次 %s 异常中断", batch.id)
        batch.status = "failed"
        batch.error = "批次异常中断，请查看已保存结果及本机日志。"
    store.save_batch(batch)
