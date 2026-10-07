def count_square_permutations(n: int, s: str) -> int:
    """ Given a string s of length n consisting of digits, find the number of unique square numbers 
    that can be obtained by interpreting any permutation of the digits as a decimal integer.
    
    Note that leading zeros are allowed in the interpretation (e.g., "010" can form 1, 10, 100),
    and different permutations that result in the same number are counted only once.
    
    Args:
        n: The length of the string (1 <= n <= 13)
        s: A string of length n consisting of digits
    
    Returns:
        The count of unique square numbers that can be formed
    
    >>> count_square_permutations(4, '4320')
    2
    >>> count_square_permutations(3, '010')
    2
    >>> count_square_permutations(1, '4')
    1
    """
    from math import isqrt

    digits = sorted(s)
    smallest = int(''.join(digits))
    largest = int(''.join(reversed(digits)))
    first_root = isqrt(smallest)
    if first_root * first_root < smallest:
        first_root += 1

    # Enumerate squares once each, padding with the allowed leading zeros
    # before comparing digit multisets. This avoids enumerating n! permutations.
    return sum(
        sorted(str(root * root).zfill(n)) == digits
        for root in range(first_root, isqrt(largest) + 1)
    )
