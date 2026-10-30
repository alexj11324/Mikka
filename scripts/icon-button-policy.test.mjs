import assert from 'node:assert/strict'
import test from 'node:test'
import { auditIconButtons } from './icon-button-policy.mjs'
const audit = code => auditIconButtons('components/settings/example.tsx', `import { Plus, X as Close } from 'lucide-react'; ${code}`)
for (const code of ['<Button><Plus /></Button>', '<button><Close /></button>', '<Button aria-label=""><Plus /></Button>', '<Button aria-label={undefined}><Plus /></Button>', '<Button>{busy ? <Plus /> : <Close />}</Button>', '<Button><span><Plus /></span></Button>', '<Button><svg /></Button>']) {
  test(`rejects unlabeled icon: ${code}`, () => assert.equal(audit(code).length, 1))
}
for (const code of ['<Button aria-label="Add"><Plus /></Button>', '<Button aria-label={t("add")}><Plus /></Button>', '<Button><Plus />Add</Button>', '<Button>{t("save")}</Button>', '<Button {...props}><Plus /></Button>', '<Button><Unknown /></Button>', '<Button><span>Add</span><Plus /></Button>', '<Button><Plus /><span className="sr-only">Add</span></Button>']) {
  test(`allows named or indeterminate button: ${code}`, () => assert.deepEqual(audit(code), []))
}
test('resolves imported button alias', () => assert.equal(audit("import { Button as Action } from '@/components/ui/button'; const ui = <Action><Plus /></Action>").length, 1))
