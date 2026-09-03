# Agent workflows (Python BullMQ worker)

Deployed with the rest of the stack via docker compose. LM Studio stays on the host.

## Run

1. Put confidential prompts in `private/daily_site_report/`:
   - `classifier_prompt.txt`
   - `extractor_prompt.txt`  
   Or: `bash scripts/seed-prompts.sh` then replace placeholders.

2. Start LM Studio’s OpenAI-compatible server on the host (default `:1234`).

3. Start the stack:

```bash
docker compose up -d --build
```

`app` enqueues BullMQ jobs when `WORKFLOWS_ENABLED=true` (default in compose).  
`workflows` consumes them and calls LM Studio at `host.docker.internal:1234`.

```bash
docker compose logs -f workflows
```

## Toggle

| Goal | Setting |
|------|---------|
| Stop enqueueing | `WORKFLOWS_ENABLED=false` |
| Disable this workflow | `ENABLED_WORKFLOWS=` (empty) |
| Change model | `LLM_MODEL=...` in root `.env` |
| Stop worker only | `docker compose stop workflows` |

## Add / remove a workflow

1. Add `agent_workflows/workflows/<name>/` with a `Workflow` subclass  
2. Register in `agent_workflows/registry.py`  
3. Set `ENABLED_WORKFLOWS=daily_site_report,<name>`  
4. Rebuild: `docker compose up -d --build workflows`

## Confidentiality

- Real prompts live under `private/` (gitignored, bind-mounted read-only)
- They are **not** copied into the Docker image
- `prompts.example/` has non-secret placeholders only

## Local (optional, without Docker for the worker)

```bash
cd agent-workflows
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # use localhost Redis/Postgres ports
python -m agent_workflows.worker
```
