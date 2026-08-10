-- Shared updated_at trigger
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- tenancy

CREATE TABLE public.organizations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  slug               text NOT NULL UNIQUE,
  quota_limit        integer NOT NULL DEFAULT 100,
  quota_used         integer NOT NULL DEFAULT 0,
  quota_period_start timestamptz NOT NULL DEFAULT date_trunc('month', now()),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organizations_quota_nonneg CHECK (quota_used >= 0 AND quota_limit >= 0)
);
CREATE TRIGGER t_organizations_updated_at BEFORE UPDATE ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.org_members (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role       text NOT NULL REFERENCES public.org_roles(value),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);
-- Drives every single permission check; keep it covering.
CREATE INDEX idx_org_members_lookup ON public.org_members (user_id, org_id, role);

-- ---------------------------------------------------------------- definition

CREATE TABLE public.workflows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text,
  is_active   boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_workflows_org ON public.workflows (org_id);
CREATE TRIGGER t_workflows_updated_at BEFORE UPDATE ON public.workflows
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.workflow_steps (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id      uuid NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  -- denormalised from the parent by trigger; never trusted from the client
  org_id           uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  position         integer NOT NULL,
  name             text NOT NULL,
  type             text NOT NULL REFERENCES public.step_types(value),
  config           jsonb NOT NULL DEFAULT '{}'::jsonb,
  max_attempts     integer NOT NULL DEFAULT 3,
  on_true_step_id  uuid REFERENCES public.workflow_steps(id) ON DELETE SET NULL,
  on_false_step_id uuid REFERENCES public.workflow_steps(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_steps_max_attempts_sane CHECK (max_attempts BETWEEN 1 AND 10),
  -- DEFERRABLE so a reorder can shuffle positions inside one transaction
  CONSTRAINT workflow_steps_position_uniq UNIQUE (workflow_id, position) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX idx_workflow_steps_workflow ON public.workflow_steps (workflow_id, position);
CREATE TRIGGER t_workflow_steps_updated_at BEFORE UPDATE ON public.workflow_steps
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.workflow_triggers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id   uuid NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  org_id        uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  type          text NOT NULL REFERENCES public.trigger_types(value),
  is_enabled    boolean NOT NULL DEFAULT true,
  config        jsonb NOT NULL DEFAULT '{}'::jsonb,
  webhook_token text UNIQUE,
  cron_expr     text,
  next_run_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_workflow_triggers_workflow ON public.workflow_triggers (workflow_id);
CREATE INDEX idx_workflow_triggers_due ON public.workflow_triggers (type, is_enabled, next_run_at);
CREATE TRIGGER t_workflow_triggers_updated_at BEFORE UPDATE ON public.workflow_triggers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------- execution

CREATE TABLE public.workflow_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id  uuid NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  org_id       uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  trigger_id   uuid REFERENCES public.workflow_triggers(id) ON DELETE SET NULL,
  trigger_type text NOT NULL REFERENCES public.trigger_types(value),
  triggered_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  status       text NOT NULL DEFAULT 'pending' REFERENCES public.run_statuses(value),
  input        jsonb NOT NULL DEFAULT '{}'::jsonb,
  error        text,
  started_at   timestamptz,
  finished_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_workflow_runs_workflow ON public.workflow_runs (workflow_id, created_at DESC);
CREATE INDEX idx_workflow_runs_org_status ON public.workflow_runs (org_id, status);
CREATE TRIGGER t_workflow_runs_updated_at BEFORE UPDATE ON public.workflow_runs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.step_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id uuid NOT NULL REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
  step_id         uuid REFERENCES public.workflow_steps(id) ON DELETE SET NULL,
  org_id          uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  position        integer NOT NULL,
  -- type/config snapshotted so editing a workflow mid-run cannot redirect
  -- an in-flight execution, and history stays truthful.
  name            text NOT NULL,
  type            text NOT NULL REFERENCES public.step_types(value),
  config          jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'pending' REFERENCES public.step_run_statuses(value),
  input           jsonb,
  output          jsonb,
  error           text,
  attempt         integer NOT NULL DEFAULT 0,
  max_attempts    integer NOT NULL DEFAULT 3,
  approved_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at     timestamptz,
  approval_note   text,
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- Makes a duplicated Hasura event retry a no-op instead of a double execution.
CREATE UNIQUE INDEX idx_step_runs_run_position ON public.step_runs (workflow_run_id, position);
CREATE TRIGGER t_step_runs_updated_at BEFORE UPDATE ON public.step_runs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------- side effects

-- db_write targets this table only; never arbitrary SQL.
CREATE TABLE public.workflow_artifacts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  workflow_run_id uuid NOT NULL REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
  step_run_id     uuid REFERENCES public.step_runs(id) ON DELETE SET NULL,
  key             text NOT NULL,
  value           jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_workflow_artifacts_run ON public.workflow_artifacts (workflow_run_id);

CREATE TABLE public.notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  workflow_run_id uuid REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
  step_run_id     uuid REFERENCES public.step_runs(id) ON DELETE SET NULL,
  channel         text NOT NULL,
  target          text NOT NULL,
  subject         text,
  body            text NOT NULL,
  status          text NOT NULL DEFAULT 'pending',
  error           text,
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifications_run ON public.notifications (workflow_run_id);

CREATE TABLE public.org_usage_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  workflow_run_id uuid REFERENCES public.workflow_runs(id) ON DELETE SET NULL,
  kind            text NOT NULL,
  units           integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_org_usage_events_org ON public.org_usage_events (org_id, created_at DESC);

-- Watched table demonstrating the database_event trigger type.
CREATE TABLE public.leads (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  email      text NOT NULL,
  name       text,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_leads_org ON public.leads (org_id);
