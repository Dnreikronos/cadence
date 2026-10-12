GRANT SELECT ON public.account_requests TO cadence_indexer;
GRANT UPDATE (status,signature,slot,submitted_signature) ON public.account_requests TO cadence_indexer;
CREATE POLICY account_requests_indexer ON public.account_requests TO cadence_indexer USING (true) WITH CHECK (true);
