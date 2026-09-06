from __future__ import annotations

from contextlib import contextmanager
from typing import Any, Iterator

import psycopg
from psycopg.rows import dict_row

from .config import settings


@contextmanager
def connect() -> Iterator[psycopg.Connection]:
    with psycopg.connect(settings.database_url, row_factory=dict_row) as conn:
        yield conn


def get_message(message_id: str) -> dict[str, Any] | None:
    with connect() as conn:
        row = conn.execute(
            """
            SELECT
                message_id,
                group_jid,
                message_type,
                text_content,
                media_path,
                is_deleted,
                is_edited,
                is_history,
                is_forwarded
            FROM messages
            WHERE message_id = %s
            """,
            (message_id,),
        ).fetchone()
        return dict(row) if row else None


def record_workflow_run(
    *,
    workflow_name: str,
    message_id: str,
    event: str,
    status: str,
    detail: str | None = None,
    group_jid: str | None = None,
) -> None:
    from .events import publish_workflow_status

    with connect() as conn:
        conn.execute(
            """
            INSERT INTO workflow_runs (workflow_name, message_id, event, status, detail)
            VALUES (%s, %s, %s, %s, %s)
            """,
            (workflow_name, message_id, event, status, detail),
        )
        resolved_group = group_jid
        if resolved_group is None:
            row = conn.execute(
                "SELECT group_jid FROM messages WHERE message_id = %s",
                (message_id,),
            ).fetchone()
            if row:
                resolved_group = row.get("group_jid")
        conn.commit()

    publish_workflow_status(
        workflow_name=workflow_name,
        message_id=message_id,
        event=event,
        status=status,
        detail=detail,
        group_jid=resolved_group,
    )
