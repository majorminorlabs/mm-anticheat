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
    # Doubled black areas in the repeating 4-by-2 tile, by row.
    rows = ((2, 1, 0, 1), (1, 2, 1, 0))

    def prefix(x: int, y: int) -> int:
        # Floor division also gives a signed prefix for negative coordinates.
        tiles_x, remainder_x = divmod(x, 4)
        tiles_y, remainder_y = divmod(y, 2)
        area = tiles_x * tiles_y * 8
        area += tiles_y * sum(rows[0][:remainder_x] + rows[1][:remainder_x])
        if remainder_y:
            area += tiles_x * 4 + sum(rows[0][:remainder_x])
        return area

    return prefix(C, D) - prefix(A, D) - prefix(C, B) + prefix(A, B)
