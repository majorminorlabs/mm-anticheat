def calculate_black_area_doubled(A: int, B: int, C: int, D: int) -> int:
    """ Calculate twice the area of black-painted regions inside a rectangle on AtCoder's wallpaper pattern.
    
    The wallpaper pattern is defined as follows:
    - The plane is divided by lines: x = n (integer n), y = n (even n), and x + y = n (even n)
    - Adjacent regions along these lines have different colors (black or white)
    - The region containing (0.5, 0.5) is black
    
    Given a rectangle with bottom-left vertex at (A, B) and top-right vertex at (C, D),
    calculate the area of black regions inside it and return twice that area.
    
    Args:
        A, B: Coordinates of the bottom-left vertex
        C, D: Coordinates of the top-right vertex
        
    Constraints:
        -10^9 <= A, B, C, D <= 10^9
        A < C and B < D
        
    Returns:
        Twice the area of black regions (guaranteed to be an integer)
    
    >>> calculate_black_area_doubled(0, 0, 3, 3)
    10
    >>> calculate_black_area_doubled(-1, -2, 1, 3)
    11
    >>> calculate_black_area_doubled(-1000000000, -1000000000, 1000000000, 1000000000)
    4000000000000000000
    """
    # Doubled black area of each unit cell; the pattern repeats every 4 in x and 2 in y.
    # cell[x % 4][y % 2] is the doubled black area of the cell [x, x+1] x [y, y+1].
    cell = [[2, 1], [1, 2], [0, 1], [1, 0]]
    offset = 2 * 10**9  # multiple of 4 and 2, makes all coordinates non-negative

    def prefix(x: int, y: int) -> int:
        # Doubled black area of [0, x] x [0, y] for x, y >= 0.
        cnt_x = [x // 4 + (1 if r < x % 4 else 0) for r in range(4)]
        cnt_y = [y // 2 + (1 if s < y % 2 else 0) for s in range(2)]
        return sum(cell[r][s] * cnt_x[r] * cnt_y[s] for r in range(4) for s in range(2))

    A += offset
    B += offset
    C += offset
    D += offset
    return prefix(C, D) - prefix(A, D) - prefix(C, B) + prefix(A, B)
