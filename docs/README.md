# Running Steward

Steward is the part of Blueprint you run beside your codebase. The Blueprint server decides what happens next and
holds no key of yours; Steward holds the keys and does the work, one claimed job at a time, in its own clone of your
repository. This page is for whoever installs and operates it.

## What it does

`blueprint-steward start` polls the server for jobs (`--interval`, 5 s by default) and runs each in its own git
worktree of the clone, at `<clone>.blueprint-worktrees/<session id>`. The kinds of job it runs:

| Kind | What Steward does |
| - | - |
| `design` | Brings the session's worktree to the job's branch, runs the repository's declared extractor (`designTooling.extract` in `.blueprint.config.json`), pushes the graph and diagnostics, downloads the method plugin the claim names and checks its sha256, then runs `claude -p` on the instructions the server serves, with `blueprint-mcp` pointed at the hosted session |
| `flush` | Commits the session's bundle to the branch with git plumbing, fast-forward only, never forced |
| `scaffold` | Runs the repository's declared scaffold command and commits what it wrote |
| `ticket-branch`, `pr-ready` | Creates a ticket's branch on origin (optionally with a draft pull request), or takes the draft out of draft, through `gh` |
| `git-poll`, `drop-worktree` | One merge poll now; removes an idle session's worktree |
| `tracker-poll`, `tracker-comment`, `tracker-transition`, `tracker-describe` | Reads and writes Jira, only with the whole Jira credential |
| `observability-read` | Runs the repository's declared `observability.read` command for a KPI lookup (30 s each) |
| `implementation-dispatch` | Fires a Claude routine for an alias it holds, with the text the server composed |

Beside the claim loop, a merge poll (`--merge-poll`, 300 s by default) fetches, reports the server's branches that
merged, closed or were deleted, and reads commit trailer signals off the branches the server lists.

`blueprint-steward push` extracts and pushes the graph once; `enqueue` queues a design job. `--help` lists every flag.

## What it touches

- **Your clone and its worktrees.** The `--repo` checkout's HEAD and working tree are never changed; jobs work in
  worktrees beside it. Commits Steward makes itself (flush, scaffold, ticket branches, agent-branch merges) are made
  with plumbing and pushed without force.
- **Commands your repository declares**, in `.blueprint.config.json`: the extractor, the scaffold command and the
  observability reader. They run with your environment, minus Steward's own secrets.
- **The design agent**: `claude -p`, started with only the tools the job names (`--tools`, `--allowedTools`),
  `--strict-mcp-config`, `--setting-sources project` and no session kept on disk. `--tool-ceiling` caps the tools any
  job may ask for. The agent's MCP server writes with a key the server minted for that job alone, never the org key.

What leaves the machine: the extracted graph and diagnostics, design operations, job reports, and the answers to jobs
the server composes (a tracker poll's tickets, an observability read's output). Source does not.

## Secrets

No child process inherits the org key (under either name), the Jira API token or any `BLUEPRINT_ROUTINE_*` variable,
or any variable whose value equals the `--token` value. Prefer the environment to `--token`, which puts the key in
the process's argv.

## Environment

| Variable | Needed | What |
| - | - | - |
| `BLUEPRINT_STEWARD_TOKEN` | yes | Your organization's Blueprint API key; `--token` overrides it |
| `CLAUDE_CODE_OAUTH_TOKEN` | for design jobs | The design agent's login, from `claude setup-token`. Steward never runs `claude --bare`, which drops it |
| `GH_TOKEN` (or `GITHUB_TOKEN`) | for GitHub | Fetch and push, open and ready pull requests, and see squash merges |
| `BITBUCKET_TOKEN`, or `BITBUCKET_USERNAME` and `BITBUCKET_APP_PASSWORD` | for Bitbucket | Merge and closure detection through the Bitbucket API |
| `BLUEPRINT_GIT_HOST` | no | `github` or `bitbucket`, when the remote URL does not say |
| `BLUEPRINT_JIRA_BASE_URL`, `BLUEPRINT_JIRA_EMAIL`, `BLUEPRINT_JIRA_API_TOKEN` | for tracker jobs | All three, or Steward claims no tracker job |
| `BLUEPRINT_ROUTINE_<ALIAS>_URL`, `BLUEPRINT_ROUTINE_<ALIAS>_TOKEN` | for dispatch | A routine's fire endpoint and its token, per alias; the claim names the aliases, never the values |
| `BLUEPRINT_MERGE_POLL_SECONDS` | no | The merge poll's period; `--merge-poll` overrides it |
| `BLUEPRINT_SESSION_ID` | no | Claim, push or enqueue for one session only |
| `BLUEPRINT_STEWARD_CLAUDE`, `BLUEPRINT_STEWARD_GH` | no | Other `claude` or `gh` binaries |

The image's entrypoint also reads `BLUEPRINT_SERVER` (the server's base URL), `BLUEPRINT_REPO_URL` (the repository
to clone; use https, since the server keys a repository by its normalized remote URL and an ssh host alias names a
different one), `BLUEPRINT_STEWARD_REF` (the branch the clone tracks; the default branch when empty) and
`GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL`. `BLUEPRINT_STEWARD_IMAGE` picks the image in the compose kit.

Steward was called the runner before it had its name. Each `BLUEPRINT_STEWARD_*` variable above is still read under
its former name, `BLUEPRINT_RUNNER_*`, when the new one is unset, with a deprecation line on stderr.

## Egress

Steward connects out to:

- the Blueprint server (`--server`);
- your git host: git over https, and its API through `gh` or `api.bitbucket.org`;
- your Jira site, when configured;
- your routines' fire endpoints, when configured;
- the LLM, through the `claude` CLI (the Anthropic API).

Commands your repository declares (the extractor, the scaffold command, the observability reader), and installs of
its dependencies through its package manager, reach whatever those commands reach.

## Install

- **Docker**: `docker build -t blueprint-steward:local .`, then [deploy/compose](../deploy/compose/compose.yaml) with
  a `.env` from [.env.example](../deploy/compose/.env.example).
- **Kubernetes**: the chart in [deploy/helm/blueprint-steward](../deploy/helm/blueprint-steward); set
  `image`, `env` and `secretName` (or `externalSecret`) in your values.
- **Without a container**: Node 24, git, `gh` and `claude` on the PATH, then
  `node packages/steward/bin/blueprint-steward.mjs start --server <url> --repo <clone>` from a checkout of this
  repository after `npm install`.

Run one Steward per repository and organization: two share one job queue and one clone.

## Later renames

The server's HTTP routes for Steward still say `runner` (`/api/blueprint/runner/claim`, `/runner/jobs/...`,
`/runner/signals`), as does the claim's `runnerVersion` field and the usage report's `cost_source: 'runner-sdk'`.
They change with the server, not here.
