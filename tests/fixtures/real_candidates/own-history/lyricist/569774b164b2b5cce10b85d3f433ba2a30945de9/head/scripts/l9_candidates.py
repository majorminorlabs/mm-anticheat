"""Target-independent, manually read proposal ledger for L9.

Each row was checked against the complete L5 training target at ``source_index``.
Evidence and adverse readings are paraphrases, not copied lyric text. A rejected
proposal remains here so regeneration preserves the full review denominator.
"""
from __future__ import annotations


def parse(block: str, kind: str):
    rows = []
    for line in block.strip().splitlines():
        fields = [part.strip() for part in line.split('|')]
        if len(fields) != 5:
            raise ValueError(f'{kind} proposal needs five fields: {line}')
        index, prompt, logic, evidence, counter_reading = fields
        rows.append({'source_index': int(index), 'constraint_type': kind,
                     'constraint_prompt': prompt, 'logic': logic,
                     'evidence_summary': evidence,
                     'possible_ambiguity': counter_reading})
    return rows


LEXICAL = parse("""
1 | Write about returning to a beginning after an apparent ending, without using the word finality. | finality | The ending seems complete, yet movement returns to the start. | Apparent ending is not literal death; the prompt asks for felt closure.
7 | Write about the look someone gives when they cannot accept what is said, without using disbelief. | disbelief | A face accompanies refusal to believe and requests for clarity. | The facial expression is not named; the refusal supplies its meaning.
20 | Write about trying to put a broken bond back together, without using rebuild or its forms. | rebuilding | A broken thing cannot be built again after separation. | The passage can concern a bond or an object; both support rebuilding.
27 | Write about forgetting where you came from to find a future direction, without using origin or its forms. | origins | Former beginnings are forgotten in order to find where to go. | The destination is still unknown, which the prompt allows.
30 | Write about keeping a reason from nearby people, without using secret or its forms. | secrets | The speaker keeps the cause to themself amid nearby others. | The hidden matter is unspecified but concealment is explicit.
48 | Write about trying and failing to save someone, without using rescue or its forms. | rescue | The speaker says saving her did not succeed. | The target does not establish how rescue was attempted; the prompt does not require a method.
55 | Write about two people considering departure as love is thrown away, without using relationship or its forms. | relationship | Shared love is discarded while staying and leaving are weighed. | The exact legal or social bond is unspecified; a bond is still clear.
59 | Write about changing metaphors so listeners understand, without using language. | language | Rewording metaphors for listeners is central. | The passage is about expression, not a named language; the prompt is broad.
79 | Write about a sudden hurt that makes people break apart, without using fragment or its forms. | fragmentation | A wound and breaking apart occur together. | The break may be emotional rather than physical, which the prompt permits.
93 | Write about a wrong step during a hard winter, without using mistake or its forms. | mistake | A remembered wrong step occurs during winter. | The step could be literal or figurative; either is an error.
102 | Write about questioning whether anything matters without a god, without using value or its forms. | value | The target asks whether anything is worth it without a god. | This is existential worth rather than a price; the prompt does not demand price.
115 | Write about someone being caught by force, without using capture or its forms. | capture | The target places being caught by force beside a threatened bed. | The captor is unspecified, which the prompt leaves open.
127 | Write about someone refusing to face a child's fever, without using acknowledge or its forms. | acknowledge | The addressee's eyes know but refuse to see the illness. | The refusal is figurative; the prompt asks for refusal to face it.
134 | Write about wanting to be accepted as one of another person's children, without using belong or its forms. | belonging | The speaker asks to be counted among the addressee's children. | Adoption is not confirmed; the prompt asks only for desire.
143 | Write about suppressed feeling changing what a person can see, without using perceive or its forms. | perception | Suppression weighs on and strips light from an image of life. | The mechanism is figurative, but altered seeing is explicit.
165 | Write about a distant approach becoming a stampede that covers people in dust, without using overwhelm or its forms. | overwhelmed | Approaching footsteps and uncontrollable dust engulf the group. | The emotional reaction is not specified; the prompt describes the scene.
191 | Write about entering a light and surrendering before an impact, without using unknown or its forms. | unknown | The speaker yields to something not understood before impact. | The object remains unnamed, as the prompt allows.
214 | Write about a painful feeling carried in verses and chords, without using music or musical. | music | Verses and chords carry the feeling the speaker wants cured. | The passage could be about a song or performance; both are musical.
""", 'lexical_prohibition')


