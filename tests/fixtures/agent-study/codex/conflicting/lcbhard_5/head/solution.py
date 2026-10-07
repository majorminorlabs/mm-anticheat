from typing import Optional, Tuple
from functools import lru_cache
from itertools import permutations


@lru_cache(maxsize=1)
def _axis_patterns():
    """Return every distinct set of overlaps along one coordinate axis."""
    patterns = {}
    for order in permutations(range(3)):
        for first_gap in range(8):
            for second_gap in range(8):
                coordinates = [0, 0, 0]
                coordinates[order[1]] = first_gap
                coordinates[order[2]] = first_gap + second_gap
                a, b, c = coordinates
                overlaps = (
                    max(0, 7 - abs(a - b)),
                    max(0, 7 - abs(a - c)),
                    max(0, 7 - abs(b - c)),
                    max(0, 7 - first_gap - second_gap),
                )
                patterns.setdefault(overlaps, tuple(coordinates))
    return tuple(patterns.items())


def find_cube_placement(V1: int, V2: int, V3: int) -> Optional[Tuple[int, int, int, int, int, int, int, int, int]]:
    """ Given three volumes V1, V2, V3, find a placement of three cubes with side length 7 such that:
    - The volume of the region contained in exactly one cube is V1
    - The volume of the region contained in exactly two cubes is V2  
    - The volume of the region contained in all three cubes is V3
    
    Each cube C(a,b,c) is defined by the region (a ≤ x ≤ a+7) ∧ (b ≤ y ≤ b+7) ∧ (c ≤ z ≤ c+7).
    
    Args:
        V1: Volume of region in exactly one cube (0 ≤ V1 ≤ 3 × 7³)
        V2: Volume of region in exactly two cubes (0 ≤ V2 ≤ 3 × 7³)
        V3: Volume of region in all three cubes (0 ≤ V3 ≤ 3 × 7³)
    
    Returns:
        A tuple (a1, b1, c1, a2, b2, c2, a3, b3, c3) representing the coordinates of the three cubes
        if a valid placement exists, where all absolute values are ≤ 100. Returns None if no valid
        placement exists.
    
    >>> find_cube_placement(840, 84, 7)
    (0, 0, 0, 0, 6, 0, 6, 0, 0)
    >>> find_cube_placement(343, 34, 3)
    None
    """
    if min(V1, V2, V3) < 0 or V1 + 2 * V2 + 3 * V3 != 3 * 7**3:
        return None

    # Pairwise intersections count the triple intersection three times.
    pairwise_volume = V2 + 3 * V3
    patterns = _axis_patterns()
    # Sorting the cube starts on an axis gives two adjacent gaps. A gap
    # greater than seven can be reduced to seven without changing any
    # intersection, so these patterns cover all integer placements.
    for x_overlaps, x_coordinates in patterns:
        for y_overlaps, y_coordinates in patterns:
            ab = x_overlaps[0] * y_overlaps[0]
            ac = x_overlaps[1] * y_overlaps[1]
            bc = x_overlaps[2] * y_overlaps[2]
            triple = x_overlaps[3] * y_overlaps[3]
            if triple * 7 < V3 or (V3 and V3 % triple):
                continue
            for z_overlaps, z_coordinates in patterns:
                if triple * z_overlaps[3] != V3:
                    continue
                if (ab * z_overlaps[0] + ac * z_overlaps[1]
                        + bc * z_overlaps[2] != pairwise_volume):
                    continue
                return tuple(
                    coordinate
                    for cube in range(3)
                    for coordinate in (
                        x_coordinates[cube],
                        y_coordinates[cube],
                        z_coordinates[cube],
                    )
                )
    return None
