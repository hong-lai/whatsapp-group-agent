from __future__ import annotations

from typing import Annotated, List, Optional

from pydantic import BaseModel, Field


class ClassifiedResult(BaseModel):
    relevant: bool = Field(
        description="Whether the message is relevant information of the daily site report."
    )


class CumulativeMetrics(BaseModel):
    trench_length: float = Field(
        description="The cumulative length of the trench in meters."
    )
    coring_length: float = Field(
        description="The cumulative length of the coring in meters."
    )
    cable_pulling_length: float = Field(
        description="The cumulative length of cable pulling in meters."
    )
    conduit_laying_length: float = Field(
        description="The cumulative length of conduit laying in meters."
    )
    trial_pit_count: int = Field(
        description="The cumulative count of trial pits excavated."
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
            "The aggregated metric measurements tracking construction progress "
            "for each contractor."
        )
    )
    remarks: Optional[str] = Field(
        default=None,
        description=(
            "Additional remarks/notes from 備注/備註. Keep original text including emoji; "
            "null if missing/empty."
        ),
    )