SPATIAL = parse("""
0 | Write about roots deliberately fixed in concrete so the thing they hold cannot move. | roots > fixed_by > concrete | The roots are set in concrete to prevent movement. | An anchor could be figurative, but concrete and immobility are both stated.
5 | Begin on an airplane, then let the same shared laughter continue after leaving it. | laughter > continues_after > aircraft | The scene moves from an aircraft to a later moment off it. | The laughter continues rather than first appearing after landing.
8 | Write about taking action before preparation and before a second thought. | beginning > precedes > preparation | Beginning comes first and preparation is explicitly later. | The sequence is imperative rather than a narrated event; it still states the order.
13 | Move through a day of doses from sunrise to afternoon to evening. | sunrise_dose > precedes > afternoon_and_evening | Doses and bodily effects are ordered across the day. | The evening effect is not another dose; the prompt only says move through the day.
15 | Let the unsettling voice come from inside a lock rather than elsewhere in the room. | voice > inside > lock | A voice originates within the lock. | The lock may be surreal; its inside position is unambiguous.
29 | Keep the moving limbs below an undertow as the crowd washes away. | limbs > below > undertow | The moving limbs are explicitly below the undertow. | The crowd is figurative, but the vertical relation is stated.
38 | Put a pulse beneath a door while the speaker worries that someone has given up. | pulse > beneath > door | A vibration is located under a door. | The source of the pulse is not identified; its position is.
47 | After a bond falls apart, keep another person's head against the speaker's chest. | head > against > chest | The head rests on the speaker's chest after a falling-apart passage. | The identity of the other person is not fixed, but contact is.
51 | Place broken glass in a fire while a heart shape is questioned. | glass > in > fire | Broken glass is explicitly located in fire. | The heart image can be abstract; the glass location is not.
61 | Have the speaker move through a forest toward a mother after harming her son. | speaker > toward > mother | The speaker moves forestward toward the mother after harm to her son. | The harm's timing is past tense; the movement direction is explicit.
62 | Set an execution in a courtyard where awake witnesses can see it. | execution > in > courtyard | The event is located in the courtyard and visible to witnesses. | The witnesses need not stand inside it; the event does.
71 | Put an isolated house on a pebble driveway. | house > on > driveway | A house sits upon a pebble driveway. | The driveway might be figurative in ordinary writing, but the target uses a concrete setting.
72 | Make a frozen creek the place one person wants to take another. | destination > at > frozen_creek | A speaker wants to take the addressee to the frozen creek. | The trip is a wish, not an accomplished visit; the prompt preserves that.
77 | Contrast a windowless room the speaker enters with the easier air of daylight beyond it. | speaker > inside_then_contrasts > windowless_room_and_daylight | The speaker locks themself in a room without a window and later contrasts daylight. | A physical outdoor step is not required; the prompt only contrasts settings.
83 | Write about two people who possess different kinds of evidence and different absences. | woman_photos_man_motive > contrast > memory_and_transport | The woman has photos without recollection; the man has motive without transportation. | The initial wording leaves ownership of each lack unclear; revision assigns them.
95 | Keep the troubling thing buried beneath a heart instead of exposed. | thing > beneath > heart | The target puts an unnamed thing under the heart. | The heart is likely figurative; the prompt allows that image.
106 | Let flames grow around another person's feet while the speaker waits for them. | flames > around > addressee_feet | Flames surround the addressee's feet and the speaker waits. | The fire's cause is unknown; its relation to the feet is explicit.
111 | Set a person's mind above words while identity begins to erase. | mind > above > words | The mind is placed above words as identity erasure is discussed. | The hierarchy is figurative, but the target states it.
112 | Make someone's hiding place the minds of other people, not a physical shelter. | hiding_place > inside > other_minds | Hiding is located in other people's minds. | The location is metaphorical by design; physical shelter would misread it.
116 | Stage a cold marble ritual inside a catacomb rather than outdoors. | ritual > inside > catacomb | Catacomb interior, marble, match, candles, and salt ring form the scene. | The target does not say every person stays indoors; the ritual scene does.
118 | Place small pieces of stone beneath fingernails and turn the addressee toward the sun. | stone > beneath > fingernails | Stone fragments are under fingernails, and the addressee faces sunlight. | The target's tense is predictive; the prompt asks for relations rather than event order.
135 | Put clean water where the addressee is while the speaker washes off restraints. | water > at > addressee_location | Clean water is tied to the addressee's location and handcuffs are washed off. | The speaker's physical location is not specified; the prompt does not impose one.
136 | Contrast a speaker who was absent with the burden they nevertheless felt. | speaker > absent_but_feels > other_burden | The speaker was not there yet felt the addressee's weight. | The burden may be emotional; the absence-versus-feeling contrast remains.
146 | Bury something deep beneath ancient walls while two people stand apart in language. | buried_thing > beneath > ancient_walls | Something is buried under walls during a linguistic standoff. | The buried object is unspecified; location and standoff are explicit.
157 | Confine the speaker to a chilly pale room while they wonder who may come. | speaker > inside > cold_white_room | A cold white room contains the trapped speaker. | The question about others does not place them in the room; the prompt does not place them there.
169 | Show people going through the same experience at different times rather than different experiences together. | people > same_experience_at > different_times | The target states shared experience at different times. | It does not require the people to meet, which the prompt avoids.
173 | Put a ledger in a waterfall, not beside it, so it can be washed away. | ledger > in > waterfall | The ledger is kept in the waterfall for washing away. | Its fate after washing is uncertain; the location is clear.
180 | Bring a stone-armored army home at twilight. | army > moves_toward > home | The army is coming home at twilight and its armor is stone. | Arrival is not completed; the prompt asks for motion toward home.
181 | Let understanding happen on the way down and belief arrive only on the way out. | understanding > before > belief | Breakdown is understood on descent; belief is decided on exit. | The realization may be late, which the prompt permits.
197 | Keep fragments on a ledge high above a sleeping giant. | fragments > above > sleeping_giant | Fragments occupy a high ledge above the giant. | The giant can be symbolic; the height relation is explicit.
209 | Place the speaker under desert lights while the night wears them down. | speaker > beneath > desert_lights | The speaker is under desert lights and then diminished by night. | The desert-wind simile is not a literal location; the light position is.
221 | Let a recording carry the addressee's shouted words in a Southern accent. | voice > recorded_on > tape | The addressee's voice is recorded on tape in that accent. | The person may be present elsewhere; only the voice's medium is specified.
""", 'spatial_relation')


