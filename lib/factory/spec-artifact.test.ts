import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ARTIFACT_MAX_BYTES } from '../artifacts/limits';
import { factorySpecMarkdown, parseFactorySpecArtifactRef } from './spec-artifact';

test('spec Artifact preserves the actual structured plan and redacts every displayed field', () => {
  const runId = randomUUID();
  const document = factorySpecMarkdown({ runId, title: 'Generic task', locale: 'en', summary: 'Brief hand-in',
    specification: { title: 'Parser plan API_TOKEN=secret-fixture', summary: 'Keep the existing grammar.', sections: [
      { heading: 'Scope', items: ['Retain the public interface.', 'password=private-fixture'] },
      { heading: 'Verification', items: ['Run the parser database tests.'] },
    ] } });
  assert.match(document.title, /^Specification · Parser plan API_TOKEN=\[REDACTED\]$/);
  assert.match(document.content, /Keep the existing grammar\./);
  assert.match(document.content, /## Scope/);
  assert.match(document.content, /- Retain the public interface\./);
  assert.match(document.content, /Run the parser database tests/);
  assert.ok(document.content.includes(runId));
  assert.doesNotMatch(JSON.stringify(document), /secret-fixture|private-fixture|Brief hand-in/);
});

test('legacy spec hand-ins remain openable without inventing sections or verification', () => {
  const document = factorySpecMarkdown({ runId: randomUUID(), title: '历史任务', locale: 'zh-CN', specification: null,
    summary: '先保留现有 API。\n再补工作区权限测试。' });
  assert.equal(document.title, '方案 · 历史任务');
  assert.match(document.content, /先保留现有 API。\n再补工作区权限测试。/);
  assert.doesNotMatch(document.content, /已验证|Verified/);
});

test('largest structured plans remain within existing Artifact limits with visible truncation', () => {
  const document = factorySpecMarkdown({ runId: randomUUID(), title: 'Large plan', locale: 'en', summary: null,
    specification: { title: 'Large plan', summary: '\\'.repeat(4000), sections: Array.from({ length: 30 }, (_, index) => ({
      heading: `Section ${index}`, items: Array.from({ length: 50 }, (_, item) => `${item}: ` + '\\'.repeat(1980)),
    })) } });
  assert.ok(Buffer.byteLength(document.content) < ARTIFACT_MAX_BYTES.markdown);
  assert.equal((document.content.match(/^## Section /gm) ?? []).length, 30);
  assert.equal((document.content.match(/^- /gm) ?? []).length, 1500);
  assert.ok(document.content.includes('…'));
});

test('spec references expose only the validated immutable identity tuple', () => {
  const ref = { artifactId: randomUUID(), version: 1, runId: randomUUID(), sha256: 'a'.repeat(64) };
  assert.deepEqual(parseFactorySpecArtifactRef({ ...ref, sessionId: 'not-public' }), ref);
  for (const value of [null, [], {}, { ...ref, version: 0 }, { ...ref, version: 1.5 }, { ...ref, artifactId: '../other' },
    { ...ref, runId: 'other' }, { ...ref, sha256: 'no-digest' }]) assert.equal(parseFactorySpecArtifactRef(value), null);
});
