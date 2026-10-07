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

    upper = denominations[0] * k
    # Inclusion-exclusion counts the union of the sets of multiples. Merge
    # subsets with the same LCM to keep each binary-search step inexpensive.
    coefficients = {}
    for coin in denominations:
        additions = {coin: 1}
        for multiple, coefficient in coefficients.items():
            intersection = lcm(multiple, coin)
            if intersection <= upper:
                additions[intersection] = additions.get(intersection, 0) - coefficient
        for multiple, coefficient in additions.items():
            coefficients[multiple] = coefficients.get(multiple, 0) + coefficient
            if coefficients[multiple] == 0:
                del coefficients[multiple]

    lower = denominations[0]
    while lower < upper:
        midpoint = (lower + upper) // 2
        count = sum(coefficient * (midpoint // multiple)
                    for multiple, coefficient in coefficients.items())
        if count >= k:
            upper = midpoint
        else:
            lower = midpoint + 1
    return lower
