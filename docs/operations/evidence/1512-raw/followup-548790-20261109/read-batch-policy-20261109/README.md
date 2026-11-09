# Native batch workspace-policy observation

This three-file patch is isolated at source tree a69946cdb08bceb994e11b3278572bea5e7e63c9. It reuses only the workspace subscription-sharing policy observation inside an already active Native readBatch. The effective database executor and exact workspace are the key. Every existing consumer branch, credential/share row query, membership check and ordinary request remains in place. The map is disabled and cleared at batch completion, including failure.

The public seam uses the real createReadBatch, its existing coordinator action argument schema, and the actual usableApiKeys and pooledOwners readers. The original source failed with two policy queries where one is required; the same case passed after the change. The final three focused suites passed 36/36 and explicit no-ignore lint passed. The request-scope boundary case uses the actual pool proxy with two independent local Pool instances whose query methods are fixture adapters; no database connection is opened and both pools are closed.

The original packaged Native result remains 473 versus Web 402, RED. Four policy reads are the theoretical maximum saving in that original login trace; even a 469 counterfactual still fails. This package claims no end-to-end SQL improvement or production acceptance. Bot projection and menu changes are deferred. No source/index outside this copy, branch, network, model, VM or CI was changed.

The manifest binds original and final sources and the unchanged guard/consumer files. Original RED and final GREEN logs remain byte-preserved. checkout and the dependency symlink are not evidence payload.
