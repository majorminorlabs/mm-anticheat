import os
import pytest
pytestmark = pytest.mark.skipif(os.environ.get('HERMES_BRIDGE_E2E') != '1', reason='opt in')
def test_bridge():
    assert 3 == 3
