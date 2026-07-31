# Lessons

- A smooth steering rack is not sufficient proof of good handling. Test the whole response from input through yaw, lateral displacement, visual heading, and road-edge behavior.
- A placement lift used for a physics-driven respawn must never be reused by a snapshot-driven replica that does not integrate gravity. Assert signed clearance from the rendered road plane.
- Keep one documented public steering sign at every boundary. When the renderer uses the opposite yaw handedness, convert heading, yaw rate, rack, and drift direction together and pin the mapping with a regression test.
- Normalize authoritative distance with the authoritative track length, not a renderer's resampled spline length, or pose phase drifts every lap.
- Prediction must pause while disconnected and reset its timing accumulator on every connection transition; neutral input is still an input, and a stale clock creates a catch-up burst after reconnect.
