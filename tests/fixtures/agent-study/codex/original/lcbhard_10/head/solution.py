from typing import List


def count_valid_strings(K: int, C: List[int]) -> int:
    """ Count the number of strings consisting of uppercase English letters with length between 
    1 and K (inclusive) that satisfy the following condition: for each letter (A=0, B=1, ..., Z=25),
    the number of occurrences in the string is at most C[i].
    
    Return the count modulo 998244353.
    
    Args:
        K: Maximum length of strings to consider (1 <= K <= 1000)
        C: List of 26 integers where C[i] is the maximum allowed occurrences of the i-th letter
            (0 <= C[i] <= 1000)
    
    Returns:
        The number of valid strings modulo 998244353
    
    >>> count_valid_strings(2, [2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    10
    >>> count_valid_strings(358, [1, 0, 1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    64
    """
    mod = 998244353
    limit = min(K, sum(C))
    if limit == 0:
        return 0

    factorial = [1] * (limit + 1)
    for n in range(1, limit + 1):
        factorial[n] = factorial[n - 1] * n % mod
    inverse_factorial = [1] * (limit + 1)
    inverse_factorial[limit] = pow(factorial[limit], mod - 2, mod)
    for n in range(limit, 0, -1):
        inverse_factorial[n - 1] = inverse_factorial[n] * n % mod

    # A letter contributes sum(x**j / j!, j=0..capacity). Multiplying
    # these polynomials and multiplying coefficient n by n! counts all
    # orderings of each permitted multiset of n letters.
    unrestricted = sum(capacity >= limit for capacity in C)
    if unrestricted:
        dp = [pow(unrestricted, n, mod) * inverse_factorial[n] % mod
              for n in range(limit + 1)]
    else:
        dp = [1]

    for capacity in sorted(c for c in C if 0 < c < limit):
        previous_degree = len(dp) - 1
        degree = min(limit, previous_degree + capacity)
        dp = [sum(dp[n - j] * inverse_factorial[j]
                  for j in range(max(0, n - previous_degree),
                                 min(capacity, n) + 1)) % mod
              for n in range(degree + 1)]

    return sum(dp[n] * factorial[n] for n in range(1, len(dp))) % mod
