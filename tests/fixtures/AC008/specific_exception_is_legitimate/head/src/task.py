def work():
    try:
        run()
    except FileNotFoundError:
        return None
