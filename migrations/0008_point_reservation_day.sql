ALTER TABLE point_reservations ADD COLUMN daily_billing_day TEXT;

UPDATE point_reservations
SET daily_billing_day = (
  SELECT u.daily_billing_day
  FROM users u
  JOIN operations o ON o.user_id = u.id
  WHERE o.id = point_reservations.operation_id
)
WHERE daily_billing_day IS NULL;
