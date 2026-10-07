"""Read-only Bot Mode adapter for the audited profile-backed Desktop roster.

No paths, arbitrary config, credentials, or chat ownership cross this boundary.
A backend must explicitly opt its whole local roster into mobile read access.
"""
from .core import Problem, identifier, opaque, unopaque, only, message

AUDITED_COMMITS = ('2a4c9afd7bd', '4bb9e57bfde8a0affb5553eff13ed6e1f14147f1')


def bot_row(source, row):
    name = identifier(row['name'])
    meta = (row.get('ui_meta') or {}).get('hermes-bots') or {}
    title = meta.get('title') or row.get('display_name') or ('Hermes' if name == 'default' else name.replace('-', ' ').replace('_', ' ').title())
    sessions = [s for s in (row.get('canonical_session'), row.get('last_session'), row.get('worker_session')) if isinstance(s, dict)]
    last = max(sessions, key=lambda s: s.get('last_active') or 0, default={})
    return {'id': opaque(source, name), 'name': title.strip(), 'profile_id': name,
            'is_default': bool(row.get('is_default') or name == 'default'),
            'description': meta.get('description') or row.get('description') or '',
            # Backend role is a permission role, not a guessed research/general category.
            'role': row.get('role') or '', 'model': row.get('model'), 'provider': row.get('provider'),
            'status': 'unknown', 'last_active': last.get('last_active'),
            'activity': only(last, 'title preview last_active'), 'has_avatar': bool(row.get('has_avatar')),
            'canonical_chat_available': isinstance(row.get('canonical_session'), dict),
            'source': 'hermes_desktop_profiles', 'activity_coverage': 'persisted_sessions_and_this_backend_only'}


class BotMode:
    def __init__(self, service, auth):
        self.service, self.auth = service, auth

    async def roster(self, source):
        backend = self.service.require(self.auth, source)
        if not backend.cfg.get('bot_mode_roster'):
            raise Problem(404, 'bot_mode_unavailable', 'Bot Mode is not enabled on this backend')
        raw = await backend.rpc('profiles.list', {'include_sessions': True})
        if raw.get('bot_mode_protocol') is not True:
            raise Problem(404, 'bot_mode_unavailable', 'This Hermes backend has no audited Bot Mode contract')
        return backend, [r for r in raw.get('profiles', []) if isinstance(r, dict) and not (r.get('ui_meta') or {}).get('hermes-bots', {}).get('hidden')]

    async def list(self):
        result = []
        for source in self.service.profiles(self.auth):
            if self.service.backends[source].cfg.get('bot_mode_roster'):
                _, rows = await self.roster(source)
                result.extend(bot_row(source, r) for r in rows)
        return result

    async def resolve(self, bid):
        source, name = unopaque(bid)
        backend, rows = await self.roster(source)
        row = next((r for r in rows if r.get('name') == name), None)
        if row is None:
            raise Problem(404, 'not_found', 'Bot is no longer in the Studio roster')
        return source, name, backend, row

    async def detail(self, bid):
        source, name, backend, row = await self.resolve(bid)
        raw = await backend.rpc('profiles.describe', {'name': name})
        result = bot_row(source, row)
        model = raw.get('model') or {}
        result.update(model=model.get('default') or result['model'], provider=model.get('provider') or result['provider'],
                      soul_summary=(raw.get('soul') or '')[:12000] or None,
                      skills=[only(s, 'name enabled') for s in raw.get('skills', [])],
                      toolsets=[only(t, 'name enabled available') for t in raw.get('toolsets', [])],
                      mcp_servers=[only(m, 'name enabled transport') for m in raw.get('mcp_servers', [])],
                      config_metadata={'toolsets_pinned': raw.get('toolsets_pinned'), 'source': 'profiles.describe'})
        if row.get('has_avatar'):
            asset = await backend.rpc('profiles.get_asset', {'name': name, 'asset': 'avatar'})
            data = asset.get('data')
            if isinstance(data, str) and len(data) <= 2800000 and data.startswith(('data:image/png;base64,', 'data:image/jpeg;base64,', 'data:image/webp;base64,')):
                result['avatar_data'] = data
        # Safe allowlisted metadata only. Optional resources stay absent on failure.
        for resource, path in [('routines', '/api/cron/jobs'), ('memory', '/api/memory')]:
            try:
                value = await backend.rest('GET', path, query={'profile': name})
                if resource == 'routines' and isinstance(value, list):
                    result[resource] = [only(v, 'id name enabled last_run_at last_status next_run_at') for v in value]
                elif resource == 'memory' and isinstance(value, dict):
                    result['memory_metadata'] = {'active': value.get('active'), 'providers': [only(v, 'name configured') for v in value.get('providers', [])], 'builtin_bytes': only(value.get('builtin_files') or {}, 'memory user')}
            except Problem:
                pass
        try:
            plugins = await backend.rpc('plugins.manage', {'profile': name, 'action': 'list'})
            result['plugins'] = [only(v, 'name enabled') for v in plugins.get('plugins', [])]
        except Problem:
            pass
        return result

    async def conversation(self, bid):
        source, name, backend, _ = await self.resolve(bid)
        # Indexed exact-title lookup EVERY open/read. Never use recency or a saved id pin.
        raw = await backend.rpc('session.list', {'profile': name, 'title': 'Bot Chat', 'include_hidden': True})
        rows = raw.get('sessions', [])
        if not rows:
            raise Problem(404, 'bot_chat_unavailable', 'This bot has no canonical Bot Chat yet; open it on the Studio')
        row = rows[0]
        if row.get('title') != 'Bot Chat':
            raise Problem(502, 'bot_chat_contract_mismatch', 'Hermes did not resolve the exact Bot Chat identity')
        sid = identifier(row.get('resolved_id') or row['id'])
        history = await backend.rest('GET', f'/api/sessions/{sid}/messages', query={'profile': name})
        return {'conversation': {'id': 'botchat.' + bid, 'profile': bid, 'title': 'Bot Chat', 'read_only': True,
                                'model': row.get('model'), 'source': 'api', **only(row, 'started_at message_count last_active preview')},
                'messages': [message(m) for m in history.get('messages', [])], 'observed_runs': []}
