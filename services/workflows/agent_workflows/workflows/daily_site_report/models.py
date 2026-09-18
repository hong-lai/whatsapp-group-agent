from __future__ import annotations

import re
from typing import Annotated, List, Optional

from pydantic import BaseModel, Field, field_validator


class ClassifiedResult(BaseModel):
    relevant: bool = Field(
        description="Whether the message is relevant information of the daily site report."
    )


_METRIC_NUMBER_RULE = (
    "A space or line break BETWEEN digits JOINS them; it is never a decimal. "
    "3 8米 → 38 (not 3.8); 1 9米 → 19 (not 1.9). "
    "Only a real decimal point ( . or ． ) starts a fractional part: 3.8米 → 3.8. "
    "Ignore parenthetical notes such as （正在cor第四條） or （A）. "
    "If written as a sum of parts (e.g. 26.3（A）+7.5（B）), output the total (33.8). "
    "Missing/blank/**/＊/N/A/- → 0."
)


class CumulativeMetrics(BaseModel):
    trench_length: float = Field(
        description=(
            "Cumulative trench length in meters from 累計開坑長度. "
            + _METRIC_NUMBER_RULE
        )
    )
    coring_length: float = Field(
        description=(
            "Cumulative coring length in meters from 累計Coring長度. "
            + _METRIC_NUMBER_RULE
        )
    )
    cable_pulling_length: float = Field(
        description=(
            "Cumulative cable-pulling length in meters from 累計拉線長度. "
            + _METRIC_NUMBER_RULE
        )
    )
    conduit_laying_length: float = Field(
        description=(
            "Cumulative conduit-laying length in meters from 累計放筒長度. "
            + _METRIC_NUMBER_RULE
        )
    )
    trial_pit_count: int = Field(
        description=(
            "Cumulative trial-pit count from 累計探窿數量. "
            + _METRIC_NUMBER_RULE
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


_FULLWIDTH_DIGITS = str.maketrans("０１２３４５６７８９", "0123456789")
_METRIC_LABELS: tuple[tuple[str, re.Pattern[str], bool], ...] = (
    ("trench_length", re.compile(r"累計開坑長度\s*[：:]"), False),
    ("coring_length", re.compile(r"累計\s*Coring\s*長度\s*[：:]", re.IGNORECASE), False),
    ("cable_pulling_length", re.compile(r"累計拉線長度\s*[：:]"), False),
    ("conduit_laying_length", re.compile(r"累計放筒長度\s*[：:]"), False),
    ("trial_pit_count", re.compile(r"累計探窿數量\s*[：:]"), True),
)
_NEXT_METRIC_CHUNK = re.compile(
    r"\n\s*(?:累計|備注|備註|日期|承辦商|項目名稱|開工人數|工作內容|"
    r"PO\b|Ref\b|RSS\b|Foreman\b|工人|司機|科文|主管|管工)",
    re.IGNORECASE,
)
_PLACEHOLDER_VALUE = re.compile(
    r"^(?:\*\*|＊{1,2}|\*|N/?A|n/?a|—+|–+|-+|／+|/{2,}|無|沒有)\s*$"
)
_METRIC_UNIT = re.compile(r"^(?:米|m|個|pcs|pc)\b", re.IGNORECASE)


def parse_labeled_cumulative_metrics(text: str) -> dict[str, float | int]:
    """Join spaced/wrapped digits in 累計 metric values.

    累計Coring長度：3 8米 （正在cor第四條） → coring_length=38 (not 3.8)
    """
    parsed: dict[str, float | int] = {}
    for field, pattern, as_int in _METRIC_LABELS:
        match = pattern.search(text)
        if not match:
            continue
        chunk = _metric_value_chunk(text[match.end() :])
        value = _parse_metric_amount(chunk)
        parsed[field] = int(round(value)) if as_int else value
    return parsed


def _metric_value_chunk(rest: str) -> str:
    stop = _NEXT_METRIC_CHUNK.search(rest)
    return rest[: stop.start()] if stop else rest


def _parse_metric_amount(raw: str) -> float:
    s = raw.translate(_FULLWIDTH_DIGITS)
    total = 0.0
    found = False
    while s:
        s = s.lstrip(" \t\r\n\u3000\xa0\u200b")
        if not s:
            break
        if s[0] in "(（":
            s = _skip_parens(s)
            continue
        if s[0] in "+＋" or s.startswith("加"):
            s = s[1:]
            continue
        if found and _METRIC_UNIT.match(s):
            break
        if not found and _PLACEHOLDER_VALUE.match(_placeholder_head(s)):
            return 0.0
        number, rest = _parse_joined_number(s)
        if number is None:
            if found:
                break
            s = s[1:]
            continue
        total += number
        found = True
        s = rest
    return total if found else 0.0


def _placeholder_head(s: str) -> str:
    first_line = s.splitlines()[0] if s else s
    unit = _METRIC_UNIT.search(first_line)
    head = first_line[: unit.start()] if unit else first_line
    return re.sub(r"[\s\u3000]+", "", head.split("（", 1)[0].split("(", 1)[0])


def _skip_parens(s: str) -> str:
    close = ")" if s[0] == "(" else "）"
    idx = s.find(close)
    return s[idx + 1 :] if idx >= 0 else ""


def _parse_joined_number(s: str) -> tuple[float | None, str]:
    int_digits: list[str] = []
    frac_digits: list[str] = []
    seen_decimal = False
    started = False
    i = 0
    while i < len(s):
        ch = s[i]
        if ch.isdigit():
            started = True
            (frac_digits if seen_decimal else int_digits).append(ch)
            i += 1
        elif ch in ".\uff0e" and not seen_decimal:
            started = True
            seen_decimal = True
            i += 1
        elif ch == "," and started and not seen_decimal:
            seen_decimal = True
            i += 1
        elif ch.isspace() or ch in "\u3000\xa0\u200b":
            i += 1
        else:
            break
    if not int_digits and not frac_digits:
        return None, s
    int_part = "".join(int_digits) or "0"
    if seen_decimal:
        return float(f"{int_part}.{''.join(frac_digits)}"), s[i:]
    return float(int_part), s[i:]


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
            "Aggregated progress metrics from 累計* labels. "
            "Spaces/line breaks between digits JOIN (3 8米 → 38, never 3.8). "
            "Only '.' / '．' is a decimal. Ignore parenthetical notes. "
            "Sums of parts become the total. Missing/** → 0."
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
