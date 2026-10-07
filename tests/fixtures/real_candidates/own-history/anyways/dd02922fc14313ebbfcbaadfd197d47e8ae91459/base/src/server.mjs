import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { URL } from 'node:url';

const ROOT = process.cwd(), DATA = path.join(ROOT, 'data', 'anyways.json'), UPLOADS = path.join(ROOT, 'uploads');
const PORT = Number(process.env.PORT || process.argv.find(a=>a.startsWith('--port='))?.split('=')[1] || 3000);

const sections = [
  ['anyways','Anyways...'], ['worth-your-time','Worth Your Time'], ['we-read-it','We Read It So You Don’t Have To'], ['receipts','Receipts'], ['meanwhile','Meanwhile...'], ['research','Research']
].map(([slug,name])=>({id:slug,slug,name}));
const topics = ['AI','Technology','Business','Markets','Internet Culture','Fashion','Sports','Gaming','Blockchain','Design','Creators','Politics'].map(name=>({id:slugify(name),name,slug:slugify(name)}));
const templates = { anyways:'## What happened\n\n## What actually matters\n\n## What comes next', 'worth-your-time':'## What we found\n\n## Why it is worth your time', 'we-read-it':'## What happened\n\n## Why it matters\n\n## Three key takeaways\n\n1.\n2.\n3.', receipts:'## What was said\n\n## What actually happened\n\n## Why it matters now', meanwhile:'## What happened\n\n## Why this is interesting', research:'## Summary\n\n## Methodology\n\n## Findings\n\n## Analysis\n\n## Limitations\n\n## Sources' };

/* The promise each section makes to the reader, from the Anyways Handbook. */
const promises = {
  'anyways':'The answer on consequential news, with the stakes up front.',
  'worth-your-time':'Work that earns your attention, recommended only after firsthand evaluation.',
  'we-read-it':'Dense primary material, turned into understanding.',
  'receipts':'The record, kept. Public words against later conduct.',
  'meanwhile':'Honest internet delight, with dignity intact.',
  'research':'Original knowledge through transparent methods.'
};

const sessions = new Map();
const id = ()=>crypto.randomUUID();
const esc = s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
function slugify(s){ return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'')||'story'; }
function load(){ if(!fs.existsSync(DATA)) return seed(); try{return JSON.parse(fs.readFileSync(DATA,'utf8'));}catch{return seed();} }
function save(db){fs.mkdirSync(path.dirname(DATA),{recursive:true});fs.writeFileSync(DATA,JSON.stringify(db,null,2));}

/* Temporary editorial filler for seeded stories. Keep it deterministic per
   article so a reseed is reproducible, and keep the generated section small
   enough that the full article can never approach the 1,500-word ceiling. */
function loremFiller(key, limit=320){
  const words='lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure reprehenderit voluptate velit esse cillum fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum integer feugiat scelerisque varius morbi enim nunc faucibus a pellentesque sit amet porttitor eget dolor'.split(' ');
  let state=0;
  for(const char of String(key)) state=(Math.imul(state||17,31)+char.charCodeAt(0))|0;
  const next=()=>{state=Math.imul(state^state>>>16,2246822519);return (state>>>0)/4294967296;};
  const out=[];
  let used=0;
  while(used<limit){
    const sentence=[];
    const length=8+Math.floor(next()*10);
    for(let i=0;i<length&&used+sentence.length<limit;i++)sentence.push(words[Math.floor(next()*words.length)]);
    if(sentence.length){out.push(sentence.join(' ') + '.');used+=sentence.length;}
  }
  return `## Notes from the desk\n\n${out.join(' ')}`;
}

function seededArticleBody(body, slug){
  const filler=`${body}\n\n${loremFiller(slug)}`;
  const trimmed=filler.trim();
  return trimmed.split(/\s+/).length<1500 ? trimmed : trimmed.split(/\s+/).slice(0,1499).join(' ');
}

