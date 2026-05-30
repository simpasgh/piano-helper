---
description: Record a durable learning into the right role context file
argument-hint: "[the learning to save]"
allowed-tools: Read, Edit, Grep, Glob
---

Persist a learning so future sessions don't rediscover it. Learning: `$ARGUMENTS`

1. Decide which role owns it and pick the file:
   - Technical (architecture, code, gotcha, bug root cause) -> `docs/context/tech-lead.md`
   - Product (market, competitor, feature, scope, business) -> `docs/context/product.md`
   - Infra (hosting, CI/CD, tooling, costs, limits) -> `docs/context/infrastructure.md`
   - Design (UX, visual, interaction) -> `docs/context/design.md`
   - If it spans roles, save the relevant part to each.
2. Append a **short, dated** entry (`YYYY-MM-DD`) at the top of the most relevant section,
   newest first. Link to files/commits instead of pasting large code or logs.
3. Confirm which file(s) you updated and show the entry you added.

If `$ARGUMENTS` is empty, review what happened this session and save anything durable that is
not already captured.
