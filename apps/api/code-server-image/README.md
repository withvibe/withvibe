# withvibe-code-server image

Custom code-server image for the per-env "Open in VS Code (Browser)" action.
Pre-installs the Claude Code extension so users get an LLM-aware editor on first
open. Lives behind `CodeServerService` (`apps/api/src/docker/code-server.service.ts`).

## Build

```sh
docker build -t withvibe-code-server apps/api/code-server-image
```

Set `CODE_SERVER_IMAGE` in the API environment if you want to pin a different
tag (e.g. a registry-hosted build). Otherwise `CodeServerService` defaults to
`withvibe-code-server:latest` and falls back to upstream
`codercom/code-server:latest` if the local image is missing.

## Why a custom image

- pre-install `anthropic.claude-code` extension
- bake in `git`, `ripgrep`, `jq` so the integrated terminal is useful out of the box
