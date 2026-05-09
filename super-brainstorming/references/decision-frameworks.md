# Decision Frameworks Reference

Use these when the standard decision matrix isn't enough.

---

## RICE Scoring (for feature prioritization)

**Reach × Impact × Confidence ÷ Effort**

| Field | Description | Scale |
|-------|-------------|-------|
| Reach | How many users affected per period? | # users/month |
| Impact | How much does this move the needle? | 0.25 / 0.5 / 1 / 2 / 3 |
| Confidence | How sure are we about R/I estimates? | 50% / 80% / 100% |
| Effort | Person-months to ship | # months |

**When to use:** Prioritizing a backlog of features. Great for product decisions.

---

## MoSCoW (for scope decisions)

- **Must Have** — non-negotiable for v1
- **Should Have** — important, but v1 ships without it
- **Could Have** — nice to have if effort is low
- **Won't Have (now)** — explicitly out of scope

**When to use:** When scope is ballooning and you need to cut ruthlessly.

---

## Jobs-to-be-Done (for user-centered design)

Frame every feature as: *"When [situation], I want to [motivation], so I can [expected outcome]."*

Example: "When a customer requests a demo, I want to provision it automatically, so I can avoid manual setup overhead."

**When to use:** When you're not sure what the user really wants — strip features back to motivations.

---

## Reversibility Test (for risky decisions)

Ask: **"Is this a one-way or two-way door?"**

- **Two-way door** (reversible): Decide fast, bias toward action, optimize later.
- **One-way door** (irreversible): Slow down, think harder, get consensus.

Examples:
- Choosing a DB schema: **one-way** (migrations are painful)
- Choosing a package: **two-way** (can swap later)
- Going multi-tenant: **one-way**
- Adding a field: **two-way**

---

## Cynefin Framework (for problem classification)

| Domain | Nature | Response |
|--------|--------|----------|
| **Simple** | Clear cause-effect | Apply best practice |
| **Complicated** | Knowable with expertise | Analyze, then apply good practice |
| **Complex** | Unknown until acted upon | Probe → Sense → Respond (experiment first) |
| **Chaotic** | No cause-effect | Act first to stabilize, then sense |

**When to use:** When you're not sure whether to plan or prototype. If it's Complex → build a spike first.

---

## Pre-Mortem (for risk discovery)

Imagine it's 6 months from now and the project **failed catastrophically**.

Ask: *"What went wrong?"*

List all the ways it could have failed:
- Technical failures
- Adoption failures  
- Scope creep
- Wrong assumptions
- Team/resource problems

Then: for each failure mode, what can we do NOW to prevent it?

---

## Trade-off Triangle (pick 2)

Classic constraints:
- **Fast** (speed to ship)
- **Good** (quality / correctness)
- **Cheap** (low effort / cost)

Advanced version for software:
- **Flexibility** (easy to change later)
- **Performance** (fast at runtime)
- **Simplicity** (easy to understand)

You can only fully optimize 2. Be explicit about which one you're sacrificing.