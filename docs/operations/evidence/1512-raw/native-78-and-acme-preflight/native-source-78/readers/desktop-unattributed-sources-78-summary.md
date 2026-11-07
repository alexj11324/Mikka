# Native query source reader, vocabulary 78

This diagnostic reader accepts only the 78-key source refinement added on base afae721f6730434ded6be932a7f9dd585c22ee49. It does not alter the original total, 17 operation buckets, window boundaries, checkpoints, unknown buckets, or performance budgets.

Run with the original lifecycle JSON and the actual API/renderer revision from that run's compiled and checkout receipts:

```sh
node desktop-unattributed-sources-78-summary.mjs ORIGINAL-LIFECYCLE.json ACTUAL-SOURCE-SHA NEW-SUMMARY.json
```

Keep the frozen desktop-query-operations-summary.mjs and desktop-native-summary.mjs next to this reader. Their Git blobs are 17a54954b618fc3373715dbc73fa86669c2aa739 and dad196c96077ab1504fd8858343d31b00cf0da3a.

Before accepting an actual result, separately verify the exact checkout/harness receipt and the source blobs reported under vocabulary/counterImplementation. These fields are the reader's expected source contract, not measurements extracted from a report. The full source must contain table blob 1bda1efd05f3e7ca8a6696cbb926743bdb921f1a, counter blob 340cf961029e706e76a6f3f0ccf08eb8cfc84cd9, and projector blob ecc5c28718320893bb96c5902cf3cae0dd965b5b.

Historical 75-key evidence must use its frozen 75-key reader (blob 28f3a63f0b9c4604b79f935dd82420f9994a9e4a). Never add zero-valued keys to a measured report or reinterpret old otherScoped counts. The test's explicitly synthetic, in-memory 78-key fixture only checks parser compatibility; it is not runtime evidence.

The three new labels are /api/approved-writes, /api/conversations/[id]/read, and /api/mobile/reactions. They are shared chat scopes. Their presence in source does not prove which queries produced the historical Native–Web difference. The next normal Native CI must supply actual counts. productionAcceptance remains null.
