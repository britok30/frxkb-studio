// Researched style catalogue for the style-explorer fan-out.
//
// WHY THIS EXISTS: the styles prompt used to hand GPT a one-line menu of ~12
// canonical families ("Scandinavian, Mid-Century Modern, Japandi, Industrial
// Loft, Bohemian, Coastal, Minimalist, Modern Farmhouse, Art Deco,
// Mediterranean, Traditional, Contemporary Luxe"). That menu WAS the output:
// across the studio's first ~40 projects those same names kept coming back,
// and an avoid-list alone couldn't beat the anchor (verified 2026-07-29 — a
// run WITH the avoid-list still repeated 5 of 9).
//
// So instead of one flat menu we carry a deep catalogue organised by AXIS,
// and each project is dealt a rotating subset ("lenses"). Two consecutive
// videos get structurally different territory even if the model would
// otherwise converge. Sources: Decorilla's styles guide, DesignFiles' 26
// styles, Homes & Gardens / 1stDibs 2026 trend reporting, and standard
// architectural-style references (see the chat research, 2026-07-29).

export type StyleAxis = {
  /** Shown to the model as the lens name. */
  name: string;
  /** What differentiates picks along this axis. */
  hint: string;
  /** Named, searchable examples. Sampled — never shown in full, so the
   *  model can't just read the first N off the list. */
  examples: string[];
};

export type LaneKey =
  | "residential-interior"
  | "residential-exterior"
  | "commercial-interior"
  | "commercial-exterior";

/** The names that dominate every generic answer. Capped, not banned — a
 *  couple are legitimately great and searchable; nine of them is a generic
 *  video. */
export const MAINSTREAM_CANON = [
  "Scandinavian",
  "Scandinavian Modern",
  "Mid-Century Modern",
  "Japandi",
  "Industrial Loft",
  "Soft Industrial",
  "Bohemian",
  "Coastal Contemporary",
  "Minimalist",
  "Modern Farmhouse",
  "Art Deco",
  "Mediterranean",
  "Mediterranean Revival",
  "Traditional",
  "Transitional",
  "Contemporary Luxe",
];

const RESIDENTIAL_INTERIOR: StyleAxis[] = [
  {
    name: "Regional vernacular",
    hint: "a real place's domestic tradition — its materials, its light, its craft",
    examples: [
      "Provençal Mas", "Andalusian Cortijo", "Moroccan Riad", "Mexican Hacienda",
      "Kyoto Machiya", "Alpine Chalet", "British Colonial", "Cycladic Greek",
      "Tuscan Farmhouse", "Portuguese Azulejo", "Rajasthani Haveli", "Balinese Pavilion",
      "Catalan Masia", "Sicilian Baroque", "Cape Dutch", "Nordic Cabin",
      "Levantine Courtyard", "Basque Caserío", "Charleston Single House", "Queenslander",
    ],
  },
  {
    name: "Era & movement",
    hint: "a dated design movement with a documented vocabulary",
    examples: [
      "Bauhaus", "Memphis Milano", "Postmodern", "Victorian", "Regency",
      "Hollywood Regency", "70s Revival", "Arts & Crafts", "Gustavian", "Biedermeier",
      "Space Age", "Art Nouveau", "Shaker", "Federal", "Empire",
      "Vienna Secession", "De Stijl", "Googie", "Brutalist Interior", "Deconstructivist",
    ],
  },
  {
    name: "Material-led",
    hint: "one hero material or finish drives the entire room",
    examples: [
      "Limewash & Plaster", "Burl Wood", "Travertine", "Terrazzo", "Rattan & Cane",
      "Blackened Steel", "Concrete & Oak", "Book-Matched Marble", "High Lacquer",
      "Bouclé & Wool", "Cork", "Reclaimed Timber", "Unlacquered Brass", "Zellige Tile",
      "Rammed Earth", "Tadelakt", "Cast Glass", "Woven Seagrass",
    ],
  },
  {
    name: "Contemporary named directions",
    hint: "the named looks designers are actually publishing in 2026",
    examples: [
      "Organic Modern", "Quiet Luxury", "Grandmillennial", "Dopamine Decor",
      "Artisan Maximalism", "Biophilic", "Modern Heritage", "Grandpa Chic",
      "Boutique Hotel at Home", "Wabi-Sabi", "Warm Minimalism", "Cottagecore",
      "Coastal Grandmother", "Eclectic Collected", "Shabby Chic", "Americana",
    ],
  },
  {
    name: "Mood & subculture",
    hint: "an atmosphere or a world, not a movement — dress the room as a character",
    examples: [
      "Dark Academia", "Cabinet of Curiosities", "Monastic Calm", "Cinematic Noir",
      "Jazz Age Supper Club", "Painter's Atelier", "Library-Led", "Conservatory",
      "Apothecary", "Hunting Lodge", "観 Tea Room", "Old-World Bar",
      "Collector's Salon", "Garden Room",
    ],
  },
  {
    name: "Craft tradition",
    hint: "built on a making tradition — joinery, weaving, pottery, paint",
    examples: [
      "Japanese Joinery", "Mingei Folk Craft", "Bloomsbury Painted", "Amish Plain",
      "Windsor & Ladderback", "Navajo Textile", "Delft & Faience", "Slöjd Woodcraft",
      "Studio Ceramics", "Marquetry & Inlay", "Block-Print Textile", "Rush & Reed",
    ],
  },
];

