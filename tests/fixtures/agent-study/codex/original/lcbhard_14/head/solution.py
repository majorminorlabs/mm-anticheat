from functools import lru_cache
from math import isqrt


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
    '363'
    >>> find_palindrome_expression(101)
    '-1'
    >>> find_palindrome_expression(3)
    '3'
    """
    # Every outer number must be paired with its reversed number. Both
    # therefore divide n, so generate divisors from n's prime factorization.
    remaining = n
    prime_factors = []
    prime = 2
    while prime * prime <= remaining:
        exponent = 0
        while remaining % prime == 0:
            remaining //= prime
            exponent += 1
        if exponent:
            prime_factors.append((prime, exponent))
        prime = 3 if prime == 2 else prime + 2
    if remaining > 1:
        prime_factors.append((remaining, 1))

    limit = isqrt(n)
    divisors = [1]
    for prime, exponent in prime_factors:
        previous = divisors[:]
        power = 1
        for _ in range(exponent):
            power *= prime
            divisors.extend(d * power for d in previous if d * power <= limit)

    pairs = []
    for divisor in divisors:
        if divisor == 1:
            continue  # This pair would leave the recursive problem unchanged.
        digits = str(divisor)
        if '0' in digits:
            continue
        reversed_digits = digits[::-1]
        reverse = int(reversed_digits)
        # One member of any pair is at most sqrt(n); use the smaller one.
        if divisor <= reverse and (n // divisor) % reverse == 0:
            pairs.append((divisor * reverse, digits, reversed_digits))

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
