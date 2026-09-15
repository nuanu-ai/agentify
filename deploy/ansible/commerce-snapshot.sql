-- The column lists are the observed source schema at the freeze boundary.
-- Target migrations may add columns or tables; these original fields must stay
-- byte-equivalent when serialized as JSONB after restore and migration.
CREATE FUNCTION pg_temp.commerce_snapshot() RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  source_columns jsonb := '{
    "cabinet_accounts": ["id","email","created_at","merchant_id","merchant_key","email_verified","name","updated_at"],
    "cabinet_credentials": ["id","user_id","provider_id","account_id","issuer","password","access_token","refresh_token","id_token","access_token_expires_at","refresh_token_expires_at","scope","created_at","updated_at"],
    "cabinet_sessions": ["id","token","user_id","expires_at","created_at","updated_at","ip_address","user_agent"],
    "cabinet_verifications": ["id","identifier","value","expires_at","created_at","updated_at"],
    "cards": ["id","merchant_item_id","card","as_of","paused","merchant_id"],
    "merchant_keys": ["id","merchant_id","label","digest","created_at","disabled_at","purpose","last_used_at"],
    "merchants": ["id","selling","updated_at","name","created_at","service_name","payout_wallet"],
    "orders": ["id","state","open","item_id","merchant_item_id","record","created_at","updated_at","merchant_id"],
    "payment_claims": ["fingerprint","order_id","claimed_at"],
    "receipts": ["order_id","receipt","updated_at","merchant_id"]
  }'::jsonb;
  table_name text;
  fields jsonb;
  field_list text;
  row_count bigint;
  row_hash text;
  result jsonb := '{}'::jsonb;
BEGIN
  FOR table_name, fields IN SELECT key, value FROM jsonb_each(source_columns) LOOP
    IF to_regclass('public.' || table_name) IS NULL THEN
      RAISE EXCEPTION 'Missing commerce table: %', table_name;
    END IF;
    SELECT string_agg(format('%I', field), ',' ORDER BY ordinal)
      INTO field_list
      FROM jsonb_array_elements_text(fields) WITH ORDINALITY AS columns(field, ordinal);
    EXECUTE format(
      'SELECT count(*), md5(COALESCE(string_agg(to_jsonb(t)::text, E''\n'' ORDER BY to_jsonb(t)::text), '''')) FROM (SELECT %s FROM public.%I) t',
      field_list, table_name
    ) INTO row_count, row_hash;
    result := result || jsonb_build_object(
      table_name, jsonb_build_object('count', row_count, 'hash', row_hash)
    );
  END LOOP;
  RETURN jsonb_build_object('columns', source_columns, 'tables', result);
END $$;

SELECT pg_temp.commerce_snapshot()::text;
