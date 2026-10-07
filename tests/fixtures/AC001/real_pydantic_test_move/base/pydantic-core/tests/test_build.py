@pytest.mark.parametrize('pickle_protocol', range(1, pickle.HIGHEST_PROTOCOL + 1))
def test_pickle(pickle_protocol: int) -> None:
    v1 = SchemaValidator(cs.bool_schema())
    assert v1.validate_python('tRuE') is True
    p = pickle.dumps(v1, protocol=pickle_protocol)
    v2 = pickle.loads(p)
    assert v2.validate_python('tRuE') is True
    assert repr(v1) == repr(v2)
