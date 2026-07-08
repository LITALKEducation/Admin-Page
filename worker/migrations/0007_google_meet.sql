-- Auto-created Google Meet link for a booked class session (see
-- src/googlemeet.ts). Both are NULL when Google Meet integration is
-- unconfigured or the Calendar API call failed — booking still succeeds.
ALTER TABLE bookings ADD COLUMN meet_link TEXT;
ALTER TABLE bookings ADD COLUMN calendar_event_id TEXT;
