-- =====================================================================
-- org_id integrity
-- Every tenant-owned child row derives org_id from its parent. A client
-- cannot smuggle a foreign org_id past a permission check, because the
-- value it sends is overwritten before the row is written.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.set_org_id_from_workflow()
RETURNS trigger AS $$
DECLARE
  v_org_id uuid;
BEGIN
  SELECT org_id INTO v_org_id FROM public.workflows WHERE id = NEW.workflow_id;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'parent workflow % not found', NEW.workflow_id;
  END IF;
  NEW.org_id := v_org_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER t_workflow_steps_org_id
  BEFORE INSERT OR UPDATE ON public.workflow_steps
  FOR EACH ROW EXECUTE FUNCTION public.set_org_id_from_workflow();

CREATE TRIGGER t_workflow_triggers_org_id
  BEFORE INSERT OR UPDATE ON public.workflow_triggers
  FOR EACH ROW EXECUTE FUNCTION public.set_org_id_from_workflow();

CREATE TRIGGER t_workflow_runs_org_id
  BEFORE INSERT OR UPDATE ON public.workflow_runs
  FOR EACH ROW EXECUTE FUNCTION public.set_org_id_from_workflow();

CREATE OR REPLACE FUNCTION public.set_org_id_from_run()
RETURNS trigger AS $$
DECLARE
  v_org_id uuid;
BEGIN
  SELECT org_id INTO v_org_id FROM public.workflow_runs WHERE id = NEW.workflow_run_id;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'parent workflow_run % not found', NEW.workflow_run_id;
  END IF;
  NEW.org_id := v_org_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER t_step_runs_org_id
  BEFORE INSERT OR UPDATE ON public.step_runs
  FOR EACH ROW EXECUTE FUNCTION public.set_org_id_from_run();

CREATE TRIGGER t_workflow_artifacts_org_id
  BEFORE INSERT OR UPDATE ON public.workflow_artifacts
  FOR EACH ROW EXECUTE FUNCTION public.set_org_id_from_run();

-- A branch target must live in the same workflow, else a branch could jump
-- execution into another org's workflow.
CREATE OR REPLACE FUNCTION public.check_branch_targets()
RETURNS trigger AS $$
BEGIN
  IF NEW.on_true_step_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.workflow_steps
     WHERE id = NEW.on_true_step_id AND workflow_id = NEW.workflow_id
  ) THEN
    RAISE EXCEPTION 'on_true_step_id must belong to the same workflow';
  END IF;

  IF NEW.on_false_step_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.workflow_steps
     WHERE id = NEW.on_false_step_id AND workflow_id = NEW.workflow_id
  ) THEN
    RAISE EXCEPTION 'on_false_step_id must belong to the same workflow';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER t_workflow_steps_branch_targets
  AFTER INSERT OR UPDATE ON public.workflow_steps
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.check_branch_targets();

-- =====================================================================
-- Quota
-- =====================================================================

-- Atomic reserve. A single conditional UPDATE, so concurrent triggers
-- cannot read-then-write their way past the limit.
CREATE OR REPLACE FUNCTION public.consume_org_quota(p_org_id uuid, p_units integer)
RETURNS boolean AS $$
DECLARE
  v_ok boolean;
BEGIN
  -- roll the window forward if we crossed a month boundary
  UPDATE public.organizations
     SET quota_used = 0,
         quota_period_start = date_trunc('month', now())
   WHERE id = p_org_id
     AND quota_period_start < date_trunc('month', now());

  UPDATE public.organizations
     SET quota_used = quota_used + p_units
   WHERE id = p_org_id
     AND quota_used + p_units <= quota_limit
  RETURNING true INTO v_ok;

  RETURN COALESCE(v_ok, false);
END;
$$ LANGUAGE plpgsql;

-- Release a reservation when a run never actually consumed it.
CREATE OR REPLACE FUNCTION public.release_org_quota(p_org_id uuid, p_units integer)
RETURNS void AS $$
BEGIN
  UPDATE public.organizations
     SET quota_used = GREATEST(quota_used - p_units, 0)
   WHERE id = p_org_id;
END;
$$ LANGUAGE plpgsql;

-- =====================================================================
-- Aggregation view (the required org-level aggregation)
-- =====================================================================

CREATE OR REPLACE VIEW public.org_usage_current_month AS
SELECT
  o.id                                        AS org_id,
  o.quota_limit,
  o.quota_used,
  GREATEST(o.quota_limit - o.quota_used, 0)   AS quota_remaining,
  o.quota_period_start,
  COUNT(r.id) FILTER (
    WHERE r.created_at >= date_trunc('month', now())
  )                                           AS runs_this_month,
  COUNT(r.id) FILTER (
    WHERE r.status = 'failed'
      AND r.created_at >= date_trunc('month', now())
  )                                           AS failed_runs_this_month,
  COALESCE(
    AVG(EXTRACT(epoch FROM (r.finished_at - r.started_at)))
      FILTER (WHERE r.status = 'succeeded' AND r.finished_at IS NOT NULL),
    0
  )::numeric(10,2)                            AS avg_run_seconds
FROM public.organizations o
LEFT JOIN public.workflow_runs r ON r.org_id = o.id
GROUP BY o.id, o.quota_limit, o.quota_used, o.quota_period_start;
