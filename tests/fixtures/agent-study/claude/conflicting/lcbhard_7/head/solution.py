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
    # Doubled black area of each unit cell over one period (x mod 4, y mod 2).
    cell = [[2, 1, 0, 1], [1, 2, 1, 0]]

    def prefix(x: int, y: int) -> int:
        # Doubled black area of [0, x] x [0, y], extended to negatives by periodicity.
        qx, rx = divmod(x, 4)
        qy, ry = divmod(y, 2)
        total = 0
        for row in range(2):
            for col in range(4):
                nx = qx + (1 if col < rx else 0)
                ny = qy + (1 if row < ry else 0)
                total += cell[row][col] * nx * ny
        return total

    return prefix(C, D) - prefix(A, D) - prefix(C, B) + prefix(A, B)
