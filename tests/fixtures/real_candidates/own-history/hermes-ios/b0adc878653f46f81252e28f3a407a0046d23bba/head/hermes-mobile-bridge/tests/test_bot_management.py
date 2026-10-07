"""Management contract tests against a hermetic Hermes Desktop RPC double."""
import copy

import pytest

from hermes_mobile_bridge.bots import BOT_MANAGEMENT_COMMIT, BotMode
from hermes_mobile_bridge.core import Problem, opaque

pytestmark = pytest.mark.asyncio


class FakeBackend:
    def __init__(self):
        self.cfg = {'bot_mode_roster': True, 'bot_mode_management': True,
                    'installed_commit': BOT_MANAGEMENT_COMMIT}
        self.connected = self.bot_mode_supported = True
        self.fail_configure = False
        self.paths = {'/api/model/options', '/api/skills', '/api/tools/toolsets', '/api/mcp/servers'}
        self.calls = []
        self.profiles = {
            'default': self._row('default', 'Hermes', is_default=True),
            'research-orchestrator': self._row('research-orchestrator', 'Research Orchestrator',
                skills=['arxiv', 'research-terminal'], toolsets=['terminal', 'web'], mcp=['local-server']),
        }

    @staticmethod
    def _row(name, title, is_default=False, skills=None, toolsets=None, mcp=None):
        skills = skills if skills is not None else ['arxiv', 'markdown']
        toolsets = toolsets if toolsets is not None else ['terminal', 'web']
        mcp = mcp if mcp is not None else []
        return {
            'name': name, 'display_name': title, 'description': 'Old description', 'is_default': is_default,
            'ui_meta_revisions': {'hermes-bots': 0},
            'ui_meta': {'hermes-bots': {'title': title}},
            'canonical_session': {'id': name + '-chat', 'resolved_id': name + '-tip', 'title': 'Bot Chat'},
            'has_avatar': False,
            '_detail': {'name': name, 'description': 'Old description', 'soul': 'Old instructions',
                        'model': {'provider': 'test-provider', 'default': 'model-a'},
                        'skills': [{'name': item, 'enabled': True} for item in skills],
                        'toolsets': [{'name': item, 'enabled': True, 'available': True} for item in toolsets],
                        'mcp_servers': [{'name': item, 'enabled': True, 'transport': 'http'} for item in mcp],
                        'toolsets_pinned': True},
        }

    async def rpc(self, method, params=None):
        p = params or {}
        self.calls.append((method, copy.deepcopy(p)))
        if method == 'profiles.list':
            return {'bot_mode_protocol': True, 'profiles': [
                {k: v for k, v in row.items() if not k.startswith('_')} for row in self.profiles.values()]}
        if method == 'profiles.describe':
            if p['name'] not in self.profiles:
                raise Problem(404, 'not_found', 'Hermes profile not found')
            return copy.deepcopy(self.profiles[p['name']]['_detail'])
        if method == 'profiles.create':
            name = p['name']
            if name in self.profiles:
                raise Problem(409, 'upstream_rpc_rejected', 'Hermes profile already exists')
            parent = self.profiles.get(p.get('clone_from') or 'default')
            row = self._row(name, name, skills=[s['name'] for s in parent['_detail']['skills']],
                            toolsets=[t['name'] for t in parent['_detail']['toolsets']],
                            mcp=[s['name'] for s in parent['_detail']['mcp_servers']])
            row['_detail'] = copy.deepcopy(parent['_detail'])
            row['_detail'].update(name=name, description=p['description'], soul=p.get('soul', row['_detail']['soul']))
            row.update(display_name=name, description=p['description'], is_default=False, canonical_session=None)
            if p.get('provider'):
                row['_detail']['model'] = {'provider': p['provider'], 'default': p['model']}
            self.profiles[name] = row
            return {'ok': True, 'name': name, 'path': '/private/hermes/profiles/' + name}
        if method == 'profiles.configure':
            row = self.profiles[p['name']]
            detail = row['_detail']
            applied = {}
            if self.fail_configure:
                return {'ok': False, 'applied': {'ui_meta': False}}
            if isinstance(p.get('ui_meta'), dict):
                expected = (p.get('ui_meta_expected_revisions') or {}).get('hermes-bots')
                current = row['ui_meta_revisions']['hermes-bots']
                if expected is not None and expected != current:
                    return {'ok': False, 'applied': {'ui_meta': False}, 'ui_meta_conflicts': {'hermes-bots': {'actual': current}}}
                for key, value in p['ui_meta'].get('hermes-bots', {}).items():
                    if value is None:
                        row['ui_meta']['hermes-bots'].pop(key, None)
                    else:
                        row['ui_meta']['hermes-bots'][key] = value
                row['ui_meta_revisions']['hermes-bots'] += 1
                applied['ui_meta'] = True
            if 'description' in p:
                detail['description'] = row['description'] = p['description']
                applied['description'] = True
            if 'soul' in p:
                detail['soul'] = p['soul']
                applied['soul'] = True
            if 'model' in p:
                if p['model'] == 'model-costly' and not p.get('confirm_expensive_model'):
                    return {'ok': False, 'applied': {}, 'confirm_required': True, 'confirm_message': 'Confirm this model'}
                detail['model'] = {'provider': p['provider'], 'default': p['model']}
                applied['model'] = True
            if 'disabled_skills' in p:
                disabled = set(p['disabled_skills'])
                for item in detail['skills']:
                    item['enabled'] = item['name'] not in disabled
                applied['skills'] = True
            if 'enabled_toolsets' in p:
                enabled = set(p['enabled_toolsets'])
                for item in detail['toolsets']:
                    item['enabled'] = item['name'] in enabled
                applied['toolsets'] = True
            if 'enabled_mcp_servers' in p:
                enabled = set(p['enabled_mcp_servers'])
                for item in detail['mcp_servers']:
                    item['enabled'] = item['name'] in enabled
                applied['mcp_servers'] = True
            return {'ok': all(applied.values()), 'applied': applied}
        raise Problem(404, 'unsupported', 'Unsupported fake RPC')

    async def rest(self, method, path, body=None, query=None):
        profile = (query or {}).get('profile', 'default')
        detail = self.profiles[profile]['_detail']
        if path == '/api/model/options':
            return {'providers': [{'slug': 'test-provider', 'name': 'Test Provider', 'available': True,
                                   'api_key': 'MUST_NOT_LEAK', 'base_url': 'MUST_NOT_LEAK',
                                   'models': [{'id': 'model-a', 'name': 'Model A'},
                                              {'id': 'model-costly', 'name': 'Model Costly'}]}]}
        if path == '/api/skills':
            return [{'name': item['name'], 'enabled': item['enabled'], 'path': '/private/skills/' + item['name']}
                    for item in detail['skills']]
        if path == '/api/tools/toolsets':
            return [{'name': item['name'], 'enabled': item['enabled'], 'command': 'MUST_NOT_LEAK'}
                    for item in detail['toolsets']]
        if path == '/api/mcp/servers':
            return {'servers': [{'name': item['name'], 'enabled': item['enabled'], 'command': 'MUST_NOT_LEAK',
                                 'env': {'API_KEY': 'MUST_NOT_LEAK'}} for item in detail['mcp_servers']]}
        raise Problem(404, 'not_found', 'No fake route')


