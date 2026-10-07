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

    def no_zero(x: int) -> bool:
        return '0' not in str(x)

    # All divisors of n above 1 up to sqrt(n); divisors of any quotient are among them.
    divisors = []
    i = 2
    while i * i <= n:
        if n % i == 0:
            divisors.append(i)
        i += 1

    @lru_cache(maxsize=None)
    def solve(m: int):
        s = str(m)
        if no_zero(m) and s == s[::-1]:
            return s
        # Peel off an outer pair x * ... * rev(x)
        for x in divisors:
            if x * x > m:
                break
            if m % x or not no_zero(x):
                continue
            r = int(str(x)[::-1])
            if m % (x * r) == 0:
                inner = solve(m // (x * r))
                if inner is not None:
                    return f"{x}*{inner}*{r}"
        return None

    result = solve(n)
    return result if result is not None and len(result) <= 1000 else '-1'
