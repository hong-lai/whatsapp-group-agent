from __future__ import annotations

from typing import Annotated, List, Optional

from pydantic import BaseModel, Field


class ClassifiedResult(BaseModel):
    relevant: bool = Field(
        description="Whether the message is relevant information of the daily site report."
    )


class CumulativeMetrics(BaseModel):
    trench_length: float = Field(
        description=(
            "Cumulative trench length in meters. "
            "If written as a sum of parts (e.g. 26.3（A）+7.5（B）), output the total (33.8)."
        )
    )
    coring_length: float = Field(
        description=(
            "Cumulative coring length in meters. "
            "If written as a sum of parts, output the total."
        )
    )
    cable_pulling_length: float = Field(
        description=(
            "Cumulative cable-pulling length in meters. "
            "If written as a sum of parts, output the total."
        )
    )
    conduit_laying_length: float = Field(
        description=(
            "Cumulative conduit-laying length in meters. "
            "If written as a sum of parts, output the total."
        )
    )
    trial_pit_count: int = Field(
        description=(
            "Cumulative trial-pit count. "
            "If written as a sum of parts, output the total."
        )
    )


RefNumberStr = Annotated[
    str, Field(pattern=r"^[A-Z]{4,5}-\d{5,6}-\d{3,4}[A-Z]?$")
]


class DailySiteReport(BaseModel):
    date: str = Field(description="The date of the report in YYYY-MM-DD format.")
    po_number: str = Field(description="The Purchase Order (PO) identification number.")
    ref_number: List[RefNumberStr] = Field(
        description="A list of reference numbers associated with the project."
    )
    contractor: str = Field(description="The name of the contractor company.")
    project_name: str = Field(description="The name or location code of the project.")
    rss: str = Field(
        description="The name of the Resident Site Staff (RSS) overseeing the project."
    )
    workers: List[str] = Field(
        description=(
            "All on-site people from 工人 / 司機 / 科文 / Foreman / 主管 / 管工. "
            "Plain names only, no role prefixes. Do not omit 主管, 司機, or Foreman."
        )
    )
    num_workers: int = Field(
        description=(
            "Integer headcount from the 開工人數 label only. "
            "Transcribe the labeled number after removing units such as 人/名. "
            "Independent of the workers list and rss; do not count names or adjust the value."
        )
    )
    work_scopes: List[str] = Field(
        description="The specific tasks or scopes of work performed (e.g., 挖掘, 清場)."
    )
    cumulative_metrics: CumulativeMetrics = Field(
        description=(
            "Aggregated progress metrics. When a metric value is written as a sum "
        )
    )
    remarks: Optional[str] = Field(
        default=None,
        description=(
            "Additional remarks/notes from 備注/備註. Keep original text including emoji; "
            "null if missing/empty."
        ),
    )
