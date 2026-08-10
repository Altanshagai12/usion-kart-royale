# Lessons

- A smooth steering rack is not sufficient proof of good handling. Test the whole response from input through yaw, lateral displacement, visual heading, and road-edge behavior.
- A placement lift used for a physics-driven respawn must never be reused by a snapshot-driven replica that does not integrate gravity. Assert signed clearance from the rendered road plane.
- Keep one documented public steering sign at every boundary. When the renderer uses the opposite yaw handedness, convert heading, yaw rate, rack, and drift direction together and pin the mapping with a regression test.
- Normalize authoritative distance with the authoritative track length, not a renderer's resampled spline length, or pose phase drifts every lap.
- Prediction must pause while disconnected and reset its timing accumulator on every connection transition; neutral input is still an input, and a stale clock creates a catch-up burst after reconnect.
- A portrait-locked host cannot satisfy a “rotate your device” gate. When the game requires landscape, rotate the game surface into a logical landscape viewport and transform touch coordinates with it.
- Never silently remove a core gameplay system to make multiplayer authoritative. If items are not yet server-owned, keep their presentation explicit and add the missing authority instead of hiding the entire item layer.
- Do not call sub-native phone rendering acceptable without measuring the actual drawing buffer. Start sharp, keep at least CSS-native density, and let an evidence-based adaptive scaler reduce only what the device cannot sustain.
- A three-slot HUD is not a three-slot inventory. When the player asks for independently stored and directly usable items, the solo model, authoritative server, protocol validation, input selection, reconnect acknowledgement, and visible hit targets must all share the same slot index.
- Never treat a matching branch name, Railway link, or service-ID slug as proof that the current checkout is Kart Royale. Before any deploy or registry update, verify all four identities together: `origin` must be `Altanshagai12/usion-kart-royale`, `upstream` must be `ryancampbell/kart-royale`, the package/title must say Kart Royale, and the production registry entry must point at the same artifact.
- A direct multiplayer result is not complete if the client disconnects on `match_end`. Keep the authoritative room alive long enough to render every `finish_ms`, require all connected racers to vote for a same-room rematch, and reset predictors from a fresh monotonic keyframe.
- Never apply a fixed forward-speed multiplier on every frame of sustained kart overlap. Weight impact loss by longitudinal contact geometry so side scrapes separate without numerical boundary chatter welding racers together.
