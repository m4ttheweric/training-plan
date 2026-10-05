---
name: create-training-plan
description: Use when creating or revising running training plans for this repository, including race preparation, maintenance blocks, weekly mileage, workout schedules, or plans/*.json files.
---

# Create a training plan

Produce an athlete-specific plan that the app can load, validate, and activate. The JSON contract is enforced by code; use the validator rather than relying on visual inspection.

## Establish the brief

Reuse facts the user supplied: goal or race, dates, current weekly mileage and longest run, available running/strength days, recovery constraints, and pace targets. Ask for missing information that materially changes the schedule. If reasonable assumptions are authorized, state them; avoid inventing pace targets, injury history, or fitness data. A JSON validation pass establishes file correctness, not training suitability.

Read these repository files before authoring:

- [JSON schema](../../../schemas/training-plan.schema.json): supported fields, types, and required metadata.
- [Runtime validator](../../../src/plan-schema.ts): calendar and cross-field constraints.
- [Neutral example](../../../examples/maintenance-example.json): a compact working shape.

These links resolve from the skill directory to the repository root. The existing race plan contains its author's personal paces, lifting routine, and injury notes; use it only as a structural reference.

## Build the schedule

Save a new file as `plans/<id>.json`, with a matching lowercase hyphenated `id`. Preserve existing plans unless revision was requested.

- `startDate` is Monday; each week contains exactly seven days ordered Monday through Sunday. For a requested midweek start, anchor on the preceding Monday and mark earlier days as rest. Explain the resulting calendar range; if an exact end date is required, reconcile it with whole calendar weeks before saving.
- Number weeks consecutively from 1. Assign each week to exactly one phase, using unique phase IDs.
- Day types are `run`, `long`, `lift`, `rest`, and `race`. Running days require positive `miles`; all distances, including `race.distance`, are miles. Convert kilometer inputs; do not introduce `km` fields.
- Schedule from the athlete's reported base and availability. Check weekly totals and requested run counts. Describe intensity and unfamiliar workouts in `detail` and the glossary; include warmups and cooldowns in session mileage.
- For race plans, match `race.date` to the scheduled race day and `race.distance` to its miles. For maintenance plans, omit `race` entirely. Include required arrays and strings even when empty.

## Validate and hand off

From the repository root, run:

```sh
bun run validate:plans plans/<id>.json
```

Fix errors and rerun until it exits successfully. Then check totals, dates, rest days, race placement, and the user's constraints independently.

When activation is requested, set only `PLAN_ID=<id>` in the local `.env`, preserving existing keys and secrets. Otherwise give that setting and the restart command. Do not use filename sorting tricks, alter app code, or push plans unless requested.

Return the file, date range, weekly mile/run totals, assumptions, validator result, and activation instructions. Never claim validation passed without running it.
