def work():
    try:
        return run()
    except Exception:
        logger.warning("best effort")
        return None
