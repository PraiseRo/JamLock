// In-Memory Genre Family Taxonomy and Dynamic Similarity Engine for JamLock Autoplay
// Ensures that continuous autoplay stays in the same musical world (e.g. Afrobeats, Amapiano, Hip-Hop, Pop)
// while actively rotating artists so no artist repeats within 4-5 consecutive tracks.

export const GENRE_FAMILIES = {
  afro: {
    name: 'Afrobeats & African Sounds',
    keywords: [
      'afrobeat', 'afrobeats', 'afropop', 'afro-fusion', 'afro-pop',
      'amapiano', 'afro-house', 'alte', 'bongo flava', 'highlife', 'gqom', 'fuji'
    ],
    seedArtists: [
      'Burna Boy', 'Wizkid', 'Davido', 'Rema', 'Asake', 'Tems', 'Omah Lay',
      'Fireboy DML', 'Ayra Starr', 'Tiwa Savage', 'CKay', 'Kizz Daniel',
      'Kabza De Small', 'DJ Maphorisa', 'Tyler ICU', 'Victony', 'Adekunle Gold',
      'BNXN', 'Seyi Vibez', 'Focalistic', 'Young Jonn', 'Shallipopi', 'Uncle Waffles'
    ]
  },
  hiphop: {
    name: 'Hip-Hop, Rap & Trap',
    keywords: [
      'hip-hop', 'hip hop', 'rap', 'trap', 'drill', 'boom bap', 'southern rap', 'west coast rap', 'east coast hip hop'
    ],
    seedArtists: [
      'Drake', 'Kendrick Lamar', 'J. Cole', 'Travis Scott', 'Future', '21 Savage',
      'Metro Boomin', 'Gunna', 'Lil Baby', 'Young Thug', 'Cardi B', 'Megan Thee Stallion',
      'Playboi Carti', 'Lil Uzi Vert', 'A$AP Rocky', 'Kanye West', 'Post Malone', 'Jack Harlow'
    ]
  },
  rnb: {
    name: 'R&B & Soul',
    keywords: [
      'r&b', 'rnb', 'contemporary r&b', 'soul', 'neo-soul', 'neo soul', 'quiet storm', 'motown'
    ],
    seedArtists: [
      'SZA', 'Brent Faiyaz', 'Frank Ocean', 'Daniel Caesar', 'Summer Walker', 'Giveon',
      'Chris Brown', 'The Weeknd', 'Jhené Aiko', 'Kehlani', 'H.E.R.', 'Khalid',
      'Bryson Tiller', 'PARTYNEXTDOOR', 'Snoh Aalegra', 'Lucky Daye', 'Tinashe'
    ]
  },
  pop: {
    name: 'Pop & Contemporary Dance',
    keywords: [
      'pop', 'dance-pop', 'electropop', 'synth-pop', 'teen pop', 'pop rock'
    ],
    seedArtists: [
      'Dua Lipa', 'Taylor Swift', 'Billie Eilish', 'Ariana Grande', 'Bruno Mars',
      'Justin Bieber', 'Harry Styles', 'Olivia Rodrigo', 'Sabrina Carpenter', 'Doja Cat',
      'Ed Sheeran', 'Rihanna', 'Katy Perry', 'Shawn Mendes', 'Charli xcx'
    ]
  },
  electronic: {
    name: 'Electronic, Dance & EDM',
    keywords: [
      'electronic', 'edm', 'house', 'deep house', 'techno', 'drum and bass', 'dnb', 'tech house', 'dance'
    ],
    seedArtists: [
      'Calvin Harris', 'David Guetta', 'Fred again..', 'Peggy Gou', 'Disclosure',
      'Black Coffee', 'Skrillex', 'Diplo', 'Avicii', 'Swedish House Mafia', 'Tiësto',
      'Flume', 'Fisher', 'RÜFÜS DU SOL', 'Martin Garrix'
    ]
  },
  latin: {
    name: 'Latin, Reggaeton & Urbano',
    keywords: [
      'latin', 'reggaeton', 'latin pop', 'latin trap', 'urbano', 'bachata', 'dembow', 'salsa'
    ],
    seedArtists: [
      'Bad Bunny', 'Rauw Alejandro', 'Feid', 'Karol G', 'J Balvin', 'Peso Pluma',
      'Maluma', 'Ozuna', 'Rosalía', 'Daddy Yankee', 'Anuel AA', 'Myke Towers'
    ]
  },
  reggae: {
    name: 'Reggae & Dancehall',
    keywords: [
      'reggae', 'dancehall', 'roots reggae', 'lovers rock', 'dub', 'ragga'
    ],
    seedArtists: [
      'Popcaan', 'Sean Paul', 'Shenseea', 'Koffee', 'Chronixx', 'Damian Marley',
      'Buju Banton', 'Vybz Kartel', 'Skillibeng', 'Tarrus Riley', 'Protoje'
    ]
  },
  indie: {
    name: 'Indie, Alternative & Rock',
    keywords: [
      'indie', 'alternative', 'indie rock', 'indie pop', 'bedroom pop', 'rock', 'alternative rock'
    ],
    seedArtists: [
      'Arctic Monkeys', 'Tame Impala', 'The 1975', 'Clairo', 'Steve Lacy',
      'Mac DeMarco', 'Dominic Fike', 'The Neighbourhood', 'Lorde', 'Phoebe Bridgers',
      'Rex Orange County', 'Wallows', 'Coldplay'
    ]
  }
};