function seed(){
  const now=new Date().toISOString();
  const users=[['admin','Admin User','admin@anyways.test','admin'],['editor','Editor User','editor@anyways.test','editor'],['contributor-one','Maya Chen','maya@anyways.test','contributor'],['contributor-two','Jon Bell','jon@anyways.test','contributor']].map(([id,name,email,role])=>({id,name,email,role,password:'anyways-demo',slug:slugify(name)}));
  const db={users,sections,topics,stories:[],sources:[],revisions:[],media:[],homepage:{primary:null,hidden:[]},searches:[]};
  const t=n=>topics.find(x=>x.name===n).id;
  const specs=[
    ['anyways','fcc-ai-data-center-zoning','The FCC just turned AI data centers into a federal zoning fight','A rule tucked into a spring docket lets Washington override local permitting for large computing sites. Mayors found out from the register, not the agency.','A new federal rule limits how cities can block AI data centers. Here is what it does, who it affects, and what happens next.','## What happened\n\nThe Federal Communications Commission voted 3 to 2 to classify large AI data centers as critical communications infrastructure. The classification lets operators appeal local zoning denials to the federal government, bypassing the city councils and county boards that have spent two years fighting over where these facilities go.\n\nThe rule was proposed in March and finalized last week. It covers any facility drawing more than 50 megawatts, which includes most of the buildout the major AI companies have announced through 2028.\n\n## What actually matters\n\nZoning is the only leverage most towns have over the biggest construction boom in tech. Data centers promise tax revenue and deliver it unevenly: they employ few people per acre, strain local power grids, and in several counties have already pushed residential electricity rates up by double digits. Moving permit appeals to Washington shifts the argument to a venue where the AI companies keep full-time lobbyists and the towns do not.\n\nThe vote also sets a precedent. If computing infrastructure is federal, the coming fights over transmission lines, water rights, and noise ordinances start from the same place.\n\n## What comes next\n\nThree states have said they will sue, and the appeals process does not open until September. Watch the first facility to invoke the rule, a 1.2 gigawatt site outside Memphis that a county board rejected in May. That case will define how much of the local veto survives.',['AI','Politics'],[['FCC Report and Order 26-41, In the Matter of Critical Computing Infrastructure','Federal Communications Commission','filing'],['Shelby County Board permit denial record, May 2026','Shelby County','official_announcement']]],
    ['anyways','sports-streaming-costs-cable','Watching sports now costs almost exactly what cable did','The new rights deals split the average fan’s teams across four services. Add them up and the savings that justified cord cutting are down to about $9 a month.','The final major league rights deal completes the streaming carve-up. The bundle is back. It just has better fonts.','## What happened\n\nThe last of the major leagues signed its new rights package this week, splitting games between a broadcast network, two streaming services, and the league’s own app. A fan who wants to follow one team through a full season now needs four subscriptions.\n\nThe math is no longer subtle. The four services together run about $86 a month in season. The average cable bill when cord cutting peaked was $95.\n\n## What actually matters\n\nThe economics of the bundle never disappeared. They waited. Sports were the last reason to keep cable, so every league discovered it could charge each service a premium for exclusive windows, and the services discovered they could pass the premium to fans who had nowhere else to go.\n\nThe losers are not just fans. Bars, which once paid one commercial cable fee, now juggle five accounts and still miss games. Youth participation tracks closely with what kids can watch for free, and the free window keeps narrowing.\n\n## What comes next\n\nExpect re-bundling. Two of the services are already in merger talks, and the leagues have quietly started including clauses that let them sell direct to fans if the fragmentation starts cutting into viewership. The bundle will return. The only question is who owns it this time.',['Sports','Business'],[['League media rights announcement, July 2026','League communications office','official_announcement'],['Streaming price tracker, Q2 2026','Consumer Reports research desk','dataset']]],
    ['anyways','free-returns-bill-in-price','Free returns built online shopping. The bill is moving into the price tag.','Return rates above 20 percent have retailers folding the cost back into sticker prices, one category at a time. Fashion went first.','Free returns were never free. Retailers are repricing the habit, and the way they do it changes what everything costs.','## What happened\n\nThree of the five largest online fashion retailers have stopped advertising free returns this year. None of them say they are charging for returns. Instead, average prices across their core categories are up 6 to 11 percent, and the companies are telling investors why: return rates above 20 percent made the old promise unpayable.\n\n## What actually matters\n\nFree returns were the subsidy that built online fashion. Shoppers ordered three sizes and sent two back, and the cost of that habit was treated as marketing. Twenty years later the logistics run in reverse at industrial scale: roughly one in five apparel items sold online makes the trip back, at $10 to $20 per item once shipping, inspection, and write-offs are counted.\n\nFolding that cost into the sticker price is more honest than a surprise fee at checkout, but it also means careful shoppers now subsidize the bracketing habit of everyone else. The price of everything online quietly includes a returns tax.\n\n## What comes next\n\nWatch fit technology and resale. Retailers would rather solve sizing than keep paying for reverse logistics, and several are testing programs that route returned items straight to secondhand marketplaces instead of back to the shelf.',['Fashion','Business'],[['Retailer earnings call transcripts, Q1 and Q2 2026','Company investor relations','earnings_report'],['National retail returns survey, 2026','Industry logistics council','research_paper']]],
    ['anyways','game-studio-union-contracts','Game studios are about to learn what union contracts cost','Three organizing wins in one quarter turned years of talk into a line item. The first contracts will set pay floors the whole industry has to plan around.','Unionization at major game studios has moved from votes to bargaining tables. The contracts will reset budgets across the industry.','## What happened\n\nWorkers at three major studios ratified union representation this quarter, including the first wall-to-wall unit at a publisher with more than 2,000 employees. Bargaining over the first contracts begins this fall, with pay floors, credit standards, and layoff notice at the top of every list.\n\n## What actually matters\n\nThe industry’s cost model was built on two assumptions: passion would tolerate crunch, and churn would keep salaries below comparable tech work. Contracts attack both. A mandated notice period before layoffs changes how publishers greenlight projects, because studios can no longer treat headcount as a dial to spin after every launch.\n\nThe effects travel past the union shops. Non-union studios already raised pay twice to compete for senior staff who suddenly had a reason to stay put.\n\n## What comes next\n\nThe first ratified contract is the template everything else gets measured against. Expect publishers to front-load hiring freezes now, before notice periods exist, and expect the next organizing wave at the mid-size studios that supply contract work to the big ones.',['Gaming','Business'],[['National Labor Relations Board election certifications','NLRB public docket','filing'],['Union bargaining priorities statement','Communications workers union local','official_announcement']]],
    ['worth-your-time','feed-reader-2003','The best way to read the internet in 2026 is a feed reader from 2003','No algorithm, no metrics, no infinite anything. RSS never died, and the newest app in the category is the one that finally makes it pleasant.','A recommendation for a quiet piece of software that gives the web back its table of contents.','## What we found\n\nA two-person team has spent three years building a feed reader that treats RSS like what it always was: a subscription to people, not platforms. You add sites, it fetches them, and everything arrives in one chronological river that ends. There is no unread count unless you ask for one.\n\n## Why it is worth your time\n\nThe reader’s trick is restraint. Feeds are grouped into a morning edition you actually finish, which changes your relationship to the sources: you start noticing which ones you open and which ones you only subscribed to out of guilt. After a month, the list edits itself.\n\nIt costs $4 a month, syncs everywhere, and exports your subscriptions in one click, which is the feature that tells you the developers plan to deserve you rather than keep you.',['Technology','Internet Culture'],[['The reader’s documentation and export format','Project documentation site','documentation']]],
    ['worth-your-time','puzzle-game-that-ends','A puzzle game confident enough to end after four hours','It teaches you a language, lets you feel fluent, and stops before the feeling wears off. More games should have the nerve.','A short, complete puzzle game that respects the player enough to finish.','## What we found\n\nA puzzle game about rewiring a switchboard in a building that should not exist. Each room teaches one rule, each floor combines them, and the final sequence asks for everything at once. It takes about four hours, and then it is over, with no seasonal content roadmap in sight.\n\n## Why it is worth your time\n\nThe ending is the design statement. Most puzzle games pad until the mastery feeling curdles into chores. This one stops at the exact moment you feel smartest, which means you finish with the rarest sensation in games: satisfaction instead of relief.\n\nIt is $16, runs on anything, and the credits include a reading list of the architecture books the building was stolen from.',['Gaming','Design'],[['Developer postmortem and design notes','Studio development blog','article']]],
    ['worth-your-time','app-that-slows-you-down','An app that made me type slower on purpose, and why I kept it','It inserts half a second of friction before anything posts. It has saved me from myself roughly twice a day.','A tiny piece of friction software that improves everything you publish.','## What we found\n\nA keyboard utility that holds every post, reply, and comment for a configurable beat before it goes out. Half a second, with the text sitting there looking at you. You can release it early. You usually do not.\n\n## Why it is worth your time\n\nThe pause is not about regret, though it catches two regrettable sentences a day. It is about authorship. That half second is the difference between reacting and writing, and after a week you start feeling it even when the app is off, which is the actual product.\n\nFree, open source, and the settings page has exactly four options. The fourth is the length of the pause.',['Technology','Internet Culture'],[['Project repository and design rationale','Public code repository','repository']]],
    ['worth-your-time','read-the-ruling','Skip the 4,000 posts. Read the 41-page decision.','The antitrust ruling everyone is arguing about is short, clear, and nothing like its coverage. The judge writes better than most of the people quoting her.','The primary document in the biggest tech case of the year is shorter and stranger than its reputation.','## What we found\n\nThe ruling is 41 pages, double spaced, with a two-page summary up front written for the public. The judge defines every term the first time she uses it, states what the evidence cannot prove, and is funny twice, once on purpose.\n\n## Why it is worth your time\n\nThe coverage has made the decision sound like a philosophy seminar. It is actually a list: six specific business practices, the evidence for each, and the remedy for the four that held. Reading it takes forty minutes and will make you allergic to at least three things you read about it afterward.\n\nBring a pen for footnote 12, where the court explains what a market is. It is the best paragraph written about the internet this year.',['Politics','Technology'],[['United States District Court opinion, case 1:26-cv-00418','Federal court records system','court_document']]],
    ['worth-your-time','screen-time-weather','A screen time dashboard that shows the week, not the guilt','Most tracking tools scold. This one treats your attention like weather: observed, patterned, occasionally surprising.','An attention tracker designed around curiosity instead of shame.','## What we found\n\nA dashboard that charts your device use the way a forecast charts rain: no goals, no streaks, no red. Sunday evenings get a one-paragraph written summary, generated on device, that reads like a calm note from a colleague who happened to watch your week.\n\n## Why it is worth your time\n\nShame-based trackers work for nine days and then get buried in a folder. This one survived three months on our phones because it never asks for anything. The patterns it surfaces (the 10:40 pm spiral, the meeting-day dip) arrive as information, and information turns out to be the only intervention that lasts.\n\nThe written summary is the part worth the price of admission. Mine said, kindly, that I do not have a phone problem on Tuesdays. I have a meetings problem.',['Technology','Design'],[['On-device summarization methods note','Developer research blog','documentation']]],
    ['worth-your-time','newsletter-design-course','The newsletter archive that works as a correspondence course in design criticism','Eight years of close readings of everyday objects, free, and better organized than most master’s programs.','A free archive of design writing that teaches you how to see.','## What we found\n\nA weekly newsletter that has spent eight years taking one ordinary object seriously: the airport chair, the hotel key card, the soccer corner flag. Each essay is 900 words, one object, zero nostalgia padding. The archive is complete, searchable, and free.\n\n## Why it is worth your time\n\nRead in order, the archive is a syllabus. Early essays teach vocabulary, middle ones teach method, and the last two years are a writer working at full power on things like the design of queue barriers at a passport desk. You will come away unable to look at a waiting room the same way, which is the point of criticism.\n\nStart with the two-part history of the stackable plastic chair. It is the best introduction to industrial design published anywhere this decade.',['Design','Creators'],[['The newsletter archive index','Publication archive','article']]],
    ['we-read-it','chip-export-rule-214-pages','We read the 214-page chip export rule. The important part is one sentence in the middle.','Everyone covered the headline restrictions. The sentence about servicing existing equipment is the one that changes what companies actually do.','The export rule’s real mechanism is a servicing clause, not a sales ban.','## What happened\n\nThe Commerce Department’s updated export controls restrict sales of advanced chips and the tools that make them to a list of countries. The press release is 2 pages. The rule is 214.\n\n## Why it matters\n\nOn page 118, the rule extends licensing requirements to the servicing of equipment already sold: software updates, replacement parts, and in some readings, remote diagnostics. Sales bans affect future business. A servicing ban degrades everything already installed, which turns the rule from a fence into a lever that can be tightened without any new announcement.\n\n## Three key takeaways\n\n1. The compliance deadline is staggered, and the first date arrives in 60 days, not next year.\n2. Cloud access to restricted chips is treated as an export, closing the rental workaround from the last round.\n3. The rule requests public comment on servicing definitions, which means the lever’s exact size is still negotiable.',['Technology','Politics'],[['Export Administration Regulations final rule, 214 pp.','Department of Commerce','legislation'],['Federal Register public comment notice','Federal Register','official_announcement']]],
    ['we-read-it','transparency-reports-footnotes','We read four platform transparency reports. The news is in the footnotes.','The headline numbers are chosen for headlines. The methodology changes, buried on page 30 and up, are where the honest trend lines live.','Four transparency reports disclose less through their numbers than through their quiet redefinitions.','## What happened\n\nThe major platforms published their semiannual transparency reports over the past six weeks. Removal totals, government requests, and enforcement actions are all included, and all are carefully presented.\n\n## Why it matters\n\nThree of the four reports changed at least one definition this cycle. One platform now counts only content removed within 24 hours of posting in its headline removal figure. Another reclassified bulk takedowns as spam, moving them out of the policy enforcement tables entirely. The year-over-year comparisons the reports invite are, in places, comparisons between different things.\n\n## Three key takeaways\n\n1. Government request volume rose at every platform, but the share complied with fell at two.\n2. One report discloses appeal overturn rates for the first time: 31 percent of appealed removals were restored.\n3. Cross-platform trends are only comparable using the raw appendix tables, never the summary dashboards.',['Internet Culture','Technology'],[['Platform transparency reports, H1 2026','Platform policy centers','dataset'],['Appendix methodology change logs','Platform policy centers','documentation']]],
    ['we-read-it','league-labor-deal','We read the league’s new labor deal so you don’t have to','Six hundred pages, one genuine surprise: the players traded a higher cap for something owners have never given up before.','The new collective bargaining agreement trades money for control over scheduling and data.','## What happened\n\nPlayers ratified a new collective bargaining agreement by a 78 percent vote. The deal runs ten years, raises the salary cap modestly, and is otherwise being described as status quo. It is not.\n\n## Why it matters\n\nFor the first time, the union accepted a smaller cap increase than it could have won in exchange for two non-economic concessions: a hard limit on games per week, and joint ownership of the tracking data collected from players’ uniforms. The second concession is the historic one. Player data is the raw material of both the gambling partnerships and the next generation of broadcast products, and the league just admitted it does not own it outright.\n\n## Three key takeaways\n\n1. The games-per-week limit effectively kills the proposed schedule expansion.\n2. Data licensing revenue splits 50-50, creating a new player income stream that scales with the gambling business.\n3. The ten-year term with an opt-out at year six means both sides bet on the media rights market moving in their favor.',['Sports','Business'],[['Collective bargaining agreement, full text','League players association','legislation'],['Ratification vote announcement','Players association','official_announcement']]],
    ['receipts','never-ads-now-ads-team','“We will never run ads.” The company now has an ads team of 40.','The promise was on the homepage for three years. The job listings went up in March. Here is the record, in order.','A three-year record of a promise, from homepage banner to job board, kept in one place.','## What was said\n\nThe company launched with a pledge on its homepage: “We will never run ads.” The founder repeated it in interviews, calling advertising a tax on users, and the pledge survived three redesigns and a funding announcement that credited it as the reason users trusted the product.\n\n## What actually happened\n\nIn March, the company posted its first listing for an ads engineering manager. By June, public profiles showed 40 employees in a monetization group, and the pledge had been edited to “ads, done right, when the time is right.” The change was not announced. It was noticed by a user comparing archived versions of the about page.\n\n## Why it matters now\n\nNobody is entitled to a company’s business model staying frozen. They are entitled to honesty about the change, especially from a company that raised money and users on the strength of the promise. The record above is kept so the next version of the pledge can be read alongside the first.',['Technology','Business'],[['Archived homepage versions, 2023 to 2026','Public web archive','dataset'],['Company job listings, March through June 2026','Company careers page','official_announcement']]],
    ['receipts','weeks-away-19-months','The feature that was “weeks away” for 19 months','Seven public statements, four launch events, and one quiet support page edit. A timeline of a promise wearing out.','A complete public timeline of one promised feature, from announcement to quiet removal.','## What was said\n\nThe flagship update was announced on stage as “weeks away.” The studio repeated the phrase in January, March, and again at a summer showcase, each time with new footage. Preorders doubled after the third showing.\n\n## What actually happened\n\nNineteen months passed. The feature appeared in two more showcases, then in a delayed-statement, then not at all. Last month, a support page quietly changed its status from “in active development” to “under evaluation,” and the preorder bonus tied to it was replaced with a cosmetic pack.\n\n## Why it matters now\n\nGame development slips, and players forgive delay when they are told the truth. The record here is not about lateness. It is about nineteen months of certainty expressed in public while the internal status was, by the studio’s own eventual admission, undecided. The difference between those two things is what a roadmap is for.',['Gaming','Technology'],[['Showcase transcripts and stage demos, 2024 to 2026','Publisher event archive','video'],['Support page revision history','Publisher support site','documentation']]],
    ['receipts','retracted-study-headlines','The study behind 400 headlines was retracted in April. The headlines keep coming.','Retractions do not travel as far as the original finding. We counted how far this one didn’t travel.','A retracted screen-time study keeps circulating. This is the count of who corrected and who did not.','## What was said\n\nA 2023 study linking two hours of daily screen time to attention problems in teenagers produced more than 400 news stories, a bestselling parenting book chapter, and at least two school district policies.\n\n## What actually happened\n\nThe journal retracted the paper in April after the authors could not produce the underlying data. We checked the 400 stories five weeks later. Sixty one had been updated or corrected. Roughly 340 still present the finding, including most of the top search results, and the policies built on it remain in force.\n\n## Why it matters now\n\nRetraction is the immune system of science, but it has no distribution channel. The finding traveled by headline; the correction travels by footnote, page 14, and nobody’s push alert. Keeping this count public is the point of the exercise: the record should be as easy to find as the mistake.',['Internet Culture','Politics'],[['Journal retraction notice, April 2026','Journal editorial office','official_announcement'],['Anyways audit of 400 citing articles, June 2026','Anyways research desk','dataset']]],
    ['meanwhile','station-cat-reelected','A town in Japan has elected the same station cat for 14 years','The position is unpaid, the approval rating is 96 percent, and the incumbent has never attended a meeting. Democracy is complicated.','A station cat’s fourteenth year in honorary office, and the town that takes the ritual seriously.','## What happened\n\nThe railway town held its annual stationmaster election last weekend, and the incumbent, a calico named Yontama, won her fourteenth consecutive term. She ran unopposed, which the station notes is a first, and celebrated by sleeping through the announcement in the ticket window.\n\n## Why this is interesting\n\nThe ritual started as a rescue: the line was near bankruptcy in 2007, and the first cat stationmaster was a stray adopted by staff. Visitors came for the cat and stayed for the town, which has since balanced its books on cat-adjacent tourism.\n\nFourteen years in, the election is less a gimmick than a piece of civic plumbing: a fixed date when the whole town shows up to the station for something that is not a crisis. The cat’s actual duties, per the railway, are “being present.” Attendance record: flawless.',['Internet Culture','Design'],[['Railway company election announcement','Wakayama Electric Railway','official_announcement']]],
    ['meanwhile','internet-speedrunning-dictionary','The internet is speedrunning the dictionary','Lexicographers say a word used to take a decade to fossilize into print. The newest entry took 19 months, and the runners are not slowing down.','Dictionary adoption is accelerating, and the people who track it are enjoying themselves.','## What happened\n\nA major dictionary added its quarterly batch of new words this month, and the youngest of them went from first recorded use to official entry in 19 months. The previous record holder took four years. The batch before that needed a decade.\n\n## Why this is interesting\n\nThe acceleration is not sloppiness. Lexicographers track a word’s spread across communities and contexts before it qualifies, and the internet now runs that gauntlet in months: a coinage jumps from niche forum to sports commentary to a senator’s floor speech before the ink on the nomination dries.\n\nThe dictionary’s editors, to their credit, are having fun. The usage note for one new entry reads, in full: “Yes, we have seen the video.”',['Internet Culture','Creators'],[['Dictionary new words announcement and editor notes','Dictionary editorial blog','official_announcement']]],
    ['meanwhile','chicago-bench-reviews','Someone is reviewing every public bench in Chicago','Eleven hundred benches so far. Criteria include shade, armrest hostility, and proximity to a good slice. The city has started replying.','A one-person bench review project has become the city’s most useful public furniture audit.','## What happened\n\nA Chicagoan has reviewed 1,100 public benches on a simple site, scoring each on comfort, shade, view, and what the reviews call armrest hostility, a measure of whether a bench permits lying down. Each entry includes a photo and a one-paragraph verdict with the confidence of a restaurant critic.\n\n## Why this is interesting\n\nThe project accidentally built the audit the city never commissioned. The bench map has started appearing in neighborhood council meetings, and the transportation department replied to one review, of a bus stop bench scored 2 out of 10, with a work order number.\n\nThe reviewer’s philosophy, stated once, is the whole case for public furniture: “A bench is the smallest possible park. Rate it like one.”',['Internet Culture','Design'],[['The bench review project index','Independent review site','dataset']]],
    ['meanwhile','olympic-pigeon-photographer','The mystery Olympic pigeon photographer has been identified','For two weeks, the best photos of the Games were of pigeons. The internet found the person responsible, and his explanation is better than the photos.','The Games’ most beloved photographer shoots only pigeons, on purpose, for a reason that holds up.','## What happened\n\nAmong the 40,000 credentialed cameras at the Games, one kept producing pictures of pigeons: pigeons on the diving platform, pigeons inspecting a javelin, a pigeon asleep in the shot put circle minutes before the final. The images spread without attribution until a venue steward identified the photographer, a retired Lithuanian sports shooter named Vitas.\n\n## Why this is interesting\n\nVitas covered nine Olympics for wire services. He retired, bought his own ticket to a tenth, and realized he had never once looked at the venue. “Forty years of athletes,” he told a local paper. “The pigeons were there for all of it. Nobody made them a portrait.”\n\nHe shoots film, waits hours per frame, and has declined every interview request except the local paper, because, he said, they asked about the pigeons.',['Sports','Internet Culture'],[['Local newspaper interview with the photographer','Regional daily','article']]],
    ['research','limited-time-offers-90-days','We tracked 90 days of “limited time offers.” Three of them ever ended.','Forty one brands, 212 offers, one calendar. Scarcity is mostly a formatting choice.','An Anyways original study of urgency marketing, with method and data.','## Summary\n\nWe logged every “limited time” offer from 41 major online retailers for 90 days and checked what happened when the deadline arrived. Of 212 offers, 209 were extended, restarted, or replaced by an identical offer within 72 hours. Three ended.\n\n## Methodology\n\nOffers were collected daily from homepage banners and promotional emails between April and June. An offer counted as ended only if the product returned to list price for at least one week. Full data and the classification rules are published with this story.\n\n## Findings\n\nThe median “limited” offer lasted 11 days before renewal, regardless of the countdown shown. Countdown timers were reset, on average, six times per offer. The three genuinely limited offers were all clearance events, which suggests real scarcity in online retail now means the warehouse is actually empty.\n\n## Analysis\n\nPerpetual urgency is not a bug in the system. It is the system’s load-bearing claim, and it works precisely because checking it costs more effort than believing it. The cost of checking, we hope, just went down.',['Business','Internet Culture'],[['Anyways offer-tracking dataset, April to June 2026','Anyways research desk','dataset'],['Consumer protection guidance on urgency claims','Federal Trade Commission','documentation']]],
    ['research','trending-sound-lifespan','How long does a trending sound actually last? We measured 1,200 of them.','The median trend is dead before most people hear it. The tail is longer than anyone thinks.','An Anyways measurement of trend lifespans across 1,200 viral sounds.','## Summary\n\nWe tracked 1,200 trending audio clips from first spike to disappearance. The median sound peaked on day 4 and fell below noise by day 19. But 12 percent never fully died, resurfacing in waves for more than a year.\n\n## Methodology\n\nA sound was counted as trending when daily uses crossed 10,000, and dead when uses fell below 2 percent of its peak for 30 consecutive days. Resurgences were tracked separately. Platform charts were not used, since they rank momentum, not life.\n\n## Findings\n\nTrend death is bimodal: sounds either burn out inside three weeks or settle into a long half-life as background vocabulary. The long-tail sounds share one trait: they work as reactions, not songs, so they attach to new content instead of expiring with old content.\n\n## Limitations\n\nWe measured use, not feeling. A sound can be ubiquitous and culturally dead, and no dataset will ever catch the exact moment a trend becomes embarrassing. That moment remains one of the last truly analog phenomena.',['Creators','Internet Culture'],[['Anyways trend-tracking dataset, 2025 to 2026','Anyways research desk','dataset'],['Platform creator analytics documentation','Platform developer portal','documentation']]]
  ];
  let n=0;
  for(const [section,slug,title,dek,summary,body,topicNames,sourceList] of specs){
    n++;
    const articleBody=seededArticleBody(body,slug);
    const story={
      id:id(),title,slug,dek,summary,body:articleBody,
      section_id:section,author_id:users[(n%2)+2].id,editor_id:users[1].id,
      status:'published',published_at:new Date(Date.now()-n*86400000).toISOString(),scheduled_for:null,updated_at:now,created_at:now,
      reading_time_minutes:Math.max(1,Math.ceil(articleBody.split(/\s+/).length/220)),
      hero_media_id:null,seo_title:title,seo_description:dek,social_title:title,social_description:dek,
      featured:n<5,homepage_priority:n,canonical_url:null,revision_number:1,
      topic_ids:topicNames.map(t),related_ids:[]
    };
    db.stories.push(story);
    sourceList.forEach(([st,sp,stype],i)=>db.sources.push({id:id(),story_id:story.id,title:st,publisher:sp,url:`https://example.com/source-${n}${i?`-${i+1}`:''}`,normalized_url:`https://example.com/source-${n}${i?`-${i+1}`:''}`,source_type:stype,author:'',published_at:null,accessed_at:now,archive_url:'',note:'',sort_order:i+1,created_at:now,created_by:users[1].id}));
  }
  db.stories.forEach((s,i)=>s.related_ids=[db.stories[(i+1)%db.stories.length].id,db.stories[(i+2)%db.stories.length].id]);
  /* A living desk: one submission in review, one draft in progress, one scheduled for tomorrow. */
  const bySlug=s=>db.stories.find(x=>x.slug===s);
  Object.assign(bySlug('newsletter-design-course'),{status:'review',published_at:null});
  Object.assign(bySlug('app-that-slows-you-down'),{status:'draft',published_at:null});
  Object.assign(bySlug('olympic-pigeon-photographer'),{status:'scheduled',published_at:null,scheduled_for:new Date(Date.now()+86400000).toISOString()});
  db.homepage.primary=db.stories[0].id;
  save(db);
  return db;
}