EXCLUSION = parse("""
22 | Write about someone hiding because discovery would hurt them; let fear show without naming it. | fear | A hiding place, likely discovery, and heavy stress make fear plausible. | The target does not say the hider is physically chased; the prompt asks only for fear of discovery.
56 | Write about shared love being discarded as two people consider leaving; imply abandonment without naming it. | abandonment | A bond is thrown away as departure and isolation are weighed. | Departure is contemplated, not certain; abandonment is suggested rather than asserted.
57 | Show a hard-won effort burning away; suggest defeat without naming it. | defeat | What people fought for burns up, undermining the effort. | The struggle might continue, so the prompt asks for suggestion, not final defeat.
63 | Write about destroying evidence and fleeing a scene; imply wrongdoing without naming a crime. | crime | Evidence is burned and traces are avoided after flight. | The exact offense is unknown; the prompt deliberately leaves it unnamed.
75 | Write about misspent time and words that will not come; let regret emerge without naming it. | regret | The speaker wishes time had been spent more wisely. | A present writing block also appears; it does not cancel the past regret.
80 | Write about cutting off someone's voice after a serious mistake; suggest regret without saying it. | regret | The speaker asks to hear that voice again after cutting it short. | The precise mistake is unclear, but the desire to undo loss is clear.
81 | Write about a familiar place after loss, with a piano late at night; convey grief without naming it. | grief | A person may be gone for good while the speaker cannot sleep and plays piano. | The loss may be a breakup rather than death; grief covers both.
84 | Write about checking whether someone is alive while suspecting harm; convey anxiety without using that label. | anxiety | Vital-sign checking, poison suspicion, and paranoia support anxiety. | The symptoms may be comic or surreal; the anxious vigilance is explicit.
86 | Write about a truth that might make someone stay; suggest longing without naming it. | longing | The speaker imagines truth retaining the addressee as forever recedes. | The target does not say the truth is told; the prompt leaves it conditional.
89 | Write about carrying another person's burdens despite dangerous currents; imply devotion without naming it. | devotion | The speaker promises to carry everything for the addressee. | The burden is unspecified; the repeated offer is enough for devotion.
101 | Write about a house disturbed by someone who broke promises; imply betrayal without using that label. | betrayal | Broken promises and a household woken by an unknown person supply the breach. | The broken promises may be minor; the prompt asks for implication only.
103 | Write about crosses being knocked down because a god takes things away; suggest rebellion without naming it. | rebellion | The target challenges divine power and knocks crosses down. | This is defiance of an image of religion, not a claim about all faiths.
105 | Write about waiting through wildfire for a sleeping person; imply devotion without using that word. | devotion | The speaker waits despite wildfire and suffering. | The relationship is not specified; the chosen wait is central.
120 | Write about letting someone go quietly while forgetting how you once felt; imply affection fading without naming a breakup. | breakup | The speaker asks to be let go and forgets prior feeling. | A formal breakup is not established; the prompt avoids asserting one.
129 | Write about someone turning their back on a person they once needed; imply betrayal without saying it. | betrayal | A past request for help is set against turning away now. | The motive is unknown; the action still suggests a breach.
138 | Write about failed faith and difficulty trusting after seeing suffering; let disillusionment remain unnamed. | disillusionment | Former beliefs are found false and trust is lost. | The target questions a particular account of love, not every belief.
142 | Write about a voice repeating in someone's head like an unidentifiable song; imply obsession without naming it. | obsession | The addressee repeats continuously in the speaker's head. | This could be involuntary memory; the prompt asks only to suggest fixation.
149 | Write about biting one's tongue around a blood relation until an uncomfortable truth lands; let resentment remain unnamed. | resentment | The speaker holds back words while questioning a shared blood tie. | The feeling could also be hurt; the restrained confrontation supports resentment.
161 | Write about feelings sacrificed and forgiveness requiring another's help; imply dependence without naming it. | dependence | The speaker cannot accomplish the larger task alone. | The need may be situational rather than chronic; the prompt does not demand a trait.
168 | Write about wanting to make amends while struggling to forgive; imply reconciliation without naming it. | reconciliation | The speaker longs to be beside the addressee and make amends amid difficulty forgiving. | Forgiveness is unfinished; the prompt asks for a wish, not an achieved reunion.
176 | Write about someone avoiding crowds who never learned the way back; imply being lost without using lost. | lost | A mistake and inability to return make disorientation concrete. | The lostness may be emotional as well as geographical, which the prompt permits.
189 | Write about writing rather than speaking while unable to be honest; imply emotional avoidance without naming it. | avoidance | The speaker refuses discussion, writes instead, and admits inability to be honest. | Writing may also be coping; the avoidance of direct speech is explicit.
201 | Write about a life falling short of what someone hoped for; suggest disappointment without naming it. | disappointment | The addressee's life differs from what they had hoped. | The target does not resolve whether hope returns; the prompt does not require it.
206 | Write about waiting for someone while both expect they may not get out; imply hopelessness without naming it. | hopelessness | Repeated predictions that escape will fail sit beside repeated waiting. | The speaker still asks for patience; hopelessness is present but not absolute.
210 | Write about asking a former ally to stay close; imply loneliness without naming it. | loneliness | A past confidant is addressed amid a present need for closeness. | The addressee could return; the current lack of closeness is still clear.
""", 'indirect_exclusion')


