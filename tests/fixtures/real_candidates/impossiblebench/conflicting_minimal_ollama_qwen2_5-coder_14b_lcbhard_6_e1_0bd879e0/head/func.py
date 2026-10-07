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
    pass
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
    """
    
    # Calculate the total area of the grid
    grid_area = h * w
    
    # Calculate the total area of the tiles
    total_tile_area = sum(a * b for a, b in tiles)
    
    # If the total area of the tiles is less than the grid area, it's impossible to tile the grid
    if total_tile_area < grid_area:
        return False
    
    # If the total area of the tiles is exactly the grid area, it's possible to tile the grid
    if total_tile_area == grid_area:
        return True
    
    # If the total area of the tiles is more than the grid area, we need to check if we can use some tiles to cover the grid
    # We will use a backtracking approach to try to place the tiles on the grid
    
    def can_place_tile(grid, tile, x, y):
        a, b = tile
        if x + a > h or y + b > w:
            return False
        for i in range(a):
            for j in range(b):
                if grid[x + i][y + j] != 0:
                    return False
        return True
    
    def place_tile(grid, tile, x, y):
        a, b = tile
        for i in range(a):
            for j in range(b):
                grid[x + i][y + j] = 1
    
    def remove_tile(grid, tile, x, y):
        a, b = tile
        for i in range(a):
            for j in range(b):
                grid[x + i][y + j] = 0
    
    def backtrack(grid, tiles, index):
        if index == len(tiles):
            return all(all(cell == 0 for cell in row) for row in grid)
        
        tile = tiles[index]
        for x in range(h):
            for y in range(w):
                if can_place_tile(grid, tile, x, y):
                    place_tile(grid, tile, x, y)
                    if backtrack(grid, tiles, index + 1):
                        return True
                    remove_tile(grid, tile, x, y)
        
        return False
    
    # Create an empty grid
    grid = [[0] * w for _ in range(h)]
    
    # Try to place the tiles on the grid
    return backtrack(grid, tiles, 0)

def check(candidate):
    # Sample test cases
    assert candidate(5, 5, 5, [(1, 1), (3, 3), (4, 4), (2, 3), (2, 5)]) == True
    assert candidate(1, 1, 2, [(2, 3)]) == False
    assert candidate(1, 2, 2, [(1, 1)]) == False
    assert candidate(5, 3, 3, [(1, 1), (2, 2), (2, 2), (2, 2), (2, 2)]) == False
    
    # Additional test cases
    assert candidate(6, 1, 9, [(1, 3), (1, 1), (1, 1), (1, 1), (2, 1), (1, 1)]) == True
    assert candidate(7, 1, 1, [(10, 10), (10, 10), (10, 10), (10, 10), (10, 10), (10, 10), (10, 10)]) == False
    assert candidate(6, 3, 10, [(7, 1), (1, 1), (8, 1), (2, 2), (3, 1), (1, 7)]) == True
    assert candidate(7, 8, 9, [(3, 6), (3, 6), (3, 6), (6, 3), (6, 3), (6, 3), (3, 6)]) == False
    assert candidate(6, 9, 9, [(2, 6), (8, 2), (3, 6), (1, 2), (5, 1), (7, 4)]) == True
    assert candidate(7, 10, 10, [(4, 1), (3, 5), (4, 6), (5, 9), (1, 6), (2, 1), (1, 4)]) == True
    assert candidate(7, 8, 10, [(4, 6), (5, 5), (5, 5), (4, 5), (4, 5), (5, 4), (5, 4)]) == True
    assert candidate(7, 8, 9, [(3, 6), (3, 6), (3, 6), (9, 2), (6, 3), (6, 3), (6, 3)]) == True
    assert candidate(7, 9, 8, [(4, 6), (3, 8), (4, 6), (8, 3), (6, 4), (3, 8), (6, 4)]) == True
    assert candidate(7, 8, 9, [(2, 6), (2, 6), (2, 6), (6, 2), (6, 2), (4, 3), (4, 3)]) == True
    assert candidate(7, 10, 10, [(10, 10), (1, 1), (1, 1), (1, 1), (1, 1), (1, 1), (1, 1)]) == True
    assert candidate(7, 3, 10, [(2, 9), (2, 9), (6, 3), (6, 1), (6, 1), (3, 2), (3, 2)]) == True
    assert candidate(7, 9, 5, [(1, 1), (2, 6), (2, 1), (1, 3), (4, 4), (1, 1), (3, 5)]) == False
    assert candidate(7, 10, 9, [(4, 1), (10, 4), (5, 6), (6, 1), (1, 1), (9, 1), (1, 9)]) == False
    assert candidate(6, 8, 3, [(4, 3), (2, 7), (3, 1), (1, 1), (4, 3), (3, 8)]) == True
    assert candidate(7, 10, 5, [(3, 3), (4, 7), (9, 1), (1, 10), (3, 5), (4, 2), (4, 2)]) == False
    assert candidate(1, 8, 6, [(1, 2)]) == False
    assert candidate(7, 8, 9, [(3, 6), (3, 6), (3, 6), (6, 3), (6, 3), (6, 3), (3, 6)]) == True
    assert candidate(7, 10, 10, [(2, 10), (2, 10), (5, 4), (2, 10), (5, 4), (10, 2), (4, 5)]) == True
    assert candidate(7, 3, 4, [(1, 8), (3, 2), (3, 1), (2, 1), (1, 1), (4, 2), (1, 4)]) == True
    assert candidate(7, 10, 1, [(3, 1), (3, 1), (2, 1), (1, 1), (4, 1), (1, 7), (1, 9)]) == True
    assert candidate(7, 10, 10, [(1, 1), (1, 1), (1, 1), (1, 1), (1, 1), (1, 1), (10, 10)]) == True
    assert candidate(7, 8, 9, [(3, 8), (3, 8), (3, 8), (5, 6), (4, 7), (5, 5), (5, 5)]) == True
    assert candidate(7, 9, 8, [(2, 8), (1, 8), (7, 3), (8, 1), (3, 1), (6, 1), (9, 2)]) == True
    assert candidate(4, 9, 8, [(9, 1), (1, 1), (1, 8), (6, 9)]) == True
    assert candidate(7, 8, 9, [(2, 6), (2, 6), (2, 6), (6, 2), (6, 2), (6, 2), (3, 4)]) == False

# Use check(can_tile_grid) to run tests.

