// Regenerates lib/issue-editor-schema-spec.json from the live issue editor schema.
// The server cannot import the editor's React-based extensions, so it validates against this snapshot;
// lib/issue-document-seed.test.ts fails whenever the snapshot drifts from the editor.
import { writeFileSync } from 'node:fs'
import { issueEditorSchemaSpec } from '../lib/issue-editor-schema-snapshot'
import { issueEditorSchema } from '../components/workspace/issue-editor-schema'

writeFileSync(new URL('../lib/issue-editor-schema-spec.json', import.meta.url), JSON.stringify(issueEditorSchemaSpec(issueEditorSchema()), null, 2) + '\n')
