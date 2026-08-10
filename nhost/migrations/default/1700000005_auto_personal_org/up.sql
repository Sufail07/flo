-- Auto-provision a personal org + owner membership for every new auth user.
-- This makes the "New workflow" button work on a fresh database: without this,
-- a brand-new user has no org_members row, so Hasura row filters return nothing
-- and the frontend keeps the create button disabled.
CREATE OR REPLACE FUNCTION public.provision_personal_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  base_slug     text;
  slug          text;
  slug_suffix   integer := 0;
  new_org_id    uuid;
  display       text;
  email_part    text;
BEGIN
  IF NEW.is_anonymous THEN
    RETURN NEW;
  END IF;

  display := coalesce(nullif(btrim(NEW.display_name), ''), '');
  email_part := split_part(coalesce(NEW.email, ''), '@', 1);

  -- Slugs must be unique and lowercase; derive from display name / email.
  base_slug := lower(regexp_replace(display, '[^a-zA-Z0-9]+', '-', 'g'));
  IF base_slug = '' OR base_slug IS NULL THEN
    base_slug := lower(regexp_replace(email_part, '[^a-zA-Z0-9]+', '-', 'g'));
  END IF;
  IF base_slug = '' OR base_slug IS NULL THEN
    base_slug := 'my-workspace';
  END IF;
  base_slug := left(base_slug, 30);

  slug := base_slug;
  LOOP
    BEGIN
      INSERT INTO public.organizations (name, slug)
      VALUES (
        coalesce(nullif(btrim(display), ''), email_part, 'My Workspace'),
        slug
      )
      RETURNING id INTO new_org_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      slug_suffix := slug_suffix + 1;
      slug := base_slug || '-' || slug_suffix;
    END;
  END LOOP;

  INSERT INTO public.org_members (org_id, user_id, role)
  VALUES (new_org_id, NEW.id, 'owner');

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS t_auth_users_provision_personal_org ON auth.users;
CREATE TRIGGER t_auth_users_provision_personal_org
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.provision_personal_org();

-- Backfill: users created before this migration get a personal org too.
-- A user may already hold memberships (e.g. seeded orgs); only provision when
-- they have zero memberships, and only when they don't already own an org.
INSERT INTO public.organizations (name, slug)
SELECT
  coalesce(nullif(btrim(u.display_name), ''), split_part(coalesce(u.email, ''), '@', 1), 'My Workspace'),
  'workspace-' || left(u.id::text, 8)
FROM auth.users u
WHERE NOT u.is_anonymous
  AND NOT EXISTS (
    SELECT 1 FROM public.org_members om
    WHERE om.user_id = u.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.organizations o
    JOIN public.org_members om ON om.org_id = o.id
    WHERE om.user_id = u.id AND om.role = 'owner'
  );

INSERT INTO public.org_members (org_id, user_id, role)
SELECT o.id, u.id, 'owner'
FROM auth.users u
JOIN public.organizations o
  ON o.slug = 'workspace-' || left(u.id::text, 8)
WHERE NOT u.is_anonymous
  AND NOT EXISTS (
    SELECT 1 FROM public.org_members om
    WHERE om.user_id = u.id
  );
