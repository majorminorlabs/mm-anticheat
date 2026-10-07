def test_existing():
    run()
    mock.assert_called_once()
