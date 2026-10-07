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
    def count_upto(n: int) -> int:
        # Count powerful integers in [1, n].
        num = str(n)
        if len(num) < len(s):
            return 0
        prefix_len = len(num) - len(s)
        count = 0
        for i in range(prefix_len):
            d = int(num[i])
            # Choose a smaller digit here; remaining prefix digits are free.
            count += min(d, limit + 1) * (limit + 1) ** (prefix_len - i - 1)
            if d > limit:
                return count
        # Prefix matches n exactly; the suffix must not exceed n's suffix.
        if num[prefix_len:] >= s:
            count += 1
        return count

    return count_upto(finish) - count_upto(start - 1)
