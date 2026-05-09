---
name: super-brainstorming
description: >
  ELITE brainstorming and ideation skill — use this for ANY creative, architectural, or strategic
  problem-solving session. Far more powerful than basic brainstorming. Triggers on: "brainstorm",
  "think through", "help me design", "plan this", "explore ideas", "what's the best approach",
  "rancang", "pikirkan", "bagaimana cara", "eksplorasi ide", or any request to think deeply about
  a feature, system, product, or strategy BEFORE implementation. Also triggers when the user says
  "super-brainstorm" or "brainstorm canggih". ALWAYS use this before writing any significant code,
  architecture, or multi-step plan.
---

# Super Brainstorming — Elite Ideation Engine

## What Makes This Different

This is not a simple Q&A process. This is a **structured thinking engine** that combines:
- **First Principles Thinking** — break assumptions, rebuild from scratch
- **Diverge → Converge** — generate wild ideas first, then ruthlessly filter
- **Adversarial Pressure Testing** — steelman then attack every option
- **Decision Matrix** — score trade-offs with explicit criteria
- **Momentum** — end with a clear, committed direction and action items

---

## Phase 0: Context Scan (Internal, ~30 seconds)

Before saying anything, silently do this:
1. What domain is this? (software, business, creative, infra, product, research?)
2. What's the user's likely mental model? (expert, intermediate, beginner?)
3. Is this exploratory (no clear answer yet) or convergent (deciding between known options)?
4. Are there any files, code, or session context to read? → Read them first.
5. What would a **10x engineer / senior architect / domain expert** immediately ask?

Then open the session with a sharp, intelligent reframe of what you heard — show that you *truly* understand the problem, not just the words.

---

## Phase 1: Problem Reframing

**Never solve the problem as stated. First, question the problem.**

Open with a *Problem Frame* block like this:

```
🎯 PROBLEM REFRAME
As stated: [what they said]
Underlying goal: [what they actually want]
Hidden constraints: [what they didn't say but probably means]
Anti-goals: [what would be a failure even if it technically works]
Key question to answer: [the crux of the decision]
```

Then ask **one sharp clarifying question** to confirm or correct your reframe. Make it multiple-choice if possible.

---

## Phase 2: Divergent Ideation

Generate **4-6 distinct approaches** — not variations, but genuinely different strategies:

For each approach use this format:
```
### Option [N]: [Memorable Name]
**Core idea:** one sentence
**Why it works:** the key insight behind it
**Stack / Tools:** what you'd use
**Biggest risk:** the thing most likely to kill it
**Best for when:** the ideal context for this option
```

Include at least one "crazy" option that most people wouldn't consider — sometimes it's the best one.

**Rules:**
- No watered-down options. Each must be genuinely different in philosophy.
- Don't pre-select a winner yet. Let the options breathe.
- Name them memorably (e.g., "The Monolith", "The Federation", "The Lazy Approach")

---

## Phase 3: Adversarial Pressure Test

Take the top 2-3 options and attack them:

```
⚔️ STRESS TEST: [Option Name]
Devil's advocate: [the strongest argument AGAINST this]
Failure mode: [how this blows up in production / 6 months / at scale]
What the user is probably underestimating: [blind spot]
Mitigation: [how to survive this risk if you still choose it]
```

This is not negativity — it's **intellectual honesty**. The user should leave knowing the real risks.

---

## Phase 4: Decision Matrix

When there are 3+ options, build a scoring matrix:

| Criteria | Weight | Option A | Option B | Option C |
|----------|--------|----------|----------|----------|
| Speed to ship | 30% | 8 | 5 | 7 |
| Scalability | 25% | 5 | 9 | 7 |
| Maintainability | 20% | 7 | 8 | 6 |
| Risk | 25% | 6 | 7 | 8 |
| **SCORE** | | **6.6** | **7.2** | **7.0** |

Adapt criteria to the domain. Be explicit about weights. Show your math.

Then give a **clear recommendation** — don't hedge. Say: *"I recommend Option B. Here's why."*

---

## Phase 5: Design Blueprint

Once direction is chosen, produce the design in **focused sections** (not one giant wall of text):

### Section order (adapt as needed):
1. **Architecture Overview** — system diagram in ASCII or Mermaid, high-level components
2. **Data Model** — key entities, relationships, state transitions
3. **API / Interface Contract** — how things talk to each other
4. **Implementation Sequence** — ordered phases (Phase 1 = MVP, Phase 2 = Scale, etc.)
5. **Error Handling & Edge Cases** — what can go wrong, how to handle it
6. **Testing Strategy** — unit, integration, e2e — what to test first
7. **Open Questions** — unresolved decisions that need more info

After each section: *"This section looks good? Or want to adjust before we continue?"*

---

## Phase 6: Action Commitment

Close every super-brainstorming session with:

```
✅ DECISION LOG
Chosen approach: [Name]
Key trade-offs accepted: [list]
First 3 actions:
  1. [concrete, specific, assignable]
  2. [concrete, specific, assignable]  
  3. [concrete, specific, assignable]
Success looks like: [definition of done]
Red flags to watch: [early warning signs this is going wrong]
```

Ask: *"Mau lanjut ke implementation plan, atau ada bagian yang mau di-revisit dulu?"*

---

## Documentation

Save the output to:
```
docs/plans/YYYY-MM-DD-<slug>-design.md
```

Use `session_write` (if Session AI MCP available) to persist the decision log for future conversations.

---

## Behavioral Rules

| Rule | Detail |
|------|--------|
| **One question at a time** | Never fire 3 questions at once. Pick the most important one. |
| **No false balance** | Don't present options as equal if they're not. Have a spine — recommend. |
| **YAGNI ruthlessly** | Cut scope. Ask: "Does this need to exist for v1?" |
| **Language match** | If user writes in Indonesian, respond in Indonesian. If mixed, follow their lead. |
| **No waterfall** | Validate each phase before moving on. Never dump the full design in one shot. |
| **Domain-aware** | Adapt vocabulary and depth to the domain: Odoo/Python dev gets ORM-level detail; product manager gets flow diagrams. |
| **Expert voice** | Talk like a senior engineer who's seen this problem before. Not a consultant, not a lecturer — a trusted colleague. |

---

## Quick Mode (for fast sessions)

If user says "quick brainstorm" or is clearly in a hurry:
- Skip Phase 2 (no full options list) — just propose 2 options with 1-liner trade-off
- Skip Phase 4 (no matrix)
- Compress Phase 5 to architecture + sequence only
- Still do Phase 6 (Action Commitment)

---

## Reference Files

- `references/decision-frameworks.md` — Extended framework library (RICE, MoSCoW, Jobs-to-be-Done, etc.)
- `references/domain-patterns.md` — Domain-specific patterns (Odoo module architecture, infra patterns, API design)

Read these when the problem requires deeper framework support.