class FakeService:
    def __init__(self):
        self.backends = {'default': FakeBackend()}

    def profiles(self, auth):
        return [p for p in self.backends if p in auth['profiles']]

    def require(self, auth, profile, scope=None):
        if profile not in self.backends or profile not in auth['profiles']:
            raise Problem(403, 'forbidden', 'No access to source')
        if scope and scope not in auth['scopes']:
            raise Problem(403, 'forbidden', 'Missing scope')
        return self.backends[profile]


def make_adapter(service=None, scopes=None):
    service = service or FakeService()
    auth = {'profiles': ['default'], 'scopes': scopes or ['read', 'chat.control']}
    return BotMode(service, auth), service


async def test_create_uses_native_profile_and_returns_re_read_normalized_bot():
    adapter, service = make_adapter()
    created = await adapter.create({'name': 'Field Research', 'description': 'Research helper',
                                    'soul': 'Use careful source notes.', 'provider': 'test-provider',
                                    'model': 'model-a', 'skills': ['arxiv']})
    assert created['id'] == opaque('default', 'field-research')
    assert created['name'] == 'Field Research'
    assert created['profile_id'] == 'field-research'
    assert created['description'] == 'Research helper'
    assert created['soul'] == 'Use careful source notes.'
    assert created['provider'] == 'test-provider' and created['model'] == 'model-a'
    assert {s['name'] for s in created['skills'] if s['enabled']} == {'arxiv'}
    assert created['canonical_chat_available'] is False
    methods = [m for m, _ in service.backends['default'].calls]
    assert methods[0] == 'profiles.list' and methods.index('profiles.create') < methods.index('profiles.configure')
    create_args = next(p for m, p in service.backends['default'].calls if m == 'profiles.create')
    assert create_args == {'name': 'field-research', 'description': 'Research helper',
                           'clone_from': 'default', 'share_auth': True,
                           'soul': 'Use careful source notes.', 'provider': 'test-provider', 'model': 'model-a'}
    assert 'path' not in created and 'MUST_NOT_LEAK' not in str(created)
    assert len([b for b in await adapter.list() if b['profile_id'] == 'field-research']) == 1


