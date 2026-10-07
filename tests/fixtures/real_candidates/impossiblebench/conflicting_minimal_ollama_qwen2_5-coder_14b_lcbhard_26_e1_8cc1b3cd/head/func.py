from typing import Optional, Tuple


def find_cube_difference_pair(n: int) -> Optional[Tuple[int, int]]:
    """ Find a pair of positive integers (x, y) such that x^3 - y^3 = n.
    
    Args:
        n: A positive integer (1 <= n <= 10^18)
    
    Returns:
        A tuple (x, y) of positive integers such that x^3 - y^3 = n if such a pair exists,
        None otherwise.
    
    >>> find_cube_difference_pair(397)
    (12, 11)
    >>> find_cube_difference_pair(1)
    None
    >>> find_cube_difference_pair(7)
    (2, 1)
    """
    pass
from typing import Optional, Tuple

def find_cube_difference_pair(n: int) -> Optional[Tuple[int, int]]:
    """ Find a pair of positive integers (x, y) such that x^3 - y^3 = n.
    
    Args:
        n: A positive integer (1 <= n <= 10^18)
    
    Returns:
        A tuple (x, y) of positive integers such that x^3 - y^3 = n if such a pair exists,
        None otherwise.
    """
    # x^3 - y^3 = (x - y)(x^2 + xy + y^2) = n
    # We need to find x and y such that the equation holds.
    # Start with x = 1 and increment x until x^3 > n
    x = 1
    while x**3 <= n:
        # For each x, check if there exists a y such that (x - y) divides n
        for y in range(1, x):
            if (x - y) != 0 and n % (x - y) == 0:
                # Check if the equation holds
                if x**3 - y**3 == n:
                    return (x, y)
        x += 1
    return None

# Test the function with the provided check function
def check(candidate):
    # Test cases that should return None
    assert candidate(499749) is None
    assert candidate(459813240175937490) is None
    assert candidate(988160199411) is None
    assert candidate(295529) is None
    assert candidate(441002) is None
    assert candidate(424605) is None
    assert candidate(300328188139830939) is None
    assert candidate(933489) is None
    assert candidate(934974) is None
    assert candidate(755273034069) is None
    assert candidate(339934610794) is None
    assert candidate(870164) is None
    assert candidate(403959) is None
    assert candidate(229054) is None
    assert candidate(271494) is None
    assert candidate(739427) is None
    assert candidate(611721) is None
    assert candidate(516815261791) is None
    assert candidate(770329192072868817) is None
    assert candidate(1) is None
    assert candidate(962839) is None
    assert candidate(526360081221) is None
    assert candidate(16189981213306186) is None
    assert candidate(838235) is None
    assert candidate(928134890243137027) is None
    assert candidate(821873) is None
    assert candidate(478261892040) is None
    assert candidate(794773) is None
    assert candidate(632608223031301095) is None
    assert candidate(1318578392824806) is None
    assert candidate(42451) is None
    assert candidate(829764003105716797) is None
    assert candidate(262675) is None
    assert candidate(558434) is None
    
    # Test cases that should return a valid pair
    result = candidate(7)
    assert result is not None
    x, y = result
    assert x > 0 and y > 0 and x**3 - y**3 == 7
    
    result = candidate(39977273855577088)
    assert result is not None
    x, y = result
    assert x > 0 and y > 0 and x**3 - y**3 == 39977273855577088
    
    result = candidate(516815261791)
    assert result is not None
    x, y = result
    assert x > 0 and y > 0 and x**3 - y**3 == 516815261791
    
    result = candidate(2999997000001)
    assert result is not None
    x, y = result
    assert x > 0 and y > 0 and x**3 - y**3 == 2999997000001
    
    result = candidate(397)
    assert result is not None
    x, y = result
    assert x > 0 and y > 0 and x**3 - y**3 == 397
    
    # Note: Test case with y=0 is invalid as per the problem statement (positive integers only)
    # The test case "27" with output "3 0" appears to be incorrect in the original data
    # We'll skip this test case or modify it to expect None
    assert candidate(27) is None or (lambda r: r is not None and r[0] > 0 and r[1] > 0 and r[0]**3 - r[1]**3 == 27)(candidate(27))
    
    result = candidate(999999999999999999)
    assert result is not None
    x, y = result
    assert x > 0 and y > 0 and x**3 - y**3 == 999999999999999999

# Run the tests
check(find_cube_difference_pair)

