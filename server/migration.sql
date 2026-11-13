-- Run once in phpMyAdmin (database if0_38842323_timer). Lets the server ignore re-sent sessions.
ALTER TABLE sessions
  ADD COLUMN client_uuid VARCHAR(64) NULL DEFAULT NULL,
  ADD UNIQUE KEY uq_sessions_client_uuid (client_uuid);
