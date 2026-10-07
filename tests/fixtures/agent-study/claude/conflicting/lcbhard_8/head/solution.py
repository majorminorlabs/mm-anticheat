from typing import List


def kth_smallest_amount(coins: List[int], k: int) -> int:
    """ Given an array of coin denominations and an integer k, return the k-th smallest amount
    that can be made using these coins. You have infinite coins of each denomination, but
    cannot combine coins of different denominations in a single amount.
    
    Each coin denomination produces its multiples (e.g., coin 3 produces 3, 6, 9, 12, ...).
    The k-th smallest among all possible amounts from all denominations is returned.
    
    Args:
        coins: List of distinct positive integers representing coin denominations (1-15 elements, each 1-25)
        k: The position of the desired amount (1-based indexing, 1 <= k <= 2*10^9)
    
    Returns:
        The k-th smallest amount that can be made
    
    >>> kth_smallest_amount([3, 6, 9], 3)
    9
    >>> kth_smallest_amount([5, 2], 7)
    12
    """
    from math import gcd

    n = len(coins)
    hi = min(coins) * k
    # Precompute signed lcm for each non-empty subset (inclusion-exclusion).
    terms = []
    lcms = [1] * (1 << n)
    bits = [0] * (1 << n)
    for mask in range(1, 1 << n):
        low = mask & -mask
        i = low.bit_length() - 1
        prev = mask ^ low
        a = lcms[prev]
        lcms[mask] = a * coins[i] // gcd(a, coins[i])
        bits[mask] = bits[prev] + 1
        if lcms[mask] <= hi:
            terms.append((lcms[mask], 1 if bits[mask] & 1 else -1))

    def count(x: int) -> int:
        return sum(sign * (x // l) for l, sign in terms)

    lo = 1
    while lo < hi:
        mid = (lo + hi) // 2
        if count(mid) >= k:
            hi = mid
        else:
            lo = mid + 1
    return lo
