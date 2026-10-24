-- 004_organizations_and_platform_admin.sql
-- Organizations/Workspaces, RBAC memberships, multi-superadmin administration, and error/diagnostic logging.

CREATE TABLE IF NOT EXISTS platform_organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  billing_tier TEXT NOT NULL DEFAULT 'self-hosted' CHECK (billing_tier IN ('self-hosted', 'free', 'pro', 'team', 'enterprise')),
  owner_id UUID REFERENCES platform_users(id) ON DELETE SET NULL,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS platform_organization_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES platform_organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'developer' CHECK (role IN ('owner', 'admin', 'developer', 'viewer', 'member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_platform_org_members_user ON platform_organization_members(user_id);
CREATE INDEX IF NOT EXISTS idx_platform_org_members_org ON platform_organization_members(organization_id);

ALTER TABLE platform_projects
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES platform_organizations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_platform_projects_org ON platform_projects(organization_id);

-- Allow platform superadmins to promote additional superadmins while registerPlatformUser
-- continues to enforce atomic single-superadmin initial bootstrap under table lock.
DROP INDEX IF EXISTS platform_users_bootstrap_superadmin_idx;

CREATE TABLE IF NOT EXISTS platform_error_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES platform_projects(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'api' CHECK (source IN ('api', 'database', 'auth', 'storage', 'realtime', 'function', 'job', 'platform')),
  severity TEXT NOT NULL DEFAULT 'error' CHECK (severity IN ('info', 'warn', 'error', 'critical')),
  status_code INTEGER,
  error_code TEXT NOT NULL,
  message TEXT NOT NULL,
  method TEXT,
  path TEXT,
  request_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_error_logs_project ON platform_error_logs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_error_logs_created ON platform_error_logs(created_at DESC);

-- Maintain strict privilege isolation on all public platform tables so project database roles
-- (role_<slug>, role_<slug>_rls, maary_rls_user) cannot read or modify platform metadata.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, maary_rls_user, maary_anon, maary_authenticated, maary_service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, maary_rls_user, maary_anon, maary_authenticated, maary_service_role;
