# Desktop f7 CI evidence

These three PNGs are unmodified files from artifact 13558729569 of Actions run 42335295533. The JSON is a bounded, credential-free projection of its report. This is failed CI evidence, not production acceptance.

Feature head: f7e901ed2c71c3d66318877a8e8f48fa69a82e09. Actual app/harness synthetic PR merge: 096597d7cb30607f16b880c42a007e3ea26316e4. The artifact ZIP SHA256 is a6fc514d3cca7ba23476627e1228200f3903a65e90137d508aa1fe80ac7606ca.

99 of 100 comparisons passed. light/artifact-markdown changed 45,112 of 1,296,000 pixels (3.480864%), above the unchanged 0.1% gate. Dynamic mask geometry matched, page errors were zero, and cleanup passed. The hosted image includes two fixture artifact cards in the current dialog's right conversation; the bundled image does not yet include them. The Markdown body and dialog geometry match.

Source inspection at the exact app/harness SHA showed ThreadArtifactCards has an independent useSWR read, returns null before data, and exposes no skeleton or busy indicator. Existing artifact-markdown readiness waited for the body heading only. These observations motivate a bounded test-readiness fix; they do not justify changing product UI, masks, or the pixel threshold. Internal scratch paths in the raw projection describe the extraction location; the adjacent files preserve the exact referenced bytes.
