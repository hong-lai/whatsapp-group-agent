FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY pyproject.toml .
COPY agent_workflows ./agent_workflows

# Confidential prompts are mounted at runtime from ./agent-workflows/private
ENV DAILY_SITE_REPORT_PROMPTS_DIR=/app/private/daily_site_report

CMD ["python", "-m", "agent_workflows.worker"]