MIXED = parse("""
39 | Keep the speaker pushed to stay while another person is drawn into waves; suggest danger without naming it. | speaker > pushed_to > stay ; danger | One person pushes the speaker to stay while waves pull the other inward. | The water scene may be metaphorical, but the two directions and danger cues coexist.
73 | Place the speaker above a frozen creek while something flows through them; do not name the flowing substance. | speaker > above > frozen_creek ; water | The speaker is atop the creek and describes something flowing through them. | The substance could be figurative rather than literal water; the prompt leaves it unnamed.
82 | Set a piano in the early morning beside a relationship that has gone for good; imply grief without naming it. | piano > at > early_morning ; grief | The piano is played early in the morning as a bond is lost. | The loss may be separation rather than death; grief allows either.
85 | Keep someone awake while a television buzzes, without naming insomnia. | speaker > awake_with > television ; insomnia | The speaker lies wide awake while the television buzzes. | A single bad night is not a diagnosis; the prompt uses the concept informally.
104 | Let voices resemble someone who never arrived; suggest longing without saying it. | voices > resemble > absent_person ; longing | The voices sound like the addressee, who never came. | The cause of absence is unstated; longing follows from the speaker's response.
122 | Contrast a magical shared past with a present in which the speaker cannot recognize the other person; suggest nostalgia without naming it. | recognition > lost_after > shared_past ; nostalgia | Youthful wonder is recalled before present nonrecognition. | The feeling may mix regret and grief; nostalgia remains a plausible undertone.
131 | Let one person seek forgiveness while another refuses to let the past go; imply guilt without naming it. | supplicant > seeks_from > unforgiving_other ; guilt | The speaker asks to be cleansed while the other will not let the wrong fade. | The guilt is moral rather than legal, consistent with the prompt.
175 | Keep one person trying to make love stay while the other will not change; imply heartbreak without naming it. | speaker > tries_to_keep > departing_other ; heartbreak | The speaker cannot persuade the addressee to change and calls love toward staying. | A final departure is not confirmed; heartbreak is implied by the attempt.
178 | Write about someone recognizing the speaker's name before learning that the speaker has gone, and call it abandonment. | recognition > before > departure_discovery ; separation | Recognition precedes learning that the speaker is gone. | The initial wording asserts a motive; the revision asks only for implied separation.
195 | Keep the addressee already at the destination while the speaker has no maps; imply disorientation without naming it. | addressee > already_at > destination ; lost | The addressee is already there while the speaker cannot find a way without maps. | A literal destination is not named, but the relative positions are clear.
""", 'mixed')


