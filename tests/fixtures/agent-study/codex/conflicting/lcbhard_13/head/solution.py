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

    def integer_root(value: int, exponent: int) -> int:
        """Return floor(value ** (1 / exponent)) using exact arithmetic."""
        if exponent == 2:
            return isqrt(value)
        low = 1
        high = 1 << ((value.bit_length() + exponent - 1) // exponent)
        while low + 1 < high:
            middle = (low + high) // 2
            if middle ** exponent <= value:
                low = middle
            else:
                high = middle
        return low

    # Inclusion-exclusion over prime exponents counts each perfect power once.
    # Intersections correspond to their square-free products, with coefficient
    # -mu(exponent). Exclude base 1 from each term and count it separately.
    limit = n.bit_length() - 1
    mobius = [1] * (limit + 1)
    prime = [True] * (limit + 1)
    for p in range(2, limit + 1):
        if prime[p]:
            for multiple in range(p, limit + 1, p):
                prime[multiple] = False
                mobius[multiple] *= -1
            for multiple in range(p * p, limit + 1, p * p):
                mobius[multiple] = 0

    return 1 - sum(
        mobius[exponent] * (integer_root(n, exponent) - 1)
        for exponent in range(2, limit + 1)
        if mobius[exponent]
    )
