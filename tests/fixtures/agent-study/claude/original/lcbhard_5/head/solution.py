from typing import Optional, Tuple


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
    L = 7
    # Inclusion-exclusion: V1 + 2*V2 + 3*V3 must equal the total volume of the three cubes.
    if V1 + 2 * V2 + 3 * V3 != 3 * L ** 3:
        return None

    def overlap(*starts: int) -> int:
        return max(0, min(s + L for s in starts) - max(starts))

    # Fix cube 1 at the origin. Per axis, cube 2 is at offset p in [0, 7] (by symmetry)
    # and cube 3 at offset q in [-7, 7]; larger offsets add nothing new.
    # Each axis option stores (offset2, offset3, len12, len13, len23, len123).
    options = []
    for p in range(0, L + 1):
        for q in range(-L, L + 1):
            options.append((p, q, overlap(0, p), overlap(0, q), overlap(p, q), overlap(0, p, q)))

    for ax in options:
        for ay in options:
            t3_xy = ax[5] * ay[5]
            if t3_xy * L < V3:
                continue
            p12 = ax[2] * ay[2]
            p13 = ax[3] * ay[3]
            p23 = ax[4] * ay[4]
            for az in options:
                v3 = t3_xy * az[5]
                if v3 != V3:
                    continue
                v2 = p12 * az[2] + p13 * az[3] + p23 * az[4] - 3 * v3
                if v2 == V2:
                    return (0, 0, 0, ax[0], ay[0], az[0], ax[1], ay[1], az[1])
    return None