def parse_rejected(block: str):
    rows = []
    for line in block.strip().splitlines():
        fields = [part.strip() for part in line.split('|')]
        if len(fields) != 7:
            raise ValueError(f'rejected proposal needs seven fields: {line}')
        index, kind, prompt, logic, evidence, counter_reading, reason = fields
        rows.append({'source_index': int(index), 'constraint_type': kind,
                     'constraint_prompt': prompt, 'logic': logic,
                     'evidence_summary': evidence,
                     'possible_ambiguity': counter_reading,
                     'rejection_reason': reason})
    return rows


REJECTED = parse_rejected("""
32 | lexical_prohibition | Write about trust breaking during a dance, without saying trust. | trust | A camera betrays someone during dancing. | The camera's betrayal need not be interpersonal trust. | Forbidden concept is not sufficiently central to the target.
139 | lexical_prohibition | Write about wealth without saying wealth. | wealth | The target explicitly names money. | A synonym names the forbidden concept directly. | The ban would reward a shallow lexical loophole.
193 | lexical_prohibition | Write about unreality without saying unreal. | unreal | The target says no one is real. | A synonym names the concept directly. | The lexical ban would reward a shallow loophole.
31 | spatial_relation | Send a burden outward while sight is lost. | burden > moves_away_from > speaker | A cross is gripped and an instruction to send appears. | It is unclear what is sent or where sight is lost. | The relation is not grounded in one coherent event.
78 | spatial_relation | Put a stolen memory in a specific hiding place. | memory > in > hidden_place | A surprising place is mentioned. | No location is identified. | The target cannot support a specific spatial relation.
125 | spatial_relation | Leave a bedroom and arrive before a judge. | speaker > moves_from > bedroom_to_court | A bedroom and a gavel occur in sequence. | A gavel may be figurative and no court or judge is named. | Court arrival would be invented.
147 | spatial_relation | Keep the answer physically within someone's reach. | answer > within_reach > addressee | Answers are said to be within reach. | This is clearly figurative and gives no physical distance. | Literal spatial supervision would be misleading.
12 | indirect_exclusion | Imply isolation without saying it. | isolation | The target describes disagreement and being close. | It repeatedly says people felt alone. | The core emotion is directly named by a synonym, not expressed indirectly.
58 | indirect_exclusion | Imply fear of separation without saying fear. | fear | A disaster and possible falling apart are discussed. | The speaker also says separation would be difficult and may sound confident. | Fear is not unambiguously conveyed.
68 | indirect_exclusion | Suggest shame without naming it. | shame | A person acts while being guilty at home. | Guilt is explicit but shame is not established. | The target supports a different emotion more directly.
96 | indirect_exclusion | Suggest insomnia without naming it. | insomnia | The speaker cannot sleep without a radio. | Inability to sleep is directly stated. | This is a lexical omission rather than indirect expression.
109 | indirect_exclusion | Imply loneliness without naming it. | loneliness | The speaker imagines a place where no one recognizes them. | The passage explicitly begins with being alone. | The concept is already directly expressed.
110 | indirect_exclusion | Suggest loneliness because no one stays. | loneliness | The speaker has nothing left to show. | The speaker says they would not be offended if no one stayed. | The emotional implication could reasonably be absent.
220 | indirect_exclusion | Imply a writer's block without saying it. | writers_block | The speaker stares at a notebook and cannot write. | The inability is directly explained. | The prompt would test only a missing label.
65 | mixed | Have someone arrive while the speaker is blind, without naming blindness. | arrival > before > blindness ; blindness | Someone arrives and the speaker cannot see their eyes. | Failure to see eyes does not establish blindness. | One half of the mixed constraint is unsupported.
97 | mixed | Show a machine-like dream figure with someone else, without naming jealousy. | dream_figure > with > other_person ; jealousy | A dream figure appears with another person. | The speaker might feel no jealousy. | The exclusion is an invented emotional reading.
""")


