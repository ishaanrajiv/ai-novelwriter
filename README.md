# AI Novel Writer (MVP)

CLI-first novel generation pipeline in TypeScript (Bun), using:
- OpenRouter SDK provider: `@openrouter/ai-sdk-provider`
- Vercel AI SDK: `ai`

## Requirements

- Bun 1.3+
- OpenRouter API key

## Environment

```bash
export OPENROUTER_API_KEY="your-key"
# optional
export OPENROUTER_HTTP_REFERER="https://your-app.example"
export OPENROUTER_APP_NAME="AI Novel Writer"
```

## Install

```bash
bun install
```

## Build / Check / Test

```bash
bun run build
bun run typecheck
bun test
```

## CLI Commands

```bash
ai-novelwriter new
ai-novelwriter run --config ./config.example.yaml
ai-novelwriter resume --project-id <projectId>
ai-novelwriter regen --project-id <projectId> --target outline
ai-novelwriter regen --project-id <projectId> --target blocks --chapter 3
ai-novelwriter regen --project-id <projectId> --target chapter --chapter 5
ai-novelwriter regen --project-id <projectId> --target block --chapter 5 --block 2
ai-novelwriter export epub --project-id <projectId>
ai-novelwriter status --project-id <projectId>
ai-novelwriter list
```

Global options:
- `--artifacts-root <path>` default: `.artifacts/novels`
- `--model <openrouter-model-id>` overrides all stage models for the run

## Artifact Layout

Projects are stored under:

```text
.artifacts/novels/<projectId>/
```

Each project contains:
- `project.yaml`
- `inputs/user-input.json`
- `manifest.json`
- `logs/events.jsonl`
- `stage1-outline/*`
- `stage2-blocks/*`
- `stage3-chapters/*`
- `exports/epub/*`

## Notes

- Resume skips completed checkpoints by default.
- Regeneration creates versioned `attempt-xxx` artifacts and updates active pointers.
- Pipeline runs auto-export EPUB after chapter generation completes.
