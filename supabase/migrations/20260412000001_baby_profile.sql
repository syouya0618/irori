-- Baby profile columns on households (1 baby per household assumption)
ALTER TABLE households ADD COLUMN IF NOT EXISTS baby_name TEXT;
ALTER TABLE households ADD COLUMN IF NOT EXISTS baby_birth_date DATE;

ALTER TABLE households ADD CONSTRAINT chk_baby_birth_date
  CHECK (baby_birth_date IS NULL OR baby_birth_date <= CURRENT_DATE);
