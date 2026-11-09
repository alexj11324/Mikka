# Optional Desktop APT passive diagnostic draft

This directory preserves all nine original files from the frozen local Desktop APT passive diagnostic package, including its original unchanged `manifest.json`, design, observer/test source, unfilled binding, source bindings and offline validation outputs.

The original manifest states `runtimeValidated: false`, `workflowCreated: false`, and `stage: optional offline draft; unactivated`. The recorded 21 passing tests used synthetic fanotify bytes and fake process/ACK guards. They are not evidence of guest execution, an actual fanotify/proc/systemctl observation, or a cloud runtime measurement.

This optional disabled draft is not a new R7 gate or formal acceptance prerequisite. No observer was activated or tested again during archival. New formal samples remain zero. This README and `archive-manifest.json` are additional archival metadata; the original nine files are byte-identical.
