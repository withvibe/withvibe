# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Note: the `withvibe` CLI lives in its own repository
> ([withvibe/withvibe-cli](https://github.com/withvibe/withvibe-cli), Apache 2.0)
> and is published to npm independently of the monorepo.

## [Unreleased]

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

[Unreleased]: https://github.com/withvibe/withvibe/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/withvibe/withvibe/releases/tag/v0.1.0
