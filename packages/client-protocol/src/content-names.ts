import { DEFAULT_LOCALE, matchLocale } from './locale.ts';

export type ContentKind = 'genre' | 'genre.blurb' | 'genre.opening' | 'archetype' | 'archetype.summary' | 'stat';

const KEY_SEPARATOR = '.';

const PT_BR: Readonly<Record<string, string>> = {
  'genre.fantasy': 'Fantasia',
  'genre.science-fiction': 'Ficção científica',
  'genre.horror': 'Terror crescente',
  'genre.investigative-mystery': 'Mistério investigativo',
  'genre.modern-adventure': 'Aventura moderna',
  'genre.blank-world': 'Mundo em branco',
  'genre.blurb.fantasy': 'As pedras eretas zumbem quando a lua passa da serra, e esta noite ela está cheia.',
  'genre.blurb.science-fiction': 'O relé responde doze minutos atrasado, e a mensagem está na sua própria voz.',
  'genre.blurb.horror': 'O arranhar parou no instante em que você prendeu a respiração.',
  'genre.blurb.investigative-mystery': 'O relógio estava com a corda em dia, mas ninguém admitiu ter mexido nele.',
  'genre.blurb.modern-adventure':
    'Seu celular vibra duas vezes: o endereço de uma entrega secreta e um voo que sai em quarenta minutos.',
  'genre.blurb.blank-world': 'Mundo em branco',
  'genre.opening.fantasy': 'Um sino toca numa capela submersa que está muda há cem anos',
  'genre.opening.science-fiction':
    'Seu rebocador de mineração atraca num posto avançado onde toda a tripulação dorme e ninguém acorda',
  'genre.opening.horror': 'Você herda uma casa cujos antigos donos deixaram a mesa posta e a porta da frente aberta',
  'genre.opening.investigative-mystery':
    'Um advogado convoca você a um escritório trancado onde o relógio parou às nove e quinze',
  'genre.opening.modern-adventure': 'Um mensageiro põe um envelope lacrado na sua mão no aeroporto e some na multidão',
  'genre.opening.blank-world': 'Nada foi decidido ainda, então descreva onde você está e o que acontece ao seu redor',
  'archetype.hedge-witch': 'Bruxa do campo',
  'archetype.exiled-knight': 'Cavaleiro exilado',
  'archetype.river-smuggler': 'Contrabandista do rio',
  'archetype.station-engineer': 'Engenheiro de estação',
  'archetype.corporate-envoy': 'Enviado corporativo',
  'archetype.drift-salvager': 'Catador de destroços',
  'archetype.skeptic': 'Cético',
  'archetype.survivor': 'Sobrevivente',
  'archetype.detective': 'Detetive',
  'archetype.journalist': 'Jornalista',
  'archetype.fixer': 'Articulador',
  'archetype.reporter': 'Repórter',
  'archetype.pilot': 'Piloto',
  'archetype.summary.hedge-witch': 'Troca remédios por segredos na beira do vilarejo',
  'archetype.summary.exiled-knight': 'Cumpre o juramento feito a um senhor que o baniu',
  'archetype.summary.river-smuggler': 'Leva mercadorias e pessoas além dos postos de pedágio',
  'archetype.summary.station-engineer': 'Mantém o suporte de vida funcionando com um orçamento falido',
  'archetype.summary.corporate-envoy': 'Negocia por uma empresa dona da concessão da colônia',
  'archetype.summary.drift-salvager': 'Desmonta naves abandonadas e vende o que ainda funciona',
  'archetype.summary.skeptic': 'Explica o impossível até que não haja mais explicação',
  'archetype.summary.survivor': 'Já viu a coisa antes e ainda tem as cicatrizes',
  'archetype.summary.detective': 'Lê pessoas e lugares atrás do que não se encaixa',
  'archetype.summary.journalist': 'Segue a história aonde ela levar',
  'archetype.summary.fixer': 'Conhece alguém em cada cidade e deve favores à maioria',
  'archetype.summary.reporter': 'Persegue a história até onde a polícia para',
  'archetype.summary.pilot': 'Leva as pessoas para dentro e para fora quando as estradas fecham',
  'stat.Might': 'Força',
  'stat.Agility': 'Agilidade',
  'stat.Wits': 'Raciocínio',
  'stat.Presence': 'Presença',
};

