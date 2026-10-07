def count_power_representations(n: int) -> int:
    """ Count how many integers x between 1 and n (inclusive) can be expressed as x = a^b
    where a is a positive integer and b is an integer greater than or equal to 2.
    
    Args:
        n: The upper bound (1 <= n <= 10^18)
    
    Returns:
        The count of integers that can be expressed as a^b where b >= 2
    
    >>> count_power_representations(99)
    12
    >>> count_power_representations(1000000000000000000)
    1001003332
    """
    from math import isqrt

    # Perfect squares (including 1) are counted directly; higher powers that
    # are not squares are collected explicitly (at most ~n^(1/3) of them).
    others = set()
    a = 2
    while a * a * a <= n:
        x = a * a * a
        while x <= n:
            r = isqrt(x)
            if r * r != x:
                others.add(x)
            x *= a
        a += 1
    return isqrt(n) + len(others)
