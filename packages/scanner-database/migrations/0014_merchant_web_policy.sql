-- Keep the existing SELECT-only policy scope while adopting the production
-- verifier's canonical name. INSERT remains a separate explicit policy.
DO $merchant_policy_name$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.merchant_applications'::regclass
      AND polname = 'merchant_web_select'
  ) THEN
    ALTER POLICY merchant_web_select ON public.merchant_applications
      RENAME TO agentify_web_service;
  END IF;
END
$merchant_policy_name$;
