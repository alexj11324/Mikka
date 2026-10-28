"""Source-level STOP regression: no gateway imports or external resources."""
import ast
from pathlib import Path
from types import SimpleNamespace
import unittest

source = ast.parse(Path(__file__).with_name('subagent-gateway.py').read_text())
browser = next(node for node in source.body if isinstance(node, ast.ClassDef) and node.name == 'Browser')
methods = [node for node in browser.body if isinstance(node, ast.AsyncFunctionDef) and node.name in ('stop', 'rpc')]
namespace = {}
exec(compile(ast.Module(body=methods, type_ignores=[]), '<gateway-retention-methods>', 'exec'), namespace)


class RetainTest(unittest.IsolatedAsyncioTestCase):
    async def test_stop_revokes_and_closes_channels_without_process_teardown(self):
        events = []

        class Marker:
            def write_text(self, value): events.append(('marker', value))

        class Socket:
            async def close(self): events.append(('socket', 'closed'))

        class Process:
            def terminate(self): raise AssertionError('resource termination is forbidden')
            def kill(self): raise AssertionError('resource termination is forbidden')

        state = SimpleNamespace(stopped=False, frame='buffered', revoked_file=Marker(), session=None,
                                viewer={Socket()}, brokers={Socket()}, process=Process())
        await namespace['stop'](state)
        self.assertTrue(state.stopped)
        self.assertIsNone(state.frame)
        self.assertEqual(events, [('marker', 'stopped'), ('socket', 'closed'), ('socket', 'closed')])

    async def test_revoked_browser_cannot_send_runtime_rpc(self):
        state = SimpleNamespace(stopped=True)
        with self.assertRaisesRegex(RuntimeError, 'revoked'):
            await namespace['rpc'](state, 'Input.insertText', {'text': 'synthetic'})

    async def test_live_target_is_frozen_and_failure_is_reported(self):
        calls = []

        class Marker:
            def write_text(self, value): pass

        async def rpc(method, params=None, session=None): calls.append((method, params, session))
        state = SimpleNamespace(stopped=False, frame='buffered', revoked_file=Marker(),
                                viewer=set(), brokers=set(), session='bound', _rpc=rpc)
        await namespace['stop'](state)
        self.assertEqual(calls, [('Emulation.setScriptExecutionDisabled', {'value': True}, 'bound'),
                                 ('Page.stopScreencast', None, 'bound')])

        async def unavailable(*args, **kwargs): raise RuntimeError('suspension unavailable')
        state._rpc = unavailable
        with self.assertRaisesRegex(RuntimeError, 'suspension unavailable'):
            await namespace['stop'](state)
        self.assertTrue(state.stopped)


if __name__ == '__main__':
    unittest.main()
