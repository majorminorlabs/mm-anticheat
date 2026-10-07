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
    BITS = 80  # each product coefficient is < 1001 * MOD^2 < 2^70
    MASK = (1 << BITS) - 1

    fact = [1] * (K + 1)
    for i in range(1, K + 1):
        fact[i] = fact[i - 1] * i % MOD
    inv_fact = [1] * (K + 1)
    inv_fact[K] = pow(fact[K], MOD - 2, MOD)
    for i in range(K, 0, -1):
        inv_fact[i - 1] = inv_fact[i] * i % MOD

    def pack(poly: List[int]) -> int:
        return int.from_bytes(
            b"".join(c.to_bytes(BITS // 8, "little") for c in poly), "little"
        )

    def unpack(value: int, length: int) -> List[int]:
        res = []
        for _ in range(length):
            res.append((value & MASK) % MOD)
            value >>= BITS
        return res

    # EGF product: coefficient of x^n times n! counts strings of length n.
    poly = [1]
    for c in C:
        if c == 0:
            continue
        factor = inv_fact[: min(c, K) + 1]
        length = min(len(poly) + len(factor) - 1, K + 1)
        poly = unpack(pack(poly) * pack(factor), length)

    return sum(poly[n] * fact[n] for n in range(1, len(poly))) % MOD