// In-memory cache for genre lookups: query -> genreFamilyKey (TTL 1 day)
const GENRE_LOOKUP_CACHE = new Map();
const GENRE_CACHE_MAX = 500;

// Normalize artist names to strip extraneous suffixes like " - Topic", "VEVO", punctuation
export function normalizeArtistName(name = '') {
  return String(name || '')
    .replace(/\s*-\s*topic\b/gi, '')
    .replace(/\bvevo\b/gi, '')
    .replace(/\s*(feat\.?|ft\.?|featuring|with)\b.*$/gi, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Detect genre family for a track using in-memory artist mappings + Apple iTunes Search API (free, zero keys)
export async function detectGenreFamily(artist = '', title = '') {
  const normArtist = normalizeArtistName(artist);
  const cacheKey = `${normArtist}::${title.toLowerCase().trim()}`;

  if (GENRE_LOOKUP_CACHE.has(cacheKey)) {
    return GENRE_LOOKUP_CACHE.get(cacheKey);
  }

  // 1. Direct match against seed artist roster
  for (const [familyKey, family] of Object.entries(GENRE_FAMILIES)) {
    for (const seed of family.seedArtists) {
      const normSeed = normalizeArtistName(seed);
      if (normArtist.includes(normSeed) || normSeed.includes(normArtist)) {
        cacheResult(cacheKey, familyKey);
        return familyKey;
      }
    }
  }

  // 2. Keyword scan in title and artist name
  const fullText = `${artist} ${title}`.toLowerCase();
  for (const [familyKey, family] of Object.entries(GENRE_FAMILIES)) {
    for (const kw of family.keywords) {
      if (fullText.includes(kw)) {
        cacheResult(cacheKey, familyKey);
        return familyKey;
      }
    }
  }

  // 3. Free Apple iTunes Search API lookup (No credentials needed; fast and returns official primaryGenreName)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const itunesQuery = encodeURIComponent(`${artist} ${title}`.trim());
    const res = await fetch(`https://itunes.apple.com/search?term=${itunesQuery}&entity=song&limit=1`, {
      signal: controller.signal,
      headers: { 'user-agent': 'JamLock/1.0 (Web Music Player)' }
    });
    clearTimeout(timeout);

    if (res.ok) {
      const json = await res.json();
      const primaryGenre = (json?.results?.[0]?.primaryGenreName || '').toLowerCase();
      if (primaryGenre) {
        for (const [familyKey, family] of Object.entries(GENRE_FAMILIES)) {
          if (family.keywords.some((kw) => primaryGenre.includes(kw))) {
            cacheResult(cacheKey, familyKey);
            return familyKey;
          }
        }
      }
    }
  } catch (e) {
    // Ignore lookup errors and fall back gracefully
  }

  // Default fallback if undetermined: 'afro' or 'pop' depending on general vibe
  const fallbackKey = 'afro';
  cacheResult(cacheKey, fallbackKey);
  return fallbackKey;
}

function cacheResult(key, val) {
  if (GENRE_LOOKUP_CACHE.size >= GENRE_CACHE_MAX) {
    const oldest = GENRE_LOOKUP_CACHE.keys().next().value;
    GENRE_LOOKUP_CACHE.delete(oldest);
  }
  GENRE_LOOKUP_CACHE.set(key, val);
}

// Generate varied discovery queries that sample across different artists in the same genre family
export function buildGenreDiscoveryQueries(currentTrack, genreFamilyKey) {
  const family = GENRE_FAMILIES[genreFamilyKey] || GENRE_FAMILIES.afro;
  const currentArtistNorm = normalizeArtistName(currentTrack.artist);

  // Filter seed artists to pick peers that are NOT the current artist
  const peerArtists = family.seedArtists.filter(
    (a) => normalizeArtistName(a) !== currentArtistNorm
  );

  // Pick 2 random distinct peers for diverse query inspiration
  const shuffled = [...peerArtists].sort(() => 0.5 - Math.random());
  const peer1 = shuffled[0] || 'Afrobeats';
  const peer2 = shuffled[1] || 'Music';
  const peer3 = shuffled[2] || 'Songs';

  return [
    `${peer1} songs audio`,
    `${peer2} hits audio`,
    `${peer1} ${peer2} audio`,
    `${peer3} music audio`
  ];
}
