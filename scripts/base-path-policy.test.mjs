import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { auditBasePath } from './base-path-policy.mjs'
import { navigationPolicyFiles } from './navigation-policy.mjs'
const inspect = (source) => auditBasePath('components/example.tsx', source)
const imports = "import NextLink from 'next/link'; import {withBasePath,BASE_PATH} from '@/lib/base-path';"

test('framework links reject prefixed literals, helper calls and values passed through variables', () => {
  for (const code of [
    '<NextLink href="/mikka/api/file"/>',
    '<NextLink href={withBasePath(path)}/>',
    'const url=withBasePath(path); <NextLink href={url}/>',
    'const url=withBasePath(path); const download=`${url}?download`; <NextLink href={download}/>',
    '<NextLink href={{pathname: withBasePath(path)}}/>',
    '<NextLink href={ready ? withBasePath(path) : "/safe"}/>',
    '<NextLink href={`${BASE_PATH}/api/file`}/>',
  ])
    assert.equal(inspect(imports + code).length, 1, code)
})
test('aliased Next and localized links cannot bypass the check', () => {
  assert.equal(
    inspect(
      "import RouteLink from 'next/link'; import {withBasePath as prefix} from '@/lib/base-path'; const url=prefix('/api/file'); <RouteLink href={url}/>",
    ).length,
    1,
  )
  assert.equal(
    inspect("import {Link as LocalLink} from '@/i18n/navigation'; <LocalLink href='/mikka/settings'/>")
      .length,
    1,
  )
})
test('router and redirect targets follow the same single-prefix rule', () => {
  const code =
    "import {useRouter,redirect as go} from 'next/navigation'; import {withBasePath} from '@/lib/base-path'; const router=useRouter(); router.push(withBasePath('/settings')); router.replace('/mikka/settings'); go(withBasePath('/sign-in'));"
  assert.equal(inspect(code).length, 3)
})
test('normal routes, native href/fetch, absolute URLs, comments and shadowed variables stay legal', () => {
  for (const code of [
    '<NextLink href="/settings"/>',
    '<NextLink href="https://example.com/mikka/file"/>',
    '<a href={withBasePath(path)}/>',
    'fetch(withBasePath(path))',
    'const url=withBasePath(path); function Child(){ const url="/safe"; return <NextLink href={url}/> }',
    'const url=withBasePath(path); function Child(url){ return <NextLink href={url}/> }',
    '// <NextLink href="/mikka/bad"/>\nconst n=1',
  ])
    assert.equal(inspect(imports + code).length, 0, code)
})
test('the whole application follows the prefix contract', () => {
  assert.deepEqual(
    navigationPolicyFiles().flatMap((file) => auditBasePath(file, readFileSync(file, 'utf8'))),
    [],
  )
})