const ES: Readonly<Record<string, string>> = {
  'genre.fantasy': 'Fantasía',
  'genre.science-fiction': 'Ciencia ficción',
  'genre.horror': 'Terror creciente',
  'genre.investigative-mystery': 'Misterio de investigación',
  'genre.modern-adventure': 'Aventura moderna',
  'genre.blank-world': 'Mundo en blanco',
  'genre.blurb.fantasy': 'Las piedras erguidas zumban cuando la luna pasa sobre la sierra, y esta noche está llena.',
  'genre.blurb.science-fiction': 'El relé responde doce minutos tarde, y el mensaje está en tu propia voz.',
  'genre.blurb.horror': 'El rasguño se detuvo en el instante en que contuviste la respiración.',
  'genre.blurb.investigative-mystery': 'El reloj tenía cuerda de sobra, pero nadie admitió haberlo tocado.',
  'genre.blurb.modern-adventure':
    'Tu celular vibra dos veces: la dirección de una entrega secreta y un vuelo que sale en cuarenta minutos.',
  'genre.blurb.blank-world': 'Mundo en blanco',
  'genre.opening.fantasy': 'Una campana suena en una capilla sumergida que lleva cien años en silencio',
  'genre.opening.science-fiction':
    'Tu remolcador minero atraca en un puesto avanzado donde toda la tripulación duerme y nadie despierta',
  'genre.opening.horror': 'Heredas una casa cuyos antiguos dueños dejaron la mesa puesta y la puerta abierta',
  'genre.opening.investigative-mystery':
    'Un abogado te cita en un despacho cerrado con llave donde el reloj se detuvo a las nueve y cuarto',
  'genre.opening.modern-adventure':
    'Un mensajero te pone un sobre sellado en la mano en el aeropuerto y desaparece entre la multitud',
  'genre.opening.blank-world': 'Nada está decidido todavía, así que describe dónde estás y qué ocurre a tu alrededor',
  'archetype.hedge-witch': 'Bruja del campo',
  'archetype.exiled-knight': 'Caballero exiliado',
  'archetype.river-smuggler': 'Contrabandista del río',
  'archetype.station-engineer': 'Ingeniero de estación',
  'archetype.corporate-envoy': 'Enviado corporativo',
  'archetype.drift-salvager': 'Recolector de restos',
  'archetype.skeptic': 'Escéptico',
  'archetype.survivor': 'Sobreviviente',
  'archetype.detective': 'Detective',
  'archetype.journalist': 'Periodista',
  'archetype.fixer': 'Intermediario',
  'archetype.reporter': 'Reportero',
  'archetype.pilot': 'Piloto',
  'archetype.summary.hedge-witch': 'Cambia remedios por secretos a las afueras del pueblo',
  'archetype.summary.exiled-knight': 'Cumple el juramento hecho a un señor que lo desterró',
  'archetype.summary.river-smuggler': 'Lleva mercancías y personas más allá de los puestos de peaje',
  'archetype.summary.station-engineer': 'Mantiene el soporte vital funcionando con un presupuesto en quiebra',
  'archetype.summary.corporate-envoy': 'Negocia por una empresa dueña de la concesión de la colonia',
  'archetype.summary.drift-salvager': 'Desarma naves abandonadas y vende lo que aún funciona',
  'archetype.summary.skeptic': 'Explica lo imposible hasta que ya no hay explicación',
  'archetype.summary.survivor': 'Ya vio la cosa antes y aún tiene las cicatrices',
  'archetype.summary.detective': 'Lee a las personas y los lugares en busca de lo que no encaja',
  'archetype.summary.journalist': 'Sigue la historia adonde lo lleve',
  'archetype.summary.fixer': 'Conoce a alguien en cada ciudad y debe favores a la mayoría',
  'archetype.summary.reporter': 'Persigue la historia hasta donde la policía se detiene',
  'archetype.summary.pilot': 'Lleva a la gente adentro y afuera cuando se cierran los caminos',
  'stat.Might': 'Fuerza',
  'stat.Agility': 'Agilidad',
  'stat.Wits': 'Ingenio',
  'stat.Presence': 'Presencia',
};

const TABLES: Readonly<Record<string, Readonly<Record<string, string>>>> = { es: ES, 'pt-BR': PT_BR };

export const hasContentNames = (locale: string): boolean =>
  matchLocale(locale, Object.keys(TABLES), DEFAULT_LOCALE) !== DEFAULT_LOCALE;

export const contentText = (locale: string, kind: ContentKind, id: string, fallback: string): string => {
  const table = TABLES[matchLocale(locale, Object.keys(TABLES), DEFAULT_LOCALE)];
  return table?.[`${kind}${KEY_SEPARATOR}${id}`] ?? fallback;
};

export const contentAliases = (kind: ContentKind, id: string): string[] =>
  Object.values(TABLES).flatMap((table) => table[`${kind}${KEY_SEPARATOR}${id}`] ?? []);
