from functools import lru_cache
from typing import List, Tuple


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
    # Discard tiles that cannot fit in either orientation.
    shapes = [
        (min(a, b), max(a, b))
        for a, b in tiles[:n]
        if (a <= h and b <= w) or (b <= h and a <= w)
    ]
    shapes.sort(key=lambda shape: shape[0] * shape[1], reverse=True)
    areas = [a * b for a, b in shapes]
    full = (1 << (h * w)) - 1

    @lru_cache(None)
    def possible_areas(available):
        if not available:
            return frozenset({0})
        bit = available & -available
        area = areas[bit.bit_length() - 1]
        smaller = possible_areas(available ^ bit)
        return smaller | frozenset(value + area for value in smaller)

    @lru_cache(None)
    def search(covered, available):
        if covered == full:
            return True
        if h * w - covered.bit_count() not in possible_areas(available):
            return False

        # In any completion, a tile must start at the first uncovered cell:
        # starting above it or to its left would overlap an occupied cell.
        empty = full ^ covered
        position = (empty & -empty).bit_length() - 1
        row, column = divmod(position, w)
        tried = set()
        for i, shape in enumerate(shapes):
            bit = 1 << i
            if not available & bit or shape in tried:
                continue
            tried.add(shape)
            a, b = shape
            orientations = [(a, b)] if a == b else [(a, b), (b, a)]
            for height, width in orientations:
                if row + height > h or column + width > w:
                    continue
                strip = (1 << width) - 1
                placement = 0
                for offset in range(height):
                    placement |= strip << ((row + offset) * w + column)
                if not placement & covered and search(
                    covered | placement, available ^ bit
                ):
                    return True
        return False

    return search(0, (1 << len(shapes)) - 1)
