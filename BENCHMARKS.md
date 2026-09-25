# Benchmarks

Run with `npm run bench` (2026-09-25, linux, Node v22.22.2).

| Metric | Reference design | Hivefloor |
|---|---|---|
| Message delivery latency (sender → recipient) | p50 774 ms · p99 1451 ms | p50 2.2 ms · p99 5.9 ms (over real HTTP + long-poll) |
| Main-thread blocking per persisted message | 101 ms sync git add+commit (spawnSync) | 0.017 ms (17.5 µs: in-memory apply + buffered WAL append) |
| Worst event-loop stall during run | 125 ms | 10.2 ms |
| PTY → UI IPC messages (10 chatty agents) | 1841 sends (one per onData chunk) | 19 sends (frame-coalesced, 96.9× fewer) — and 0 for terminals not on screen |
| Memory recall, 20k entries | external MemPalace CLI process per query (not benchmarked here) | in-process BM25: p50 0.250 ms · p99 3.4 ms (index build 528 ms) |