const RESIDENTIAL_EXTERIOR: StyleAxis[] = [
  {
    name: "Regional vernacular",
    hint: "a real place's building tradition — climate-driven form and material",
    examples: [
      "Cycladic Whitewash", "Andalusian Cortijo", "Provençal Mas", "Tuscan Villa",
      "Moroccan Riad Facade", "Cape Dutch", "Queenslander", "Bermudian",
      "Santa Fe Pueblo", "Norwegian Hytte", "Swiss Chalet", "Balinese Compound",
      "Portuguese Quinta", "Catalan Masia", "Japanese Minka", "Cornish Cottage",
    ],
  },
  {
    name: "Era & movement",
    hint: "a dated architectural movement with recognisable massing and detail",
    examples: [
      "Craftsman", "Tudor Revival", "Spanish Colonial Revival", "Victorian Queen Anne",
      "Georgian", "Federal", "Prairie School", "Streamline Moderne", "Googie",
      "International Style", "Brutalist", "Neo-Futurist", "Deconstructivist",
      "Art Deco Facade", "Bauhaus", "Usonian", "Second Empire", "Gothic Revival",
    ],
  },
  {
    name: "Material-led",
    hint: "one hero envelope material sets the whole character",
    examples: [
      "Corten Steel", "Board-Formed Concrete", "Shou Sugi Ban Cedar", "Limestone",
      "Rammed Earth", "Brick-Forward", "Glass Pavilion", "Timber Frame",
      "Lime Render", "Standing-Seam Metal", "Flint & Stone", "Terracotta Screen",
    ],
  },
  {
    name: "Contemporary named directions",
    hint: "how architects are naming new-build houses right now",
    examples: [
      "Desert Contemporary", "Passive House", "Biophilic Facade", "Barnhouse Modern",
      "Modern Heritage", "Coastal Contemporary", "Courtyard Modern", "Scandi-Modern",
      "Agrarian Modern", "Cabin Modern",
    ],
  },
  {
    name: "Landscape-led",
    hint: "the setting and planting define it as much as the building",
    examples: [
      "Mediterranean Terrace", "Xeriscape Desert", "Woodland Clearing", "Coastal Dune",
      "Olive Grove", "Walled Garden", "Rooftop Terrace", "Water Garden",
      "Alpine Meadow", "Tropical Canopy",
    ],
  },
];

