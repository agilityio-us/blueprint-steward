---
work_item: 2026-11-02-session-target-branch
plugin: bett3r-ai-workflow@0.119.0+a32f574
base: 264fa524
slices:
  - id: 1
    name: "TRACER BULLET — a retarget job rebases the ticket branch onto the new target, moves its PR and pushes reality"
    origin: plan
    mode: sequential
    modeReason: pool=0
    commit: null
    passed: false
    attempts: 1
    fixRounds: []
    verifier: escalate
    redBeforeGreen: true
    postDesignDecisions: []
  - id: 2
    name: "A retarget that cannot land moves nothing and says why"
    origin: plan
    mode: null
    modeReason: null
    commit: null
    passed: false
    attempts: 0
    fixRounds: []
    verifier: null
    redBeforeGreen: null
    postDesignDecisions: []
---
## What shipped

Nothing landed. Slice 1 (the tracer bullet) went green on its oracle
(`retarget.test.ts`, 2 passed; RED by assertion first; the `--onto` probe turned it red)
and scope-check was CLEAN. The verifier returned ESCALATE on a design defect:
design.md Implementation Decisions 5 says "if origin/<to> is already part of the tip,
skip the rebase". That test is also true when the new target is *behind* the old base
(retarget develop → main of a branch cut from develop). The job then reports
`already-on-target`, moves nothing, and still retargets the PR to main, so the PR carries
develop's commits. That breaks D4 ("rebase, not just retarget"). The fix needs the owner to
reword decision 5's idempotency predicate, and slice 2's `diverged` rule depends on that wording.

Slice 1's implementation is left uncommitted in the working tree for the fix round. Slice 2
(depends on 1) did not start.

Fix round owed once decided: check `tip === expectedTip` first, then the agreed
already-on-target predicate; add a reverse-direction (develop → main) scenario; make the
fixture's opening commit empty to match the real cut (verifier F2); pin the
"gh edit failed, job still done" report (F3, decision 6); add a design Risks line that a new
Steward claims nothing from a server that doesn't know `retarget` yet.