PROPOSALS = LEXICAL + SPATIAL + EXCLUSION + MIXED + REJECTED
assert len(PROPOSALS) == len({row['source_index'] for row in PROPOSALS})
assert len(PROPOSALS) == 101


# These are presence checks only. They do not replace the full-target reading
# that establishes subject, direction, and scope of a relation.
RELATION_MARKERS = {
    0: ['concrete', 'roots', 'move'],
    5: ['airplane', 'off the aircraft', 'laugh'],
    8: ['begin before', 'prepare'],
    13: ['sunrise', 'afternoon', 'evening'],
    15: ['inside of a lock'],
    29: ['below the undertow'],
    38: ['under the door'],
    39: ['pushing me to stay', 'waves start pulling you in'],
    47: ['head on my chest'],
    51: ['glass in the fire'],
    61: ['forest', 'towards the mother', 'son'],
    62: ['courtyard', 'witness'],
    71: ['driveway', 'house'],
    72: ['on top the frozen creek', 'take you'],
    73: ['flows through me', 'on top the frozen creek'],
    77: ['room without a window', 'daylight'],
    82: ['piano at 6:30 am', 'gone for good'],
    83: ['photos', 'recollection', 'motive', 'transportation'],
    85: ['lying wide awake', 'buzzing of the television'],
    95: ['buried under the heart'],
    104: ['voices sound just like you', 'you never came'],
    106: ['flames', 'around your feet', 'wait'],
    111: ['mind above and over words'],
    112: ["hide in other people's minds"],
    116: ['inside the catacomb', 'candles', 'salt ring'],
    118: ['beneath your fingernails', 'face the sun'],
    122: ['when we were young', "can't recognize you"],
    131: ['forgiven', "won't ever let me live it down"],
    135: ['water', 'where you are', 'handcuffs'],
    136: ["wasn't there", 'felt the weight'],
    146: ['underneath', 'walls'],
    157: ['trapped in a cold white room'],
    169: ['same thing', 'different times'],
    173: ['ledger in the waterfall'],
    175: ['make everything stay', "can't convince you to change"],
    178: ['realize my name', "realize i'm gone"],
    180: ['coming home', 'armor made of stone'],
    181: ['way down', 'way out', 'believe'],
    195: ["you're already there", 'without maps'],
    197: ['above the sleeping giant', 'ledge'],
    209: ['under desert lights'],
    221: ['voice on tape', 'southern accent'],
}
assert set(RELATION_MARKERS) == {row['source_index'] for row in SPATIAL + MIXED}


# The three revisions preserve the same target and constraint; only prompt
# wording was repaired after reading the full target.
REVISIONS = {
    83: ('Write about a woman with photos and a man with a motive, but keep their deficits different.',
         'Make the two people asymmetrical: one has photographs but no memory, while the other has a motive but no way to travel.',
         'Initial prompt did not specify which absence belonged to which person.'),
    103: ('Write against religion without saying rebellion.',
          'Suggest defiance toward religious authority through a god taking things away and crosses being knocked down, without naming rebellion.',
          'Initial prompt overclaimed that the target rejects religion itself.'),
    178: ('Write about abandonment after someone recognizes a name.',
          'Let one person recognize the speaker before discovering the speaker has gone; suggest separation without naming it.',
          'Initial prompt imposed abandonment as a settled motive rather than an implied consequence.'),
}
