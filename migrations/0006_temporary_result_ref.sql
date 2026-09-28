ALTER TABLE operations ADD COLUMN temporary_result_ref TEXT;
CREATE INDEX IF NOT EXISTS idx_operations_temporary_result_ref ON operations(temporary_result_ref);
