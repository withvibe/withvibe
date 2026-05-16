# withvibe

CLI to run a withvibe environment locally — clones the repos defined by the
env, boots its `docker-compose` stack, and opens it in VSCode.

Binary name: `withvibe`.

## Install (from source)

```bash
pnpm --filter withvibe build
node packages/cli/dist/index.js --help
```

To use the `withvibe` name globally, link the package:

```bash
cd packages/cli && pnpm link --global
withvibe --help
```

## Commands

### `withvibe login`

Authorize this machine against a withvibe server. Stores a CLI token in your
OS keyring (or falls back to a config file).

```bash
withvibe login
withvibe login --force        # re-auth even if a token exists
withvibe --server <url> login # point at a non-default server
```

### `withvibe env <envId>`

Set up the given env on this machine: pre-flight checks, GitHub-account
confirmation, repo cloning, port allocation, then `docker compose up -d`, and
finally launches VSCode.

```bash
withvibe env env_abc123
withvibe env env_abc123 --no-open  # skip VSCode launch
```

## Configuration

| Flag / env var | Purpose | Default |
| --- | --- | --- |
| `--server <url>` / `WITHVIBE_SERVER` | Withvibe web server URL | `http://localhost:3000` |

## How it works

1. **Preflight** — checks `git`, `docker`, `gh`, and `code` are on `PATH`.
2. **GitHub auth** — uses `gh auth status` to show which account git will use, with a prompt to switch.
3. **Repo clone** — clones each repo declared by the env into a per-env workspace folder.
4. **Ports** — allocates host ports and wires them into the compose project.
5. **`docker compose up -d`** — starts the env's services.
6. **VSCode** — opens the workspace folder.

## Links

- Website / docs: <https://withvibe.dev>

## License

Elastic License 2.0 — see the [root LICENSE](../../LICENSE).
