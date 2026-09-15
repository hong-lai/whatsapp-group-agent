from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class Workflow(ABC):
    """Pluggable message workflow. Add a new package and register it to enable."""

    name: str

    def matches(self, job: dict[str, Any], message: dict[str, Any] | None) -> bool:
        """Return True if this workflow should handle the job.

        Override to filter by message_type, group, media, etc.
        Default: text-capable events only; deletes always match so results can clear.
        """
        event = job.get("event")
        if event == "message.deleted":
            return True
        if message is None:
            return False
        if message.get("is_deleted"):
            return True
        text = (message.get("text_content") or "").strip()
        return bool(text)

    @abstractmethod
    async def handle(
        self,
        job: dict[str, Any],
        message: dict[str, Any] | None,
    ) -> str:
        """Process the job. Return a short status string for workflow_runs.detail."""
