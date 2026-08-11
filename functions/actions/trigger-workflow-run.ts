import type { Request, Response } from 'express';
import {
  type ActionPayload,
  errorResponse,
  requireUserId,
  requireOrgRole,
  requireWebhookSecret,
} from '../_lib/auth';
import { adminGql } from '../_lib/graphql';
import { reserveQuota } from '../_lib/runner';

type Input = { workflow_id: string; payload?: Record<string, unknown> };

/**
 * Hasura Action: triggerWorkflowRun(workflow_id) — manual trigger.
 *
 * Layer-2 gate: the caller's role in the workflow's org is re-derived from
 * org_members inside the handler (never trusted from the payload), and only
 * owner/editor may start a run. Viewer or non-member gets the same 403 so an
 * ID cannot be probed.
 */
export default async function handler(req: Request, res: Response) {
  try {
    requireWebhookSecret(req);

    const body = req.body as ActionPayload<Input>;
    const userId = requireUserId(body.session_variables);
    const { workflow_id } = body.input;

    const workflow = await adminGql<{
      workflows_by_pk: { org_id: string; id: string } | null;
    }>(
      `query ($workflowId: uuid!) {
         workflows_by_pk(id: $workflowId) { id org_id }
       }`,
      { workflowId: workflow_id },
    );
    if (!workflow.workflows_by_pk) {
      return res.status(404).json({ message: 'not found', code: 'not-found' });
    }
    const orgId = workflow.workflows_by_pk.org_id;

    // Layer-2: fresh membership lookup, owner/editor minimum.
    await requireOrgRole(userId, orgId, 'editor');

    // Atomic quota check: reserves one unit or fails before any run is created.
    const reserved = await reserveQuota(orgId);
    if (!reserved) {
      return res.status(429).json({ message: 'organization quota exhausted', code: 'quota-exhausted' });
    }

    const created = await adminGql<{ insert_workflow_runs_one: { id: string } }>(
      `mutation ($obj: workflow_runs_insert_input!) {
         insert_workflow_runs_one(object: $obj) { id }
       }`,
      {
        obj: {
          workflow_id,
          org_id: orgId,
          trigger_type: 'manual',
          triggered_by: userId,
          status: 'pending',
          input: body.input.payload ?? {},
        },
      },
    );
    const runId = created.insert_workflow_runs_one.id;

    // Return as soon as the run row exists. The execute-run Event Trigger drives
    // the steps, so the client gets run_id immediately and can open its
    // step_runs subscription before execution starts — that is what makes
    // progress stream live instead of arriving all at once at the end.
    return res.json({
      run_id: runId,
      status: 'pending',
      paused_at_step_run_id: null,
    });
  } catch (err) {
    const r = errorResponse(err);
    return res.status(r.status).json(r.body);
  }
}
