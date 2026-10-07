def count_beautiful_integers(low: int, high: int, k: int) -> int:
    """ Count the number of beautiful integers in the range [low, high].
    
    A number is beautiful if it meets both conditions:
    1. The count of even digits equals the count of odd digits
    2. The number is divisible by k
    
    Args:
        low: Lower bound of the range (inclusive), 0 < low <= high <= 10^9
        high: Upper bound of the range (inclusive)
        k: Divisor to check, 0 < k <= 20
    
    Returns:
        The count of beautiful integers in the given range
    
    >>> count_beautiful_integers(10, 20, 3)
    2
    >>> count_beautiful_integers(1, 10, 1)
    1
    >>> count_beautiful_integers(5, 5, 2)
    0
    """
    from functools import lru_cache

    def count_up_to(bound: int) -> int:
        if bound <= 0:
            return 0
        digits = tuple(map(int, str(bound)))

        @lru_cache(maxsize=None)
        def count(position, balance, remainder, started, tight):
            if position == len(digits):
                return int(started and balance == 0 and remainder == 0)
            if abs(balance) > len(digits) - position:
                return 0

            limit = digits[position] if tight else 9
            total = 0
            for digit in range(limit + 1):
                next_tight = tight and digit == digits[position]
                if not started and digit == 0:
                    # Leading zeros are not digits of the integer.
                    total += count(position + 1, 0, 0, False, next_tight)
                else:
                    total += count(
                        position + 1,
                        balance + (1 if digit % 2 == 0 else -1),
                        (remainder * 10 + digit) % k,
                        True,
                        next_tight,
                    )
            return total

        return count(0, 0, 0, False, True)

    return count_up_to(high) - count_up_to(low - 1)
