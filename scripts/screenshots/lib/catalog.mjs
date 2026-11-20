/**
 * The demo catalogue. Every title, name, plot, studio and channel here is invented for the MediaMax
 * screenshots; any resemblance to real works or people is unintended.
 */

export const STUDIOS = {
  lantern: 'Lanternfish Pictures',
  north: 'Northbound Films',
  copper: 'Copperleaf Studios',
  comet: 'Pocket Comet Animation',
  blackwater: 'Blackwater Lane',
  halcyon: 'Halcyon Reel',
  tinroof: 'Tin Roof Television',
};

/** Recurring cast so person links, "More with" and recommendations have something to connect. */
export const PEOPLE = [
  'Ines Calloway', 'Rafe Okonjo', 'Talia Brennan-Soto', 'Miko Hartwell', 'Dario Feldmann', 'Saoirse Lindqvist',
  'Bastian Crowe', 'Amara Delacroix-Yu', 'Nils Okafor', 'Wren Castellanos', 'Odile Marchetti', 'Kofi Ansah-Bell',
  'Juno Pereira-Lowe', 'Hollis Vantreight', 'Lucian Thorne-Adebayo', 'Esme Kaur-Whitfield', 'Felix Andrade-Moss',
  'Noor Haddadin', 'Callum Reyes-Stroud', 'Yara Lindgren-Oduya', 'Tobias Merrinfield', 'Ivy Nakamura-Cole',
  'Ruben Ashcombe', 'Sloane Whitacre', 'Priya Castellane', 'Elias Brookhaven', 'Marisol Quenneville', 'Anouk de Vries-Tal',
  'Theo Ashgrove', 'Delphine Okoro', 'Benedikt Sall', 'Rosalind Achterberg', 'Kasimir Ndlovu', 'Gemma Tolliver-Kane',
];

const P = (i) => PEOPLE[i];
const cast = (...pairs) => pairs.map(([i, role]) => ({ name: P(i), role }));

/**
 * style: poster/backdrop look (scifi, noir, drama, family, horror, action, comedy, adventure).
 * pal: [deep, mid, accent, light] colours used by the artwork templates.
 */
