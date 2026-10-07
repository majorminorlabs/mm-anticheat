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
    # Doubled black areas in a 4-by-2 repeating tile are
    # (2, 1, 0, 1) on the bottom row and (1, 2, 1, 0) above it.
    tile_prefix = (
        (0, 0, 0, 0, 0),
        (0, 2, 3, 3, 4),
        (0, 3, 6, 7, 8),
    )

    def prefix(x: int, y: int) -> int:
        # Floor division keeps the remainders inside the tile even for
        # negative coordinates, extending the signed prefix to all quadrants.
        x_tiles, x_rest = divmod(x, 4)
        y_tiles, y_rest = divmod(y, 2)
        return (
            8 * x_tiles * y_tiles
            + y_tiles * tile_prefix[2][x_rest]
            + x_tiles * tile_prefix[y_rest][4]
            + tile_prefix[y_rest][x_rest]
        )

    return prefix(C, D) - prefix(A, D) - prefix(C, B) + prefix(A, B)
