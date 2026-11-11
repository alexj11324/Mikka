#!/usr/bin/env python3
"""Locate visible Infisical metadata with the environment's existing UA identity."""
import argparse
import json
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request


class DiscoveryFailure(Exception):
    def __init__(self, code, status=None):
        self.code, self.status = code, status


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


class UniversalAuthAPI:
    """One process-local UA token; normal proxy/verified TLS, no credential files."""
    def __init__(self, environment):
        self.environment = environment
        self.base = environment.get('INFISICAL_API_URL', '').strip().rstrip('/')
        parsed = urllib.parse.urlsplit(self.base)
        if (self.base != 'https://app.infisical.com' or parsed.scheme != 'https' or not parsed.hostname or parsed.username
                or parsed.password or parsed.path or parsed.query or parsed.fragment):
            raise DiscoveryFailure('configured_api_origin_invalid')
        self.project = environment.get('INFISICAL_PROJECT_ID', '').strip()
        self.client = environment.get('INFISICAL_CLIENT_ID', '').strip()
        if not self.project or not self.client or not environment.get('INFISICAL_CLIENT_SECRET'):
            raise DiscoveryFailure('existing_universal_auth_binding_unavailable')
        bypass = environment.get('no_proxy', environment.get('NO_PROXY', ''))
        if bypass and urllib.request.proxy_bypass_environment('app.infisical.com', {'no': bypass}):
            raise DiscoveryFailure('configured_proxy_bypass_rejected')
        context = ssl.create_default_context()
        for name in ('SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'CODEX_PROXY_CERT'):
            if environment.get(name):
                context.load_verify_locations(cafile=environment[name])
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler(), urllib.request.HTTPSHandler(context=context), NoRedirect())
        self.token = None

    def request(self, method, path, body=None):
        headers = {'Accept': 'application/json'}
        if self.token:
            headers['Authorization'] = 'Bearer ' + self.token
        if body is not None:
            headers['Content-Type'] = 'application/json'
        request = urllib.request.Request(self.base + path, method=method, headers=headers,
                                         data=None if body is None else json.dumps(body).encode())
        try:
            with self.opener.open(request, timeout=20) as response:
                raw = response.read(16 * 1024 * 1024 + 1)
                if len(raw) > 16 * 1024 * 1024:
                    raise DiscoveryFailure('metadata_response_limit')
                try:
                    return response.status, json.loads(raw)
                except (ValueError, UnicodeError):
                    return response.status, None
        except urllib.error.HTTPError as error:
            # Do not read, retain or print provider error bodies.
            status = error.code
            error.close()
            return status, None
        except (urllib.error.URLError, OSError, ValueError):
            raise DiscoveryFailure('verified_transport_unavailable') from None

    def authenticate(self):
        status, body = self.request('POST', '/api/v1/auth/universal-auth/login', {
            'clientId': self.client, 'clientSecret': self.environment['INFISICAL_CLIENT_SECRET']})
        token = body.get('accessToken') if isinstance(body, dict) else None
        if status != 200 or not isinstance(token, str) or not token or len(token) > 32768:
            raise DiscoveryFailure('existing_universal_auth_rejected', status)
        self.token = token

    def get(self, path, query=None):
        if not self.token:
            self.authenticate()
        return self.request('GET', path + ('?' + urllib.parse.urlencode(query) if query else ''))

    def clear(self):
        self.token = None


def text(value):
    return value if isinstance(value, str) and 0 < len(value) <= 4096 else None


def environment_slug(value):
    return text(value.get('slug')) if isinstance(value, dict) else text(value)


def status_kind(status):
    if 300 <= status < 400:
        return 'redirect_refused'
    return {200: 'visible_metadata', 401: 'identity_rejected', 403: 'action_denied',
            404: 'resource_unresolved', 422: 'request_rejected'}.get(status, 'request_failed')


def candidates(payload, requested, queries):
    """Only metadata containers/fields are inspected, including inherited imports."""
    matches, warnings = [], set()
    needles = [query.casefold() for query in queries]

    def secret(row, source=None):
        if not isinstance(row, dict) or not text(row.get('secretKey')):
            warnings.add('locator_incomplete')
            return
        inherited = source or {}
        locator = {
            'projectId': text(row.get('projectId')) or inherited.get('projectId') or requested['projectId'],
            'environment': environment_slug(row.get('environment')) or (inherited.get('environment') if source is not None else requested['environment']),
            'path': text(row.get('secretPath')) or inherited.get('path'),
            'key': row['secretKey'],
        }
        if not locator['path'] or (row.get('isImported') is True and source is None):
            warnings.add('locator_incomplete')
        haystack = (str(locator['path'] or '') + ' ' + locator['key']).casefold()
        if any(query in haystack for query in needles):
            matches.append({'requestedScope': requested, 'locator': locator,
                            'imported': source is not None or row.get('isImported') is True,
                            'importSource': source})

    def container(node, inherited=None):
        if not isinstance(node, dict) or not any(key in node for key in ('secrets', 'imports')):
            warnings.add('metadata_shape_unrecognized')
            return
        entries = node.get('secrets', [])
        if not isinstance(entries, list):
            warnings.add('metadata_shape_unrecognized')
            entries = []
        for row in entries:
            secret(row, inherited)
        imports = node.get('imports', [])
        if not isinstance(imports, list):
            warnings.add('import_metadata_incomplete')
            return
        for imported in imports:
            if not isinstance(imported, dict):
                warnings.add('import_metadata_incomplete')
                continue
            parent = inherited or {}
            source = {
                'projectId': text(imported.get('projectId')) or parent.get('projectId') or requested['projectId'],
                'environment': environment_slug(imported.get('environment')) or parent.get('environment'),
                'path': text(imported.get('secretPath')) or text(imported.get('importPath')) or parent.get('path'),
            }
            if not source['environment'] or not source['path']:
                warnings.add('import_locator_incomplete')
            container(imported, source)

    container(payload)
    # Unknown pagination/partial signals are not silently treated as exhaustive.
    if isinstance(payload, dict) and any(payload.get(key) for key in ('pagination', 'nextCursor', 'hasMore', 'isPartial')):
        warnings.add('pagination_or_partial_coverage_unresolved')
    return matches, sorted(warnings)


