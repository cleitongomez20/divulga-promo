CREATE UNIQUE INDEX marketplace_one_per_owner ON public.marketplace_connections(user_id,marketplace);
CREATE TABLE public.connector_runtime(scope text PRIMARY KEY, next_allowed_at timestamptz NOT NULL DEFAULT now(), interval_ms integer NOT NULL DEFAULT 3000 CHECK(interval_ms BETWEEN 1000 AND 60000), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
GRANT ALL ON public.connector_runtime TO service_role;
ALTER TABLE public.connector_runtime ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER touch_updated BEFORE UPDATE ON public.connector_runtime FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
INSERT INTO public.connector_runtime(scope,interval_ms) VALUES('shopee',3000);
CREATE FUNCTION public.reserve_connector_slot(p_scope text, p_interval_ms integer DEFAULT 3000) RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE t timestamptz; gap integer; moment timestamptz; BEGIN
IF p_interval_ms NOT BETWEEN 1000 AND 60000 THEN RAISE EXCEPTION 'Invalid interval'; END IF;
INSERT INTO public.connector_runtime(scope,interval_ms) VALUES(p_scope,p_interval_ms) ON CONFLICT(scope) DO NOTHING;
SELECT next_allowed_at,interval_ms INTO t,gap FROM public.connector_runtime WHERE scope=p_scope FOR UPDATE;
moment=clock_timestamp();
IF t>moment THEN RETURN ceil(extract(epoch FROM(t-moment))*1000)::integer; END IF;
UPDATE public.connector_runtime SET next_allowed_at=moment+make_interval(secs=>gap/1000.0) WHERE scope=p_scope;
RETURN 0; END $$;
CREATE FUNCTION public.shopee_store_credentials(p_user_id uuid,p_ciphertext text) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE old_id uuid; new_id uuid; BEGIN
PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text,12));
SELECT credential_id INTO old_id FROM public.marketplace_connections WHERE user_id=p_user_id AND marketplace='shopee';
INSERT INTO public.connector_secrets(user_id,ciphertext) VALUES(p_user_id,p_ciphertext) RETURNING id INTO new_id;
INSERT INTO public.marketplace_connections(user_id,marketplace,status,credential_id) VALUES(p_user_id,'shopee','saved',new_id) ON CONFLICT(user_id,marketplace) DO UPDATE SET credential_id=new_id,status='saved',last_synced_at=NULL;
DELETE FROM public.connector_secrets WHERE id=old_id AND user_id=p_user_id;
INSERT INTO public.activity_log(user_id,action,result) VALUES(p_user_id,'Credenciais da Shopee salvas','Aguardando teste'); END $$;
CREATE FUNCTION public.shopee_remove_credentials(p_user_id uuid) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE old_id uuid; BEGIN
PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text,12));
SELECT credential_id INTO old_id FROM public.marketplace_connections WHERE user_id=p_user_id AND marketplace='shopee';
UPDATE public.marketplace_connections SET credential_id=NULL,status='disconnected',last_synced_at=NULL WHERE user_id=p_user_id AND marketplace='shopee';
DELETE FROM public.connector_secrets WHERE id=old_id AND user_id=p_user_id;
INSERT INTO public.activity_log(user_id,action,result) VALUES(p_user_id,'Conexão da Shopee removida','Modo de teste (dados simulados)'); END $$;
CREATE FUNCTION public.shopee_record_test(p_user_id uuid,p_credential_id uuid,p_status text,p_result text,p_details jsonb) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN
PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text,12));
UPDATE public.marketplace_connections SET status=p_status,last_synced_at=now() WHERE user_id=p_user_id AND marketplace='shopee' AND credential_id IS NOT DISTINCT FROM p_credential_id;
INSERT INTO public.activity_log(user_id,action,result,details) VALUES(p_user_id,'Conexão da Shopee testada',p_result,p_details); END $$;
REVOKE ALL ON FUNCTION public.reserve_connector_slot(text,integer),public.shopee_store_credentials(uuid,text),public.shopee_remove_credentials(uuid),public.shopee_record_test(uuid,uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_connector_slot(text,integer),public.shopee_store_credentials(uuid,text),public.shopee_remove_credentials(uuid),public.shopee_record_test(uuid,uuid,text,text,jsonb) TO service_role;