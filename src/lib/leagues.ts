// ĞIGI GIVØ — Worldwide league & competition catalog (ESPN soccer slugs).
// 200+ active competitions across all regions. Grouped by region for the UI.

export interface LeagueDef {
  slug:   string;
  name:   string;
  region: string;
  tier:   number; // 1 = top feed, 2 = major, 3 = regional
}

export const LEAGUES: LeagueDef[] = [

  // ═══════════════════════════════════════════════════════════════════════════
  // ENGLAND
  // ═══════════════════════════════════════════════════════════════════════════
  { slug: "eng.1",          name: "Premier League",              region: "England",        tier: 1 },
  { slug: "eng.2",          name: "Championship",                region: "England",        tier: 2 },
  { slug: "eng.3",          name: "League One",                  region: "England",        tier: 3 },
  { slug: "eng.4",          name: "League Two",                  region: "England",        tier: 3 },
  { slug: "eng.fa",         name: "FA Cup",                      region: "England",        tier: 2 },
  { slug: "eng.league_cup", name: "EFL Cup (Carabao Cup)",       region: "England",        tier: 2 },
  { slug: "eng.trophy",     name: "EFL Trophy (Papa John's)",    region: "England",        tier: 3 },
  { slug: "eng.fa.women",   name: "Women's Super League",        region: "England",        tier: 2 },

  // ═══════════════════════════════════════════════════════════════════════════
  // SPAIN
  // ═══════════════════════════════════════════════════════════════════════════
  { slug: "esp.1",             name: "LaLiga",                   region: "Spain",          tier: 1 },
  { slug: "esp.2",             name: "LaLiga 2",                 region: "Spain",          tier: 2 },
  { slug: "esp.3",             name: "Primera Federación",       region: "Spain",          tier: 3 },
  { slug: "esp.copa_del_rey",  name: "Copa del Rey",             region: "Spain",          tier: 2 },
  { slug: "esp.super_cup",     name: "Supercopa de España",      region: "Spain",          tier: 2 },

  // ═══════════════════════════════════════════════════════════════════════════
  // GERMANY
  // ═══════════════════════════════════════════════════════════════════════════
  { slug: "ger.1",          name: "Bundesliga",                  region: "Germany",        tier: 1 },
  { slug: "ger.2",          name: "2. Bundesliga",               region: "Germany",        tier: 2 },
  { slug: "ger.3",          name: "3. Liga",                     region: "Germany",        tier: 3 },
  { slug: "ger.dfb_pokal",  name: "DFB Pokal",                   region: "Germany",        tier: 2 },
  { slug: "ger.super_cup",  name: "DFL Supercup",                region: "Germany",        tier: 3 },

  // ═══════════════════════════════════════════════════════════════════════════
  // ITALY
  // ═══════════════════════════════════════════════════════════════════════════
  { slug: "ita.1",            name: "Serie A",                   region: "Italy",          tier: 1 },
  { slug: "ita.2",            name: "Serie B",                   region: "Italy",          tier: 2 },
  { slug: "ita.3",            name: "Serie C",                   region: "Italy",          tier: 3 },
  { slug: "ita.coppa_italia", name: "Coppa Italia",              region: "Italy",          tier: 2 },
  { slug: "ita.super_cup",    name: "Supercoppa Italiana",       region: "Italy",          tier: 3 },

  // ═══════════════════════════════════════════════════════════════════════════
  // FRANCE
  // ═══════════════════════════════════════════════════════════════════════════
  { slug: "fra.1",                name: "Ligue 1",               region: "France",         tier: 1 },
  { slug: "fra.2",                name: "Ligue 2",               region: "France",         tier: 2 },
  { slug: "fra.coupe_de_france",  name: "Coupe de France",       region: "France",         tier: 2 },
  { slug: "fra.coupe_de_la_ligue",name: "Trophée des Champions", region: "France",         tier: 3 },

  // ═══════════════════════════════════════════════════════════════════════════
  // NETHERLANDS
  // ═══════════════════════════════════════════════════════════════════════════
  { slug: "ned.1",          name: "Eredivisie",                  region: "Netherlands",    tier: 1 },
  { slug: "ned.2",          name: "Eerste Divisie",              region: "Netherlands",    tier: 3 },
  { slug: "ned.cup",        name: "KNVB Beker",                  region: "Netherlands",    tier: 2 },

  // ═══════════════════════════════════════════════════════════════════════════
  // PORTUGAL
  // ═══════════════════════════════════════════════════════════════════════════
  { slug: "por.1",          name: "Primeira Liga",               region: "Portugal",       tier: 1 },
  { slug: "por.2",          name: "LigaPro (Liga 2)",            region: "Portugal",       tier: 3 },
  { slug: "por.cup",        name: "Taça de Portugal",            region: "Portugal",       tier: 2 },

  // ═══════════════════════════════════════════════════════════════════════════
  // SCOTLAND
  // ═══════════════════════════════════════════════════════════════════════════
  { slug: "sco.1",          name: "Scottish Premiership",        region: "Scotland",       tier: 2 },
  { slug: "sco.2",          name: "Scottish Championship",       region: "Scotland",       tier: 3 },
  { slug: "sco.fa",         name: "Scottish FA Cup",             region: "Scotland",       tier: 3 },
  { slug: "sco.league_cup", name: "Scottish League Cup",         region: "Scotland",       tier: 3 },

  // ═══════════════════════════════════════════════════════════════════════════
  // BELGIUM
  // ═══════════════════════════════════════════════════════════════════════════
  { slug: "bel.1",          name: "Belgian Pro League",          region: "Belgium",        tier: 2 },
  { slug: "bel.2",          name: "Belgian First Amateur",       region: "Belgium",        tier: 3 },
  { slug: "bel.cup",        name: "Belgian Cup",                 region: "Belgium",        tier: 3 },

  // ═══════════════════════════════════════════════════════════════════════════
  // TURKEY
  // ═══════════════════════════════════════════════════════════════════════════
  { slug: "tur.1",          name: "Süper Lig",                   region: "Turkey",         tier: 2 },
  { slug: "tur.2",          name: "TFF First League",            region: "Turkey",         tier: 3 },
  { slug: "tur.cup",        name: "Türkiye Kupası",              region: "Turkey",         tier: 3 },

  // ═══════════════════════════════════════════════════════════════════════════
  // GREECE
  // ═══════════════════════════════════════════════════════════════════════════
  { slug: "gre.1",          name: "Super League Greece",         region: "Greece",         tier: 3 },
  { slug: "gre.2",          name: "Super League 2",              region: "Greece",         tier: 3 },
  { slug: "gre.cup",        name: "Greek Cup",                   region: "Greece",         tier: 3 },

  // ═══════════════════════════════════════════════════════════════════════════
  // REST OF EUROPE
  // ═══════════════════════════════════════════════════════════════════════════
  { slug: "sui.1",          name: "Swiss Super League",          region: "Switzerland",    tier: 3 },
  { slug: "sui.2",          name: "Swiss Challenge League",      region: "Switzerland",    tier: 3 },
  { slug: "aut.1",          name: "Austrian Bundesliga",         region: "Austria",        tier: 3 },
  { slug: "aut.cup",        name: "ÖFB Cup",                     region: "Austria",        tier: 3 },
  { slug: "den.1",          name: "Danish Superliga",            region: "Denmark",        tier: 3 },
  { slug: "den.cup",        name: "Danish Cup",                  region: "Denmark",        tier: 3 },
  { slug: "nor.1",          name: "Eliteserien",                 region: "Norway",         tier: 3 },
  { slug: "nor.cup",        name: "Norwegian Cup",               region: "Norway",         tier: 3 },
  { slug: "swe.1",          name: "Allsvenskan",                 region: "Sweden",         tier: 3 },
  { slug: "swe.2",          name: "Superettan",                  region: "Sweden",         tier: 3 },
  { slug: "fin.1",          name: "Veikkausliiga",               region: "Finland",        tier: 3 },
  { slug: "pol.1",          name: "Ekstraklasa",                 region: "Poland",         tier: 3 },
  { slug: "pol.2",          name: "I Liga",                      region: "Poland",         tier: 3 },
  { slug: "cze.1",          name: "Czech First League",          region: "Czechia",        tier: 3 },
  { slug: "svk.1",          name: "Slovak Super Liga",           region: "Slovakia",       tier: 3 },
  { slug: "hun.1",          name: "OTP Bank Liga",               region: "Hungary",        tier: 3 },
  { slug: "rou.1",          name: "Liga I",                      region: "Romania",        tier: 3 },
  { slug: "bul.1",          name: "First Professional League",   region: "Bulgaria",       tier: 3 },
  { slug: "srb.1",          name: "SuperLiga Serbia",            region: "Serbia",         tier: 3 },
  { slug: "cro.1",          name: "HNL Croatia",                 region: "Croatia",        tier: 3 },
  { slug: "slo.1",          name: "PrvaLiga Slovenia",           region: "Slovenia",       tier: 3 },
  { slug: "bih.1",          name: "Premier League BiH",          region: "Bosnia",         tier: 3 },
  { slug: "mne.1",          name: "Montenegrin First League",    region: "Montenegro",     tier: 3 },
  { slug: "mkd.1",          name: "Macedonian First League",     region: "N. Macedonia",   tier: 3 },
  { slug: "alb.1",          name: "Albanian Kategoria Superiore",region: "Albania",        tier: 3 },
  { slug: "kos.1",          name: "Kosovo Football League",      region: "Kosovo",         tier: 3 },
  { slug: "isr.1",          name: "Israeli Premier League",      region: "Israel",         tier: 3 },
  { slug: "irl.1",          name: "League of Ireland Premier",   region: "Ireland",        tier: 3 },
  { slug: "nir.1",          name: "NIFL Premiership",            region: "N. Ireland",     tier: 3 },
  { slug: "wal.1",          name: "Cymru Premier",               region: "Wales",          tier: 3 },
  { slug: "lux.1",          name: "BGL Ligue",                   region: "Luxembourg",     tier: 3 },
  { slug: "cyp.1",          name: "Cypriot First Division",      region: "Cyprus",         tier: 3 },
  { slug: "mlt.1",          name: "Maltese Premier League",      region: "Malta",          tier: 3 },
  { slug: "geo.1",          name: "Erovnuli Liga",               region: "Georgia",        tier: 3 },
  { slug: "arm.1",          name: "Armenian Premier League",     region: "Armenia",        tier: 3 },
  { slug: "aze.1",          name: "Azerbaijani Premier League",  region: "Azerbaijan",     tier: 3 },
  { slug: "kaz.1",          name: "Kazakhstan Premier League",   region: "Kazakhstan",     tier: 3 },
  { slug: "bel2.1",         name: "Belarusian Premier League",   region: "Belarus",        tier: 3 },
  { slug: "mol.1",          name: "Moldovan National Division",  region: "Moldova",        tier: 3 },
  { slug: "lat.1",          name: "Latvian Higher League",       region: "Latvia",         tier: 3 },
  { slug: "lit.1",          name: "Lithuanian A Lyga",           region: "Lithuania",      tier: 3 },
  { slug: "est.1",          name: "Estonian Meistriliiga",       region: "Estonia",        tier: 3 },
  { slug: "fro.1",          name: "Faroe Islands Premier League",region: "Faroe Islands",  tier: 3 },
  { slug: "ice.1",          name: "Úrvalsdeild",                 region: "Iceland",        tier: 3 },
  { slug: "and.1",          name: "Primera Divisió (Andorra)",   region: "Andorra",        tier: 3 },
  { slug: "ukr.1",          name: "Ukrainian Premier League",    region: "Ukraine",        tier: 3 },
  { slug: "rus.1",          name: "Russian Premier League",      region: "Russia",         tier: 3 },

  // ═══════════════════════════════════════════════════════════════════════════
  // UEFA / CONTINENTAL CLUBS
  // ═══════════════════════════════════════════════════════════════════════════
  { slug: "uefa.champions",     name: "UEFA Champions League",           region: "Europe (UEFA)", tier: 1 },
  { slug: "uefa.europa",        name: "UEFA Europa League",              region: "Europe (UEFA)", tier: 1 },
  { slug: "uefa.europa.conf",   name: "UEFA Conference League",          region: "Europe (UEFA)", tier: 2 },
  { slug: "uefa.super_cup",     name: "UEFA Super Cup",                  region: "Europe (UEFA)", tier: 2 },
  { slug: "uefa.nations",       name: "UEFA Nations League",             region: "Europe (UEFA)", tier: 2 },
  { slug: "uefa.euro",          name: "UEFA European Championship",      region: "Europe (UEFA)", tier: 1 },
  { slug: "fifa.cwc",           name: "FIFA Club World Cup",             region: "Global Clubs",  tier: 1 },

  // ═══════════════════════════════════════════════════════════════════════════
  // NORTH & CENTRAL AMERICA
  // ═══════════════════════════════════════════════════════════════════════════
  { slug: "usa.1",              name: "Major League Soccer",             region: "USA & Canada",  tier: 1 },
  { slug: "usa.2",              name: "USL Championship",                region: "USA & Canada",  tier: 2 },
  { slug: "usa.usl.1",          name: "USL Super League",                region: "USA & Canada",  tier: 3 },
  { slug: "usa.3",              name: "USL League One",                  region: "USA & Canada",  tier: 3 },
  { slug: "usa.open",           name: "US Open Cup",                     region: "USA & Canada",  tier: 2 },
  { slug: "usa.nwsl",           name: "NWSL (Women)",                    region: "USA & Canada",  tier: 2 },
  { slug: "can.1",              name: "Canadian Premier League",         region: "USA & Canada",  tier: 2 },
  { slug: "mex.1",              name: "Liga MX",                         region: "Mexico",        tier: 1 },
  { slug: "mex.2",              name: "Liga de Expansión MX",            region: "Mexico",        tier: 3 },
  { slug: "mex.copa",           name: "Copa MX",                         region: "Mexico",        tier: 3 },
  { slug: "gtm.1",              name: "Liga Nacional Guatemala",         region: "Central America",tier: 3 },
  { slug: "slv.1",              name: "Primera División El Salvador",    region: "Central America",tier: 3 },
  { slug: "hnd.1",              name: "Liga Nacional Honduras",          region: "Central America",tier: 3 },
  { slug: "crc.1",              name: "Primera División Costa Rica",     region: "Central America",tier: 3 },
  { slug: "pan.1",              name: "LPF Panama",                      region: "Central America",tier: 3 },
  { slug: "nic.1",              name: "Primera División Nicaragua",      region: "Central America",tier: 3 },
  { slug: "dom.1",              name: "Liga Dominicana",                 region: "Caribbean",     tier: 3 },
  { slug: "jam.1",              name: "Jamaica Premier League",          region: "Caribbean",     tier: 3 },
  { slug: "tri.1",              name: "Trinidad & Tobago Pro League",    region: "Caribbean",     tier: 3 },
  { slug: "concacaf.champions", name: "CONCACAF Champions Cup",          region: "North America", tier: 2 },
  { slug: "concacaf.gold",      name: "CONCACAF Gold Cup",               region: "North America", tier: 2 },
  { slug: "concacaf.nations",   name: "CONCACAF Nations League",         region: "North America", tier: 2 },

  // ═══════════════════════════════════════════════════════════════════════════
  // SOUTH AMERICA
  // ═══════════════════════════════════════════════════════════════════════════
  { slug: "bra.1",              name: "Brasileirão Série A",             region: "Brazil",        tier: 1 },
  { slug: "bra.2",              name: "Brasileirão Série B",             region: "Brazil",        tier: 2 },
  { slug: "bra.3",              name: "Brasileirão Série C",             region: "Brazil",        tier: 3 },
  { slug: "bra.copa",           name: "Copa do Brasil",                  region: "Brazil",        tier: 2 },
  { slug: "bra.gaucho",         name: "Campeonato Gaúcho",               region: "Brazil",        tier: 3 },
  { slug: "bra.paulista",       name: "Campeonato Paulista",             region: "Brazil",        tier: 3 },
  { slug: "bra.carioca",        name: "Campeonato Carioca",              region: "Brazil",        tier: 3 },
  { slug: "bra.mineiro",        name: "Campeonato Mineiro",              region: "Brazil",        tier: 3 },
  { slug: "arg.1",              name: "Liga Profesional Argentina",      region: "Argentina",     tier: 1 },
  { slug: "arg.2",              name: "Primera Nacional Argentina",      region: "Argentina",     tier: 3 },
  { slug: "arg.copa",           name: "Copa Argentina",                  region: "Argentina",     tier: 3 },
  { slug: "col.1",              name: "Categoría Primera A",             region: "Colombia",      tier: 2 },
  { slug: "col.2",              name: "Categoría Primera B",             region: "Colombia",      tier: 3 },
  { slug: "chi.1",              name: "Primera División Chile",          region: "Chile",         tier: 2 },
  { slug: "chi.2",              name: "Primera B Chile",                 region: "Chile",         tier: 3 },
  { slug: "uru.1",              name: "Primera División Uruguay",        region: "Uruguay",       tier: 2 },
  { slug: "uru.2",              name: "Segunda División Uruguay",        region: "Uruguay",       tier: 3 },
  { slug: "per.1",              name: "Liga 1 Perú",                     region: "Peru",          tier: 2 },
  { slug: "ecu.1",              name: "LigaPro Ecuador",                 region: "Ecuador",       tier: 2 },
  { slug: "par.1",              name: "División Profesional Paraguay",   region: "Paraguay",      tier: 2 },
  { slug: "bol.1",              name: "División Profesional Bolivia",    region: "Bolivia",       tier: 3 },
  { slug: "ven.1",              name: "Liga FUTVE",                      region: "Venezuela",     tier: 3 },
  { slug: "conmebol.libertadores",  name: "Copa Libertadores",          region: "South America", tier: 1 },
  { slug: "conmebol.sudamericana",  name: "Copa Sudamericana",          region: "South America", tier: 2 },
  { slug: "conmebol.america",       name: "Copa América",               region: "International", tier: 1 },
  { slug: "conmebol.recopa",        name: "Recopa Sudamericana",        region: "South America", tier: 2 },

  // ═══════════════════════════════════════════════════════════════════════════
  // ASIA
  // ═══════════════════════════════════════════════════════════════════════════
  { slug: "jpn.1",          name: "J1 League",                          region: "Japan",          tier: 2 },
  { slug: "jpn.2",          name: "J2 League",                          region: "Japan",          tier: 3 },
  { slug: "jpn.3",          name: "J3 League",                          region: "Japan",          tier: 3 },
  { slug: "jpn.cup",        name: "Emperor's Cup",                      region: "Japan",          tier: 3 },
  { slug: "kor.1",          name: "K League 1",                         region: "South Korea",    tier: 2 },
  { slug: "kor.2",          name: "K League 2",                         region: "South Korea",    tier: 3 },
  { slug: "kor.cup",        name: "Korean FA Cup",                      region: "South Korea",    tier: 3 },
  { slug: "chn.1",          name: "Chinese Super League",               region: "China",          tier: 2 },
  { slug: "chn.2",          name: "Chinese League One",                 region: "China",          tier: 3 },
  { slug: "chn.cup",        name: "Chinese FA Cup",                     region: "China",          tier: 3 },
  { slug: "ind.1",          name: "Indian Super League",                region: "India",          tier: 2 },
  { slug: "ind.2",          name: "I-League",                           region: "India",          tier: 3 },
  { slug: "tha.1",          name: "Thai League 1",                      region: "Thailand",       tier: 3 },
  { slug: "tha.2",          name: "Thai League 2",                      region: "Thailand",       tier: 3 },
  { slug: "mys.1",          name: "Malaysia Super League",              region: "Malaysia",       tier: 3 },
  { slug: "idn.1",          name: "BRI Liga 1 Indonesia",               region: "Indonesia",      tier: 3 },
  { slug: "sgp.1",          name: "Singapore Premier League",           region: "Singapore",      tier: 3 },
  { slug: "vnm.1",          name: "V.League 1 Vietnam",                 region: "Vietnam",        tier: 3 },
  { slug: "phi.1",          name: "Philippines Football League",        region: "Philippines",    tier: 3 },
  { slug: "mmr.1",          name: "Myanmar National League",            region: "Myanmar",        tier: 3 },
  { slug: "khm.1",          name: "Cambodian Premier League",           region: "Cambodia",       tier: 3 },
  { slug: "pak.1",          name: "Pakistan Premier Football League",   region: "Pakistan",       tier: 3 },
  { slug: "bgd.1",          name: "Bangladesh Premier League",          region: "Bangladesh",     tier: 3 },
  { slug: "lka.1",          name: "Sri Lanka Football League",          region: "Sri Lanka",      tier: 3 },
  { slug: "nep.1",          name: "Nepal Super League",                 region: "Nepal",          tier: 3 },
  { slug: "afc.champions",  name: "AFC Champions League Elite",         region: "Asia",           tier: 2 },
  { slug: "afc.cup",        name: "AFC Cup",                            region: "Asia",           tier: 3 },
  { slug: "afc.asian.cup",  name: "AFC Asian Cup",                      region: "International",  tier: 2 },

  // ═══════════════════════════════════════════════════════════════════════════
  // MIDDLE EAST
  // ═══════════════════════════════════════════════════════════════════════════
  { slug: "ksa.1",          name: "Saudi Pro League",                   region: "Saudi Arabia",   tier: 2 },
  { slug: "ksa.2",          name: "Saudi First Division",               region: "Saudi Arabia",   tier: 3 },
  { slug: "ksa.cup",        name: "King's Cup Saudi Arabia",            region: "Saudi Arabia",   tier: 3 },
  { slug: "uae.1",          name: "UAE Pro League",                     region: "UAE",            tier: 2 },
  { slug: "uae.cup",        name: "UAE President's Cup",                region: "UAE",            tier: 3 },
  { slug: "qat.1",          name: "QSL Stars League",                   region: "Qatar",          tier: 2 },
  { slug: "qat.cup",        name: "Emir Cup Qatar",                     region: "Qatar",          tier: 3 },
  { slug: "irn.1",          name: "Persian Gulf Pro League",            region: "Iran",           tier: 3 },
  { slug: "irq.1",          name: "Iraq Premier League",                region: "Iraq",           tier: 3 },
  { slug: "jor.1",          name: "Jordan Pro League",                  region: "Jordan",         tier: 3 },
  { slug: "kuw.1",          name: "Kuwait Premier League",              region: "Kuwait",         tier: 3 },
  { slug: "bhr.1",          name: "Bahrain Premier League",             region: "Bahrain",        tier: 3 },
  { slug: "omn.1",          name: "Oman Professional League",           region: "Oman",           tier: 3 },
  { slug: "yem.1",          name: "Yemeni League",                      region: "Yemen",          tier: 3 },
  { slug: "lbn.1",          name: "Lebanese Premier League",            region: "Lebanon",        tier: 3 },
  { slug: "pal.1",          name: "West Bank Premier League",           region: "Palestine",      tier: 3 },

  // ═══════════════════════════════════════════════════════════════════════════
  // AFRICA
  // ═══════════════════════════════════════════════════════════════════════════
  { slug: "egy.1",          name: "Egyptian Premier League",            region: "Egypt",          tier: 2 },
  { slug: "egy.cup",        name: "Egypt Cup",                          region: "Egypt",          tier: 3 },
  { slug: "mar.1",          name: "Botola Pro 1 (Morocco)",             region: "Morocco",        tier: 3 },
  { slug: "tun.1",          name: "Ligue Professionnelle 1 Tunisia",    region: "Tunisia",        tier: 3 },
  { slug: "dza.1",          name: "Ligue Professionnelle 1 Algeria",    region: "Algeria",        tier: 3 },
  { slug: "lby.1",          name: "Libyan Premier League",              region: "Libya",          tier: 3 },
  { slug: "rsa.1",          name: "Betway Premiership (South Africa)",  region: "South Africa",   tier: 2 },
  { slug: "rsa.nfd",        name: "SA National First Division",         region: "South Africa",   tier: 3 },
  { slug: "nga.1",          name: "Nigeria Premier Football League",    region: "Nigeria",        tier: 3 },
  { slug: "gha.1",          name: "Ghana Premier League",               region: "Ghana",          tier: 3 },
  { slug: "civ.1",          name: "Ligue 1 Côte d'Ivoire",             region: "Ivory Coast",    tier: 3 },
  { slug: "sen.1",          name: "Senegal Ligue 1",                    region: "Senegal",        tier: 3 },
  { slug: "cmr.1",          name: "Cameroon Elite One",                 region: "Cameroon",       tier: 3 },
  { slug: "ken.1",          name: "Football Kenya Premier League",      region: "Kenya",          tier: 3 },
  { slug: "tza.1",          name: "Tanzania Mainland Premier League",   region: "Tanzania",       tier: 3 },
  { slug: "uga.1",          name: "Uganda Premier League",              region: "Uganda",         tier: 3 },
  { slug: "eth.1",          name: "Ethiopian Premier League",           region: "Ethiopia",       tier: 3 },
  { slug: "zim.1",          name: "Castle Lager Premier Soccer League", region: "Zimbabwe",       tier: 3 },
  { slug: "zmb.1",          name: "MTN Super League Zambia",            region: "Zambia",         tier: 3 },
  { slug: "ang.1",          name: "GiraBola Angola",                    region: "Angola",         tier: 3 },
  { slug: "cod.1",          name: "Linafoot DRC",                       region: "DR Congo",       tier: 3 },
  { slug: "moz.1",          name: "Mocambola",                          region: "Mozambique",     tier: 3 },
  { slug: "mwi.1",          name: "Super League Malawi",                region: "Malawi",         tier: 3 },
  { slug: "bwa.1",          name: "Botswana Premier League",            region: "Botswana",       tier: 3 },
  { slug: "ner.1",          name: "Nigerien Football Federation League",region: "Niger",          tier: 3 },
  { slug: "mli.1",          name: "Malian Première Division",           region: "Mali",           tier: 3 },
  { slug: "gnb.1",          name: "Liga Nacional Guinea-Bissau",        region: "Guinea-Bissau",  tier: 3 },
  { slug: "caf.champions",  name: "CAF Champions League",               region: "Africa",         tier: 2 },
  { slug: "caf.confed",     name: "CAF Confederation Cup",              region: "Africa",         tier: 2 },
  { slug: "caf.supercup",   name: "CAF Super Cup",                      region: "Africa",         tier: 3 },
  { slug: "caf.nations",    name: "Africa Cup of Nations",              region: "International",  tier: 2 },
  { slug: "caf.chan",       name: "CHAN (AFCON Local Players)",          region: "International",  tier: 3 },

  // ═══════════════════════════════════════════════════════════════════════════
  // OCEANIA
  // ═══════════════════════════════════════════════════════════════════════════
  { slug: "aus.1",          name: "A-League Men",                       region: "Australia",      tier: 2 },
  { slug: "aus.2",          name: "A-League Women",                     region: "Australia",      tier: 3 },
  { slug: "aus.cup",        name: "Australia Cup",                      region: "Australia",      tier: 3 },
  { slug: "nzl.1",          name: "New Zealand National League",        region: "New Zealand",    tier: 3 },
  { slug: "ofc.champions",  name: "OFC Champions League",               region: "Oceania",        tier: 3 },

  // ═══════════════════════════════════════════════════════════════════════════
  // INTERNATIONAL — NATIONAL TEAMS
  // ═══════════════════════════════════════════════════════════════════════════
  { slug: "fifa.world",           name: "FIFA World Cup",               region: "International",  tier: 1 },
  { slug: "fifa.friendly",        name: "International Friendlies",     region: "International",  tier: 2 },
  { slug: "fifa.worldq.uefa",     name: "WC Qualifying — UEFA",         region: "International",  tier: 2 },
  { slug: "fifa.worldq.conmebol", name: "WC Qualifying — CONMEBOL",    region: "International",  tier: 2 },
  { slug: "fifa.worldq.concacaf", name: "WC Qualifying — CONCACAF",    region: "International",  tier: 2 },
  { slug: "fifa.worldq.afc",      name: "WC Qualifying — AFC",          region: "International",  tier: 2 },
  { slug: "fifa.worldq.caf",      name: "WC Qualifying — CAF",          region: "International",  tier: 2 },
  { slug: "fifa.worldq.ofc",      name: "WC Qualifying — OFC",          region: "International",  tier: 3 },
  { slug: "ofc.nations",          name: "OFC Nations Cup",              region: "International",  tier: 3 },
  { slug: "afc.challenge",        name: "AFC Challenge Cup",            region: "International",  tier: 3 },
  { slug: "cosafa.cup",           name: "COSAFA Cup",                   region: "International",  tier: 3 },
  { slug: "cecafa.cup",           name: "CECAFA Cup",                   region: "International",  tier: 3 },
  { slug: "wafu.cup",             name: "WAFU Cup of Nations",          region: "International",  tier: 3 },
  { slug: "uncaf.cup",            name: "UNCAF Nations Cup",            region: "International",  tier: 3 },
];

// ─── Derived lookups ──────────────────────────────────────────────────────────

/** O(1) slug → LeagueDef lookup */
export const LEAGUE_MAP: Record<string, LeagueDef> = Object.fromEntries(
  LEAGUES.map((l) => [l.slug, l]),
);

/** Leagues grouped by region (for the browser UI league browser) */
export function leaguesByRegion(): Record<string, LeagueDef[]> {
  const map: Record<string, LeagueDef[]> = {};
  for (const l of LEAGUES) {
    (map[l.region] ??= []).push(l);
  }
  return map;
}

/** @deprecated use leaguesByRegion() */
export const getLeaguesByRegion = leaguesByRegion;

/** @deprecated use LEAGUE_MAP */
export function getLeagueBySlug(slug: string): LeagueDef | undefined {
  return LEAGUE_MAP[slug];
}

/** Leagues aggregated for the "Top Matches" home feed (tier 1 only) */
export const TOP_FEED_SLUGS: string[] = LEAGUES
  .filter((l) => l.tier === 1)
  .map((l) => l.slug);
