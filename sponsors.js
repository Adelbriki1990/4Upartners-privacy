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
