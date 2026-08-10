-- The org_id-deriving triggers previously fired on UPDATE too. That broke
-- cascading deletes: deleting a workflow cascades to workflow_runs, then the
-- step_runs SET NULL on step_id fired an UPDATE whose trigger tried to look up
-- an already-deleted parent run. These triggers only need to run on INSERT —
-- org_id is immutable once a row exists, so UPDATE is safe to skip.
DROP TRIGGER IF EXISTS t_workflow_steps_org_id ON public.workflow_steps;
CREATE TRIGGER t_workflow_steps_org_id
  BEFORE INSERT ON public.workflow_steps
  FOR EACH ROW EXECUTE FUNCTION public.set_org_id_from_workflow();

DROP TRIGGER IF EXISTS t_workflow_triggers_org_id ON public.workflow_triggers;
CREATE TRIGGER t_workflow_triggers_org_id
  BEFORE INSERT ON public.workflow_triggers
  FOR EACH ROW EXECUTE FUNCTION public.set_org_id_from_workflow();

DROP TRIGGER IF EXISTS t_workflow_runs_org_id ON public.workflow_runs;
CREATE TRIGGER t_workflow_runs_org_id
  BEFORE INSERT ON public.workflow_runs
  FOR EACH ROW EXECUTE FUNCTION public.set_org_id_from_workflow();

DROP TRIGGER IF EXISTS t_step_runs_org_id ON public.step_runs;
CREATE TRIGGER t_step_runs_org_id
  BEFORE INSERT ON public.step_runs
  FOR EACH ROW EXECUTE FUNCTION public.set_org_id_from_run();

DROP TRIGGER IF EXISTS t_workflow_artifacts_org_id ON public.workflow_artifacts;
CREATE TRIGGER t_workflow_artifacts_org_id
  BEFORE INSERT ON public.workflow_artifacts
  FOR EACH ROW EXECUTE FUNCTION public.set_org_id_from_run();
