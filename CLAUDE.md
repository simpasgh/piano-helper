# Piano Helper

Turn piano sheet music into a Synthesia-style falling-notes performance with a synced
sheet view. See [README.md](README.md) for the product and [docs/context/](docs/context/)
for accumulated knowledge.

## How this project is run: role-based context

Work is split across four roles, each backed by a **subagent** with its own isolated
context window and a committed **context file** it owns. Delegate to the matching role so
context stays split and focused.

| Role | Subagent | Owns context file | Use for |
| --- | --- | --- | --- |
| **Tech Lead** | `tech-lead` | [docs/context/tech-lead.md](docs/context/tech-lead.md) | Architecture, code, technical decisions, code review |
| **Product Manager** | `product-manager` | [docs/context/product.md](docs/context/product.md) | Market, competitors, features, business, roadmap |
| **IT / DevOps** | `it-support` | [docs/context/infrastructure.md](docs/context/infrastructure.md) | Hosting, CI/CD, releases, tooling, costs |
| **Designer** | `designer` | [docs/context/design.md](docs/context/design.md) | UX, visual design, interaction |

The main agent plans and integrates; it hands bounded work to these roles (Operator /
Agent-Teams pattern).

## Cardinal rule: save context when you learn

**Every session, every role: when you learn something durable, append it to the matching
context file before you finish.** Durable = anything a future session would waste time
rediscovering (a non-obvious decision + why, a gotcha, a constraint, a bug's root cause, a
market fact, a design rationale). Keep entries short and dated, newest first. The
`/save-context` command helps route a learning to the right file.

## Hard constraints

- **Free tooling only**, no caps or only very large ones. Never add a paid service. See
  [docs/context/infrastructure.md](docs/context/infrastructure.md).
- **No em dashes** in generated text (project + user style).

## Release & merge workflow

Full SOP: [docs/workflow.md](docs/workflow.md). Non-negotiables:

1. **Trunk-based.** `main` is always releasable. Do work on short-lived branches
   `type/short-desc` (e.g. `feat/omr-upload`). For parallel work, use **git worktrees** so
   branches don't collide.
2. **Rebase, don't merge-commit.** Before opening/updating a PR, `git fetch` and
   `git rebase origin/main`. History stays **linear** (enforced by ruleset).
3. **Tests + review before merge.** Every change ships with tests. CI (typecheck + build +
   unit tests) must pass, and the **Tech Lead reviews locally** (`/code-review`, plus
   `/security-review` for sensitive changes) before merge.
4. **Merge only an up-to-date branch.** The ruleset requires the branch to be current with
   `main`, so a parallel merge can never silently override yours. Resolve by rebasing.
5. **Release = `/release`.** It rebases, runs tests + review, opens/merges the PR, then
   deploy + a **prod smoke test** (`/smoke-test`) run automatically. Investigate any smoke
   failure immediately; `main` must stay green.

Do not push or merge directly to `main` outside this flow.

## Commands

- `/release [version]` — run the full gated release.
- `/smoke-test [url]` — hit the live prod URL and assert the app loads and plays.
- `/save-context` — record a learning into the right role context file.

## Dev quickstart

```bash
npm install
npm run dev      # local app
npm test         # unit tests
npm run build    # typecheck + production build
```
