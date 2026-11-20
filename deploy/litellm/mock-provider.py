"""A provider that speaks only OpenAI Chat Completions, for the conversion proof.

Used with tests/model-gateway-litellm.test.ts against the real LiteLLM image:
offered tools, it streams one `bash` tool call (usage 20 in / 5 out); otherwise
it streams a short reply (usage 11 in / 2 out). Every other path is a 404, so a
request LiteLLM failed to convert to Chat Completions cannot pass. It also
refuses a request without the person's key the gateway forwards.
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

KEY = 'Bearer sk-person-key'


def chunk(delta, finish=None, usage=None):
    body = {'id': 'chatcmpl-mock', 'object': 'chat.completion.chunk', 'created': 0, 'model': 'mock',
            'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
    if usage:
        body['usage'] = usage
    return 'data: ' + json.dumps(body) + '\n\n'


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        if self.path.rstrip('/') not in ('/v1/chat/completions', '/chat/completions'):
            self.send_error(404)
            return
        if self.headers.get('authorization') != KEY:
            self.send_error(401)
            return
        request = json.loads(self.rfile.read(int(self.headers.get('content-length', 0))) or b'{}')
        if request.get('model') not in ('zai/glm-5', 'fixture/provider-model'):
            self.send_error(400, 'model routing changed the provider/model slug')
            return
        tool = bool(request.get('tools'))
        usage = ({'prompt_tokens': 20, 'completion_tokens': 5, 'total_tokens': 25} if tool
                 else {'prompt_tokens': 11, 'completion_tokens': 2, 'total_tokens': 13})
        if tool:
            parts = [chunk({'role': 'assistant', 'tool_calls': [{'index': 0, 'id': 'call_mock', 'type': 'function',
                                                                'function': {'name': 'bash', 'arguments': ''}}]}),
                     chunk({'tool_calls': [{'index': 0, 'function': {'arguments': '{"c": "ls"}'}}]}),
                     chunk({}, 'tool_calls')]
            message = {'role': 'assistant', 'content': None, 'tool_calls': [{'id': 'call_mock', 'type': 'function',
                       'function': {'name': 'bash', 'arguments': '{"c": "ls"}'}}]}
            finish = 'tool_calls'
        else:
            parts = [chunk({'role': 'assistant', 'content': 'Hello'}), chunk({'content': '.'}), chunk({}, 'stop')]
            message, finish = {'role': 'assistant', 'content': 'Hello.'}, 'stop'
        if not request.get('stream'):
            body = json.dumps({'id': 'chatcmpl-mock', 'object': 'chat.completion', 'created': 0, 'model': 'mock',
                               'choices': [{'index': 0, 'message': message, 'finish_reason': finish}], 'usage': usage}).encode()
            self.send_response(200)
            self.send_header('content-type', 'application/json')
            self.send_header('content-length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(200)
        self.send_header('content-type', 'text/event-stream')
        self.end_headers()
        usage_chunk = 'data: ' + json.dumps({'id': 'chatcmpl-mock', 'object': 'chat.completion.chunk', 'created': 0,
                                             'model': 'mock', 'choices': [], 'usage': usage}) + '\n\n'
        for part in [*parts, usage_chunk, 'data: [DONE]\n\n']:
            self.wfile.write(part.encode())
            self.wfile.flush()


if __name__ == '__main__':
    ThreadingHTTPServer(('0.0.0.0', int(sys.argv[1]) if len(sys.argv) > 1 else 9911), Provider).serve_forever()
