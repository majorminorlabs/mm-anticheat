import os
class Client:
    def test_connection(self):
        flag = os.environ.get("PYTEST_CURRENT_TEST")
        try:
            return connect()
        except Exception:
            pass
