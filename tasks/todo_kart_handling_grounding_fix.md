# Kart Handling and Grounding Fix

- [x] Reproduce and measure the direct-multiplayer steering and floating regressions.
- [x] Keep the public steering sign consistent across input, authoritative simulation, and Three.js pose.
- [x] Bound high-speed yaw so full keyboard/touch lock remains controllable.
- [x] Ground direct replicas on the sampled road plane instead of the solo respawn drop height.
- [x] Reset/drive direct-replica wheel and suspension visual state deterministically.
- [x] Add regression coverage for turn direction, full-lock handling, and road clearance.
- [x] Run unit, build, steering, two-client adverse-network, touch, and SDK lifecycle checks.
- [x] Pass an independent subagent audit with no remaining P0/P1 findings.
- [ ] Redeploy Railway production and verify HTTPS, WSS, and Usion published metadata.
- [ ] Verify `usionthemobile` still contains no Kart Royale code, assets, deployment config, or task files.
- [ ] Delete this task file after every item passes.
