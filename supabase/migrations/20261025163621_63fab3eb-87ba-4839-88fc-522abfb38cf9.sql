-- private_access reads only the caller identity and needs no elevated privileges.
ALTER FUNCTION public.private_access() SECURITY INVOKER;