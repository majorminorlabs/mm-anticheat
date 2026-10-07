from typing import List


def sum_imbalance_numbers(nums: List[int]) -> int:
    """ Calculate the sum of imbalance numbers of all subarrays of the given array.
    
    The imbalance number of an array is defined as the number of indices i (0 <= i < n-1) 
    in the sorted array where sorted_array[i+1] - sorted_array[i] > 1.
    
    A subarray is a contiguous non-empty sequence of elements within an array.
    
    Args:
        nums: A list of integers where 1 <= len(nums) <= 1000 and 1 <= nums[i] <= len(nums)
    
    Returns:
        The sum of imbalance numbers of all subarrays
    
    >>> sum_imbalance_numbers([2, 3, 1, 4])
    3
    >>> sum_imbalance_numbers([1, 3, 3, 3, 5])
    8
    """
    raise NotImplementedError
