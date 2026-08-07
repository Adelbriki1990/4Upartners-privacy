// City + sponsor catalog for Street Ops.
//
// Each city is a selectable map with its own atmosphere and its own sponsor
// roster. Sponsors appear as glowing billboards on towers, street-level ad
// stands and storefront signs inside that city.
//
// Sponsor fields:
//   name    - big text on the billboard
//   tagline - smaller text under the name
//   colorA / colorB - gradient background colors (any CSS color)
//   logo    - optional path to an image file in this repo, e.g. 'ads/redbull.png'.
//             When the file exists it is drawn on the billboard above the name.
//             Get the official asset (and permission!) from each sponsor, drop
//             it into the ads/ folder, and it appears automatically.
export const CITIES = [
  {
    id: 'neon',
    name: 'NEON DISTRICT',
    blurb: 'Rain-soaked megacity core. Heavy weather, electric skyline.',
    accent: '#41d8ff',
    sponsors: [
      { name: 'RED BULL',     tagline: 'Energy for the night shift', colorA: '#16305e', colorB: '#0a1430', logo: 'ads/redbull.png' },
      { name: 'NOVA TELECOM', tagline: 'Always connected',           colorA: '#660d73', colorB: '#1a0533', logo: null },
      { name: 'VOLT ENERGY',  tagline: 'Charge the night',           colorA: '#b36f05', colorB: '#4d1c04', logo: null },
    ],
  },
  {
    id: 'marina',
    name: 'MARINA BAY',
    blurb: 'Warm gulf downtown. Clear skies, golden towers.',
    accent: '#ffcf6e',
    sponsors: [
      { name: 'SNOONU',      tagline: 'Delivered in minutes',  colorA: '#e01f43', colorB: '#5c0d1e', logo: 'ads/snoonu.png' },
      { name: 'BMW',         tagline: 'Sheer driving pleasure', colorA: '#1c69d4', colorB: '#0a2038', logo: 'ads/bmw.png' },
      { name: '4U PARTNERS', tagline: 'Your city. Your game.',  colorA: '#0d3f8a', colorB: '#061229', logo: null },
    ],
  },
  {
    id: 'sahara',
    name: 'OLD SAHARA',
    blurb: 'Traditional desert medina. Sand walls, souq lanes, camel caravans.',
    accent: '#e8c06a',
    sponsors: [
      { name: 'SNOONU',   tagline: 'Delivered in minutes', colorA: '#e01f43', colorB: '#5c0d1e', logo: 'ads/snoonu.png' },
      { name: 'RED BULL', tagline: 'Energy for the dunes', colorA: '#16305e', colorB: '#0a1430', logo: 'ads/redbull.png' },
      { name: 'AL SOUQ',  tagline: 'The heart of the medina', colorA: '#8a5a1e', colorB: '#3a2408', logo: null },
    ],
  },
  {
    id: 'nyc',
    name: 'EMPIRE CITY',
    blurb: 'Towering skyline, yellow cabs, a deco giant above it all.',
    accent: '#ffd23f',
    sponsors: [
      { name: 'COCA-COLA',       tagline: 'Taste the feeling',      colorA: '#f40009', colorB: '#5e0000', logo: 'ads/cocacola.png' },
      { name: 'BIG APPLE PIZZA', tagline: 'A slice of the city',    colorA: '#b3950f', colorB: '#3d3204', logo: null },
      { name: 'LIBERTY BANK',    tagline: 'The city that never sleeps', colorA: '#0d3f8a', colorB: '#061229', logo: null },
    ],
  },
  {
    id: 'dubai',
    name: 'GOLDEN GULF',
    blurb: 'Supertall glass over the gulf. Gold, palms and hypercars.',
    accent: '#ffd700',
    sponsors: [
      { name: 'RED BULL',  tagline: 'Gives you wings',        colorA: '#16305e', colorB: '#0a1430', logo: 'ads/redbull.png' },
      { name: 'BMW',       tagline: 'Sheer driving pleasure', colorA: '#1c69d4', colorB: '#0a2038', logo: 'ads/bmw.png' },
      { name: 'GOLD SOUK', tagline: 'The city of gold',       colorA: '#8a6a12', colorB: '#3a2c08', logo: null },
    ],
  },
  {
    id: 'doha',
    name: 'PEARL BAY',
    blurb: 'Glass towers on the corniche. The pearl of the gulf.',
    accent: '#e05a7a',
    sponsors: [
      { name: 'SNOONU',    tagline: 'Delivered in minutes',   colorA: '#e01f43', colorB: '#5c0d1e', logo: 'ads/snoonu.png' },
      { name: 'RED BULL',  tagline: 'Energy for the corniche', colorA: '#16305e', colorB: '#0a1430', logo: 'ads/redbull.png' },
      { name: 'THE PEARL', tagline: 'Live the bay life',      colorA: '#7a2038', colorB: '#2c0a14', logo: null },
    ],
  },
  {
    id: 'harbor',
    name: 'RED HARBOR',
    blurb: 'Old-town brick and sodium lamps. Low rooftops, tight corners.',
    accent: '#ff8a5f',
    sponsors: [
      { name: 'COCA-COLA',   tagline: 'Taste the feeling', colorA: '#f40009', colorB: '#5e0000', logo: 'ads/cocacola.png' },
      { name: 'APEX MOTORS', tagline: 'Drive the future',  colorA: '#0d664d', colorB: '#041f19', logo: null },
      { name: 'LUCKY DINER', tagline: 'Open all night',    colorA: '#b3950f', colorB: '#3d3204', logo: null },
    ],
  },
];

// Clean-brand mode for portal builds: no real trademarks anywhere.
const CLEAN_SP = (typeof window !== 'undefined') &&
  (!!window.CLEAN_BUILD || new URLSearchParams(window.location.search).has('clean'));
if (CLEAN_SP) {
  const SWAP = {
    'RED BULL':  { name: 'BOLT ENERGY',   tagline: 'Charge your run' },
    'SNOONU':    { name: 'ZOOM EATS',     tagline: 'Delivered in minutes' },
    'BMW':       { name: 'AURORA MOTORS', tagline: 'Drive the future' },
    'COCA-COLA': { name: 'COSMO COLA',    tagline: 'Taste the sparkle' },
  };
  for (const city of CITIES)
    for (const sp of city.sponsors) {
      const sub = SWAP[sp.name];
      if (sub) { sp.name = sub.name; sp.tagline = sub.tagline; }
      sp.logo = null; // text billboards only — no uploaded logo art
    }
}
