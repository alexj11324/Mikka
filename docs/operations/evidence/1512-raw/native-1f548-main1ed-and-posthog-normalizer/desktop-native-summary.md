# Offline Desktop evidence summary

This script reads the five saved acceptance JSON files. It performs no network requests and starts no application, database, browser, daemon or model. It never rewrites an input report; the output must be a new file.

```bash
node ops1512/desktop-native-summary.mjs \
  --reports ops1512/evidence/desktop-1f548 \
  --source 7355553d3ec5e3c99b792f27eda2c8380724eeb2 \
  --harness-revision 7355553d3ec5e3c99b792f27eda2c8380724eeb2 \
  --harness-sha256 36ed7202e05b11cafb1c5f2f2264c9a6ad4c536672b455ad3c1378fc2e56ae7a \
  --output ops1512/evidence/desktop-1f548-offline-summary.json \
  --compare ops1512/evidence/desktop-191fcce-offline-summary.json
```

`--source` is the actual application revision in the immutable reports, not the PR head. Both saved runs use GitHub synthetic merge revisions. Supply the expected identities from the independently verified artifact provenance; the script does not discover or attest GitHub source relationships. It requires lifecycle, both renderer identities, smoke, crypto and parity application revisions to match, and independently checks parity harness revision/SHA256. Counter revision must agree when present. The standalone package report must match the crypto report's embedded package report.

Required files under `--reports`:

- `lifecycle.json`
- `parity/parity.json`
- `smoke.json`
- `native-crypto.json`
- `mac-acceptance-package.json`

The summary records every input's exact byte count and SHA256. It reports full ordinary-login windows, including common authentication, Native PKCE/automatic renderer work, workspace work and all background SQL counted by the original primary API counter. No queries are subtracted. Startup SQL is limited to pair 1; it is not a median of the ten launch samples.

Twelve checkpoint observations must retain one PID/process start/runtime, nondecreasing cumulative query calls, zero known unknown-read counters, exact segment/total deltas and original time boundaries. Incomplete or inconsistent measurements retain observed numbers where present, but the comparison conclusion is `null`. Missing numbers remain `null`.

Physical HTTP and logical action counts remain separate. Starts, completions, crossings and unpaired observations are not added together. `loginActionStartsAcrossRoutes` compares Native and Web starts by registered action while the full rows retain their transport route. These are request counts, not measured SQL per action. Unknown labels are replaced by a fixed label and prevent the action comparison.

Cleanup output preserves stage results, reported native-resource cleanup counts, lease/account release state and sealed-baseline match booleans. Reported resource counts are not recast as remaining-resource counts. A false `workspaceName.restored` is retained; it alone does not prove cleanup failure when the original name already matched. No workspace names, account values, error messages, URLs or arbitrary payloads are copied.

The optional `--compare` accepts a previously generated summary and reports new-minus-old window/action counts, preserving unknowns. It does not claim causality between runs. `productionAcceptance` is always `null`; neither a successful CLI exit nor a passed Desktop workflow establishes the SQL comparison or production acceptance.

Run the small saved-report and malformed/missing-observation checks with:

```bash
node --test ops1512/desktop-native-summary.test.mjs
```
