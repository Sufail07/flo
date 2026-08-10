import type { Request, Response } from 'express';
import {
  type ActionPayload,
  errorResponse,
  requireUserId,
  requireOrgRole,
  requireWebhookSecret,
} from '../_lib/auth';
import { adminGql } from '../_lib/graphql';
import { executeWorkflowRun } from '../_lib/runner';

type Input = { step_run_id: string };

type StepRunRow = {
  id: string;
  workflow_run_id: string;
  position: number;
  type: string;
  status: string;
  workflow_run: { org_id: string; workflow_id: string };
};

/**
 * Hasura Action: approveStep(step_run_id) — resumes a paused approval gate.
 *
 * Layer-2 gate: the approver's role is looked up fresh in the run's org and
 * must be owner/editor. Only a step that is actually an approval_gate in
 * awaiting_approval state can be approved; anything else is a 409.
 */
export default async function handler(req: Request, res: Response) {
  try {
    requireWebhookSecret(req);

    const body = req.body as ActionPayload<Input>;
    const userId = requireUserId(body.session_variables);
    const { step_run_id } = body.input;

    const stepRun = await adminGql<{ step_runs_by_pk: StepRunRow | null }>(
      `query ($stepRunId: uuid!) {
         step_runs_by_pk(id: $stepRunId) {
           id workflow_run_id position type status
           workflow_run { org_id workflow_id }
         }
       }`,
      { stepRunId: step_run_id },
    );
    const sr = stepRun.step_runs_by_pk;
    if (!sr) {
      return res.status(404).json({ message: 'not found', code: 'not-found' });
    }

    const orgId = sr.workflow_run.org_id;

    // Layer-2: the approver must currently hold owner/editor in that org.
    await requireOrgRole(userId, orgId, 'editor');

    if (sr.type !== 'approval_gate' || sr.status !== 'awaiting_approval') {
      return res
        .status(409)
        .json({ message: 'step is not awaiting approval', code: 'not-awaiting-approval' });
    }

    await adminGql(
      `mutation ($id: uuid!, $userId: uuid!, $status: step_run_statuses_enum!) {
         update_step_runs_by_pk(
           pk_columns: { id: $id }
           _set: {
             status: $status
             approved_by: $userId
             approved_at: now
           }
         ) { id }
       }`,
      { id: sr.id, userId, status: 'succeeded' },
    );

    await adminGql(
      `mutation ($runId: uuid!, $status: run_statuses_enum!) {
         update_workflow_runs_by_pk(pk_columns: { id: $runId }, _set: { status: $status }) { id }
       }`,
      { runId: sr.workflow_run_id, status: 'running' },
    );

    // Resume the paused run from the step after the gate.
    const result = await executeWorkflowRun(sr.workflow_run_id, {
      resumeAfterPosition: sr.position,
    });

    return res.json({
      run_id: sr.workflow_run_id,
      status: result.status,
      approved_by: userId,
    });
  } catch (err) {
    const r = errorResponse(err);
    return res.status(r.status).json(r.body);
  }
}
