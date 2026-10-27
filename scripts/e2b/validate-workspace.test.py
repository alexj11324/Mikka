import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name('validate-workspace.py')

class ValidateWorkspaceTest(unittest.TestCase):
    def test_rejects_executable_config_without_printing_it(self):
        with tempfile.TemporaryDirectory() as temp:
            subprocess.run(['git', '-C', temp, 'init', '-q'], check=True)
            def validate():
                return subprocess.run(['python3', str(SCRIPT), temp], capture_output=True, text=True)
            self.assertEqual(validate().returncode, 0)
            subprocess.run(['git', '-C', temp, 'config', '--local', 'filter.example.smudge', 'secret-command'], check=True)
            result = validate()
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn('secret-command', result.stderr)
            subprocess.run(['git', '-C', temp, 'config', '--local', '--unset', 'filter.example.smudge'], check=True)
            subprocess.run(['git', '-C', temp, 'config', '--local', 'include.path', '/tmp/untrusted'], check=True)
            self.assertNotEqual(validate().returncode, 0)

if __name__ == '__main__':
    unittest.main()
