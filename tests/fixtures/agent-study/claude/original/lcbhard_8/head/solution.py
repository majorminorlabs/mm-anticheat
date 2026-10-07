from math import gcd
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
    # Drop coins that are multiples of a smaller coin; they add no new amounts.
    coins = sorted(set(coins))
    base = [c for i, c in enumerate(coins) if all(c % d for d in coins[:i])]

    hi = min(base) * k
    # Inclusion-exclusion terms: (lcm, sign) for every non-empty subset.
    terms = [(1, -1)]
    for c in base:
        new = []
        for l, sign in terms:
            m = l * c // gcd(l, c)
            if m <= hi:
                new.append((m, -sign))
        terms += new
    terms = terms[1:]

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