function userFor(req,db){const token=(req.headers.cookie||'').match(/session=([^;]+)/)?.[1];return token&&sessions.get(token)?db.users.find(u=>u.id===sessions.get(token)):null;}
function can(user,action,story){if(!user)return false;if(user.role==='admin')return true;if(user.role==='editor')return action!=='users'; if(user.role==='contributor'){if(['create','media'].includes(action))return true;return action==='edit'&&story?.author_id===user.id&&['idea','researching','draft','review'].includes(story.status);}return false;}
const published=s=>s.status==='published'&&s.published_at&&new Date(s.published_at)<=new Date();

/* ---------- Markdown (groups consecutive list items, same syntax as before) ---------- */
function inline(s){return s.replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>').replace(/\*(.*?)\*/g,'<em>$1</em>');}
function md(text){
  const lines=esc(text).split('\n');let html='',list=null;
  const close=()=>{if(list){html+=`</${list}>`;list=null;}};
  for(const line of lines){
    if(line.startsWith('### ')){close();html+=`<h3>${inline(line.slice(4))}</h3>`;}
    else if(line.startsWith('## ')){close();html+=`<h2>${inline(line.slice(3))}</h2>`;}
    else if(line.startsWith('> ')){close();html+=`<blockquote>${inline(line.slice(2))}</blockquote>`;}
    else if(/^\d+\. /.test(line)){if(list!=='ol'){close();html+='<ol>';list='ol';}html+=`<li>${inline(line.replace(/^\d+\. /,''))}</li>`;}
    else if(line.startsWith('- ')){if(list!=='ul'){close();html+='<ul>';list='ul';}html+=`<li>${inline(line.slice(2))}</li>`;}
    else if(line==='---'){close();html+='<hr>';}
    else if(line){close();html+=`<p>${inline(line)}</p>`;}
    else close();
  }
  close();return html;
}

/* ---------- Editorial furniture: numerals, dates, shared components ---------- */
const dLong=d=>new Date(d).toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'});
const dShort=d=>new Date(d).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
function numerals(db){const map=new Map();db.stories.filter(published).sort((a,b)=>new Date(a.published_at)-new Date(b.published_at)).forEach((s,i)=>map.set(s.id,i+1));return map;}
const no=n=>n?`№ ${String(n).padStart(3,'0')}`:'';
const authorOf=(db,s)=>db.users.find(u=>u.id===s.author_id);
const editorOf=(db,s)=>db.users.find(u=>u.id===s.editor_id);
const sectionOf=(db,s)=>db.sections.find(x=>x.id===s.section_id);

/* ---------- The composed edition: palette, plates, marginalia ----------
   Presentation only. Every published story carries one of twelve risograph
   accents; plates are placement photography chosen at random so pages can
   be inspected with images in place. Data and workflow are untouched. */

const PALETTE=['cyan','mustard','yellow','magenta','brick','peach','lime','cobalt','mint','coral','violet','tangerine'];
function hash(s){let h=2166136261;for(const c of String(s)){h^=c.charCodeAt(0);h=Math.imul(h,16777619);}return h>>>0;}
/* One accent per story, in display order: never the previous color twice,
   and out of the previous three whenever the palette allows it. */
function accents(xs){
  const map=new Map(),recent=[];
  for(const s of xs){
    let i=hash(s.id||s.slug)%PALETTE.length,c=PALETTE[i],guard=0;
    while(recent.includes(c)&&guard++<PALETTE.length*2){i=(i+1)%PALETTE.length;c=PALETTE[i];}
    if(c===recent[recent.length-1]){i=(i+1)%PALETTE.length;c=PALETTE[i];}
    map.set(s.id,c);recent.push(c);if(recent.length>3)recent.shift();
  }
  return map;
}

/* The photo desk: chosen at random, repeated freely, never curated. */
const PHOTOS=['p01.jpg','p02.jpg','p03.jpg','p04.jpg','p05.jpg','p06.jpg','p07.jpg','p08.jpg','p09.jpg','p10.jpg','p11.jpg','p12.jpg','p13.jpg','p14.jpg','p15.jpg','p16.jpg','p17.jpg','p18.jpg','p19.jpg','p20.jpg','p21.jpg','p22.jpg','p23.jpg','p24.jpg','p25.jpg','p26.jpg','p27.jpg','p28.jpg','p29.jpg','p30.jpg','p31.jpg','p32.jpg','p33.jpg','p34.jpg','p35.jpg','p36.jpg','p37.jpg','p38.png','p39.png','p40.png','p41.jpg'];
const photo=()=>`/photos/${PHOTOS[Math.floor(Math.random()*PHOTOS.length)]}`;
const plateNo=src=>src.split('/').pop().split('.')[0].toUpperCase();

/* A plate: an image with a desk caption. Treatments are the reusable set
   from the stylesheet: frame, arch, circle, fade, duo, letterbox, float. */
function plate(treat='',caption='The desk archive'){
  const src=photo();
  return `<figure class="plate ${treat}"><img src="${src}" alt="" loading="lazy"><figcaption><span>${caption}</span><span>${plateNo(src)}</span></figcaption></figure>`;
}

/* The interruption: one per story, guaranteed. The brief, set solid. */
function interruption(s,n){
  return `<section class="interruption"><span class="label">The brief</span><p class="interruption-text">${esc(s.summary||s.dek)}</p><span class="numeral">${no(n)}</span></section>`;
}

/* Margin notes: persistent annotation, composed from the story's own record. */
function marginNotes(db,s,nums){
  const notes=[];
  const ts=s.topic_ids.map(i=>db.topics.find(t=>t.id===i)).filter(Boolean);
  if(ts.length)notes.push(`<aside class="mn"><span class="mn-label">Filed under</span><p>${ts.map(t=>`<a href="/topics/${t.slug}">${esc(t.name)}</a>`).join(' / ')}</p></aside>`);
  const ss=db.sources.filter(x=>x.story_id===s.id);
  if(ss.length)notes.push(`<aside class="mn"><span class="mn-label">The record</span><p>${ss.length} source${ss.length===1?'':'s'} on file, beginning with ${esc(ss[0].publisher||ss[0].title)}. The full list follows the story.</p></aside>`);
  const arc=db.stories.filter(x=>published(x)&&x.id!==s.id);
  if(arc.length){const pick=arc[Math.floor(Math.random()*arc.length)];notes.push(`<aside class="mn"><span class="mn-label">From the archive</span><p><span class="mn-no">${no(nums.get(pick.id))}</span> · <a href="/stories/${pick.slug}">${esc(pick.title)}</a></p></aside>`);}
  return notes;
}

/* Body composition. The text carries the page; the composition interrupts
   it: plates between paragraphs, notes in the margin, one solid band. */
function composeBody(db,s,html,nums){
  const blocks=html.split(/(?=<h2|<h3|<p>|<blockquote>|<ul>|<ol>|<hr>)/).filter(Boolean);
  const out=[];let paras=0,plates=0;
  const treats=['plate--float','plate--left plate--frame','plate--float plate--arch','plate--left'];
  const notes=marginNotes(db,s,nums),breakAt=Math.max(2,Math.round(blocks.length*0.45));
  for(let i=0;i<blocks.length;i++){
    out.push(blocks[i]);
    if(i===1&&notes[0])out.push(notes[0]);
    if(blocks[i].startsWith('<p>'))paras++;
    if(paras>0&&paras%3===0&&plates<3){out.push(plate(treats[plates%treats.length]));plates++;}
    if(i===breakAt)out.push(interruption(s,nums.get(s.id)));
    if(i===Math.min(blocks.length-2,breakAt+2)&&notes[1])out.push(notes[1]);
  }
  if(notes[2])out.push(notes[2]);
  return out.join('');
}

const FAVICON=`data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' fill='%23f6f2e8'/%3E%3Ctext x='32' y='44' font-family='Georgia' font-size='38' text-anchor='middle' fill='%23b23a1d'%3E%E2%80%A6%3C/text%3E%3C/svg%3E`;
const FONTS=`<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:ital,wght@0,400;0,500;1,400&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400;1,6..72,500&display=swap" rel="stylesheet">`;

function nameplate(db,current){
  const count=db.stories.filter(published).length;
  const links=db.sections.map(s=>`<a href="/sections/${s.slug}" ${current===s.slug?'aria-current="page"':''}>${esc(s.name)}</a>`).join('');
  return `<header class="nameplate page">
  <div class="dateline micro"><span>${dLong(new Date())}</span><span>${count} stories on file · Cover only what matters</span></div>
  <div class="wordmark-row">
    <a class="wordmark brand-lockup brand-lockup--header" href="/" aria-label="Anyways home"><img src="/brand/anyways-logo.png" alt="" width="1536" height="1024" fetchpriority="high" decoding="async"></a>
    <p class="promise">For curious people who want to understand what is shaping culture before everyone else catches up.</p>
  </div>
  <nav class="index-nav" aria-label="Sections">
    ${links}
    <span class="desk-links">
      <a href="/topics" ${current==='topics'?'aria-current="page"':''}>Topics</a>
      <a href="/search" ${current==='search'?'aria-current="page"':''}>Search</a>
      <a href="/newsroom" ${current==='newsroom'?'aria-current="page"':''}>Newsroom</a>
    </span>
  </nav>
</header>`;
}

function colophon(db){
  const sectionLinks=db.sections.map(s=>`<li><a href="/sections/${s.slug}">${esc(s.name)}</a></li>`).join('');
  return `<footer class="colophon page">
  <a class="footer-brand brand-lockup" href="/" aria-label="Anyways home"><img src="/brand/anyways-logo.png" alt="" width="1536" height="1024" loading="lazy" decoding="async"></a>
  <div class="colophon-grid">
    <div><p class="mission">Cover only what matters, explain why it matters, and respect the reader’s time.</p></div>
    <div><h4>Sections</h4><ul>${sectionLinks}</ul></div>
    <div><h4>The desk</h4><ul><li><a href="/topics">Topics</a></li><li><a href="/search">Search the archive</a></li><li><a href="/rss.xml">RSS</a></li><li><a href="/newsroom">Newsroom</a></li></ul></div>
  </div>
  <div class="set-line meta-line"><span>Set in Newsreader and IBM Plex Mono. Sources are part of every story.</span><span>© ${new Date().getFullYear()} Anyways. Reading time is respected here.</span></div>
</footer>`;
}

function layout(title,body,user,opts={}){
  const db=opts.db||{sections,stories:[]};
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} | Anyways</title><meta name="description" content="${esc(opts.desc||'Anyways is an editorial publication for curious people who want to understand what is shaping culture before everyone else catches up.')}">${FONTS}<link rel="preload" as="image" href="/brand/anyways-logo.png" fetchpriority="high"><link rel="stylesheet" href="/assets/design.css"><link rel="icon" href="${FAVICON}"></head><body class="${opts.pageClass||''}">${nameplate(db,opts.current)}<main class="page">${body}</main>${colophon(db)}</body></html>`;
}

/* A story reference: numeral, kicker, headline, dek, byline, hairline. Never a card.
   opts.acc sets the story's accent scope; opts.thumb ('split'|'offset'|'media')
   adds a plate whose size sets the entry's editorial weight. */
function entry(db,s,nums,opts={}){
  const a=authorOf(db,s),sec=sectionOf(db,s),n=nums.get(s.id);
  const href=opts.href||`/stories/${s.slug}`;
  const stamp=opts.status?`<span class="stamp st-${s.status}">${esc(s.status.replace('_',' '))}</span>`:'';
  const date=s.published_at&&published(s)?dShort(s.published_at):(opts.status?'':esc(s.status));
  const variant=opts.thumb?` entry--${opts.thumb}`:'';
  const scope=opts.acc?` a-${opts.acc}`:'';
  const thumb=opts.thumb?`<a class="entry-thumb${opts.treat?` ${opts.treat}`:''}" href="${href}" tabindex="-1" aria-hidden="true"><img src="${photo()}" alt="" loading="lazy"></a>`:'';
  return `<article class="entry${variant}${scope}">
  <span class="numeral">${no(n)}</span>
  <div class="entry-body">
    <h3><a href="${href}">${esc(s.title)}</a></h3>
    <p class="dek">${esc(s.dek)}</p>
    <div class="meta-line">
      ${stamp}
      <span class="section-tag"><a href="/sections/${sec?.slug}">${esc(sec?.name||'')}</a></span>
      <span>By ${esc(a?.name||'Unknown')}</span>
      <span>${date}</span>
      <span>${s.reading_time_minutes} min</span>
    </div>
  </div>
  ${thumb}
</article>`;
}

/* Table of contents line with dot leaders. */
function tocLine(s,nums){
  return `<li><div class="toc-line"><span class="t"><a href="/stories/${s.slug}">${esc(s.title)}</a></span><span class="dots" aria-hidden="true"></span><span class="numeral">${s.published_at?dShort(s.published_at):''}</span></div></li>`;
}

const emptyNote=t=>`<p class="empty-note">${t}</p>`;

/* ---------- Newsroom form helpers (field names are part of the backend contract) ---------- */
function topicChecks(db, selected=[]){return `<div class="topic-checks">${db.topics.map(t=>`<label><input type="checkbox" name="topic" value="${t.id}" ${selected.includes(t.id)?'checked':''}> ${esc(t.name)}</label>`).join('')}</div>`;}
const sourceTypes=['article','official_announcement','filing','research_paper','court_document','legislation','earnings_report','documentation','video','podcast','social_post','dataset','repository','other'];
function workflowActions(user,story,newStory){
  if(newStory)return '<button form="story-form" type="submit">Create draft</button>';
  const status=story.status;
  if(user.role==='contributor')return '<button class="quiet" form="story-form" type="submit" name="status" value="draft">Save draft</button><button form="story-form" type="submit" name="status" value="review">Submit for review</button>';
  const actions={idea:[['draft','Save draft'],['review','Submit for review']],researching:[['draft','Save draft'],['review','Submit for review']],draft:[['draft','Save draft'],['review','Submit for review']],review:[['draft','Return to draft'],['fact_check','Send to fact check']],fact_check:[['scheduled','Schedule'],['published','Publish']],scheduled:[['scheduled','Save schedule'],['published','Publish now']],published:[['published','Save changes']],archived:[['draft','Restore draft']]};
  const choices=actions[status]||[[status,'Save changes']];
  return choices.map(([value,label],index)=>`<button ${index===choices.length-1?'':'class="quiet" '}form="story-form" type="submit" name="status" value="${value}">${label}</button>`).join('');
}
function sourceOptions(){return sourceTypes.map(x=>`<option>${x}</option>`).join('');}
function markdownPreview(body){return `<details class="preview"><summary>Preview markdown</summary><div id="markdown-preview" class="markdown-preview">${md(body||'')}</div></details>`;}

function editorForm(db,user,s={},notice=''){
  const newStory=!s.id;
  const sources=db.sources.filter(x=>x.story_id===s.id).sort((a,b)=>a.sort_order-b.sort_order);
  const body=s.body||templates[s.section_id||'anyways'];
  const sourceSection=newStory?`<section class="editor-section"><h2>Sources</h2><p class="muted">Add a primary source now so this draft is ready for review.</p><label>Source title</label><input name="source_title" required><label>Publisher</label><input name="source_publisher"><label>Source URL</label><input name="source_url" type="url" placeholder="https://" required><label>Source type</label><select name="source_type">${sourceOptions()}</select></section>`:'';
  const sourceList=sources.map((x,index)=>`<article class="source-row"><div class="src-title"><a target="_blank" href="${esc(x.url)}">${esc(x.title)}</a><div class="meta-line">${esc(x.publisher||'')} · ${esc(x.source_type)}</div></div><div class="src-actions"><form method="post" action="/newsroom/stories/${s.id}/sources/${x.id}/move"><button class="quiet" name="direction" value="up" ${index===0?'disabled':''}>Up</button><button class="quiet" name="direction" value="down" ${index===sources.length-1?'disabled':''}>Down</button></form><form method="post" action="/newsroom/stories/${s.id}/sources/${x.id}/delete"><button class="danger-quiet">Remove</button></form></div></article>`).join('')||'<p class="muted">No sources yet.</p>';
  const existingSources=!newStory?`<section class="editor-section"><h2>Sources</h2><p class="muted">Sources are required for publishing. Their order here is their order on the story.</p>${sourceList}<form method="post" action="/newsroom/stories/${s.id}/sources" class="add-source"><h3>Add source</h3><label>Title</label><input name="title" required><label>Publisher</label><input name="publisher"><label>URL</label><input name="url" type="url" placeholder="https://" required><label>Type</label><select name="source_type">${sourceOptions()}</select><div style="margin-top:1rem"><button>Add source</button></div></form></section>`:'';
  return `<div class="page-head"><div class="kicker"><span>The desk</span><span class="sep">·</span><span>${newStory?'New story':`Editing · ${esc(s.slug)}`}</span></div><h1>${newStory?'New story':'Edit story'}</h1></div>
${notice?`<p class="notice">${esc(notice)}</p>`:''}
<form id="story-form" class="desk-form" method="post" action="${newStory?'/newsroom/stories':'/newsroom/stories/'+s.id}">
<div class="editor-grid">
  <div>
    <section class="editor-section">
      <h2>Story</h2>
      <label>Title</label><input name="title" required value="${esc(s.title)}">
      <label>Dek</label><textarea name="dek" required style="min-height:70px">${esc(s.dek)}</textarea>
      <label>Summary</label><textarea name="summary" style="min-height:70px">${esc(s.summary)}</textarea>
      <label>Primary section</label><select name="section_id">${db.sections.map(x=>`<option value="${x.id}" ${s.section_id===x.id?'selected':''}>${esc(x.name)}</option>`).join('')}</select>
      <label>Topics</label>${topicChecks(db,s.topic_ids||[])}
      <label>Body (Markdown)</label><textarea id="story-body" name="body" required>${esc(body)}</textarea>${markdownPreview(body)}
    </section>
    ${sourceSection}
  </div>
  <div>
    <section class="editor-section">
      <h2>Editorial</h2>
      ${user.role==='contributor'?`<p class="meta-line">Author: ${esc(user.name)}</p><input type="hidden" name="author_id" value="${esc(user.id)}">`:`<label>Author</label><select name="author_id">${db.users.filter(u=>u.role!=='admin').map(u=>`<option value="${u.id}" ${(s.author_id||user.id)===u.id?'selected':''}>${esc(u.name)}</option>`).join('')}</select>`}
      <label>Responsible editor</label>
      <select name="editor_id" required><option value="">Choose an editor</option>${db.users.filter(u=>['editor','admin'].includes(u.role)).map(u=>`<option value="${u.id}" ${(s.editor_id||'')===u.id?'selected':''}>${esc(u.name)}</option>`).join('')}</select>
      <p class="meta-line" style="margin-top:1.3rem">Current status: <span class="stamp st-${s.status||'idea'}">${esc((s.status||'idea').replace('_',' '))}</span></p>
      <label>Scheduled time</label><input type="datetime-local" name="scheduled_for" value="${s.scheduled_for?new Date(s.scheduled_for).toISOString().slice(0,16):''}">
      <label>Change note</label><input name="change_note" placeholder="What changed?">
    </section>
    <details class="editor-section">
      <summary>Publishing</summary>
      <div class="secondary-fields">
        <label>Slug (stable URL)</label><input name="slug" value="${esc(s.slug)}" placeholder="Generated from title if left blank">
        <label>SEO title</label><input name="seo_title" value="${esc(s.seo_title||s.title||'')}" placeholder="Defaults to title">
        <label>SEO description</label><textarea name="seo_description" style="min-height:60px" placeholder="Defaults to dek">${esc(s.seo_description||s.dek||'')}</textarea>
        <label class="check-line" style="text-transform:none;letter-spacing:0.02em;font-size:0.8rem"><input type="checkbox" name="featured" ${s.featured?'checked':''}> Feature on homepage</label>
        <label>Homepage priority</label><input type="number" name="homepage_priority" value="${s.homepage_priority||0}">
      </div>
    </details>
  </div>
</div>
</form>
${existingSources}
${!newStory?`<section class="editor-section"><h2>History</h2>${db.revisions.filter(r=>r.story_id===s.id).sort((a,b)=>b.revision_number-a.revision_number).map(r=>`<div class="revision-line"><span class="rev-no">Rev ${String(r.revision_number).padStart(2,'0')}</span><span>${new Date(r.created_at).toLocaleString()}</span><span>${esc(r.change_note||'Saved')}</span></div>`).join('')||'<p class="muted">No revisions yet.</p>'}</section>`:''}
<div class="action-bar">
  <span class="meta-line">${newStory?'Create a draft first, then use the workflow actions on the saved story.':`Status: ${esc(s.status)}. Every save keeps a revision.`}</span>
  <div class="buttons">${workflowActions(user,s,newStory)}</div>
</div>
<script>(()=>{const input=document.getElementById('story-body'),preview=document.getElementById('markdown-preview');if(!input||!preview)return;const escape=value=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[char]));const render=value=>{preview.innerHTML=value.split('\\n').map(line=>line.startsWith('### ')?'<'+'h3>'+escape(line.slice(4))+'</h3>':line.startsWith('## ')?'<h2>'+escape(line.slice(3))+'</h2>':line?'<p>'+escape(line)+'</p>':'').join('');};input.addEventListener('input',()=>render(input.value));})();</script>`;
}

function runScheduler(db){let changed=0;for(const s of db.stories)if(s.status==='scheduled'&&s.scheduled_for&&new Date(s.scheduled_for)<=new Date()&&!storyValid(db,s).length){s.status='published';s.published_at=s.published_at||new Date().toISOString();s.updated_at=new Date().toISOString();changed++;}if(changed)save(db);return changed;}

/* ---------- Request plumbing (unchanged behavior) ---------- */
function getBody(req){return new Promise(resolve=>{let s='';req.on('data',d=>s+=d);req.on('end',()=>resolve(Object.fromEntries(new URLSearchParams(s))));});}
function getMultipart(req){return new Promise(resolve=>{const chunks=[];req.on('data',d=>chunks.push(d));req.on('end',()=>{const raw=Buffer.concat(chunks),boundary=(req.headers['content-type']||'').match(/boundary=(.+)$/)?.[1];if(!boundary)return resolve({});const fields={},parts=raw.toString('binary').split(`--${boundary}`);for(const part of parts){const cut=part.indexOf('\r\n\r\n');if(cut<0)continue;const head=part.slice(0,cut),content=part.slice(cut+4,-2),name=head.match(/name="([^"]+)"/)?.[1],filename=head.match(/filename="([^"]*)"/)?.[1];if(!name)continue;if(filename){fields.file={filename:path.basename(filename),type:head.match(/Content-Type: ([^\r]+)/)?.[1]||'',data:Buffer.from(content,'binary')};}else fields[name]=Buffer.from(content,'binary').toString('utf8');}resolve(fields);});});}
function redirect(res,to){res.writeHead(302,{Location:to});res.end();}
function storyValid(db,s){let errors=[];for(const f of ['title','slug','dek','body','section_id','author_id','editor_id','seo_title','seo_description'])if(!s[f])errors.push(f);if(!s.topic_ids?.length)errors.push('at least one topic');if(!db.sources.some(x=>x.story_id===s.id&&validUrl(x.url)))errors.push('at least one valid source');return errors;}
function validUrl(s){try{return ['http:','https:'].includes(new URL(s).protocol)}catch{return false}}
function transitionAllowed(user,story,next){const order=['idea','researching','draft','review','fact_check','scheduled','published','archived']; if(!order.includes(next))return false;if(user.role==='contributor')return story.author_id===user.id&&['idea','researching','draft','review'].includes(next);return user.role==='editor'||user.role==='admin';}
function list(db,{section,topic,q,author,page=1}={}){let xs=db.stories.filter(published);if(section)xs=xs.filter(s=>s.section_id===section);if(topic)xs=xs.filter(s=>s.topic_ids.includes(topic));if(author)xs=xs.filter(s=>s.author_id===author);if(q){const needle=q.toLowerCase();xs=xs.filter(s=>[s.title,s.dek,s.summary,s.body,db.sections.find(x=>x.id===s.section_id)?.name,db.users.find(u=>u.id===s.author_id)?.name,...s.topic_ids.map(i=>db.topics.find(t=>t.id===i)?.name)].join(' ').toLowerCase().includes(needle));}return xs.sort((a,b)=>new Date(b.published_at)-new Date(a.published_at));}

/* Newsroom sub-navigation, same desk, every page. */
function deskNav(user,current=''){
  const links=[['Overview','/newsroom','overview'],['Stories','/newsroom/stories','stories']];
  if(['editor','admin'].includes(user.role))links.push(['Review','/newsroom/review','review'],['Scheduled','/newsroom/scheduled','scheduled'],['Published','/newsroom/published','published'],['Homepage','/newsroom/homepage','homepage'],['Topics','/newsroom/topics','topics']);
  links.push(['Media','/newsroom/media','media']);
  if(user.role==='admin')links.push(['Contributors','/newsroom/contributors','contributors']);
  const nav=links.map(([label,href,key])=>`<a href="${href}" ${current===key?'aria-current="page" style="color:var(--red)"':''}>${label}</a>`).join('');
  const create=can(user,'create')?`<a href="/newsroom/stories/new" style="color:var(--green)">New story →</a>`:'';
  return `<nav class="desk-nav" aria-label="Newsroom">${nav}${create}<span class="who">${esc(user.name)} · ${esc(user.role)} · <a href="/signout" style="text-decoration:underline">Sign out</a></span></nav>`;
}

const server=http.createServer(async(req,res)=>{
  const db=load();runScheduler(db);
  const url=new URL(req.url,`http://${req.headers.host}`), p=url.pathname, user=userFor(req,db);
  const send=(title,body,status=200,opts={})=>{res.writeHead(status,{'Content-Type':'text/html; charset=utf-8'});res.end(layout(title,body,user,{db,...opts}));};

  if(p==='/robots.txt'){res.writeHead(200,{'Content-Type':'text/plain'});return res.end('User-agent: *\nAllow: /\nSitemap: /sitemap.xml');}
  if(p==='/brand/anyways-logo.png'){const file=path.join(ROOT,'public','brand','anyways-logo.png');if(!fs.existsSync(file)){res.writeHead(404);return res.end();}res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'public, max-age=86400'});return fs.createReadStream(file).pipe(res);}
  if(p==='/assets/design.css'){const file=path.join(ROOT,'public','design','design.css');if(!fs.existsSync(file)){res.writeHead(404);return res.end();}res.writeHead(200,{'Content-Type':'text/css; charset=utf-8','Cache-Control':'no-cache'});return fs.createReadStream(file).pipe(res);}
  if(p.startsWith('/uploads/')){const file=path.join(UPLOADS,path.basename(p));if(!fs.existsSync(file)){res.writeHead(404);return res.end();}res.writeHead(200,{'Content-Type':'image/*'});return fs.createReadStream(file).pipe(res);}
  if(p.startsWith('/photos/')){const file=path.join(ROOT,'public','photos',path.basename(p));if(!fs.existsSync(file)){res.writeHead(404);return res.end();}res.writeHead(200,{'Content-Type':p.endsWith('.png')?'image/png':'image/jpeg','Cache-Control':'no-cache'});return fs.createReadStream(file).pipe(res);}
  if(p==='/sitemap.xml'){res.writeHead(200,{'Content-Type':'application/xml'});return res.end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${db.stories.filter(published).map(s=>`<url><loc>http://localhost:${PORT}/stories/${s.slug}</loc></url>`).join('')}</urlset>`);}
  if(p==='/rss.xml'||p.match(/^\/rss\/[^/]+\.xml$/)){const sec=p==='/rss.xml'?null:p.split('/')[2].replace('.xml','');const xs=list(db,{section:sec});res.writeHead(200,{'Content-Type':'application/rss+xml'});return res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Anyways</title><link>http://localhost:${PORT}</link>${xs.map(s=>`<item><title>${esc(s.title)}</title><link>http://localhost:${PORT}/stories/${s.slug}</link><description>${esc(s.dek)}</description></item>`).join('')}</channel></rss>`);}

  /* ---------- Auth ---------- */
  if(p==='/signin'&&req.method==='GET')return send('Sign in',`<div class="signin desk">
    <div class="kicker"><span>The desk</span></div>
    <h1>Newsroom sign in</h1>
    <p class="hint">Demo accounts: admin@, editor@, maya@, jon@ (anyways.test), password “anyways-demo”.</p>
    <form method="post"><label>Email</label><input name="email" type="email" required><label>Password</label><input name="password" type="password" required><div style="margin-top:1.4rem"><button>Sign in</button></div></form>
  </div>`,200,{current:'newsroom',pageClass:'desk'});
  if(p==='/signin'&&req.method==='POST'){const b=await getBody(req),u=db.users.find(x=>x.email===b.email&&x.password===b.password);if(!u)return send('Sign in',`<div class="signin desk"><h1>Try again</h1><p class="notice">Incorrect email or password.</p><p class="hint"><a href="/signin" style="color:var(--green);text-decoration:underline">Back to sign in</a></p></div>`,401,{current:'newsroom',pageClass:'desk'});const token=id();sessions.set(token,u.id);res.writeHead(302,{'Set-Cookie':`session=${token}; HttpOnly; SameSite=Lax; Path=/`,'Location':'/newsroom'});return res.end();}
  if(p==='/signout'){const t=(req.headers.cookie||'').match(/session=([^;]+)/)?.[1];if(t)sessions.delete(t);res.writeHead(302,{'Set-Cookie':'session=; Max-Age=0; Path=/','Location':'/'});return res.end();}

  /* ---------- Homepage: the composed edition ---------- */
  if(p==='/'){
    const all=list(db),nums=numerals(db),acc=accents(all);
    const primary=db.stories.find(s=>s.id===db.homepage.primary&&published(s))||all[0];
    if(!primary)return send('Anyways',`<section class="closer"><div class="endmark">…</div><p>The desk is setting its first edition.</p></section>`,200,{current:'home'});
    const pa=authorOf(db,primary),pe=editorOf(db,primary),psec=sectionOf(db,primary);
    const briefing=all.filter(s=>s.id!==primary.id).slice(0,4);
    /* Each briefing position carries a different visual weight, on purpose. */
    const weights=['split','offset','media','media'],treats=['','plate--duo','','plate--frame'];
    /* The archive strip: one letterbox plate and one older story, mid-edition. */
    const rest=all.filter(s=>s.id!==primary.id&&!briefing.some(b=>b.id===s.id));
    const pick=rest.length?rest[Math.floor(Math.random()*rest.length)]:null;
    const sectionRows=db.sections.map(sec=>{
      const xs=all.filter(s=>s.section_id===sec.id&&s.id!==primary.id).slice(0,3);
      if(!xs.length)return '';
      return `<div class="section-row a-${acc.get(xs[0].id)}">
        <div>
          <div class="sec-head"><span class="tick" aria-hidden="true"></span><h2 class="section-name"><a href="/sections/${sec.slug}">${esc(sec.name)}</a></h2></div>
          <p class="section-promise">${esc(promises[sec.id]||'')}</p>
          <a class="all-link" href="/sections/${sec.slug}">All ${esc(sec.name.replace(/\.\.\./,'…'))} →</a>
        </div>
        <ul class="toc">${xs.map(s=>tocLine(s,nums)).join('')}</ul>
      </div>`;
    }).join('');
    return send('Anyways',`
      <section class="lead a-${acc.get(primary.id)}">
        <div class="lead-grid">
          <div class="lead-head">
            <div class="kicker"><a class="hilite" href="/sections/${psec.slug}">${esc(psec.name)}</a><span class="sep">·</span><span class="chip">${no(nums.get(primary.id))}</span><span class="sep">·</span><span>The lead</span></div>
            <h1><a href="/stories/${primary.slug}">${esc(primary.title)}</a></h1>
            <p class="standfirst">${esc(primary.dek)}</p>
            <div class="byline"><span>By <a href="/authors/${pa?.slug}">${esc(pa?.name||'')}</a></span><span>Edited by ${esc(pe?.name||'')}</span><span>${dLong(primary.published_at)}</span><span>${primary.reading_time_minutes} min read</span></div>
          </div>
          ${plate('plate--frame lead-plate','The cover plate')}
        </div>
      </section>
      ${briefing.length?`<section class="movement">
        <div class="movement-head"><span class="label">The briefing</span><span class="meta-line faint">What matters, in under ten minutes</span></div>
        <div class="entries">${briefing.map((s,i)=>entry(db,s,nums,{acc:acc.get(s.id),thumb:weights[i%weights.length],treat:treats[i%treats.length]})).join('')}</div>
      </section>`:''}
      ${pick?`<section class="strip a-${acc.get(pick.id)}">
        ${plate('plate--letterbox plate--fade','From the archive')}
        <div class="strip-note"><span class="meta-line">From the archive · ${no(nums.get(pick.id))}</span><a href="/stories/${pick.slug}">${esc(pick.title)} →</a></div>
      </section>`:''}
      ${sectionRows?`<section class="sections-index">${sectionRows}</section>`:''}
      <section class="closer">
        <div class="endmark">…</div>
        <p>That’s the edition. The archive stays open.</p>
        <div class="desk-links"><a class="all-link" href="/topics">Browse topics</a><a class="all-link" href="/search">Search the archive</a></div>
      </section>`,200,{current:'home'});
  }

  /* ---------- Search: ask the desk ---------- */
  if(p==='/search'){
    const q=url.searchParams.get('q')||'',sectionFilter=url.searchParams.get('section')||'';
    const xs=list(db,{q:q||undefined,section:sectionFilter||undefined,topic:url.searchParams.get('topic')||undefined}),nums=numerals(db),acc=accents(list(db));
    if(q&&!xs.length){db.searches.push({query:q,created_at:new Date().toISOString()});save(db);}
    const results=q?(xs.length?`<p class="results-line meta-line">${xs.length} result${xs.length===1?'':'s'} for “${esc(q)}”</p><div class="entries">${xs.map(s=>entry(db,s,nums,{acc:acc.get(s.id),thumb:'media'})).join('')}</div>`:emptyNote(`Nothing filed under “${esc(q)}” yet. The desk has noted the question.`)):(q===''&&sectionFilter?`<p class="results-line meta-line">${xs.length} stories in this section</p><div class="entries">${xs.map(s=>entry(db,s,nums,{acc:acc.get(s.id),thumb:'media'})).join('')}</div>`:'');
    return send('Search',`<div class="search-page">
      <div class="page-head">
        <div class="kicker"><span>The archive</span><span class="sep">·</span><span class="numeral">${db.stories.filter(published).length} stories on file</span></div>
        <h1>Ask the desk.</h1>
        <p class="standfirst">Every story is numbered, sourced, and still on file.</p>
      </div>
      <form method="get" class="search-block">
        <div class="search-form"><input name="q" type="search" value="${esc(q)}" placeholder="Search stories, people, topics" aria-label="Search"><button type="submit">Search →</button></div>
        <div class="search-filter"><span class="label">In</span><select name="section" aria-label="Section"><option value="">All sections</option>${db.sections.map(s=>`<option value="${s.id}" ${sectionFilter===s.id?'selected':''}>${esc(s.name)}</option>`).join('')}</select></div>
      </form>
      ${results}
    </div>`,200,{current:'search'});
  }

  /* ---------- Topics ---------- */
  if(p==='/topics'){
    return send('Topics',`<div class="page-head">
        <div class="kicker"><span>The archive, by subject</span></div>
        <h1>Topics</h1>
        <p class="standfirst">The ongoing files. New stories are added as they are published.</p>
      </div>
      <ul class="toc topic-index">${db.topics.map(t=>{const n=list(db,{topic:t.id}).length;return n?`<li><div class="toc-line"><span class="t"><a href="/topics/${t.slug}">${esc(t.name)}</a></span><span class="dots" aria-hidden="true"></span><span class="numeral">${n} ${n===1?'story':'stories'}</span></div></li>`:''}).join('')}</ul>`,200,{current:'topics'});
  }
  if(p.startsWith('/topics/')){
    const slug=p.split('/')[2],t=db.topics.find(x=>x.slug===slug);
    if(!t)return send('Not found',notFound(),404);
    const sec=url.searchParams.get('section')||undefined,xs=list(db,{topic:t.id,section:sec}),nums=numerals(db),acc=accents(list(db));
    return send(t.name,`<div class="page-head">
        <div class="kicker"><span>Topic</span><span class="sep">·</span><span class="numeral">${xs.length} ${xs.length===1?'story':'stories'}</span></div>
        <h1>${esc(t.name)}</h1>
      </div>
      <form method="get" class="filter-bar"><span class="label">Section</span><select name="section"><option value="">All sections</option>${db.sections.map(s=>`<option value="${s.id}" ${sec===s.id?'selected':''}>${esc(s.name)}</option>`).join('')}</select><button class="quiet">Filter</button></form>
      ${xs.length?`<div class="entries" style="margin-top:0.5rem">${xs.map(s=>entry(db,s,nums,{acc:acc.get(s.id),thumb:'media'})).join('')}</div>`:emptyNote('No published stories match this filter.')}`,200,{current:'topics'});
  }

  /* ---------- Sections: the promise ---------- */
  if(p.startsWith('/sections/')||['/receipts','/research','/meanwhile','/worth-your-time'].includes(p)){
    const slug=p.startsWith('/sections/')?p.split('/')[2]:p.slice(1),sec=db.sections.find(x=>x.slug===slug);
    if(!sec)return send('Not found',notFound(),404);
    const top=url.searchParams.get('topic')||undefined,xs=list(db,{section:sec.id,topic:top}),nums=numerals(db),acc=accents(list(db));
    return send(sec.name,`<div class="page-head">
        <div class="kicker"><span>Section</span><span class="sep">·</span><span class="numeral">${xs.length} ${xs.length===1?'story':'stories'}</span></div>
        <h1>${esc(sec.name)}</h1>
        <p class="standfirst">${esc(promises[sec.id]||'')}</p>
      </div>
      <form method="get" class="filter-bar"><span class="label">Topic</span><select name="topic"><option value="">All topics</option>${db.topics.map(t=>`<option value="${t.id}" ${top===t.id?'selected':''}>${esc(t.name)}</option>`).join('')}</select><button class="quiet">Filter</button></form>
      ${xs.length?`<div class="entries" style="margin-top:0.5rem">${xs.map(s=>entry(db,s,nums,{acc:acc.get(s.id),thumb:'media'})).join('')}</div>`:emptyNote('Nothing filed here yet. The archive below is always open.')}`,200,{current:sec.slug});
  }

  /* ---------- Authors ---------- */
  if(p.startsWith('/authors/')){
    const u=db.users.find(x=>x.slug===p.split('/')[2]);
    if(!u)return send('Not found',notFound(),404);
    const xs=list(db,{author:u.id}),nums=numerals(db),acc=accents(list(db));
    return send(u.name,`<div class="page-head">
        <div class="kicker"><span>${esc(u.role)}</span><span class="sep">·</span><span class="numeral">${xs.length} ${xs.length===1?'story':'stories'}</span></div>
        <h1>${esc(u.name)}</h1>
      </div>
      ${xs.length?`<div class="entries">${xs.map(s=>entry(db,s,nums,{acc:acc.get(s.id),thumb:'media'})).join('')}</div>`:emptyNote('Nothing published under this byline yet.')}`,200,{current:''});
  }

  /* ---------- Story: one of four reusable compositions ---------- */
  if(p.startsWith('/stories/')){
    const s=db.stories.find(x=>x.slug===p.split('/')[2]);
    if(!s||(!published(s)&&!(user&&(user.role!=='contributor'||s.author_id===user.id))))return send('Not found',notFound(),404);
    const a=authorOf(db,s),e=editorOf(db,s),sec=sectionOf(db,s),nums=numerals(db),acc=accents(list(db));
    const ss=db.sources.filter(x=>x.story_id===s.id).sort((a,b)=>a.sort_order-b.sort_order);
    const rel=db.stories.filter(x=>s.related_ids?.includes(x.id)&&published(x));
    const filed=s.topic_ids.map(i=>db.topics.find(t=>t.id===i)).filter(Boolean).map(t=>`<a href="/topics/${t.slug}">${esc(t.name)}</a>`).join(' / ');
    /* The slug picks the composition, so a story always opens the same way. */
    const comps={offset:['comp-offset','plate--frame'],split:['comp-split','plate--arch'],poster:['comp-poster','plate--letterbox plate--fade'],margin:['comp-margin','plate--circle']};
    const keys=Object.keys(comps),[comp,heroTreat]=comps[keys[hash(s.slug)%keys.length]];
    const head=`<div class="kicker"><a class="hilite" href="/sections/${sec?.slug}">${esc(sec?.name||'')}</a><span class="sep">·</span><span class="chip">${no(nums.get(s.id))}</span></div>
        <h1>${esc(s.title)}</h1>
        <p class="standfirst">${esc(s.dek)}</p>`;
    const hero=comp==='comp-margin'
      ?`<figure class="plate ${heroTreat} article-hero"><img src="${photo()}" alt=""></figure>`
      :plate(`${heroTreat} article-hero`,'The cover plate');
    const opening=
      comp==='comp-poster'?`${hero}<header class="article-head"><div class="head-pad">${head}</div></header>`
      :comp==='comp-margin'?`<header class="article-head">${hero}${head}</header>`
      :comp==='comp-split'?`<div class="head-grid">${hero}<header class="article-head">${head}</header></div>`
      :`<div class="head-grid"><header class="article-head">${head}</header>${hero}</div>`;
    return send(s.seo_title||s.title,`<article class="comp ${comp} a-${acc.get(s.id)||'brick'}">
      ${opening}
      <div class="byline-block">
        <span>By <a href="/authors/${a?.slug}">${esc(a?.name||'Unknown')}</a></span>
        <span>Edited by ${esc(e?.name||'')}</span>
        <span>${dLong(s.published_at||s.updated_at)}</span>
        <span>${s.reading_time_minutes} min read</span>
        ${filed?`<span class="filed">Filed under ${filed}</span>`:''}
      </div>
      <div class="article-body prose">${composeBody(db,s,md(s.body),nums)}<div class="endmark" aria-hidden="true">…</div></div>
      ${ss.length?`<aside class="sources">
        <span class="label">Sources</span>
        <p class="sources-note">Sources are part of the story.</p>
        <ol>${ss.map(x=>`<li><a target="_blank" rel="noopener" href="${esc(x.url)}">${esc(x.title)}</a><span class="src-meta">${esc(x.publisher||'')} · ${esc(x.source_type.replace(/_/g,' '))}${x.published_at?` · ${dShort(x.published_at)}`:''}</span></li>`).join('')}</ol>
      </aside>`:''}
      ${rel.length?`<section class="next-reads">
        <h2>Anyways…</h2>
        <p class="meta-line faint" style="margin-bottom:0.6rem">Here’s where we’d go next.</p>
        <div class="entries">${rel.map(x=>entry(db,x,nums,{acc:acc.get(x.id),thumb:'media'})).join('')}</div>
      </section>`:''}
    </article>`,200,{desc:s.seo_description||s.dek});
  }

  /* ---------- Newsroom ---------- */
  if(p.startsWith('/newsroom')&&!user)return redirect(res,'/signin');

  if(p==='/newsroom'){
    const mine=db.stories.filter(s=>s.author_id===user.id&&s.status!=='published');
    const statuses=['idea','researching','draft','review','fact_check','scheduled','published','archived'];
    const hour=new Date().getHours(),greeting=hour<12?'Good morning':hour<18?'Good afternoon':'Good evening';
    const board=statuses.map(st=>{const n=db.stories.filter(s=>s.status===st).length;return n?`<li><div class="toc-line"><span class="t"><span class="stamp st-${st}">${st.replace('_',' ')}</span></span><span class="dots" aria-hidden="true"></span><span class="numeral">${n} ${n===1?'story':'stories'}</span></div></li>`:''}).join('');
    return send('Newsroom',`<div class="desk">
      <div class="page-head">
        <div class="kicker"><span>The desk</span><span class="sep">·</span><span>${dLong(new Date())}</span></div>
        <h1>${greeting}, ${esc(user.name.split(' ')[0])}.</h1>
        <p class="standfirst">${user.role==='contributor'?'Your drafts, the board, and the way to review.':'The board, the queue, and everything in progress.'}</p>
      </div>
      ${deskNav(user,'overview')}
      <div class="desk-section"><span class="label">The board</span><ul class="toc desk-index">${board||'<li class="meta-line" style="padding:1em 0">No stories yet.</li>'}</ul></div>
      <div class="desk-section"><span class="label">Your drafts</span>${mine.length?`<div class="entries">${mine.map(s=>entry(db,s,numerals(db),{status:true,href:`/newsroom/stories/${s.id}`})).join('')}</div>`:emptyNote(`Nothing in progress. <a href="/newsroom/stories/new" style="color:var(--green);text-decoration:underline">Start a story</a>.`)}</div>
    </div>`,200,{current:'newsroom',pageClass:'desk'});
  }

  if(p==='/newsroom/stories'&&req.method==='GET'){
    const xs=db.stories.filter(s=>user.role==='contributor'?s.author_id===user.id:true).sort((a,b)=>new Date(b.updated_at)-new Date(a.updated_at));
    return send('Stories',`<div class="desk">
      <div class="page-head"><div class="kicker"><span>The desk</span></div><h1>Stories</h1></div>
      ${deskNav(user,'stories')}
      <div class="desk-section"><table class="desk-table">
        <tr><th>Title</th><th>Status</th><th>Section</th><th>By</th><th>Updated</th></tr>
        ${xs.map(s=>`<tr><td class="title-cell"><a href="/newsroom/stories/${s.id}">${esc(s.title)}</a></td><td><span class="stamp st-${s.status}">${s.status.replace('_',' ')}</span></td><td class="mono">${esc(sectionOf(db,s)?.name||'')}</td><td class="mono">${esc(authorOf(db,s)?.name||'')}</td><td class="mono">${dShort(s.updated_at)}</td></tr>`).join('')}
      </table></div>
    </div>`,200,{current:'newsroom',pageClass:'desk'});
  }

  if(p==='/newsroom/stories/new'){if(!can(user,'create'))return send('Forbidden',forbidden(),403,{current:'newsroom',pageClass:'desk'});return send('New story',`<div class="desk">${deskNav(user,'stories')}${editorForm(db,user,{section_id:'anyways',author_id:user.id,editor_id:user.role==='contributor'?'':user.id,status:'idea',topic_ids:[]})}</div>`,200,{current:'newsroom',pageClass:'desk'});}
  if(p==='/newsroom/stories'&&req.method==='POST'){if(!can(user,'create'))return send('Forbidden',forbidden(),403,{current:'newsroom',pageClass:'desk'});const b=await getBody(req),topic=Array.isArray(b.topic)?b.topic:(b.topic?[b.topic]:[]);if(!validUrl(b.source_url))return send('Invalid source',`<div class="desk">${deskNav(user,'stories')}${editorForm(db,user,{...b,section_id:b.section_id||'anyways',author_id:user.id,status:'idea',topic_ids:topic},'A primary source URL must begin with http:// or https://.')}</div>`,422,{current:'newsroom',pageClass:'desk'});let base=slugify(b.slug||b.title),slug=base,n=2;while(db.stories.some(s=>s.slug===slug))slug=`${base}-${n++}`;const s={id:id(),title:b.title,slug,dek:b.dek,summary:b.summary,body:b.body,section_id:b.section_id,author_id:user.role==='contributor'?user.id:b.author_id,editor_id:b.editor_id||'',status:'idea',published_at:null,scheduled_for:null,updated_at:new Date().toISOString(),created_at:new Date().toISOString(),reading_time_minutes:Math.max(1,Math.ceil((b.body||'').split(/\s+/).length/220)),hero_media_id:null,seo_title:b.seo_title||b.title,seo_description:b.seo_description||b.dek,social_title:'',social_description:'',featured:false,homepage_priority:0,canonical_url:null,revision_number:1,topic_ids:topic,related_ids:[]};db.stories.push(s);db.sources.push({id:id(),story_id:s.id,title:b.source_title,publisher:b.source_publisher,url:b.source_url,normalized_url:new URL(b.source_url).toString(),source_type:b.source_type,author:'',published_at:null,accessed_at:new Date().toISOString(),archive_url:'',note:'',sort_order:1,created_at:new Date().toISOString(),created_by:user.id});save(db);return redirect(res,`/newsroom/stories/${s.id}`);}
  if(p.match(/^\/newsroom\/stories\/[^/]+$/)&&req.method==='GET'){const s=db.stories.find(x=>x.id===p.split('/')[3]);if(!s||!can(user,'edit',s))return send('Forbidden',forbidden(),403,{current:'newsroom',pageClass:'desk'});return send('Edit story',`<div class="desk">${deskNav(user,'stories')}${editorForm(db,user,s)}</div>`,200,{current:'newsroom',pageClass:'desk'});}
  if(p.match(/^\/newsroom\/stories\/[^/]+$/)&&req.method==='POST'){const s=db.stories.find(x=>x.id===p.split('/')[3]);if(!s||!can(user,'edit',s))return send('Forbidden',forbidden(),403,{current:'newsroom',pageClass:'desk'});const b=await getBody(req),topic=Array.isArray(b.topic)?b.topic:(b.topic?[b.topic]:[]),next=b.status;if(!transitionAllowed(user,s,next))return send('Invalid workflow','<div class="desk"><div class="page-head"><h1>Invalid workflow transition</h1></div><p class="notice">Contributors can only move their own work through review.</p></div>',403,{current:'newsroom',pageClass:'desk'});const newSlug=slugify(b.slug||b.title);if(db.stories.some(x=>x.id!==s.id&&x.slug===newSlug))return send('Duplicate slug',`<div class="desk">${deskNav(user,'stories')}${editorForm(db,user,s,'That slug is already in use.')}</div>`,422,{current:'newsroom',pageClass:'desk'});Object.assign(s,{title:b.title,slug:newSlug,dek:b.dek,summary:b.summary,body:b.body,section_id:b.section_id,author_id:user.role==='contributor'?user.id:b.author_id,editor_id:b.editor_id,status:next,scheduled_for:b.scheduled_for?new Date(b.scheduled_for).toISOString():null,featured:!!b.featured,homepage_priority:Number(b.homepage_priority||0),seo_title:b.seo_title,seo_description:b.seo_description,topic_ids:topic,updated_at:new Date().toISOString(),reading_time_minutes:Math.max(1,Math.ceil((b.body||'').split(/\s+/).length/220))});if(next==='published'){const errors=storyValid(db,s);if(errors.length)return send('Cannot publish',`<div class="desk">${deskNav(user,'stories')}${editorForm(db,user,s,`Publishing requires: ${errors.join(', ')}`)}</div>`,422,{current:'newsroom',pageClass:'desk'});s.published_at=s.published_at||new Date().toISOString();}if(next==='scheduled'&&!s.scheduled_for)return send('Schedule required',`<div class="desk">${deskNav(user,'stories')}${editorForm(db,user,s,'A scheduled date and time is required.')}</div>`,422,{current:'newsroom',pageClass:'desk'});s.revision_number++;db.revisions.push({id:id(),story_id:s.id,revision_number:s.revision_number,snapshot:JSON.stringify(s),created_by:user.id,created_at:new Date().toISOString(),change_note:b.change_note});save(db);return redirect(res,`/newsroom/stories/${s.id}`);}
  if(p.match(/^\/newsroom\/stories\/[^/]+\/sources$/)&&req.method==='POST'){const s=db.stories.find(x=>x.id===p.split('/')[3]);if(!s||!can(user,'edit',s))return send('Forbidden',forbidden(),403,{current:'newsroom',pageClass:'desk'});const b=await getBody(req);if(!validUrl(b.url))return send('Invalid source',`<div class="desk">${deskNav(user,'stories')}${editorForm(db,user,s,'A source URL must begin with http:// or https://.')}</div>`,422,{current:'newsroom',pageClass:'desk'});const normalized=new URL(b.url).toString();if(db.sources.some(x=>x.story_id===s.id&&x.normalized_url===normalized))return send('Duplicate source',`<div class="desk">${deskNav(user,'stories')}${editorForm(db,user,s,'That source URL already exists on this story.')}</div>`,422,{current:'newsroom',pageClass:'desk'});db.sources.push({id:id(),story_id:s.id,title:b.title,publisher:b.publisher,url:b.url,normalized_url:normalized,source_type:b.source_type,author:'',published_at:null,accessed_at:new Date().toISOString(),archive_url:'',note:'',sort_order:db.sources.filter(x=>x.story_id===s.id).length+1,created_at:new Date().toISOString(),created_by:user.id});save(db);return redirect(res,`/newsroom/stories/${s.id}`);}
  if(p.match(/^\/newsroom\/stories\/[^/]+\/sources\/[^/]+\/move$/)&&req.method==='POST'){const parts=p.split('/'),storyId=parts[3],sourceId=parts[5],s=db.stories.find(x=>x.id===storyId);if(!s||!can(user,'edit',s))return send('Forbidden',forbidden(),403,{current:'newsroom',pageClass:'desk'});const b=await getBody(req),sources=db.sources.filter(x=>x.story_id===s.id).sort((a,b)=>a.sort_order-b.sort_order),index=sources.findIndex(x=>x.id===sourceId),target=index+(b.direction==='up'?-1:b.direction==='down'?1:0);if(index<0||target<0||target>=sources.length)return redirect(res,`/newsroom/stories/${s.id}`);[sources[index],sources[target]]=[sources[target],sources[index]];sources.forEach((source,position)=>source.sort_order=position+1);save(db);return redirect(res,`/newsroom/stories/${s.id}`);}
  if(p.match(/^\/newsroom\/stories\/[^/]+\/sources\/[^/]+\/delete$/)){const parts=p.split('/'),storyId=parts[3],sourceId=parts[5];const s=db.stories.find(x=>x.id===storyId);if(!s||!can(user,'edit',s))return send('Forbidden',forbidden(),403,{current:'newsroom',pageClass:'desk'});db.sources=db.sources.filter(x=>x.id!==sourceId);save(db);return redirect(res,`/newsroom/stories/${s.id}`);}

  if(p==='/newsroom/review'||p==='/newsroom/scheduled'||p==='/newsroom/published'){
    if(!['editor','admin'].includes(user.role))return send('Forbidden',forbidden('Editors and admins only.'),403,{current:'newsroom',pageClass:'desk'});
    const status=p.split('/').pop(),map={review:'review',scheduled:'scheduled',published:'published'};
    const xs=db.stories.filter(s=>s.status===map[status]).sort((a,b)=>new Date(b.updated_at)-new Date(a.updated_at));
    const labels={review:['Review queue','Submissions waiting on an editorial decision.'],scheduled:['Scheduled','Finished work with a date. It publishes itself when the time comes.'],published:['Published','The live record. Corrections and updates still belong here.']};
    return send(labels[status][0],`<div class="desk">
      <div class="page-head"><div class="kicker"><span>The desk</span></div><h1>${labels[status][0]}</h1><p class="standfirst">${labels[status][1]}</p></div>
      ${deskNav(user,status)}
      <div class="desk-section">${xs.length?`<div class="entries">${xs.map(s=>entry(db,s,numerals(db),{status:true,href:`/newsroom/stories/${s.id}`})).join('')}</div>`:emptyNote('Nothing here. The board is clear.')}</div>
    </div>`,200,{current:'newsroom',pageClass:'desk'});
  }

  if(p==='/newsroom/topics'&&req.method==='GET'){if(!user||!['admin','editor'].includes(user.role))return send('Forbidden',forbidden(),403,{current:'newsroom',pageClass:'desk'});return send('Topics',`<div class="desk">
    <div class="page-head"><div class="kicker"><span>The desk</span></div><h1>Topics</h1><p class="standfirst">The subject files every story is filed under.</p></div>
    ${deskNav(user,'topics')}
    <div class="desk-section"><ul class="toc desk-index">${db.topics.map(t=>`<li><div class="toc-line"><span class="t">${esc(t.name)}</span><span class="dots" aria-hidden="true"></span><span class="numeral">${t.slug}</span></div></li>`).join('')}</ul></div>
    <div class="desk-section"><span class="label">Add topic</span><form method="post" style="max-width:26rem"><label>Name</label><input name="name" required><div style="margin-top:1rem"><button>Add topic</button></div></form></div>
  </div>`,200,{current:'newsroom',pageClass:'desk'});}
  if(p==='/newsroom/topics'&&req.method==='POST'){if(!user||!['admin','editor'].includes(user.role))return send('Forbidden',forbidden(),403,{current:'newsroom',pageClass:'desk'});const b=await getBody(req),slug=slugify(b.name);if(!b.name||db.topics.some(t=>t.slug===slug))return send('Topics','<div class="desk"><div class="page-head"><h1>Topics</h1></div><p class="notice">That topic already exists, or the name was blank.</p></div>',422,{current:'newsroom',pageClass:'desk'});db.topics.push({id:slug,name:b.name,slug});save(db);return redirect(res,'/newsroom/topics');}

  if(p==='/newsroom/contributors'){if(!user||user.role!=='admin')return send('Forbidden',forbidden('Admins only.'),403,{current:'newsroom',pageClass:'desk'});return send('Contributors',`<div class="desk">
    <div class="page-head"><div class="kicker"><span>The desk</span></div><h1>Contributors</h1></div>
    ${deskNav(user,'contributors')}
    <div class="desk-section"><table class="desk-table"><tr><th>Name</th><th>Email</th><th>Role</th></tr>${db.users.map(u=>`<tr><td class="title-cell">${esc(u.name)}</td><td class="mono">${esc(u.email)}</td><td><span class="stamp">${esc(u.role)}</span></td></tr>`).join('')}</table></div>
  </div>`,200,{current:'newsroom',pageClass:'desk'});}

  if(p==='/newsroom/homepage'&&req.method==='GET'){if(!user||!['admin','editor'].includes(user.role))return send('Forbidden',forbidden(),403,{current:'newsroom',pageClass:'desk'});const xs=db.stories.filter(published).sort((a,b)=>a.homepage_priority-b.homepage_priority);return send('Homepage manager',`<div class="desk">
    <div class="page-head"><div class="kicker"><span>The desk</span></div><h1>Homepage manager</h1><p class="standfirst">Choose the lead. Everything else falls back safely to the current published order.</p></div>
    ${deskNav(user,'homepage')}
    <div class="desk-section"><form method="post" style="max-width:34rem"><label>The lead story</label><select name="primary">${xs.map(s=>`<option value="${s.id}" ${db.homepage.primary===s.id?'selected':''}>${esc(s.title)}</option>`).join('')}</select><div style="margin-top:1rem"><button>Save placement</button></div></form></div>
    <div class="desk-section"><span class="label">Published, in homepage priority order</span><div class="entries">${xs.map(s=>entry(db,s,numerals(db),{href:`/newsroom/stories/${s.id}`})).join('')}</div></div>
  </div>`,200,{current:'newsroom',pageClass:'desk'});}
  if(p==='/newsroom/homepage'&&req.method==='POST'){if(!user||!['admin','editor'].includes(user.role))return send('Forbidden',forbidden(),403,{current:'newsroom',pageClass:'desk'});const b=await getBody(req);if(db.stories.some(s=>s.id===b.primary&&published(s)))db.homepage.primary=b.primary;save(db);return redirect(res,'/newsroom/homepage');}

  if(p==='/newsroom/media'&&req.method==='GET'){if(!user)return redirect(res,'/signin');return send('Media library',`<div class="desk">
    <div class="page-head"><div class="kicker"><span>The desk</span></div><h1>Media library</h1><p class="standfirst">Images supply evidence, place, character, or necessary mood. Never filler.</p></div>
    ${deskNav(user,'media')}
    <div class="desk-section"><span class="label">Add media</span><p class="notice ok" style="margin-top:0.6rem">JPEG, PNG, WebP, or GIF up to 5 MB, or a stable image URL. Alt text is required, credit is expected.</p>
    <form method="post" enctype="multipart/form-data"><label>File</label><input type="file" name="file" accept="image/jpeg,image/png,image/webp,image/gif"><label>Image URL (optional if uploading)</label><input name="public_url" placeholder="https://"><label>Alt text</label><input name="alt_text" required><label>Caption</label><input name="caption"><label>Credit</label><input name="credit"><div style="margin-top:1rem"><button>Add media</button></div></form></div>
    <div class="media-grid">${db.media.map(m=>`<figure><img src="${esc(m.public_url)}" alt="${esc(m.alt_text)}"><figcaption>${esc(m.caption||m.alt_text)}<br><span class="credit">${esc(m.credit||'')}</span></figcaption></figure>`).join('')||'<p class="empty-note">No media yet.</p>'}</div>
  </div>`,200,{current:'newsroom',pageClass:'desk'});}
  if(p==='/newsroom/media'&&req.method==='POST'){if(!user)return send('Forbidden',forbidden(),403,{current:'newsroom',pageClass:'desk'});const b=await getMultipart(req);let publicUrl=b.public_url,storage='external',filename=publicUrl?.split('/').pop()||'',mime='image/*';if(b.file?.filename){if(!['image/jpeg','image/png','image/webp','image/gif'].includes(b.file.type)||b.file.data.length>5*1024*1024)return send('Media','<div class="desk"><div class="page-head"><h1>Media library</h1></div><p class="notice">Use a JPEG, PNG, WebP, or GIF up to 5 MB.</p></div>',422,{current:'newsroom',pageClass:'desk'});fs.mkdirSync(UPLOADS,{recursive:true});filename=`${id()}-${b.file.filename}`;fs.writeFileSync(path.join(UPLOADS,filename),b.file.data);publicUrl=`/uploads/${filename}`;storage=filename;mime=b.file.type;}else if(!validUrl(publicUrl))return send('Media','<div class="desk"><div class="page-head"><h1>Media library</h1></div><p class="notice">Upload an image or use a valid image URL.</p></div>',422,{current:'newsroom',pageClass:'desk'});db.media.push({id:id(),storage_path:storage,public_url:publicUrl,filename,mime_type:mime,width:null,height:null,alt_text:b.alt_text,caption:b.caption,credit:b.credit,source_url:b.public_url||'',uploaded_by:user.id,created_at:new Date().toISOString()});save(db);return redirect(res,'/newsroom/media');}

  return send('Not found',notFound(),404);
});

const notFound=()=>`<div class="not-found"><div class="endmark" aria-hidden="true">…</div><h1>This page is not in the edition.</h1><p class="meta-line"><a href="/" style="color:var(--green);text-decoration:underline">Return to the front page</a></p></div>`;
const forbidden=(msg='You do not have access to this part of the desk.')=>`<div class="not-found"><div class="endmark" aria-hidden="true">…</div><h1>Not your desk.</h1><p class="meta-line">${esc(msg)}</p></div>`;

if(process.argv.includes('--seed')){seed();console.log('Seeded data/anyways.json');process.exit(0);}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(new URL(import.meta.url).pathname))server.listen(PORT,()=>console.log(`Anyways is running at http://localhost:${PORT}`));
export { seed, storyValid, transitionAllowed, validUrl, runScheduler };
