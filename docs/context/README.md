# Role context files

These are the **living memory** of the project, split by role so each agent loads
only the context it needs. They are committed to the repo, so every clone and every
session sees the same accumulated knowledge.

| File | Owner role | Holds |
| --- | --- | --- |
| [tech-lead.md](tech-lead.md) | Tech Lead | Architecture, stack, technical decisions, gotchas |
| [product.md](product.md) | Product Manager | Market, competitors, features, business, roadmap |
| [infrastructure.md](infrastructure.md) | IT / DevOps | Hosting, CI/CD, release workflow, tooling, costs |
| [design.md](design.md) | Designer | UX, visual design, interaction decisions |

## The rule

**Whenever you learn something durable during work, append it to your role's file.**
A "durable learning" is anything a future session would waste time rediscovering: a
non-obvious decision and its reason, a gotcha, a constraint, a fixed bug's root cause,
a market fact, a design rationale.

Keep entries short and dated. Newest at the top of the relevant section. Don't paste
large code or logs; link to files/commits instead. See [../../CLAUDE.md](../../CLAUDE.md)
for how roles and the workflow fit together.
