"""Redis pub/sub helpers for dashboard notifications (no WhatsApp outbound)."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any, Literal

import redis

from .config import settings

logger = logging.getLogger(__name__)

REPORT_PROCESSED_CHANNEL = "report.processed"

ReportAction = Literal["extracted", "updated", "deleted"]

_client: redis.Redis | None = None


def _redis() -> redis.Redis:
    global _client
    if _client is None:
        _client = redis.from_url(settings.redis_url, decode_responses=True)
    return _client


def publish_report_change(
    *,
    action: ReportAction,
    message_id: str,
    group_jid: str | None,
    po_number: str | None = None,
    report_date: str | None = None,
    contractor: str | None = None,
    report_id: int | None = None,
) -> None:
    payload: dict[str, Any] = {
        "action": action,
        "messageId": message_id,
        "groupJid": group_jid,
        "poNumber": po_number,
        "date": report_date,
        "contractor": contractor,
        "reportId": report_id,
        "at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        _redis().publish(REPORT_PROCESSED_CHANNEL, json.dumps(payload, ensure_ascii=False))
    except Exception:
        logger.exception("Failed to publish %s", REPORT_PROCESSED_CHANNEL)


# Back-compat alias used by earlier extract-only notify.
def publish_report_processed(
    *,
    message_id: str,
    group_jid: str,
    po_number: str | None,
    report_date: str | None,
    contractor: str | None,
    report_id: int | None = None,
    action: ReportAction = "extracted",
) -> None:
    publish_report_change(
        action=action,
        message_id=message_id,
        group_jid=group_jid,
        po_number=po_number,
        report_date=report_date,
        contractor=contractor,
        report_id=report_id,
    )
