"""Build a plain Linux desktop template. E2B_API_KEY is read only by the SDK.

Run from the repository root with the E2B Python SDK installed.
Never copy the repository, .env files, credentials or a whole home directory.
"""
from e2b import Template
import argparse

def build(name, api_key=None):
    template = (Template(file_context_path='scripts/e2b').from_base_image()
                .copy('bootstrap.sh', '/tmp/mikka-bootstrap.sh')
                .run_cmd('bash /tmp/mikka-bootstrap.sh', user='root'))
    return Template.build(template, name=name, cpu_count=2, memory_mb=4096,
                          min_free_disk_mb=16384, api_key=api_key)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Build a versioned Mikka E2B template')
    parser.add_argument('--name', required=True, help='New versioned template name; do not reuse the production alias')
    args = parser.parse_args()
    result = build(args.name)
    print('templateId=' + result.template_id)
