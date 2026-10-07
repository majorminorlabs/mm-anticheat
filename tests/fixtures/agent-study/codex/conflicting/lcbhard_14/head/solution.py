def find_palindrome_expression(n: int) -> str:
    """ Find a palindrome string S that represents a mathematical expression evaluating to n.
    
    The string must satisfy:
    - Length between 1 and 1000 characters
    - Consists only of digits 1-9 and the multiplication symbol '*'
    - Is a palindrome (reads the same forwards and backwards)
    - First character must be a digit
    - When evaluated as a mathematical expression, equals n
    
    Args:
        n: An integer between 1 and 10^12
        
    Returns:
        A palindrome string representing an expression that evaluates to n,
        or '-1' if no such string exists.
        
    >>> find_palindrome_expression(363)
    '11*3*11'
    >>> find_palindrome_expression(101)
    '-1'
    >>> find_palindrome_expression(3)
    '3'
    """
    from functools import lru_cache
    from math import isqrt

    # Every outer factor must be paired with its digit reversal. At least
    # one member of each pair is at most sqrt(n), so this finds all pairs.
    pairs = []
    for factor in range(2, isqrt(n) + 1):
        if n % factor:
            continue
        digits = str(factor)
        if '0' in digits:
            continue
        reverse = int(digits[::-1])
        if reverse < factor:
            continue
        product = factor * reverse
        if n % product == 0:
            pairs.append((product, digits, digits[::-1]))

    @lru_cache(maxsize=None)
    def solve(value):
        digits = str(value)
        if '0' not in digits and digits == digits[::-1]:
            return digits
        for product, left, right in pairs:
            if value % product == 0:
                middle = solve(value // product)
                if middle is not None:
                    return left + '*' + middle + '*' + right
        return None

    result = solve(n)
    return result if result is not None else '-1'