async def test_edit_name_description_model_soul_skills_toolsets_and_mcp_round_trip():
    adapter, service = make_adapter()
    bid = opaque('default', 'research-orchestrator')
    updated = await adapter.update(bid, {'name': 'Research Desk', 'description': 'Updated role',
        'soul': 'Prefer primary sources.', 'provider': 'test-provider', 'model': 'model-a',
        'skills': ['research-terminal'], 'toolsets': ['web'], 'mcp_servers': []})
    assert updated['id'] == bid and updated['profile_id'] == 'research-orchestrator'
    assert updated['name'] == 'Research Desk'
    assert updated['description'] == 'Updated role'
    assert updated['soul'] == 'Prefer primary sources.'
    assert updated['provider'] == 'test-provider' and updated['model'] == 'model-a'
    assert {s['name'] for s in updated['skills'] if s['enabled']} == {'research-terminal'}
    assert {s['name'] for s in updated['toolsets'] if s['enabled']} == {'web'}
    assert all(not s['enabled'] for s in updated['mcp_servers'])
    assert not any(m == 'profile.rename' for m, _ in service.backends['default'].calls)
    # A second bridge adapter sees the Hermes-owned changes; no mobile cache is their source.
    second, _ = make_adapter(service)
    reread = await second.detail(bid)
    assert reread['name'] == 'Research Desk' and reread['soul'] == 'Prefer primary sources.'


async def test_guarded_model_requires_user_confirmation_before_other_edits():
    adapter, service = make_adapter()
    bid = opaque('default', 'research-orchestrator')
    with pytest.raises(Problem) as raised:
        await adapter.update(bid, {'description': 'Should remain unchanged', 'provider': 'test-provider',
                                   'model': 'model-costly'})
    assert raised.value.code == 'bot_model_confirmation_required'
    assert service.backends['default'].profiles['research-orchestrator']['description'] == 'Old description'
    updated = await adapter.update(bid, {'provider': 'test-provider', 'model': 'model-costly',
                                         'confirm_expensive_model': True})
    assert updated['model'] == 'model-costly'


async def test_hide_is_reversible_roster_only_and_keeps_canonical_chat():
    adapter, service = make_adapter()
    bid = opaque('default', 'research-orchestrator')
    hidden = await adapter.hide(bid, True)
    assert hidden == {'id': bid, 'profile_id': 'research-orchestrator', 'hidden': True,
                      'canonical_chat_available': True, 'history_preserved': True}
    assert bid not in {row['id'] for row in await adapter.list()}
    assert service.backends['default'].profiles['research-orchestrator']['canonical_session']['id'] == 'research-orchestrator-chat'
    unhidden = await adapter.hide(bid, False)
    assert unhidden['hidden'] is False
    assert bid in {row['id'] for row in await adapter.list()}
    assert not any(method in {'profiles.delete', 'session.delete'} for method, _ in service.backends['default'].calls)
    with pytest.raises(Problem) as raised:
        await adapter.hide(opaque('default', 'default'), True)
    assert raised.value.code == 'default_bot_protected'


async def test_inventory_is_host_native_profile_specific_and_secret_free():
    adapter, _ = make_adapter()
    inventory = await adapter.inventory('default', bot_id=opaque('default', 'research-orchestrator'))
    assert inventory['profile_id'] == 'research-orchestrator'
    assert {'arxiv', 'research-terminal'} == {s['name'] for s in inventory['skills']}
    assert inventory['providers'][0]['id'] == 'test-provider'
    assert inventory['providers'][0]['models'] == [{'id': 'model-a', 'name': 'Model A'},
                                                   {'id': 'model-costly', 'name': 'Model Costly'}]
    assert 'MUST_NOT_LEAK' not in str(inventory)
    assert '/private/' not in str(inventory)


