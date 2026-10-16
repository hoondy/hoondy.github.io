// Word packs. Lowercase a–z only; the game picks lengths to suit each stage, so every pack
// needs a spread from short to long words.

const list = (s) => s.trim().split(/\s+/);

const everyday = list(`
  art bag bay bed bee box bus cab cap car cat cup day dog dot egg elf fan fig fox fun gem hat hop
  hug ice ink jam jar jog joy key kit lab lid map mix mop mug nap net nut oak owl pan paw pen pie
  pod pop pot ray row rug run sea sky sun tea tin toe top toy tub van wax web wig win yak yam zip
  zoo
  bake ball band bark bean bell bike bird boat bold book boot bowl cake calm card cave chef city
  clay coat coin cold cook corn cozy crab dawn deer desk dice dish door dove draw drum duck dune
  easy farm fern fish flag foam fork frog game gift glow gold golf hare harp hike hill home hope
  iris jazz kite knot lake lamp leaf lime lion loft maze mild milk mint moon moss nest note oven
  palm park path pear pine play plum pond rain reed ring road rock roof rose sail salt sand seed
  ship silk sing snow soap sock sofa song soup star swan swim tide toad town tree tuna vase vine
  wave wind wing wish wolf wool yard yarn zero zest
  acorn amber apple beach berry bloom board bread brick brush cabin candy cedar chair chalk charm
  cider cliff cloud coral crane cream crown daisy dance dream eagle earth fable feast field flame
  flute frost fruit globe grape grass happy heart honey horse house jelly jewel juice kayak lemon
  light lilac llama lunch magic mango maple melon music night ocean olive opera otter paint panda
  paper party peach pearl piano pilot plant plaza quilt radio raven river robin salad scarf shell
  shore skate sleep slice smile sneak spoon sport storm story sugar sunny swing table tiger toast
  tower train tulip vapor waltz water whale wheat world zebra
  almond anchor autumn banana basket beacon breeze bridge bubble butter button camera candle
  canyon carrot castle cherry cinema circle clever clover cobalt cookie copper cotton coyote
  dragon falcon flower forest friend galaxy garden ginger glider guitar hammer harbor helmet
  island jacket jungle kettle ladder lagoon laptop lizard marble meadow mirror mitten muffin
  nectar noodle orange orchid oyster parade parrot pepper pillow planet pocket puzzle rabbit
  rhythm ribbon rocket saddle salmon sketch spirit spring sprout squash stream summer sunset
  teapot temple ticket tomato travel tunnel turtle velvet violet violin walnut window winter
  wizard yellow
  avocado balloon blanket cabbage captain caramel coconut compass concert cupcake curtain diamond
  dolphin dreamer evening fiction freedom giraffe harmony harvest holiday horizon iceberg jasmine
  journal journey kitchen ladybug lantern lettuce library meadows morning mustard network octopus
  orchard painter pancake panther peacock pelican penguin picture pilgrim popcorn pumpkin rainbow
  sandals seaside shelter sparrow sunrise theater thunder tornado trumpet uniform vanilla voyager
  weather whisper
  airplane alphabet aquarium backpack birthday blizzard bluebird calendar campfire cardinal
  carnival cinnamon dinosaur elephant festival firework flamingo goldfish hedgehog honeybee
  kangaroo keyboard lemonade marathon mountain mushroom notebook painting pancakes paradise
  pinecone platypus porridge postcard question raincoat sandwich sapphire scramble seashell
  sneakers snowball sprinkle squirrel starfish sunlight sunshine treasure triangle umbrella
  universe vacation velocity wildlife
  adventure blueberry buttercup butterfly celebrate chocolate crocodile dandelion discovery
  dragonfly education evergreen fireplace gardening happiness hurricane lightbulb nightfall
  orchestra pineapple quicksand raspberry sailboats snowflake spaghetti sunflower tangerine
  telescope waterfall wonderful
  basketball blackboard cheesecake friendship grapefruit lighthouse microphone motorcycle
  peppermint playground rhinoceros strawberry sweetheart toothbrush watermelon wristwatch
  celebration imagination marshmallow photography thunderbolt
  encyclopedia
`);

const nyc = list(`
  ave bus cab egg jay lox met pie rye
  bond cafe card curb deli dock east fare hero honk jazz line loft mets moma mott nets noho omny
  park pier rush soho soul stop taxi wall west
  allen arepa astor babka bagel bench bialy block bronx canal coney crown doors dumbo ellis essex
  ferry grand grate halal knish lenox local mural opera pizza rails ramen salsa slice steam stoop
  swipe token train union
  apollo avenue bagels ballet bodega boerum bowery bryant cobble corona fulton greene harlem
  hester hiphop hudson inwood knicks ludlow myrtle nolita pickle pigeon prince queens spring
  square subway sunset tracks uptown
  astoria battery bayside bedford bodegas borough borscht buskers cannoli carroll chelsea cyclone
  ditmars express falafel fordham gowanus heights houston hydrant jackson jamaica knishes liberty
  lincoln madison maspeth midtown orchard pierogi pretzel rangers rooftop schmear shuttle skyline
  tribeca yankees
  bleecker brighton broadway brooklyn bushwick canarsie carnegie chrysler columbus commuter
  delancey downtown dumpling elmhurst empanada flatbush flatiron flushing gramercy highline
  marathon mulberry nostrand pastrami platform prospect randalls rockaway rugelach steinway
  transfer woodside
  amsterdam chinatown concourse conductor cortlandt crosstown crosswalk flatlands governors
  greenwood koreatown lafayette lexington manhattan mezzanine ridgewood riverdale riverside
  roosevelt stapleton stonewall sunnyside turnstile unisphere yorkville
  brownstone cheesecake greenpoint guggenheim kosciuszko sheepshead verrazzano whitestone
  bensonhurst christopher kingsbridge meatpacking morningside parkchester rockefeller scaffolding
  smorgasburg straphanger tottenville
  metropolitan williamsburg
`);