export const MOVIES = [
  {
    slug: 'neon-meridian', motif: 'spire', title: 'Neon Meridian', year: 2025, style: 'scifi', pal: ['#07081f', '#2b0b5a', '#ff2bd6', '#2de2ff'],
    genres: ['Science Fiction', 'Thriller'], rating: 8.4, mpaa: 'PG-13', runtime: 128, studio: STUDIOS.lantern,
    tagline: 'The city never sleeps. Neither does she.',
    plot: 'In a rain-soaked megacity where memories are traded like currency, courier Vela Strand discovers that the package she has carried for ten years is a stolen piece of her own past. With a rogue archivist and a malfunctioning traffic drone at her side, she has one night to reach the Meridian Spire before the city erases her for good.',
    director: P(0), writers: [P(0), P(25)], cast: cast([2, 'Vela Strand'], [1, 'Oren Kade'], [5, 'Archivist Lune'], [8, 'Commissioner Hask'], [13, 'Dot (voice)'], [21, 'Mara Strand'], [17, 'Broker Ilse'], [6, 'Spire Warden']),
    logo: true, trailer: true, featurette: true, deleted: true,
  },
  {
    slug: 'last-lighthouse-kepler', motif: 'lighthouse', title: 'The Last Lighthouse on Kepler', year: 2023, style: 'scifi', pal: ['#020c1b', '#0b3a5b', '#7cf7ff', '#ffd27a'],
    genres: ['Science Fiction', 'Drama'], rating: 8.1, mpaa: 'PG', runtime: 117, studio: STUDIOS.north,
    tagline: 'Someone has to keep the light on.',
    plot: 'The last keeper of a navigation beacon on a frozen moon receives a distress call from a ship that vanished forty years ago. As the signal grows stronger, she must decide whether to guide it home or keep the light dark.',
    director: P(9), writers: [P(9)], cast: cast([11, 'Keeper Sol Avery'], [2, 'Captain Ren Ota'], [14, 'Juno (voice)'], [20, 'Dr. Tamsin Vale'], [29, 'Young Sol']),
    logo: true, trailer: true,
  },
  {
    slug: 'signal-drift', motif: 'dish', title: 'Signal Drift', year: 2021, style: 'scifi', pal: ['#050b14', '#103a3a', '#3dffb5', '#e6fff6'],
    genres: ['Science Fiction', 'Mystery'], rating: 7.6, mpaa: 'PG-13', runtime: 109, studio: STUDIOS.halcyon,
    tagline: 'The message was sent tomorrow.',
    plot: 'A radio astronomer on a remote island picks up a broadcast in her own voice, dated three days from now. Each new transmission rewrites the warning, and the island begins to change around her.',
    director: P(24), writers: [P(24), P(30)], cast: cast([5, 'Dr. Hanne Rook'], [10, 'Piet Ansel'], [22, 'Ferryman'], [16, 'Lieutenant Moss']),
    trailer: true,
  },
  {
    slug: 'orbital-hearts', motif: 'orbit', title: 'Orbital Hearts', year: 2024, style: 'scifi', pal: ['#10061f', '#4a1366', '#ff8fb8', '#ffe1a8'],
    genres: ['Science Fiction', 'Romance'], rating: 7.2, mpaa: 'PG-13', runtime: 104, studio: STUDIOS.copper,
    tagline: 'Two stations. One orbit. Ninety minutes a day.',
    plot: 'Two engineers on rival space stations can only talk during the ninety minutes a day their orbits line up. What starts as a feud over a shared antenna becomes the most important conversation of their lives.',
    director: P(31), writers: [P(31)], cast: cast([3, 'Noa Lind'], [12, 'Teo Marr'], [19, 'Station Chief Brann'], [33, 'Ada (voice)']),
  },
  {
    slug: 'rainwater-alley', motif: 'alley', title: 'Rainwater Alley', year: 2019, style: 'noir', pal: ['#07070a', '#22252b', '#d7263d', '#e8e2d6'],
    genres: ['Crime', 'Thriller'], rating: 8.0, mpaa: 'R', runtime: 121, studio: STUDIOS.blackwater,
    tagline: 'Every gutter in this city leads somewhere.',
    plot: 'A disgraced detective working nights as a hotel bellhop recognises a dead man in the lobby — because she watched him die six years ago. Her search leads through jazz cellars, flooded subway tunnels and a family business nobody leaves.',
    director: P(15), writers: [P(15), P(32)], cast: cast([4, 'Det. Iris Calder'], [7, 'Felix Orme'], [1, 'Benny Sato'], [18, 'Mrs. Varga'], [26, 'Harlan Price']),
    logo: true, trailer: true,
  },
  {
    slug: 'velvet-ledger', motif: 'curtain', title: 'The Velvet Ledger', year: 2022, style: 'noir', pal: ['#0b0606', '#3a1414', '#e0b04a', '#f2e6cf'],
    genres: ['Crime', 'Drama'], rating: 7.8, mpaa: 'R', runtime: 133, studio: STUDIOS.blackwater,
    tagline: 'Some debts are written in ink. Others in blood.',
    plot: 'An accountant for a glamorous supper club finds a second set of books that tracks favours instead of money. When the owner turns up dead, every name in the ledger has a reason to want it burned.',
    director: P(15), writers: [P(27)], cast: cast([7, 'Leopold Crane'], [11, 'Vivienne Dusk'], [4, 'Inspector Gale'], [28, 'Teddy Bloom']),
  },
  {
    slug: 'hotel-ostrava', motif: 'hotel', title: 'Midnight at the Hotel Ostrava', year: 2016, style: 'noir', pal: ['#090a10', '#1f2a44', '#4fb0ff', '#e9edf5'],
    genres: ['Mystery', 'Thriller'], rating: 7.4, mpaa: 'PG-13', runtime: 112, studio: STUDIOS.halcyon,
    tagline: 'Check in. Find out.',
    plot: 'Snowed in at a grand old hotel, a night porter has until dawn to work out which of the eleven guests is not who they claim to be — and why the clocks on the fourth floor keep stopping at midnight.',
    director: P(30), writers: [P(30)], cast: cast([10, 'Tomas Prell'], [3, 'Countess Arlen'], [8, 'Mr. Gideon'], [21, 'Clara Wend']),
  },
  {
    slug: 'paper-kites', motif: 'kites', title: 'Summer of the Paper Kites', year: 2020, style: 'drama', pal: ['#3b1d2a', '#c8553d', '#f6ae2d', '#fff4e0'],
    genres: ['Drama', 'Family'], rating: 7.9, mpaa: 'PG', runtime: 106, studio: STUDIOS.copper,
    tagline: 'Some summers carry you for the rest of your life.',
    plot: 'Three estranged siblings return to their grandmother\'s seaside town to sell the family kite shop, only to find she has left them one last unfinished kite — and a list of instructions that will take all summer.',
    director: P(27), writers: [P(27), P(9)], cast: cast([18, 'Agnes Holm'], [12, 'Jasper Holm'], [22, 'Rosa Holm'], [33, 'Grandma Edda'], [20, 'Kit Morrow']),
    logo: true, trailer: true,
  },
  {
    slug: 'lemon-trees', motif: 'grove', title: 'Where the Lemon Trees Lean', year: 2023, style: 'drama', pal: ['#2d2a1a', '#7a8b3a', '#f2d24b', '#fffbe8'],
    genres: ['Drama', 'Romance'], rating: 7.7, mpaa: 'PG-13', runtime: 118, studio: STUDIOS.north,
    tagline: 'Love grows where you least expect it.',
    plot: 'A burnt-out architect inherits a crumbling hillside grove and a stubborn caretaker who refuses to leave. Through one harvest season, the two rebuild the terraces — and, slowly, each other.',
    director: P(31), writers: [P(31)], cast: cast([20, 'Livia Moreau'], [16, 'Matteo Sarn'], [26, 'Old Benedetto'], [11, 'Clara Moreau']),
  },
  {
    slug: 'alder-street', motif: 'street', title: 'Letters to Alder Street', year: 2018, style: 'drama', pal: ['#1d2b3a', '#5c7c8a', '#e8a87c', '#f7efe5'],
    genres: ['Drama'], rating: 7.5, mpaa: 'PG', runtime: 101, studio: STUDIOS.halcyon,
    tagline: 'Every letter finds its way home.',
    plot: 'A retired postwoman starts answering the undeliverable letters piling up in a closed sorting office, and a neighbourhood of strangers slowly becomes a family.',
    director: P(9), writers: [P(29)], cast: cast([33, 'Martha Penhale'], [13, 'Desmond Ike'], [23, 'Lucy Fairburn']),
  },
  {
    slug: 'pip-moon-machine', motif: 'moon', title: 'Pip and the Moon Machine', year: 2022, style: 'family', pal: ['#1b2a6b', '#4f7cff', '#ffcf3f', '#ffffff'],
    genres: ['Animation', 'Family', 'Adventure'], rating: 7.8, mpaa: 'G', runtime: 94, studio: STUDIOS.comet,
    tagline: 'Small inventor. Big night.',
    plot: 'When the moon gets stuck behind the town clock tower, a pint-sized inventor and her grumpy robot vacuum build a machine to push it back into the sky before morning.',
    director: P(29), writers: [P(29), P(13)], cast: cast([14, 'Pip (voice)'], [13, 'Bolt (voice)'], [23, 'Mayor Puddle (voice)'], [6, 'The Moon (voice)']),
    logo: true, trailer: true,
  },
  {
    slug: 'sock-rebellion', motif: 'socks', title: 'The Great Sock Rebellion', year: 2024, style: 'family', pal: ['#ff5e5b', '#ffb84c', '#2ec4b6', '#fffaf0'],
    genres: ['Animation', 'Comedy', 'Family'], rating: 7.3, mpaa: 'G', runtime: 89, studio: STUDIOS.comet,
    tagline: 'They are done being left behind.',
    plot: 'Every lost sock ends up in the same place: a secret kingdom under the washing machine. When their king declares war on the dryer, one mismatched pair must stop the uprising.',
    director: P(29), writers: [P(13)], cast: cast([13, 'Lefty (voice)'], [14, 'Rightie (voice)'], [6, 'King Argyle (voice)'], [19, 'The Dryer (voice)']),
  },
  {
    slug: 'hollow-choir', motif: 'chapel', title: 'The Hollow Choir', year: 2022, style: 'horror', pal: ['#050304', '#2a0a0e', '#b3001b', '#d9d0c7'],
    genres: ['Horror', 'Mystery'], rating: 7.1, mpaa: 'R', runtime: 99, studio: STUDIOS.blackwater,
    tagline: 'Once you hear it, it learns your voice.',
    plot: 'A sound recordist hired to capture the acoustics of an abandoned chapel discovers the choir loft is not empty. Every night the recordings get longer — and one voice sounds exactly like her.',
    director: P(32), writers: [P(32)], cast: cast([21, 'Edie Marsh'], [17, 'Father Aldous'], [24, 'Simon Pell']),
    logo: true, trailer: true,
  },
  {
    slug: 'birch-house', motif: 'birch', title: 'Below the Birch House', year: 2020, style: 'horror', pal: ['#030507', '#14242a', '#9bd1c9', '#e3e9e8'],
    genres: ['Horror'], rating: 6.8, mpaa: 'R', runtime: 96, studio: STUDIOS.halcyon,
    tagline: 'The house is fine. It\'s what\'s under it.',
    plot: 'A family moves into a lakeside home surrounded by white birches and finds a door in the cellar that was bricked up from the inside.',
    director: P(32), writers: [P(32), P(28)], cast: cast([4, 'Nora Quill'], [10, 'Henrik Quill'], [22, 'Mabel Quill']),
  },
  {
    slug: 'static-bloom', motif: 'bloom', title: 'Static Bloom', year: 2025, style: 'horror', pal: ['#040607', '#0f2b1f', '#9cff57', '#e7ffe0'],
    genres: ['Horror', 'Science Fiction'], rating: 7.0, mpaa: 'R', runtime: 102, studio: STUDIOS.lantern,
    tagline: 'It grows in the noise.',
    plot: 'Researchers at an Arctic listening station find a fungus that thrives on radio static. When the station\'s transmitter is switched on, it begins to spread.',
    director: P(0), writers: [P(25)], cast: cast([5, 'Dr. Lena Voss'], [8, 'Ari Thal'], [1, 'Sergeant Kemp'], [19, 'Radio Operator Bix']),
  },
  {
    slug: 'crimson-freight', motif: 'train', title: 'Crimson Freight', year: 2021, style: 'action', pal: ['#0a0f14', '#0e4a5a', '#ff7a1a', '#fff1e0'],
    genres: ['Action', 'Thriller'], rating: 7.3, mpaa: 'PG-13', runtime: 115, studio: STUDIOS.north,
    tagline: 'Twelve carriages. One way out.',
    plot: 'A retired rail marshal is pulled back for one last run when a cross-continental freight train carrying a secret cargo is hijacked in the middle of a desert storm.',
    director: P(6), writers: [P(6), P(28)], cast: cast([1, 'Marshal Cole Brannigan'], [2, 'Agent Dana Reyes'], [16, 'Viktor Sarn'], [7, 'Engineer Polly']),
    logo: true, trailer: true,
  },
  {
    slug: 'cartographers-gambit', motif: 'map', title: 'The Cartographer\'s Gambit', year: 2017, style: 'adventure', pal: ['#1a140c', '#5a4022', '#e2b04a', '#f6ecd6'],
    genres: ['Adventure', 'Mystery'], rating: 7.6, mpaa: 'PG', runtime: 124, studio: STUDIOS.copper,
    tagline: 'X never marks the spot.',
    plot: 'A mapmaker\'s apprentice inherits an atlas with an island that appears on no other chart, and a rival guild willing to sink every ship in the harbour to find it first.',
    director: P(6), writers: [P(25)], cast: cast([12, 'Ezra Fenn'], [3, 'Captain Isolde Marr'], [26, 'Master Corwin'], [0, 'Guildmistress Thale']),
  },
  {
    slug: 'second-best-man', motif: 'rings', title: 'Second Best Man', year: 2023, style: 'comedy', pal: ['#ffde59', '#ff66a1', '#3a86ff', '#1b1b1b'],
    genres: ['Comedy', 'Romance'], rating: 6.9, mpaa: 'PG-13', runtime: 98, studio: STUDIOS.copper,
    tagline: 'He\'s got the ring. He just lost the groom.',
    plot: 'The groom\'s chronically unlucky cousin is promoted to best man on the morning of the wedding — and has eight hours to find the actual groom, the rings and his dignity.',
    director: P(24), writers: [P(24)], cast: cast([16, 'Danny Pike'], [18, 'Celeste Marlow'], [7, 'Uncle Rudy'], [23, 'Grandma Pike']),
  },
];

