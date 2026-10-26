"""Build a plain Linux desktop template. E2B_API_KEY is read only by the SDK.

Run from the repository root with e2b==2.28.0 or a compatible SDK installed.
Never copy the repository, .env files, credentials or a whole home directory.
"""
from e2b import Template

def build(api_key=None):
    template = (Template(file_context_path='scripts/e2b').from_base_image()
                .copy('bootstrap.sh', '/tmp/mikka-bootstrap.sh')
                .run_cmd('bash /tmp/mikka-bootstrap.sh', user='root'))
    return Template.build(template, name='mikka-cloud-desktop', cpu_count=2,
                          memory_mb=2048, api_key=api_key)

if __name__ == '__main__':
    result = build()
    print('templateId=' + result.template_id)
