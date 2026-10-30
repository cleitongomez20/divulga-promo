ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_user_id_external_order_id_key;
ALTER TABLE public.orders
  ADD COLUMN marketplace text NOT NULL DEFAULT 'shopee',
  ADD COLUMN conversion_id text NOT NULL DEFAULT '',
  ADD COLUMN item_id text NOT NULL DEFAULT '',
  ADD COLUMN commission_cents bigint NOT NULL DEFAULT 0,
  ADD COLUMN conversion_commission_cents bigint NOT NULL DEFAULT 0,
  ADD COLUMN raw_order_status text,
  ADD COLUMN fraud_status text,
  ADD COLUMN item_notes text,
  ADD COLUMN attribution_type text,
  ADD COLUMN utm_content text,
  ADD COLUMN sub_ids text[] NOT NULL DEFAULT '{}',
  ADD COLUMN item_name text,
  ADD COLUMN item_image_url text,
  ADD COLUMN shop_name text,
  ADD COLUMN quantity integer,
  ADD COLUMN clicked_at timestamptz,
  ADD COLUMN completed_at timestamptz,
  ADD COLUMN synced_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.orders ADD CONSTRAINT orders_status_check CHECK (status IN ('pending','completed','cancelled'));
ALTER TABLE public.orders ADD CONSTRAINT orders_item_key UNIQUE (user_id, conversion_id, external_order_id, item_id);
CREATE INDEX orders_user_ordered ON public.orders(user_id, ordered_at DESC);

CREATE TABLE public.shopee_sync_state (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  running_until timestamptz,
  queue jsonb NOT NULL DEFAULT '[]'::jsonb,
  history_days integer NOT NULL DEFAULT 90 CHECK (history_days BETWEEN 1 AND 365),
  interval_minutes integer NOT NULL DEFAULT 30 CHECK (interval_minutes BETWEEN 5 AND 1440),
  sub_id_separator text NOT NULL DEFAULT '-' CHECK (char_length(sub_id_separator) BETWEEN 1 AND 3),
  backfill_queued boolean NOT NULL DEFAULT false,
  last_periodic_at timestamptz,
  last_reconcile_at timestamptz,
  last_success_at timestamptz,
  failures integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  last_result text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.shopee_sync_state TO authenticated;
GRANT ALL ON public.shopee_sync_state TO service_role;
ALTER TABLE public.shopee_sync_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY shopee_sync_state_read ON public.shopee_sync_state FOR SELECT TO authenticated USING (user_id = auth.uid() AND public.private_access());
CREATE TRIGGER touch_updated BEFORE UPDATE ON public.shopee_sync_state FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE FUNCTION public.shopee_sync_lock(p_user_id uuid, p_seconds integer) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE got uuid; BEGIN
IF p_seconds NOT BETWEEN 10 AND 600 THEN RAISE EXCEPTION 'Invalid lock'; END IF;
INSERT INTO public.shopee_sync_state(user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;
UPDATE public.shopee_sync_state SET running_until = clock_timestamp() + make_interval(secs => p_seconds)
 WHERE user_id = p_user_id AND (running_until IS NULL OR running_until < clock_timestamp()) RETURNING user_id INTO got;
RETURN got IS NOT NULL; END $$;
REVOKE ALL ON FUNCTION public.shopee_sync_lock(uuid,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shopee_sync_lock(uuid,integer) TO service_role;