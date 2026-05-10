-- Add enum value fields to DataSource for storing possible values of USER-DEFINED type fields
ALTER TABLE "data_sources" ADD COLUMN IF NOT EXISTS "typeFieldEnumValues" JSONB;
ALTER TABLE "data_sources" ADD COLUMN IF NOT EXISTS "statusFieldEnumValues" JSONB;

-- Add comment explaining the structure
-- typeFieldEnumValues and statusFieldEnumValues store arrays of possible enum values
-- Example: ["CONSULTATION", "HOME_SAMPLE", "INJECTION"]
-- Used for creating rules with specific field value selections