const science = list(`
  ant bio dna dye eye fly gas gel gut ion lab ohm rna
  acid atom base beam bone bulb cell coil core dust fern gene germ heat iron lava lens lung mass
  moon neon nova root seed skin spin star tide tube volt watt worm zinc
  algae alloy argon biome blood boron brain clone cloud comet earth flask force fungi gland heart
  helix joule laser lever liver lunar magma metal meter nerve orbit organ ozone petri prism probe
  pulse quark radar slide solar sonar spore steam storm trait virus xenon yeast
  beaker beetle carbon copper cosmos crater embryo energy enzyme fossil fusion galaxy genome
  helium insect iodine kelvin magnet mammal mantle meteor nebula neuron newton nuclei oxygen
  photon plasma planet pollen proton quasar rocket sodium spleen tissue torque tundra vacuum
  zygote
  biology calcium climate crystal current density eclipse ecology element entropy fission gallium
  glacier glucose gravity habitat hormone inertia insulin isotope jupiter kinetic lithium meiosis
  mercury mineral mitosis neptune neutron nucleus physics pipette polymer protein quantum species
  sunspot synapse vaccine volcano voltage
  antibody asteroid bacteria catalyst chlorine collagen compound dinosaur dopamine electron
  equation friction genetics hydrogen magnetic membrane molecule momentum mutation nitrogen
  organism particle pendulum plankton platinum pressure reaction ribosome sediment skeleton
  solution spectrum tectonic titanium velocity
  amplitude astronaut barometer biosphere chemistry conductor cytoplasm ecosystem evolution
  frequency longitude magnetism mechanics meteorite molecular organelle petroleum radiation
  satellite serotonin supernova telescope
  absorption atmosphere centrifuge chromosome combustion conduction convection earthquake
  experiment geothermal hemisphere hypothesis laboratory microscope oscillator propulsion
  reflection refraction spacecraft thermostat wavelength
  chlorophyll circulation electricity evaporation exoskeleton gravitation observatory
  radioactive temperature thermometer
  acceleration biodiversity fermentation oceanography paleontology
`);

const code = list(`
  api bit bug css git npm sql tab var vim
  bash byte char code data diff enum fork hash heap html http json lint list loop main mock node
  null pipe port push repo ruby rust sort stub sudo swap sync test type void yaml
  array async await break build cache catch class clone const debug fetch float graph index input
  merge mutex parse pixel print proxy query queue react regex route scope shell stack state swift
  token tuple union while yield
  binary branch buffer bundle canvas client commit cookie cursor deploy docker effect export
  filter format golang handle header import inline kernel lambda linker logger method module
  object packet parser plugin prompt python rebase reduce render return router schema script
  select server shader socket source static stream string switch syntax tensor thread toggle
  unpack vector widget
  backend boolean browser closure compile console dataset default generic hashmap integer latency
  library migrate monitor mutable network package payload pointer promise request resolve runtime
  sandbox timeout webhook
  callback checksum endpoint firmware frontend function gradient iterator keyboard manifest
  metadata notebook overflow pipeline polyfill refactor register response snapshot terminal
  variable viewport workflow
  algorithm bandwidth benchmark component container dataframe decorator docstring exception
  framework fullstack generator immutable interface localhost namespace optimizer parameter
  partition primitive prototype recursion scheduler semaphore serialize singleton tokenizer
  undefined
  annotation breakpoint dependency descriptor encryption javascript middleware throughput
  typescript validation versioning
  abstraction concurrency destructure inheritance interpreter transaction
  asynchronous
`);

function unique(words) {
  return [...new Set(words.filter((w) => /^[a-z]{2,16}$/.test(w)))];
}

export const PACK_INFO = {
  everyday: { label: 'Everyday', blurb: 'Common words, short to long', bullet: 'E', color: '#0039A6', words: unique(everyday) },
  nyc: { label: 'NYC', blurb: 'Neighborhoods, streets, food', bullet: 'N', color: '#FCCC0A', dark: true, words: unique(nyc) },
  science: { label: 'Science', blurb: 'Atoms, planets, lab gear', bullet: 'S', color: '#00933C', words: unique(science) },
  code: { label: 'Code', blurb: 'Programming terms', bullet: 'C', color: '#FF6319', words: unique(code) },
};
