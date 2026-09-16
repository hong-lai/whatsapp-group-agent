from __future__ import annotations

import re
from typing import Annotated, List, Optional

from pydantic import BaseModel, Field, field_validator


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


# RefNumberStr = Annotated[
#     str, Field(pattern=r"^[A-Z]{4,5}-\d{5,6}-\d{3,4}[A-Z]?$")
# ]

# Punctuation between people. CJK runs have no internal space; Latin names may.
_WORKER_SEP = re.compile(r"[,，、;/；]+")
_WORKER_TOKEN = re.compile(
    r"[A-Za-z][A-Za-z'.\-]*(?:\s+[A-Za-z][A-Za-z'.\-]*)*"
    r"|[\u3400-\u9FFF\uF900-\uFAFF]+"
)


def split_worker_names(names: List[str]) -> List[str]:
    """Split merged worker entries so spaced CJK names become separate people.

    Latin given+family names ("John Smith") stay one item. A space between CJK
    runs ("張偉明 林美玲") is a person separator.
    """
    split: List[str] = []
    for raw in names:
        if not isinstance(raw, str):
            continue
        for chunk in _WORKER_SEP.split(raw):
            chunk = chunk.strip()
            if not chunk:
                continue
            tokens = [match.group(0).strip() for match in _WORKER_TOKEN.finditer(chunk)]
            split.extend(tokens or [chunk])
    return split


_DATE_LABEL = re.compile(r"日期\s*[：:]")


def parse_labeled_report_date(text: str) -> str | None:
    """Join spaced/wrapped digits in a 日期 value into YYYY-MM-DD.

    2026年09月1 6日（星期三） → 2026-09-16
    """
    match = _DATE_LABEL.search(text)
    if not match:
        return None
    rest = text[match.end() :]
    year, rest = _digits_until(rest, "年")
    month, rest = _digits_until(rest, "月")
    day, _ = _digits_until(rest, "日號号")
    if day is None:
        day = _leading_digits(rest)
    if not year or not month or not day or len(year) != 4:
        return None
    try:
        year_n, month_n, day_n = int(year), int(month), int(day)
    except ValueError:
        return None
    if not (1 <= month_n <= 12 and 1 <= day_n <= 31):
        return None
    return f"{year_n:04d}-{month_n:02d}-{day_n:02d}"


def _digits_until(s: str, stops: str) -> tuple[str | None, str]:
    digits: list[str] = []
    for i, ch in enumerate(s):
        if ch in stops:
            return ("".join(digits) or None, s[i + 1 :])
        if ch.isdigit():
            digits.append(ch)
        elif ch.isspace() or ch == "\u3000":
            continue
        elif digits:
            return ("".join(digits), s[i:])
    return ("".join(digits) or None, "")


def _leading_digits(s: str) -> str:
    digits: list[str] = []
    started = False
    for ch in s:
        if ch.isdigit():
            digits.append(ch)
            started = True
        elif ch.isspace() or ch == "\u3000":
            continue
        elif started:
            break
    return "".join(digits)


class DailySiteReport(BaseModel):
    date: str = Field(
        description=(
            "Report date from this message's 日期 value, YYYY-MM-DD. "
            "Scan left to right: all digits until 年 are YEAR, until 月 are MONTH, "
            "until 日/號/号 are DAY. Spaces or line breaks between digits JOIN "
            "(do not apply worker name-splitting to dates). "
            "DAY is every digit before 日/號/号, never only the first: "
            "2026年09月1 6日（星期三） → 2026-09-16 (not 2026-09-01); "
            "1 2號 → day 12 (not 01); 1 5號 → day 15 (not 01). "
            "Zero-padded months (09月) and weekday text are ignored after the day. "
            "Then zero-pad month and day. Discard 星期 and weekday text."
        )
    )
    po_number: str = Field(description="The Purchase Order (PO) identification number.")
    ref_number: List[str] = Field(
        description="A list of reference numbers associated with the project."
    )
    contractor: str = Field(description="The name of the contractor company.")
    project_name: str = Field(description="The name or location code of the project.")
    rss: str = Field(
        description=(
            "Name from the RSS line only. Not 主管 / 管工 / Foreman — those belong in workers."
        )
    )
    workers: List[str] = Field(
        description=(
            "Union of names from every 工人 / 司機 / 科文 / Foreman / 主管 / 管工 / 棚架工 "
            "line in the message, not only the 工人 line. A standalone 主管： line is a "
            "worker even when it appears above RSS and even when 工人/司機 also exist. "
            "主管 is not RSS. Exclude only the RSS person. Plain names only, no role "
            "prefixes. Do not omit 主管, 司機, or Foreman. One array item per person. "
            "Chinese/CJK names have no internal space: '張偉明 林美玲' is two people. "
            "Latin names may keep an internal space: 'John Smith' is one person."
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

    @field_validator("workers", mode="after")
    @classmethod
    def _split_spaced_cjk_names(cls, names: List[str]) -> List[str]:
        return split_worker_names(names)
