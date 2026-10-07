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
    last_root = isqrt(largest)

    # Permuting decimal digits preserves the number modulo nine. Only
    # examine root residues whose squares have the required residue.
    residue = sum(int(digit) for digit in s) % 9
    count = 0
    for root_residue in range(9):
        if root_residue * root_residue % 9 != residue:
            continue
        start = first_root + (root_residue - first_root) % 9
        for root in range(start, last_root + 1, 9):
            if sorted(str(root * root).zfill(n)) == digits:
                count += 1
    return count
