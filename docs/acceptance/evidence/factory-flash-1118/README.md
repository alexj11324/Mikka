# Factory acceptance UI — #1118

Original Chromium screenshots of the real isolated development application at
`http://localhost:3110`, viewport 1600×1000. They show retained real task/run
records, not mocked page responses or reconstructed frames. No browser test
suite ran. These are development-flow evidence, not production-build screenshots.

The producing/checking runs used fixed source `8efe8924`; the final view-only
corrections are `cc9b2c4e`. All model runs were terminal before the last display
corrections. The screenshots then reread the same retained database records.

- [Code candidate awaiting the person's merge](code-acceptance.png): candidate
  `aac66e8928cb24214ea22949e7020a7f3eb155e1`, four criteria and separate
  review/verify results. The commit icon and SHA are one compact copy control;
  the action bar does not repeat the SHA. Environment shows the actual device
  name `579a43969c3c`.
- [Report accepted through the real UI](report-accepted.png): task
  `c108e2c6-d461-4244-960e-9b970d482e9b`, candidate
  `4c07c637-366a-4ffb-8825-08716836bfec`, five criteria. The real UI's accept
  operation returned HTTP 200/accepted at 2026-11-03 12:30:01 UTC. The database
  acceptance row was independently read back; the corrected UI shows 已验收.

Models, daemon, PostgreSQL and local Git were real; GitHub API was a local
synthetic fixture. No production merge, production database mutation, real E2B
or production OAuth acceptance is claimed. Full evidence and run/session IDs:
[acceptance record](../../../acceptance-factory-flash-2026-11-03.md).
