-- Keep page progress separate from the last fully reconciled history cursor.
ALTER TABLE public.indexer_cursors
  ALTER COLUMN signature DROP NOT NULL,
  ADD COLUMN scan_head text,
  ADD COLUMN scan_before text,
  ADD CONSTRAINT indexer_scan_checkpoint CHECK (
    (scan_head IS NULL) = (scan_before IS NULL)
    AND (signature IS NOT NULL OR scan_head IS NOT NULL)
  );
