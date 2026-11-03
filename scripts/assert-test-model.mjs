// Safe to call from production acceptance drivers too: no network, no secrets.
import { assertFlashTestModel } from './test-model-policy.mjs'
assertFlashTestModel(process.argv[2])