export const SHOWS = [
  {
    slug: 'quiet-frontier', motif: 'ship', title: 'The Quiet Frontier', year: 2023, style: 'scifi', pal: ['#030914', '#123a63', '#69d2ff', '#f0f7ff'],
    genres: ['Science Fiction', 'Drama'], rating: 8.6, mpaa: 'TV-14', studio: STUDIOS.tinroof, runtimeEp: 48,
    tagline: 'Four hundred years from home. One ship. No way back.',
    plot: 'Generations after leaving Earth, the colony ship Halcyon is nearing its destination — and the crew discovers that the planet they were promised has already been claimed.',
    cast: cast([11, 'Captain Imre Sol'], [2, 'Navigator Yael Brin'], [1, 'Chief Engineer Odo Fenwick'], [20, 'Dr. Kestrel Vane'], [14, 'ARIA (voice)'], [29, 'Cadet Tomas Reed']),
    logo: true,
    seasons: [
      ['Wake Cycle', 'The crew is woken early when the ship\'s navigation core reports an object that should not exist.'],
      ['Ballast', 'A hull breach forces the captain to choose which deck to seal — and who will be on the wrong side.'],
      ['Long Silence', 'Contact with the forward probe is lost; the navigator suspects sabotage.'],
      ['Landfall', 'A first team lands on the new world and finds footprints.'],
      ['The Other Ship', 'A second colony ship answers their hail. It left Earth fifty years after they did.'],
      ['Charter', 'Two crews, one planet. Negotiations begin, and so does the countdown.'],
    ],
  },
  {
    slug: 'harbor-lights', motif: 'harbor', title: 'Harbor Lights', year: 2021, style: 'noir', pal: ['#05080c', '#16314a', '#ffb347', '#f5efe6'],
    genres: ['Crime', 'Drama', 'Mystery'], rating: 8.2, mpaa: 'TV-MA', studio: STUDIOS.blackwater, runtimeEp: 52,
    tagline: 'In a town this small, everyone is hiding something.',
    plot: 'When a fishing trawler drifts into port with no crew aboard, a detective who swore never to come home must work the case in the town that raised her — and the family that still runs it.',
    cast: cast([4, 'DI Maren Holt'], [7, 'Callum Holt'], [18, 'Sgt. Bea Flint'], [26, 'Old Man Holt'], [17, 'Father Keane']),
    logo: true,
    seasons: [
      ['The Empty Boat', 'The Morning Star drifts in at dawn with dinner still warm on the galley table.'],
      ['Low Tide', 'A body surfaces under the pier, and the harbourmaster\'s alibi falls apart.'],
      ['Undertow', 'Maren confronts her brother about the night their father\'s boat went down.'],
      ['Fog Warning', 'A storm cuts the town off as a second crew goes missing.'],
      ['Saltwater', 'An old smuggling route is reopened, and someone in the station is using it.'],
      ['Lighthouse Keepers', 'The truth about the Morning Star comes ashore.'],
    ],
  },
  {
    slug: 'night-shift-bakery', motif: 'bakery', title: 'The Night Shift Bakery', year: 2022, style: 'comedy', pal: ['#2b1638', '#ff8a5b', '#ffd166', '#fff8ec'],
    genres: ['Comedy'], rating: 7.9, mpaa: 'TV-PG', studio: STUDIOS.tinroof, runtimeEp: 24,
    tagline: 'Fresh bread. Questionable decisions.',
    plot: 'A chaotic crew of night-owl bakers keeps a beloved neighbourhood bakery running between 10pm and 6am, while the day shift has no idea what really goes on.',
    cast: cast([16, 'Gus Ferreira'], [23, 'Bev Okafor'], [13, 'Little Sam'], [22, 'Mrs. Dunmore'], [12, 'Rory the Delivery Guy']),
    seasons: [
      ['Proof', 'Gus tries to impress the new owner by baking 400 croissants in one night.'],
      ['The Sourdough Incident', 'Bev\'s 30-year-old starter goes missing.'],
      ['Rush Hour', 'A wedding order arrives at 3am. The wedding is at 9.'],
      ['Health Inspector', 'An inspector shows up at midnight and refuses to leave.'],
      ['Gluten Free', 'Sam secretly enters a televised bake-off.'],
      ['Day Shift', 'The night crew is forced to work in daylight. It goes badly.'],
    ],
  },
];

