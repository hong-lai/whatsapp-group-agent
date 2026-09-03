from __future__ import annotations

from pathlib import Path

from langchain_core.messages import SystemMessage
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.runnables import RunnableBranch, RunnableLambda, RunnablePassthrough
from langchain_openai import ChatOpenAI
from pydantic import SecretStr

from ...config import settings
from .models import ClassifiedResult, DailySiteReport


def _load_prompt(name: str) -> str:
    prompts_dir = Path(settings.daily_site_report_prompts_dir)
    path = prompts_dir / name
    if not path.is_file():
        raise FileNotFoundError(
            f"Missing confidential prompt file: {path}. "
            f"Copy the *.example.txt files into {prompts_dir} and fill in company prompts."
        )
    return path.read_text(encoding="utf-8")


def build_chain():
    model = ChatOpenAI(
        base_url=settings.llm_base_url,
        api_key=SecretStr(settings.llm_api_key),
        model=settings.llm_model,
        temperature=settings.llm_temperature,
    )
    model_with_thinking = model
    if settings.llm_enable_thinking:
        model_with_thinking = model.bind(extra_body={"enable_thinking": True})

    classifier = model.with_structured_output(ClassifiedResult)
    report_extractor = model_with_thinking.with_structured_output(DailySiteReport)

    classifier_prompt = _load_prompt("classifier_prompt.txt")
    extractor_prompt = _load_prompt("extractor_prompt.txt")

    classification_chat_template = ChatPromptTemplate.from_messages(
        [
            SystemMessage(content=classifier_prompt),
            ("human", "{user_input}"),
        ]
    )
    report_gen_chat_template = ChatPromptTemplate.from_messages(
        [
            SystemMessage(content=extractor_prompt),
            ("human", "{user_input}"),
        ]
    )

    classifier_chain = {
        "user_input": lambda x: x["user_input"]
    } | RunnablePassthrough.assign(
        classification=classification_chat_template | classifier
    )

    branch_chain = RunnableBranch(
        (
            lambda x: x["classification"].relevant is True,
            report_gen_chat_template | report_extractor,
        ),
        RunnableLambda(lambda _: None),
    )

    return classifier_chain | branch_chain
