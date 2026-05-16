# AI Novel Writer

CLI-first novel generation pipeline in TypeScript (Bun), now with:
- LM Studio local models (default, OpenAI-compatible endpoint)
- OpenRouter (optional provider)
- Iterative planner-style generation loop with resumable checkpoints

## Requirements

- Bun 1.3+
- LM Studio running local server (`http://127.0.0.1:1234/v1`) OR OpenRouter API key

## Setup

1. Install dependencies:
```bash
bun install
```

2. Create env file:
```bash
cp .env.example .env
```

3. Start LM Studio local server (default provider):
- Launch LM Studio
- Load a model
- Start server at `http://127.0.0.1:1234/v1`

4. Optional OpenRouter setup (if using `provider.type=openrouter`):
```bash
export OPENROUTER_API_KEY="your-key"
export OPENROUTER_HTTP_REFERER="https://your-app.example"
export OPENROUTER_APP_NAME="AI Novel Writer"
export OPENROUTER_SESSION_ID="novelwriter-session-001"
export NOVELWRITER_OPENROUTER_TIMEOUT_MS="120000" # optional, default 120s
```

## Environment

- `provider.type=lmstudio`: no required env vars (optional `LMSTUDIO_API_KEY`)
- `provider.type=openrouter`: requires `OPENROUTER_API_KEY`
- OpenRouter session grouping:
  - By default, session ID is auto-generated per project as `book-<projectId>`.
  - Optional override: set `OPENROUTER_SESSION_ID` to force a custom session ID.
- OpenRouter request timeout:
  - Default is `120s` (`120000ms`).
  - Optional override: set `NOVELWRITER_OPENROUTER_TIMEOUT_MS`.

## Running

```bash
./ai-novelwriter --help
./ai-novelwriter new --advanced
./ai-novelwriter run --config ./config.example.yaml
```

Global options:
- `--artifacts-root <path>` default: `.artifacts/novels`
- `--model <model-id>` overrides all stage models
- `--provider <lmstudio|openrouter>` overrides configured provider

## Pipeline Stages

1. `premise_expansion`
2. `story_summary`
3. `chapter_outline`
4. `chapter_loop`
5. `global_revision`
6. `export_epub`

Each major stage iterates with generator/critic/reviser passes until convergence policy is met, `iterationPolicy.maxPassesPerStage` is reached (default `3`), or stagnation is detected (`stagnationPassStart`, `stagnationChangeThreshold`) when revisions are nearly unchanged.

## Artifact Layout

```text
.artifacts/novels/<projectId>/
  stage0-premise/
  stage1-summary/
  stage2-outline/
  stage3-chapters/
  stage4-global-revision/
  planner/
  exports/epub/
```
