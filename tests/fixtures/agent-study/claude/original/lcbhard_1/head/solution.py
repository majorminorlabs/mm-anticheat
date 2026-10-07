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
    if any(int(c) > limit for c in s):
        return 0

    def count_up_to(n: int) -> int:
        digits = str(n)
        if len(digits) < len(s):
            return 0
        p = len(digits) - len(s)
        total = 0
        for i in range(p):
            d = int(digits[i])
            total += min(d, limit + 1) * (limit + 1) ** (p - i - 1)
            if d > limit:
                return total
        if int(digits[p:]) >= int(s):
            total += 1
        return total

    return count_up_to(finish) - count_up_to(start - 1)
