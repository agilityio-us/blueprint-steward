# Blueprint Steward

Steward is the part of Blueprint a team runs beside its own codebase. Blueprint turns
a work item into a design and the design into code; its server decides what happens next, and Steward acts for it
with the team's own keys: it extracts the code graph, runs the design agent, opens branches and pull requests,
comments on tickets and fires implementation routines. The server never holds the team's source or write access to
it, and never connects in: Steward polls out.

What runs in your environment with your keys should be auditable, so Steward is open source under the MIT license.

## Layout

| Path | What |
| - | - |
| `packages/steward` | `@bett3r-dev/blueprint-steward`: the `blueprint-steward` CLI (`bin/`, `lib/`) and the two MCP servers it starts for a design agent (`mcp/`): `blueprint-mcp`, the hosted design session, and `blueprint-repo-mcp`, read-only git history |
| `packages/spec` | `@bett3r-dev/blueprint-spec`: what the Blueprint server and Steward agree on (routes, job kinds and steps, report reasons, signals, exit codes, wire types) |
| `docs/` | The operator's guide: what Steward does, what it touches, its environment and its egress |
| `Dockerfile`, `deploy/docker` | The image |
| `deploy/compose`, `deploy/helm` | Install kits for one Docker host or a Kubernetes cluster |

## Develop

Node 24 and npm.

```sh
npm install
npm test                 # vitest; the suite spawns git and sh, so run it on Linux or macOS
npm run typecheck        # the MCP servers' TypeScript
npm run build            # bundles Steward into packages/steward/dist
node packages/steward/bin/blueprint-steward.mjs --help
docker build -t blueprint-steward:local .
```

Start with [docs/README.md](docs/README.md) to run it.