const COMMERCIAL_INTERIOR: StyleAxis[] = [
  {
    name: "Hospitality archetype",
    hint: "the kind of room a guest walks into",
    examples: [
      "Boutique Hotel Lobby", "Speakeasy", "Listening Bar", "Members' Club",
      "Trattoria", "Izakaya", "Nordic Bakery", "Grand Brasserie",
      "Tea House", "Wine Cellar", "Supper Club", "Hotel Library",
    ],
  },
  {
    name: "Retail & workspace archetype",
    hint: "commercial rooms that sell or work",
    examples: [
      "Luxury Retail Salon", "Atelier Showroom", "Apothecary", "Concept Store",
      "Biophilic Office", "Co-working Loft", "Design Studio", "Gallery White Cube",
      "Bookshop", "Record Shop", "Flower Studio", "Barber Parlour",
    ],
  },
  {
    name: "Era & movement",
    hint: "a dated movement applied to a commercial room",
    examples: [
      "Art Deco Bar", "Bauhaus Workspace", "Memphis Retail", "Postmodern Lobby",
      "Mid-Century Office", "Brutalist Foyer", "Belle Époque", "Vienna Coffee House",
      "Space Age Lounge", "Googie Diner",
    ],
  },
  {
    name: "Material-led",
    hint: "one hero material carries the commercial identity",
    examples: [
      "Blackened Steel & Glass", "Travertine", "Book-Matched Marble", "Oak Millwork",
      "Terrazzo", "Polished Concrete", "Brass & Mirror", "Lacquer & Chrome",
      "Exposed Brick", "Ceramic Tile",
    ],
  },
];

const COMMERCIAL_EXTERIOR: StyleAxis[] = [
  {
    name: "Frontage archetype",
    hint: "what kind of street presence it presents",
    examples: [
      "Boutique Storefront", "Market Hall", "Arcade & Colonnade", "Corner Café",
      "Gallery Frontage", "Neon Nightlife", "Warehouse Conversion", "Kiosk Pavilion",
      "Courtyard Entry", "Showroom Window",
    ],
  },
  {
    name: "Era & movement",
    hint: "a dated architectural movement on a commercial facade",
    examples: [
      "Art Deco Facade", "Streamline Moderne", "International Style", "Brutalist",
      "Postmodern", "Prairie School", "Googie", "Neo-Futurist",
      "Deconstructivist", "Beaux-Arts",
    ],
  },
  {
    name: "Material-led",
    hint: "one hero envelope material",
    examples: [
      "Corten Frontage", "Board-Formed Concrete", "Modern Glass Curtain Wall",
      "Industrial Brick", "Timber Pavilion", "Terracotta Baguette", "Stone Plinth",
      "Perforated Metal Screen", "Glazed Tile", "Lime Render",
    ],
  },
  {
    name: "Regional vernacular",
    hint: "a real place's commercial street tradition",
    examples: [
      "Mediterranean Plaza", "Japanese Shotengai", "Parisian Shopfront",
      "Moroccan Souk", "Dutch Canal House", "Andalusian Patio Frontage",
      "Colonial Verandah", "Alpine Village",
    ],
  },
];

const CATALOGUE: Record<LaneKey, StyleAxis[]> = {
  "residential-interior": RESIDENTIAL_INTERIOR,
  "residential-exterior": RESIDENTIAL_EXTERIOR,
  "commercial-interior": COMMERCIAL_INTERIOR,
  "commercial-exterior": COMMERCIAL_EXTERIOR,
};

export function laneKey(propertyType: string, worldType: string): LaneKey {
  const program = propertyType === "commercial" ? "commercial" : "residential";
  const vantage = worldType === "exterior" ? "exterior" : "interior";
  return `${program}-${vantage}` as LaneKey;
}

/** Non-mutating random sample. */
function sample<T>(arr: readonly T[], n: number): T[] {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(n, copy.length));
}

export type StyleLens = { name: string; hint: string; examples: string[] };

/**
 * Deal this project its lenses: a rotating subset of axes, each with a
 * SAMPLE of its examples. Rotation is the actual anti-recycling mechanism —
 * two consecutive videos land on different axes, so they can't converge even
 * if the model's instincts are identical both times.
 */
export function pickStyleLenses(
  lane: LaneKey,
  opts: { axisCount?: number; examplesPerAxis?: number } = {}
): StyleLens[] {
  const axes = CATALOGUE[lane] ?? RESIDENTIAL_INTERIOR;
  const chosen = sample(axes, opts.axisCount ?? 3);
  return chosen.map((a) => ({
    name: a.name,
    hint: a.hint,
    examples: sample(a.examples, opts.examplesPerAxis ?? 9),
  }));
}
