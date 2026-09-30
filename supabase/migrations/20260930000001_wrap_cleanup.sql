-- Restrict deletion to stale unsigned requests. Confirmed receipts are permanent.
CREATE INDEX wrap_requests_unsigned_created_at ON public.wrap_requests (created_at)
    WHERE signature IS NULL;

CREATE FUNCTION public.cleanup_wrap_requests(finalized_height bigint) RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
    WITH expired AS (
        SELECT id FROM public.wrap_requests
        WHERE signature IS NULL
          AND last_valid_block_height < finalized_height
          AND created_at < clock_timestamp() - interval '24 hours'
        ORDER BY created_at
        LIMIT 1000
        FOR UPDATE SKIP LOCKED
    ), removed AS (
        DELETE FROM public.wrap_requests AS requests USING expired
        WHERE requests.id = expired.id AND requests.signature IS NULL
        RETURNING requests.id
    )
    SELECT count(*) FROM removed;
$$;
REVOKE ALL ON FUNCTION public.cleanup_wrap_requests(bigint)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_wrap_requests(bigint) TO cadence_wrap_service;
