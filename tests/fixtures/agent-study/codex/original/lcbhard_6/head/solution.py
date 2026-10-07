from typing import List, Tuple
from functools import lru_cache


def can_tile_grid(n: int, h: int, w: int, tiles: List[Tuple[int, int]]) -> bool:
    """ Determine if it's possible to place rectangular tiles on an H×W grid such that:
    - Every cell is covered by exactly one tile
    - Tiles can be rotated (so a 2×3 tile can be placed as 3×2)
    - Some tiles may remain unused
    - Tiles must be aligned with grid cells and cannot extend outside
    
    Args:
        n: Number of available tiles (1 ≤ n ≤ 7)
        h: Height of the grid (1 ≤ h ≤ 10)
        w: Width of the grid (1 ≤ w ≤ 10)
        tiles: List of (a, b) tuples where tile i has dimensions a×b (1 ≤ a, b ≤ 10)
    
    Returns:
        True if the grid can be perfectly tiled, False otherwise
    
    >>> can_tile_grid(5, 5, 5, [(1, 1), (3, 3), (4, 4), (2, 3), (2, 5)])
    True
    >>> can_tile_grid(1, 1, 2, [(2, 3)])
    False
    >>> can_tile_grid(1, 2, 2, [(1, 1)])
    False
    """
    # Each bit represents one grid cell, in row-major order.
    full_grid = (1 << (h * w)) - 1
    dimensions = tiles[:n]
    areas = [a * b for a, b in dimensions]

    # Bit k is set when a subset of the available tiles has total area k.
    area_sums = [0] * (1 << n)
    area_sums[0] = 1
    for available in range(1, 1 << n):
        bit = available & -available
        index = bit.bit_length() - 1
        previous = area_sums[available ^ bit]
        area_sums[available] = previous | (previous << areas[index])

    @lru_cache(maxsize=None)
    def search(covered: int, available: int) -> bool:
        if covered == full_grid:
            return True
        remaining_area = h * w - covered.bit_count()
        if not (area_sums[available] >> remaining_area) & 1:
            return False

        empty = full_grid ^ covered
        first = (empty & -empty).bit_length() - 1
        row, column = divmod(first, w)
        tried = set()
        for index, (a, b) in enumerate(dimensions):
            bit = 1 << index
            if not available & bit:
                continue
            shape = (min(a, b), max(a, b))
            if shape in tried:
                continue
            tried.add(shape)
            for height, width in {(a, b), (b, a)}:
                if row + height > h or column + width > w:
                    continue
                row_mask = (1 << width) - 1
                placement = 0
                for offset in range(height):
                    placement |= row_mask << (first + offset * w)
                if not placement & covered and search(
                    covered | placement, available ^ bit
                ):
                    return True
        return False

    return search(0, (1 << n) - 1)
