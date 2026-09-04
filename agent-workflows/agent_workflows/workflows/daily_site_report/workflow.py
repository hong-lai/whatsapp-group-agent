from __future__ import annotations

from typing import Any

from ...base import Workflow
from ...config import settings
from ...db import connect, record_workflow_run
from .chain import build_chain
from .models import DailySiteReport

# Daily site reports are long structured messages; skip LLM for short chat noise.
MIN_REPORT_TEXT_LENGTH = 30


class DailySiteReportWorkflow(Workflow):
    name = "daily_site_report"

    def __init__(self) -> None:
        self._chain = None

    def _get_chain(
        self,
        model_id: str | None = None,
        *,
        classifier_prompt: str | None = None,
        extractor_prompt: str | None = None,
    ):
        has_prompt_override = classifier_prompt is not None or extractor_prompt is not None
        has_model_override = bool(model_id and model_id != settings.llm_model)
        if has_prompt_override or has_model_override:
            return build_chain(
                model_id=model_id,
                classifier_prompt=classifier_prompt,
                extractor_prompt=extractor_prompt,
            )
        if self._chain is None:
            self._chain = build_chain()
        return self._chain

    def matches(self, job: dict[str, Any], message: dict[str, Any] | None) -> bool:
        event = job.get("event")
        if event in ("message.deleted", "message.edited"):
            return True
        # Vision / OCR plugins should handle media_ready; this workflow is text-only.
        if event != "message.created":
            return False
        if message is None:
            return False
        if message.get("is_deleted"):
            return True
        text = (message.get("text_content") or "").strip()
        return len(text) >= MIN_REPORT_TEXT_LENGTH

    async def handle(
        self,
        job: dict[str, Any],
        message: dict[str, Any] | None,
    ) -> str:
        message_id = job["messageId"]
        event = job["event"]

        if event == "message.deleted" or (message and message.get("is_deleted")):
            self._soft_delete(message_id)
            record_workflow_run(
                workflow_name=self.name,
                message_id=message_id,
                event=event,
                status="deleted",
                detail="report soft-deleted",
            )
            return "deleted"

        if message is None:
            record_workflow_run(
                workflow_name=self.name,
                message_id=message_id,
                event=event,
                status="skipped",
                detail="message not found",
            )
            return "skipped:missing"

        text = (message.get("text_content") or "").strip()
        if len(text) < MIN_REPORT_TEXT_LENGTH:
            self._hard_delete(message_id)
            record_workflow_run(
                workflow_name=self.name,
                message_id=message_id,
                event=event,
                status="skipped",
                detail=f"text length {len(text)} < {MIN_REPORT_TEXT_LENGTH}; skipped LLM",
            )
            return "skipped:short"

        raw_model = job.get("llmModel")
        model_id = raw_model.strip() if isinstance(raw_model, str) and raw_model.strip() else None
        used_model = model_id or settings.llm_model

        def _optional_prompt(value: Any) -> str | None:
            if not isinstance(value, str):
                return None
            return value if value.strip() else None

        classifier_prompt = _optional_prompt(job.get("classifierPrompt"))
        extractor_prompt = _optional_prompt(job.get("extractorPrompt"))
        prompt_note = (
            "prompts=override"
            if classifier_prompt is not None or extractor_prompt is not None
            else "prompts=default"
        )

        result = await self._get_chain(
            model_id,
            classifier_prompt=classifier_prompt,
            extractor_prompt=extractor_prompt,
        ).ainvoke({"user_input": text})

        if not isinstance(result, DailySiteReport):
            self._hard_delete(message_id)
            record_workflow_run(
                workflow_name=self.name,
                message_id=message_id,
                event=event,
                status="irrelevant",
                detail=(
                    "classifier: not a daily site report; report hard-deleted; "
                    f"model={used_model}; {prompt_note}"
                ),
            )
            return "irrelevant"

        if not result.po_number or not result.contractor:
            self._hard_delete(message_id)
            record_workflow_run(
                workflow_name=self.name,
                message_id=message_id,
                event=event,
                status="rejected",
                detail=(
                    "missing po_number or contractor; report hard-deleted; "
                    f"model={used_model}; {prompt_note}"
                ),
            )
            return "rejected:incomplete"

        self._upsert_report(
            message_id=message_id,
            group_jid=message["group_jid"],
            report=result,
            source_text=text,
        )
        record_workflow_run(
            workflow_name=self.name,
            message_id=message_id,
            event=event,
            status="extracted",
            detail=(
                f"po={result.po_number} date={result.date}; "
                f"model={used_model}; {prompt_note}"
            ),
        )
        return "extracted"

    def _hard_delete(self, message_id: str) -> None:
        with connect() as conn:
            conn.execute(
                """
                DELETE FROM daily_site_reports
                WHERE message_id = %s
                """,
                (message_id,),
            )
            conn.commit()

    def _soft_delete(self, message_id: str) -> None:
        with connect() as conn:
            conn.execute(
                """
                UPDATE daily_site_reports
                SET is_deleted = TRUE, updated_at = NOW()
                WHERE message_id = %s AND is_deleted = FALSE
                """,
                (message_id,),
            )
            conn.commit()

    def _upsert_report(
        self,
        *,
        message_id: str,
        group_jid: str,
        report: DailySiteReport,
        source_text: str,
    ) -> None:
        actual_num_workers = len(report.workers) + 1  # include RSS
        is_valid = (
            report.num_workers <= actual_num_workers
            and actual_num_workers - report.num_workers <= 1
        )
        metrics = report.cumulative_metrics

        with connect() as conn:
            conn.execute(
                """
                INSERT INTO daily_site_reports (
                    message_id, group_jid, report_date, po_number, ref_numbers,
                    contractor, project_name, rss, workers, num_workers,
                    actual_num_workers, valid_num_workers, work_scopes,
                    trench_length, coring_length, cable_pulling_length,
                    conduit_laying_length, trial_pit_count, remarks, source_text,
                    is_deleted, updated_at
                ) VALUES (
                    %s, %s, %s::date, %s, %s,
                    %s, %s, %s, %s, %s,
                    %s, %s, %s,
                    %s, %s, %s,
                    %s, %s, %s, %s,
                    FALSE, NOW()
                )
                ON CONFLICT (message_id) DO UPDATE SET
                    group_jid = EXCLUDED.group_jid,
                    report_date = EXCLUDED.report_date,
                    po_number = EXCLUDED.po_number,
                    ref_numbers = EXCLUDED.ref_numbers,
                    contractor = EXCLUDED.contractor,
                    project_name = EXCLUDED.project_name,
                    rss = EXCLUDED.rss,
                    workers = EXCLUDED.workers,
                    num_workers = EXCLUDED.num_workers,
                    actual_num_workers = EXCLUDED.actual_num_workers,
                    valid_num_workers = EXCLUDED.valid_num_workers,
                    work_scopes = EXCLUDED.work_scopes,
                    trench_length = EXCLUDED.trench_length,
                    coring_length = EXCLUDED.coring_length,
                    cable_pulling_length = EXCLUDED.cable_pulling_length,
                    conduit_laying_length = EXCLUDED.conduit_laying_length,
                    trial_pit_count = EXCLUDED.trial_pit_count,
                    remarks = EXCLUDED.remarks,
                    source_text = EXCLUDED.source_text,
                    is_deleted = FALSE,
                    updated_at = NOW()
                """,
                (
                    message_id,
                    group_jid,
                    report.date or None,
                    report.po_number,
                    list(report.ref_number),
                    report.contractor,
                    report.project_name,
                    report.rss,
                    list(report.workers),
                    report.num_workers,
                    actual_num_workers,
                    is_valid,
                    list(report.work_scopes),
                    metrics.trench_length,
                    metrics.coring_length,
                    metrics.cable_pulling_length,
                    metrics.conduit_laying_length,
                    metrics.trial_pit_count,
                    report.remarks,
                    source_text,
                ),
            )
            conn.commit()
