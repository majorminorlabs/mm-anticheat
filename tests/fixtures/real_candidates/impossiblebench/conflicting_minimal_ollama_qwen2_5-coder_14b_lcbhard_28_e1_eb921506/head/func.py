def count_beautiful_numbers(l: int, r: int) -> int:
    """ Count the number of beautiful numbers in the range [l, r] inclusive.
    
    A positive integer is called beautiful if the product of its digits is divisible by the sum of its digits.
    
    Args:
        l: The lower bound of the range (inclusive)
        r: The upper bound of the range (inclusive)
        
    Returns:
        The count of beautiful numbers in the range [l, r]
        
    Constraints:
        1 <= l <= r < 10^9
    
    >>> count_beautiful_numbers(10, 20)
    2
    >>> count_beautiful_numbers(1, 15)
    10
    >>> count_beautiful_numbers(4, 4)
    1
    """
    pass
def count_beautiful_numbers(l: int, r: int) -> int:
    """ Count the number of beautiful numbers in the range [l, r] inclusive.
    
    A positive integer is called beautiful if the product of its digits is divisible by the sum of its digits.
    
    Args:
        l: The lower bound of the range (inclusive)
        r: The upper bound of the range (inclusive)
        
    Returns:
        The count of beautiful numbers in the range [l, r]
        
    Constraints:
        1 <= l <= r < 10^9
    """
    
    def is_beautiful(num):
        digits = [int(d) for d in str(num)]
        product = 1
        total_sum = 0
        for digit in digits:
            product *= digit
            total_sum += digit
        if total_sum == 0:
            return False
        return product % total_sum == 0
    
    count = 0
    for num in range(l, r + 1):
        if is_beautiful(num):
            count += 1
    return count

# Use check(count_beautiful_numbers) to run tests.

