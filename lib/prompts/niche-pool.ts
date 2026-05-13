import type { WorldType } from "./types";

/** Curated pool of object-led residential niches per visual lane. Each entry
 *  names 2-4 anchor objects of the lineage so (a) the operator sees the
 *  altitude we want when they land on the wizard and (b) the niche string
 *  transitively primes Claude's downstream concept brief with lineage-specific
 *  vocabulary. Spans Asia / Mediterranean / Northern Europe / Americas /
 *  Africa / Middle East / Tropical so a session sample covers real
 *  geographic and cultural variety.
 *
 *  Single source of truth — imported by both the wizard (for per-session
 *  preset/placeholder rotation) and suggest-world (for altitude calibration
 *  examples injected into the Claude prompt). */
export const NICHE_POOL: Record<WorldType, readonly string[]> = {
  interior: [
    "A Kyoto townhouse with paper screens, tatami, ikebana, gray cypress beams",
    "A Tokyo apartment with a tansu chest, low cushions, washi paper lanterns, a calligraphy scroll",
    "A Bali jungle pavilion with carved teak doors, woven palm baskets, rattan daybeds, tropical ferns",
    "A Hanoi colonial townhouse with tile floors, French shutters, lacquered cabinets, tropical light",
    "A Mallorcan farmhouse with whitewashed walls, esparto baskets, indigo linen, terracotta floors",
    "A Cycladic stone home with limewashed walls, bougainvillea, blue shutters, low rough-plaster benches",
    "A Provençal mas with stone fireplaces, lavender bunches drying, copper pots, faded toile linen",
    "An Apulian trullo with whitewashed cone ceilings, olive wood furniture, ceramic pitchers, pomegranate bowls",
    "An Andalusian patio home with azulejo tiles, citrus trees, wrought-iron gates, geraniums in clay pots",
    "A Belgian farmhouse with reclaimed oak beams, linen-slipcovered sofas, ironstone pottery, hydrangeas",
    "A Cotswold cottage with low ceilings, English chintz armchairs, books on flagstones, dried herbs",
    "A Norwegian hytte with timber walls, Marimekko throws, sheepskins, birch logs by a wood stove",
    "A Scottish bothy with stone walls, Hebridean tweed, peat fire, weathered fishing rods by the door",
    "A Marfa adobe with raw plaster, vintage Mexican blankets, agave in clay urns, mesquite stools",
    "A Joshua Tree desert house with corten steel, Pendleton wool, cacti in concrete planters",
    "A Hudson Valley barn conversion with whitewashed pine beams, antique milking stools, hop vines",
    "A Yucatán henequén house with limestone walls, hammocks, equipales chairs, papel picado garlands",
    "A Patagonian estancia with sheepskin throws, weathered leather chairs, gaucho tools, fir floors",
    "A Marrakech riad with zellige tile, brass lanterns, Berber rugs, jasmine in tadelakt walls",
    "A Cape Town veld home with reed ceilings, kudu skull on plaster, sisal rugs, fynbos in stone urns",
    "An Atlas Mountain rammed-earth home with palm-leaf baskets, low cedar tables, mint tea service",
    "A Lebanese mountain villa with arched doorways, tiled fountains, brass coffee pots, rosewater glasses",
    "A Tulum cenote home with palapa roof, hammock, ceramic mezcal cups, copal incense burner",
    "A Mauritian Creole bungalow with louvered shutters, frangipani in vases, planter chairs, vanilla pods",
    "A São Paulo penthouse with Sergio Rodrigues poltronas, philodendron, terrazzo, Burle Marx prints",
  ],
  exterior: [
    "A Kyoto machiya with cypress lattice gates, gravel courtyard, single pine tree, lantern by the door",
    "A Hokkaido cabin with cedar walls, snow-laden eaves, woodpile, pine forest behind",
    "A Bali villa with thatched roof, lily pond, frangipani trees, stone steps to the entry",
    "A Hanoi shophouse with mustard plaster, climbing bougainvillea, fruit vendor cart, scooters outside",
    "A Mallorcan farmhouse with terracotta-tiled roof, olive grove, blue-painted door, drystone walls",
    "A Cycladic whitewashed home with rounded forms, bougainvillea cascade, blue domed chapel beside, sea horizon",
    "A Provençal mas with shutter-framed windows, lavender beds, gravel drive, plane-tree allée",
    "An Andalusian patio house with iron-grilled windows, jasmine climbing, fountain at entry, citrus orchard",
    "A Cinque Terre seaside home with painted plaster facades, drying laundry, terraced lemon groves above",
    "A Cotswold cottage with thatched roof, hollyhocks against stone, picket gate, climbing roses",
    "A Norwegian black-tarred hytte with grass roof, fjord beyond, kayak on the wall, woodpile",
    "A Belgian gabled farmhouse with brick facade, coppiced linden trees, gravel forecourt, climbing ivy",
    "A Scottish stone bothy with slate roof, heather moor surrounding, peat smoke from chimney, tweed bench",
    "A Marfa adobe house with corten steel canopy, agave garden, gravel drive, low desert horizon",
    "A Joshua Tree desert house with weathered pine, ocotillo, fire pit ringed by boulders, big sky",
    "A Hudson Valley farmhouse with white clapboard, wraparound porch, pumpkin patch, sugar maples",
    "A Yucatán hacienda with pink lime-washed walls, hammock-strung trees, stone arches, henequén plants",
    "A California coastal modernist with redwood cladding, swimming pool, cypress windbreak, Pacific fog",
    "A Marrakech riad with carved cedar door, climbing jasmine, brass lantern at entry, palm-shaded patio",
    "A Cape Town fynbos house with thatched roof, proteas in the garden, stone steps, indigenous shrubs",
    "An Atlas Mountain pisé home with red earth walls, terraced vegetable gardens, fig trees, mules nearby",
    "A Lebanese mountain stone house with arched loggia, vine-covered pergola, lemon trees, weathered shutters",
    "A Tulum jungle palapa with bamboo gates, hammock between palms, cenote at the back, frangipani petals on stone",
    "A Mauritian Creole bungalow with verandah, frangipani in the yard, vanilla vines, ironwork balustrade",
    "A Costa Rican coastal home with corrugated metal roof, banana palms, outdoor shower, surfboards leaning",
  ],
};

/** Fisher-Yates non-mutating sample of n items from arr. Used for per-session
 *  rotation of niche presets, placeholders, and altitude-calibration examples
 *  in the suggest-world prompt. */
export function sampleN<T>(arr: readonly T[], n: number): T[] {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(n, copy.length));
}
