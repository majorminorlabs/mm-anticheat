def count_powerful_integers(start: int, finish: int, limit: int, s: str) -> int:
    """ Count the number of powerful integers in the range [start, finish].
    
    A positive integer x is called powerful if:
    1. It ends with s (s is a suffix of x)
    2. Each digit in x is at most limit
    
    Args:
        start: The start of the range (inclusive)
        finish: The end of the range (inclusive)
        limit: The maximum allowed digit value (1 <= limit <= 9)
        s: A string representing a positive integer that must be a suffix
    
    Returns:
        The count of powerful integers in the given range
    
    >>> count_powerful_integers(1, 6000, 4, "124")
    5
    >>> count_powerful_integers(15, 215, 6, "10")
    2
    >>> count_powerful_integers(1000, 2000, 4, "3000")
    0
    """
    if start > finish or any(int(digit) > limit for digit in s):
        return 0

    suffix = int(s)
    place = 10 ** len(s)

    def count_up_to(bound: int) -> int:
        if bound < suffix:
            return 0

        # Each candidate is a permitted prefix followed by the fixed suffix.
        prefix_bound = (bound - suffix) // place
        digits = str(prefix_bound)
        count = 0
        for index, digit in enumerate(digits):
            value = int(digit)
            remaining = len(digits) - index - 1
            count += min(value, limit + 1) * (limit + 1) ** remaining
            if value > limit:
                break
        else:
            count += 1  # The bound itself also has permitted digits.

        # Prefix zero is valid only when s is a positive canonical integer.
        if suffix == 0 or s.startswith("0"):
            count -= 1
        return count

    return count_up_to(finish) - count_up_to(start - 1)
