from __future__ import annotations

from .base import Workflow
from .config import settings
from .workflows.daily_site_report import DailySiteReportWorkflow

# Register new workflows here. Enable/disable via ENABLED_WORKFLOWS env.
_AVAILABLE: dict[str, type[Workflow]] = {
    DailySiteReportWorkflow.name: DailySiteReportWorkflow,
}


def load_enabled_workflows() -> list[Workflow]:
    enabled = settings.enabled_workflow_names()
    workflows: list[Workflow] = []
    for name in enabled:
        cls = _AVAILABLE.get(name)
        if cls is None:
            raise KeyError(
                f"Unknown workflow '{name}'. Available: {sorted(_AVAILABLE)}"
            )
        workflows.append(cls())
    return workflows


def available_workflow_names() -> list[str]:
    return sorted(_AVAILABLE)
