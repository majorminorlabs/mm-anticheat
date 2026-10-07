def min_operations_to_rearrange(n: int, s: str, t: str) -> int:
    """ Given two strings s and t of length n consisting of 'B' and 'W' characters,
    determine the minimum number of operations needed to transform the initial configuration s
    into the target configuration t.
    
    Initially, there are n stones placed in cells 1 to n according to string s,
    where 'W' represents a white stone and 'B' represents a black stone.
    There are also two empty cells at positions n+1 and n+2.
    
    In one operation, you can:
    - Choose two adjacent cells that both contain stones
    - Move these two stones to the two empty cells while preserving their order
    
    Return the minimum number of operations needed to achieve configuration t,
    or -1 if it's impossible.
    
    Args:
        n: Number of stones (2 <= n <= 14)
        s: Initial configuration string of length n
        t: Target configuration string of length n
    
    Returns:
        Minimum number of operations, or -1 if impossible
    
    >>> min_operations_to_rearrange(6, 'BWBWBW', 'WWWBBB')
    4
    >>> min_operations_to_rearrange(6, 'BBBBBB', 'WWWWWW')
    -1
    >>> min_operations_to_rearrange(3, 'BBW', 'BBW')
    0
    """
    if s == t:
        return 0
    if s.count('B') != t.count('B'):
        return -1

    # A state records black-stone positions and the first of the two empty
    # cells. White stones occupy every remaining nonempty position.
    start = (sum(1 << i for i, stone in enumerate(s) if stone == 'B'), n)
    goal = (sum(1 << i for i, stone in enumerate(t) if stone == 'B'), n)
    sources = [
        [i for i in range(n + 1) if i + 1 < hole or i > hole + 1]
        for hole in range(n + 1)
    ]

    frontier = {start}
    other_frontier = {goal}
    distances = {start: 0}
    other_distances = {goal: 0}

    # Every move can be reversed, so search from both configurations and
    # expand one complete layer of the smaller frontier at a time.
    while frontier and other_frontier:
        if len(frontier) > len(other_frontier):
            frontier, other_frontier = other_frontier, frontier
            distances, other_distances = other_distances, distances

        next_frontier = set()
        for mask, hole in frontier:
            distance = distances[(mask, hole)] + 1
            for source in sources[hole]:
                pair = (mask >> source) & 3
                moved_mask = (mask & ~(3 << source)) | (pair << hole)
                state = (moved_mask, source)
                if state in distances:
                    continue
                if state in other_distances:
                    return distance + other_distances[state]
                distances[state] = distance
                next_frontier.add(state)
        frontier = next_frontier

    return -1
