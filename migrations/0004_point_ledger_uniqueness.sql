CREATE UNIQUE INDEX idx_point_ledger_operation_event
  ON point_ledger(operation_id, source, entry_type)
  WHERE operation_id IS NOT NULL;
