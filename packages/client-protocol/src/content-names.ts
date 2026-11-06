import { DEFAULT_LOCALE, matchLocale } from './locale.ts';

export type ContentKind = 'genre' | 'genre.blurb' | 'archetype' | 'archetype.summary' | 'stat';

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

const TABLES: Readonly<Record<string, Readonly<Record<string, string>>>> = { 'pt-BR': PT_BR };

export const contentText = (locale: string, kind: ContentKind, id: string, fallback: string): string => {
  const table = TABLES[matchLocale(locale, Object.keys(TABLES), DEFAULT_LOCALE)];
  return table?.[`${kind}${KEY_SEPARATOR}${id}`] ?? fallback;
};
