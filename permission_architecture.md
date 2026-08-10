# Permission Architecture — AI Agent Workflow Builder

## 0. The one decision everything else follows from

**Role (owner/editor/viewer) is per-organization, not global.** The same user can be
`owner` in Org A and have no membership at all in Org B. That means you must **not**
try to encode role as a Hasura session-variable role (`X-Hasura-Role: owner`) the way
the Hasura docs' toy examples do — a static JWT claim can't represent "owner in this
org, nothing in that one."

Instead:

- Hasura roles stay coarse: `public` (unauthenticated) and `user` (any logged-in
  nhost user). Every table's real access control is a **row filter that joins out to
  `org_members`** and checks role there, scoped to the row's own org.
- The *only* thing the JWT carries is `X-Hasura-User-Id`. Everything else — which
  orgs you're in, what role you hold in each — is looked up live, per row, per
  request. This is what makes cross-org isolation airtight: there is no cached claim
  to spoof, and no way to "guess" your way past a row filter with a raw ID, because
  the filter re-derives permission from the join every time.

This is the spine of both layers below.

---

## 1. Layer 1 — org + role scoping (Hasura declarative permissions)

Relationships needed for the filters to work (define these in Hasura metadata even
if you don't expose all of them in the GraphQL schema):

```
workflows.org_id            -> organizations.id            (object: "org")
workflow_steps.workflow_id  -> workflows.id                (object: "workflow")
workflow_triggers.workflow_id -> workflows.id              (object: "workflow")
workflow_runs.workflow_id   -> workflows.id                (object: "workflow")
step_runs.workflow_run_id   -> workflow_runs.id            (object: "workflow_run")
organizations.id            -> org_members.org_id          (array: "members")
```

Hasura permission filters can walk multiple relationship hops, so
`workflow_steps` can reach `org_members` via `workflow.org.members`.

### org_members
| Op | Filter | Notes |
|---|---|---|
| select | `{ org_id: { _in: <orgs the caller belongs to> } }` i.e. `{ org: { members: { user_id: { _eq: X-Hasura-User-Id } } } }` | you can see the roster of any org you're in |
| insert | `{ org: { members: { user_id: {_eq: X-Hasura-User-Id}, role: {_eq: "owner"} } } }` | only owners manage membership |
| update | same as insert | e.g. changing someone's role |
| delete | same as insert | removing a member |

### organizations
| Op | Filter |
|---|---|
| select | `{ members: { user_id: { _eq: X-Hasura-User-Id } } }` |
| update (quota fields) | admin-only / via Action, not exposed to `user` role at all |

### workflows
| Op | Filter |
|---|---|
| select | `{ org: { members: { user_id: {_eq: X-Hasura-User-Id} } } }` — any role can see |
| insert | `{ org: { members: { user_id: {_eq: X-Hasura-User-Id}, role: {_in: ["owner","editor"]} } } }` |
| update | same as insert |
| delete | `{ org: { members: { user_id: {_eq: X-Hasura-User-Id}, role: {_eq: "owner"} } } }` — deleting a workflow is destructive enough to reserve for owner |

### workflow_steps
| Op | Filter |
|---|---|
| select | inherits via `workflow.org.members` — any role |
| insert | **two-part check**, combining Layer 1 (org+role) with the Layer-2-flavored step-type gate that *can* be expressed declaratively: `{ _and: [ { workflow: { org: { members: { user_id:{_eq:X-Hasura-User-Id}, role:{_in:["owner","editor"]} } } } }, { _or: [ { type: { _nin: ["db_write"] } }, { workflow: { org: { members: { user_id:{_eq:X-Hasura-User-Id}, role:{_eq:"owner"} } } } } ] } ] }` |
| update/delete | same shape as insert |

This is the one place Layer 1 and Layer 2 blend: "only owner can add `db_write`" is a
row-level insert check, so Hasura *can* enforce it directly on `workflow_steps` and
`workflow_triggers` (unlike `approval_gate` resumption, which is inherently
mid-execution and has to live in the Action — see §2).

### workflow_triggers
Same pattern as `workflow_steps`, with the gated type being `webhook` instead of
`db_write`:
```
{ _or: [ { trigger_type: { _neq: "webhook" } },
         { workflow: { org: { members: { role: {_eq:"owner"} } } } } ] }
```

### workflow_runs / step_runs
| Op | Filter |
|---|---|
| select | via `workflow.org.members` (any role) — this is what the live subscription relies on |
| insert/update | **not granted to `user` role at all** — these are written exclusively by the Action handler using the admin secret. Clients never insert/update run state directly; they only read it via subscription. This closes off a whole class of "I'll just PATCH my own run to `approved`" attacks. |

**Why deny direct writes on runs entirely:** the moment you let the `user` role
update `step_runs.status`, someone can flip an `approval_gate` to `approved` with a
plain mutation, bypassing the approver-role check that only exists in the Action
handler. Run/step-run mutation is a privileged operation, full stop — it only
happens server-side.

### Aggregation (quota / avg run duration)
Expose as a Postgres view (`org_usage_this_month`) with the same
`org.members.user_id` filter as `organizations`. Track it as a Hasura table so it
gets permissions like any other.

---

## 2. Layer 2 — step-level gating in the Action handlers

Two Actions carry logic Hasura's declarative permissions structurally cannot express,
because both are *decisions made mid-execution*, not row reads/writes:

### `triggerWorkflowRun(workflow_id)`
```
handler(input, sessionVars):
  userId = sessionVars["x-hasura-user-id"]          # from Hasura, not the payload
  membership = adminQuery(
    "select role from org_members om
     join workflows w on w.org_id = om.org_id
     where w.id = $workflow_id and om.user_id = $userId")

  if membership is null:                             # covers both "not a member"
    return 403                                        # and "workflow doesn't exist for you"
  if membership.role == "viewer":
    return 403

  org = adminQuery("select used, allowed from organizations where id = ...")
  if org.used >= org.allowed:
    return 429 "quota exhausted"

  run = adminInsert(workflow_runs, {workflow_id, status: "running", started_by: userId})

  for step in orderedSteps(workflow_id):
    stepRun = adminInsert(step_runs, {run_id: run.id, step_id: step.id, status:"running", attempt:1})
    result = execute(step)     # llm_call/http_request retry up to N times w/ backoff
    adminUpdate(step_runs, stepRun.id, {status, output/error})

    if step.type == "approval_gate":
      adminUpdate(workflow_runs, run.id, {status: "paused"})
      break     # handler exits; approveStep resumes later

    if step.type == "conditional_branch":
      nextStep = evaluateBranch(result)   # picks the branch path

  if run completed without pause:
    adminUpdate(organizations, org.id, {used: org.used + 1})
    adminUpdate(workflow_runs, run.id, {status: "completed"})
```

Key point: **membership is re-queried from `org_members` inside the handler using
the admin secret**, keyed off `x-hasura-user-id` from the verified session, never
trusted from the action's input payload. This is what stops "call the action with
someone else's workflow_id and your own claimed role" — there's no claimed role;
it's looked up fresh, server-side, every call.

### `approveStep(step_run_id)`
```
handler(input, sessionVars):
  userId = sessionVars["x-hasura-user-id"]
  stepRun = adminQuery("select sr.*, wr.workflow_id, wr.status as run_status
                         from step_runs sr join workflow_runs wr on ...
                         where sr.id = $step_run_id")
  if stepRun is null:
    return 404

  membership = adminQuery("select role from org_members om
                            join workflows w on w.org_id = om.org_id
                            where w.id = $stepRun.workflow_id and om.user_id = $userId")

  if membership is null or membership.role == "viewer":
    return 403
  if stepRun.type != "approval_gate" or stepRun.status != "awaiting_approval":
    return 409   # nothing to approve

  adminUpdate(step_runs, stepRun.id, {status:"approved", approved_by:userId, approved_at:now})
  adminUpdate(workflow_runs, stepRun.run_id, {status:"running"})
  resumeExecutionFrom(stepRun)   # continues the loop in triggerWorkflowRun's logic,
                                 # either inline or via a queued job
```

Same discipline: **the approver's role is fetched fresh from `org_members` inside
the handler**, not passed in or inferred from anything the client sent. This is the
part of the spec that explicitly can't be a database permission — "resume this
specific paused run if and only if the caller currently holds owner/editor in this
specific org" is a conditional business action, not a row visibility/writability
rule.

---

## 3. Why this defeats direct ID guessing

Every read (`workflows`, `workflow_steps`, `workflow_runs`, `step_runs`,
`org_members`) is filtered by a live join to `org_members` scoped to
`X-Hasura-User-Id`. An Org B user who guesses Org A's `workflow_id` and queries it
directly gets an **empty result set**, not a 403 — Hasura row filters behave like the
row doesn't exist for you, which is the correct posture (don't even confirm the ID is
valid).

Every write path that matters (`workflow_runs`, `step_runs`) has **no `user`-role
insert/update permission at all** — it's admin-secret-only, invoked exclusively
through the two Actions, both of which independently re-derive the caller's org
membership from the database. So even a well-formed mutation or a hand-crafted
Action call with someone else's `workflow_id`/`step_run_id` fails the membership
lookup and returns 403/404, regardless of what the client claims about itself.

---

## 4. Testing checklist (maps directly to the Final Task)

- [ ] Org B `editor` queries Org A's `workflow_id` directly → empty result, not error-with-details
- [ ] Org B `owner` calls `approveStep` on Org A's `step_run_id` → 403 (membership lookup returns null)
- [ ] Org A `viewer` calls `triggerWorkflowRun` → 403
- [ ] Org A `editor` tries to insert a `db_write` step → Hasura permission check fails (not app-level)
- [ ] Org A `editor` tries to insert a `webhook` trigger → Hasura permission check fails
- [ ] Quota exhausted → `triggerWorkflowRun` returns 429 before any `workflow_run` row is created
- [ ] Subscription on `step_runs` shows `paused` the instant the Action sets it, no polling
- [ ] `approveStep` from Org A `owner` on Org A's own paused run → succeeds, run resumes, subscription updates live