/** Music: real tones and beats are synthesised per track (see media.mjs) so DJ analysis finds tempo and key. */
export const ALBUMS = [
  {
    artist: 'Neon Cartography', album: 'Afterglow Avenue', year: 2024, genre: 'Synthwave', style: 'synthwave', bpm: 100, root: 110,
    pal: ['#120526', '#ff3cac', '#2b86c5', '#ffd166'],
    tracks: ['Afterglow Avenue', 'Chrome Horizon', 'Late Arcade', 'Coastline at 3AM', 'Rearview Hearts'],
  },
  {
    artist: 'Mossgarden', album: 'Rainy Window Tapes', year: 2023, genre: 'Lo-Fi', style: 'lofi', bpm: 84, root: 98,
    pal: ['#2e3a4b', '#9fb7a4', '#f2c6a0', '#f7f1e8'],
    tracks: ['Kettle On', 'Window Seat', 'Paper Umbrellas', 'Slow Tram', 'Moss & Tea', 'Goodnight Radiator'],
  },
  {
    artist: 'Parallax Harbour', album: 'Low Sun Sessions', year: 2025, genre: 'House', style: 'house', bpm: 124, root: 87,
    pal: ['#1d0f05', '#ff6b35', '#f7c548', '#fdf0d5'],
    tracks: ['Low Sun', 'Terrace Lights', 'Saltwater Groove', 'Warm Concrete', 'Last Ferry Home'],
  },
  {
    artist: 'Hexa Dune', album: 'Glass Circuit', year: 2022, genre: 'Techno', style: 'techno', bpm: 130, root: 73,
    pal: ['#050505', '#3a3a3a', '#00f0ff', '#f4f4f4'],
    tracks: ['Glass Circuit', 'Signal Path', 'Night Logic', 'Cold Start'],
  },
];

