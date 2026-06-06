# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Note: the `withvibe` CLI lives in its own repository
> ([withvibe/withvibe-cli](https://github.com/withvibe/withvibe-cli), Apache 2.0)
> and is published to npm independently of the monorepo.

## [Unreleased]

## [0.4.2] - 2026-06-05

### Fixed

- Web: chat messages no longer overflow the panel on wide tool diffs or long
  file paths — assistant bubbles are width-constrained so inner diff regions
  scroll instead of widening the bubble.

## [0.4.1] - 2026-06-05

### Added

- Plugins can declare `agentInstructions` in their manifest; when a plugin is
  enabled in an env, those rules are folded into the chat system prompt so the
  agent knows _when_ to use the plugin's tools (e.g. an approval/voting flow).

### Changed

- Demo workspace names are personalized per owner instead of a shared name.
- A built env defaults its chat to the Orchestrator ("Build") session.

## [0.4.0] - 2026-06-05

### Added

- Personal Anthropic API key: each user can store their own key on the Account
  page (masked; set/replace/remove). Runs resolve the speaker's personal key
  first, then the workspace key, then the server's `ANTHROPIC_API_KEY`.
- Service-readiness indicator: envs surface when the service _inside_ the
  container is actually answering (via container healthchecks), not just that
  the container is up — with a "Service starting…" chip and preview overlay.

## [0.3.4] - 2026-06-05

### Changed

- New workspaces default to Sonnet 4.6 instead of `auto`.

### Fixed

- Stop leaking a dev `apps/api/.env` into the API image, which could point the
  plugin marketplace at a local URL and 500 the catalog in production.

## [0.3.3] - 2026-06-05

### Changed

- Demo aquarium template runs the dev server with the source bind-mounted, so
  the agent's code edits hot-reload in seconds instead of needing a rebuild.

## [0.3.2] - 2026-06-05

### Changed

- Demo envs seed an Orchestrator session so visitors reach the agent that can
  edit application code by default.

## [0.3.1] - 2026-06-05

### Changed

- Demo mode auto-starts the env after provisioning.

### Fixed

- Traefik container is now auto-discovered by its Compose service label; the old
  hard-coded default bypassed discovery and 504'd isolated envs.

## [0.1.11] - 2026-05-18

### Added

- Single-label env subdomains (`<service>-<short>.<base>`) to match
  single-label wildcard DNS/TLS.
- Decoupled env routing base domain (`WITHVIBE_ROUTING_BASE_DOMAIN`), so the
  env-subdomain wildcard can sit at a different level than the platform UI host
  to match an operator's TLS certificate.

### Fixed

- Quieter upgrade rollback: `pg_dump` uses `--clean --if-exists --no-owner
  --no-privileges` so a restore over an existing DB no longer spews errors.

## [0.1.0] - 2026-05-16

Initial public, source-available release under the
[Elastic License 2.0](./LICENSE).

### Added

- Shared AI development environments: one-click, code-seeded, isolated
  workspaces with Claude as the primary collaborator.
- Live, shareable AI chat sessions per environment with multi-agent support
  (DevOps, QA, Security built-in agents) and an orchestrator mode.
- Security scan: a one-click review of an environment's code changes vs. its
  base branch, surfaced as a progress flow and a structured diagnostic.
- Git panel: per-repo status, diff viewer, commit/push, and PR helpers.
- Container orchestration for env runtimes, preview, logs, terminal, and a
  database viewer.
- `withvibe` CLI for installing and running the stack locally
  (independently published; latest CLI line: 0.1.x).
- Chrome QA browser extension for driving a real browser from the QA agent.

[Unreleased]: https://github.com/withvibe/withvibe/compare/v0.4.2...HEAD
[0.4.2]: https://github.com/withvibe/withvibe/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/withvibe/withvibe/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/withvibe/withvibe/compare/v0.3.4...v0.4.0
[0.3.4]: https://github.com/withvibe/withvibe/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/withvibe/withvibe/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/withvibe/withvibe/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/withvibe/withvibe/compare/v0.1.11...v0.3.1
[0.1.11]: https://github.com/withvibe/withvibe/compare/v0.1.0...v0.1.11
[0.1.0]: https://github.com/withvibe/withvibe/releases/tag/v0.1.0
