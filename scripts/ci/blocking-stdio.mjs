// `--test-force-exit` calls process.exit while a large TAP write may still be
// queued. A blocking stdio handle finishes that write before exit, so the
// runner still receives the `# tests` summary.
for (const stream of [process.stdout, process.stderr]) {
  stream._handle?.setBlocking?.(true)
}