export const AUDIOBOOKS = [
  {
    author: 'Adelaide Marsh', title: 'The Clockmaker of Wrenfield', year: 2021, narrator: 'Theo Ashgrove', style: 'clock', pal: ['#1b1410', '#6b4226', '#e8b04b', '#f6ead2'],
    chapters: 3,
  },
  {
    author: 'Tomasz Vey', title: 'Salt and Starlight', year: 2024, narrator: 'Delphine Okoro', style: 'sea', pal: ['#06122b', '#1d4e89', '#9ad1f5', '#fff6e5'],
    chapters: 3,
  },
];

export const PHOTOS = [
  ['Coastal Weekend', 'cliffs-at-dawn', 'dawn'], ['Coastal Weekend', 'harbour-evening', 'dusk'], ['Coastal Weekend', 'tide-pools', 'day'],
  ['Mountain Hike', 'ridge-line', 'day'], ['Mountain Hike', 'alpine-lake', 'dawn'], ['Mountain Hike', 'summit-stars', 'night'],
];

/** Live TV: a fictional channel line-up for the mock Xtream provider. */
export const CHANNELS = [
  { id: 101, name: 'Meridian News 24', short: 'M24', cat: 'News', colors: ['#c1121f', '#ffffff'], kind: 'news' },
  { id: 102, name: 'Pulse Sports', short: 'PULSE', cat: 'Sports', colors: ['#00b4d8', '#03045e'], kind: 'sports' },
  { id: 103, name: 'Wildscape', short: 'WILD', cat: 'Documentary', colors: ['#2d6a4f', '#d8f3dc'], kind: 'nature' },
  { id: 104, name: 'Popcorn Kids', short: 'POP!', cat: 'Kids', colors: ['#ffbe0b', '#fb5607'], kind: 'kids' },
  { id: 105, name: 'Reelhouse Movies', short: 'REEL', cat: 'Movies', colors: ['#6a040f', '#ffba08'], kind: 'movies' },
  { id: 106, name: 'Tempo Music', short: 'TEMPO', cat: 'Music', colors: ['#7209b7', '#f72585'], kind: 'music' },
  { id: 107, name: 'Hearth & Home', short: 'H&H', cat: 'Entertainment', colors: ['#bc6c25', '#fefae0'], kind: 'lifestyle' },
  { id: 108, name: 'Orbit Science', short: 'ORBIT', cat: 'Documentary', colors: ['#3a0ca3', '#4cc9f0'], kind: 'science' },
  { id: 109, name: 'Laugh Track', short: 'LOL', cat: 'Entertainment', colors: ['#ff006e', '#ffbe0b'], kind: 'comedy' },
  { id: 110, name: 'Atlas Travel', short: 'ATLAS', cat: 'Documentary', colors: ['#0077b6', '#caf0f8'], kind: 'travel' },
];

