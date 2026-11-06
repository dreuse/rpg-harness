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
  'archetype.Hedge witch': 'Bruxa do campo',
  'archetype.Exiled knight': 'Cavaleiro exilado',
  'archetype.River smuggler': 'Contrabandista do rio',
  'archetype.Station engineer': 'Engenheiro de estação',
  'archetype.Corporate envoy': 'Enviado corporativo',
  'archetype.Drift salvager': 'Catador de destroços',
  'archetype.Skeptic': 'Cético',
  'archetype.Survivor': 'Sobrevivente',
  'archetype.Detective': 'Detetive',
  'archetype.Journalist': 'Jornalista',
  'archetype.Fixer': 'Articulador',
  'archetype.Reporter': 'Repórter',
  'archetype.Pilot': 'Piloto',
  'archetype.summary.Hedge witch': 'Troca remédios por segredos na beira do vilarejo',
  'archetype.summary.Exiled knight': 'Cumpre o juramento feito a um senhor que o baniu',
  'archetype.summary.River smuggler': 'Leva mercadorias e pessoas além dos postos de pedágio',
  'archetype.summary.Station engineer': 'Mantém o suporte de vida funcionando com um orçamento falido',
  'archetype.summary.Corporate envoy': 'Negocia por uma empresa dona da concessão da colônia',
  'archetype.summary.Drift salvager': 'Desmonta naves abandonadas e vende o que ainda funciona',
  'archetype.summary.Skeptic': 'Explica o impossível até que não haja mais explicação',
  'archetype.summary.Survivor': 'Já viu a coisa antes e ainda tem as cicatrizes',
  'archetype.summary.Detective': 'Lê pessoas e lugares atrás do que não se encaixa',
  'archetype.summary.Journalist': 'Segue a história aonde ela levar',
  'archetype.summary.Fixer': 'Conhece alguém em cada cidade e deve favores à maioria',
  'archetype.summary.Reporter': 'Persegue a história até onde a polícia para',
  'archetype.summary.Pilot': 'Leva as pessoas para dentro e para fora quando as estradas fecham',
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
  'archetype.Hedge witch': 'Bruja del campo',
  'archetype.Exiled knight': 'Caballero exiliado',
  'archetype.River smuggler': 'Contrabandista del río',
  'archetype.Station engineer': 'Ingeniero de estación',
  'archetype.Corporate envoy': 'Enviado corporativo',
  'archetype.Drift salvager': 'Recolector de restos',
  'archetype.Skeptic': 'Escéptico',
  'archetype.Survivor': 'Sobreviviente',
  'archetype.Detective': 'Detective',
  'archetype.Journalist': 'Periodista',
  'archetype.Fixer': 'Intermediario',
  'archetype.Reporter': 'Reportero',
  'archetype.Pilot': 'Piloto',
  'archetype.summary.Hedge witch': 'Cambia remedios por secretos a las afueras del pueblo',
  'archetype.summary.Exiled knight': 'Cumple el juramento hecho a un señor que lo desterró',
  'archetype.summary.River smuggler': 'Lleva mercancías y personas más allá de los puestos de peaje',
  'archetype.summary.Station engineer': 'Mantiene el soporte vital funcionando con un presupuesto en quiebra',
  'archetype.summary.Corporate envoy': 'Negocia por una empresa dueña de la concesión de la colonia',
  'archetype.summary.Drift salvager': 'Desarma naves abandonadas y vende lo que aún funciona',
  'archetype.summary.Skeptic': 'Explica lo imposible hasta que ya no hay explicación',
  'archetype.summary.Survivor': 'Ya vio la cosa antes y aún tiene las cicatrices',
  'archetype.summary.Detective': 'Lee a las personas y los lugares en busca de lo que no encaja',
  'archetype.summary.Journalist': 'Sigue la historia adonde lo lleve',
  'archetype.summary.Fixer': 'Conoce a alguien en cada ciudad y debe favores a la mayoría',
  'archetype.summary.Reporter': 'Persigue la historia hasta donde la policía se detiene',
  'archetype.summary.Pilot': 'Lleva a la gente adentro y afuera cuando se cierran los caminos',
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
