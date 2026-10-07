from typing import List
from math import lcm


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
    # Multiples of a denomination already covered by a smaller one add nothing.
    denominations = []
    for coin in sorted(set(coins)):
        if not any(coin % smaller == 0 for smaller in denominations):
            denominations.append(coin)

    # Combine inclusion-exclusion terms that share the same least common multiple.
    terms = {}
    for coin in denominations:
        additions = {coin: 1}
        for divisor, coefficient in terms.items():
            common = lcm(divisor, coin)
            additions[common] = additions.get(common, 0) - coefficient
        for divisor, coefficient in additions.items():
            terms[divisor] = terms.get(divisor, 0) + coefficient
            if terms[divisor] == 0:
                del terms[divisor]

    low, high = 1, denominations[0] * k
    while low < high:
        middle = (low + high) // 2
        count = sum(coefficient * (middle // divisor)
                    for divisor, coefficient in terms.items())
        if count >= k:
            high = middle
        else:
            low = middle + 1
    return low
