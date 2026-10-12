# Benchmarks

The benchmark results live on the site: **https://velimirmueller.github.io/code-context-mcp/**

This folder holds a copy of the last published run, so the numbers sit in the repository next to
the code they measured.

| Path                   | What it is                                              |
| ---------------------- | ------------------------------------------------------- |
| `latest/manifest.json` | The runs in the last run: id, kind, model, timestamp    |
| `latest/<run_id>.json` | Full run files (schema `ccc-bench/1`), unchanged copies |

- **Last run** = the newest run of each kind (simulated, GLM, DeepSeek, Opus) on the newest
  publish date. The site calls the same set "Run N".
- **Source** = the `bench-results` branch (`data/runs/`). It holds every published run, also the
  runs before the history restart on 2026-10-13. Run files are never rewritten.
- **Updates** come from `.github/workflows/bench-snapshot.yml` as a pull request each time
  `bench-results` changes. Do not edit the copies by hand.
- **Method, task sets and limits** are in [BENCHMARK-GUIDE.md](../BENCHMARK-GUIDE.md).
