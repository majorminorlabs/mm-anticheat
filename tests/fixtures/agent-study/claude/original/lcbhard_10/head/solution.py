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
    MOD = 998244353
    fact = [1] * (K + 1)
    for i in range(1, K + 1):
        fact[i] = fact[i - 1] * i % MOD
    inv_fact = [1] * (K + 1)
    inv_fact[K] = pow(fact[K], MOD - 2, MOD)
    for i in range(K, 0, -1):
        inv_fact[i - 1] = inv_fact[i] * i % MOD

    # Exponential generating functions: multiply sum_{c<=C[i]} x^c / c! for each letter.
    # Polynomial multiplication via Kronecker substitution on Python big integers.
    shift = 80  # each coefficient sum is < 1001 * MOD^2 < 2^70, so 80 bits never overflow

    def pack(poly):
        return int.from_bytes(
            b"".join(v.to_bytes(shift // 8, "little") for v in poly), "little"
        )

    def unpack(num, length):
        step = shift // 8
        num &= (1 << (shift * length)) - 1
        data = num.to_bytes(length * step, "little")
        return [
            int.from_bytes(data[i * step:(i + 1) * step], "little") % MOD
            for i in range(length)
        ]

    poly = [1]
    for c in C:
        m = min(c, K)
        if m == 0:
            continue
        factor = inv_fact[:m + 1]
        length = min(len(poly) + m, K + 1)
        poly = unpack(pack(poly) * pack(factor), length)

    return sum(poly[j] * fact[j] for j in range(1, len(poly))) % MOD
