# PR299 unread browser evidence

Original unedited local test logs from the same Chromium version as GitHub CI. Before: 12 passed / 1 failed; after: 13 passed. Tests and expected30 assertion unchanged. These are isolated browser-component integration tests, not real provider or production acceptance. See attestation.json for source/build limitations and exact-head CI references.

The expected email-service-unavailable background messages are from synthetic local registration without a configured email provider; no email was sent. No tokens, account email addresses, cookies or credential URLs are included.