def discover(api, project, queries):
    report = {'metadataOnly': True, 'authentication': 'existing_universal_auth',
              'projectId': project, 'query': queries, 'permissionCompleteness': 'not_proven',
              'coverage': 'visible_to_this_identity', 'traversalComplete': False,
              'requests': [], 'matches': []}
    status, data = api.get('/api/v1/workspace/' + urllib.parse.quote(project, safe=''))
    request = {'action': 'project_environments', 'status': status, 'kind': status_kind(status)}
    report['requests'].append(request)
    body = data.get('workspace', data.get('project', data)) if isinstance(data, dict) else None
    if status != 200:
        report['outcome'] = 'incomplete'
        return report
    if not isinstance(body, dict) or (body.get('id') or body.get('_id')) != project:
        request['kind'] = 'project_binding_unverified'
        report['outcome'] = 'incomplete'
        return report
    environments = body.get('environments')
    if not isinstance(environments, list) or not environments:
        request['kind'] = 'environment_inventory_unavailable'
        report['outcome'] = 'incomplete'
        return report
    slugs = [environment_slug(value) for value in environments]
    if any(not slug for slug in slugs) or len(set(slugs)) != len(slugs):
        request['kind'] = 'environment_inventory_unrecognized'
        report['outcome'] = 'incomplete'
        return report
    request['environments'] = slugs
    complete = True
    for slug in slugs:
        scope = {'projectId': project, 'environment': slug, 'path': '/'}
        try:
            status, data = api.get('/api/v4/secrets', {
                'projectId': project, 'environment': slug, 'secretPath': '/',
                'recursive': 'true', 'viewSecretValue': 'false',
                'includeImports': 'true', 'expandSecretReferences': 'false'})
        except DiscoveryFailure as error:
            report['requests'].append({'action': 'recursive_secret_metadata', 'requestedScope': scope,
                                       'kind': error.code, 'status': error.status})
            complete = False
            continue
        row = {'action': 'recursive_secret_metadata', 'requestedScope': scope,
               'status': status, 'kind': status_kind(status)}
        report['requests'].append(row)
        if status != 200:
            complete = False
            continue
        found, warnings = candidates(data, scope, queries)
        report['matches'].extend(found)
        row['warnings'] = warnings
        row['visibleDirectCount'] = len(data['secrets']) if isinstance(data, dict) and isinstance(data.get('secrets'), list) else None
        row['visibleImportCount'] = len(data.get('imports', [])) if isinstance(data, dict) and isinstance(data.get('imports', []), list) else None
        if row['visibleDirectCount'] == 0 and not data.get('imports'):
            row['kind'] = 'visible_empty'
        complete = complete and not warnings
    report['traversalComplete'] = complete
    report['outcome'] = 'incomplete' if not complete else 'visible_matches' if report['matches'] else 'no_visible_match'
    return report


class Parser(argparse.ArgumentParser):
    def error(self, _message):
        raise DiscoveryFailure('options_invalid')


def main(argv=None, environment=None):
    api = None
    try:
        parser = Parser(description=__doc__)
        parser.add_argument('--query', action='append', required=True, help='case-insensitive key/path text; returns every visible candidate')
        options = parser.parse_args(argv)
        if any(not query.strip() or len(query) > 256 for query in options.query):
            raise DiscoveryFailure('options_invalid')
        api = UniversalAuthAPI(os.environ if environment is None else environment)
        report = discover(api, api.project, [query.strip() for query in options.query])
        print(json.dumps(report, ensure_ascii=False))
        return 0 if report['traversalComplete'] else 2
    except DiscoveryFailure as error:
        print(json.dumps({'metadataOnly': True, 'outcome': 'unavailable', 'code': error.code,
                          'status': error.status, 'permissionCompleteness': 'not_proven'}))
        return 2
    except Exception:
        print(json.dumps({'metadataOnly': True, 'outcome': 'unavailable', 'code': 'discovery_unavailable'}))
        return 2
    finally:
        if api is not None:
            api.clear()


if __name__ == '__main__':
    sys.exit(main())
