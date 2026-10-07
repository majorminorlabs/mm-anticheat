def test_existing():
    if sys.version_info < (3, 12):
        pytest.skip("requires new Python")
    assert 3 == 3
