# AI Novel Writer (MVP)

CLI-first novel generation pipeline in TypeScript (Bun), using:
- OpenRouter SDK provider: `@openrouter/ai-sdk-provider`
- Vercel AI SDK: `ai`

## Requirements

- Bun 1.3+
- OpenRouter API key

## Environment

Use a local `.env` file (recommended):

```bash
cp .env.example .env
# then set OPENROUTER_API_KEY in .env
```

You can still use shell exports if you prefer:

```bash
export OPENROUTER_API_KEY="your-key"
export OPENROUTER_HTTP_REFERER="https://your-app.example"
export OPENROUTER_APP_NAME="AI Novel Writer"
```

If required env vars are missing at launch, the CLI prompts for them and saves to `.env`.

## Install

```bash
bun install
```

## Running The CLI

From project root (fastest local workflow):

```bash
./ai-novelwriter --help
./ai-novelwriter new
./ai-novelwriter new --advanced
./ai-novelwriter run --config ./config.example.yaml
```

Install globally once and call from anywhere:

```bash
bun run link:global
ai-novelwriter --help
# alias
novelwriter --help
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
ai-novelwriter new --advanced
ai-novelwriter run --config ./config.example.yaml
ai-novelwriter resume
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

`new` command option:
- `--advanced` asks advanced wizard arguments (model overrides, prompt template fields, block policy, retry policy). Without this flag, only core prompts are asked and advanced values use defaults.

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
- `resume` with no `--project-id` picks the most recently updated incomplete project.
- Regeneration creates versioned `attempt-xxx` artifacts and updates active pointers.
- Pipeline runs auto-export EPUB after chapter generation completes.
