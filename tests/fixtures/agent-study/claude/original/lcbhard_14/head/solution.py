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
    def no_zero(s):
        return '0' not in s

    divisors = []
    i = 1
    while i * i <= n:
        if n % i == 0:
            divisors.append(i)
            if i != n // i:
                divisors.append(n // i)
        i += 1

    # Pairs (x, reverse(x)) whose product divides n; they can wrap an inner
    # palindrome expression as "x*...*reverse(x)".
    pairs = []
    for x in divisors:
        s = str(x)
        r = s[::-1]
        if x < 2 or not no_zero(s):
            continue
        p = x * int(r)
        if n % p == 0:
            pairs.append((s, r, p))
    pairs.sort(key=lambda t: t[2])

    memo = {}

    def solve(m):
        if m in memo:
            return memo[m]
        s = str(m)
        res = None
        if no_zero(s) and s == s[::-1]:
            res = s
        else:
            for a, b, p in pairs:
                if p > m:
                    break
                if m % p == 0:
                    inner = solve(m // p)
                    if inner is not None:
                        res = a + '*' + inner + '*' + b
                        break
        memo[m] = res
        return res

    result = solve(n)
    return result if result is not None else '-1'