/** Programme titles per channel kind, cycled through the day. [title, minutes, description, category] */
export const PROGRAMMES = {
  news: [['Meridian Morning', 120, 'News, weather and the stories shaping the day.', 'News'], ['World Desk', 60, 'International headlines with correspondents around the globe.', 'News'], ['Market Watch', 30, 'Business news and the latest from the markets.', 'News'], ['The Briefing', 30, 'The day\'s top stories in thirty minutes.', 'News'], ['Meridian Tonight', 60, 'In-depth reporting and interviews.', 'News'], ['Weather Now', 30, 'The national and regional forecast.', 'News']],
  sports: [['Matchday Live', 120, 'Live coverage of the Coastal League fixture.', 'Sports'], ['Pulse Highlights', 30, 'All the goals and talking points.', 'Sports'], ['Track & Field Gala', 90, 'Live athletics from the Riverside Stadium.', 'Sports'], ['The Locker Room', 60, 'Former players debate the weekend\'s action.', 'Sports'], ['Grid Racing: Qualifying', 90, 'Live qualifying from the Harbour Circuit.', 'Sports']],
  nature: [['Kingdom of Reeds', 60, 'A year in the life of a wetland.', 'Documentary'], ['Night Hunters', 60, 'The creatures that come alive after dark.', 'Documentary'], ['Ocean Giants', 60, 'Following migrating whales across an ocean.', 'Documentary'], ['The Secret Garden Pond', 30, 'Tiny worlds, filmed up close.', 'Documentary'], ['Frozen Frontiers', 90, 'Survival at the edge of the ice.', 'Documentary']],
  kids: [['Bolt & Pip Shorts', 30, 'Animated adventures with a tiny inventor and her robot.', 'Kids'], ['Captain Crayon', 30, 'Drawing comes to life.', 'Kids'], ['Dino Day Care', 30, 'Even dinosaurs need a nap.', 'Kids'], ['The Sock Squad', 30, 'Lost socks save the day.', 'Kids'], ['Story Tree', 30, 'Bedtime stories read aloud.', 'Kids'], ['Science Sprouts', 30, 'Big experiments for small scientists.', 'Kids']],
  movies: [['Feature: Iron Lantern', 120, 'A lighthouse keeper uncovers a smuggling ring.', 'Movie'], ['Feature: The Long Road West', 120, 'Two strangers share a car across the plains.', 'Movie'], ['Short Film Showcase', 60, 'Award-winning shorts from new directors.', 'Movie'], ['Feature: Moonlight Express', 90, 'A heist aboard a night train.', 'Movie']],
  music: [['Tempo Countdown', 60, 'The forty biggest tracks of the week.', 'Music'], ['Live at the Pavilion', 90, 'Concert special.', 'Music'], ['Fresh Cuts', 30, 'Brand new music videos.', 'Music'], ['Late Night Grooves', 120, 'Deep house and downtempo till late.', 'Music']],
  lifestyle: [['Kitchen Table', 60, 'Simple family recipes from a farmhouse kitchen.', 'Lifestyle'], ['Room by Room', 30, 'A tired flat gets a weekend makeover.', 'Lifestyle'], ['Garden Hour', 60, 'Seasonal tips for every garden.', 'Lifestyle'], ['Bake Street', 30, 'Neighbours compete in a street bake-off.', 'Lifestyle']],
  science: [['Inside the Atom', 60, 'The hidden forces holding everything together.', 'Science'], ['Rocket Diaries', 60, 'Behind the scenes of a launch campaign.', 'Science'], ['How It\'s Made Here', 30, 'From raw material to finished product.', 'Science'], ['Deep Sky', 60, 'A tour of the night sky with astronomers.', 'Science']],
  comedy: [['Stand-Up Spotlight', 60, 'New comedians, live on stage.', 'Comedy'], ['The Flatmates', 30, 'Four friends, one bathroom.', 'Comedy'], ['Panel Panic', 60, 'Comedy quiz with celebrity guests.', 'Comedy'], ['Sketch Club', 30, 'Quick-fire sketches.', 'Comedy']],
  travel: [['Slow Trains', 60, 'Scenic rail journeys through mountain valleys.', 'Travel'], ['Island Hopper', 60, 'Exploring a chain of volcanic islands.', 'Travel'], ['Street Food Atlas', 30, 'Night markets and the cooks behind them.', 'Travel'], ['Off the Map', 90, 'Remote villages and the people who live there.', 'Travel']],
};

export const USERS = {
  admin: { username: 'admin', displayName: 'Sam', password: 'demo-pass-2026' },
  alex: { username: 'alex', displayName: 'Alex', password: 'demo-pass-2026' },
  kids: { username: 'kids', displayName: 'Kids', password: 'demo-pass-2026', maxContentRating: 'PG' },
};

/** Twelve themes for the themes gallery. */
export const THEMES = ['mediamax', 'cinema', 'nordic', 'velvet', 'sunset', 'aurora', 'noir', 'arcade', 'paper', 'sakura', 'kids', 'contrast'];
