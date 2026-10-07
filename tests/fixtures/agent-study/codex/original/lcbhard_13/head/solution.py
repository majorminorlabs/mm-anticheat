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

    # Include 1 separately. For x > 1, the greatest common divisor of
    # its prime-factor exponents determines whether x is a perfect power.
    # Mobius inversion counts each such x exactly once, even when it has
    # several representations (for example, 64 = 8^2 = 4^3 = 2^6).
    total = 1
    for exponent in range(2, n.bit_length()):
        remaining = exponent
        mobius = 1
        factor = 2
        while factor * factor <= remaining:
            if remaining % factor == 0:
                remaining //= factor
                mobius = -mobius
                if remaining % factor == 0:
                    mobius = 0
                    break
            factor += 1
        if mobius == 0:
            continue
        if remaining > 1:
            mobius = -mobius

        if exponent == 2:
            root = isqrt(n)
        else:
            # Use integer arithmetic so values next to large perfect
            # powers are not misclassified by floating-point rounding.
            low = 1
            high = 1 << ((n.bit_length() + exponent - 1) // exponent)
            while low + 1 < high:
                middle = (low + high) // 2
                if middle ** exponent <= n:
                    low = middle
                else:
                    high = middle
            root = low
        total -= mobius * (root - 1)
    return total
