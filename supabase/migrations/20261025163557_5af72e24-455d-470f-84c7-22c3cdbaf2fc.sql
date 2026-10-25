-- Owner decision: password-only access; preserve every existing RLS policy and role rule.
CREATE OR REPLACE FUNCTION public.private_access()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL
$$;