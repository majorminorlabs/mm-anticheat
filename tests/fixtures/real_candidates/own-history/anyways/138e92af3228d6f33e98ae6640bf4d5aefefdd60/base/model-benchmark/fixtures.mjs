import { EDITORIAL_PROMPT_DOCTRINE } from '../src/editorial.mjs';

export { EDITORIAL_PROMPT_DOCTRINE as doctrine };

export const candidates = [
  ['c01','A city requires data centers to publish neighborhood water use before permits are renewed','systems','proceed','ai'],
  ['c02','A video platform changes its recommendation system to privilege group chats over public posts','internet','proceed',''],
  ['c03','A musician sells concert tickets through a fan cooperative that shares resale profits','media','proceed','music'],
  ['c04','A repair collective maps which apartment buildings ban tenant-installed heat pumps','modern-life','proceed','cities'],
  ['c05','A small fashion label uses preorders to let customers vote on which silhouettes reach production','builders','proceed','fashion'],
  ['c06','A grocery delivery app adds a new dark mode','modern-life','reject',''],
  ['c07','A phone maker announces a slightly faster processor','modern-life','reject',''],
  ['c08','A celebrity posts a teaser for an unreleased album','media','reject','music'],
  ['c09','A sports league signs a shoe sponsorship deal with no change to fan access or labor rules','taste','reject','sports'],
  ['c10','A game studio lets players train private NPCs on their own saved play history','modern-life','proceed','gaming,ai'],
  ['c11','A city removes parking minimums around public libraries and tracks which small businesses appear','systems','proceed','cities,architecture'],
  ['c12','A luxury brand opens a flagship store with an expensive launch party','taste','watch','luxury,brands'],
  ['c13','A startup promises an AI assistant for every spreadsheet without publishing prices or access details','modern-life','reject','ai'],
  ['c14','A labor union builds a public calculator that compares creator-platform payout terms','systems','proceed','media'],
  ['c15','A museum releases 3D scans that allow local schools to make tactile replicas','modern-life','proceed','design'],
  ['c16','A viral clip claims a new battery charges in 30 seconds, but its source is an anonymous repost','internet','watch',''],
  ['c17','A restaurant chain introduces a limited seasonal drink','taste','reject','food'],
  ['c18','A community radio station publishes the hidden fees that determine which local musicians get airplay','media','proceed','music'],
  ['c19','A car company shows a concept vehicle at an auto show with no production plan','taste','reject','automotive'],
  ['c20','A design tool changes its pricing so free users lose access to their own archived files','modern-life','proceed','design']
].map(([id, headline, section, decision, beats]) => ({ id, headline, expected_section: section, expected_decision: decision, expected_beats: beats ? beats.split(',') : [] }));

export const sourcePacket = `SOURCE A (city filing, May 2): River County approved a 120MW data center after the operator agreed to publish monthly water use. SOURCE B (operator press release, May 3): the facility will create 400 permanent jobs. SOURCE C (county labor office, May 8): comparable facilities employ 35 to 80 permanent workers. SOURCE D (utility meeting transcript, May 11): the local grid upgrade is estimated at $86m and the utility has not allocated costs. SOURCE E (mayor interview, May 14): residents were not consulted before the first vote.`;

export const claimSet = [
  ['River County approved a 120MW data center.','supported'],
  ['The operator agreed to publish monthly water use.','supported'],
  ['The project will certainly create 400 permanent jobs.','partially_supported'],
  ['Comparable facilities employ at least 400 permanent workers.','contradicted'],
  ['The grid upgrade costs exactly $86m.','partially_supported'],
  ['The project is obviously a bad deal for residents.','opinion'],
  ['The filing was made last week.','requires_human_review']
];

export const flawedArticle = `The new River County data center is a game changer. It is a game changer because it will transform the future of technology. The project was approved, and this means a lot. In conclusion, the future is here. The company says it creates 400 permanent jobs, while the county labor office says comparable sites employ 35 to 80. This illustrates the complex landscape. Moreover, it is important to note that residents were not consulted.`;

export const slopDraft = `In today's rapidly evolving landscape, River County's data center represents more than a building. It represents a paradigm shift. It is not just about computers; it is about the future. From jobs, to water, to power, the implications are profound. Ultimately, only time will tell what happens next.`;
