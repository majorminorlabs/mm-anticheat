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
    K = min(K, sum(C))
    if K == 0:
        return 0

    factorial = [1] * (K + 1)
    for n in range(1, K + 1):
        factorial[n] = factorial[n - 1] * n % mod
    inverse_factorial = [1] * (K + 1)
    inverse_factorial[K] = pow(factorial[K], mod - 2, mod)
    for n in range(K, 0, -1):
        inverse_factorial[n - 1] = inverse_factorial[n] * n % mod

    # Unrestricted letters contribute exp(unrestricted * x). Each capped
    # letter contributes sum(x**j / j!, j=0..cap) to the generating function.
    unrestricted = sum(cap >= K for cap in C)
    if unrestricted:
        coefficients = [1]
        power = 1
        for n in range(1, K + 1):
            power = power * unrestricted % mod
            coefficients.append(power * inverse_factorial[n] % mod)
    else:
        coefficients = [1]

    for cap in sorted(cap for cap in C if 0 < cap < K):
        previous_degree = len(coefficients) - 1
        degree = min(K, previous_degree + cap)
        coefficients = [
            sum(
                coefficients[n - j] * inverse_factorial[j]
                for j in range(max(0, n - previous_degree), min(cap, n) + 1)
            ) % mod
            for n in range(degree + 1)
        ]

    # Multiplying the degree-n coefficient by n! counts ordered strings.
    return sum(coefficients[n] * factorial[n]
               for n in range(1, len(coefficients))) % mod