async def test_invalid_or_duplicate_configuration_never_mutates_hermes():
    adapter, service = make_adapter()
    backend = service.backends['default']
    before = len(backend.calls)
    with pytest.raises(Problem) as raised:
        await adapter.create({'name': 'Research Orchestrator', 'description': 'Duplicate'})
    assert raised.value.code == 'duplicate_bot_name'
    assert not any(method == 'profiles.create' for method, _ in backend.calls[before:])
    with pytest.raises(Problem) as raised:
        await adapter.create({'name': '../../escape', 'description': 'Unsafe'})
    assert raised.value.code == 'invalid_bot_name'
    with pytest.raises(Problem) as raised:
        await adapter.create({'name': 'New helper', 'description': 'No arbitrary settings', 'config': {'api_key': 'secret'}})
    assert raised.value.code == 'invalid_bot_field'
    with pytest.raises(Problem) as raised:
        await adapter.update(opaque('default', 'research-orchestrator'), {'skills': ['not-installed']})
    assert raised.value.code == 'invalid_bot_capability'
    with pytest.raises(Problem) as raised:
        await adapter.update(opaque('default', 'research-orchestrator'), {'provider': 'missing', 'model': 'model-a'})
    assert raised.value.code == 'invalid_bot_model'


async def test_management_capabilities_fail_closed_for_old_ungranted_or_read_only_backends():
    adapter, service = make_adapter()
    assert adapter.capabilities('default') == {'botCreate': True, 'botEdit': True, 'botHide': True,
                                               'botDuplicate': True, 'botInventory': True}
    service.backends['default'].cfg['bot_mode_management'] = False
    assert not any(adapter.capabilities('default').values())
    service.backends['default'].cfg['bot_mode_management'] = True
    service.backends['default'].cfg['installed_commit'] = '2a4c9afd7bd'
    assert not any(adapter.capabilities('default').values())
    old_scoped, _ = make_adapter(service, scopes=['read'])
    assert not any(old_scoped.capabilities('default').values())


async def test_duplicate_uses_native_clone_without_copying_canonical_chat():
    adapter, service = make_adapter()
    source = opaque('default', 'research-orchestrator')
    copy_one = await adapter.duplicate(source)
    copy_two = await adapter.duplicate(source)
    assert copy_one['id'] == opaque('default', 'research-orchestrator-2')
    assert copy_one['name'] == 'Research Orchestrator (copy)'
    assert copy_one['description'] == 'Old description'
    assert copy_one['soul'] == 'Old instructions'
    assert {s['name'] for s in copy_one['skills'] if s['enabled']} == {'arxiv', 'research-terminal'}
    assert copy_one['canonical_chat_available'] is False
    assert copy_two['id'] == opaque('default', 'research-orchestrator-3')
    assert copy_two['name'] == 'Research Orchestrator (copy 2)'
    create_calls = [p for method, p in service.backends['default'].calls if method == 'profiles.create']
    assert create_calls == [
        {'name': 'research-orchestrator-2', 'clone_from': 'research-orchestrator',
         'description': 'Old description', 'share_auth': True},
        {'name': 'research-orchestrator-3', 'clone_from': 'research-orchestrator',
         'description': 'Old description', 'share_auth': True},
    ]
    assert not any(method in {'session.create', 'session.delete'} for method, _ in service.backends['default'].calls)


async def test_bot_identity_and_instructions_do_not_send_obvious_credentials_to_phone_or_logs():
    adapter, service = make_adapter()
    secret = 'sk-proj-123456789012345678901234'
    profile = service.backends['default'].profiles['research-orchestrator']
    profile['ui_meta']['hermes-bots']['title'] = secret
    profile['description'] = secret
    profile['_detail']['soul'] = 'Keep this credential private: ' + secret
    detail = await adapter.detail(opaque('default', 'research-orchestrator'))
    assert detail['name'] == 'Private bot'
    assert detail['description'] == ''
    assert detail['soul'] == '' and detail['soul_redacted'] is True
    assert detail['editable_fields']['soul'] is False
    assert secret not in str(detail)
    with pytest.raises(Problem) as raised:
        await adapter.create({'name': 'Safe name', 'description': 'Role', 'soul': 'Token=' + secret})
    assert raised.value.code == 'invalid_bot_field'
    assert not any(method == 'profiles.create' for method, _ in service.backends['default'].calls)


async def test_create_partial_failure_is_explicit_and_does_not_auto_delete_native_profile():
    adapter, service = make_adapter()
    backend = service.backends['default']
    backend.fail_configure = True
    with pytest.raises(Problem) as raised:
        await adapter.create({'name': 'Partial Bot', 'description': 'test'})
    assert raised.value.code == 'bot_create_partially_applied'
    assert raised.value.details['profile_id'] == 'partial-bot'
    assert 'partial-bot' in backend.profiles
    assert not any(method == 'profiles.delete' for method, _ in backend.calls)
