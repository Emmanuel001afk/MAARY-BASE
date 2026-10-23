-- 003_security_hardening.sql
-- Enforce database-level privilege boundaries on public platform tables and bootstrap superadmin uniqueness.

REVOKE CREATE ON SCHEMA public FROM PUBLIC, maary_rls_user, maary_anon, maary_authenticated, maary_service_role;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, maary_rls_user, maary_anon, maary_authenticated, maary_service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, maary_rls_user, maary_anon, maary_authenticated, maary_service_role;

-- Ensure at the database constraint level that only one superadmin can be bootstrapped initially
CREATE UNIQUE INDEX IF NOT EXISTS platform_users_bootstrap_superadmin_idx
  ON platform_users ((is_superadmin))
  WHERE is_superadmin = true;
