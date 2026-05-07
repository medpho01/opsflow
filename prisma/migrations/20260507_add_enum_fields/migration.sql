-- Add enum value fields to DataSource for storing possible values of USER-DEFINED type fields
ALTER TABLE taskos."data_sources" ADD COLUMN "typeFieldEnumValues" JSONB;
ALTER TABLE taskos."data_sources" ADD COLUMN "statusFieldEnumValues" JSONB;

-- Add comment explaining the structure
-- typeFieldEnumValues and statusFieldEnumValues store arrays of possible enum values
-- Example: ["CONSULTATION", "HOME_SAMPLE", "INJECTION"]
-- Used for creating rules with specific field value selections
