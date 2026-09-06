from __future__ import annotations

import asyncio
import logging
import signal
from typing import Any, Awaitable, Callable

from bullmq import Worker

from .config import settings
from .db import get_message, record_workflow_run
from .llm_errors import is_llm_unavailable
from .registry import available_workflow_names, load_enabled_workflows

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("agent_workflows")


def _llm_retry_delay_ms(failed_attempt: int) -> int:
    min_ms = max(1, settings.llm_retry_min_ms)
    max_ms = max(min_ms, settings.llm_retry_max_ms)
    shift = max(0, failed_attempt - 1)
    return min(max_ms, min_ms * (2**shift))


async def _run_with_llm_retry(
    *,
    workflow_name: str,
    message_id: str,
    event: str,
    run: Callable[[], Awaitable[str]],
) -> str:
    """Retry indefinitely while the LLM server is unreachable; fail fast otherwise."""
    llm_attempt = 0
    last_recorded_at = 0.0
    record_every_s = 5 * 60
    while True:
        try:
            return await run()
        except Exception as exc:
            if not is_llm_unavailable(exc):
                raise
            llm_attempt += 1
            delay_ms = _llm_retry_delay_ms(llm_attempt)
            now = asyncio.get_running_loop().time()
            should_record = llm_attempt == 1 or (now - last_recorded_at) >= record_every_s
            log.warning(
                "workflow.llm_unavailable name=%s event=%s message_id=%s attempt=%s delay_ms=%s err=%s",
                workflow_name,
                event,
                message_id,
                llm_attempt,
                delay_ms,
                exc,
            )
            if should_record:
                detail = (
                    f"LLM unavailable (attempt {llm_attempt}); "
                    f"retrying in {delay_ms}ms; {exc}"
                )[:2000]
                record_workflow_run(
                    workflow_name=workflow_name,
                    message_id=message_id,
                    event=event,
                    status="retrying",
                    detail=detail,
                )
                last_recorded_at = now
            await asyncio.sleep(delay_ms / 1000)


async def run_worker() -> None:
    workflows = load_enabled_workflows()
    log.info(
        "worker.starting queue=%s enabled=%s available=%s llm=%s",
        settings.message_events_queue,
        [w.name for w in workflows],
        available_workflow_names(),
        settings.llm_base_url,
    )
    if not workflows:
        log.warning(
            "No workflows enabled. Set ENABLED_WORKFLOWS=daily_site_report (or leave empty to idle)."
        )

    async def process_job(job: Any, _token: str | None = None) -> dict[str, Any]:
        data = job.data if hasattr(job, "data") else job
        if not isinstance(data, dict):
            raise TypeError(f"Unexpected job payload type: {type(data)}")

        message_id = data.get("messageId")
        event = data.get("event")
        if not message_id or not event:
            raise ValueError("Job missing messageId or event")

        message = get_message(message_id)
        results: dict[str, str] = {}

        for workflow in workflows:
            if not workflow.matches(data, message):
                continue
            try:
                status = await _run_with_llm_retry(
                    workflow_name=workflow.name,
                    message_id=message_id,
                    event=event,
                    run=lambda w=workflow: w.handle(data, message),
                )
                results[workflow.name] = status
                log.info(
                    "workflow.done name=%s event=%s message_id=%s status=%s",
                    workflow.name,
                    event,
                    message_id,
                    status,
                )
            except Exception as exc:
                log.exception(
                    "workflow.failed name=%s event=%s message_id=%s",
                    workflow.name,
                    event,
                    message_id,
                )
                record_workflow_run(
                    workflow_name=workflow.name,
                    message_id=message_id,
                    event=event,
                    status="error",
                    detail=str(exc)[:2000],
                )
                raise

        return {"messageId": message_id, "event": event, "results": results}

    # Pass Redis URL string — Node-style opts like maxRetriesPerRequest break redis-py.
    worker = Worker(
        settings.message_events_queue,
        process_job,
        {
            "connection": settings.redis_url,
            "concurrency": settings.concurrency,
            # Local LLM classify+extract can exceed the default 30s lock.
            "lockDuration": 5 * 60 * 1000,
        },
    )

    stop = asyncio.Event()

    def _stop(*_args: object) -> None:
        stop.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _stop)
        except NotImplementedError:
            signal.signal(sig, lambda *_: _stop())

    await stop.wait()
    log.info("worker.stopping")
    await worker.close()


def main() -> None:
    asyncio.run(run_worker())


if __name__ == "__main__":
    main()
