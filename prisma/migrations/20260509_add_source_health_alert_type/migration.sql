-- Add SOURCE_HEALTH alert type so the source-health watcher can emit alerts
-- when a data source has been failing/silent for too long.
--
-- The taskos.AlertType enum is used by `taskos.alerts.alertType`. Adding a
-- value to a Postgres enum is a non-blocking ALTER and does not require
-- table rewrites.
--
-- Note: the source-health watcher uses entityType='DATA_SOURCE' and stores
-- the dataSource cuid in metadata.dataSourceId (Alert.entityId is Int? and
-- DataSource.id is a cuid string).

ALTER TYPE taskos."AlertType" ADD VALUE IF NOT EXISTS 'SOURCE_HEALTH';
